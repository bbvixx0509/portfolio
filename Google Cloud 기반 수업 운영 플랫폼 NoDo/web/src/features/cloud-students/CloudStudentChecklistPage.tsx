import {
  CheckCircle2,
  ChevronDown,
  Circle,
  MessageCircleMore,
  LogOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  loadStudentParticipantSession,
  loadStudentRoomChecklist,
  type StudentChecklistItem,
  type StudentRoomChecklist,
} from "./cloudStudentApi";
import { useStudentRoomPresence } from "./useStudentRoomPresence";
import { LiveRoomPanelSwitch, LiveRoomShell } from "../live-room/LiveRoomShell";
import { LiveRoomMaterialPane } from "../live-material/LiveRoomMaterialPane";
import { CloudStudentQuestionsPage } from "../cloud-questions/CloudStudentQuestionsPage";
import { CloudStudentAssistantPanel } from "../cloud-student-assistant/CloudStudentAssistantPanel";
import {
  getStudentRoomMaterialAccess,
  type RoomMaterialAccess,
} from "../live-material/roomMaterialApi";
import { formatKoreanDateTime } from "../cloud-rooms/endAccessDeadline";
import styles from "./CloudStudentChecklistPage.module.css";

const POLL_INTERVAL_MS = 2_500;

function chapterGroups(items: StudentChecklistItem[]) {
  const groups: Array<{ id: string; title: string; items: StudentChecklistItem[] }> = [];
  for (const item of items) {
    const group = groups.find((candidate) => candidate.id === item.chapterId);
    if (group) group.items.push(item);
    else groups.push({ id: item.chapterId, title: item.chapterTitle, items: [item] });
  }
  return groups;
}

function statusLabel(status: StudentRoomChecklist["roomStatus"]) {
  if (status === "LIVE") return "진행 중";
  if (status === "ENDED") return "종료됨";
  return "준비 중";
}

export function CloudStudentChecklistPage() {
  const { orgId = "", roomCode = "" } = useParams();
  const { identityKind, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = location.pathname.endsWith("/assistant")
    ? "assistant"
    : location.pathname.endsWith("/chat")
      ? "chat"
      : "roadmap";
  const [checklist, setChecklist] = useState<StudentRoomChecklist | null>(null);
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [endedMaterialAccess, setEndedMaterialAccess] = useState<RoomMaterialAccess | null>(null);
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const initializedChapterRoom = useRef<string | null>(null);
  const [expandedChapterIds, setExpandedChapterIds] = useState<Set<string>>(() => new Set());
  const [chatVisited, setChatVisited] = useState(activeTab === "chat");
  const [assistantVisited, setAssistantVisited] = useState(activeTab === "assistant");
  const isStaff = identityKind === "staff" || identityKind === "invited-staff";
  const basePath = `/join/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}`;
  const { leave, leaving } = useStudentRoomPresence(isStaff ? null : user, orgId, roomCode);

  useEffect(() => {
    if (activeTab === "chat") setChatVisited(true);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "assistant") setAssistantVisited(true);
  }, [activeTab]);

  const load = useCallback(async () => {
    if (!user || isStaff || inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const [nextChecklist, session] = await Promise.all([
        loadStudentRoomChecklist(user, orgId, roomCode, controller.signal),
        loadStudentParticipantSession(user, orgId, roomCode, controller.signal),
      ]);
      if (!mountedRef.current) return;
      setChecklist(nextChecklist);
      const roomKey = `${orgId}/${roomCode}`;
      if (initializedChapterRoom.current !== roomKey) {
        initializedChapterRoom.current = roomKey;
        const currentChapter = chapterGroups(nextChecklist.flowItems).find((chapter) =>
          chapter.items.some((item) => item.itemId === nextChecklist.currentItemId),
        );
        setExpandedChapterIds(currentChapter ? new Set([currentChapter.id]) : new Set());
      }
      setNickname(session.nickname);
      setError(null);
    } catch {
      if (mountedRef.current && !controller.signal.aborted) {
        setError("강의 진행 정보를 불러오지 못했습니다. 마지막 정상 화면을 유지합니다.");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inFlightRef.current = false;
    }
  }, [isStaff, orgId, roomCode, user]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      abortRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (checklist?.roomStatus !== "ENDED" || !user || typeof user.getIdToken !== "function") {
      setEndedMaterialAccess(null);
      return;
    }
    let active = true;
    void getStudentRoomMaterialAccess(user, orgId, roomCode)
      .then((access) => {
        if (active) setEndedMaterialAccess(access);
      })
      .catch(() => {
        if (active) setEndedMaterialAccess(null);
      });
    return () => {
      active = false;
    };
  }, [checklist?.roomStatus, orgId, roomCode, user]);

  if (isStaff) {
    return <main className={styles.message} role="alert">학생 강의 화면은 별도의 브라우저 또는 기기에서 이용해 주세요.</main>;
  }

  if (!checklist) {
    return <main className={styles.message} role={error ? "alert" : "status"}>{error ?? "학생 로드맵을 준비하고 있어요."}</main>;
  }

  const groups = chapterGroups(checklist.flowItems);
  const completedCount = checklist.flowItems.filter((item) => item.isCompleted).length;
  const itemCounts = new Map(checklist.summary.itemCounts.map((item) => [item.itemId, item.totalCount]));
  const endedAccessMessage = endedMaterialAccess?.material
    ? endedMaterialAccess.material.downloadAvailableUntil
      ? `이 자료는 ${formatKoreanDateTime(endedMaterialAccess.material.downloadAvailableUntil)}까지 열람·다운로드할 수 있습니다.`
      : "이 자료의 열람·다운로드는 강의 종료와 함께 마감되었습니다."
    : "연결된 자료가 없거나 자료 열람 기간이 마감되었습니다.";
  function toggleChapter(chapterId: string) {
    setExpandedChapterIds((current) => {
      const next = new Set(current);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  }
  async function exitRoom() {
    try {
      await leave();
      navigate(basePath, { replace: true });
    } catch {
      setError("강의방에서 나가지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }

  return (
    <LiveRoomShell
      homeTo={basePath}
      homeLabel="NoDo 학생 강의 홈"
      roomTitle={checklist.roomTitle}
      roomMeta={`익명 수강생 · ${nickname || "별명 확인 중"}`}
      panelLabel="학생 강의방 작업 패널"
      panelTitle="강의 진행"
      managedPanelTransition
      headerAction={<button type="button" className={styles.leaveButton} onClick={() => void exitRoom()} disabled={leaving}><LogOut aria-hidden="true" /> {leaving ? "나가는 중" : "나가기"}</button>}
      tabs={[
        { label: "AI 도우미", to: `${basePath}/assistant`, active: activeTab === "assistant" },
        { label: <>채팅 <b>{checklist.summary.allCount}</b></>, to: `${basePath}/chat`, active: activeTab === "chat" },
        { label: "로드맵", to: `${basePath}/checklist`, active: activeTab === "roadmap" },
      ]}
      context={
        <>
          <div className={styles.liveContextHeading}>
            <p className={styles.eyebrow}>강의 진행 로드맵</p>
            <h1 id="student-checklist-title">{checklist.roomTitle}</h1>
            <p>수업 흐름과 현재 진행 항목을 확인하고, 질문 배지에서 해당 항목의 대화로 이동할 수 있어요.</p>
          </div>
          <dl className={styles.liveContextFacts}>
            <div><dt>강의 상태</dt><dd>{statusLabel(checklist.roomStatus)}</dd></div>
            <div><dt>진행률</dt><dd>{completedCount}/{checklist.flowItems.length}</dd></div>
          </dl>
          {checklist.roomStatus === "ENDED" ? <section className={styles.endedAccess} aria-label="학생 자료 열람 마감 안내">
            <p>학생 자료 열람 안내</p>
            <strong>{endedAccessMessage}</strong>
            <span>마감 전 자료만 열람·다운로드할 수 있으며, 종료 뒤 마감 정책은 변경할 수 없습니다.</span>
          </section> : null}
          <LiveRoomMaterialPane user={user} scope={{ mode: "student", orgId, roomCode }} />
          <div className={styles.progressRow}>
            <span>전체 진행률</span>
            <progress value={completedCount} max={Math.max(checklist.flowItems.length, 1)}>{completedCount}/{checklist.flowItems.length}</progress>
          </div>
        </>
      }
      panel={
        <LiveRoomPanelSwitch
          activeTab={activeTab}
          roadmap={<div className={styles.livePanelContent}>
          {error ? <p className={styles.notice} role="alert">{error}</p> : null}
          <div className={styles.chapterList}>
            {groups.map((chapter, index) => {
              const chapterDone = chapter.items.filter((item) => item.isCompleted).length;
              const isExpanded = expandedChapterIds.has(chapter.id);
              const chapterContentId = `student-chapter-items-${chapter.id}`;
              return <section key={chapter.id} className={styles.chapter} aria-labelledby={`student-chapter-${chapter.id}`}>
                <header><div><span>{String(index + 1).padStart(2, "0")}</span><h2 id={`student-chapter-${chapter.id}`}>{chapter.title}</h2></div><p>{chapterDone} / {chapter.items.length}</p><button type="button" onClick={() => toggleChapter(chapter.id)} aria-expanded={isExpanded} aria-controls={chapterContentId} aria-label={isExpanded ? "챕터 접기" : "챕터 펼치기"} title={isExpanded ? "챕터 접기" : "챕터 펼치기"}><ChevronDown aria-hidden="true" /></button></header>
                {isExpanded ? <ul id={chapterContentId}>{chapter.items.map((item) => {
                  const current = item.itemId === checklist.currentItemId;
                  const state = item.isCompleted ? "complete" : current ? "current" : "future";
                  return <li key={item.itemId} className={styles[`item${state}`]} data-state={state}>
                    <span className={styles.stateIcon} aria-label={`${item.itemTitle}: ${item.isCompleted ? "완료" : current ? "현재 진행" : "미완료"}`}>{item.isCompleted ? <CheckCircle2 aria-hidden="true" /> : <Circle aria-hidden="true" />}</span>
                    <div className={styles.itemCopy}><p><span>{item.itemNumber}</span> <strong>{item.itemTitle}</strong></p>{item.itemDescription ? <small>{item.itemDescription}</small> : null}{item.sourcePageOrSlideNumbers?.length ? <small>자료 참고 {item.sourcePageOrSlideNumbers.join(", ")}</small> : null}</div>
                    {current ? <span className={styles.currentBadge}>{checklist.roomStatus === "LIVE" ? "현재 진행" : "첫 시작 항목"}</span> : null}
                    <Link className={styles.questionBadge} to={`${basePath}/chat?context=${encodeURIComponent(`ITEM:${item.itemId}`)}`} aria-label={`${item.itemTitle} 질문 ${itemCounts.get(item.itemId) ?? 0}개 보기`}><MessageCircleMore aria-hidden="true" /> {itemCounts.get(item.itemId) ?? 0}</Link>
                  </li>;
                })}</ul> : null}
              </section>;
            })}
          </div>
          </div>}
          chat={chatVisited || activeTab === "chat" ? <CloudStudentQuestionsPage embedded /> : null}
          assistant={assistantVisited || activeTab === "assistant" ? <CloudStudentAssistantPanel
            user={user}
            orgId={orgId}
            roomCode={roomCode}
            roomStatus={checklist.roomStatus}
            currentItemId={checklist.currentItemId}
            flowItems={checklist.flowItems}
          /> : null}
        />
      }
    />
  );
}
