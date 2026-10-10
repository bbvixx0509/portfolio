import { lazy, Suspense } from "react";
import { useAuth } from "../auth/AuthContext";
import { AuthProfileUnavailable } from "../auth/AuthProfileUnavailable";
import { TeachingRoomPage } from "../demo-course/TeachingRoomPage";

const LiveTeachingRoomPage = lazy(async () => {
  const module = await import("./LiveTeachingRoomPage");
  return { default: module.LiveTeachingRoomPage };
});

export function AdaptiveTeachingRoomPage({
  view,
}: {
  view: "CHECKLIST" | "CHAT";
}) {
  const { user, profile, error, isRestoringSession } = useAuth();

  if (isRestoringSession) {
    return <p role="status">인증 세션 확인 중</p>;
  }

  if (!user) {
    return <TeachingRoomPage view={view} />;
  }

  if (!profile) return <AuthProfileUnavailable message={error} />;

  return (
    <Suspense fallback={<p role="status">실시간 강의 화면 준비 중</p>}>
      <LiveTeachingRoomPage view={view} />
    </Suspense>
  );
}
