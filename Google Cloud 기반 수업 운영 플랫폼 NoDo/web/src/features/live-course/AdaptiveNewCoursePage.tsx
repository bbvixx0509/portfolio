import { ArrowRight, FileUp, PenLine } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { requestApi } from "../../lib/api/apiClient";
import { useAuth } from "../auth/AuthContext";
import { AuthProfileUnavailable } from "../auth/AuthProfileUnavailable";
import { CourseFlowBuilderPage } from "../demo-course/CourseFlowBuilderPage";
import styles from "./AdaptiveNewCoursePage.module.css";

function readCourseId(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const course = root.course && typeof root.course === "object" ? root.course as Record<string, unknown> : root;
  return typeof course.courseId === "string" ? course.courseId : typeof course.id === "string" ? course.id : null;
}

function LiveNewCoursePage({ source }: { source: "material" | "manual" }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [title, setTitle] = useState(source === "material" ? "자료 기반 새 강의" : "직접 만든 새 강의");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createCourse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    setIsSaving(true);
    setError(null);
    try {
      const payload = await requestApi<unknown>("/api/courses", { method: "POST", body: { title: value }, authUser: user });
      const courseId = readCourseId(payload);
      if (!courseId) throw new Error("생성된 강의 ID를 확인할 수 없습니다.");
      navigate(`/courses/${courseId}/prepare`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "강의를 생성하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className={styles.page}>
      <header><Link to="/" aria-label="NoDo"><span>NO</span><span>DO</span></Link><Link to="/courses/import">실제 강의 목록</Link></header>
      <main><div className={styles.icon}>{source === "material" ? <FileUp aria-hidden="true" /> : <PenLine aria-hidden="true" />}</div><p>LIVE COURSE · FASTAPI</p><h1>{source === "material" ? "자료로 " : "빈 흐름에서 "}<span>강의 만들기</span></h1><p>강의 기본 정보를 먼저 서버에 저장한 뒤 실제 Firestore 수업 흐름 편집기로 이동합니다.</p><form onSubmit={createCourse}><label>강의 이름<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>{error ? <p role="alert">{error}</p> : null}<button type="submit" disabled={isSaving || !title.trim()}>{isSaving ? "저장 중" : "강의 생성 후 편집"}<ArrowRight aria-hidden="true" size={17} /></button></form></main>
    </div>
  );
}

export function AdaptiveNewCoursePage({ source }: { source: "material" | "manual" }) {
  const { user, profile, error, isRestoringSession } = useAuth();
  if (isRestoringSession) return <p role="status">인증 세션 확인 중</p>;
  if (!user) return <CourseFlowBuilderPage source={source} />;
  if (!profile) return <AuthProfileUnavailable message={error} />;
  if (profile.accountType !== "STAFF") {
    return (
      <main className={styles.denied}>
        <h1>새 강의를 만들 수 없습니다</h1>
        <p>새 강의 생성은 같은 조직의 직원 계정만 사용할 수 있습니다.</p>
        <Link to="/courses/import">접근 가능한 강의 목록 보기</Link>
      </main>
    );
  }
  return <LiveNewCoursePage source={source} />;
}
