import { LogOut, UsersRound } from "lucide-react";
import { Link } from "react-router-dom";
import styles from "./StartHeader.module.css";

export type StartHeaderUser = Readonly<{
  name: string;
  avatarLabel: string;
  source: "mock" | "cloud";
  roleLabel?: string;
  photoURL?: string | null;
}>;

type StartHeaderProps = {
  user: StartHeaderUser;
  organizationManagementTo?: string;
  onLogout?: () => void;
  isLoggingOut?: boolean;
};

export function StartHeader({
  user,
  organizationManagementTo,
  onLogout,
  isLoggingOut = false,
}: StartHeaderProps) {
  const userLabel = user.roleLabel
    ? `현재 사용자: ${user.name}, ${user.roleLabel}`
    : `mock 사용자 정보: ${user.name} 강사님, 안녕하세요`;

  return (
    <header className={styles.header}>
      <div className={styles.brandGroup}>
        <Link className={styles.logo} to="/" aria-label="NoDo">
          <span className={styles.logoMark} aria-hidden="true">
            <span>NO</span>
            <span>DO</span>
          </span>
        </Link>
        <span className={styles.contextLabel}>새 강의 만들기</span>
      </div>

      <div className={styles.accountActions}>
        <div
          className={styles.user}
          role="group"
          aria-label={userLabel}
          data-user-source={user.source}
        >
          {user.photoURL ? (
            <img
              className={styles.avatarImage}
              src={user.photoURL}
              alt=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className={styles.avatar} aria-hidden="true">
              {user.avatarLabel}
            </span>
          )}
          <span className={styles.greeting}>
            <strong>{user.name}</strong>
            {user.roleLabel ? <span className={styles.role}>{user.roleLabel}</span> : " 강사님, 안녕하세요"}
          </span>
        </div>
        {organizationManagementTo ? (
          <Link
            className={styles.organizationLink}
            to={organizationManagementTo}
            aria-label="조직 구성원 관리"
          >
            <UsersRound aria-hidden="true" size={16} />
            <span>구성원 관리</span>
          </Link>
        ) : null}
        {onLogout ? (
          <button
            className={styles.logoutButton}
            type="button"
            onClick={onLogout}
            disabled={isLoggingOut}
          >
            <LogOut aria-hidden="true" size={16} />
            {isLoggingOut ? "로그아웃 중..." : "로그아웃"}
          </button>
        ) : null}
      </div>
    </header>
  );
}
