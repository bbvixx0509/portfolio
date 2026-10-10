import { Eye, EyeOff, MessageCircleQuestion, RefreshCw, Send, Undo2 } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { CloudRoomCapacityPanel } from "../cloud-rooms/CloudRoomCapacityPanel";
import { LiveRoomShell } from "../live-room/LiveRoomShell";
import { LiveRoomShareControl } from "../live-room/LiveRoomHeaderControls";
import { LiveRoomMaterialPane } from "../live-material/LiveRoomMaterialPane";
import { getCloudRoom, type CloudRoomRecord } from "../cloud-rooms/roomApi";
import { isStudentAccessOpen } from "../cloud-rooms/endAccessDeadline";
import {
  answerCloudRoomQuestion,
  cancelCloudRoomQuestionAnswer,
  getCloudRoomQuestions,
  markCloudRoomQuestionsRead,
  setCloudRoomQuestionHidden,
  type CloudQuestion,
  type StaffQuestionFeed,
} from "./cloudQuestionApi";
import styles from "./CloudQuestionPages.module.css";

type FilterKind = "ALL" | "GENERAL" | "ITEM";

function contextIdFor(filter: FilterKind, selectedItemId: string | null) {
  return selectedItemId ? `ITEM:${selectedItemId}` : filter;
}

function contextNewCount(
  summary: StaffQuestionFeed["summary"],
  contextId: string,
) {
  if (contextId === "ALL") return summary.newCount;
  if (contextId === "GENERAL") return summary.generalNewCount;
  return summary.itemCounts.find((item) => `ITEM:${item.itemId}` === contextId)?.newCount ?? 0;
}

function observedQuestionId(
  questions: CloudQuestion[],
  contextId: string,
) {
  const matching = questions.filter((question) => {
    if (contextId === "ALL") return true;
    if (contextId === "GENERAL") return question.isGeneral;
    return question.itemId === contextId.slice("ITEM:".length);
  });
  return matching.at(-1)?.id ?? null;
}

function errorMessage() {
  return "질문을 최신 상태로 불러오지 못했습니다. 마지막 정상 목록을 유지합니다.";
}

export function CloudRoomQuestionsPage({ embedded = false }: { embedded?: boolean }) {
  const { roomId = "" } = useParams();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [feed, setFeed] = useState<StaffQuestionFeed | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [room, setRoom] = useState<CloudRoomRecord | null>(null);
  const [mutating, setMutating] = useState<string | null>(null);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState("");
  const inFlightRef = useRef(false);

  useEffect(() => {
    let active = true;
    if (roomId) {
      getCloudRoom(user, roomId).then((res) => {
        if (active) setRoom(res);
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [roomId, user]);

  const selectedItemId = searchParams.get("item");
  const filter: FilterKind = selectedItemId ? "ITEM" : searchParams.get("filter") === "GENERAL" ? "GENERAL" : "ALL";

  async function loadQuestions(markRead = false) {
    if (!roomId || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const next = await getCloudRoomQuestions(user, roomId);
      setFeed(next);
      setLoadError(null);
      const contextId = contextIdFor(filter, selectedItemId);
      const observedId = observedQuestionId(next.questions, contextId);
      if (
        markRead
        && next.roomPermissions.questionOperations
        && observedId
        && contextNewCount(next.summary, contextId) > 0
      ) {
        const receipt = await markCloudRoomQuestionsRead(
          user, roomId, contextId, observedId,
        );
        if (receipt.marked) {
          setFeed(await getCloudRoomQuestions(user, roomId));
        }
      }
    } catch {
      setLoadError(errorMessage());
    } finally {
      inFlightRef.current = false;
    }
  }

  useEffect(() => {
    void loadQuestions(true);
  }, [roomId, user, selectedItemId, filter]);

  useEffect(() => {
    let timer: number | null = null;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadQuestions();
    };
    const start = () => {
      if (timer === null && document.visibilityState === "visible") {
        timer = window.setInterval(refresh, 2500);
      }
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      stop();
      start();
      refresh();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [roomId, user]);

  const visibleQuestions = useMemo(() => {
    if (!feed) return [];
    if (filter === "GENERAL") return feed.questions.filter((question) => question.isGeneral);
    if (filter === "ITEM" && selectedItemId) return feed.questions.filter((question) => question.itemId === selectedItemId);
    return feed.questions;
  }, [feed, filter, selectedItemId]);

  function selectAll() { setSearchParams({}); }
  function selectGeneral() { setSearchParams({ filter: "GENERAL" }); }
  function selectItem(itemId: string) { setSearchParams({ item: itemId }); }

  async function submitAnswer(event: FormEvent<HTMLFormElement>, question: CloudQuestion) {
    event.preventDefault();
    if (!answerDraft.trim() || mutating || !roomId) return;
    setMutating(`answer-${question.id}`);
    try {
      await answerCloudRoomQuestion(user, roomId, question.id, answerDraft);
      setAnswerDraft("");
      setAnsweringId(null);
      await loadQuestions();
    } catch {
      setLoadError("답변을 저장하지 못했습니다. 입력한 내용은 유지됩니다.");
    } finally {
      setMutating(null);
    }
  }

  async function changeVisibility(question: CloudQuestion, hidden: boolean) {
    if (mutating || !roomId) return;
    setMutating(`${hidden ? "hide" : "restore"}-${question.id}`);
    try {
      await setCloudRoomQuestionHidden(user, roomId, question.id, hidden);
      await loadQuestions();
    } catch {
      setLoadError("질문 상태를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setMutating(null);
    }
  }

  async function cancelAnswer(question: CloudQuestion) {
    if (mutating || !roomId) return;
    setMutating(`cancel-${question.id}`);
    try {
      await cancelCloudRoomQuestionAnswer(user, roomId, question.id);
      await loadQuestions();
    } catch {
      setLoadError("답변을 취소하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setMutating(null);
    }
  }

  if (!feed) {
    if (embedded) {
      return <div className={styles.staffLivePanelContent}><p role="status">질문 화면을 준비하고 있어요.</p>{loadError ? <p role="alert">{loadError}</p> : null}</div>;
    }
    return <main className={styles.page}><p role="status">질문 화면을 준비하고 있어요.</p>{loadError ? <p role="alert">{loadError}</p> : null}</main>;
  }

  const canManage = feed.roomPermissions.questionOperations;
  const itemCounts = new Map(feed.summary.itemCounts.map((item) => [item.itemId, item]));
  const selectedItem = selectedItemId ? feed.flowItems.find((item) => item.itemId === selectedItemId) ?? null : null;
  const selectedContextLabel = selectedItem
    ? `${selectedItem.itemNumber} · ${selectedItem.itemTitle}`
    : filter === "GENERAL" ? "일반 질문" : "전체 질문";
  const canShare = (feed.currentRole === "LEAD_INSTRUCTOR" || feed.currentRole === "ASSISTANT")
    && (feed.roomStatus !== "ENDED" || (room ? isStudentAccessOpen(room.endedAt ?? null, room.downloadAvailableUntil ?? null) : false));

  const panel = (
    <div className={styles.staffLivePanelContent}>
      <section className={styles.filterPanel} aria-label="질문 필터">
        <button type="button" aria-pressed={filter === "ALL"} onClick={selectAll}>전체 <b>{feed.summary.allCount}</b><em>{feed.summary.newCount}</em></button>
        <button type="button" aria-pressed={filter === "GENERAL"} onClick={selectGeneral}>일반 질문 <b>{feed.summary.generalCount}</b><em>{feed.summary.generalNewCount}</em></button>
        {feed.flowItems.map((item) => {
          const count = itemCounts.get(item.itemId);
          return <button key={item.itemId} type="button" aria-pressed={selectedItemId === item.itemId} onClick={() => selectItem(item.itemId)}>{item.itemNumber} {item.itemTitle} <b>{count?.totalCount ?? 0}</b><em>{count?.newCount ?? 0}</em></button>;
        })}
      </section>
      <div className={styles.staffMessageArea}>
        <div className={styles.staffNotices}>
          {loadError ? <p role="alert" className={styles.error}>{loadError}</p> : null}
          {!canManage ? <p className={styles.readOnly}>관리자는 질문을 읽을 수 있지만 답변·숨김·복구는 할 수 없습니다.</p> : null}
        </div>
        <section className={styles.questionList} aria-label="질문 목록" data-testid="staff-question-message-list">
          {visibleQuestions.length === 0 ? <p className={styles.empty}>이 문맥에는 아직 질문이 없습니다.</p> : null}
          {visibleQuestions.map((question) => (
            <article key={question.id} className={styles.questionCard} data-hidden={question.isHidden ? "true" : undefined}>
              <div className={styles.questionMeta}>
                <strong>{question.nicknameSnapshot}</strong><span>{question.isGeneral ? "일반 질문" : `${question.itemNumberSnapshot} · ${question.itemTitleSnapshot}`}</span>
                {question.moderationStatus === "NEEDS_REVIEW" ? <mark>검토 필요</mark> : null}{question.isHidden ? <mark>학생 비공개</mark> : null}
              </div>
              {!question.isGeneral ? <p className={styles.context}>{question.chapterTitleSnapshot} · {question.itemNumberSnapshot} {question.itemTitleSnapshot}</p> : null}
              <p className={styles.questionContent}>{question.content}</p>
              {question.answer ? <section className={styles.answer}><strong>공식 답변 · {question.answer.staffDisplayName}</strong><p>{question.answer.content}</p></section> : null}
              {canManage ? <div className={styles.actions}>{question.answer ? <button type="button" onClick={() => void cancelAnswer(question)} disabled={Boolean(mutating)}><Undo2 aria-hidden="true" /> 답변 취소</button> : <button type="button" onClick={() => { setAnsweringId(question.id); setAnswerDraft(""); }} disabled={Boolean(mutating)}><MessageCircleQuestion aria-hidden="true" /> 답변하기</button>}<button type="button" onClick={() => void changeVisibility(question, !question.isHidden)} disabled={Boolean(mutating)}>{question.isHidden ? <><Eye aria-hidden="true" /> 복구</> : <><EyeOff aria-hidden="true" /> 숨김</>}</button></div> : null}
              {canManage && answeringId === question.id ? <form className={styles.answerForm} onSubmit={(event) => void submitAnswer(event, question)}><label htmlFor={`answer-${question.id}`}>공식 답변</label><textarea id={`answer-${question.id}`} value={answerDraft} onChange={(event) => setAnswerDraft(event.target.value)} maxLength={2000} autoFocus /><div><button type="submit" disabled={!answerDraft.trim() || Boolean(mutating)}><Send aria-hidden="true" /> 답변 저장</button><button type="button" onClick={() => setAnsweringId(null)} disabled={Boolean(mutating)}>취소</button></div></form> : null}
            </article>
          ))}
        </section>
      </div>
    </div>
  );

  if (embedded) return panel;

  return (
    <LiveRoomShell
      homeTo="/rooms"
      homeLabel="강의방 목록"
      roomTitle={feed.roomTitle}
      roomMeta={`강사 운영 · ${feed.roomStatus === "LIVE" ? "진행 중" : feed.roomStatus === "READY" ? "준비 중" : "종료됨"}`}
      panelLabel="강사 질문 작업 패널"
      panelTitle="질문 운영"
      headerAction={
        <>
          {canShare ? <LiveRoomShareControl roomId={roomId} message={feed.roomStatus === "ENDED" ? "자료 열람 기간 동안 학생이 다시 접속할 수 있습니다." : undefined} /> : null}
        </>
      }
      tabs={[
        { label: <>채팅 {feed.summary.allCount} · 새 {feed.summary.newCount}</>, to: `/rooms/${encodeURIComponent(roomId)}/chat`, active: true },
        { label: "로드맵", to: `/rooms/${encodeURIComponent(roomId)}/checklist`, active: false },
      ]}
      context={
        <>
          <div className={styles.liveContextHeading}>
            <p className={styles.eyebrow}>공개 질문 채팅</p>
            <h1>질문과 답변</h1>
            <p>질문은 수업 흐름 문맥에 연결되며, 강사의 공식 답변은 학생 화면에 바로 표시됩니다.</p>
          </div>
          <dl className={styles.liveContextFacts}>
            <div><dt>공개 질문</dt><dd>{feed.summary.allCount}건</dd></div>
            <div><dt>새 질문</dt><dd>{feed.summary.newCount}건</dd></div>
          </dl>
          <section className={styles.currentFlowContext} aria-labelledby="staff-question-context-title">
            <p>선택한 질문 문맥</p>
            <h2 id="staff-question-context-title">{selectedContextLabel}</h2>
            <span>로드맵 항목의 질문 배지를 선택하면 이 문맥으로 바로 이동합니다.</span>
          </section>
          <LiveRoomMaterialPane user={user} scope={{ mode: "staff", roomId }} />
          <div className={styles.staffWorkspaceActions}>
            <button type="button" className={styles.refresh} onClick={() => void loadQuestions(true)} disabled={Boolean(mutating)}>
              <RefreshCw aria-hidden="true" /> 최신 상태 확인
            </button>
          </div>
        </>
      }
      panelFixed={
        <div className={styles.staffLivePanelStatus}>
          <CloudRoomCapacityPanel user={user} roomId={roomId} compact />
        </div>
      }
      panel={panel}
    />
  );
}
