import { LogOut, MessageCircleMore, Send } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  createQuestionRequestId,
  createStudentRoomQuestion,
  getStudentRoomQuestions,
  studentQuestionSubmitErrorMessage,
  toCloudQuestionInput,
  type StudentQuestionFeed,
} from "./cloudQuestionApi";
import styles from "./CloudStudentQuestionsPage.module.css";
import { useStudentRoomPresence } from "../cloud-students/useStudentRoomPresence";
import { LiveRoomShell } from "../live-room/LiveRoomShell";
import { LiveRoomMaterialPane } from "../live-material/LiveRoomMaterialPane";

const POLL_INTERVAL_MS = 2_500;

function contextLabel(context: string, feed: StudentQuestionFeed) {
  if (context === "ALL") return "전체 질문";
  if (context === "GENERAL") return "일반 질문";
  const item = feed.flowItems.find((candidate) => `ITEM:${candidate.itemId}` === context);
  return item ? `${item.itemNumber} · ${item.itemTitle}` : "항목 질문";
}

export function CloudStudentQuestionsPage({ embedded = false }: { embedded?: boolean }) {
  const { orgId = "", roomCode = "" } = useParams();
  const { identityKind, user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [feed, setFeed] = useState<StudentQuestionFeed | null>(null);
  const [content, setContent] = useState("");
  const [itemId, setItemId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(createQuestionRequestId);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlightRef = useRef(false);
  const submitRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const selectedContext = searchParams.get("context") ?? "ALL";
  const isStaff = identityKind === "staff" || identityKind === "invited-staff";
  const basePath = `/join/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}`;
  const { leave, leaving } = useStudentRoomPresence(isStaff || embedded ? null : user, orgId, roomCode);

  const load = useCallback(async () => {
    if (!user || isStaff || inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const next = await getStudentRoomQuestions(user, orgId, roomCode, controller.signal);
      if (!mountedRef.current) return;
      setFeed(next);
      setError(null);
    } catch {
      if (mountedRef.current && !controller.signal.aborted) {
        setError("질문을 불러오지 못했습니다. 마지막 정상 화면을 유지합니다.");
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
    if (!selectedContext.startsWith("ITEM:")) return;
    setItemId(selectedContext.slice("ITEM:".length));
  }, [selectedContext]);

  function selectContext(context: string) {
    setSearchParams(context === "ALL" ? {} : { context });
  }

  async function exitRoom() {
    try {
      await leave();
      navigate(basePath, { replace: true });
    } catch {
      setError("강의방에서 나가지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }

  async function submitQuestion() {
    if (!user || submitRef.current || !content.trim()) return;
    submitRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await createStudentRoomQuestion(user, orgId, roomCode, toCloudQuestionInput(content, itemId, requestId));
    } catch (submissionError) {
      setSubmitError(studentQuestionSubmitErrorMessage(submissionError));
      return;
    } finally {
      submitRef.current = false;
      setSubmitting(false);
    }

    // A read-only refresh failure must not turn a completed POST into a
    // failed send or trigger a duplicate retry with a new request ID.
    setContent("");
    setItemId(null);
    setRequestId(createQuestionRequestId());
    selectContext("ALL");
    await load();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion();
  }

  function retrySubmit() {
    void submitQuestion();
  }

  function updateContent(nextContent: string) {
    setContent(nextContent);
    setSubmitError(null);
  }

  if (isStaff) {
    return <main className={styles.message} role="alert">학생 채팅은 별도의 브라우저 또는 기기에서 이용해 주세요.</main>;
  }

  if (!feed) {
    if (embedded) {
      return <div className={styles.livePanelContent} role={error ? "alert" : "status"}>{error ?? "학생 채팅을 준비하고 있어요."}</div>;
    }
    return <main className={styles.message} role={error ? "alert" : "status"}>{error ?? "학생 채팅을 준비하고 있어요."}</main>;
  }

  const visibleQuestions = feed.questions.filter((question) => {
    if (selectedContext === "ALL") return true;
    if (selectedContext === "GENERAL") return question.isGeneral;
    return question.itemId === selectedContext.slice("ITEM:".length);
  });

  const panel = (
    <div className={styles.livePanelContent}>
      <nav className={styles.contexts} aria-label="질문 문맥 필터">
        <button type="button" aria-pressed={selectedContext === "ALL"} onClick={() => selectContext("ALL")}>전체</button>
        <button type="button" aria-pressed={selectedContext === "GENERAL"} onClick={() => selectContext("GENERAL")}>일반</button>
        {feed.flowItems.map((item) => <button key={item.itemId} type="button" aria-pressed={selectedContext === `ITEM:${item.itemId}`} onClick={() => selectContext(`ITEM:${item.itemId}`)}>{item.itemNumber}</button>)}
      </nav>
      <div className={styles.messageArea}>
        <div className={styles.notices}>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {submitError ? <div className={styles.error} role="alert">
            <p>{submitError} 입력한 내용은 그대로 남아 있습니다.</p>
            <button type="button" className={styles.retryButton} onClick={retrySubmit} disabled={submitting}>다시 시도</button>
          </div> : null}
        </div>
        <section className={styles.messageList} aria-label="공개 질문과 답변" data-testid="student-question-message-list">
          {visibleQuestions.length === 0 ? <p className={styles.empty}>이 문맥에는 아직 공개된 질문이 없습니다.</p> : null}
          {visibleQuestions.map((question) => <article key={question.id} className={styles.questionBubble}>
            <div className={styles.questionMeta}><span>{question.isGeneral ? "일반 질문" : `${question.itemNumberSnapshot} · ${question.itemTitleSnapshot}`}</span><strong>{question.nicknameSnapshot}</strong></div>
            <p>{question.content}</p>
            {question.answer ? <section className={styles.answerBubble}><div><MessageCircleMore aria-hidden="true" /><strong>공식 답변</strong></div><p>{question.answer.content}</p></section> : null}
          </article>)}
        </section>
      </div>
      {feed.roomStatus === "ENDED" ? (
        <div className={styles.endedNotice} style={{ padding: '1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderTop: '1px solid #e5e7eb', color: '#6b7280', fontSize: '0.875rem' }}>
          종료된 수업에서는 새 질문을 남길 수 없습니다.
        </div>
      ) : (
        <form className={styles.composer} aria-label="질문 입력" data-testid="student-question-composer" onSubmit={(event) => void submit(event)}>
          <div className={styles.composerContext}>
            <label htmlFor="question-kind">질문 문맥</label>
            <select id="question-kind" value={itemId ?? ""} onChange={(event) => setItemId(event.target.value || null)} disabled={submitting}>
              <option value="">일반 질문</option>
              <optgroup label="로드맵 항목 질문">
                {feed.flowItems.map((item) => <option key={item.itemId} value={item.itemId}>{item.itemNumber} · {item.itemTitle}</option>)}
              </optgroup>
            </select>
          </div>
          <div className={styles.composerInput}>
            <label className={styles.srOnly} htmlFor="student-question-content">질문 내용</label>
            <textarea id="student-question-content" value={content} onChange={(event) => updateContent(event.target.value)} maxLength={500} placeholder="수업 중 궁금한 점을 남겨 주세요." disabled={submitting} />
            <div><span>{content.length}/500</span><button type="submit" disabled={!content.trim() || submitting}>{submitting ? "전송 중..." : <><Send aria-hidden="true" /> 질문 전송</>}</button></div>
          </div>
        </form>
      )}
    </div>
  );

  if (embedded) return panel;

  return (
    <LiveRoomShell
      homeTo={basePath}
      homeLabel="NoDo 학생 강의 홈"
      roomTitle={feed.roomTitle}
      roomMeta={`익명 수강생 · ${feed.nickname}`}
      panelLabel="학생 질문 작업 패널"
      panelTitle="질문과 답변"
      headerAction={<button type="button" className={styles.leaveButton} onClick={() => void exitRoom()} disabled={leaving}><LogOut aria-hidden="true" /> {leaving ? "나가는 중" : "나가기"}</button>}
      tabs={[
        { label: <>채팅 <b>{feed.questions.length}</b></>, to: `${basePath}/chat`, active: true },
        { label: "로드맵", to: `${basePath}/checklist`, active: false },
      ]}
      context={
        <>
          <div className={styles.liveContextHeading}>
            <p className={styles.eyebrow}>공개 질문 채팅</p>
            <h1 id="student-chat-title">질문과 답변</h1>
            <p>공개 질문과 강사의 공식 답변을 확인하고, 현재 수업 흐름에 연결된 질문을 남길 수 있어요.</p>
          </div>
          <dl className={styles.liveContextFacts}>
            <div><dt>선택한 문맥</dt><dd>{contextLabel(selectedContext, feed)}</dd></div>
            <div><dt>이 문맥의 공개 질문</dt><dd>{visibleQuestions.length}건</dd></div>
          </dl>
          <section className={styles.currentFlowContext} aria-labelledby="student-question-context-title">
            <p>질문 작성 안내</p>
            <h2 id="student-question-context-title">{contextLabel(selectedContext, feed)}</h2>
            <span>항목 질문은 로드맵의 질문 배지에서 해당 문맥으로 이동해 바로 확인할 수 있어요.</span>
          </section>
          <LiveRoomMaterialPane user={user} scope={{ mode: "student", orgId, roomCode }} />
        </>
      }
      panel={panel}
    />
  );
}
