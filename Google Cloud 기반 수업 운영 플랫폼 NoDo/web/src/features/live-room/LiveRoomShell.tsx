import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { CommonHeader } from "../../components/navigation/CommonHeader";
import styles from "./LiveRoomShell.module.css";

export type LiveRoomTab = {
  label: ReactNode;
  to: string;
  active: boolean;
};

type LiveRoomShellProps = {
  homeTo: string;
  homeLabel: string;
  roomTitle: string;
  roomMeta: string;
  tabs: LiveRoomTab[];
  context: ReactNode;
  panelFixed?: ReactNode;
  panel: ReactNode;
  panelLabel: string;
  panelTitle: string;
  headerAction?: ReactNode;
  className?: string;
  managedPanelTransition?: boolean;
};

const MIN_CONTEXT_WIDTH = 320;
const MIN_PANEL_WIDTH = 340;
const DEFAULT_PANEL_WIDTH = 440;
const PANEL_STEP = 24;
const PANEL_WIDTH_STORAGE_KEY = "nodo.live-room.panel-width";
const PANEL_READY_EVENT = "nodo:live-room-panel-ready";
const PANEL_READY_TIMEOUT_MS = 900;

type TabSlideDirection = "roadmap-to-chat" | "chat-to-roadmap";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => {
    finished?: Promise<unknown>;
  };
};

function tabKind(path: string) {
  if (/\/chat(?:$|[?#])/.test(path)) return "chat";
  if (/\/checklist(?:$|[?#])/.test(path)) return "roadmap";
  return null;
}

function tabSlideDirection(currentPath: string, targetPath: string): TabSlideDirection | null {
  const current = tabKind(currentPath);
  const target = tabKind(targetPath);
  if (current === "roadmap" && target === "chat") return "roadmap-to-chat";
  if (current === "chat" && target === "roadmap") return "chat-to-roadmap";
  return null;
}

function pathnameOf(path: string) {
  return new URL(path, window.location.origin).pathname;
}

function initialPanelWidth() {
  if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
  try {
    const storedWidth = Number(window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
    return Number.isFinite(storedWidth) && storedWidth >= MIN_PANEL_WIDTH
      ? storedWidth
      : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

function maxPanelWidth(workspace: HTMLElement | null) {
  const workspaceWidth = workspace?.getBoundingClientRect().width ?? 0;
  if (!workspaceWidth) return DEFAULT_PANEL_WIDTH;
  return Math.max(
    MIN_PANEL_WIDTH,
    workspaceWidth - MIN_CONTEXT_WIDTH - 12,
  );
}

function panelWidthWithinBounds(
  workspace: HTMLElement | null,
  requestedWidth: number,
) {
  return Math.min(
    Math.max(requestedWidth, MIN_PANEL_WIDTH),
    maxPanelWidth(workspace),
  );
}

/**
 * Shared visual shell for staff and student live-room routes.
 * It deliberately owns only layout and navigation; data remains in each role's page.
 */
export function LiveRoomShell({
  homeTo,
  homeLabel,
  roomTitle,
  roomMeta,
  tabs,
  context,
  panelFixed,
  panel,
  panelLabel,
  panelTitle,
  headerAction,
  className,
  managedPanelTransition = false,
}: LiveRoomShellProps) {
  const navigate = useNavigate();
  const workspaceRef = useRef<HTMLElement | null>(null);
  const isResizingRef = useRef(false);
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const keepPanelWithinBounds = () => {
      setPanelWidth((current) => panelWidthWithinBounds(workspace, current));
    };
    keepPanelWithinBounds();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(keepPanelWithinBounds);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(panelWidth));
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [panelWidth]);

  function resizePanel(requestedWidth: number) {
    setPanelWidth(panelWidthWithinBounds(workspaceRef.current, requestedWidth));
  }

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (window.matchMedia?.("(max-width: 720px)").matches) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    isResizingRef.current = true;
    setIsResizing(true);
  }

  function moveResize(event: PointerEvent<HTMLDivElement>) {
    if (!isResizingRef.current || !workspaceRef.current) return;
    const bounds = workspaceRef.current.getBoundingClientRect();
    resizePanel(bounds.right - event.clientX);
  }

  function finishResize(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    isResizingRef.current = false;
    setIsResizing(false);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizePanel(panelWidth + PANEL_STEP);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      resizePanel(panelWidth - PANEL_STEP);
    }
  }

  const panelWidthMax = maxPanelWidth(workspaceRef.current);
  const workspaceStyle = {
    "--live-room-panel-width": `${panelWidth}px`,
  } as CSSProperties;
  const isStudentRoom = homeTo.startsWith("/join/");
  const activeTabPath = tabs.find((tab) => tab.active)?.to ?? "";
  const activeTabIndex = Math.max(0, tabs.findIndex((tab) => tab.active));

  useLayoutEffect(() => {
    if (!activeTabPath) return;
    window.dispatchEvent(
      new CustomEvent(PANEL_READY_EVENT, {
        detail: { pathname: pathnameOf(activeTabPath) },
      }),
    );
  }, [activeTabPath]);

  function waitForPanel(targetPath: string) {
    let cancel: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        window.removeEventListener(PANEL_READY_EVENT, onPanelReady);
        resolve();
      };
      const onPanelReady = (event: Event) => {
        const detail = (event as CustomEvent<{ pathname?: string }>).detail;
        if (detail?.pathname === targetPath) finish();
      };
      const timeoutId = window.setTimeout(finish, PANEL_READY_TIMEOUT_MS);
      window.addEventListener(PANEL_READY_EVENT, onPanelReady);
      cancel = finish;
    });
    return { ready, cancel };
  }

  function navigateTabWithTransition(event: MouseEvent<HTMLAnchorElement>, to: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    if (managedPanelTransition) return;
    if (to === activeTabPath || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const transitionDocument = document as ViewTransitionDocument;
    if (!transitionDocument.startViewTransition) return;
    event.preventDefault();
    const direction = tabSlideDirection(activeTabPath, to);
    const root = document.documentElement;
    if (direction) root.dataset.liveRoomTabTransition = direction;
    const panelReady = direction ? waitForPanel(pathnameOf(to)) : null;
    try {
      const transition = transitionDocument.startViewTransition(() => {
        flushSync(() => navigate(to));
        return panelReady?.ready;
      });
      void Promise.resolve(transition.finished).finally(() => {
        panelReady?.cancel();
        delete root.dataset.liveRoomTabTransition;
      });
    } catch {
      panelReady?.cancel();
      delete root.dataset.liveRoomTabTransition;
      navigate(to);
    }
  }

  return (
    <main className={`${styles.page}${className ? ` ${className}` : ""}`} data-testid="live-room-shell" data-room-title={roomTitle} data-room-meta={roomMeta}>
      <CommonHeader
        variant={isStudentRoom ? "student" : "staff"}
        context={isStudentRoom ? "학생 강의" : "강의 운영"}
        homeTo={homeTo}
        homeLabel={homeLabel}
        action={headerAction}
      />

      <section
        ref={workspaceRef}
        className={styles.workspace}
        aria-label="라이브 강의 작업 영역"
        style={workspaceStyle}
      >
        <section className={styles.context} aria-label="강의 진행 영역">
          {context}
        </section>
        <div
          className={`${styles.resizeHandle}${isResizing ? ` ${styles.resizing}` : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="작업 패널 너비 조절"
          aria-valuemin={MIN_PANEL_WIDTH}
          aria-valuemax={Math.round(panelWidthMax)}
          aria-valuenow={Math.round(panelWidth)}
          tabIndex={0}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onKeyDown={resizeWithKeyboard}
        />
        <aside className={styles.panel} aria-label={panelLabel}>
          <header className={styles.panelHeader}>
            <p>{panelTitle}</p>
            <nav
              className={`${styles.tabs}${managedPanelTransition ? ` ${styles.managedTabs}` : ""}`}
              aria-label="강의방 탭"
              data-active-index={activeTabIndex}
              style={{
                "--live-room-tab-count": tabs.length,
                "--live-room-tab-offset": activeTabIndex,
              } as CSSProperties}
            >
              {tabs.map((tab) => (
                <Link key={tab.to} to={tab.to} aria-current={tab.active ? "page" : undefined} onClick={(event) => navigateTabWithTransition(event, tab.to)}>
                  {tab.label}
                </Link>
              ))}
            </nav>
          </header>
          <div className={styles.panelFixed}>{panelFixed}</div>
          <div className={styles.panelBody}>{panel}</div>
        </aside>
      </section>
    </main>
  );
}

export function LiveRoomPanelSwitch({
  activeTab,
  roadmap,
  chat,
  assistant,
}: {
  activeTab: "roadmap" | "chat" | "assistant";
  roadmap: ReactNode;
  chat: ReactNode;
  assistant?: ReactNode;
}) {
  return (
    <div className={styles.panelSwitch} data-active-tab={activeTab}>
      <section className={`${styles.panelPane} ${styles.roadmapPane}`} aria-hidden={activeTab !== "roadmap"} inert={activeTab !== "roadmap" ? true : undefined}>
        {roadmap}
      </section>
      <section className={`${styles.panelPane} ${styles.chatPane}`} aria-hidden={activeTab !== "chat"} inert={activeTab !== "chat" ? true : undefined}>
        {chat}
      </section>
      {assistant === undefined ? null : <section className={`${styles.panelPane} ${styles.assistantPane}`} aria-hidden={activeTab !== "assistant"} inert={activeTab !== "assistant" ? true : undefined}>
        {assistant}
      </section>}
    </div>
  );
}
