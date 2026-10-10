import {
  CheckCircle2,
  DoorOpen,
  LogOut,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../features/auth/AuthContext";
import {
  createRandomStudentNickname,
  studentNicknameLength,
  validateStudentNickname,
  validateStudentRoomCode,
} from "../features/auth/studentAuth";
import styles from "./StudentEntryPage.module.css";

export function StudentEntryPage() {
  const { roomCode: routeRoomCode = "" } = useParams();
  const {
    identityKind,
    studentSession,
    isLoading,
    startStudentSession,
    endStudentSession,
    logout,
  } = useAuth();
  const [nickname, setNickname] = useState(createRandomStudentNickname);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const isComposingRef = useRef(false);
  const submitInProgressRef = useRef(false);

  const nicknameValidation = useMemo(
    () => validateStudentNickname(nickname),
    [nickname],
  );
  const roomCodeValidation = useMemo(
    () => validateStudentRoomCode(routeRoomCode),
    [routeRoomCode],
  );
  const nicknameLength = studentNicknameLength(nickname);
  const visibleRoomCode = roomCodeValidation.valid
    ? roomCodeValidation.roomCode
    : "확인 필요";
  const isSessionForCurrentRoute = Boolean(
    studentSession &&
    roomCodeValidation.valid &&
    studentSession.roomCode === roomCodeValidation.roomCode,
  );
  const isFormVisible =
    !studentSession && (identityKind === "signed-out" || isSubmitting);
  const isFormValid = nicknameValidation.valid && roomCodeValidation.valid;
  const isBusy = isSubmitting || (isLoading && isFormVisible);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isComposingRef.current || submitInProgressRef.current || !isFormValid) {
      return;
    }

    submitInProgressRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await startStudentSession(
        roomCodeValidation.valid ? roomCodeValidation.roomCode : routeRoomCode,
        nicknameValidation.valid ? nicknameValidation.nickname : nickname,
      );
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "참여를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      submitInProgressRef.current = false;
      setIsSubmitting(false);
    }
  }

  function handleNicknameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.nativeEvent.isComposing || isComposingRef.current || event.keyCode === 229) {
      return;
    }
    event.currentTarget.form?.requestSubmit();
  }

  async function handleStudentExit() {
    if (isEnding) return;
    setIsEnding(true);
    setSubmitError(null);
    try {
      await endStudentSession();
      setNickname(createRandomStudentNickname());
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "학생 참여를 종료하지 못했습니다. 다시 시도해 주세요.",
      );
    } finally {
      setIsEnding(false);
    }
  }

  async function handleStaffLogout() {
    if (isEnding) return;
    setIsEnding(true);
    setSubmitError(null);
    try {
      await logout();
      setNickname(createRandomStudentNickname());
    } catch {
      setSubmitError("로그아웃하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setIsEnding(false);
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.logo} aria-label="NoDo">
          <span>NO</span><span>DO</span>
        </div>
        <span>강의 참여</span>
      </header>

      <main className={styles.main}>
        {identityKind === "loading" && !isSubmitting ? (
          <section className={styles.statusCard} aria-live="polite">
            <DoorOpen aria-hidden="true" />
            <h1>참여 상태를 확인하고 있어요</h1>
            <p>잠시만 기다려 주세요.</p>
          </section>
        ) : null}

        {identityKind === "staff" || identityKind === "invited-staff" ? (
          <section className={styles.statusCard} aria-labelledby="staff-conflict-title">
            <ShieldAlert aria-hidden="true" />
            <h1 id="staff-conflict-title">학생 참여를 시작할 수 없어요</h1>
            <p>
              현재 강사 계정으로 로그인되어 있습니다.<br />
              학생으로 참여하려면 강사 계정에서 먼저 로그아웃해 주세요.
            </p>
            {submitError ? <p className={styles.error} role="alert">{submitError}</p> : null}
            <button type="button" onClick={() => void handleStaffLogout()} disabled={isEnding} aria-busy={isEnding}>
              <LogOut aria-hidden="true" />
              {isEnding ? "로그아웃 중..." : "강사 계정에서 로그아웃"}
            </button>
          </section>
        ) : null}

        {identityKind === "unsupported" ? (
          <section className={styles.statusCard} aria-labelledby="unsupported-title">
            <ShieldAlert aria-hidden="true" />
            <h1 id="unsupported-title">현재 로그인 상태를 확인해 주세요</h1>
            <p>이 상태에서는 학생 참여를 시작할 수 없습니다.</p>
            {submitError ? <p className={styles.error} role="alert">{submitError}</p> : null}
            <button type="button" onClick={() => void handleStaffLogout()} disabled={isEnding} aria-busy={isEnding}>
              <LogOut aria-hidden="true" />
              {isEnding ? "종료 중..." : "현재 상태 종료"}
            </button>
          </section>
        ) : null}

        {identityKind === "student" && studentSession && isSessionForCurrentRoute ? (
          <section className={styles.statusCard} aria-labelledby="ready-title">
            <CheckCircle2 className={styles.successIcon} aria-hidden="true" />
            <p className={styles.eyebrow}>참여 코드 {studentSession.roomCode}</p>
            <h1 id="ready-title">참여 준비가 완료되었습니다.</h1>
            <dl className={styles.summary}>
              <div><dt>참여 이름</dt><dd>{studentSession.nickname}</dd></div>
              <div><dt>참여 코드</dt><dd>{studentSession.roomCode}</dd></div>
            </dl>
            <p>실제 강의방 데이터 연결은 이후 단계에서 제공됩니다.</p>
            {submitError ? <p className={styles.error} role="alert">{submitError}</p> : null}
            <button type="button" onClick={() => void handleStudentExit()} disabled={isEnding} aria-busy={isEnding}>
              <LogOut aria-hidden="true" />
              {isEnding ? "종료 중..." : "학생 참여 종료"}
            </button>
          </section>
        ) : null}

        {identityKind === "student" && studentSession && !isSessionForCurrentRoute ? (
          <section className={styles.statusCard} aria-labelledby="different-room-title">
            <ShieldAlert aria-hidden="true" />
            <h1 id="different-room-title">현재 다른 참여를 준비하고 있습니다.</h1>
            <p>새 참여 코드로 시작하려면 현재 학생 참여를 먼저 종료해 주세요.</p>
            {submitError ? <p className={styles.error} role="alert">{submitError}</p> : null}
            <button type="button" onClick={() => void handleStudentExit()} disabled={isEnding} aria-busy={isEnding}>
              <LogOut aria-hidden="true" />
              {isEnding ? "종료 중..." : "학생 참여 종료"}
            </button>
          </section>
        ) : null}

        {identityKind === "student" && !studentSession && !isSubmitting ? (
          <section className={styles.statusCard} aria-labelledby="student-conflict-title">
            <ShieldAlert aria-hidden="true" />
            <h1 id="student-conflict-title">현재 학생으로 참여 중입니다.</h1>
            <p>새로 참여하려면 현재 학생 참여를 먼저 종료해 주세요.</p>
            {submitError ? <p className={styles.error} role="alert">{submitError}</p> : null}
            <button type="button" onClick={() => void handleStudentExit()} disabled={isEnding} aria-busy={isEnding}>
              <LogOut aria-hidden="true" />
              {isEnding ? "종료 중..." : "학생 참여 종료"}
            </button>
          </section>
        ) : null}

        {isFormVisible ? (
          <section className={styles.entryCard} aria-labelledby="entry-title">
            <div className={styles.iconBadge}><UserRound aria-hidden="true" /></div>
            <p className={styles.eyebrow}>참여 코드 {visibleRoomCode}</p>
            <h1 id="entry-title">강의에 참여할 이름을 확인해 주세요</h1>
            <p className={styles.description}>
              수업에서 사용할 별명입니다. 참여하기 전에 수정할 수 있어요.
            </p>

            <form onSubmit={handleSubmit} noValidate>
              <label htmlFor="student-nickname">참여 이름</label>
              <input
                id="student-nickname"
                value={nickname}
                onChange={(event) => {
                  setNickname(event.target.value);
                  setSubmitError(null);
                }}
                onCompositionStart={() => { isComposingRef.current = true; }}
                onCompositionEnd={() => { isComposingRef.current = false; }}
                onKeyDown={handleNicknameKeyDown}
                aria-invalid={!nicknameValidation.valid}
                aria-describedby="nickname-help nickname-count nickname-error"
                autoComplete="nickname"
                autoFocus
                readOnly={isBusy}
              />
              <div className={styles.inputMeta}>
                <span id="nickname-help">2~16자로 입력해 주세요.</span>
                <span
                  id="nickname-count"
                  className={nicknameLength > 16 ? styles.countError : undefined}
                >{nicknameLength}/16</span>
              </div>
              <div className={styles.messageSlot} id="nickname-error">
                {!nicknameValidation.valid ? (
                  <p className={styles.error} role="alert">{nicknameValidation.message}</p>
                ) : !roomCodeValidation.valid ? (
                  <p className={styles.error} role="alert">{roomCodeValidation.message}</p>
                ) : submitError ? (
                  <p className={styles.error} role="alert">{submitError}</p>
                ) : (
                  <p className={styles.readyMessage}>참여 이름을 자유롭게 수정할 수 있어요.</p>
                )}
              </div>
              <button type="submit" disabled={!isFormValid || isBusy} aria-busy={isBusy}>
                {isBusy ? "참여 중..." : "참여하기"}
              </button>
              <span className={styles.srOnly} aria-live="polite">
                {isBusy ? "참여 요청을 처리하고 있습니다." : ""}
              </span>
            </form>
          </section>
        ) : null}
      </main>
    </div>
  );
}
