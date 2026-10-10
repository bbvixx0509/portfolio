import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Clock3,
  LogOut,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api/apiClient";
import { useAuth } from "../features/auth/AuthContext";
import { clearCloudReturnPath } from "../features/auth/cloudAuthNavigation";
import styles from "./OrganizationJoinPage.module.css";

type JoinFailure = "UNAVAILABLE" | "ALREADY_JOINED" | "NETWORK";

export function isInvitationExpired(expiresAt: string, now = Date.now()) {
  const expiration = Date.parse(expiresAt);
  return Number.isNaN(expiration) || expiration <= now;
}

export function organizationJoinFailure(error: unknown): JoinFailure {
  if (error instanceof ApiError) {
    if (error.status === 403 || error.status === 404) return "UNAVAILABLE";
    if (error.status === 409) return "ALREADY_JOINED";
  }
  return "NETWORK";
}

function expirationLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

export function OrganizationJoinPage() {
  const navigate = useNavigate();
  const {
    user,
    profile,
    organizationInvitation,
    identityKind,
    isLoading,
    acceptOrganizationInvitation,
    logout,
  } = useAuth();
  const [isAccepting, setIsAccepting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [failure, setFailure] = useState<JoinFailure | null>(null);
  const invitationExpired = useMemo(
    () => organizationInvitation
      ? isInvitationExpired(organizationInvitation.expiresAt)
      : false,
    [organizationInvitation],
  );

  useEffect(() => {
    if (identityKind !== "signed-out") return;
    navigate("/login", {
      replace: true,
      state: { from: "/join-organization" },
    });
  }, [identityKind, navigate]);

  async function handleAccept() {
    if (isAccepting || invitationExpired) return;
    setFailure(null);
    setIsAccepting(true);
    try {
      await acceptOrganizationInvitation();
      clearCloudReturnPath();
      navigate("/", { replace: true });
    } catch (acceptError) {
      setFailure(organizationJoinFailure(acceptError));
    } finally {
      setIsAccepting(false);
    }
  }

  async function handleLogout() {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setFailure(null);
    try {
      await logout();
      clearCloudReturnPath();
      navigate("/login", { replace: true });
    } catch {
      setFailure("NETWORK");
    } finally {
      setIsLoggingOut(false);
    }
  }

  if (isLoading && identityKind === "loading") {
    return (
      <main className={styles.page}>
        <section className={styles.card} role="status">
          <Clock3 className={styles.pulse} aria-hidden="true" />
          <h1>초대 정보를 확인하고 있습니다</h1>
          <p>잠시만 기다려 주세요.</p>
        </section>
      </main>
    );
  }

  if (identityKind === "signed-out") {
    return <Navigate to="/login" replace state={{ from: "/join-organization" }} />;
  }

  if (profile && identityKind === "staff") {
    return (
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="already-joined-title">
          <CheckCircle2 className={styles.successIcon} aria-hidden="true" />
          <p className={styles.eyebrow}>DEMO ORGANIZATION</p>
          <h1 id="already-joined-title">이미 DEMO 조직에 가입되어 있습니다</h1>
          <p>별도의 가입 절차 없이 NoDo를 계속 사용할 수 있습니다.</p>
          <Link className={styles.primaryLink} to="/">NoDo 시작하기</Link>
        </section>
      </main>
    );
  }

  if (
    identityKind !== "invited-staff" ||
    !organizationInvitation ||
    !user
  ) {
    return (
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="unavailable-title">
          <AlertCircle className={styles.errorIcon} aria-hidden="true" />
          <h1 id="unavailable-title">사용할 수 있는 조직 초대가 없습니다</h1>
          <p>초대 상태를 다시 확인하거나 조직 관리자에게 문의해 주세요.</p>
          <button type="button" className={styles.secondaryButton} onClick={() => void handleLogout()}>
            <LogOut aria-hidden="true" /> 로그아웃
          </button>
        </section>
      </main>
    );
  }

  const unavailable = invitationExpired || failure === "UNAVAILABLE";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.logo} aria-label="NoDo"><span>NO</span><span>DO</span></span>
        <span>조직 가입</span>
      </header>
      <main className={styles.main}>
        <section className={styles.card} aria-labelledby="organization-invite-title">
          {unavailable ? (
            <>
              <AlertCircle className={styles.errorIcon} aria-hidden="true" />
              <p className={styles.eyebrow}>INVITATION UNAVAILABLE</p>
              <h1 id="organization-invite-title">초대가 만료되었거나 취소되었습니다</h1>
              <p>조직 관리자에게 새로운 초대를 요청해 주세요.</p>
            </>
          ) : failure === "ALREADY_JOINED" ? (
            <>
              <CheckCircle2 className={styles.successIcon} aria-hidden="true" />
              <p className={styles.eyebrow}>MEMBERSHIP CHECK</p>
              <h1 id="organization-invite-title">이미 처리된 조직 가입입니다</h1>
              <p>다시 로그인하면 현재 구성원 상태를 확인할 수 있습니다.</p>
            </>
          ) : (
            <>
              <div className={styles.buildingIcon}><Building2 aria-hidden="true" /></div>
              <p className={styles.eyebrow}>WELCOME TO {organizationInvitation.organizationName}</p>
              <h1 id="organization-invite-title">
                {organizationInvitation.organizationName} 조직에 초대되었습니다
              </h1>
              <p>가입을 선택하면 NoDo의 회사 직원 화면을 사용할 수 있습니다.</p>
              <dl className={styles.accountSummary}>
                <div><dt>로그인한 사용자</dt><dd>{user.displayName || "회사 직원"}</dd></div>
                <div><dt>회사 이메일</dt><dd>{user.email || "확인된 회사 계정"}</dd></div>
                <div><dt>초대 만료</dt><dd>{expirationLabel(organizationInvitation.expiresAt)}</dd></div>
              </dl>
            </>
          )}

          {failure === "NETWORK" ? (
            <p className={styles.inlineError} role="alert">
              <AlertCircle aria-hidden="true" /> 네트워크 연결을 확인한 뒤 다시 시도해 주세요.
            </p>
          ) : null}

          <div className={styles.actions}>
            {!unavailable && failure !== "ALREADY_JOINED" ? (
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void handleAccept()}
                disabled={isAccepting || isLoggingOut}
                aria-busy={isAccepting}
              >
                <CheckCircle2 aria-hidden="true" />
                {isAccepting ? "가입 처리 중..." : "조직 가입하기"}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void handleLogout()}
              disabled={isLoggingOut || isAccepting}
              aria-busy={isLoggingOut}
            >
              {failure === "ALREADY_JOINED" ? <UserRound aria-hidden="true" /> : <LogOut aria-hidden="true" />}
              {isLoggingOut ? "로그아웃 중..." : "로그아웃"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
