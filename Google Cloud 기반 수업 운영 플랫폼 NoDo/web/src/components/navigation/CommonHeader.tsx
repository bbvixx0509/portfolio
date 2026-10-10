import { ChevronLeft, UserRound, UsersRound } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import nodoMark from "../../assets/nodo-mark.png";
import { profileAccountLabel } from "../../features/auth/authTypes";
import { useAuth } from "../../features/auth/AuthContext";
import styles from "./CommonHeader.module.css";

type CommonHeaderProps = {
  context?: string;
  variant?: "staff" | "student";
  homeTo?: string;
  homeLabel?: string;
  action?: ReactNode;
};

const CONTEXT_BY_PATH: Array<readonly [RegExp, string]> = [
  [/^\/$/, "시작 화면"],
  [/^\/courses\/import/, "기존 목록 불러오기"],
  [/^\/create\/material/, "강의 자료 선택"],
  [/^\/material-course-drafts\//, "수업 흐름 편집"],
  [/^\/create\/manual|^\/courses\/[^/]+\/(?:edit|prepare)/, "수업 흐름 편집"],
  [/^\/courses\/[^/]+\/rooms\/new/, "강의방 준비"],
  [/^\/rooms$/, "강의방 목록"],
  [/^\/rooms\/[^/]+\/prepare/, "강의방 준비"],
  [/^\/rooms\/[^/]+\/(?:checklist|chat|material)/, "강의 운영"],
  [/^\/rooms\/[^/]+\/summary/, "수업 종료 요약"],
  [/^\/organization\/members/, "구성원 관리"],
  [/^\/organization\/storage/, "자료 용량 관리"],
  [/^\/join\//, "학생 강의"],
];

export function commonHeaderContext(pathname: string) {
  return CONTEXT_BY_PATH.find(([pattern]) => pattern.test(pathname))?.[1] ?? "NoDo";
}

export function CommonHeader({
  context,
  variant = "staff",
  homeTo = "/",
  homeLabel = "시작 화면으로",
  action,
}: CommonHeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { profile, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const label = context ?? commonHeaderContext(location.pathname);
  const showHome = variant === "staff" && location.pathname !== "/";

  async function signOut() {
    setIsLoggingOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <header className={styles.header} data-testid="common-header">
      <div className={styles.leading}>
        <Link className={styles.logo} to={homeTo} aria-label={variant === "student" ? homeLabel : "NoDo 시작 화면"}>
          <img src={nodoMark} alt="NoDo" />
        </Link>
        <span className={styles.context} title={label}>{label}</span>
      </div>

      <div className={styles.actions}>
        {variant === "staff" && profile ? (
          <div className={styles.account} role="group" aria-label={`현재 사용자: ${profile.displayName}, ${profileAccountLabel(profile)}`}>
            {profile.photoURL ? <img src={profile.photoURL} alt="" referrerPolicy="no-referrer" /> : <UserRound aria-hidden="true" size={15} />}
            <span><strong>{profile.displayName}</strong><small>{profileAccountLabel(profile)}</small></span>
            <button type="button" onClick={() => void signOut()} disabled={isLoggingOut}>{isLoggingOut ? "로그아웃 중" : "로그아웃"}</button>
          </div>
        ) : null}
        {variant === "staff" && profile?.organizationRole === "ADMIN" && location.pathname !== "/organization/members" ? <Link className={styles.homeLink} to="/organization/members" aria-label="조직 구성원 관리"><UsersRound aria-hidden="true" size={15} />구성원 관리</Link> : null}
        {showHome ? <Link className={styles.homeLink} to="/"><ChevronLeft aria-hidden="true" size={15} />시작 화면으로</Link> : null}
        {action ? <div className={styles.extraAction}>{action}</div> : null}
      </div>
    </header>
  );
}
