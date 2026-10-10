import type { StudentAccessWindow } from "./roomApi";

export const KOREA_TIME_ZONE = "Asia/Seoul";

export function formatKoreanDateTime(value: string | null) {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "기록 없음";
  return `${new Intl.DateTimeFormat("ko-KR", {
    timeZone: KOREA_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)} KST`;
}

export function studentAccessDeadline(
  endedAt: string | null,
  downloadAvailableUntil: string | null,
) {
  const stored = downloadAvailableUntil ? new Date(downloadAvailableUntil) : null;
  if (stored && !Number.isNaN(stored.getTime())) return stored;
  const ended = endedAt ? new Date(endedAt) : null;
  if (!ended || Number.isNaN(ended.getTime())) return null;
  return new Date(ended.getTime() + 7 * 24 * 60 * 60 * 1000);
}

export function isStudentAccessOpen(
  endedAt: string | null,
  downloadAvailableUntil: string | null,
  now = new Date(),
) {
  const deadline = studentAccessDeadline(endedAt, downloadAvailableUntil);
  return deadline !== null && now.getTime() < deadline.getTime();
}

export function kstInputToIso(value: string) {
  if (!value) return null;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const date = new Date(`${withSeconds}+09:00`);
  return Number.isNaN(date.getTime()) ? null : `${withSeconds}+09:00`;
}

export function isFutureKstInput(value: string, now = new Date()) {
  const iso = kstInputToIso(value);
  if (!iso) return false;
  return new Date(iso).getTime() > now.getTime();
}

export function studentAccessWindowDescription(
  window: StudentAccessWindow,
  customValue: string,
) {
  if (window === "IMMEDIATE") {
    return "강의 종료와 동시에 학생의 자료 열람·다운로드가 마감됩니다.";
  }
  if (window === "ONE_DAY") {
    return "서버가 실제 종료 시각을 기준으로 학생 자료 열람·다운로드를 1일 뒤 마감합니다.";
  }
  if (window === "THIRTY_DAYS") {
    return "서버가 실제 종료 시각을 기준으로 학생 자료 열람·다운로드를 30일 뒤 마감합니다.";
  }
  if (window === "CUSTOM") {
    return customValue
      ? `학생 자료 열람·다운로드를 ${customValue.replace("T", " ")} KST에 마감하도록 서버에 요청합니다.`
      : "한국 시간 기준의 마감 날짜와 시간을 입력해 주세요.";
  }
  return "서버가 실제 종료 시각을 기준으로 학생 자료 열람·다운로드를 7일 뒤 마감합니다.";
}
