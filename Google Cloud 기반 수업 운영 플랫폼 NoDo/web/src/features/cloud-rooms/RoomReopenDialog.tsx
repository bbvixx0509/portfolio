import { ApiError } from "../../lib/api/apiClient";
import styles from "./CloudRoomPages.module.css";

export function roomReopenErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "이 강의방을 다시 열 권한이 없습니다.";
    if (error.status === 404) return "강의방을 찾을 수 없습니다.";
    if (error.status === 409) {
      return "강의방 상태가 변경되었거나 복구 가능한 시간이 지났습니다. 새로고침 후 다시 확인해 주세요.";
    }
  }
  return "강의방을 다시 열지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

type RoomReopenDialogProps = {
  open: boolean;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export function RoomReopenDialog({
  open,
  pending,
  error,
  onCancel,
  onConfirm,
}: RoomReopenDialogProps) {
  if (!open) return null;
  return (
    <div className={styles.instructorConfirmBackdrop} role="presentation">
      <section className={styles.instructorConfirm} role="dialog" aria-modal="true" aria-labelledby="room-reopen-title">
        <h2 id="room-reopen-title">이 강의방을 다시 열까요?</h2>
        <p>학생 입장과 질문 기능이 다시 활성화됩니다.</p>
        {error ? <p role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <button type="button" onClick={onCancel} disabled={pending}>취소</button>
          <button type="button" onClick={onConfirm} disabled={pending}>
            {pending ? "처리 중..." : "종료 취소"}
          </button>
        </div>
      </section>
    </div>
  );
}
