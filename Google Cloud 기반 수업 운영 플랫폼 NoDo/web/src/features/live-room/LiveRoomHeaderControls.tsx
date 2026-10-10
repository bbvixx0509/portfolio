import { Copy, LogOut, Share2, UserRound } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { profileAccountLabel } from "../auth/authTypes";
import { useAuth } from "../auth/AuthContext";
import {
  cloudRoomShareLink,
  copyCloudRoomValue,
  getCloudRoomShare,
  type CloudRoomShare,
} from "../cloud-rooms/roomApi";
import styles from "./LiveRoomHeaderControls.module.css";

type LiveRoomShareControlProps = {
  roomId: string;
  roomCode?: string;
  message?: string;
};

type LiveRoomAccountControlProps = {
  roomRole?: "LEAD_INSTRUCTOR" | "ASSISTANT";
};

function accountRoleLabel(roomRole: LiveRoomAccountControlProps["roomRole"], profile: Parameters<typeof profileAccountLabel>[0]) {
  if (roomRole === "LEAD_INSTRUCTOR") return "주 강사";
  if (roomRole === "ASSISTANT") return "보조 강사";
  return profileAccountLabel(profile);
}

export function LiveRoomAccountControl({ roomRole }: LiveRoomAccountControlProps) {
  const { profile, logout, runtimeMode } = useAuth();
  const navigate = useNavigate();

  if (!profile) return null;

  async function signOut() {
    await logout();
    if (runtimeMode === "cloud-auth") navigate("/login", { replace: true });
  }

  return (
    <div className={styles.account} aria-label="현재 사용자">
      <UserRound aria-hidden="true" size={17} />
      <span className={styles.accountIdentity}>
        <strong>{profile.displayName}</strong>
        <small>{accountRoleLabel(roomRole, profile)}</small>
      </span>
      <button type="button" onClick={() => void signOut()} aria-label="로그아웃">
        <LogOut aria-hidden="true" size={15} />
        <span>로그아웃</span>
      </button>
    </div>
  );
}

export function LiveRoomShareControl({ roomId, roomCode, message }: LiveRoomShareControlProps) {
  const { user } = useAuth();
  const [share, setShare] = useState<CloudRoomShare | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function toggleShare() {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    setNotice(null);
    if (!nextOpen || share || isLoading) return;
    setIsLoading(true);
    try {
      setShare(await getCloudRoomShare(user, roomId));
    } catch {
      setNotice("공유 정보를 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await copyCloudRoomValue(value);
      setNotice(`${label}를 복사했습니다.`);
    } catch {
      setNotice(`${label}를 복사하지 못했습니다.`);
    }
  }

  const currentRoomCode = share?.roomCode || roomCode || "";
  const shareLink = share ? cloudRoomShareLink(share.joinPath) : "";

  return (
    <div className={styles.share}>
      <button
        type="button"
        className={styles.shareButton}
        onClick={() => void toggleShare()}
        aria-expanded={isOpen}
        aria-controls="live-room-share-details"
      >
        <Share2 aria-hidden="true" size={15} /> 공유하기
      </button>
      {isOpen ? (
        <section id="live-room-share-details" className={styles.shareDetails} aria-label="강의방 공유 정보">
          <strong>학생 참여 정보</strong>
          {message ? <p>{message}</p> : null}
          {isLoading ? <p role="status">공유 정보를 불러오는 중입니다.</p> : null}
          {!isLoading && currentRoomCode && shareLink ? (
            <>
              <label>
                방 코드
                <span>
                  <input aria-label="방 코드" readOnly value={currentRoomCode} />
                  <button type="button" onClick={() => void copy(currentRoomCode, "방 코드")}><Copy aria-hidden="true" size={14} /> 복사</button>
                </span>
              </label>
              <label>
                학생 입장 링크
                <span>
                  <input aria-label="학생 입장 링크" readOnly value={shareLink} />
                  <button type="button" onClick={() => void copy(shareLink, "학생 입장 링크")}><Copy aria-hidden="true" size={14} /> 복사</button>
                </span>
              </label>
            </>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
