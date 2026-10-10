import { ArrowRight, Dices, PencilLine, UserRoundPlus } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../features/auth/AuthContext";
import { validateNickname } from "../features/auth/authTypes";
import styles from "./LocalAuthPage.module.css";

const adjectives = ["용감한", "차분한", "반짝이는", "호기심 많은", "든든한"];
const animals = ["수달", "여우", "토끼", "고래", "판다"];

export function createRandomNickname(random = Math.random) {
  const adjective = adjectives[Math.floor(random() * adjectives.length)] ?? adjectives[0];
  const animal = animals[Math.floor(random() * animals.length)] ?? animals[0];
  return `${adjective} ${animal}`;
}

export function JoinRoomPage() {
  const navigate = useNavigate();
  const { roomCode = "" } = useParams();
  const { joinRoom, isLoading } = useAuth();
  const initialNickname = useMemo(() => createRandomNickname(), []);
  const [nickname, setNickname] = useState(initialNickname);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateNickname(nickname);
    if (!validation.valid) {
      setError(validation.message);
      return;
    }
    setError(null);
    try {
      const result = await joinRoom(roomCode.trim().toUpperCase(), validation.nickname);
      navigate(`/rooms/${result.roomId}/checklist`, { replace: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "강의방에 입장하지 못했습니다.");
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" aria-label="NoDo 시작 화면"><span>NO</span><span>DO</span></Link>
        <span>익명 수강생 입장</span>
      </header>
      <main className={`${styles.layout} ${styles.joinLayout}`}>
        <section className={styles.intro}>
          <p>JOIN CLASS · {roomCode || "참여 코드"}</p>
          <h1>내 정보를 공개하지 않고<br /><span>수업 흐름</span>을 함께 봐요</h1>
          <p>입장 뒤에도 익명 별명을 바꿀 수 있고, 로드맵은 읽기 전용입니다.</p>
        </section>
        <section className={styles.card} aria-labelledby="join-title">
          <div><UserRoundPlus aria-hidden="true" /><h2 id="join-title">강의방 입장</h2></div>
          <form onSubmit={handleSubmit}>
            <label>참여 코드
              <input value={roomCode.toUpperCase()} readOnly aria-readonly="true" />
            </label>
            <label>익명 별명
              <span className={styles.nicknameField}>
                <PencilLine aria-hidden="true" size={17} />
                <input
                  value={nickname}
                  maxLength={20}
                  onChange={(event) => setNickname(event.target.value)}
                  required
                />
              </span>
            </label>
            <button
              className={styles.shuffle}
              type="button"
              onClick={() => setNickname(createRandomNickname())}
            ><Dices aria-hidden="true" size={17} /> 다른 별명 추천</button>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <button className={styles.submit} type="submit" disabled={isLoading}>
              {isLoading ? "익명 인증 중" : "수강생으로 입장"}
              <ArrowRight aria-hidden="true" size={18} />
            </button>
          </form>
          <p className={styles.joinHelp}>직원인가요? <Link to="/login">직원 로그인</Link></p>
        </section>
      </main>
    </div>
  );
}
