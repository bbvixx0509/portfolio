import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { lazy, type FormEvent, Suspense, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { isCloudAuthMode } from "../config/runtimeMode";
import { useAuth } from "../features/auth/AuthContext";
import { AuthDiagnosticsPanel } from "../features/auth/AuthDiagnosticsPanel";
import {
  clearCloudReturnPath,
  readCloudReturnPath,
} from "../features/auth/cloudAuthNavigation";
import cloudStyles from "./CloudLoginPage.module.css";
import styles from "./LocalAuthPage.module.css";

const LocalApiRecoveryNotice = import.meta.env.DEV
  ? lazy(() => import("./LocalApiRecoveryNotice").then((module) => ({
    default: module.LocalApiRecoveryNotice,
  })))
  : null;

export function LoginPage() {
  return isCloudAuthMode ? <CloudGoogleLoginPage /> : <EmulatorLoginPage />;
}

function EmulatorLoginPage() {
  const navigate = useNavigate();
  const { login, isLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const profile = await login(email.trim(), password);
      navigate(profile.accountType === "STUDENT" ? "/" : "/courses/import", {
        replace: true,
      });
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "로그인하지 못했습니다.",
      );
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" aria-label="NoDo 시작 화면">
          <span>NO</span><span>DO</span>
        </Link>
        <span>Firebase Emulator 전용</span>
      </header>
      <main className={styles.layout}>
        <section className={styles.intro}>
          <p>LOCAL SIGN IN · 01-3A</p>
          <h1>직원 계정으로<br /><span>NoDo 강의</span>를 관리해요</h1>
          <p>입력한 인증 정보는 로컬 Authentication Emulator에만 전달됩니다.</p>
          <div className={styles.securityNote}>
            <ShieldCheck aria-hidden="true" />
            실제 Google 로그인·회사 이메일·클라우드 프로젝트를 사용하지 않아요.
          </div>
        </section>
        <section className={styles.card} aria-labelledby="login-title">
          <div>
            <LockKeyhole aria-hidden="true" />
            <h2 id="login-title">직원 로그인</h2>
          </div>
          <form onSubmit={handleSubmit}>
            <label>이메일
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="회사 이메일"
                required
              />
            </label>
            <label>비밀번호
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="비밀번호"
                required
              />
            </label>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <button className={styles.submit} type="submit" disabled={isLoading}>
              {isLoading ? "로그인 확인 중" : "로그인"}
              <ArrowRight aria-hidden="true" size={18} />
            </button>
          </form>
          <p className={styles.joinHelp}>수강생인가요? <Link to="/join/NODO01">참여 코드로 입장</Link></p>
        </section>
      </main>
    </div>
  );
}

function CloudGoogleLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    profile,
    organizationInvitation,
    identityKind,
    isBootstrappingOrganization,
    isGoogleRedirecting,
    googleLoginRecoveryAvailable,
    localApiRecoveryAvailable,
    authDiagnostics,
    error: authError,
    loginWithGoogle,
    reconnectLocalApi,
    endStudentSession,
  } = useAuth();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isEndingStudent, setIsEndingStudent] = useState(false);
  const [isGoogleLoginSubmitting, setIsGoogleLoginSubmitting] = useState(false);
  const returnPath = readCloudReturnPath(location.state);

  useEffect(() => {
    if (identityKind === "invited-staff" && organizationInvitation) {
      navigate("/join-organization", { replace: true });
      return;
    }
    if (!profile) return;
    clearCloudReturnPath();
    navigate(returnPath, { replace: true });
  }, [identityKind, navigate, organizationInvitation, profile, returnPath]);

  async function handleGoogleLogin() {
    setSubmitError(null);
    setIsGoogleLoginSubmitting(true);
    try {
      await loginWithGoogle();
    } catch (nextError) {
      setSubmitError(
        nextError instanceof Error
          ? nextError.message
          : "Google 로그인을 시작하지 못했습니다.",
      );
    } finally {
      setIsGoogleLoginSubmitting(false);
    }
  }

  async function handleLocalApiReconnect() {
    setSubmitError(null);
    setIsGoogleLoginSubmitting(true);
    try {
      await reconnectLocalApi();
    } catch (nextError) {
      setSubmitError(
        nextError instanceof Error
          ? nextError.message
          : "연결을 다시 확인하지 못했습니다.",
      );
    } finally {
      setIsGoogleLoginSubmitting(false);
    }
  }

  const visibleError = submitError ?? authError;
  const isGoogleLoginBusy =
    isGoogleLoginSubmitting || isGoogleRedirecting || isBootstrappingOrganization;

  async function handleStudentExit() {
    setSubmitError(null);
    setIsEndingStudent(true);
    try {
      await endStudentSession();
    } catch {
      setSubmitError("학생 참여를 종료하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setIsEndingStudent(false);
    }
  }

  if (identityKind === "student") {
    return (
      <div className={cloudStyles.page}>
        <header className={cloudStyles.header}>
          <Link to="/login" aria-label="NoDo 강사 로그인">
            <span>NO</span><span>DO</span>
          </Link>
          <span>강사 로그인</span>
        </header>
        <main className={cloudStyles.layout}>
          <section className={cloudStyles.intro}>
            <p>NODO STAFF</p>
            <h1>학생 참여를 종료한 뒤<br /><span>강사 화면</span>을 시작하세요</h1>
          </section>
          <section className={cloudStyles.card} aria-labelledby="student-login-conflict">
            <div className={cloudStyles.cardTitle}>
              <LockKeyhole aria-hidden="true" />
              <div><p>SESSION CHECK</p><h2 id="student-login-conflict">강사 로그인을 시작할 수 없습니다</h2></div>
            </div>
            <p className={cloudStyles.description}>
              현재 학생으로 참여 중입니다.<br />
              강사로 로그인하려면 학생 참여를 먼저 종료해 주세요.
            </p>
            {visibleError ? <p className={cloudStyles.error} role="alert">{visibleError}</p> : null}
            <button
              className={cloudStyles.googleButton}
              type="button"
              onClick={() => void handleStudentExit()}
              disabled={isEndingStudent}
            >
              {isEndingStudent ? "종료 중..." : "학생 참여 종료"}
            </button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className={cloudStyles.page}>
      <header className={cloudStyles.header}>
        <Link to="/login" aria-label="NoDo Google 로그인">
          <span>NO</span><span>DO</span>
        </Link>
        <span>02 · Google Authentication</span>
      </header>
      <main className={cloudStyles.layout}>
        <section className={cloudStyles.intro}>
          <p>SECURE SIGN IN · 02-1</p>
          <h1>회사 Google 계정으로<br /><span>NoDo</span>를 시작하세요</h1>
          <p>
            로그인 후 NoDo가 DEMO 조직 구성원 또는 초대 여부를 안전하게 확인합니다.
          </p>
          <div className={cloudStyles.securityNote}>
            <ShieldCheck aria-hidden="true" />
            등록된 회사 직원과 초대받은 직원만 보호 화면에 접근할 수 있습니다.
          </div>
        </section>
        <section className={cloudStyles.card} aria-labelledby="google-login-title">
          <div className={cloudStyles.cardTitle}>
            <LockKeyhole aria-hidden="true" />
            <div>
              <p>NODO ACCOUNT</p>
              <h2 id="google-login-title">Google 로그인</h2>
            </div>
          </div>
          <p className={cloudStyles.description}>
            계정 선택 창에서 NoDo 사용이 승인된 회사 계정을 선택해 주세요.
          </p>
          {LocalApiRecoveryNotice && localApiRecoveryAvailable ? (
            <Suspense fallback={null}>
              <LocalApiRecoveryNotice
                disabled={isGoogleLoginBusy}
                onReconnect={() => void handleLocalApiReconnect()}
              />
            </Suspense>
          ) : visibleError ? (
            <p className={cloudStyles.error} role="alert" aria-live="assertive">{visibleError}</p>
          ) : null}
          <button
            className={cloudStyles.googleButton}
            type="button"
            onClick={() => void handleGoogleLogin()}
            disabled={isGoogleLoginBusy}
            aria-busy={isGoogleLoginBusy}
          >
            <span className={cloudStyles.googleMark} aria-hidden="true">G</span>
            {isBootstrappingOrganization
              ? "조직 설정 중..."
              : isGoogleRedirecting
                ? "Google 로그인 확인 중"
                : isGoogleLoginSubmitting
                  ? "Google 로그인 진행 중"
                : "Google로 시작하기"}
          </button>
          {isGoogleLoginBusy ? (
            <p className={cloudStyles.processing} role="status" aria-live="polite">
              {isGoogleRedirecting
                ? "Google 로그인 결과를 확인하고 있습니다."
                : isBootstrappingOrganization
                  ? "조직 설정을 확인하고 있습니다."
                  : "Google 로그인 창에서 회사 계정을 선택해 주세요."}
            </p>
          ) : null}
          {!localApiRecoveryAvailable && !isGoogleLoginBusy && googleLoginRecoveryAvailable ? (
            <div className={cloudStyles.recoveryActions} aria-label="Google 로그인 복구 동작">
              <button
                className={cloudStyles.secondaryButton}
                type="button"
                onClick={() => void handleGoogleLogin()}
              >
                다시 시도
              </button>
            </div>
          ) : null}
          <p className={cloudStyles.notice}>
            조직 권한은 FastAPI를 통해 확인하며 브라우저는 Firestore에 직접 연결하지 않습니다.
          </p>
          <AuthDiagnosticsPanel diagnostics={authDiagnostics} />
        </section>
      </main>
    </div>
  );
}
