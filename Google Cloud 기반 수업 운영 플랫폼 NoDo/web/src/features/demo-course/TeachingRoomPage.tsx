import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Eraser,
  Maximize2,
  MessageCircle,
  PenLine,
  Send,
  Square,
  Underline,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getChapterCompletedCount,
  getCompletedFlowItemCount,
  getCourseCompletionPercent,
  getCurrentProgressItem,
  getDisplayedFlowItem,
  getIsCourseCompleted,
  getIsItemCompletionToggleEnabled,
  getOrderedFlowItems,
  getQuestionCountsForItem,
} from "./demoCourseSelectors";
import { useDemoCourse } from "./DemoCourseContext";
import { DemoCourseHeader } from "./DemoCourseHeader";
import type {
  CourseFlowItem,
  DemoQuestion,
} from "./demoCourseTypes";
import { validateDemoQuestion } from "./demoQuestionRules";
import styles from "./TeachingRoomPage.module.css";

type TeachingRoomPageProps = {
  view: "CHECKLIST" | "CHAT";
};

export function TeachingRoomPage({ view }: TeachingRoomPageProps) {
  const { state, actions } = useDemoCourse();
  const orderedItems = getOrderedFlowItems(state);
  const currentProgressItem = getCurrentProgressItem(state);
  const displayedItem = getDisplayedFlowItem(state);
  const panelName = view === "CHECKLIST" ? "로드맵" : "채팅";
  const panelToggleLabel = state.isPanelExpanded
    ? "자료와 함께 보기"
    : `${panelName} 크게 보기`;

  return (
    <div
      className={`${styles.page} ${
        state.isPanelExpanded ? styles.panelOnlyPage : ""
      }`}
    >
      <DemoCourseHeader activeTab={view} showRoomCode />

      <div
        className={styles.roomToolbar}
        role="toolbar"
        aria-label="수업 화면 배치"
      >
        <button
          type="button"
          className={styles.panelToggleButton}
          aria-label={panelToggleLabel}
          aria-pressed={state.isPanelExpanded}
          title={
            state.isPanelExpanded
              ? "자료 영역을 복원하고 두 화면을 함께 표시합니다."
              : `${panelName} 패널을 작업 영역 전체 너비로 표시합니다.`
          }
          onClick={actions.togglePanelExpanded}
        >
          {state.isPanelExpanded ? (
            <Columns2 aria-hidden="true" size={17} />
          ) : (
            <Maximize2 aria-hidden="true" size={17} />
          )}
          {panelToggleLabel}
        </button>
      </div>

      <main
        className={`${styles.roomLayout} ${
          state.isPanelExpanded ? styles.panelOnly : ""
        }`}
        data-panel-expanded={state.isPanelExpanded}
      >
        {!state.isPanelExpanded ? (
          <MaterialStage
            currentProgressItem={currentProgressItem}
            displayedItem={displayedItem}
            orderedItems={orderedItems}
            onSelect={actions.selectItem}
          />
        ) : null}

        <aside
          className={`${styles.sidePanel} ${
            view === "CHAT" ? styles.chatSidePanel : ""
          }`}
          id="room-side-panel"
          role="tabpanel"
          aria-labelledby={
            view === "CHECKLIST" ? "room-checklist-tab" : "room-chat-tab"
          }
          aria-label={view === "CHECKLIST" ? "전체 로드맵" : "익명 채팅"}
        >
          {view === "CHECKLIST" ? (
            <ChecklistPanel />
          ) : (
            <ChatPanel />
          )}
        </aside>
      </main>
    </div>
  );
}

type MaterialStageProps = {
  currentProgressItem: CourseFlowItem | null;
  displayedItem: CourseFlowItem | null;
  orderedItems: CourseFlowItem[];
  onSelect: (itemId: string) => void;
};

function MaterialStage({
  currentProgressItem,
  displayedItem,
  orderedItems,
  onSelect,
}: MaterialStageProps) {
  const { state } = useDemoCourse();
  const selectedIndex = displayedItem
    ? orderedItems.findIndex((item) => item.id === displayedItem.id)
    : -1;
  const displayedChapterIndex = displayedItem
    ? state.chapters.findIndex(
        (chapter) => chapter.id === displayedItem.chapterId,
      )
    : -1;
  const sharedMaterial = state.materials[0];
  const courseCompleted = getIsCourseCompleted(state);

  return (
    <section className={styles.materialStage} aria-labelledby="material-title">
      <div className={styles.stageIntro}>
        <div>
          <p>STEP 02 · 발표 화면</p>
          <h1 id="material-title">
            {courseCompleted ? (
              <span>모든 항목을 완료했어요</span>
            ) : (
              <>
                지금 <span>진행중</span>인 항목이 보여요
              </>
            )}
          </h1>
          <p>
            과거나 미래 항목을 미리 볼 수 있으며, 파란 현재 표시는 실제 수업
            진행 위치를 뜻해요.
          </p>
        </div>
        <button type="button" disabled title="실제 파일 공유는 구현하지 않았습니다.">
          다른 파일로 바꾸기
        </button>
      </div>

      <div className={styles.shareStrip}>
        <span>
          <strong>지금 공유 중</strong> · {sharedMaterial?.name ?? "mock_material.pdf"} ·
          A1B2C9
        </span>
        <span>● 18 / 24명 받음</span>
        <button type="button" disabled>
          새로 공유하기
        </button>
      </div>

      <div className={styles.stageWorkspace}>
        <nav className={styles.previewRail} aria-label="항목 미리보기 목록">
          {orderedItems.map((item, index) => (
            <button
              className={`${
                displayedItem?.id === item.id ? styles.activePreview : ""
              } ${
                currentProgressItem?.id === item.id
                  ? styles.currentPreview
                  : ""
              } ${item.isCompleted ? styles.completedPreview : ""}`}
              key={item.id}
              type="button"
              aria-current={
                currentProgressItem?.id === item.id ? "step" : undefined
              }
              aria-pressed={displayedItem?.id === item.id}
              onClick={() => onSelect(item.id)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{item.materialLabel}</strong>
              <small>
                {item.isCompleted
                  ? "완료"
                  : currentProgressItem?.id === item.id
                    ? "현재 진행"
                    : "미완료"}
              </small>
            </button>
          ))}
        </nav>

        <div className={styles.materialContent}>
          <div className={styles.highlightTools} aria-label="강조 도구">
            <span>강조 도구</span>
            <button type="button" aria-label="펜 도구" aria-pressed="true">
              <PenLine aria-hidden="true" size={18} />
            </button>
            <button type="button" aria-label="사각형 도구">
              <Square aria-hidden="true" size={18} />
            </button>
            <button type="button" aria-label="밑줄 도구">
              <Underline aria-hidden="true" size={18} />
            </button>
            <button type="button" aria-label="지우개 도구">
              <Eraser aria-hidden="true" size={18} />
            </button>
          </div>

          <article
            className={styles.materialCard}
            aria-label="현재 자료"
            aria-live="polite"
          >
            {displayedItem ? (
              <>
                <header>
                  <span>
                    CH.{String(displayedChapterIndex + 1).padStart(2, "0")} ·{" "}
                    {displayedItem.kind}
                  </span>
                  <span>
                    {String(selectedIndex + 1).padStart(2, "0")} /{" "}
                    {String(orderedItems.length).padStart(2, "0")}
                  </span>
                </header>
                <span className={styles.materialStatus}>
                  {displayedItem.id === currentProgressItem?.id
                    ? "현재 진행"
                    : "선택한 항목 미리보기"}
                </span>
                <h2>{displayedItem.title}</h2>
                {displayedItem.kind === "CODE" ? (
                  <pre aria-label="mock 코드 자료">
                    <code>{`1  def build_prompt(examples, question):\n2      prompt = ""\n3      for ex in examples:\n4          prompt += ____\n5      prompt += f"Q: {question}\\nA:"\n6      return prompt`}</code>
                  </pre>
                ) : (
                  <div className={styles.slideMock}>
                    <span>{displayedItem.kind}</span>
                    <strong>{displayedItem.title}</strong>
                    <p>{displayedItem.description}</p>
                  </div>
                )}
                <p className={styles.materialHint}>
                  {displayedItem.description} · 학생 화면과 함께 바뀌는 mock 자료예요.
                </p>
              </>
            ) : (
              <div className={styles.noMaterial}>
                <strong>표시할 수업 흐름 항목이 없습니다.</strong>
                <span>제작 화면에서 항목을 먼저 추가해 주세요.</span>
              </div>
            )}
          </article>

          <nav className={styles.slideNavigation} aria-label="자료 항목 이동">
            <button
              type="button"
              aria-label="이전 항목"
              disabled={selectedIndex <= 0}
              onClick={() => onSelect(orderedItems[selectedIndex - 1].id)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <span>
              {orderedItems.map((item) => (
                <i
                  className={
                    item.id === displayedItem?.id ? styles.activeDot : ""
                  }
                  key={item.id}
                />
              ))}
            </span>
            <button
              type="button"
              aria-label="다음 항목"
              disabled={selectedIndex < 0 || selectedIndex === orderedItems.length - 1}
              onClick={() => onSelect(orderedItems[selectedIndex + 1].id)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </nav>
        </div>
      </div>
    </section>
  );
}

function ChecklistPanel() {
  const navigate = useNavigate();
  const { state, actions } = useDemoCourse();
  const orderedItems = getOrderedFlowItems(state);
  const currentProgressItem = getCurrentProgressItem(state);
  const completedCount = getCompletedFlowItemCount(state);
  const completionPercent = getCourseCompletionPercent(state);
  const courseCompleted = getIsCourseCompleted(state);

  function openItemChat(itemId: string) {
    actions.selectItem(itemId);
    navigate("/rooms/demo-room/chat");
  }

  return (
    <div className={styles.checklistPanel}>
      <header className={styles.panelHeading}>
        <div>
          <span>COURSE CHECKLIST</span>
          <h2>챕터별 전체 로드맵</h2>
        </div>
        <span>
          {completedCount} / {orderedItems.length} · {completionPercent}%
        </span>
      </header>

      <div className={styles.overallProgress}>
        <div>
          <span>전체 진행률</span>
          <strong>{completionPercent}%</strong>
        </div>
        <progress
          max={orderedItems.length || 1}
          value={completedCount}
          aria-label="전체 수업 흐름 완료 진행률"
        />
        {courseCompleted ? (
          <p role="status">모든 항목을 완료했어요</p>
        ) : null}
      </div>

      <div className={styles.checklistChapters}>
        {state.chapters.map((chapter, chapterIndex) => {
          const chapterItems = chapter.itemIds
            .map((itemId) => state.items.find((item) => item.id === itemId))
            .filter((item) => item !== undefined);
          const chapterCompletedCount = getChapterCompletedCount(
            state,
            chapter.id,
          );
          return (
            <section key={chapter.id} aria-labelledby={`${chapter.id}-checklist`}>
              <header>
                <span>{String(chapterIndex + 1).padStart(2, "0")}</span>
                <h3 id={`${chapter.id}-checklist`}>{chapter.title}</h3>
                <strong>
                  {chapterCompletedCount} / {chapterItems.length}
                </strong>
                <progress
                  max={chapterItems.length || 1}
                  value={chapterCompletedCount}
                  aria-label={`${chapter.title} 완료 진행률`}
                />
              </header>

              <div className={styles.checklistItems}>
                {chapterItems.map((item, itemIndex) => {
                  const counts = getQuestionCountsForItem(state, item.id);
                  const isCurrent = currentProgressItem?.id === item.id;
                  const completionState = item.isCompleted
                    ? "completed"
                    : isCurrent
                      ? "current"
                      : "future";
                  const canToggle = getIsItemCompletionToggleEnabled(
                    state,
                    item.id,
                  );
                  return (
                    <article
                      className={`${styles.checklistItem} ${
                        item.isCompleted ? styles.completedChecklistItem : ""
                      } ${isCurrent ? styles.currentChecklistItem : ""} ${
                        state.selectedItemId === item.id
                          ? styles.selectedChecklistItem
                          : ""
                      }`}
                      key={item.id}
                      data-checklist-item-id={item.id}
                      data-completion-state={completionState}
                    >
                      <div className={styles.itemMainRow}>
                        <label
                          className={styles.completionCheckbox}
                          title={
                            canToggle
                              ? `${item.title} 완료 여부 변경`
                              : "앞 항목을 먼저 완료해 주세요"
                          }
                        >
                          <input
                            type="checkbox"
                            aria-label={`${item.title} 완료`}
                            checked={item.isCompleted}
                            disabled={!canToggle}
                            onChange={() =>
                              actions.toggleItemCompletion(item.id)
                            }
                          />
                        </label>
                        <button
                          className={styles.itemSelectButton}
                          type="button"
                          aria-pressed={state.selectedItemId === item.id}
                          onClick={() => actions.selectItem(item.id)}
                        >
                          <span>
                            <strong>
                              {chapterIndex + 1}.{itemIndex + 1} {item.title}
                            </strong>
                            <small>{item.description}</small>
                          </span>
                        </button>
                        {isCurrent ? (
                          <span className={styles.currentBadge}>현재 진행</span>
                        ) : null}
                      </div>

                      <div className={styles.checklistItemActions}>
                        <button
                          className={styles.questionBadge}
                          type="button"
                          aria-label={`${item.title} 질문 ${counts.total}개, 미확인 ${counts.unread}개 보기`}
                          onClick={() => openItemChat(item.id)}
                        >
                          <MessageCircle aria-hidden="true" size={14} />
                          {counts.total} · {counts.unread}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <footer className={styles.panelFooter}>
        <span>● 브라우저 상태로 실시간 동기화되고 있어요</span>
        <span>첫 번째 미완료 항목이 현재 진행 항목이에요</span>
      </footer>
    </div>
  );
}

function ChatPanel() {
  const { state, actions } = useDemoCourse();
  const orderedItems = getOrderedFlowItems(state);
  const currentProgressItem = getCurrentProgressItem(state);
  const currentChapterIndex = currentProgressItem
    ? state.chapters.findIndex(
        (chapter) => chapter.id === currentProgressItem.chapterId,
      )
    : -1;
  const [questionInput, setQuestionInput] = useState("");
  const [scopeValue, setScopeValue] = useState(
    state.selectedItemId ?? "GENERAL",
  );
  const [composerMessage, setComposerMessage] = useState(
    "실시간 mock 욕설·도배 필터링이 작동하고 있어요",
  );

  useEffect(() => {
    setScopeValue(state.selectedItemId ?? "GENERAL");
  }, [state.selectedItemId]);

  const visibleQuestions = useMemo(
    () => state.questions.filter((question) => !question.hidden),
    [state.questions],
  );
  const hiddenQuestions = useMemo(
    () => state.questions.filter((question) => question.hidden),
    [state.questions],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateDemoQuestion(questionInput, state.questions);
    if (!validation.valid) {
      setComposerMessage(validation.message);
      return;
    }
    const isGeneral = scopeValue === "GENERAL";
    actions.addQuestion(
      validation.content,
      isGeneral ? null : scopeValue,
      isGeneral,
    );
    setQuestionInput("");
    setComposerMessage("질문을 mock 상태에 추가했습니다.");
  }

  return (
    <div className={styles.chatPanel}>
      <header className={styles.panelHeading}>
        <div>
          <span>
            {currentProgressItem
              ? `현재 진행 · ${currentChapterIndex + 1} ${currentProgressItem.title}`
              : getIsCourseCompleted(state)
                ? "모든 항목 완료"
                : "현재 진행 항목 없음"}
          </span>
          <h2>익명 채팅</h2>
        </div>
        <span>참여 24명 · 오늘</span>
      </header>

      <div className={styles.questionList} aria-live="polite">
        {visibleQuestions.map((question) => (
          <QuestionCard
            key={question.id}
            question={question}
            item={state.items.find((item) => item.id === question.itemId)}
            onToggleAnswered={() =>
              actions.toggleQuestionAnswered(question.id)
            }
            onHide={() => actions.hideQuestion(question.id)}
          />
        ))}

        {hiddenQuestions.length > 0 ? (
          <section className={styles.hiddenQuestions} aria-label="숨겨진 질문">
            <h3>숨겨진 질문 {hiddenQuestions.length}개</h3>
            {hiddenQuestions.map((question) => (
              <div key={question.id}>
                <span>{question.nickname}의 질문을 숨겼습니다.</span>
                <button
                  type="button"
                  onClick={() => actions.restoreQuestion(question.id)}
                >
                  {question.nickname} 질문 복구
                </button>
              </div>
            ))}
          </section>
        ) : null}
      </div>

      <form className={styles.chatComposer} onSubmit={handleSubmit}>
        <label>
          <span>질문 연결</span>
          <select
            aria-label="질문 연결 대상"
            value={scopeValue}
            onChange={(event) => setScopeValue(event.target.value)}
          >
            <option value="GENERAL">일반 질문</option>
            {orderedItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <div>
          <input
            aria-label="질문 입력"
            placeholder="질문을 입력하세요 · Enter로 전송"
            value={questionInput}
            onChange={(event) => setQuestionInput(event.target.value)}
          />
          <button type="submit" aria-label="질문 전송">
            <Send aria-hidden="true" size={19} />
          </button>
        </div>
        <p role="status" aria-label="질문 전송 상태">
          ● {composerMessage}
        </p>
      </form>
    </div>
  );
}

type QuestionCardProps = {
  question: DemoQuestion;
  item: CourseFlowItem | undefined;
  onToggleAnswered: () => void;
  onHide: () => void;
};

function QuestionCard({
  question,
  item,
  onToggleAnswered,
  onHide,
}: QuestionCardProps) {
  const tag = question.isGeneral
    ? "일반 질문"
    : `${item?.kind === "CODE" ? "CODE · " : ""}${item?.title ?? "연결 항목"} 관련 질문`;

  return (
    <article
      className={`${styles.questionCard} ${
        question.needsReview ? styles.reviewQuestion : ""
      }`}
      data-question-id={question.id}
    >
      <span className={styles.questionTag}>{tag}</span>
      {question.needsReview ? (
        <span className={styles.reviewBadge}>검토 필요 · 강사에게만 보여요</span>
      ) : null}
      <div className={styles.questionIdentity}>
        <span aria-hidden="true">{question.avatar}</span>
        <strong>{question.nickname}</strong>
        {question.answered ? <span>답변 완료</span> : null}
      </div>
      <p className={styles.questionBubble}>{question.content}</p>
      {question.answer ? (
        <div className={styles.instructorAnswer}>
          <strong>나 (강사)</strong>
          <p>{question.answer}</p>
        </div>
      ) : null}
      <div className={styles.questionActions}>
        <button type="button" onClick={onToggleAnswered}>
          {question.answered ? "답변 완료 취소" : "답변 완료로 변경"}
        </button>
        <button type="button" onClick={onHide}>
          {question.nickname} 질문 숨기기
        </button>
      </div>
    </article>
  );
}
