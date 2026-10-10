import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  MessageCircle,
  RotateCcw,
  Send,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import type { User } from "firebase/auth";
import { requestApi } from "../../lib/api/apiClient";
import type { AuthProfile } from "../auth/authTypes";
import { numberedCourseItemLabel } from "./courseItemNumbers";
import type { LiveCourseItem, LiveQuestion } from "./liveCourseTypes";
import {
  compareQuestionKeys,
  questionContextId,
  questionIsUnread,
  type QuestionReadWatermark,
} from "./useLiveQuestions";
import styles from "./LiveQuestionPanel.module.css";

type PendingQuestionRequest = {
  content: string;
  itemId: string | null;
  clientRequestId: string;
};

type LiveQuestionPanelProps = {
  roomId: string;
  questions: LiveQuestion[];
  items: LiveCourseItem[];
  itemNumberById: ReadonlyMap<string, string>;
  profile: AuthProfile | null;
  user: User | null;
  filterContext: string;
  onFilterContextChange: (contextId: string) => void;
  readWatermarkByContext: Record<string, QuestionReadWatermark>;
  canAnswerQuestions: boolean;
  canModerateQuestions: boolean;
  isQuestionRestricted: boolean;
  isRoomActive: boolean;
  isLoading: boolean;
  subscriptionError: string | null;
};

function requestId() {
  return crypto.randomUUID();
}

function matchesContext(question: LiveQuestion, contextId: string) {
  return contextId === "ALL" || questionContextId(question) === contextId;
}

function questionContextLabel(
  question: LiveQuestion,
  itemNumberById: ReadonlyMap<string, string>,
) {
  if (question.isGeneral || !question.itemId) return "일반 질문방";
  const itemNumber =
    question.itemNumberSnapshot ?? itemNumberById.get(question.itemId);
  const title = question.itemTitleSnapshot ?? "연결된 수업 항목";
  return itemNumber ? `${itemNumber} ${title}` : title;
}

function roomRoleLabel(roomRole: "LEAD" | "ASSISTANT") {
  return roomRole === "ASSISTANT" ? "보조 강사" : "주 강사";
}

export function countQuestionsForContext(
  questions: LiveQuestion[],
  contextId: string,
) {
  return questions.filter((question) => matchesContext(question, contextId)).length;
}

export function countUnreadQuestionsForContext(
  questions: LiveQuestion[],
  contextId: string,
  readWatermarkByContext: Record<string, QuestionReadWatermark>,
) {
  return questions.filter(
    (question) =>
      matchesContext(question, contextId) &&
      questionIsUnread(question, readWatermarkByContext),
  ).length;
}

export function LiveQuestionPanel({
  roomId,
  questions,
  items,
  itemNumberById,
  profile,
  user,
  filterContext,
  onFilterContextChange,
  readWatermarkByContext,
  canAnswerQuestions,
  canModerateQuestions,
  isQuestionRestricted,
  isRoomActive,
  isLoading,
  subscriptionError,
}: LiveQuestionPanelProps) {
  const requestedChecklistItem =
    filterContext !== "ALL" && filterContext !== "GENERAL"
      ? filterContext
      : null;
  const [questionMode, setQuestionMode] = useState<"GENERAL" | "CHECKLIST">(
    requestedChecklistItem ? "CHECKLIST" : "GENERAL",
  );
  const [questionScope, setQuestionScope] = useState(
    requestedChecklistItem ?? items[0]?.id ?? "",
  );
  const [questionDraft, setQuestionDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const sendInFlightRef = useRef(false);
  const retryRequestRef = useRef<PendingQuestionRequest | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const lastReadRequestRef = useRef("");

  const isStaff = profile?.accountType === "STAFF";
  const canAskQuestions =
    profile?.accountType === "STUDENT" && isRoomActive && !isQuestionRestricted;

  useEffect(() => {
    if (filterContext === "GENERAL") {
      setQuestionMode("GENERAL");
      return;
    }
    if (filterContext !== "ALL") {
      setQuestionMode("CHECKLIST");
      setQuestionScope(filterContext);
    }
  }, [filterContext]);

  useEffect(() => {
    if (
      questionMode === "CHECKLIST" &&
      !items.some((item) => item.id === questionScope)
    ) {
      setQuestionScope(items[0]?.id ?? "");
    }
  }, [items, questionMode, questionScope]);

  const filteredQuestions = useMemo(
    () =>
      questions
        .filter((question) => matchesContext(question, filterContext))
        .sort((first, second) =>
          compareQuestionKeys(
            {
              observedAtMillis: first.createdAtMillis,
              observedQuestionId: first.id,
            },
            {
              observedAtMillis: second.createdAtMillis,
              observedQuestionId: second.id,
            },
          ),
        ),
    [filterContext, questions],
  );

  const groupedQuestions = useMemo(() => {
    const groups = new Map<string, LiveQuestion[]>();
    for (const question of filteredQuestions) {
      const contextId = questionContextId(question);
      groups.set(contextId, [...(groups.get(contextId) ?? []), question]);
    }
    const contextOrder = new Map([
      ["GENERAL", -1],
      ...items.map((item, index) => [item.id, index] as const),
    ]);
    return [...groups.entries()].sort(
      ([first], [second]) =>
        (contextOrder.get(first) ?? Number.MAX_SAFE_INTEGER) -
        (contextOrder.get(second) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [filteredQuestions, items]);

  useEffect(() => {
    if (!isStaff || !user || filteredQuestions.length === 0) return;
    const latestQuestion = filteredQuestions.reduce((latest, question) =>
      compareQuestionKeys(
        {
          observedAtMillis: question.createdAtMillis,
          observedQuestionId: question.id,
        },
        {
          observedAtMillis: latest.createdAtMillis,
          observedQuestionId: latest.id,
        },
      ) > 0
        ? question
        : latest,
    );
    if (!latestQuestion.createdAt) return;
    const emptyWatermark: QuestionReadWatermark = {
      observedAtMillis: 0,
      observedQuestionId: "",
    };
    const contextWatermark =
      filterContext === "ALL"
        ? emptyWatermark
        : readWatermarkByContext[filterContext] ?? emptyWatermark;
    const allWatermark = readWatermarkByContext.ALL ?? emptyWatermark;
    const currentWatermark =
      compareQuestionKeys(contextWatermark, allWatermark) >= 0
        ? contextWatermark
        : allWatermark;
    const latestWatermark = {
      observedAtMillis: latestQuestion.createdAtMillis,
      observedQuestionId: latestQuestion.id,
    };
    if (compareQuestionKeys(latestWatermark, currentWatermark) <= 0) return;
    const requestKey = `${filterContext}:${latestQuestion.createdAtMillis}:${latestQuestion.id}`;
    if (lastReadRequestRef.current === requestKey) return;
    lastReadRequestRef.current = requestKey;
    void requestApi(`/api/rooms/${encodeURIComponent(roomId)}/questions/read`, {
      method: "POST",
      body: {
        contextId: filterContext,
        observedAt: latestQuestion.createdAt,
        observedQuestionId: latestQuestion.id,
      },
      authUser: user,
    }).catch(() => {
      lastReadRequestRef.current = "";
    });
  }, [
    filterContext,
    filteredQuestions,
    isStaff,
    readWatermarkByContext,
    roomId,
    user,
  ]);

  function updateDraft(value: string) {
    setQuestionDraft(value);
    const retry = retryRequestRef.current;
    if (retry && retry.content !== value.trim()) retryRequestRef.current = null;
  }

  async function sendQuestion() {
    if (sendInFlightRef.current || !canAskQuestions || !user) return;
    const content = questionDraft.trim();
    if (!content) {
      setNotice("질문 내용을 입력해 주세요.");
      return;
    }
    if (Array.from(content).length > 500) {
      setNotice("질문은 500자 이하로 입력해 주세요.");
      return;
    }
    const itemId = questionMode === "GENERAL" ? null : questionScope || null;
    if (questionMode === "CHECKLIST" && !itemId) {
      setNotice("질문할 로드맵 항목을 선택해 주세요.");
      return;
    }
    const retry = retryRequestRef.current;
    const request =
      retry && retry.content === content && retry.itemId === itemId
        ? retry
        : { content, itemId, clientRequestId: requestId() };
    retryRequestRef.current = request;
    sendInFlightRef.current = true;
    setIsSending(true);
    setNotice("질문을 안전하게 전송하고 있습니다.");
    try {
      await requestApi(`/api/rooms/${encodeURIComponent(roomId)}/questions`, {
        method: "POST",
        body: request,
        authUser: user,
      });
      retryRequestRef.current = null;
      setQuestionDraft("");
      setNotice("질문을 전송했습니다.");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "질문을 전송하지 못했습니다.",
      );
    } finally {
      sendInFlightRef.current = false;
      setIsSending(false);
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendQuestion();
  }

  function handleQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendQuestion();
    }
  }

  async function runQuestionAction(
    questionId: string,
    action: "answer" | "remove-answer" | "hide" | "restore" | "approve",
  ) {
    if (!user || !isRoomActive || pendingAction) return;
    const actionKey = `${questionId}:${action}`;
    setPendingAction(actionKey);
    setNotice(null);
    try {
      if (action === "answer") {
        const answer = (answerDrafts[questionId] ?? "").trim();
        if (!answer) {
          setNotice("답변 내용을 입력해 주세요.");
          return;
        }
        await requestApi(
          `/api/rooms/${encodeURIComponent(roomId)}/questions/${encodeURIComponent(questionId)}/answer`,
          { method: "PUT", body: { answer }, authUser: user },
        );
      } else if (action === "remove-answer") {
        await requestApi(
          `/api/rooms/${encodeURIComponent(roomId)}/questions/${encodeURIComponent(questionId)}/answer`,
          { method: "DELETE", authUser: user },
        );
      } else {
        await requestApi(
          `/api/rooms/${encodeURIComponent(roomId)}/questions/${encodeURIComponent(questionId)}/${action}`,
          { method: "POST", authUser: user },
        );
      }
      setNotice("질문 상태를 저장했습니다.");
      if (action === "answer") {
        setAnswerDrafts((current) => {
          const next = { ...current };
          delete next[questionId];
          return next;
        });
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "질문 상태를 저장하지 못했습니다.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="live-question-title">
      <div className={styles.heading}>
        <div>
          <p>REALTIME QUESTIONS</p>
          <h2 id="live-question-title">익명 질문</h2>
        </div>
        <div className={styles.metrics} aria-label="질문 현황">
          <span>전체 <strong>{questions.length}</strong></span>
          {isStaff ? (
            <span>
              미확인 <strong>{countUnreadQuestionsForContext(questions, "ALL", readWatermarkByContext)}</strong>
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.filters}>
        <label>
          <span>질문 필터</span>
          <select
            aria-label="질문 필터"
            value={filterContext}
            onChange={(event) => onFilterContextChange(event.target.value)}
          >
            <option value="ALL">전체 질문 ({questions.length})</option>
            <option value="GENERAL">
              일반 질문방 ({countQuestionsForContext(questions, "GENERAL")}
              {isStaff
                ? ` · 미확인 ${countUnreadQuestionsForContext(questions, "GENERAL", readWatermarkByContext)}`
                : ""}
              )
            </option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {numberedCourseItemLabel(item, itemNumberById)} ({countQuestionsForContext(questions, item.id)}
                {isStaff
                  ? ` · 미확인 ${countUnreadQuestionsForContext(questions, item.id, readWatermarkByContext)}`
                  : ""}
                )
              </option>
            ))}
          </select>
        </label>
        {filterContext !== "ALL" ? (
          <button type="button" onClick={() => onFilterContextChange("ALL")}>
            전체 보기
          </button>
        ) : null}
      </div>

      {subscriptionError ? (
        <p className={styles.error} role="alert">
          질문을 실시간으로 불러오지 못했습니다: {subscriptionError}
        </p>
      ) : null}

      <div className={styles.questionList} aria-live="polite">
        {isLoading ? <p role="status">질문을 불러오는 중입니다.</p> : null}
        {!isLoading && groupedQuestions.length === 0 ? (
          <p className={styles.empty}>아직 표시할 질문이 없습니다.</p>
        ) : null}
        {groupedQuestions.map(([contextId, contextQuestions]) => (
          <section className={styles.questionGroup} key={contextId}>
            <h3>
              {contextId === "GENERAL"
                ? "일반 질문방"
                : questionContextLabel(contextQuestions[0], itemNumberById)}
              <span>{contextQuestions.length}</span>
              {isStaff ? (
                <small>
                  미확인 {countUnreadQuestionsForContext(
                    contextQuestions,
                    contextId,
                    readWatermarkByContext,
                  )}
                </small>
              ) : null}
            </h3>
            <ul>
              {contextQuestions.map((entry) => {
                const unread = isStaff && questionIsUnread(entry, readWatermarkByContext);
                const answerValue =
                  answerDrafts[entry.id] ?? entry.answer?.content ?? "";
                return (
                  <li
                    key={entry.id}
                    data-question-id={entry.id}
                    data-visibility={entry.visibility}
                    data-hidden={entry.isHidden ? "true" : "false"}
                  >
                    <header>
                      <span className={styles.avatar} aria-hidden="true">💬</span>
                      <div>
                        <strong>{entry.nicknameSnapshot}</strong>
                        <small>{questionContextLabel(entry, itemNumberById)}</small>
                      </div>
                      {unread ? <span className={styles.unread}>미확인</span> : null}
                      {entry.moderationStatus === "NEEDS_REVIEW" ? (
                        <span className={styles.reviewBadge}>
                          <AlertTriangle aria-hidden="true" size={12} /> 검토 필요
                        </span>
                      ) : null}
                      {entry.isHidden ? (
                        <span className={styles.hiddenBadge}>
                          <EyeOff aria-hidden="true" size={12} /> 숨김
                        </span>
                      ) : null}
                      {entry.isAnswered ? (
                        <span className={styles.answeredBadge}>
                          <CheckCircle2 aria-hidden="true" size={12} /> 답변 완료
                        </span>
                      ) : null}
                    </header>
                    <p className={styles.content}>{entry.content}</p>
                    {entry.answer ? (
                      <div className={styles.answer}>
                        <strong>
                          {entry.answer.instructorDisplayName} · {roomRoleLabel(entry.answer.roomRole)}
                        </strong>
                        <p>{entry.answer.content}</p>
                      </div>
                    ) : null}
                    {!entry.isGeneral && entry.itemId ? (
                      <div className={styles.contextSnapshot}>
                        <span>{entry.chapterTitleSnapshot ?? "수업 흐름"}</span>
                        <strong>
                          {questionContextLabel(entry, itemNumberById)}
                        </strong>
                        {entry.materialLabelSnapshot ? (
                          <small>{entry.materialLabelSnapshot}</small>
                        ) : null}
                        <Link to={`/rooms/${roomId}/checklist?itemId=${encodeURIComponent(entry.itemId)}`}>
                          로드맵에서 보기
                        </Link>
                      </div>
                    ) : null}
                    {isRoomActive && canAnswerQuestions && !entry.isHidden ? (
                      <div className={styles.answerEditor}>
                        <textarea
                          aria-label={`${entry.nicknameSnapshot} 질문 답변`}
                          maxLength={2000}
                          value={answerValue}
                          onChange={(event) =>
                            setAnswerDrafts((current) => ({
                              ...current,
                              [entry.id]: event.target.value,
                            }))
                          }
                          placeholder="강사 답변을 입력해 주세요"
                        />
                        <button
                          type="button"
                          disabled={Boolean(pendingAction)}
                          onClick={() => void runQuestionAction(entry.id, "answer")}
                        >
                          {entry.isAnswered ? "답변 수정" : "답변 등록"}
                        </button>
                        {entry.isAnswered ? (
                          <button
                            type="button"
                            disabled={Boolean(pendingAction)}
                            onClick={() => void runQuestionAction(entry.id, "remove-answer")}
                          >
                            답변 취소
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {isRoomActive && canModerateQuestions ? (
                      <div className={styles.moderationActions}>
                        {entry.moderationStatus === "NEEDS_REVIEW" ? (
                          <button
                            type="button"
                            disabled={Boolean(pendingAction)}
                            onClick={() => void runQuestionAction(entry.id, "approve")}
                          >
                            <Eye aria-hidden="true" size={14} /> 공개 승인
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={Boolean(pendingAction)}
                          onClick={() =>
                            void runQuestionAction(
                              entry.id,
                              entry.isHidden ? "restore" : "hide",
                            )
                          }
                        >
                          {entry.isHidden ? (
                            <RotateCcw aria-hidden="true" size={14} />
                          ) : (
                            <EyeOff aria-hidden="true" size={14} />
                          )}
                          {entry.isHidden ? "질문 복구" : "질문 숨김"}
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {profile?.accountType === "STUDENT" ? (
        <form className={styles.composer} onSubmit={submitQuestion}>
          <div className={styles.composerControls}>
            <label>
              <span>질문 종류</span>
              <select
                aria-label="질문 종류"
                value={questionMode}
                disabled={!canAskQuestions || isSending}
                onChange={(event) =>
                  setQuestionMode(event.target.value as "GENERAL" | "CHECKLIST")
                }
              >
                <option value="GENERAL">일반 질문</option>
                <option value="CHECKLIST">로드맵 질문</option>
              </select>
            </label>
            {questionMode === "CHECKLIST" ? (
              <label>
                <span>로드맵 항목</span>
                <select
                  aria-label="로드맵 질문 항목"
                  value={questionScope}
                  disabled={!canAskQuestions || isSending}
                  onChange={(event) => setQuestionScope(event.target.value)}
                >
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {numberedCourseItemLabel(item, itemNumberById)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className={styles.composerEntry}>
            <MessageCircle aria-hidden="true" size={18} />
            <textarea
              aria-label="질문 입력"
              value={questionDraft}
              maxLength={500}
              disabled={!canAskQuestions || isSending}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={handleQuestionKeyDown}
              placeholder={
                !isRoomActive
                  ? "종료된 강의에서는 새 질문을 작성할 수 없습니다"
                  : isQuestionRestricted
                    ? "질문 작성이 제한되었습니다"
                    : "질문을 입력해 주세요 · Shift+Enter 줄바꿈"
              }
            />
            <button
              type="submit"
              disabled={!canAskQuestions || isSending || !questionDraft.trim()}
              aria-label="질문 보내기"
              aria-busy={isSending}
            >
              <Send aria-hidden="true" size={17} />
            </button>
          </div>
        </form>
      ) : (
        <p className={styles.staffHint}>수강생 질문이 Firestore Emulator에서 실시간으로 표시됩니다.</p>
      )}
      {isQuestionRestricted ? (
        <p className={styles.restricted} role="alert">
          강의 운영 정책에 따라 새 질문 작성이 제한되었습니다. 기존 자료와 공개 질문은 계속 볼 수 있습니다.
        </p>
      ) : null}
      {!isRoomActive ? (
        <p className={styles.restricted}>종료된 강의입니다. 질문과 답변은 읽기 전용으로 유지됩니다.</p>
      ) : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    </section>
  );
}
