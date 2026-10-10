import { lazy, Suspense } from "react";
import { CourseFlowBuilderPage } from "../demo-course/CourseFlowBuilderPage";
import { useAuth } from "../auth/AuthContext";
import { AuthProfileUnavailable } from "../auth/AuthProfileUnavailable";

const LiveCourseFlowEditorPage = lazy(async () => {
  const module = await import("./LiveCourseFlowEditorPage");
  return { default: module.LiveCourseFlowEditorPage };
});

export function AdaptiveCourseFlowBuilderPage() {
  const { user, profile, error, isRestoringSession } = useAuth();
  if (isRestoringSession) return <p role="status">인증 세션 확인 중</p>;
  if (!user) return <CourseFlowBuilderPage source="import" />;
  return profile ? (
    <Suspense fallback={<p role="status">실제 수업 흐름 준비 중</p>}>
      <LiveCourseFlowEditorPage />
    </Suspense>
  ) : <AuthProfileUnavailable message={error} />;
}
