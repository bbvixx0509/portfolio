import {
  ArrowDown,
  ArrowUp,
  Check,
  FileUp,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { importCourseMocks } from "../../data/importPageMocks";
import { NotFoundPage } from "../../pages/NotFoundPage";
import {
  getCurrentProgressItem,
  getIsCourseCompleted,
  getQuestionCountsForItem,
} from "./demoCourseSelectors";
import {
  getDemoMaterialFormat,
  useDemoCourse,
} from "./DemoCourseContext";
import { DemoCourseHeader } from "./DemoCourseHeader";
import type {
  DemoCourseSource,
  DemoMaterialFormat,
} from "./demoCourseTypes";
import styles from "./CourseFlowBuilderPage.module.css";

type CourseFlowBuilderPageProps = {
  source: "material" | "manual" | "import";
};

const sourceLabels = {
  material: "자료로 만들기",
  manual: "직접 만들기",
  import: "기존 목록 이어서 만들기",
} as const;

export function CourseFlowBuilderPage({ source }: CourseFlowBuilderPageProps) {
  const navigate = useNavigate();
  const { courseId: routeCourseId } = useParams();
  const importedCourse = importCourseMocks.find(
    (course) => course.id === routeCourseId,
  );
  const { state, actions } = useDemoCourse();
  const [newItemTitle, setNewItemTitle] = useState("");
  const [newItemChapterId, setNewItemChapterId] = useState("");
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [notice, setNotice] = useState("자동 백업 저장 · 바뀐 부분만 다시 정리");
  const currentProgressItem = getCurrentProgressItem(state);
  const allItemsCompleted = getIsCourseCompleted(state);

  const sourceConfig = useMemo(() => {
    if (source === "import") {
      if (!importedCourse) {
        return null;
      }
      return {
        source: `import:${importedCourse.id}` as DemoCourseSource,
        courseId: importedCourse.id,
        title: importedCourse.title,
      };
    }
    return {
      source,
      courseId: `draft-${source}`,
      title: source === "material" ? "자료 기반 새 강의" : "직접 만든 새 강의",
    };
  }, [importedCourse, source]);

  useEffect(() => {
    if (!sourceConfig) {
      return;
    }
    actions.initializeSource(sourceConfig);
  }, [actions, sourceConfig]);

  useEffect(() => {
    const isAvailableChapter = state.chapters.some(
      (chapter) => chapter.id === newItemChapterId,
    );

    if (!isAvailableChapter) {
      setNewItemChapterId(state.chapters[0]?.id ?? "");
    }
  }, [newItemChapterId, state.chapters]);

  if (!sourceConfig) {
    return <NotFoundPage />;
  }

  function registerFiles(files: FileList | readonly File[]) {
    const selectedFiles = Array.from(files);
    for (const file of selectedFiles) {
      actions.addMaterial(file.name, getDemoMaterialFormat(file.name));
    }
    if (selectedFiles.length > 0) {
      setNotice(
        `${selectedFiles.length}개 파일의 이름과 형식만 브라우저 상태에 저장했습니다. 파일 내용은 읽거나 전송하지 않았습니다.`,
      );
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) {
      registerFiles(event.target.files);
    }
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    registerFiles(event.dataTransfer.files);
  }

  function handleAddItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newItemTitle.trim();
    if (!title || !newItemChapterId) {
      setNotice("항목 이름과 챕터를 확인해 주세요.");
      return;
    }
    actions.addItem(newItemChapterId, title);
    setNewItemTitle("");
    setNotice(`“${title}” 항목을 추가하고 브라우저 상태에 자동 저장했습니다.`);
  }

  function handleAddChapter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newChapterTitle.trim();
    if (!title) {
      setNotice("새 챕터 이름을 입력해 주세요.");
      return;
    }
    actions.addChapter(title);
    setNewChapterTitle("");
    setNotice(`“${title}” 챕터를 추가했습니다.`);
  }

  function startEditing(itemId: string, title: string) {
    setEditingItemId(itemId);
    setEditingTitle(title);
  }

  function saveEditing(itemId: string) {
    const title = editingTitle.trim();
    if (!title) {
      setNotice("항목 이름은 비워 둘 수 없습니다.");
      return;
    }
    actions.updateItem(itemId, title);
    setEditingItemId(null);
    setNotice(`“${title}” 항목의 이름을 수정했습니다.`);
  }

  function handleGenerateFlow() {
    actions.generateMockFlow();
    setNotice("AI 대신 준비된 mock 수업 흐름 6개를 표시했습니다.");
  }

  function handleStartCourse() {
    actions.startCourse();
    navigate("/rooms/demo-room/checklist");
  }

  return (
    <div className={styles.page}>
      <DemoCourseHeader activeTab="BUILDER" />

      <main className={styles.builder}>
        <section className={styles.setupPanel} aria-labelledby="builder-title">
          <div className={styles.intro}>
            <p className={styles.step}>STEP 01 · 자료 · 코드 · 데이터 등록</p>
            <h1 id="builder-title">Make RoadMap</h1>
            <p>
              PPT · PDF 발표 자료와 코드 · 데이터 파일을 함께 정리해
              NoDo 수업 흐름을 만들어요.
            </p>
            <span className={styles.sourceBadge}>{sourceLabels[source]}</span>
          </div>

          {source === "material" ? (
            <div
              className={styles.uploadCard}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              <div className={styles.uploadCardHeading}>
                <span>UPLOAD</span>
                <span>STEP 01</span>
              </div>
              <FileUp aria-hidden="true" size={44} strokeWidth={1.8} />
              <h2>파일을 여기로 끌어다 놓으세요</h2>
              <p>
                지원 형식 <strong>PPTX · PDF · 코드 파일 · 데이터 파일</strong>
              </p>
              <p>파일 내용은 읽지 않고 이름과 형식만 mock 상태에 저장해요.</p>
              <label className={styles.fileButton}>
                파일 선택하기
                <input
                  className={styles.fileInput}
                  type="file"
                  multiple
                  aria-label="자료 파일 선택"
                  onChange={handleFileChange}
                />
              </label>
              <div className={styles.formatList} aria-label="지원 파일 형식">
                {(["PPTX", "PDF", "CODE", "DATA"] as DemoMaterialFormat[]).map(
                  (format) => (
                    <span key={format}>
                      {format === "PPTX" || format === "PDF"
                        ? `.${format}`
                        : format}
                    </span>
                  ),
                )}
              </div>
            </div>
          ) : (
            <div className={styles.sourceCard}>
              <Sparkles aria-hidden="true" size={34} />
              <h2>
                {source === "manual"
                  ? "빈 수업 흐름에서 시작해요"
                  : sourceConfig.title}
              </h2>
              <p>
                {source === "manual"
                  ? "오른쪽에서 챕터와 항목을 직접 추가해 나만의 수업 순서를 만들어 주세요."
                  : "선택한 강의 ID · "}
                {source === "import" ? (
                  <strong>{sourceConfig.courseId}</strong>
                ) : null}
              </p>
              {source === "import" ? (
                <nav className={styles.sourceLinks} aria-label="불러온 강의 이동">
                  <Link to="/courses/import">목록 화면으로 돌아가기</Link>
                  <Link to="/">시작 화면으로 돌아가기</Link>
                </nav>
              ) : (
                <Link to="/">시작 화면으로 돌아가기</Link>
              )}
            </div>
          )}

          <section className={styles.materialSummary} aria-label="선택한 파일">
            <div>
              <h2>선택한 파일</h2>
              <span>{state.materials.length}개</span>
            </div>
            {state.materials.length > 0 ? (
              <ul>
                {state.materials.map((material) => (
                  <li key={material.id}>
                    <strong>{material.name}</strong>
                    <span>{material.format}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>아직 선택한 파일이 없습니다.</p>
            )}
            {source === "material" ? (
              <button
                type="button"
                disabled={state.materials.length === 0}
                onClick={handleGenerateFlow}
              >
                <Sparkles aria-hidden="true" size={17} />
                AI로 mock 수업 흐름 생성
              </button>
            ) : null}
          </section>

          <p
            className={styles.autoSave}
            role="status"
            aria-label="자동 저장 상태"
          >
            {notice}
          </p>
        </section>

        <aside className={styles.flowPanel} aria-label="챕터와 수업 흐름">
          <div className={styles.flowHeading}>
            <div>
              <span>COURSE FLOW</span>
              <h2>{state.course.title}</h2>
            </div>
            <span className={styles.courseStatus}>
              {allItemsCompleted
                ? "강의 완료"
                : state.course.status === "LIVE"
                  ? "강의 진행 중"
                  : "강의 준비 중"}
            </span>
          </div>

          <div className={styles.chapterList}>
            {state.chapters.map((chapter, chapterIndex) => {
              const chapterItems = chapter.itemIds
                .map((itemId) => state.items.find((item) => item.id === itemId))
                .filter((item) => item !== undefined);
              const completedCount = chapterItems.filter(
                (item) => item.isCompleted,
              ).length;
              return (
                <section
                  className={styles.chapter}
                  key={chapter.id}
                  aria-labelledby={`${chapter.id}-title`}
                >
                  <header>
                    <span>{String(chapterIndex + 1).padStart(2, "0")}</span>
                    <h3 id={`${chapter.id}-title`}>{chapter.title}</h3>
                    <strong>
                      {completedCount} / {chapterItems.length}
                    </strong>
                  </header>

                  {chapterItems.length > 0 ? (
                    <ol>
                      {chapterItems.map((item, itemIndex) => {
                        const counts = getQuestionCountsForItem(state, item.id);
                        const isEditing = editingItemId === item.id;
                        const isCurrent = currentProgressItem?.id === item.id;
                        const progressState = item.isCompleted
                          ? "completed"
                          : isCurrent
                            ? "current"
                            : "future";
                        const progressLabel = item.isCompleted
                          ? "완료"
                          : isCurrent
                            ? "현재 진행"
                            : "미완료";
                        return (
                          <li
                            className={
                              item.isCompleted
                                ? styles.completedItem
                                : isCurrent
                                  ? styles.currentItem
                                  : styles.futureItem
                            }
                            key={item.id}
                            data-flow-item-id={item.id}
                            data-completion-state={progressState}
                            aria-current={isCurrent ? "step" : undefined}
                          >
                            <div className={styles.itemMain}>
                              <span className={styles.itemNumber}>
                                {chapterIndex + 1}.{itemIndex + 1}
                              </span>
                              {isEditing ? (
                                <form
                                  className={styles.inlineEdit}
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    saveEditing(item.id);
                                  }}
                                >
                                  <label>
                                    <span className={styles.srOnly}>항목 이름</span>
                                    <input
                                      aria-label={`${item.title} 새 이름`}
                                      value={editingTitle}
                                      onChange={(event) =>
                                        setEditingTitle(event.target.value)
                                      }
                                    />
                                  </label>
                                  <button type="submit">저장</button>
                                </form>
                              ) : (
                                <div className={styles.itemCopy}>
                                  <strong>{item.title}</strong>
                                  <span>{item.description}</span>
                                </div>
                              )}
                              <span
                                className={styles.questionCount}
                                aria-label={`질문 ${counts.total}개, 미확인 ${counts.unread}개`}
                              >
                                💬 {counts.total} · {counts.unread}
                              </span>
                            </div>

                            <div className={styles.itemActions}>
                              <span
                                className={`${styles.itemProgressState} ${
                                  item.isCompleted
                                    ? styles.completedState
                                    : isCurrent
                                      ? styles.currentState
                                      : styles.futureState
                                }`}
                                aria-label={`${item.title} 진행 상태: ${progressLabel}`}
                              >
                                {item.isCompleted ? (
                                  <Check aria-hidden="true" size={14} />
                                ) : (
                                  <i aria-hidden="true" />
                                )}
                                {progressLabel}
                              </span>
                              <button
                                type="button"
                                aria-label={`${item.title} 수정`}
                                onClick={() => startEditing(item.id, item.title)}
                              >
                                <Pencil aria-hidden="true" size={15} />
                              </button>
                              <button
                                type="button"
                                aria-label={`${item.title} 위로 이동`}
                                disabled={itemIndex === 0}
                                onClick={() => actions.moveItem(item.id, "UP")}
                              >
                                <ArrowUp aria-hidden="true" size={15} />
                              </button>
                              <button
                                type="button"
                                aria-label={`${item.title} 아래로 이동`}
                                disabled={itemIndex === chapterItems.length - 1}
                                onClick={() => actions.moveItem(item.id, "DOWN")}
                              >
                                <ArrowDown aria-hidden="true" size={15} />
                              </button>
                              <button
                                type="button"
                                aria-label={`${item.title} 삭제`}
                                onClick={() => actions.deleteItem(item.id)}
                              >
                                <Trash2 aria-hidden="true" size={15} />
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className={styles.emptyChapter}>
                      아직 항목이 없습니다. 아래에서 첫 항목을 추가해 주세요.
                    </p>
                  )}
                </section>
              );
            })}
          </div>

          <div className={styles.editorForms}>
            <form onSubmit={handleAddItem}>
              <h3>항목 추가</h3>
              <select
                aria-label="항목을 추가할 챕터"
                value={newItemChapterId}
                onChange={(event) => setNewItemChapterId(event.target.value)}
              >
                {state.chapters.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>
                    {chapter.title}
                  </option>
                ))}
              </select>
              <input
                aria-label="새 항목 이름"
                placeholder="예: 실습 환경 준비"
                value={newItemTitle}
                onChange={(event) => setNewItemTitle(event.target.value)}
              />
              <button type="submit">
                <Plus aria-hidden="true" size={15} /> 항목 추가
              </button>
            </form>

            <form onSubmit={handleAddChapter}>
              <h3>챕터 추가</h3>
              <input
                aria-label="새 챕터 이름"
                placeholder="예: 실전 프로젝트"
                value={newChapterTitle}
                onChange={(event) => setNewChapterTitle(event.target.value)}
              />
              <button type="submit">
                <Plus aria-hidden="true" size={15} /> 챕터 추가
              </button>
            </form>
          </div>

          <footer className={styles.flowFooter}>
            <span>● 새로고침 전까지 브라우저에서 자동 저장돼요</span>
            <button
              type="button"
              disabled={state.items.length === 0}
              onClick={handleStartCourse}
            >
              강의 시작
            </button>
          </footer>
        </aside>
      </main>
    </div>
  );
}
