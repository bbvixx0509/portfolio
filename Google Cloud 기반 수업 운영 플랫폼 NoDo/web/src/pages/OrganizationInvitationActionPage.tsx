import {
  AlertCircle,
  CheckCircle2,
  LogIn,
  MailCheck,
  MailX,
} from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../features/auth/AuthContext";
import { respondToStaffInvitation } from "../features/organization/organizationApi";
import { ApiError } from "../lib/api/apiClient";
import styles from "./OrganizationInvitationActionPage.module.css";

type InvitationAction = "accept" | "decline";
type ActionFailure =
  | "EMAIL_MISMATCH"
  | "EXPIRED"
  | "REVOKED"
  | "ALREADY_PROCESSED"
  | "INVALID"
  | "NETWORK";

function errorCode(error: ApiError) {
  if (!error.details || typeof error.details !== "object" || Array.isArray(error.details)) {
    return null;
  }
  const details = error.details as Record<string, unknown>;
  if (typeof details.code === "string") return details.code;
  if (details.detail && typeof details.detail === "object" && !Array.isArray(details.detail)) {
    const nestedCode = (details.detail as Record<string, unknown>).code;
    return typeof nestedCode === "string" ? nestedCode : null;
  }
  return null;
}

export function invitationActionFailure(error: unknown): ActionFailure {
  if (!(error instanceof ApiError)) return "NETWORK";
  const code = errorCode(error)?.toLocaleLowerCase("en-US") ?? "";
  if (code.includes("email") && code.includes("mismatch")) return "EMAIL_MISMATCH";
  if (code.includes("expired") || error.status === 410) return "EXPIRED";
  if (code.includes("revoked")) return "REVOKED";
  if (
    code.includes("already")
    || code.includes("processed")
    || error.status === 409
  ) return "ALREADY_PROCESSED";
  if (code.includes("invalid") || error.status === 403 || error.status === 404) {
    return "INVALID";
  }
  return "NETWORK";
}

function failureMessage(failure: ActionFailure) {
  if (failure === "EMAIL_MISMATCH") {
    return "로그인한 이메일이 초대받은 이메일과 일치하지 않습니다. 초대받은 계정으로 다시 로그인해 주세요.";
  }
  if (failure === "EXPIRED") {
    return "초대가 만료되었습니다. 조직 관리자에게 새로운 초대를 요청해 주세요.";
  }
  if (failure === "REVOKED") {
    return "취소된 초대입니다. 조직 관리자에게 새로운 초대를 요청해 주세요.";
  }
  if (failure === "ALREADY_PROCESSED") {
    return "이미 수락하거나 거절한 초대입니다.";
  }
  if (failure === "INVALID") {
    return "유효하지 않은 초대 링크입니다.";
  }
  return "초대 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export function OrganizationInvitationActionPage({
  action,
}: {
  action: InvitationAction;
}) {
  const { rawToken = "" } = useParams();
  const navigate = useNavigate();
  const {
    user,
    identityKind,
    isLoading,
    loginWithGoogle,
    logout,
    refreshProfile,
  } = useAuth();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const isSignedIn = Boolean(user && user.isAnonymous !== true);
  const isAccept = action === "accept";

  async function handleLogin() {
    if (isSigningIn) return;
    setFailure(null);
    setIsSigningIn(true);
    try {
      await loginWithGoogle();
    } catch {
      setFailure("NETWORK");
    } finally {
      setIsSigningIn(false);
    }
  }

  async function handleAction() {
    if (!user || user.isAnonymous || isSubmitting || !rawToken) return;
    setFailure(null);
    setIsSubmitting(true);
    try {
      const invitation = await respondToStaffInvitation(user, rawToken, action);
      if (isAccept) {
        if (invitation.status !== "ACCEPTED") throw new Error("unexpected invitation status");
        const refreshedProfile = await refreshProfile();
        if (!refreshedProfile) throw new Error("profile refresh failed");
        navigate("/", { replace: true });
      } else {
        if (invitation.status !== "DECLINED") throw new Error("unexpected invitation status");
        navigate("/organization/invitations/declined", { replace: true });
      }
    } catch (error) {
      setFailure(invitationActionFailure(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleChangeAccount() {
    if (isSigningIn) return;
    setIsSigningIn(true);
    try {
      await logout();
      setFailure(null);
    } catch {
      setFailure("NETWORK");
    } finally {
      setIsSigningIn(false);
    }
  }

  if (isLoading || identityKind === "loading") {
    return (
      <main className={styles.page}>
        <section className={styles.card} role="status">
          <MailCheck className={styles.statusIcon} aria-hidden="true" />
          <h1>초대 로그인 상태를 확인하고 있습니다</h1>
        </section>
      </main>
    );
  }

  const terminalFailure = failure && failure !== "NETWORK";
  const Icon = isAccept ? MailCheck : MailX;

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="invitation-action-title">
        <Icon className={styles.actionIcon} aria-hidden="true" />
        <p className={styles.eyebrow}>NODO ORGANIZATION</p>
        <h1 id="invitation-action-title">
          {isAccept ? "조직 초대를 수락할까요?" : "조직 초대를 거절할까요?"}
        </h1>
        <p>
          {isAccept
            ? "초대받은 회사 Google 계정으로 로그인한 뒤 조직에 참여할 수 있습니다."
            : "초대받은 회사 Google 계정으로 로그인한 뒤 초대를 거절할 수 있습니다."}
        </p>

        {failure ? (
          <p className={styles.error} role="alert">
            <AlertCircle aria-hidden="true" />
            {failureMessage(failure)}
          </p>
        ) : null}

        <div className={styles.actions}>
          {failure === "EMAIL_MISMATCH" ? (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void handleChangeAccount()}
              disabled={isSigningIn}
            >
              <LogIn aria-hidden="true" />
              {isSigningIn ? "로그아웃 중..." : "다른 Google 계정으로 로그인"}
            </button>
          ) : !isSignedIn ? (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void handleLogin()}
              disabled={isSigningIn}
            >
              <LogIn aria-hidden="true" />
              {isSigningIn ? "Google 로그인 중..." : "Google 계정으로 로그인"}
            </button>
          ) : !terminalFailure ? (
            <button
              type="button"
              className={isAccept ? styles.primaryButton : styles.dangerButton}
              onClick={() => void handleAction()}
              disabled={isSubmitting}
            >
              <Icon aria-hidden="true" />
              {isSubmitting
                ? "처리 중..."
                : isAccept
                  ? "초대 수락"
                  : "초대 거절"}
            </button>
          ) : null}
          <Link className={styles.secondaryLink} to="/login">취소</Link>
        </div>
      </section>
    </main>
  );
}

export function OrganizationInvitationDeclinedPage() {
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="invitation-declined-title">
        <CheckCircle2 className={styles.successIcon} aria-hidden="true" />
        <p className={styles.eyebrow}>INVITATION DECLINED</p>
        <h1 id="invitation-declined-title">초대를 거절했습니다</h1>
        <p>조직 멤버십은 생성되지 않았습니다.</p>
        <Link className={styles.secondaryLink} to="/login">NoDo 로그인으로</Link>
      </section>
    </main>
  );
}
