import { type FormEvent, useEffect, useState } from "react";
import type { CloudRoomEndInput, StudentAccessWindow } from "./roomApi";
import {
  isFutureKstInput,
  kstInputToIso,
  studentAccessWindowDescription,
} from "./endAccessDeadline";
import styles from "./EndAccessDeadlineDialog.module.css";

type EndAccessDeadlineDialogProps = {
  open: boolean;
  isEnding: boolean;
  onCancel: () => void;
  onConfirm: (input: CloudRoomEndInput) => void;
};

const accessWindows: Array<{ value: StudentAccessWindow; label: string }> = [
  { value: "IMMEDIATE", label: "지금 종료하고 자료 열람도 바로 마감" },
  { value: "ONE_DAY", label: "종료 후 1일" },
  { value: "SEVEN_DAYS", label: "종료 후 7일" },
  { value: "THIRTY_DAYS", label: "종료 후 30일" },
  { value: "CUSTOM", label: "직접 날짜·시간 지정 (KST)" },
];

export function EndAccessDeadlineDialog({
  open,
  isEnding,
  onCancel,
  onConfirm,
}: EndAccessDeadlineDialogProps) {
  const [window, setWindow] = useState<StudentAccessWindow>("SEVEN_DAYS");
  const [customUntil, setCustomUntil] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setWindow("SEVEN_DAYS");
    setCustomUntil("");
    setError("");
  }, [open]);

  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (window === "CUSTOM") {
      if (!customUntil) {
        setError("KST 기준의 마감 날짜와 시간을 입력해 주세요.");
        return;
      }
      if (!isFutureKstInput(customUntil)) {
        setError("직접 지정한 마감 시간은 현재 시각 이후여야 합니다.");
        return;
      }
      const studentAccessUntil = kstInputToIso(customUntil);
      if (!studentAccessUntil) {
        setError("KST 기준의 올바른 날짜와 시간을 입력해 주세요.");
        return;
      }
      onConfirm({ studentAccessWindow: window, studentAccessUntil });
      return;
    }
    onConfirm({ studentAccessWindow: window });
  }

  return (
    <div className={styles.backdrop} role="presentation">
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="end-access-title">
        <header>
          <p>강의 종료 확인</p>
          <h2 id="end-access-title">학생 자료 열람 마감일을 선택하세요</h2>
          <span>최종 마감 시각은 서버가 실제 종료 시각을 기준으로 결정합니다.</span>
        </header>
        <form onSubmit={submit}>
          <fieldset disabled={isEnding}>
            <legend>학생 자료 열람·다운로드 기간</legend>
            {accessWindows.map((option) => (
              <label key={option.value} className={styles.option}>
                <input
                  type="radio"
                  name="student-access-window"
                  value={option.value}
                  checked={window === option.value}
                  onChange={() => {
                    setWindow(option.value);
                    setError("");
                  }}
                />
                <span>{option.label}{option.value === "SEVEN_DAYS" ? " (기본)" : ""}</span>
              </label>
            ))}
          </fieldset>
          {window === "CUSTOM" ? (
            <label className={styles.customInput}>
              직접 마감 날짜·시간 (KST)
              <input
                type="datetime-local"
                value={customUntil}
                onChange={(event) => {
                  setCustomUntil(event.target.value);
                  setError("");
                }}
                aria-describedby="custom-end-help"
                required
              />
              <small id="custom-end-help">한국 시간(KST) 기준으로 입력하세요.</small>
            </label>
          ) : null}
          <p className={styles.description}>{studentAccessWindowDescription(window, customUntil)}</p>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <footer>
            <button type="button" onClick={onCancel} disabled={isEnding}>취소</button>
            <button className={styles.endButton} type="submit" disabled={isEnding}>
              {isEnding ? "강의 종료 처리 중..." : "강의 종료"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
