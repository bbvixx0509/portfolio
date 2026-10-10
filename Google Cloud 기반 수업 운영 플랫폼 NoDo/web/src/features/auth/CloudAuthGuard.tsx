import { LockKeyhole, LogOut } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { rememberCloudReturnPath } from "./cloudAuthNavigation";
import styles from "./CloudAuthGuard.module.css";

export function StaffCloudAuthGuard({ children }: { children: ReactNode }) {
  const {
    user,
    profile,
    organizationInvitation,
    identityKind,
    isLoading,
    isBootstrappingOrganization,
    error,
    reconnectLocalApi,
    endStudentSession,
    logout,
  } = useAuth();
  const location = useLocation();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const returnPath = `${location.pathname}${location.search}${location.hash}`;
  const isStudent = identityKind === "student" || user?.isAnonymous === true;
  const isUnsupported = identityKind === "unsupported";
  const hasStaffVerificationFailure = Boolean(
    identityKind === "staff-verification-failed" &&
    user &&
    user.isAnonymous !== true,
  );
  const isInvitedStaff = Boolean(
    identityKind === "invited-staff" &&
    user &&
    organizationInvitation,
  );
  const isAuthorized = Boolean(
    user &&
    profile &&
    identityKind === "staff" &&
    profile.uid === user.uid &&
    profile.accountType === "STAFF" &&
    profile.orgId &&
    profile.authorized === true &&
    user.isAnonymous !== true,
  );
  const shouldRedirectToLogin =
    !isLoading &&
    !isStudent &&
    !isUnsupported &&
    !hasStaffVerificationFailure &&
    !isInvitedStaff &&
    !isAuthorized;

  useEffect(() => {
    if (shouldRedirectToLogin) {
      rememberCloudReturnPath(returnPath);
    }
  }, [returnPath, shouldRedirectToLogin]);

  if (isLoading) {
    return (
      <p role="status">
        {isBootstrappingOrganization
          ? "조직 설정 중..."
          : "Google 인증과 회사 직원 권한 확인 중"}
      </p>
    );
  }

  if (isInvitedStaff) {
    return <Navigate to="/join-organization" replace />;
  }

  if (hasStaffVerificationFailure) {
    const handleReconnect = async () => {
      setActionError(null);
      setIsReconnecting(true);
      try {
        await reconnectLocalApi();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "연결을 다시 확인하지 못했습니다.");
      } finally {
        setIsReconnecting(false);
      }
    };

    return (
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="staff-verification-title">
          <LockKeyhole aria-hidden="true" />
          <h1 id="staff-verification-title">직원 권한을 다시 확인하지 못했습니다</h1>
          <p>{error ?? "Google 로그인은 유지하고 있습니다. 잠시 후 다시 시도해 주세요."}</p>
          {actionError ? <p role="alert" className={styles.error}>{actionError}</p> : null}
          <button type="button" onClick={() => void handleReconnect()} disabled={isReconnecting}>
            {isReconnecting ? "확인 중..." : "연결 다시 확인"}
          </button>
        </section>
      </main>
    );
  }

  if (isStudent || isUnsupported) {
    const handleExit = async () => {
      setActionError(null);
      try {
        if (isStudent) await endStudentSession();
        else await logout();
      } catch {
        setActionError("현재 참여 상태를 종료하지 못했습니다. 다시 시도해 주세요.");
      }
    };
    return (
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="staff-only-title">
          <LockKeyhole aria-hidden="true" />
          <h1 id="staff-only-title">권한이 없습니다</h1>
          <p>이 화면은 확인된 강사와 관리자만 사용할 수 있습니다.</p>
          {isStudent ? <p>현재 학생 참여를 먼저 종료해 주세요.</p> : null}
          {actionError ? <p role="alert">{actionError}</p> : null}
          <button type="button" onClick={() => void handleExit()}>
            <LogOut aria-hidden="true" /> 현재 상태 종료
          </button>
        </section>
      </main>
    );
  }

  if (shouldRedirectToLogin) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: returnPath }}
      />
    );
  }

  return children;
}

export const CloudAuthGuard = StaffCloudAuthGuard;

function OrganizationManagementBoundary({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  if (profile?.organizationRole === "ADMIN") {
    return children;
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="organization-management-title">
        <LockKeyhole aria-hidden="true" />
        <h1 id="organization-management-title">조직 관리 권한이 없습니다</h1>
        <p>직원 초대, 역할 변경, 취소는 DEMO 관리자만 관리할 수 있습니다.</p>
        <Link to="/">NoDo 시작 화면으로</Link>
      </section>
    </main>
  );
}

export function OrganizationManagementGuard({ children }: { children: ReactNode }) {
  return (
    <StaffCloudAuthGuard>
      <OrganizationManagementBoundary>{children}</OrganizationManagementBoundary>
    </StaffCloudAuthGuard>
  );
}
