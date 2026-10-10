import { CheckCircle2, ChevronDown, Circle, LockKeyhole, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  getCloudRoomQuestionSummary,
  type CloudQuestionSummary,
} from "../cloud-questions/cloudQuestionApi";
import {
  completeCloudRoomChecklistItem,
  endCloudRoom,
  getCloudRoomChecklist,
  startCloudRoom,
  undoCloudRoomChecklistItem,
  type CloudRoomEndInput,
  type CloudRoomFlowItem,
  type CloudRoomRecord,
} from "./roomApi";
import { CloudRoomCapacityPanel } from "./CloudRoomCapacityPanel";
import { EndAccessDeadlineDialog } from "./EndAccessDeadlineDialog";
import { formatKoreanDateTime, isStudentAccessOpen } from "./endAccessDeadline";
import { LiveRoomPanelSwitch, LiveRoomShell } from "../live-room/LiveRoomShell";
import { LiveRoomShareControl } from "../live-room/LiveRoomHeaderControls";
import { LiveRoomMaterialPane } from "../live-material/LiveRoomMaterialPane";
import { CloudRoomQuestionsPage } from "../cloud-questions/CloudRoomQuestionsPage";
import {
  getCloudRoomMaterialAccess,
  type RoomMaterialAccess,
} from "../live-material/roomMaterialApi";
import styles from "./CloudRoomPages.module.css";
import checklistStyles from "./CloudRoomChecklistPage.module.css";

const POLL_INTERVAL_MS = 2_500;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function roomStatusLabel(status: CloudRoomRecord["status"]) {
  if (status === "LIVE") return "진행 중";
  if (status === "ENDED") return "종료됨";
  return "준비 중";
}

function chapterGroups(items: CloudRoomFlowItem[]) {
  const groups: Array<{ id: string; title: string; items: CloudRoomFlowItem[] }> = [];
  for (const item of items) {
    const existing = groups.find((group) => group.id === item.chapterId);
    if (existing) existing.items.push(item);
    else groups.push({ id: item.chapterId, title: item.chapterTitle, items: [item] });
  }
  return groups;
}

export function CloudRoomChecklistPage() {
  const { roomId = "" } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = location.pathname.endsWith("/chat") ? "chat" : "roadmap";
  const [room, setRoom] = useState<CloudRoomRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [questionSummary, setQuestionSummary] = useState<CloudQuestionSummary | null>(null);
  const [isEndDialogOpen, setIsEndDialogOpen] = useState(false);
  const [endedMaterialAccess, setEndedMaterialAccess] = useState<RoomMaterialAccess | null>(null);
  const inFlight = useRef(false);
  const latestRoom = useRef<CloudRoomRecord | null>(null);
  const initializedChapterRoom = useRef<string | null>(null);
  const [expandedChapterIds, setExpandedChapterIds] = useState<Set<string>>(() => new Set());
  const [chatVisited, setChatVisited] = useState(activeTab === "chat");

  useEffect(() => {
    if (activeTab === "chat") setChatVisited(true);
  }, [activeTab]);

  useEffect(() => {
    latestRoom.current = room;
  }, [room]);

  const loadChecklist = useCallback(
    async (polling = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const [next, nextQuestionSummary] = await Promise.all([
          getCloudRoomChecklist(user, roomId),
          getCloudRoomQuestionSummary(user, roomId),
        ]);
        setRoom((current) =>
          current && current.revision === next.revision ? current : next,
        );
        if (initializedChapterRoom.current !== next.id) {
          initializedChapterRoom.current = next.id;
          const currentChapter = chapterGroups(next.flowItems).find((chapter) =>
            chapter.items.some((item) => item.itemId === next.currentItemId),
          );
          setExpandedChapterIds(currentChapter ? new Set([currentChapter.id]) : new Set());
        }
        setQuestionSummary(nextQuestionSummary);
        setPollError(null);
        if (!polling) setNotice(null);
      } catch (error) {
        const nextMessage = errorMessage(
          error,
          "로드맵을 불러오지 못했습니다.",
        );
        if (polling && latestRoom.current) setPollError(nextMessage);
        else setNotice(nextMessage);
      } finally {
        inFlight.current = false;
        if (!polling) setLoading(false);
      }
    },
    [roomId, user],
  );

  useEffect(() => {
    void loadChecklist();
  }, [loadChecklist]);

  useEffect(() => {
    if (!room || room.status !== "LIVE") return;
    let disposed = false;
    const refresh = () => {
      if (!disposed && document.visibilityState === "visible") {
        void loadChecklist(true);
      }
    };
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadChecklist, room?.id, room?.status]);

  useEffect(() => {
    if (room?.status !== "ENDED" || !user || typeof user.getIdToken !== "function") {
      setEndedMaterialAccess(null);
      return;
    }
    let active = true;
    void getCloudRoomMaterialAccess(user, roomId)
      .then((access) => {
        if (active) setEndedMaterialAccess(access);
      })
      .catch(() => {
        if (active) setEndedMaterialAccess(null);
      });
    return () => {
      active = false;
    };
  }, [room?.status, roomId, user]);

  async function mutate(
    change: (current: CloudRoomRecord) => Promise<CloudRoomRecord>,
  ) {
    if (!room || mutating) return;
    setMutating(true);
    setNotice(null);
    try {
      const next = await change(room);
      setRoom(next);
      setPollError(null);
    } catch (error) {
      setNotice(errorMessage(error, "로드맵을 변경하지 못했습니다."));
    } finally {
      setMutating(false);
    }
  }

  async function confirmEnd(input: CloudRoomEndInput) {
    if (!room || mutating || room.currentRole !== "LEAD_INSTRUCTOR" || room.status !== "LIVE") return;
    setMutating(true);
    setNotice(null);
    try {
      const ended = await endCloudRoom(user, roomId, room.revision, input);
      setRoom(ended);
      setPollError(null);
      setIsEndDialogOpen(false);
      navigate(`/rooms/${encodeURIComponent(roomId)}/summary`);
    } catch (error) {
      setNotice(errorMessage(error, "강의를 종료하지 못했습니다."));
    } finally {
      setMutating(false);
    }
  }

  if (loading) return <p role="status">강의방 로드맵을 불러오는 중입니다.</p>;
  if (!room) return <p role="alert">{notice ?? "강의방을 찾을 수 없습니다."}</p>;

  const completedCount = room.flowItems.filter((item) => item.isCompleted).length;
  const hasChecklistPermission = room.currentRole === "LEAD_INSTRUCTOR"
    || room.roomPermissions?.checklistProgress === true;
  const canChange = hasChecklistPermission && room.status === "LIVE";
  const canStart = hasChecklistPermission && room.status === "READY";
  const canEnd = room.currentRole === "LEAD_INSTRUCTOR" && room.status === "LIVE";
  const canShare = (room.currentRole === "LEAD_INSTRUCTOR" || room.currentRole === "ASSISTANT")
    && (room.status !== "ENDED" || isStudentAccessOpen(room.endedAt ?? null, room.downloadAvailableUntil ?? null));
  const groups = chapterGroups(room.flowItems);
  const endedAccessMessage = endedMaterialAccess?.material
    ? endedMaterialAccess.material.downloadAvailableUntil
      ? `학생 자료 열람·다운로드 마감: ${formatKoreanDateTime(endedMaterialAccess.material.downloadAvailableUntil)}`
      : "학생 자료 열람·다운로드는 강의 종료와 함께 마감되었습니다."
    : "연결된 학생 자료가 없어 별도의 열람·다운로드 마감이 없습니다.";
  const itemQuestionCounts = new Map(
    questionSummary?.itemCounts.map((item) => [item.itemId, item]) ?? [],
  );

  function toggleChapter(chapterId: string) {
    setExpandedChapterIds((current) => {
      const next = new Set(current);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  }

  return (
    <>
      <LiveRoomShell
      homeTo="/rooms"
      homeLabel="강의방 목록"
      roomTitle={room.title}
      roomMeta={`강사 운영 · ${roomStatusLabel(room.status)}`}
      panelLabel="강사 강의방 작업 패널"
      panelTitle="강의 운영"
      managedPanelTransition
      headerAction={
        <>
          {canShare ? <LiveRoomShareControl roomId={roomId} roomCode={room.roomCode} message={room.status === "ENDED" ? "자료 열람 기간 동안 학생이 다시 접속할 수 있습니다." : undefined} /> : null}
        </>
      }
      tabs={[
        {
          label: <>채팅 {questionSummary?.allCount ?? 0} · 새 {questionSummary?.newCount ?? 0}</>,
          to: `/rooms/${encodeURIComponent(roomId)}/chat`,
          active: activeTab === "chat",
        },
        { label: "로드맵", to: `/rooms/${encodeURIComponent(roomId)}/checklist`, active: activeTab === "roadmap" },
      ]}
      context={
        <>
          <div className={styles.liveContextHeading}>
            <p className={styles.eyebrow}>실제 강의 진행</p>
            <h1 id="room-checklist-title">{room.title}</h1>
            <p>원본 수업 흐름: <strong>{room.sourceCourseTitle}</strong></p>
          </div>
          <dl className={styles.liveContextFacts}>
            <div><dt>강의 상태</dt><dd>{roomStatusLabel(room.status)}</dd></div>
            <div><dt>진행 항목</dt><dd>{completedCount}/{room.flowItems.length}</dd></div>
          </dl>
          <LiveRoomMaterialPane user={user} scope={{ mode: "staff", roomId }} />
          <div className={styles.progressRow}>
            <strong>강의 흐름 진행률</strong>
            <progress value={completedCount} max={Math.max(room.flowItems.length, 1)}>{completedCount}/{room.flowItems.length}</progress>
          </div>
        </>
      }
      panelFixed={
        <div className={`${styles.livePanelStatus} ${checklistStyles.status}`}>
          <span className={styles[`status${room.status}`]}> {roomStatusLabel(room.status)} </span>
          <CloudRoomCapacityPanel user={user} roomId={roomId} compact />
        </div>
      }
      panel={
        <LiveRoomPanelSwitch
          activeTab={activeTab}
          roadmap={<article className={`${styles.livePanelContent} ${checklistStyles.panel}`}>
          {room.status === "READY" ? (
            <section className={`${styles.readyCallout} ${checklistStyles.readyCallout}`}>
              <h2>수업을 시작할 준비가 되었습니다</h2>
              <p>시작 전에는 로드맵을 미리 볼 수만 있습니다.</p>
              {canStart ? (
                <button type="button" className={styles.primaryAction} disabled={mutating} onClick={() => void mutate((current) => startCloudRoom(user, roomId, current.revision))}>
                  <Play aria-hidden="true" /> {mutating ? "수업 시작 중..." : "수업 시작"}
                </button>
              ) : <p className={styles.readOnly}><LockKeyhole aria-hidden="true" /> 로드맵 진행 권한이 있는 강사만 수업을 시작할 수 있습니다.</p>}
            </section>
          ) : null}
          {canEnd ? <button type="button" className={styles.primaryAction} disabled={mutating} onClick={() => setIsEndDialogOpen(true)}>강의 종료</button> : null}
          {room.status === "ENDED" && room.currentRole === "LEAD_INSTRUCTOR" ? <p className={styles.readOnly}>종료된 수업은 읽기 전용입니다. <Link to={`/rooms/${encodeURIComponent(roomId)}/summary`}>종료 요약 보기</Link></p> : null}
          {room.status === "ENDED" ? <section className={styles.readOnly} aria-label="학생 자료 열람 마감 안내"><LockKeyhole aria-hidden="true" /><span>{endedAccessMessage} 종료 뒤에는 마감 정책을 다시 편집할 수 없습니다.</span></section> : null}
          {!canChange && !canStart ? <p className={styles.readOnly}>현재 계정에는 이 강의방의 로드맵 진행 권한이 없습니다.</p> : null}
          {notice ? <p role="alert">{notice}</p> : null}
          {pollError ? <p role="alert">최신 상태를 다시 확인하지 못했습니다. 마지막 정상 화면을 유지합니다: {pollError}</p> : null}
          <div className={`${styles.chapterList} ${checklistStyles.chapterList}`}>
            {groups.map((chapter) => {
              const isExpanded = expandedChapterIds.has(chapter.id);
              const chapterDone = chapter.items.filter((item) => item.isCompleted).length;
              const chapterContentId = `chapter-items-${chapter.id}`;
              return <section key={chapter.id} className={`${styles.chapter} ${checklistStyles.chapter}`} aria-labelledby={`chapter-${chapter.id}`}>
                <header className={`${styles.chapterHeader} ${checklistStyles.chapterHeader}`}>
                  <h2 id={`chapter-${chapter.id}`}>{chapter.title}</h2>
                  <span>{chapterDone} / {chapter.items.length}</span>
                  <button
                    type="button"
                    onClick={() => toggleChapter(chapter.id)}
                    aria-expanded={isExpanded}
                    aria-controls={chapterContentId}
                    aria-label={isExpanded ? "챕터 접기" : "챕터 펼치기"}
                    title={isExpanded ? "챕터 접기" : "챕터 펼치기"}
                  >
                    <ChevronDown aria-hidden="true" />
                  </button>
                </header>
                {isExpanded ? <ul id={chapterContentId}>
                  {chapter.items.map((item) => {
                    const current = room.currentItemId === item.itemId;
                    const editable = canChange && (item.isCompleted || current);
                    const state = item.isCompleted ? "complete" : current ? "current" : "future";
                    return <li key={item.itemId} className={`${styles[`checklist${state}`]} ${checklistStyles.item}`} data-state={state}>
                      <div className={`${styles.itemMain} ${checklistStyles.itemMain}`}>
                        <button type="button" className={styles.stateButton} aria-label={`${item.itemTitle}: ${item.isCompleted ? "완료" : current ? "현재 진행" : "미완료"}`} aria-pressed={item.isCompleted} disabled={!editable || mutating} onClick={() => void mutate((latest) => item.isCompleted ? undoCloudRoomChecklistItem(user, roomId, item.itemId, latest.revision) : completeCloudRoomChecklistItem(user, roomId, item.itemId, latest.revision))}>
                          {item.isCompleted ? <CheckCircle2 aria-hidden="true" /> : <Circle aria-hidden="true" />}
                        </button>
                        <span><strong>{item.itemTitle}</strong>{item.itemDescription ? <small>{item.itemDescription}</small> : null}{item.sourcePageOrSlideNumbers?.length ? <small>자료 참고 {item.sourcePageOrSlideNumbers.join(", ")}</small> : null}</span>
                      </div>
                      {current ? <small className={`${styles.currentBadge} ${checklistStyles.currentBadge}`}>현재 진행</small> : null}
                      <Link className={`${styles.itemQuestionLink} ${checklistStyles.questionLink}`} to={`/rooms/${encodeURIComponent(roomId)}/chat?item=${encodeURIComponent(item.itemId)}`}>
                        질문 {itemQuestionCounts.get(item.itemId)?.totalCount ?? 0} · 새 {itemQuestionCounts.get(item.itemId)?.newCount ?? 0}
                      </Link>
                    </li>;
                  })}
                </ul> : null}
              </section>;
            })}
          </div>
          </article>}
          chat={chatVisited || activeTab === "chat" ? <CloudRoomQuestionsPage embedded /> : null}
        />
      }
      />
      <EndAccessDeadlineDialog
        open={isEndDialogOpen && canEnd}
        isEnding={mutating}
        onCancel={() => setIsEndDialogOpen(false)}
        onConfirm={(input) => void confirmEnd(input)}
      />
    </>
  );
}
