import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FileUp,
  GripVertical,
  Link2Off,
  Pencil,
  Plus,
  Presentation,
  Save,
  Trash2,
} from "lucide-react";
import type { User } from "firebase/auth";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  attachCloudCourseMaterial,
  createCloudCourse,
  detachCloudCourseMaterial,
  getCloudCourse,
  listCloudCourseMaterials,
  loadCloudCourseMaterialContent,
  updateCloudCourse,
  type CourseMaterial,
  type CourseChapter,
  type CourseDraft,
  type CourseItem,
  type CourseRecord,
} from "../cloud-courses/courseApi";
import { MaterialFilePicker } from "./MaterialFilePicker";
import { uploadMaterialFile } from "./materialUploadApi";
import type { MaterialFileMetadata } from "./materialTypes";
import styles from "./MaterialCourseDraftEditorPage.module.css";
import editorStyles from "./CourseFlowEditorPage.module.css";

const emptyDraft = (): CourseDraft => ({
  title: "",
  description: "",
  chapters: [newChapter()],
});

const DEFAULT_ROADMAP_PANEL_WIDTH = 440;
const MIN_ROADMAP_PANEL_WIDTH = 380;
const MAX_ROADMAP_PANEL_WIDTH = 560;
const ROADMAP_PANEL_RATIO_LIMIT = 0.48;

function maximumRoadmapPanelWidth(workspaceWidth: number) {
  return Math.max(
    MIN_ROADMAP_PANEL_WIDTH,
    Math.min(
      MAX_ROADMAP_PANEL_WIDTH,
      Math.floor(workspaceWidth * ROADMAP_PANEL_RATIO_LIMIT),
    ),
  );
}

function clampRoadmapPanelWidth(width: number, workspaceWidth: number) {
  return Math.min(
    maximumRoadmapPanelWidth(workspaceWidth),
    Math.max(MIN_ROADMAP_PANEL_WIDTH, width),
  );
}

function localId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function newItem(): CourseItem {
  return {
    id: localId("item"),
    title: "새 로드맵 항목",
    description: "",
    position: 0,
    sourcePageOrSlideNumbers: [],
  };
}

function newChapter(): CourseChapter {
  return { id: localId("chapter"), title: "새 챕터", position: 0, items: [newItem()] };
}

function editableCourse(course: CourseRecord): CourseDraft {
  return {
    title: course.title,
    description: course.description,
    chapters: course.chapters.map((chapter) => ({
      ...chapter,
      items: chapter.items.map((item) => ({
        ...item,
        sourcePageOrSlideNumbers: item.sourcePageOrSlideNumbers ?? [],
      })),
    })),
  };
}

function reorderById<T extends { id: string }>(values: T[], activeId: string, overId: string): T[] {
  const from = values.findIndex((value) => value.id === activeId);
  const to = values.findIndex((value) => value.id === overId);
  if (from < 0 || to < 0 || from === to) return values;
  return arrayMove(values, from, to);
}

function stateRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

type LinkedMaterial = CourseMaterial & { file?: File };

function linkedMaterial(
  result: { uploadId: string; normalizedExtension: "pdf" | "pptx"; sizeBytes: number },
  metadata: MaterialFileMetadata,
): LinkedMaterial {
  return {
    id: result.uploadId,
    filename: metadata.fileName,
    normalizedExtension: result.normalizedExtension,
    sizeBytes: result.sizeBytes,
    file: metadata.file,
  };
}

function safeMaterialUploadMessage(reason: unknown) {
  if (reason && typeof reason === "object" && "status" in reason) {
    const status = (reason as { status?: unknown }).status;
    if (status === 409) {
      return "자료 저장 공간이 부족합니다. 사용하지 않는 자료를 정리하거나 관리자에게 용량 상향을 요청해 주세요.";
    }
    if (status === 401 || status === 403) return "자료를 연결할 권한이 없습니다.";
    if (status === 422) return "파일 형식과 크기를 다시 확인해 주세요.";
  }
  return "자료를 업로드하거나 연결하지 못했습니다. 다시 시도해 주세요.";
}

export function CourseFlowEditorPage({ creating = false }: { creating?: boolean }) {
  const { courseId = "" } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [course, setCourse] = useState<CourseRecord | null>(null);
  const [draft, setDraft] = useState<CourseDraft>(emptyDraft);
  const [loading, setLoading] = useState(!creating);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedChapterIds, setExpandedChapterIds] = useState<string[]>([]);
  const [editingCourseField, setEditingCourseField] = useState<"title" | "description" | null>(null);
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [itemEditor, setItemEditor] = useState<{ itemId: string; title: string; description: string } | null>(null);
  const [linkedMaterials, setLinkedMaterials] = useState<LinkedMaterial[]>([]);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [materialsLoading, setMaterialsLoading] = useState(!creating);
  const [materialLoadError, setMaterialLoadError] = useState<string | null>(null);
  const [materialLinkWarning, setMaterialLinkWarning] = useState<string | null>(null);
  const [showMaterialPicker, setShowMaterialPicker] = useState(false);
  const [selectedMaterialFile, setSelectedMaterialFile] = useState<MaterialFileMetadata | null>(null);
  const [uploadingMaterial, setUploadingMaterial] = useState(false);
  const [materialNotice, setMaterialNotice] = useState<string | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<LinkedMaterial | null>(null);
  const [roadmapPanelWidth, setRoadmapPanelWidth] = useState(
    DEFAULT_ROADMAP_PANEL_WIDTH,
  );
  const saveInFlight = useRef(false);
  const chapterExpansionInitialized = useRef(false);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function currentWorkspaceWidth() {
    const measuredWidth = workspaceRef.current?.getBoundingClientRect().width ?? 0;
    if (measuredWidth > 0) return measuredWidth;
    return typeof window === "undefined" ? 1200 : window.innerWidth;
  }

  function setClampedRoadmapPanelWidth(nextWidth: number) {
    setRoadmapPanelWidth(
      clampRoadmapPanelWidth(nextWidth, currentWorkspaceWidth()),
    );
  }

  function handlePanelResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = roadmapPanelWidth;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setClampedRoadmapPanelWidth(startWidth + startX - moveEvent.clientX);
    };
    const finishResize = () => {
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });
  }

  function handlePanelResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 48 : 24;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setClampedRoadmapPanelWidth(roadmapPanelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setClampedRoadmapPanelWidth(roadmapPanelWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      setClampedRoadmapPanelWidth(MIN_ROADMAP_PANEL_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setClampedRoadmapPanelWidth(maximumRoadmapPanelWidth(currentWorkspaceWidth()));
    }
  }

  useEffect(() => {
    const keepPanelWidthInBounds = () => {
      const workspaceWidth = currentWorkspaceWidth();
      setRoadmapPanelWidth((width) => clampRoadmapPanelWidth(width, workspaceWidth));
    };
    window.addEventListener("resize", keepPanelWidthInBounds);
    return () => window.removeEventListener("resize", keepPanelWidthInBounds);
  }, []);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeData = active.data.current;
    const overData = over.data.current;

    if (activeData?.kind === "chapter" && overData?.kind === "chapter") {
      setDraft((current) => ({
        ...current,
        chapters: reorderById(current.chapters, String(active.id), String(over.id)),
      }));
      return;
    }

    if (activeData?.kind === "item" && overData?.kind === "item" && activeData.chapterId === overData.chapterId) {
      setDraft((current) => ({
        ...current,
        chapters: current.chapters.map((chapter) => chapter.id === activeData.chapterId ? {
          ...chapter,
          items: reorderById(chapter.items, String(active.id), String(over.id)),
        } : chapter),
      }));
    }
  }

  useEffect(() => {
    if (creating) return;
    let active = true;
    void getCloudCourse(user, courseId)
      .then((result) => {
        if (!active) return;
        setCourse(result);
        const nextDraft = editableCourse(result);
        setDraft(nextDraft);
        setExpandedChapterIds(nextDraft.chapters.slice(0, 1).map((chapter) => chapter.id));
        setEditingCourseField(null);
        setEditingChapterId(null);
        setItemEditor(null);
        if (result.isMine) void loadLinkedMaterials(result.id, () => active);
        else {
          setMaterialsLoading(false);
          setMaterialLoadError(null);
          setMaterialLinkWarning(null);
          setLinkedMaterials([]);
          setSelectedMaterialId(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) setNotice(reason instanceof Error ? reason.message : "수업 흐름을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [courseId, creating, user]);

  async function loadLinkedMaterials(id: string, isActive: () => boolean = () => true) {
    setMaterialsLoading(true);
    setMaterialLoadError(null);
    setMaterialLinkWarning(null);
    try {
      const result = await listCloudCourseMaterials(user, id);
      if (!isActive()) return;
      setLinkedMaterials(result.materials);
      setMaterialLinkWarning(result.unavailableMaterialCount > 0 ? "연결된 자료를 찾을 수 없습니다. 자료를 다시 연결해 주세요." : null);
      setSelectedMaterialId((current) => result.materials.some((material) => material.id === current) ? current : result.materials[0]?.id ?? null);
    } catch {
      if (isActive()) setMaterialLoadError("연결된 자료 정보를 불러오지 못했습니다.");
    } finally {
      if (isActive()) setMaterialsLoading(false);
    }
  }

  useEffect(() => {
    if (!creating || chapterExpansionInitialized.current) return;
    chapterExpansionInitialized.current = true;
    const firstChapterId = draft.chapters[0]?.id;
    if (firstChapterId) setExpandedChapterIds([firstChapterId]);
  }, [creating, draft.chapters]);

  const editable = creating || (course?.status === "ACTIVE" && course.isMine === true);
  const readOnly = !editable || saving;
  const totalItems = draft.chapters.reduce((total, chapter) => total + chapter.items.length, 0);
  const canSave = useMemo(() => Boolean(
    draft.title.trim()
      && draft.chapters.length > 0
      && draft.chapters.every((chapter) => chapter.title.trim()
        && chapter.items.length > 0
        && chapter.items.every((item) => item.title.trim())),
  ), [draft]);

  function updateChapter(index: number, change: Partial<CourseChapter>) {
    setDraft((current) => ({
      ...current,
      chapters: current.chapters.map((chapter, currentIndex) => (
        currentIndex === index ? { ...chapter, ...change } : chapter
      )),
    }));
  }

  function updateItem(chapterIndex: number, itemIndex: number, change: Partial<CourseItem>) {
    setDraft((current) => ({
      ...current,
      chapters: current.chapters.map((chapter, currentChapterIndex) => (
        currentChapterIndex === chapterIndex
          ? {
              ...chapter,
              items: chapter.items.map((item, currentItemIndex) => (
                currentItemIndex === itemIndex ? { ...item, ...change } : item
              )),
            }
          : chapter
      )),
    }));
  }

  function toggleChapter(chapterId: string) {
    setExpandedChapterIds((current) => current.includes(chapterId) ? [] : [chapterId]);
    setEditingChapterId(null);
    setItemEditor(null);
  }

  function selectItem(chapterId: string, item: CourseItem) {
    setExpandedChapterIds([chapterId]);
    setEditingChapterId(null);
    setItemEditor({ itemId: item.id, title: item.title, description: item.description });
  }

  function addChapter() {
    const chapter = newChapter();
    setDraft((current) => ({ ...current, chapters: [...current.chapters, chapter] }));
    setExpandedChapterIds([chapter.id]);
    setEditingChapterId(null);
    setItemEditor({ itemId: chapter.items[0].id, title: chapter.items[0].title, description: chapter.items[0].description });
  }

  function addItem(chapterIndex: number, chapter: CourseChapter) {
    const item = newItem();
    updateChapter(chapterIndex, { items: [...chapter.items, item] });
    setExpandedChapterIds([chapter.id]);
    setEditingChapterId(null);
    setItemEditor({ itemId: item.id, title: item.title, description: item.description });
  }

  function replaceLinkedMaterials(next: CourseMaterial[]) {
    setLinkedMaterials((current) => next.map((material) => ({
      ...material,
      file: current.find((candidate) => candidate.id === material.id)?.file,
    })));
    setSelectedMaterialId((current) => next.some((material) => material.id === current) ? current : next[0]?.id ?? null);
  }

  async function attachUploadedMaterial(material: LinkedMaterial) {
    if (!course) return;
    try {
      const next = await attachCloudCourseMaterial(user, course.id, material.id);
      replaceLinkedMaterials(next);
      setSelectedMaterialId(material.id);
      setPendingAttachment(null);
      setMaterialNotice(null);
    } catch (reason) {
      setPendingAttachment(material);
      setMaterialNotice(safeMaterialUploadMessage(reason));
    }
  }

  async function uploadSelectedMaterial() {
    if (!selectedMaterialFile || uploadingMaterial || readOnly) return;
    setUploadingMaterial(true);
    setMaterialNotice(null);
    try {
      const result = await uploadMaterialFile(selectedMaterialFile, () => undefined);
      const material = linkedMaterial(result, selectedMaterialFile);
      if (course) {
        await attachUploadedMaterial(material);
      } else {
        setLinkedMaterials((current) => [...current, material]);
        setSelectedMaterialId(material.id);
      }
      setSelectedMaterialFile(null);
      setShowMaterialPicker(false);
    } catch (reason) {
      setMaterialNotice(safeMaterialUploadMessage(reason));
    } finally {
      setUploadingMaterial(false);
    }
  }

  async function detachLinkedMaterial(material: LinkedMaterial) {
    if (readOnly) return;
    setMaterialNotice(null);
    if (!course) {
      setLinkedMaterials((current) => current.filter((candidate) => candidate.id !== material.id));
      setSelectedMaterialId((current) => current === material.id ? null : current);
      return;
    }
    try {
      replaceLinkedMaterials(await detachCloudCourseMaterial(user, course.id, material.id));
    } catch (reason) {
      setMaterialNotice(safeMaterialUploadMessage(reason));
    }
  }

  async function save() {
    if (!editable || !canSave || saving || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setNotice(null);
    try {
      if (course) {
        const saved = await updateCloudCourse(user, course.id, draft, course.revision);
        setCourse(saved);
        setDraft(editableCourse(saved));
      } else {
        const created = await createCloudCourse(user, draft, linkedMaterials.map((material) => material.id));
        navigate(`/courses/${encodeURIComponent(created.id)}/edit`, {
          replace: true,
          state: stateRecord(location.state),
        });
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "수업 흐름을 저장하지 못했습니다.");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  if (loading) return <p className={styles.loading} role="status">수업 흐름을 불러오는 중입니다.</p>;
  if (!creating && !course) {
    return <main className={styles.page}><p className={styles.error} role="alert">{notice ?? "수업 흐름을 찾을 수 없습니다."}</p><Link to="/courses/import">수업 흐름 목록으로</Link></main>;
  }

  return (
    <main className={styles.page}>
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      <section
        ref={workspaceRef}
        className={`${styles.workspace} ${editorStyles.courseWorkspace}`}
        style={{
          "--roadmap-panel-width": `${roadmapPanelWidth}px`,
        } as CSSProperties}
        aria-label="강의 준비 편집 화면"
      >
        <section className={`${styles.materialArea} ${editorStyles.courseMaterialArea}`} aria-label="선택한 자료 보기">
          {linkedMaterials.length > 0 ? <div className={`${styles.materialHeading} ${editorStyles.courseMaterialHeading}`}>
            <p className={styles.eyebrow}>강의 준비 · 편집</p>
            <h1>{draft.title || "강의 준비"}</h1>
            <p>선택한 자료와 로드맵을 함께 보며 수업 흐름을 정리합니다.</p>
          </div> : null}
          <div className={editorStyles.materialWorkspaceContent}>
            <CourseMaterialPreview
              courseId={course?.id ?? null}
              user={user}
              materials={linkedMaterials}
              selectedMaterialId={selectedMaterialId}
              onSelect={setSelectedMaterialId}
              onDetach={(material) => void detachLinkedMaterial(material)}
              canManage={editable}
              materialsLoading={materialsLoading}
              materialLoadError={materialLoadError}
              materialLinkWarning={materialLinkWarning}
              onRetryLoad={() => course && void loadLinkedMaterials(course.id)}
              materialNotice={materialNotice}
              pendingAttachment={pendingAttachment}
              onRetryAttachment={() => pendingAttachment && void attachUploadedMaterial(pendingAttachment)}
              showPicker={showMaterialPicker}
              onShowPicker={() => { setMaterialNotice(null); setShowMaterialPicker(true); }}
              selectedFile={selectedMaterialFile}
              onSelectionChange={setSelectedMaterialFile}
              onCancelSelection={() => { setSelectedMaterialFile(null); setShowMaterialPicker(false); }}
              onUpload={() => void uploadSelectedMaterial()}
              uploading={uploadingMaterial}
              disabled={readOnly}
            />
          </div>
        </section>
        <div
          className={editorStyles.panelResizeHandle}
          role="separator"
          aria-label="로드맵 패널 너비 조절"
          aria-orientation="vertical"
          aria-controls="course-roadmap-editor"
          aria-valuemin={MIN_ROADMAP_PANEL_WIDTH}
          aria-valuemax={maximumRoadmapPanelWidth(currentWorkspaceWidth())}
          aria-valuenow={roadmapPanelWidth}
          tabIndex={0}
          title="드래그하여 로드맵 패널 너비 조절"
          onPointerDown={handlePanelResizeStart}
          onKeyDown={handlePanelResizeKeyDown}
        >
          <span aria-hidden="true" />
        </div>
        <section id="course-roadmap-editor" className={`${styles.editorPanel} ${editorStyles.editorPanel}`} aria-label="로드맵 편집">
          <header className={editorStyles.editorHeader}>
            <div><h2>로드맵 편집</h2><p>{readOnly ? "읽기 전용" : "편집 중"} · {totalItems}개 항목</p></div>
            <span className={editorStyles.activeTab}>로드맵</span>
          </header>
          <div className={editorStyles.editorScroll}>
            {course?.status === "ARCHIVED" ? <p className={styles.readOnlyNotice}>보관된 수업 흐름은 읽기 전용입니다.</p> : null}
            {!creating && course && !course.isMine && course.status === "ACTIVE" ? <p className={styles.readOnlyNotice}>작성자만 수업 흐름을 수정할 수 있습니다.</p> : null}
            <section className={editorStyles.courseSummary} aria-label="수업 기본 정보">
              <div className={editorStyles.summaryRow} data-editing={editingCourseField === "title"}>
                <div><span>수업 제목</span>{editingCourseField === "title" ? <input autoFocus aria-label="수업 제목" value={draft.title} disabled={readOnly} onBlur={() => setEditingCourseField(null)} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /> : <p>{draft.title || "제목 없음"}</p>}</div>
                {editable ? <button type="button" className={editorStyles.iconButton} aria-label="수업 제목 수정" title="수업 제목 수정" disabled={readOnly} onClick={() => { setEditingCourseField("title"); setEditingChapterId(null); setItemEditor(null); }}><Pencil aria-hidden="true" /></button> : null}
              </div>
            </section>
            <section className={editorStyles.checklistBlock} aria-labelledby="course-checklist-title">
              <div className={editorStyles.blockHeader}><h2 id="course-checklist-title">수업 흐름 로드맵</h2>{editable ? <button type="button" className={editorStyles.addButton} disabled={readOnly || draft.chapters.length >= 60} onClick={addChapter}><Plus aria-hidden="true" />챕터 추가</button> : null}</div>
              <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
              <SortableContext items={draft.chapters.map((chapter) => chapter.id)} strategy={verticalListSortingStrategy}>
              {draft.chapters.map((chapter, chapterIndex) => {
                const isExpanded = expandedChapterIds.includes(chapter.id);
                const isEditingChapter = editingChapterId === chapter.id;
                const completedItems = chapter.items.filter((item) => item.title.trim() && item.description.trim()).length;
                const completion = chapter.items.length ? Math.round((completedItems / chapter.items.length) * 100) : 0;
                return <SortableChapter id={chapter.id} disabled={readOnly} expanded={isExpanded} key={chapter.id}>
                  {(chapterDragHandle) => <>
                  <header className={editorStyles.chapterHeader}>
                    {chapterDragHandle}
                    <button type="button" className={editorStyles.chapterToggle} aria-expanded={isExpanded} aria-label={`챕터 ${String(chapterIndex + 1).padStart(2, "0")} ${isExpanded ? "접기" : "펼치기"}`} onClick={() => toggleChapter(chapter.id)}>
                      <span className={editorStyles.chapterNumber}>{String(chapterIndex + 1).padStart(2, "0")}</span>
                      <span className={editorStyles.chapterCopy}><strong>{chapter.title || "제목 없는 챕터"}</strong><span className={editorStyles.chapterProgress} aria-hidden="true"><span style={{ width: `${completion}%` }} /></span></span>
                      <span className={editorStyles.chapterCount}>{completedItems} / {chapter.items.length}</span>
                      {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                    </button>
                    {editable ? <span className={editorStyles.chapterActions}>
                      <button type="button" className={editorStyles.iconButton} aria-label="챕터 제목 수정" title="챕터 제목 수정" disabled={readOnly} onClick={() => { setExpandedChapterIds([chapter.id]); setEditingCourseField(null); setItemEditor(null); setEditingChapterId(chapter.id); }}><Pencil aria-hidden="true" /></button>
                      <button type="button" className={editorStyles.iconButton} aria-label="챕터 삭제" title="챕터 삭제" disabled={readOnly || draft.chapters.length === 1} onClick={() => { setDraft({ ...draft, chapters: draft.chapters.filter((_, index) => index !== chapterIndex) }); setExpandedChapterIds((current) => current.filter((id) => id !== chapter.id)); if (editingChapterId === chapter.id) setEditingChapterId(null); }}><Trash2 aria-hidden="true" /></button>
                    </span> : null}
                  </header>
                  {isExpanded ? <div className={editorStyles.chapterContent}>
                    {isEditingChapter ? <label className={editorStyles.chapterEditor}>챕터 제목<input autoFocus aria-label={`챕터 ${chapterIndex + 1} 제목`} value={chapter.title} disabled={readOnly} onBlur={() => setEditingChapterId(null)} onChange={(event) => updateChapter(chapterIndex, { title: event.target.value })} /></label> : null}
                    <SortableContext items={chapter.items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                    <ol className={editorStyles.items}>{chapter.items.map((item, itemIndex) => {
                      const isSelected = itemEditor?.itemId === item.id;
                      const reference = item.sourcePageOrSlideNumbers?.length ? item.sourcePageOrSlideNumbers.join(", ") : "없음";
                      const deleteItem = () => { updateChapter(chapterIndex, { items: chapter.items.filter((_, index) => index !== itemIndex) }); if (isSelected) setItemEditor(null); };
                      const applyItemEdit = () => { if (!itemEditor || itemEditor.itemId !== item.id) return; updateItem(chapterIndex, itemIndex, { title: itemEditor.title, description: itemEditor.description }); setItemEditor(null); };
                      return <SortableItem id={item.id} chapterId={chapter.id} disabled={readOnly} selected={isSelected} key={item.id}>
                        {(itemDragHandle) => <>
                        <div className={editorStyles.itemRow}>
                          {itemDragHandle}
                          <button type="button" className={editorStyles.itemSummary} aria-expanded={isSelected} onClick={() => selectItem(chapter.id, item)}>
                            <span className={editorStyles.itemNumber}>{itemIndex + 1}</span>
                            <span className={editorStyles.itemCopy}><strong>{item.title || "제목 없는 항목"}</strong><span>{item.description || "설명 없음"}</span></span>
                          </button>
                          <span className={editorStyles.itemMeta}><span className={editorStyles.questionBadge}>질문 0</span>{isSelected ? <span className={editorStyles.editingBadge}>편집 중</span> : null}</span>
                          {editable ? <span className={editorStyles.itemActions}>
                            <button type="button" className={editorStyles.iconButton} aria-label="항목 편집" title="항목 편집" disabled={readOnly} onClick={() => selectItem(chapter.id, item)}><Pencil aria-hidden="true" /></button>
                            <button type="button" className={editorStyles.iconButton} aria-label="항목 삭제" title="항목 삭제" disabled={readOnly || chapter.items.length === 1} onClick={deleteItem}><Trash2 aria-hidden="true" /></button>
                          </span> : null}
                        </div>
                        {isSelected ? <div className={editorStyles.itemDetail} data-testid="selected-checklist-item-editor">
                          <label>항목 제목<input aria-label={`챕터 ${chapterIndex + 1} 항목 ${itemIndex + 1} 제목`} value={itemEditor?.title ?? item.title} disabled={readOnly} onChange={(event) => setItemEditor((current) => current && current.itemId === item.id ? { ...current, title: event.target.value } : current)} /></label>
                          <label>항목 설명<textarea aria-label={`챕터 ${chapterIndex + 1} 항목 ${itemIndex + 1} 설명`} value={itemEditor?.description ?? item.description} disabled={readOnly} onChange={(event) => setItemEditor((current) => current && current.itemId === item.id ? { ...current, description: event.target.value } : current)} /></label>
                          <footer><p>자료 참고 {reference}</p><span><button type="button" className={editorStyles.cancelButton} disabled={readOnly} onClick={() => setItemEditor(null)}>취소</button><button type="button" className={editorStyles.applyEditButton} disabled={readOnly} onClick={applyItemEdit}>적용</button></span></footer>
                        </div> : null}
                        </>}
                      </SortableItem>;
                    })}</ol>
                    </SortableContext>
                    {editable ? <button type="button" className={editorStyles.addItem} disabled={readOnly || chapter.items.length >= 100} onClick={() => addItem(chapterIndex, chapter)}><Plus aria-hidden="true" />항목 추가</button> : null}
                  </div> : null}
                  </>}
                </SortableChapter>;
              })}
              </SortableContext>
              </DndContext>
            </section>
          </div>
          <footer className={editorStyles.actions} data-testid="course-flow-editor-actions">
            {course?.id ? (
              <div className={editorStyles.navigationActions}>
                <Link className={editorStyles.secondaryLink} to="/courses/import">수업 목록으로 가기</Link>
                <Link className={editorStyles.secondaryLink} to={`/courses/${encodeURIComponent(course.id)}/rooms/new`}>수업 열기</Link>
              </div>
            ) : null}
            {editable ? <button type="button" className={editorStyles.applyButton} disabled={readOnly || !canSave} onClick={() => void save()}><Save aria-hidden="true" />{saving ? "저장 중..." : "저장"}</button> : null}
          </footer>
        </section>
      </section>
    </main>
  );
}

function SortableChapter({ id, disabled, expanded, children }: { id: string; disabled: boolean; expanded: boolean; children: (dragHandle: ReactNode) => ReactNode }) {
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({ id, disabled, data: { kind: "chapter" } });
  const dragHandle = <button ref={setActivatorNodeRef} type="button" className={styles.dragHandle} aria-label="순서 변경" title="순서 변경" disabled={disabled} {...attributes} {...listeners}><GripVertical aria-hidden="true" /></button>;
  return <section ref={setNodeRef} className={editorStyles.chapter} data-expanded={expanded} data-dragging={isDragging} style={{ transform: CSS.Transform.toString(transform), transition }}>{children(dragHandle)}</section>;
}

function SortableItem({ id, chapterId, disabled, selected, children }: { id: string; chapterId: string; disabled: boolean; selected: boolean; children: (dragHandle: ReactNode) => ReactNode }) {
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({ id, disabled, data: { kind: "item", chapterId } });
  const dragHandle = <button ref={setActivatorNodeRef} type="button" className={styles.dragHandle} aria-label="순서 변경" title="순서 변경" disabled={disabled} {...attributes} {...listeners}><GripVertical aria-hidden="true" /></button>;
  return <li ref={setNodeRef} className={editorStyles.item} data-selected={selected} data-dragging={isDragging} style={{ transform: CSS.Transform.toString(transform), transition }}>{children(dragHandle)}</li>;
}

function CourseMaterialPreview({
  courseId,
  user,
  materials,
  selectedMaterialId,
  onSelect,
  onDetach,
  canManage,
  materialsLoading,
  materialLoadError,
  materialLinkWarning,
  onRetryLoad,
  materialNotice,
  pendingAttachment,
  onRetryAttachment,
  showPicker,
  onShowPicker,
  selectedFile,
  onSelectionChange,
  onCancelSelection,
  onUpload,
  uploading,
  disabled,
}: {
  courseId: string | null;
  user: User | null;
  materials: LinkedMaterial[];
  selectedMaterialId: string | null;
  onSelect: (id: string) => void;
  onDetach: (material: LinkedMaterial) => void;
  canManage: boolean;
  materialsLoading: boolean;
  materialLoadError: string | null;
  materialLinkWarning: string | null;
  onRetryLoad: () => void;
  materialNotice: string | null;
  pendingAttachment: LinkedMaterial | null;
  onRetryAttachment: () => void;
  showPicker: boolean;
  onShowPicker: () => void;
  selectedFile: MaterialFileMetadata | null;
  onSelectionChange: (metadata: MaterialFileMetadata | null) => void;
  onCancelSelection: () => void;
  onUpload: () => void;
  uploading: boolean;
  disabled: boolean;
}) {
  const selected = materials.find((material) => material.id === selectedMaterialId) ?? materials[0] ?? null;
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setPreviewNotice(null);
    setPdfUrl(null);
    if (!selected || selected.normalizedExtension !== "pdf") return;
    if (selected.file) {
      objectUrl = URL.createObjectURL(selected.file);
      setPdfUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl!);
    }
    if (!courseId) return;
    void loadCloudCourseMaterialContent(user, courseId, selected.id)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      })
      .catch(() => {
        if (active) setPreviewNotice("자료 미리보기를 불러오지 못했습니다.");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [courseId, selected, user]);

  if (materialsLoading && !selected) {
    return <section className={`${editorStyles.materialUnavailable} ${editorStyles.materialLoadState}`} role="status">
      <FileText aria-hidden="true" />
      <p>연결된 자료 정보를 불러오는 중입니다.</p>
    </section>;
  }

  if (!selected && (materialLoadError || materialLinkWarning)) {
    const message = materialLoadError ?? materialLinkWarning!;
    return <section className={`${editorStyles.materialUnavailable} ${editorStyles.materialLoadState}`} data-testid="course-material-load-error">
      <div role="alert"><FileText aria-hidden="true" /><h2>{message}</h2><p>{materialLoadError ? "잠시 후 다시 시도해 주세요." : "기존 자료와 수업 흐름은 변경되지 않았습니다."}</p></div>
      <div className={editorStyles.materialLoadActions}>
        <button type="button" className={editorStyles.materialCancelButton} onClick={onRetryLoad}>다시 시도</button>
        {canManage ? <button type="button" className={editorStyles.materialAddButton} disabled={disabled} onClick={onShowPicker}><FileUp aria-hidden="true" />자료 추가</button> : null}
      </div>
      <MaterialUploadForm show={showPicker} selectedFile={selectedFile} onSelectionChange={onSelectionChange} onCancel={onCancelSelection} onUpload={onUpload} uploading={uploading} disabled={disabled} notice={materialNotice} pendingAttachment={pendingAttachment} onRetryAttachment={onRetryAttachment} />
    </section>;
  }

  if (!selected) {
    return <section className={`${editorStyles.materialUnavailable} ${editorStyles.materialUploadEmpty}`} data-testid="empty-course-materials">
      <div className={editorStyles.emptyMaterialCopy}>
        <FileText aria-hidden="true" />
        <h2>강의 자료 추가</h2>
        <p>필요한 자료를 연결하면 로드맵을 보며 함께 확인할 수 있습니다. 자료 없이 직접 로드맵을 작성해도 됩니다.</p>
      </div>
      {canManage ? <>
        <MaterialFilePicker initialFile={selectedFile} selectLabel="자료 선택" onSelectionChange={onSelectionChange} disabled={disabled || uploading} />
        <footer className={editorStyles.emptyMaterialActions}>
          {selectedFile ? <button type="button" className={editorStyles.materialCancelButton} disabled={uploading} onClick={onCancelSelection}>선택 취소</button> : <span />}
          <button type="button" className={editorStyles.materialUploadButton} disabled={disabled || uploading || !selectedFile} onClick={onUpload}>{uploading ? "자료 업로드 중..." : "자료 업로드"}</button>
        </footer>
      </> : null}
      {materialNotice ? <p className={editorStyles.materialNotice} role="alert">{materialNotice}</p> : null}
      {pendingAttachment ? <button type="button" className={editorStyles.materialUploadButton} disabled={disabled} onClick={onRetryAttachment}>연결 다시 시도</button> : null}
    </section>;
  }

  return <section className={editorStyles.courseMaterials} aria-label="연결된 자료">
    <header className={editorStyles.materialToolbar}>
      <div className={editorStyles.materialSelector} aria-label="연결된 자료 목록">
        {materials.map((material) => <button key={material.id} type="button" className={editorStyles.materialSelectButton} data-selected={material.id === selected.id} onClick={() => onSelect(material.id)} title={material.filename}>
          {material.normalizedExtension.toUpperCase()} · {material.filename}
        </button>)}
      </div>
      {canManage ? <span className={editorStyles.materialToolbarActions}>
        <button type="button" className={editorStyles.materialAddButton} disabled={disabled} onClick={onShowPicker}><FileUp aria-hidden="true" />자료 추가</button>
        <button type="button" className={editorStyles.materialDetachIcon} aria-label="자료 연결 해제" title="자료 연결 해제" disabled={disabled} onClick={() => onDetach(selected)}><Link2Off aria-hidden="true" /></button>
      </span> : null}
    </header>
    {materialLoadError || materialLinkWarning ? <div className={editorStyles.materialLoadAlert} role="alert"><span>{materialLoadError ?? materialLinkWarning}</span><button type="button" className={editorStyles.materialCancelButton} onClick={onRetryLoad}>다시 시도</button></div> : null}
    <section className={editorStyles.materialViewer}>
      <header><FileText aria-hidden="true" /><span>{selected.filename} · {selected.normalizedExtension.toUpperCase()}</span></header>
      {selected.normalizedExtension === "pdf" ? (pdfUrl ? <iframe title="선택한 PDF 자료" src={pdfUrl} /> : <p>{previewNotice ?? "자료를 준비하는 중입니다."}</p>) : <div className={editorStyles.materialUnavailable}><Presentation aria-hidden="true" /><h2>선택한 PPTX 자료</h2><p>PPTX 원문은 이 화면에서 가짜 슬라이드로 바꾸지 않습니다. 로드맵의 자료 참고 번호를 확인해 주세요.</p></div>}
    </section>
    <MaterialUploadForm show={showPicker} selectedFile={selectedFile} onSelectionChange={onSelectionChange} onCancel={onCancelSelection} onUpload={onUpload} uploading={uploading} disabled={disabled} notice={materialNotice} pendingAttachment={pendingAttachment} onRetryAttachment={onRetryAttachment} />
  </section>;
}

function MaterialUploadForm({ show, selectedFile, onSelectionChange, onCancel, onUpload, uploading, disabled, notice, pendingAttachment, onRetryAttachment }: {
  show: boolean;
  selectedFile: MaterialFileMetadata | null;
  onSelectionChange: (metadata: MaterialFileMetadata | null) => void;
  onCancel: () => void;
  onUpload: () => void;
  uploading: boolean;
  disabled: boolean;
  notice: string | null;
  pendingAttachment: LinkedMaterial | null;
  onRetryAttachment: () => void;
}) {
  if (!show && !notice && !pendingAttachment) return null;
  return <section className={editorStyles.materialUploadForm} aria-label="자료 추가">
    {show ? <><MaterialFilePicker initialFile={selectedFile} onSelectionChange={onSelectionChange} disabled={disabled || uploading} /><footer><button type="button" className={editorStyles.materialCancelButton} disabled={uploading} onClick={onCancel}>선택 취소</button><button type="button" className={editorStyles.materialUploadButton} disabled={disabled || uploading || !selectedFile} onClick={onUpload}>{uploading ? "자료 업로드 중..." : "자료 업로드"}</button></footer></> : null}
    {notice ? <p className={editorStyles.materialNotice} role="alert">{notice}</p> : null}
    {pendingAttachment ? <button type="button" className={editorStyles.materialUploadButton} disabled={disabled} onClick={onRetryAttachment}>연결 다시 시도</button> : null}
  </section>;
}
