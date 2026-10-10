import { ImportCoursesPage } from "../../pages/ImportCoursesPage";
import { StartPage } from "../../pages/StartPage";
import { useAuth } from "../auth/AuthContext";
import { AuthProfileUnavailable } from "../auth/AuthProfileUnavailable";

const LiveCourseCatalogPage = lazy(async () => {
  const module = await import("./LiveCourseCatalogPage");
  return { default: module.LiveCourseCatalogPage };
});

function LiveCatalog({ variant }: { variant: "dashboard" | "import" }) {
  return (
    <Suspense fallback={<p role="status">실제 강의 목록 준비 중</p>}>
      <LiveCourseCatalogPage variant={variant} />
    </Suspense>
  );
}

function SessionLoading() {
  return <p role="status">인증 세션 확인 중</p>;
}

export function AdaptiveStartPage() {
  const { user, profile, error, isRestoringSession } = useAuth();
  if (isRestoringSession) return <SessionLoading />;
  if (!user) return <StartPage />;
  return profile ? <LiveCatalog variant="dashboard" /> : <AuthProfileUnavailable message={error} />;
}

export function AdaptiveImportCoursesPage() {
  const { user, profile, error, isRestoringSession } = useAuth();
  if (isRestoringSession) return <SessionLoading />;
  if (!user) return <ImportCoursesPage />;
  return profile ? <LiveCatalog variant="import" /> : <AuthProfileUnavailable message={error} />;
}
import { lazy, Suspense } from "react";
