import { Copy, FolderOpen, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import {
  archiveCloudCourse,
  createCloudCourse,
  duplicateCloudCourse,
  getCloudCourse,
  listCloudCourses,
  type CourseChapter,
  type CourseDraft,
  type CourseRecord,
  type CourseSummary,
  updateCloudCourse,
} from "./courseApi";
import { loadOwnStorageUsage, storageLabel, type StorageUsage } from "../material-selection/storageQuotaApi";
import { ApiError } from "../../lib/api/apiClient";
import { isStudentAccessOpen } from "../cloud-rooms/endAccessDeadline";
import styles from "./CloudCoursePages.module.css";

const emptyCourse = (): CourseDraft => ({ title: "", description: "", chapters: [] });
const id = () => crypto.randomUUID();
const message = (error: unknown, fallback: string) => {
  if (error instanceof Error) {
    if (error.message === "Failed to fetch") return `${fallback} 로컬 서버 연결을 확인한 뒤 다시 시도해 주세요.`;
    return error.message;
  }
  return fallback;
};
type CourseSort = "RECENT" | "OLDEST" | "TITLE_KO";
type CourseEntryStatus = "NOT_STARTED" | "LIVE" | "DOWNLOAD_OPEN" | "ENDED";
type CourseEntryFilter = Exclude<CourseEntryStatus, "ENDED"> | "ALL";
type StorageUsageError = "AUTHENTICATION" | "FORBIDDEN" | "UNAVAILABLE";

const courseTitleCollator = new Intl.Collator("ko-KR", { numeric: true });
const entryStatusLabel: Record<CourseEntryStatus, string> = {
  NOT_STARTED: "시작 전",
  LIVE: "진행 중",
  DOWNLOAD_OPEN: "자료 열람 가능",
  ENDED: "종료됨",
};


export function courseEntryStatus(
  room: CourseSummary["latestAccessibleRoom"],
  now = Date.now(),
): CourseEntryStatus {
  if (!room || room.status === "READY") return "NOT_STARTED";
  if (room.status === "LIVE") return "LIVE";

  if (room.status === "ENDED") {
    if (isStudentAccessOpen(room.endedAt ?? null, room.downloadAvailableUntil ?? null, new Date(now))) {
      return "DOWNLOAD_OPEN";
    }
  }
  return "ENDED";
}

export function sortCloudCourses(courses: CourseSummary[], sort: CourseSort) {
  return [...courses].sort((left, right) => {
    if (sort === "TITLE_KO") {
      return courseTitleCollator.compare(left.title, right.title)
        || courseTitleCollator.compare(left.id, right.id);
    }
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    const difference = sort === "RECENT" ? rightTime - leftTime : leftTime - rightTime;
    return difference
      || courseTitleCollator.compare(left.title, right.title)
      || courseTitleCollator.compare(left.id, right.id);
  });
}

export function CloudCourseCatalogPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CourseSort>("RECENT");
  const [statusFilter, setStatusFilter] = useState<CourseEntryFilter>("ALL");
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [storageStatus, setStorageStatus] = useState<"LOADING" | "READY" | "ERROR">("LOADING");
  const [storageError, setStorageError] = useState<StorageUsageError | null>(null);

  const loadStorageUsage = useCallback(async () => {
    setStorageStatus("LOADING");
    setStorageError(null);
    try {
      setStorageUsage(await loadOwnStorageUsage());
      setStorageStatus("READY");
    } catch (error) {
      setStorageUsage(null);
      setStorageError(
        error instanceof ApiError && error.status === 401
          ? "AUTHENTICATION"
          : error instanceof ApiError && error.status === 403
            ? "FORBIDDEN"
            : "UNAVAILABLE",
      );
      setStorageStatus("ERROR");
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      try {
        const nextCourses = await listCloudCourses(user);
        if (active) {
          setCourses(nextCourses);
        }
      } catch (error) {
        if (active) setNotice(message(error, "목록을 불러오지 못했습니다."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [user]);

  useEffect(() => { void loadStorageUsage(); }, [loadStorageUsage]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => {
    let filtered = courses.filter((course) => !normalizedQuery || course.title.toLocaleLowerCase().includes(normalizedQuery));
    if (statusFilter !== "ALL") {
      filtered = filtered.filter(course => courseEntryStatus(course.latestAccessibleRoom) === statusFilter);
    }
    return sortCloudCourses(filtered, sort);
  }, [courses, normalizedQuery, sort, statusFilter]);
  const storageUsedRatio = storageUsage && storageUsage.limitBytes > 0
    ? Math.min(1, storageUsage.usedBytes / storageUsage.limitBytes)
    : 0;
  const storageFull = storageUsage?.remainingBytes === 0;
  const storageNearLimit = !storageFull && storageUsedRatio >= 0.8;
  const storagePending = storageUsage?.baselineState === "PENDING_BASELINE";

  function openCourse(courseId: string, room: CourseSummary["latestAccessibleRoom"]) {
    if (room && room.status !== "ENDED") {
      navigate(`/rooms/${encodeURIComponent(room.roomId)}/checklist`);
      return;
    }
    if (room && room.status === "ENDED") {
      navigate(`/rooms/${encodeURIComponent(room.roomId)}/summary`);
      return;
    }
    navigate(`/courses/${encodeURIComponent(courseId)}/rooms/new`);
  }

  async function archive(course: CourseSummary) {
    if (!window.confirm(`‘${course.title}’을 목록에서 삭제할까요?\n삭제한 목록은 일반 목록에서 보이지 않으며, 운영 기록을 위해 보관됩니다.`)) return;
    try {
      await archiveCloudCourse(user, course.id, course.revision);
      setCourses((current) => current.filter((item) => item.id !== course.id));
      setNotice("목록을 삭제했습니다.");
    } catch (error) {
      setNotice(message(error, "목록을 삭제하지 못했습니다."));
    }
  }

  return <main className={styles.page}>
    <div className={styles.pageActions}><Link to="/create/manual"><Plus aria-hidden="true" />직접 만들기</Link></div>
    <section className={styles.heading}>
      <p>재사용 가능한 수업 흐름</p><h1>기존 목록 불러오기</h1>
      <div className={styles.filters}>
        <label className={styles.search}><span className={styles.srOnly}>수업 흐름 검색</span><input aria-label="수업 흐름 검색" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="수업 제목 검색" /></label>
        <label className={styles.sortField}>상태
          <select aria-label="수업 상태 필터" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CourseEntryFilter)}>
            <option value="ALL">전체</option>
            <option value="NOT_STARTED">시작 전</option>
            <option value="LIVE">진행 중</option>
            <option value="DOWNLOAD_OPEN">자료 열람 가능</option>
          </select>
        </label>
        <label className={styles.sortField}>정렬
          <select aria-label="수업 흐름 정렬" value={sort} onChange={(event) => setSort(event.target.value as CourseSort)}>
            <option value="RECENT">최신순</option>
            <option value="OLDEST">오래된순</option>
            <option value="TITLE_KO">가나다순</option>
          </select>
        </label>
      </div>
      <section className={styles.storageSummary} aria-label="내 자료 용량">
        {storageStatus === "LOADING" ? <span className={styles.storageLoading}>내 자료 용량을 확인하는 중입니다.</span> : null}
        {storageStatus === "ERROR" ? <div className={styles.storageError} role="status"><span>{storageError === "AUTHENTICATION" ? "로그인 상태를 확인한 뒤 다시 시도해 주세요." : storageError === "FORBIDDEN" ? "자료 용량 조회 권한이 없습니다." : "자료 용량 정보를 불러오지 못했습니다."}</span><button type="button" onClick={() => void loadStorageUsage()}>다시 시도</button></div> : null}
        {storageStatus === "READY" && storageUsage && storagePending ? <p className={styles.storageLoading} role="status">자료 사용량을 준비하고 있습니다.</p> : null}
        {storageStatus === "READY" && storageUsage && !storagePending ? <>
          <div className={styles.storageCopy}>
            <strong>내 자료 용량</strong>
            <span>사용 중 {storageLabel(storageUsage.usedBytes)} / {storageLabel(storageUsage.limitBytes)}</span>
            <span>남은 용량 {storageLabel(storageUsage.remainingBytes)}</span>
          </div>
          <div className={styles.storageMeter} aria-label={`자료 용량 사용률 ${Math.round(storageUsedRatio * 100)}%`}>
            <span className={storageFull ? styles.storageFull : storageNearLimit ? styles.storageNearLimit : undefined} style={{ width: `${storageUsedRatio * 100}%` }} />
          </div>
          {storageFull ? <p className={`${styles.storageWarning} ${styles.storageFullWarning}`} role="status">자료 저장 공간을 모두 사용했습니다. 불필요한 자료를 정리하거나 관리자에게 한도 상향을 요청하세요.</p> : null}
          {storageNearLimit ? <p className={`${styles.storageWarning} ${styles.storageNearWarning}`} role="status">저장 공간이 얼마 남지 않았습니다.</p> : null}
        </> : null}
      </section>
    </section>
    {notice ? <p role="status">{notice}</p> : null}
    {loading ? <p role="status">목록을 불러오는 중입니다.</p> : visible.length === 0 ? <section className={styles.empty}><FolderOpen aria-hidden="true" /><p>{normalizedQuery ? "검색 결과가 없습니다." : "저장된 수업 흐름이 없습니다."}</p></section> : <ul className={styles.list}>{visible.map((course) => {
      const status = courseEntryStatus(course.latestAccessibleRoom);
      return <li key={course.id}>
      <div>
        <div className={styles.cardTitle}>
          <h2>{course.title}</h2>
          <span className={`${styles.roomState} ${styles[`roomState${status}`]}`}>{entryStatusLabel[status]}</span>
        </div>
        <small>
          챕터 {course.chapterCount} · 항목 {course.itemCount}
          {status === "DOWNLOAD_OPEN" && " · 마감 전까지 열람 가능"}
        </small>
      </div>
      <div className={styles.actions}>
        <button type="button" onClick={() => void openCourse(course.id, course.latestAccessibleRoom)}>열기</button>
        <button type="button" onClick={() => navigate(`/courses/${encodeURIComponent(course.id)}/edit`)}>편집</button>
        {course.isMine ? <button type="button" onClick={() => void archive(course)}><Trash2 aria-hidden="true" />삭제</button> : null}
      </div>
    </li>;
    })}</ul>}
  </main>;
}

export function CloudCourseEditorPage({ creating = false }: { creating?: boolean }) {
  const { courseId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [course, setCourse] = useState<CourseRecord | null>(null);
  const [draft, setDraft] = useState<CourseDraft>(emptyCourse);
  const [loading, setLoading] = useState(!creating);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (creating) return;
    void (async () => {
      try {
        const next = await getCloudCourse(user, courseId);
        setCourse(next);
        setDraft({ title: next.title, description: next.description, chapters: next.chapters });
      } catch (error) {
        setNotice(message(error, "목록을 열 수 없습니다."));
      } finally {
        setLoading(false);
      }
    })();
  }, [creating, courseId, user]);

  const archived = course?.status === "ARCHIVED";
  const editable = !archived && (creating || course?.isMine === true);
  function updateChapter(index: number, changes: Partial<CourseChapter>) { setDraft((current) => ({ ...current, chapters: current.chapters.map((chapter, i) => i === index ? { ...chapter, ...changes } : chapter) })); }
  function addChapter() { setDraft((current) => ({ ...current, chapters: [...current.chapters, { id: id(), title: "새 챕터", position: current.chapters.length, items: [] }] })); }
  function removeChapter(index: number) { setDraft((current) => ({ ...current, chapters: current.chapters.filter((_, i) => i !== index) })); }
  function moveChapter(index: number, direction: -1 | 1) { setDraft((current) => { const chapters = [...current.chapters]; const target = index + direction; if (target < 0 || target >= chapters.length) return current; [chapters[index], chapters[target]] = [chapters[target], chapters[index]]; return { ...current, chapters }; }); }
  function removeItem(chapterIndex: number, itemIndex: number) { const chapter = draft.chapters[chapterIndex]; updateChapter(chapterIndex, { items: chapter.items.filter((_, i) => i !== itemIndex) }); }
  function moveItem(chapterIndex: number, itemIndex: number, direction: -1 | 1) { const chapter = draft.chapters[chapterIndex]; const items = [...chapter.items]; const target = itemIndex + direction; if (target < 0 || target >= items.length) return; [items[itemIndex], items[target]] = [items[target], items[itemIndex]]; updateChapter(chapterIndex, { items }); }
  async function save() {
    if (!editable || !draft.title.trim()) return;
    setSaving(true); setNotice(null);
    try {
      const saved = creating ? await createCloudCourse(user, draft) : await updateCloudCourse(user, courseId, draft, course?.revision ?? 0);
      navigate(`/courses/${saved.id}/prepare`, { replace: creating });
      setCourse(saved); setDraft({ title: saved.title, description: saved.description, chapters: saved.chapters }); setNotice("수업 흐름을 저장했습니다.");
    } catch (error) { setNotice(message(error, "저장하지 못했습니다. 최신 내용을 확인해 주세요.")); } finally { setSaving(false); }
  }
  async function copy() { if (!course || archived) return; try { const next = await duplicateCloudCourse(user, course.id); navigate(`/courses/${next.id}/prepare`); } catch (error) { setNotice(message(error, "목록을 복사하지 못했습니다.")); } }
  async function archive() { if (!course || archived || !window.confirm(`‘${course.title}’을 목록에서 삭제할까요?\n삭제한 목록은 일반 목록에서 보이지 않으며, 운영 기록을 위해 보관됩니다.`)) return; try { await archiveCloudCourse(user, course.id, course.revision); navigate("/courses/import", { state: { notice: "목록을 삭제했습니다." } }); } catch (error) { setNotice(message(error, "목록을 삭제하지 못했습니다.")); } }

  if (loading) return <p role="status">수업 흐름을 불러오는 중입니다.</p>;
  return <main className={styles.page}><div className={styles.pageActions}><Link to="/courses/import">목록으로</Link></div><section className={styles.editor}>
    <p>{editable ? "수업 흐름 편집" : "읽기 전용 수업 흐름"}</p>
    {archived ? <><span className={styles.archivedBadge}>보관된 수업</span><p className={styles.readOnlyNotice}>보관된 수업은 읽기 전용입니다. 수정하거나 다시 보관할 수 없습니다.</p></> : null}
    {!editable ? <p className={styles.creator}>작성자: {course?.createdByDisplayNameSnapshot || "이름 미등록"}</p> : null}
    <input aria-label="수업 제목" value={draft.title} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
    {draft.chapters.map((chapter, index) => <section className={styles.chapter} key={chapter.id}><div className={styles.row}><input aria-label={`챕터 ${index + 1} 제목`} value={chapter.title} disabled={!editable} onChange={(event) => updateChapter(index, { title: event.target.value })} />{editable ? <span><button aria-label={`챕터 ${index + 1} 위로`} disabled={index === 0} onClick={() => moveChapter(index, -1)}>위</button><button aria-label={`챕터 ${index + 1} 아래로`} disabled={index === draft.chapters.length - 1} onClick={() => moveChapter(index, 1)}>아래</button><button aria-label={`챕터 ${index + 1} 삭제`} onClick={() => removeChapter(index)}>삭제</button></span> : null}</div>{chapter.items.map((item, itemIndex) => <div className={styles.item} key={item.id}><input aria-label={`항목 ${itemIndex + 1} 제목`} value={item.title} disabled={!editable} onChange={(event) => updateChapter(index, { items: chapter.items.map((value, i) => i === itemIndex ? { ...value, title: event.target.value } : value) })} /><textarea aria-label={`항목 ${itemIndex + 1} 설명`} value={item.description} disabled={!editable} onChange={(event) => updateChapter(index, { items: chapter.items.map((value, i) => i === itemIndex ? { ...value, description: event.target.value } : value) })} />{editable ? <span><button aria-label={`항목 ${itemIndex + 1} 위로`} disabled={itemIndex === 0} onClick={() => moveItem(index, itemIndex, -1)}>위</button><button aria-label={`항목 ${itemIndex + 1} 아래로`} disabled={itemIndex === chapter.items.length - 1} onClick={() => moveItem(index, itemIndex, 1)}>아래</button><button aria-label={`항목 ${itemIndex + 1} 삭제`} onClick={() => removeItem(index, itemIndex)}>삭제</button></span> : null}</div>)}{editable ? <button onClick={() => updateChapter(index, { items: [...chapter.items, { id: id(), title: "새 항목", description: "", position: chapter.items.length }] })}>항목 추가</button> : null}</section>)}
    {notice ? <p role="status">{notice}</p> : null}
    {editable ? <div className={styles.actions}><button onClick={addChapter}><Plus aria-hidden="true" />챕터 추가</button><button disabled={saving || !draft.title.trim()} onClick={() => void save()}><Save aria-hidden="true" />{saving ? "저장 중..." : "저장하기"}</button>{!creating ? <><button onClick={() => navigate(`/courses/${courseId}/rooms/new`)}>강의방 만들기</button><button onClick={() => void archive()}><Trash2 aria-hidden="true" />삭제</button></> : null}</div> : course && !archived ? <div className={styles.actions}><button onClick={() => navigate(`/courses/${courseId}/rooms/new`)}>강의방 만들기</button><button onClick={() => void copy()}><Copy aria-hidden="true" />이 목록 복사</button></div> : null}
  </section></main>;
}
