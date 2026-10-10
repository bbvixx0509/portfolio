import { LogIn, LogOut, UserRound } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { NoDoRuntimeMode } from "../../config/runtimeMode";
import { profileAccountLabel } from "./authTypes";
import { useAuth } from "./AuthContext";
import styles from "./AuthSessionBar.module.css";

export function shouldHideAuthSessionBar(
  runtimeMode: NoDoRuntimeMode,
  pathname: string,
) {
  const isTeachingRoom = /^\/rooms\/[^/]+\/(?:chat|checklist)$/.test(pathname);
  return (
    pathname === "/login" ||
    pathname === "/join-organization" ||
    pathname.startsWith("/join/") ||
    (runtimeMode === "cloud-auth" && pathname === "/") ||
    isTeachingRoom
  );
}

export function AuthSessionBar() {
  const {
    profile,
    isLoading,
    isBootstrappingOrganization,
    logout,
    runtimeMode,
  } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  if (shouldHideAuthSessionBar(runtimeMode, location.pathname)) {
    return null;
  }

  if (isLoading) {
    return (
      <div className={styles.sessionBar} role="status">
        {isBootstrappingOrganization
          ? "조직 설정 중..."
          : runtimeMode === "cloud-auth"
            ? "Google 인증 확인 중"
            : "로컬 인증 확인 중"}
      </div>
    );
  }

  if (!profile) {
    return (
      <Link className={styles.loginLink} to="/login">
        <LogIn aria-hidden="true" size={16} /> 직원 로그인
      </Link>
    );
  }

  return (
    <div className={styles.sessionBar} aria-label="현재 사용자">
      {profile.photoURL ? (
        <img
          className={styles.avatar}
          src={profile.photoURL}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : <UserRound aria-hidden="true" size={17} />}
      <span>
        <strong>{profile.displayName}</strong>
        {profileAccountLabel(profile)}
      </span>
      <button
        type="button"
        onClick={() => void logout().then(() => {
          if (runtimeMode === "cloud-auth") navigate("/login", { replace: true });
        })}
      >
        <LogOut aria-hidden="true" size={15} /> 로그아웃
      </button>
    </div>
  );
}
