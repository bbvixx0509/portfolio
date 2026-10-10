import {
  browserSessionPersistence,
  setPersistence,
  signInAnonymously,
  type User,
} from "firebase/auth";
import { CheckCircle2, DoorOpen, ShieldAlert, UserRound } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../../lib/api/apiClient";
import { getFirebaseAuth } from "../../lib/firebase/firebaseAuth";
import { useAuth } from "../auth/AuthContext";
import {
  joinPublicRoom,
  loadPublicRoom,
  loadStudentParticipantSession,
  type PublicRoom,
  type StudentParticipantSession,
} from "./cloudStudentApi";
import {
  createRandomParticipantNickname,
  participantNicknameLength,
  validateParticipantNickname,
} from "./participantNickname";
import styles from "./CloudStudentEntryPage.module.css";

const UNAVAILABLE_MESSAGE = "현재 이 강의방에 참여할 수 없습니다.";
const STAFF_MESSAGE = "학생 참여는 별도의 브라우저 또는 기기에서 진행해 주세요.";
const CAPACITY_FULL_MESSAGE = "현재 참여 인원이 가득 찼습니다.";

function participantErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 409) return error.message;
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return UNAVAILABLE_MESSAGE;
    }
  }
  return "참여를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export function CloudStudentEntryPage() {
  const { orgId = "", roomCode = "" } = useParams();
  const { identityKind, user } = useAuth();
  const navigate = useNavigate();
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [session, setSession] = useState<StudentParticipantSession | null>(null);
  const [nickname, setNickname] = useState(createRandomParticipantNickname);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isComposingRef = useRef(false);
  const submitInProgressRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const nicknameValidation = useMemo(
    () => validateParticipantNickname(nickname),
    [nickname],
  );
  const nicknameLength = participantNicknameLength(nickname);
  const isStaff = identityKind === "staff" || identityKind === "invited-staff";

  useEffect(() => {
    let active = true;
    setRoom(null);
    setSession(null);
    setLoadError(null);
    void loadPublicRoom(orgId, roomCode)
      .then((nextRoom) => {
        if (active) setRoom(nextRoom);
      })
      .catch(() => {
        if (active) setLoadError(UNAVAILABLE_MESSAGE);
      });
    return () => { active = false; };
  }, [orgId, roomCode]);

  useEffect(() => {
    if (!room || !user?.isAnonymous) return;
    let active = true;
    void loadStudentParticipantSession(user, orgId, roomCode)
      .then((nextSession) => {
        if (!active) return;
        setNickname(nextSession.nickname);
        setSession(nextSession);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [orgId, room, roomCode, user]);

  useEffect(() => {
    if (!session || isStaff) return;
    navigate(
      `/join/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}/checklist`,
      { replace: true },
    );
  }, [isStaff, navigate, orgId, roomCode, session]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      isComposingRef.current ||
      submitInProgressRef.current ||
      !nicknameValidation.valid ||
      !room ||
      isStaff
    ) return;

    submitInProgressRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const auth = getFirebaseAuth();
      const currentUser = auth.currentUser;
      if (currentUser && !currentUser.isAnonymous) {
        setSubmitError(STAFF_MESSAGE);
        return;
      }
      let anonymousUser: User;
      if (currentUser?.isAnonymous) {
        anonymousUser = currentUser;
      } else {
        await setPersistence(auth, browserSessionPersistence);
        anonymousUser = (await signInAnonymously(auth)).user;
      }
      const nextSession = await joinPublicRoom(
        anonymousUser,
        orgId,
        roomCode,
        nicknameValidation.nickname,
      );
      setSession(nextSession);
      setNickname(nextSession.nickname);
    } catch (error) {
      setSubmitError(participantErrorMessage(error));
    } finally {
      submitInProgressRef.current = false;
      setIsSubmitting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.nativeEvent.isComposing || isComposingRef.current || event.keyCode === 229) return;
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        {loadError ? (
          <section className={styles.statusCard} aria-live="polite">
            <ShieldAlert aria-hidden="true" />
            <h1>{UNAVAILABLE_MESSAGE}</h1>
          </section>
        ) : null}
        {!loadError && !room ? (
          <section className={styles.statusCard} aria-live="polite">
            <DoorOpen aria-hidden="true" />
            <h1>강의방을 확인하고 있어요</h1>
            <p>잠시만 기다려 주세요.</p>
          </section>
        ) : null}
        {room && isStaff ? (
          <section className={styles.statusCard} aria-labelledby="staff-entry-title">
            <ShieldAlert aria-hidden="true" />
            <h1 id="staff-entry-title">학생 참여는 별도 환경에서 진행해 주세요</h1>
            <p>{STAFF_MESSAGE}</p>
          </section>
        ) : null}
        {room && !isStaff && session ? (
          <section className={styles.statusCard} aria-labelledby="waiting-title">
            <CheckCircle2 className={styles.successIcon} aria-hidden="true" />
            <p className={styles.eyebrow}>입장 완료</p>
            <h1 id="waiting-title">{session.roomTitle}</h1>
            <dl className={styles.summary}>
              <div><dt>별명</dt><dd>{session.nickname}</dd></div>
              <div><dt>상태</dt><dd>완료</dd></div>
            </dl>
            <p>강의 시작을 기다려 주세요.</p>
            <Link className={styles.questionLink} to={`/join/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}/questions`}>질문 보기</Link>
          </section>
        ) : null}
        {room && !isStaff && !session ? (
          <section className={styles.entryCard} aria-labelledby="entry-title">
            <div className={styles.iconBadge}><UserRound aria-hidden="true" /></div>
            <p className={styles.eyebrow}>강의방</p>
            <h1 id="entry-title">{room.title}</h1>
            <p className={styles.description}>수업에서 사용할 별명을 확인한 뒤 참여해 주세요.</p>
            <form ref={formRef} onSubmit={handleSubmit} noValidate>
              <label htmlFor="participant-nickname">별명</label>
              <input
                id="participant-nickname"
                value={nickname}
                onChange={(event) => { setNickname(event.target.value); setSubmitError(null); }}
                onCompositionStart={() => { isComposingRef.current = true; }}
                onCompositionEnd={() => { isComposingRef.current = false; }}
                onKeyDown={handleKeyDown}
                aria-invalid={!nicknameValidation.valid}
                aria-describedby="participant-nickname-help participant-nickname-count participant-nickname-error"
                autoComplete="nickname"
                autoFocus
                readOnly={isSubmitting}
              />
              <div className={styles.inputMeta}>
                <span id="participant-nickname-help">한글·영문·숫자·공백, 2~16자</span>
                <span id="participant-nickname-count" className={nicknameLength > 16 ? styles.countError : undefined}>{nicknameLength}/16</span>
              </div>
              <div className={styles.messageSlot} id="participant-nickname-error">
                {!nicknameValidation.valid ? <p className={styles.error} role="alert">{nicknameValidation.message}</p> : null}
                {nicknameValidation.valid && submitError ? <div className={styles.error} role="alert"><p>{submitError}</p>{submitError === CAPACITY_FULL_MESSAGE ? <button type="button" onClick={() => formRef.current?.requestSubmit()} disabled={isSubmitting}>다시 시도</button> : null}</div> : null}
                {nicknameValidation.valid && !submitError ? <p className={styles.readyMessage}>참여하기 전에 별명을 수정할 수 있어요.</p> : null}
              </div>
              <button type="submit" disabled={!nicknameValidation.valid || isSubmitting} aria-busy={isSubmitting}>
                {isSubmitting ? "참여 중..." : "참여하기"}
              </button>
            </form>
          </section>
        ) : null}
      </main>
    </div>
  );
}
