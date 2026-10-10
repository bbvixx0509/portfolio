import { ArrowDown, ArrowUp, FileUp, Link2, Plus, Save, Trash2 } from "lucide-react";
import { collection, doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { Link, useNavigate, useParams } from "react-router-dom";
import { requestApi } from "../../lib/api/apiClient";
import { getLocalFirebaseFirestore } from "../../lib/firebase/firebaseFirestore";
import { useAuth } from "../auth/AuthContext";
import { createEmptyPermissions, normalizePermissions } from "../auth/authTypes";
import type { LiveChapter, LiveCourseItem } from "./liveCourseTypes";
import styles from "./LiveCourseFlowEditorPage.module.css";
import { useRoomCreation } from "./useRoomCreation";

type LiveCourseRecord = {
  id: string;
  title: string;
  status: string;
  leadInstructorId: string;
  activeRoomId: string | null;
  description: string;
};

type RoomShareInfo = {
  joinCode: string;
  joinPath: string;
};

export function buildRoomJoinUrl(joinPath: string, origin?: string) {
  const baseOrigin = origin ?? globalThis.location?.origin ?? "http://127.0.0.1:5174";
  return new URL(joinPath, baseOrigin).toString();
}

function text(data: DocumentData, key: string, fallback = "") {
  return typeof data[key] === "string" ? data[key] : fallback;
}

function parseChapter(id: string, data: DocumentData): LiveChapter {
  return { id, title: text(data, "title", "이름 없는 챕터"), order: typeof data.order === "number" ? data.order : 0 };
}

function parseItem(id: string, data: DocumentData): LiveCourseItem {
  return {
    id,
    chapterId: text(data, "chapterId"),
    title: text(data, "title", "이름 없는 항목"),
    description: text(data, "description"),
    materialLabel: text(data, "materialLabel", text(data, "title", "항목")),
    kind: text(data, "kind", "SLIDE"),
    order: typeof data.order === "number" ? data.order : 0,
    isCompleted: data.isCompleted === true,
  };
}

export function buildFlowUpdatePayload(
  chapters: LiveChapter[],
  items: LiveCourseItem[],
) {
  const orderedItems = chapters.flatMap((chapter) =>
    items
      .filter((item) => item.chapterId === chapter.id)
      .sort((first, second) => first.order - second.order),
  );
  return {
    chapters: chapters.map((chapter, index) => ({
      id: chapter.id,
      title: chapter.title,
      order: index,
    })),
    items: orderedItems.map((item, index) => ({
      id: item.id,
      chapterId: item.chapterId,
      title: item.title,
      order: index,
    })),
  };
}

export function buildMaterialUpdatePayload(fileName: string, isShared = true) {
  const normalizedName = fileName.trim();
  const fileType = normalizedName.includes(".")
    ? normalizedName.split(".").at(-1)?.toUpperCase() ?? "DATA"
    : "DATA";
  return { fileName: normalizedName, fileType, isShared };
}

export function LiveCourseFlowEditorPage() {
  const { courseId = "" } = useParams();
  const navigate = useNavigate();
  const { profile, user } = useAuth();
  const [course, setCourse] = useState<LiveCourseRecord | null>(null);
  const [chapters, setChapters] = useState<LiveChapter[]>([]);
  const [items, setItems] = useState<LiveCourseItem[]>([]);
  const [workingChapters, setWorkingChapters] = useState<LiveChapter[]>([]);
  const [workingItems, setWorkingItems] = useState<LiveCourseItem[]>([]);
  const [permissions, setPermissions] = useState(createEmptyPermissions);
  const [courseTitle, setCourseTitle] = useState("");
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [newItemTitle, setNewItemTitle] = useState("");
  const [newItemChapterId, setNewItemChapterId] = useState("");
  const [materialName, setMaterialName] = useState("");
  const [isMaterialShared, setIsMaterialShared] = useState(true);
  const [isMaterialDirty, setIsMaterialDirty] = useState(false);
  const materialDirtyRef = useRef(false);
  const materialServerRef = useRef({ fileName: "", isShared: true });
  const [shareInfo, setShareInfo] = useState<RoomShareInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const handleRoomCreated = useCallback(
    (roomId: string) => navigate(`/rooms/${roomId}/checklist`),
    [navigate],
  );
  const {
    createRoom,
    pendingCourseId: pendingRoomCourseId,
  } = useRoomCreation({
    authUser: user,
    onCreated: handleRoomCreated,
    onNotice: setNotice,
  });

  useEffect(() => {
    const firestore = getLocalFirebaseFirestore();
    const unsubscribers = [
      onSnapshot(doc(firestore, "courses", courseId), (snapshot) => {
        if (!snapshot.exists()) {
          setCourse(null);
          setNotice("강의를 찾을 수 없습니다.");
        } else {
          const data = snapshot.data();
          const nextCourse = {
            id: snapshot.id,
            title: text(data, "title", "이름 없는 강의"),
            status: text(data, "status", "PREPARING"),
            leadInstructorId: text(data, "leadInstructorId", text(data, "ownerId")),
            activeRoomId: typeof data.activeRoomId === "string" ? data.activeRoomId : null,
            description: text(data, "description"),
          };
          setCourse(nextCourse);
          setCourseTitle(nextCourse.title);
        }
        setIsLoading(false);
      }, (error) => { setNotice(error.message); setIsLoading(false); }),
      onSnapshot(collection(firestore, "courses", courseId, "chapters"), (snapshot) => {
        setChapters(snapshot.docs.map((entry) => parseChapter(entry.id, entry.data())).sort((a, b) => a.order - b.order));
      }, (error) => setNotice(error.message)),
      onSnapshot(collection(firestore, "courses", courseId, "items"), (snapshot) => {
        setItems(snapshot.docs.map((entry) => parseItem(entry.id, entry.data())).sort((a, b) => a.order - b.order));
      }, (error) => setNotice(error.message)),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [courseId]);

  useEffect(() => {
    if (!isDirty) {
      setWorkingChapters(chapters);
      setWorkingItems(items);
      setNewItemChapterId((current) => current || chapters[0]?.id || "");
    }
  }, [chapters, isDirty, items]);

  useEffect(() => {
    setPermissions(createEmptyPermissions());
    if (
      !profile ||
      profile.accountType !== "STAFF" ||
      !course?.activeRoomId ||
      profile.uid === course.leadInstructorId
    ) return;
    return onSnapshot(
      doc(getLocalFirebaseFirestore(), "rooms", course.activeRoomId, "staff", profile.uid),
      (snapshot) => setPermissions(snapshot.exists() ? normalizePermissions(snapshot.data().permissions) : createEmptyPermissions()),
      () => setPermissions(createEmptyPermissions()),
    );
  }, [course?.activeRoomId, profile]);

  const isLead = Boolean(profile && course && profile.uid === course.leadInstructorId);
  const canEditCourse = isLead || permissions.canEditCourse;
  const canEditFlow = isLead || permissions.canEditCourseFlow;
  const canManageMaterials = isLead || permissions.canManageMaterials;
  const canShareRoom = isLead || permissions.canShareRoom;
  const canShareRoomRef = useRef(canShareRoom);

  useEffect(() => {
    canShareRoomRef.current = canShareRoom;
    if (!canShareRoom) setShareInfo(null);
  }, [canShareRoom]);

  useEffect(() => {
    materialDirtyRef.current = isMaterialDirty;
  }, [isMaterialDirty]);

  useEffect(() => {
    if (!canManageMaterials) {
      materialServerRef.current = { fileName: "", isShared: true };
      setMaterialName("");
      setIsMaterialShared(true);
      setIsMaterialDirty(false);
      return;
    }
    return onSnapshot(
      doc(
        getLocalFirebaseFirestore(),
        "courses",
        courseId,
        "materials",
        "current",
      ),
      (snapshot) => {
        const data = snapshot.exists() ? snapshot.data() : {};
        const nextMaterial = {
          fileName: text(data, "fileName"),
          isShared: snapshot.exists() ? data.isShared === true : true,
        };
        materialServerRef.current = nextMaterial;
        if (!materialDirtyRef.current) {
          setMaterialName(nextMaterial.fileName);
          setIsMaterialShared(nextMaterial.isShared);
        }
      },
      (error) => setNotice(error.message),
    );
  }, [canManageMaterials, courseId]);

  useEffect(() => {
    if (!canEditFlow && isDirty) {
      setWorkingChapters(chapters);
      setWorkingItems(items);
      setIsDirty(false);
      setNotice("수업 흐름 편집 권한이 회수되어 저장하지 않은 변경을 취소했습니다.");
    }
  }, [canEditFlow, chapters, isDirty, items]);

  const grouped = useMemo(() => workingChapters.map((chapter) => ({ chapter, items: workingItems.filter((item) => item.chapterId === chapter.id).sort((a, b) => a.order - b.order) })), [workingChapters, workingItems]);

  async function saveCourseTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditCourse || !courseTitle.trim()) return;
    try {
      await requestApi(`/api/courses/${encodeURIComponent(courseId)}`, {
        method: "PUT",
        body: { title: courseTitle.trim(), description: course?.description ?? "" },
        authUser: user,
      });
      setNotice("강의 이름을 저장했습니다.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "강의 이름을 저장하지 못했습니다."); }
  }

  function updateItem(itemId: string, changes: Partial<LiveCourseItem>) {
    if (!canEditFlow) return;
    setWorkingItems((current) => current.map((item) => item.id === itemId ? { ...item, ...changes } : item));
    setIsDirty(true);
  }

  function addChapter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newChapterTitle.trim();
    if (!title || !canEditFlow) return;
    const id = `chapter-${crypto.randomUUID()}`;
    setWorkingChapters((current) => [...current, { id, title, order: current.length }]);
    setNewItemChapterId(id);
    setNewChapterTitle("");
    setIsDirty(true);
  }

  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newItemTitle.trim();
    if (!title || !newItemChapterId || !canEditFlow) return;
    const nextOrder = workingItems.reduce(
      (maximum, item) => Math.max(maximum, item.order + 1),
      0,
    );
    setWorkingItems((current) => [...current, { id: `item-${crypto.randomUUID()}`, chapterId: newItemChapterId, title, description: "", materialLabel: title, kind: "SLIDE", order: nextOrder, isCompleted: false }]);
    setNewItemTitle("");
    setIsDirty(true);
  }

  function deleteItem(itemId: string) {
    if (!canEditFlow) return;
    setWorkingItems((current) => current.filter((item) => item.id !== itemId));
    setIsDirty(true);
  }

  function deleteChapter(chapterId: string) {
    if (!canEditFlow) return;
    const remaining = workingChapters.filter((chapter) => chapter.id !== chapterId);
    setWorkingChapters(remaining);
    setWorkingItems((current) =>
      current.filter((item) => item.chapterId !== chapterId),
    );
    if (newItemChapterId === chapterId) {
      setNewItemChapterId(remaining[0]?.id ?? "");
    }
    setIsDirty(true);
  }

  function moveChapter(chapterId: string, direction: -1 | 1) {
    if (!canEditFlow) return;
    setWorkingChapters((current) => {
      const index = current.findIndex((chapter) => chapter.id === chapterId);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
    setIsDirty(true);
  }

  function moveItem(itemId: string, direction: -1 | 1) {
    if (!canEditFlow) return;
    setWorkingItems((current) => {
      const target = current.find((item) => item.id === itemId);
      if (!target) return current;
      const sameChapter = current.filter((item) => item.chapterId === target.chapterId).sort((a, b) => a.order - b.order);
      const index = sameChapter.findIndex((item) => item.id === itemId);
      const swap = sameChapter[index + direction];
      if (!swap) return current;
      return current.map((item) => item.id === target.id ? { ...item, order: swap.order } : item.id === swap.id ? { ...item, order: target.order } : item);
    });
    setIsDirty(true);
  }

  async function saveFlow() {
    if (!canEditFlow) return;
    setNotice("수업 흐름을 서버에서 검증하고 있습니다.");
    try {
      await requestApi(`/api/courses/${encodeURIComponent(courseId)}/flow`, {
        method: "PUT",
        body: buildFlowUpdatePayload(workingChapters, workingItems),
        authUser: user,
      });
      setIsDirty(false);
      setNotice("수업 흐름을 저장했습니다. 구독 중인 화면에 실시간 반영됩니다.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "수업 흐름을 저장하지 못했습니다."); }
  }

  async function saveMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageMaterials || !materialName.trim()) return;
    try {
      const materialPayload = buildMaterialUpdatePayload(
        materialName,
        isMaterialShared,
      );
      await requestApi(`/api/courses/${encodeURIComponent(courseId)}/materials`, {
        method: "PUT",
        body: materialPayload,
        authUser: user,
      });
      materialServerRef.current = {
        fileName: materialPayload.fileName,
        isShared: materialPayload.isShared,
      };
      setMaterialName(materialPayload.fileName);
      setIsMaterialShared(materialPayload.isShared);
      setIsMaterialDirty(false);
      setNotice("자료 메타데이터를 저장했습니다. 파일 내용은 전송하지 않았습니다.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "자료 정보를 저장하지 못했습니다."); }
  }

  async function showShareInfo() {
    if (!course?.activeRoomId || !canShareRoom) return;
    try {
      const data = await requestApi<Record<string, unknown>>(`/api/rooms/${encodeURIComponent(course.activeRoomId)}/share`, { authUser: user });
      if (!canShareRoomRef.current) return;
      const joinCode = typeof data.joinCode === "string" ? data.joinCode : "";
      const joinPath = typeof data.joinPath === "string" ? data.joinPath : `/join/${joinCode}`;
      setShareInfo({ joinCode, joinPath });
    } catch (error) { setNotice(error instanceof Error ? error.message : "공유 정보를 불러오지 못했습니다."); }
  }

  if (isLoading) return <main className={styles.center} role="status">실제 수업 흐름을 불러오는 중입니다.</main>;
  if (!course) return <main className={styles.center}><h1>강의를 열 수 없습니다</h1><p>{notice}</p><Link to="/courses/import">강의 목록으로 돌아가기</Link></main>;

  return (
    <div className={styles.page}>
      <header className={styles.header}><Link to="/" aria-label="NoDo"><span>NO</span><span>DO</span></Link><span>{course.status}</span><nav><Link to="/courses/import">강의 목록</Link>{course.activeRoomId ? <Link to={`/rooms/${course.activeRoomId}/checklist`}>강의방</Link> : null}</nav></header>
      <main className={styles.layout}>
        <aside className={styles.settings}>
          <p>LIVE COURSE · {course.id}</p><h1>Make RoadMap</h1>
          <form onSubmit={saveCourseTitle}><label>강의 이름<input value={courseTitle} readOnly={!canEditCourse} onChange={(event) => setCourseTitle(event.target.value)} /></label>{canEditCourse ? <button type="submit"><Save aria-hidden="true" size={15} /> 이름 저장</button> : <small>강의 정보 수정 권한이 없습니다.</small>}</form>
          {canManageMaterials ? <form onSubmit={saveMaterial}><label>자료 메타데이터<input value={materialName} onChange={(event) => { setMaterialName(event.target.value); setIsMaterialDirty(true); }} placeholder="예: lesson.pdf" /></label><label className={styles.shareToggle}><input type="checkbox" checked={isMaterialShared} onChange={(event) => { setIsMaterialShared(event.target.checked); setIsMaterialDirty(true); }} /> 수강생에게 자료 공개</label><button type="submit" disabled={!materialName.trim()}><FileUp aria-hidden="true" size={15} /> 자료 정보 저장</button>{isMaterialDirty ? <button type="button" onClick={() => { setMaterialName(materialServerRef.current.fileName); setIsMaterialShared(materialServerRef.current.isShared); setIsMaterialDirty(false); }}>서버값으로 되돌리기</button> : null}<small>{isMaterialDirty ? "저장되지 않은 자료 변경 · " : ""}파일 내용은 읽거나 전송하지 않습니다.</small></form> : null}
          {course.activeRoomId ? canShareRoom ? <div className={styles.shareBox}><button type="button" onClick={() => void showShareInfo()}><Link2 aria-hidden="true" size={15} /> 참여 코드·링크·QR 보기</button>{shareInfo ? <div className={styles.shareDetails} role="status"><div className={styles.qrCode} role="img" aria-label={`참여 코드 ${shareInfo.joinCode} QR`}><QRCode value={buildRoomJoinUrl(shareInfo.joinPath)} size={112} /></div><strong>{shareInfo.joinCode}</strong><Link to={shareInfo.joinPath}>{buildRoomJoinUrl(shareInfo.joinPath)}</Link></div> : null}</div> : null : isLead ? <button className={styles.createRoom} type="button" aria-busy={pendingRoomCourseId === courseId} disabled={pendingRoomCourseId !== null} onClick={() => void createRoom(courseId)}>{pendingRoomCourseId === courseId ? "강의방 생성 중" : "강의방 생성"}</button> : null}
          {!canEditFlow ? <p className={styles.readOnly}>수업 흐름 편집 권한이 없어 읽기 전용입니다.</p> : null}
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        </aside>
        <section className={styles.flowPanel} aria-labelledby="flow-title"><div className={styles.flowHeading}><div><p>FIRESTORE REALTIME FLOW</p><h2 id="flow-title">챕터와 수업 흐름</h2></div>{canEditFlow ? <button type="button" disabled={!isDirty} onClick={() => void saveFlow()}><Save aria-hidden="true" size={16} /> {isDirty ? "변경 저장" : "저장됨"}</button> : null}</div>
          <div className={styles.chapters}>{grouped.map(({ chapter, items: chapterFlow }, chapterIndex) => <article key={chapter.id}><header><input aria-label={`${chapter.title} 이름`} value={chapter.title} readOnly={!canEditFlow} onChange={(event) => { setWorkingChapters((current) => current.map((entry) => entry.id === chapter.id ? { ...entry, title: event.target.value } : entry)); setIsDirty(true); }} /><span>{chapterFlow.length}개</span>{canEditFlow ? <div className={styles.chapterActions}><button type="button" aria-label={`${chapter.title} 챕터 위로 이동`} disabled={chapterIndex === 0} onClick={() => moveChapter(chapter.id, -1)}><ArrowUp aria-hidden="true" size={14} /></button><button type="button" aria-label={`${chapter.title} 챕터 아래로 이동`} disabled={chapterIndex === grouped.length - 1} onClick={() => moveChapter(chapter.id, 1)}><ArrowDown aria-hidden="true" size={14} /></button><button type="button" aria-label={`${chapter.title} 챕터 삭제`} onClick={() => deleteChapter(chapter.id)}><Trash2 aria-hidden="true" size={14} /></button></div> : null}</header><ol>{chapterFlow.map((item, index) => <li key={item.id}><span>{String(index + 1).padStart(2, "0")}</span><input aria-label={`${item.title} 새 이름`} value={item.title} readOnly={!canEditFlow} onChange={(event) => updateItem(item.id, { title: event.target.value, materialLabel: event.target.value })} />{canEditFlow ? <div><button type="button" aria-label={`${item.title} 위로 이동`} disabled={index === 0} onClick={() => moveItem(item.id, -1)}><ArrowUp aria-hidden="true" size={14} /></button><button type="button" aria-label={`${item.title} 아래로 이동`} disabled={index === chapterFlow.length - 1} onClick={() => moveItem(item.id, 1)}><ArrowDown aria-hidden="true" size={14} /></button><button type="button" aria-label={`${item.title} 삭제`} onClick={() => deleteItem(item.id)}><Trash2 aria-hidden="true" size={14} /></button></div> : null}</li>)}</ol></article>)}</div>
          {canEditFlow ? <div className={styles.addForms}><form onSubmit={addItem}><h3>항목 추가</h3><select aria-label="항목을 추가할 챕터" value={newItemChapterId} onChange={(event) => setNewItemChapterId(event.target.value)}>{workingChapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select><input aria-label="새 항목 이름" value={newItemTitle} onChange={(event) => setNewItemTitle(event.target.value)} /><button type="submit"><Plus aria-hidden="true" size={14} /> 항목 추가</button></form><form onSubmit={addChapter}><h3>챕터 추가</h3><input aria-label="새 챕터 이름" value={newChapterTitle} onChange={(event) => setNewChapterTitle(event.target.value)} /><button type="submit"><Plus aria-hidden="true" size={14} /> 챕터 추가</button></form></div> : null}
        </section>
      </main>
    </div>
  );
}
