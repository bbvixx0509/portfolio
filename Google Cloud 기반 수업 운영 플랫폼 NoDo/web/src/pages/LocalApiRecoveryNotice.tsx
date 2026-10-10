import cloudStyles from "./CloudLoginPage.module.css";

type LocalApiRecoveryNoticeProps = {
  disabled: boolean;
  onReconnect: () => void;
};

/** Loaded only by the localhost cloud-auth development login page. */
export function LocalApiRecoveryNotice({
  disabled,
  onReconnect,
}: LocalApiRecoveryNoticeProps) {
  return (
    <>
      <div className={cloudStyles.error} role="alert" aria-live="assertive">
        <strong>로컬 서버에 연결하지 못했습니다.</strong>
        <span>NoDo 로컬 FastAPI(127.0.0.1:8082)가 실행 중인지 확인한 뒤 다시 연결해 주세요.</span>
      </div>
      {!disabled ? (
        <div className={cloudStyles.recoveryActions} aria-label="로컬 FastAPI 재연결 동작">
          <button
            className={cloudStyles.secondaryButton}
            type="button"
            onClick={onReconnect}
          >
            연결 다시 확인
          </button>
        </div>
      ) : null}
    </>
  );
}
