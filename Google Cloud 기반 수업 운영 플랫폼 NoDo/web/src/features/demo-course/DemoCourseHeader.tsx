import { Link } from "react-router-dom";
import {
  getCurrentProgressItem,
  getIsCourseCompleted,
  getUnreadQuestionCount,
} from "./demoCourseSelectors";
import { useDemoCourse } from "./DemoCourseContext";
import styles from "./DemoCourseHeader.module.css";

type DemoCourseHeaderProps = {
  activeTab: "BUILDER" | "CHECKLIST" | "CHAT";
  showRoomCode?: boolean;
};

export function DemoCourseHeader({
  activeTab,
  showRoomCode = false,
}: DemoCourseHeaderProps) {
  const { state } = useDemoCourse();
  const unreadCount = getUnreadQuestionCount(state);
  const currentProgressItem = getCurrentProgressItem(state);
  const allItemsCompleted = getIsCourseCompleted(state);
  const statusLabel = allItemsCompleted
    ? "완료"
    : state.course.status === "LIVE"
      ? "진행중"
      : "준비중";
  const chapterIndex = currentProgressItem
    ? state.chapters.findIndex(
        (chapter) => chapter.id === currentProgressItem.chapterId,
      )
    : -1;
  const chapterLabel =
    chapterIndex >= 0 ? ` · CH.${String(chapterIndex + 1).padStart(2, "0")}` : "";

  return (
    <header className={styles.header}>
      <div className={styles.brandGroup}>
        <Link className={styles.logo} to="/" aria-label="NoDo">
          <span aria-hidden="true">NO</span>
          <span aria-hidden="true">DO</span>
        </Link>
        <span
          className={`${styles.statusPill} ${
            allItemsCompleted ? styles.completedStatusPill : ""
          }`}
          aria-label={`강의 상태: ${statusLabel}`}
        >
          오늘의 강의{chapterLabel} · {statusLabel}
        </span>
        {showRoomCode ? (
          <span className={styles.roomCode}>
            강의방 코드 <strong>{state.course.roomCode}</strong>
          </span>
        ) : (
          <button
            className={styles.sharePlaceholder}
            type="button"
            disabled
            title="실제 공유 기능은 아직 연결하지 않았습니다."
          >
            강의방 공유하기
          </button>
        )}
      </div>

      <nav
        className={styles.tabs}
        aria-label="강의 화면 전환"
        role="tablist"
      >
        <Link
          className={activeTab === "CHAT" ? styles.activeTab : ""}
          to="/rooms/demo-room/chat"
          role="tab"
          aria-selected={activeTab === "CHAT"}
          aria-controls={activeTab === "BUILDER" ? undefined : "room-side-panel"}
          id="room-chat-tab"
          aria-current={activeTab === "CHAT" ? "page" : undefined}
        >
          채팅 <span>{unreadCount}</span>
        </Link>
        <Link
          className={activeTab === "CHECKLIST" ? styles.activeTab : ""}
          to="/rooms/demo-room/checklist"
          role="tab"
          aria-selected={activeTab === "CHECKLIST"}
          aria-controls={activeTab === "BUILDER" ? undefined : "room-side-panel"}
          id="room-checklist-tab"
          aria-current={activeTab === "CHECKLIST" ? "page" : undefined}
        >
          로드맵
        </Link>
      </nav>
    </header>
  );
}
