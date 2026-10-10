import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, FileText, GripVertical, Pencil, Plus, Presentation, Save, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  applyMaterialCourseDraft,
  discardMaterialCourseDraft,
  getMaterialCourseDraft,
  type MaterialCourseDraftApplyInput,
  type MaterialCourseDraftResult,
} from "./materialUploadApi";
import styles from "./MaterialCourseDraftEditorPage.module.css";

type EditableItem = {
  localId: string;
  title: string;
  description: string;
  sourcePageOrSlideNumbers: number[];
};

type EditableChapter = {
  localId: string;
  title: string;
  items: EditableItem[];
};

type EditableDraft = {
  title: string;
  description: string;
  chapters: EditableChapter[];
};

function localId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function editableDraft(draft: MaterialCourseDraftResult): EditableDraft {
  return {
    title: draft.suggestedTitle ?? "",
    description: draft.summary ?? "",
    chapters: draft.chapters.map((chapter) => ({
      localId: localId("chapter"),
      title: chapter.title,
      items: chapter.items.map((item) => ({
        localId: localId("item"),
        title: item.title,
        description: item.description,
        sourcePageOrSlideNumbers: [...item.sourcePageOrSlideNumbers],
      })),
    })),
  };
}

function newItem(): EditableItem {
  return {
    localId: localId("item"),
    title: "새 로드맵 항목",
    description: "",
    sourcePageOrSlideNumbers: [],
  };
}

function newChapter(): EditableChapter {
  return { localId: localId("chapter"), title: "새 챕터", items: [newItem()] };
}

function toApplyInput(value: EditableDraft, revision: number): MaterialCourseDraftApplyInput {
  return {
    title: value.title.trim(),
    description: value.description.trim(),
    chapters: value.chapters.map((chapter) => ({
      title: chapter.title.trim(),
      items: chapter.items.map((item) => ({
        title: item.title.trim(),
        description: item.description.trim(),
        sourcePageOrSlideNumbers: item.sourcePageOrSlideNumbers,
      })),
    })),
    expectedRevision: revision,
  };
}

function reorderById<T extends { localId: string }>(values: T[], activeId: string, overId: string): T[] {
  const from = values.findIndex((value) => value.localId === activeId);
  const to = values.findIndex((value) => value.localId === overId);
  if (from < 0 || to < 0 || from === to) return values;
  return arrayMove(values, from, to);
}

export function MaterialCourseDraftEditorPage() {
  const { draftId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<MaterialCourseDraftResult | null>(null);
  const [form, setForm] = useState<EditableDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null);
  const [confirmation, setConfirmation] = useState<"discard" | null>(null);
  const [expandedChapterIds, setExpandedChapterIds] = useState<string[]>([]);
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const applyInFlight = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    let active = true;
    void getMaterialCourseDraft(draftId)
      .then((result) => {
        if (!active) return;
        setDraft(result);
        const nextForm = editableDraft(result);
        setForm(nextForm);
        setExpandedChapterIds(nextForm.chapters.slice(0, 1).map((chapter) => chapter.localId));
        setEditingChapterId(null);
        setSelectedItemId(null);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "AI 초안을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [draftId]);

  const canApply = useMemo(() => Boolean(
    form
      && form.title.trim()
      && form.chapters.length > 0
      && form.chapters.every((chapter) => chapter.title.trim() && chapter.items.length > 0
        && chapter.items.every((item) => item.title.trim())),
  ), [form]);

  if (loading) return <p className={styles.loading} role="status">AI 수업 흐름 초안을 불러오는 중입니다.</p>;
  if (!draft || !form) return <main className={styles.page}><p className={styles.error} role="alert">{error ?? "AI 초안을 찾을 수 없습니다."}</p><Link to="/create/material">자료 선택으로 돌아가기</Link></main>;

  const isGenerated = draft.status === "GENERATED";
  const readOnly = !isGenerated || busy !== null;
  const totalItems = form.chapters.reduce((count, chapter) => count + chapter.items.length, 0);

  function updateChapter(index: number, change: Partial<EditableChapter>) {
    setForm((current) => current ? {
      ...current,
      chapters: current.chapters.map((chapter, chapterIndex) => chapterIndex === index ? { ...chapter, ...change } : chapter),
    } : current);
  }

  function updateItem(chapterIndex: number, itemIndex: number, change: Partial<EditableItem>) {
    setForm((current) => current ? {
      ...current,
      chapters: current.chapters.map((chapter, currentChapterIndex) => currentChapterIndex === chapterIndex ? {
        ...chapter,
        items: chapter.items.map((item, currentItemIndex) => currentItemIndex === itemIndex ? { ...item, ...change } : item),
      } : chapter),
    } : current);
  }

  function toggleChapter(chapterId: string) {
    setExpandedChapterIds((current) => current.includes(chapterId)
      ? current.filter((id) => id !== chapterId)
      : [...current, chapterId]);
  }

  function selectItem(chapterId: string, itemId: string) {
    setExpandedChapterIds((current) => current.includes(chapterId) ? current : [...current, chapterId]);
    setEditingChapterId(null);
    setSelectedItemId(itemId);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeData = active.data.current;
    const overData = over.data.current;

    if (activeData?.kind === "chapter" && overData?.kind === "chapter") {
      setForm((current) => current ? {
        ...current,
        chapters: reorderById(current.chapters, String(active.id), String(over.id)),
      } : current);
      return;
    }

    if (activeData?.kind === "item" && overData?.kind === "item" && activeData.chapterId === overData.chapterId) {
      setForm((current) => current ? {
        ...current,
        chapters: current.chapters.map((chapter) => chapter.localId === activeData.chapterId ? {
          ...chapter,
          items: reorderById(chapter.items, String(active.id), String(over.id)),
        } : chapter),
      } : current);
    }
  }

  function addChapter() {
    const chapter = newChapter();
    setForm((current) => current ? { ...current, chapters: [...current.chapters, chapter] } : current);
    setExpandedChapterIds((current) => [...current, chapter.localId]);
    setEditingChapterId(null);
    setSelectedItemId(chapter.items[0].localId);
  }

  async function applyDraft() {
    if (!canApply || !form || !draft?.revision || applyInFlight.current) return;
    applyInFlight.current = true;
    setBusy("apply");
    setError(null);
    try {
      const result = await applyMaterialCourseDraft(draftId, toApplyInput(form, draft.revision));
      navigate(`/courses/${encodeURIComponent(result.course.id)}/edit`, {
        replace: true,
        state: location.state,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI 초안을 수업으로 저장하지 못했습니다.");
    } finally {
      applyInFlight.current = false;
      setBusy(null);
    }
  }

  async function discardDraft() {
    const currentDraft = draft;
    if (!currentDraft?.revision) return;
    setBusy("discard");
    setError(null);
    try {
      setDraft(await discardMaterialCourseDraft(draftId, currentDraft.revision));
      setConfirmation(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "AI 초안을 폐기하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  if (!isGenerated) {
    if (draft.status === "APPLIED" && draft.appliedCourseId) {
      return <Navigate replace to={`/courses/${encodeURIComponent(draft.appliedCourseId)}/edit`} state={location.state} />;
    }
    return (
      <main className={styles.page}>
        <section className={styles.terminal} aria-labelledby="draft-terminal-title">
          <p className={styles.eyebrow}>AI COURSE DRAFT</p>
          <h1 id="draft-terminal-title">{draft.status === "APPLIED" ? "수업으로 저장된 초안입니다" : "폐기된 초안입니다"}</h1>
          <p>폐기 기록은 보관되며 다시 편집하거나 적용할 수 없습니다.</p>
          <Link to="/courses/import">수업 목록으로 이동</Link>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <section className={styles.workspace} aria-label="강의 준비 편집 화면">
        <section className={styles.materialArea} aria-label="선택한 자료 보기">
          <div className={styles.materialHeading}>
            <p className={styles.eyebrow}>강의 준비 · 편집 중</p>
            <h1>{form.title || "강의 준비"}</h1>
            <p>선택한 자료와 로드맵을 함께 보며 수업 흐름을 정리합니다.</p>
          </div>
          <DraftMaterialPreview state={location.state} />
        </section>
        <section className={styles.editorPanel} aria-label="로드맵 편집">
          <header className={styles.editorHeader}>
            <div><h2>로드맵 편집</h2><p>준비 중 · {totalItems}개 항목</p></div>
            <span className={styles.activeTab}>로드맵</span>
          </header>
          <div className={styles.editorScroll}>
            <div className={styles.courseFields}>
              <label>수업 제목<input value={form.title} disabled={readOnly} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
            </div>
            <section className={styles.block} aria-labelledby="chapters-title">
              <div className={styles.blockHeader}><h2 id="chapters-title">수업 흐름 로드맵</h2><button type="button" disabled={readOnly || form.chapters.length >= 8} onClick={addChapter}><Plus aria-hidden="true" />챕터 추가</button></div>
              <DndContext
                sensors={sensors}
                onDragEnd={handleDragEnd}
                accessibility={{
                  screenReaderInstructions: { draggable: "순서 변경 핸들에서 스페이스바 또는 엔터를 눌러 정렬을 시작하고, 화살표 키로 위치를 옮긴 뒤 다시 스페이스바 또는 엔터를 눌러 놓습니다." },
                }}
              >
              <SortableContext items={form.chapters.map((chapter) => chapter.localId)} strategy={verticalListSortingStrategy}>
              {form.chapters.map((chapter, chapterIndex) => {
                const isExpanded = expandedChapterIds.includes(chapter.localId);
                const isEditingChapter = editingChapterId === chapter.localId;
                const completedItems = chapter.items.filter((item) => item.title.trim() && item.description.trim()).length;
                const completion = chapter.items.length ? Math.round((completedItems / chapter.items.length) * 100) : 0;
                return <SortableChapter id={chapter.localId} disabled={readOnly} expanded={isExpanded} key={chapter.localId}>
                  {(chapterDragHandle) => <>
                  <header className={styles.chapterHeader}>
                    {chapterDragHandle}
                    <button
                      type="button"
                      className={styles.chapterToggle}
                      aria-expanded={isExpanded}
                      aria-label={`챕터 ${String(chapterIndex + 1).padStart(2, "0")} ${isExpanded ? "접기" : "펼치기"}`}
                      title={isExpanded ? "챕터 접기" : "챕터 펼치기"}
                      onClick={() => toggleChapter(chapter.localId)}
                    >
                      <span className={styles.chapterNumber}>{String(chapterIndex + 1).padStart(2, "0")}</span>
                      <span className={styles.chapterCopy}>
                        <span className={styles.chapterName}>{chapter.title || "제목 없는 챕터"}</span>
                        <span className={styles.chapterProgress} aria-hidden="true"><span style={{ width: `${completion}%` }} /></span>
                      </span>
                      <span className={styles.chapterCount}>{completedItems} / {chapter.items.length}</span>
                      {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                    </button>
                    <span className={styles.chapterActions}>
                      <button type="button" className={styles.iconButton} aria-label="챕터 제목 수정" title="챕터 제목 수정" disabled={readOnly} onClick={() => { setExpandedChapterIds((current) => current.includes(chapter.localId) ? current : [...current, chapter.localId]); setSelectedItemId(null); setEditingChapterId(chapter.localId); }}><Pencil aria-hidden="true" /></button>
                      <button type="button" className={styles.iconButton} aria-label="챕터 삭제" title="챕터 삭제" disabled={readOnly || form.chapters.length === 1} onClick={() => { setForm({ ...form, chapters: form.chapters.filter((_, index) => index !== chapterIndex) }); setExpandedChapterIds((current) => current.filter((id) => id !== chapter.localId)); if (editingChapterId === chapter.localId) setEditingChapterId(null); }}><Trash2 aria-hidden="true" /></button>
                    </span>
                  </header>
                  {isExpanded ? <div className={styles.chapterContent}>
                    {isEditingChapter ? <label className={styles.chapterEditor}>챕터 제목<input aria-label={`챕터 ${chapterIndex + 1} 제목`} value={chapter.title} disabled={readOnly} onChange={(event) => updateChapter(chapterIndex, { title: event.target.value })} onBlur={() => setEditingChapterId(null)} /></label> : null}
                    <SortableContext items={chapter.items.map((item) => item.localId)} strategy={verticalListSortingStrategy}>
                    <ol className={styles.items}>{chapter.items.map((item, itemIndex) => {
                      const isSelected = selectedItemId === item.localId;
                      const reference = item.sourcePageOrSlideNumbers.length ? item.sourcePageOrSlideNumbers.join(", ") : "없음";
                      const deleteItem = () => { updateChapter(chapterIndex, { items: chapter.items.filter((_, index) => index !== itemIndex) }); if (isSelected) setSelectedItemId(null); };
                      return <SortableItem id={item.localId} chapterId={chapter.localId} disabled={readOnly} selected={isSelected} key={item.localId}>
                        {(itemDragHandle) => <>
                        <div className={styles.itemRow}>
                          {itemDragHandle}
                          <button type="button" className={styles.itemSummary} aria-expanded={isSelected} onClick={() => selectItem(chapter.localId, item.localId)}>
                            <span className={styles.itemNumber}>{itemIndex + 1}</span>
                            <span className={styles.itemCopy}>
                              <strong>{item.title || "제목 없는 항목"}</strong>
                              <span className={styles.itemMeta}><span className={styles.itemPreview}>{item.description || "설명 없음"}</span><span className={styles.reference}>자료 참고 {reference}</span></span>
                            </span>
                          </button>
                          <span className={styles.questionBadge}>질문 0</span>
                          <span className={styles.itemActions}>
                            <button type="button" className={styles.iconButton} aria-label="항목 편집" title="항목 편집" disabled={readOnly} onClick={() => selectItem(chapter.localId, item.localId)}><Pencil aria-hidden="true" /></button>
                            <button type="button" className={styles.iconButton} aria-label="항목 삭제" title="항목 삭제" disabled={readOnly || chapter.items.length === 1} onClick={deleteItem}><Trash2 aria-hidden="true" /></button>
                          </span>
                        </div>
                        {isSelected ? <div className={styles.itemDetail} data-testid="selected-checklist-item-editor">
                          <label>항목 제목<input aria-label={`챕터 ${chapterIndex + 1} 항목 ${itemIndex + 1} 제목`} value={item.title} disabled={readOnly} onChange={(event) => updateItem(chapterIndex, itemIndex, { title: event.target.value })} /></label>
                          <label>항목 설명<textarea aria-label={`챕터 ${chapterIndex + 1} 항목 ${itemIndex + 1} 설명`} value={item.description} disabled={readOnly} onChange={(event) => updateItem(chapterIndex, itemIndex, { description: event.target.value })} /></label>
                          <div className={styles.detailFooter}><p className={styles.reference}>자료 참고 {reference}</p><span className={styles.detailActions}><button type="button" className={styles.iconButton} aria-label="선택한 항목 삭제" title="항목 삭제" disabled={readOnly || chapter.items.length === 1} onClick={deleteItem}><Trash2 aria-hidden="true" /></button></span></div>
                        </div> : null}
                        </>}
                      </SortableItem>;
                    })}</ol>
                    </SortableContext>
                    <button type="button" className={styles.addItem} disabled={readOnly || chapter.items.length >= 10} onClick={() => { const item = newItem(); updateChapter(chapterIndex, { items: [...chapter.items, item] }); setEditingChapterId(null); setSelectedItemId(item.localId); }}><Plus aria-hidden="true" />항목 추가</button>
                  </div> : null}
                  </>}
                </SortableChapter>;
              })}
              </SortableContext>
              </DndContext>
            </section>
          </div>
          <footer className={styles.actions} data-testid="draft-editor-actions"><button type="button" className={styles.discardButton} disabled={readOnly} onClick={() => setConfirmation("discard")}>초안 폐기</button><button type="button" className={styles.applyButton} disabled={!canApply || readOnly} onClick={() => void applyDraft()}><Save aria-hidden="true" />{busy === "apply" ? "저장 중..." : "저장"}</button></footer>
        </section>
      </section>
      {confirmation ? <section className={styles.dialogBackdrop} role="presentation"><div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="confirmation-title"><button type="button" className={styles.dialogClose} aria-label="확인 창 닫기" onClick={() => setConfirmation(null)} disabled={busy !== null}><X aria-hidden="true" /></button><h2 id="confirmation-title">이 AI 초안을 폐기할까요?</h2><p>초안은 삭제되지 않고 폐기 상태로 보관되며, 이후 편집하거나 저장할 수 없습니다.</p><div className={styles.dialogActions}><button type="button" onClick={() => setConfirmation(null)} disabled={busy !== null}>취소</button><button type="button" className={styles.discardButton} onClick={() => void discardDraft()} disabled={busy !== null}>{busy ? "저장 중" : "초안 폐기"}</button></div></div></section> : null}
    </main>
  );
}

function SortableChapter({ id, disabled, expanded, children }: { id: string; disabled: boolean; expanded: boolean; children: (dragHandle: ReactNode) => ReactNode }) {
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({ id, disabled, data: { kind: "chapter" } });
  const dragHandle = <button ref={setActivatorNodeRef} type="button" className={styles.dragHandle} aria-label="순서 변경" title="순서 변경" disabled={disabled} {...attributes} {...listeners}><GripVertical aria-hidden="true" /></button>;
  return <section ref={setNodeRef} className={styles.chapter} data-expanded={expanded} data-dragging={isDragging} style={{ transform: CSS.Transform.toString(transform), transition }}>{children(dragHandle)}</section>;
}

function SortableItem({ id, chapterId, disabled, selected, children }: { id: string; chapterId: string; disabled: boolean; selected: boolean; children: (dragHandle: ReactNode) => ReactNode }) {
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({ id, disabled, data: { kind: "item", chapterId } });
  const dragHandle = <button ref={setActivatorNodeRef} type="button" className={styles.dragHandle} aria-label="순서 변경" title="순서 변경" disabled={disabled} {...attributes} {...listeners}><GripVertical aria-hidden="true" /></button>;
  return <li ref={setNodeRef} className={styles.item} data-selected={selected} data-dragging={isDragging} style={{ transform: CSS.Transform.toString(transform), transition }}>{children(dragHandle)}</li>;
}

function DraftMaterialPreview({ state }: { state: unknown }) {
  const file = previewFile(state);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file || !isPdf(file)) { setPdfUrl(null); return; }
    const next = URL.createObjectURL(file);
    setPdfUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  if (!file) {
    return <section className={styles.materialUnavailable}><FileText aria-hidden="true" /><h2>비공개 자료 보기</h2><p>직접 연 초안은 자료 파일을 다시 표시하지 않습니다. 로드맵과 자료 참고 번호는 계속 편집할 수 있습니다.</p></section>;
  }
  if (isPdf(file)) {
    return <section className={styles.materialViewer}><header><FileText aria-hidden="true" /><span>선택한 PDF 자료</span></header>{pdfUrl ? <iframe title="선택한 PDF 자료" src={pdfUrl} /> : <p>자료를 준비하는 중입니다.</p>}</section>;
  }
  return <section className={styles.materialUnavailable}><Presentation aria-hidden="true" /><h2>선택한 PPTX 자료</h2><p>슬라이드 원문은 저장하지 않고, 서버가 만든 슬라이드 참조 번호를 로드맵과 함께 편집합니다.</p></section>;
}

function previewFile(state: unknown): File | null {
  if (!state || typeof state !== "object" || typeof File === "undefined") return null;
  const value = state as { materialPreview?: { file?: unknown } };
  return value.materialPreview?.file instanceof File ? value.materialPreview.file : null;
}

function isPdf(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}
