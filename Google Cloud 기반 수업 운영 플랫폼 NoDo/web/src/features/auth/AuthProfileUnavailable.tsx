import { Link } from "react-router-dom";

export function AuthProfileUnavailable({ message }: { message?: string | null }) {
  return (
    <main
      style={{
        display: "grid",
        placeItems: "center",
        alignContent: "center",
        gap: 12,
        minHeight: "100vh",
        padding: 24,
        background: "#f5f6fa",
        textAlign: "center",
      }}
    >
      <h1>사용자 역할을 확인할 수 없습니다</h1>
      <p role="alert">{message ?? "로컬 seed와 FastAPI 연결 상태를 확인해 주세요."}</p>
      <Link to="/login">로그인 화면으로 이동</Link>
    </main>
  );
}
