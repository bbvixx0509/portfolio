import { ArrowRight, BookOpen, Plus, Radio, RefreshCw } from "lucide-react";
import { collectionGroup, onSnapshot, query, where } from "firebase/firestore";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { requestApi } from "../../lib/api/apiClient";
import { getLocalFirebaseFirestore } from "../../lib/firebase/firebaseFirestore";
import { useAuth } from "../auth/AuthContext";
import { profileAccountLabel } from "../auth/authTypes";
import styles from "./LiveCourseCatalogPage.module.css";
import { useRoomCreation } from "./useRoomCreation";

type LiveCourseSummary = {
  id: string;
  title: string;
  status: string;
  activeRoomId: string | null;
  updatedAt: string | null;
  leadInstructorId: string | null;
  roomRole: "LEAD" | "ASSISTANT" | null;
};

function readString(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (typeof data[key] === "string") return data[key] as string;
  return null;
}

function normalizeCourse(value: unknown): LiveCourseSummary | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const id = readString(data, "id", "courseId");
  if (!id) return null;
  return {
    id,
    title: readString(data, "title") ?? "이름 없는 강의",
    status: readString(data, "status") ?? "PREPARING",
    activeRoomId: readString(data, "activeRoomId"),
    updatedAt: readString(data, "updatedAt"),
    leadInstructorId: readString(data, "leadInstructorId"),
    roomRole:
      data.roomRole === "LEAD" || data.roomRole === "ASSISTANT"
        ? data.roomRole
        : null,
  };
}

function normalizeCourses(payload: unknown) {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const values = Array.isArray(payload) ? payload : Array.isArray(root.courses) ? root.courses : [];
  return values.map(normalizeCourse).filter((course): course is LiveCourseSummary => Boolean(course));
}

export function LiveCourseCatalogPage({ variant }: { variant: "dashboard" | "import" }) {
  const navigate = useNavigate();
  const { profile, user } = useAuth();
  const [courses, setCourses] = useState<LiveCourseSummary[]>([]);
  const [title, setTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const handleRoomCreated = useCallback(
    (roomId: string) => navigate(`/rooms/${roomId}/checklist`),
    [navigate],
  );
  const {
    createRoom: startRoom,
    pendingCourseId: pendingRoomCourseId,
  } = useRoomCreation({
    authUser: user,
    onCreated: handleRoomCreated,
    onNotice: setNotice,
  });

  const loadCourses = useCallback(async () => {
    setIsLoading(true);
    setNotice(null);
    try {
      const payload = await requestApi<unknown>("/api/courses", { authUser: user });
      setCourses(normalizeCourses(payload));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "강의 목록을 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => { void loadCourses(); }, [loadCourses]);

  useEffect(() => {
    if (profile?.accountType !== "STAFF") return;
    const ownRoomRelations = query(
      collectionGroup(getLocalFirebaseFirestore(), "staff"),
      where("userId", "==", profile.uid),
      where("orgId", "==", profile.orgId),
    );
    return onSnapshot(
      ownRoomRelations,
      () => {
        void loadCourses();
      },
      (error) => setNotice(error.message),
    );
  }, [loadCourses, profile?.accountType, profile?.orgId, profile?.uid]);

  async function createCourse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = title.trim();
    if (!value || profile?.accountType !== "STAFF") return;
    setNotice("새 강의를 서버에 저장하고 있습니다.");
    try {
      const payload = await requestApi<unknown>("/api/courses", {
        method: "POST",
        body: { title: value },
        authUser: user,
      });
      const course = normalizeCourse(payload) ?? normalizeCourse((payload as Record<string, unknown>)?.course);
      setTitle("");
      if (course) {
        navigate(`/courses/${course.id}/prepare`);
      } else {
        await loadCourses();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "강의를 만들지 못했습니다.");
    }
  }

  function roomRelation(course: LiveCourseSummary) {
    if (!profile || profile.accountType !== "STAFF") return null;
    if (course.leadInstructorId === profile.uid || course.roomRole === "LEAD") {
      return "LEAD" as const;
    }
    if (course.roomRole === "ASSISTANT") return "ASSISTANT" as const;
    return null;
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}><a href="/" aria-label="NoDo"><span>NO</span><span>DO</span></a><div><span>{profile ? profileAccountLabel(profile) : "사용자"}</span><strong>{profile?.displayName}</strong></div></header>
      <main className={styles.main}>
        <section className={styles.intro}><div><p>LIVE COURSES · FIRESTORE EMULATOR</p><h1>{variant === "dashboard" ? "오늘 진행할 " : "저장된 "}<span>강의 목록</span></h1><p>이 목록은 FastAPI 권한 검사를 거쳐 같은 조직의 실제 Emulator 데이터만 표시합니다.</p></div><button type="button" onClick={() => void loadCourses()}><RefreshCw aria-hidden="true" size={16} /> 새로고침</button></section>
        {profile?.accountType === "STAFF" ? <form className={styles.createForm} onSubmit={createCourse}><label><span>새 강의명</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 생성형 AI 실습" /></label><button type="submit" disabled={!title.trim()}><Plus aria-hidden="true" size={17} /> 새 강의 생성</button></form> : null}
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        {isLoading ? (
          <p className={styles.loading} role="status">강의 목록을 불러오는 중입니다.</p>
        ) : courses.length === 0 ? (
          <div className={styles.empty}><BookOpen aria-hidden="true" /><strong>아직 표시할 강의가 없습니다.</strong><span>직원 계정에서 첫 강의를 만들어 보세요.</span></div>
        ) : (
          <section className={styles.grid} aria-label="실제 강의 목록">
            {courses.map((course) => {
              const relation = roomRelation(course);
              return <article key={course.id}>
                <header><span>{relation === "LEAD" ? "주 강사" : relation === "ASSISTANT" ? "보조 강사" : "담당자 아님"} · {course.status}</span><small>{course.id}</small></header>
                <h2>{course.title}</h2>
                <p>{course.activeRoomId ? `진행 강의방 · ${course.activeRoomId}` : "아직 생성된 강의방이 없습니다."}</p>
                <footer>
                  {relation ? (
                    <button type="button" onClick={() => navigate(`/courses/${course.id}/prepare`)}>
                      {relation === "LEAD" ? "수업 흐름 편집" : "수업 흐름 보기"} <ArrowRight aria-hidden="true" size={15} />
                    </button>
                  ) : null}
                  {course.activeRoomId && (relation || profile?.accountType === "STUDENT") ? (
                    <button type="button" onClick={() => navigate(`/rooms/${course.activeRoomId}/checklist`)}><Radio aria-hidden="true" size={15} /> 강의방 열기</button>
                  ) : null}
                  {!course.activeRoomId && relation === "LEAD" ? (
                    <button
                      type="button"
                      aria-busy={pendingRoomCourseId === course.id}
                      disabled={pendingRoomCourseId !== null}
                      onClick={() => void startRoom(course.id)}
                    >
                      <Radio aria-hidden="true" size={15} /> {pendingRoomCourseId === course.id ? "강의방 생성 중" : "강의방 생성"}
                    </button>
                  ) : null}
                </footer>
              </article>;
            })}
          </section>
        )}
      </main>
    </div>
  );
}
