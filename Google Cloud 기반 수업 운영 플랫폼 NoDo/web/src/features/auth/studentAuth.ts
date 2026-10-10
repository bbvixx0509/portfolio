import type { User } from "firebase/auth";
import { ApiError } from "../../lib/api/apiClient";

export const STUDENT_NICKNAME_KEY = "nodo.student.nickname";
export const STUDENT_ROOM_CODE_KEY = "nodo.student.room-code";

const adjectives = ["차분한", "푸른", "맑은", "따뜻한", "밝은", "조용한"] as const;
const nouns = ["별빛", "연필", "구름", "햇살", "노트", "키보드"] as const;
const blockedNicknameTerms = ["씨발", "병신", "개새끼", "욕설"] as const;
const reservedNicknameKeys = new Set([
  "관리자",
  "운영자",
  "시스템",
  "공식강사",
  "nodo관리자",
  "nodo운영자",
  "nodo시스템",
  "nodo공식강사",
]);
const controlCharacterPattern = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const lineBreakPattern = /[\r\n\u2028\u2029]/u;
const roomCodePattern = /^[A-Z0-9]{4,12}$/u;

export type StudentAuthSession = {
  accountType: "STUDENT";
  isAnonymous: true;
  identityVerified: true;
  provider: "anonymous";
  scope: "AUTH_ONLY";
  roomAuthorized: false;
  nickname: string;
  roomCode: string;
};

export type CloudIdentityKind =
  | "loading"
  | "signed-out"
  | "staff"
  | "staff-verification-failed"
  | "invited-staff"
  | "student"
  | "unsupported";

export type AuthConflictState =
  | "STAFF_ON_STUDENT_ENTRY"
  | "STUDENT_ON_STAFF_LOGIN"
  | "UNSUPPORTED_PROVIDER";

export class AuthConflictError extends Error {
  readonly conflict: AuthConflictState;

  constructor(conflict: AuthConflictState, message: string) {
    super(message);
    this.name = "AuthConflictError";
    this.conflict = conflict;
  }
}

export function createRandomStudentNickname(random = Math.random) {
  const adjectiveIndex = Math.min(
    adjectives.length - 1,
    Math.max(0, Math.floor(random() * adjectives.length)),
  );
  const nounIndex = Math.min(
    nouns.length - 1,
    Math.max(0, Math.floor(random() * nouns.length)),
  );
  return `${adjectives[adjectiveIndex]} ${nouns[nounIndex]}`;
}

export function studentNicknameLength(value: string) {
  return Array.from(value.trim()).length;
}

export function validateStudentNickname(value: unknown) {
  if (typeof value !== "string") {
    return { valid: false as const, message: "참여 이름을 확인해 주세요." };
  }
  if (lineBreakPattern.test(value)) {
    return { valid: false as const, message: "참여 이름은 한 줄로 입력해 주세요." };
  }
  if (controlCharacterPattern.test(value)) {
    return {
      valid: false as const,
      message: "참여 이름에 사용할 수 없는 문자가 포함되어 있습니다.",
    };
  }

  const nickname = value.normalize("NFC").trim();
  const length = Array.from(nickname).length;
  if (length === 0) {
    return { valid: false as const, message: "참여 이름을 입력해 주세요." };
  }
  if (length < 2) {
    return { valid: false as const, message: "참여 이름은 2자 이상 입력해 주세요." };
  }
  if (length > 16) {
    return { valid: false as const, message: "참여 이름은 16자 이하로 입력해 주세요." };
  }
  const policyKey = nickname
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^0-9a-z가-힣]+/gu, "");
  if (blockedNicknameTerms.some((term) => policyKey.includes(term))) {
    return {
      valid: false as const,
      message: "참여 이름에 사용할 수 없는 표현이 포함되어 있습니다.",
    };
  }
  if (reservedNicknameKeys.has(policyKey)) {
    return {
      valid: false as const,
      message: "강사나 운영진으로 오해할 수 있는 참여 이름은 사용할 수 없습니다.",
    };
  }

  return { valid: true as const, nickname };
}

export function validateStudentRoomCode(value: unknown) {
  if (typeof value !== "string") {
    return { valid: false as const, message: "참여 코드를 확인해 주세요." };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return { valid: false as const, message: "참여 코드 형식이 올바르지 않습니다." };
  }

  const roomCode = decoded.trim().toUpperCase();
  if (!roomCodePattern.test(roomCode)) {
    return {
      valid: false as const,
      message: "참여 코드는 영문과 숫자 4~12자로 입력해 주세요.",
    };
  }
  return { valid: true as const, roomCode };
}

function recordFromUnknown(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeStudentAuthSession(payload: unknown): StudentAuthSession {
  const record = recordFromUnknown(payload);
  if (
    record.accountType !== "STUDENT" ||
    record.isAnonymous !== true ||
    record.identityVerified !== true ||
    record.provider !== "anonymous" ||
    record.scope !== "AUTH_ONLY" ||
    record.roomAuthorized !== false
  ) {
    throw new Error("참여 확인 응답이 올바르지 않습니다.");
  }

  const nicknameResult = validateStudentNickname(record.nickname);
  const roomCodeResult = validateStudentRoomCode(record.roomCode);
  if (!nicknameResult.valid || !roomCodeResult.valid) {
    throw new Error("참여 확인 응답이 올바르지 않습니다.");
  }

  return {
    accountType: "STUDENT",
    isAnonymous: true,
    identityVerified: true,
    provider: "anonymous",
    scope: "AUTH_ONLY",
    roomAuthorized: false,
    nickname: nicknameResult.nickname,
    roomCode: roomCodeResult.roomCode,
  };
}

export function cloudUserKind(user: User): "staff" | "student" | "unsupported" {
  if (user.isAnonymous) return "student";
  const providers = new Set(user.providerData.map((entry) => entry.providerId));
  return providers.size === 1 && providers.has("google.com")
    ? "staff"
    : "unsupported";
}

export function storeStudentSession(session: StudentAuthSession) {
  try {
    globalThis.sessionStorage?.setItem(STUDENT_NICKNAME_KEY, session.nickname);
    globalThis.sessionStorage?.setItem(STUDENT_ROOM_CODE_KEY, session.roomCode);
  } catch {
    // 저장소가 차단되어도 현재 탭의 참여 확인 상태는 계속 사용할 수 있다.
  }
}

export function clearStoredStudentSession() {
  try {
    globalThis.sessionStorage?.removeItem(STUDENT_NICKNAME_KEY);
    globalThis.sessionStorage?.removeItem(STUDENT_ROOM_CODE_KEY);
  } catch {
    // 저장소 정리가 실패해도 Firebase 로그아웃은 계속 진행한다.
  }
}

export function readStoredStudentSession() {
  try {
    const nickname = globalThis.sessionStorage?.getItem(STUDENT_NICKNAME_KEY);
    const roomCode = globalThis.sessionStorage?.getItem(STUDENT_ROOM_CODE_KEY);
    const nicknameResult = validateStudentNickname(nickname);
    const roomCodeResult = validateStudentRoomCode(roomCode);
    if (!nicknameResult.valid || !roomCodeResult.valid) {
      clearStoredStudentSession();
      return null;
    }
    return {
      nickname: nicknameResult.nickname,
      roomCode: roomCodeResult.roomCode,
    };
  } catch {
    return null;
  }
}

function firebaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function studentAuthErrorMessage(error: unknown) {
  if (error instanceof AuthConflictError) return error.message;
  switch (firebaseErrorCode(error)) {
    case "auth/network-request-failed":
      return "네트워크 연결을 확인한 뒤 다시 시도해 주세요.";
    case "auth/operation-not-allowed":
    case "auth/admin-restricted-operation":
      return "현재 참여 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.";
    case "auth/too-many-requests":
    case "auth/quota-exceeded":
      return "요청이 많아 잠시 참여할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  }

  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "참여 정보를 확인하지 못했습니다. 참여를 종료한 뒤 다시 시도해 주세요.";
    }
    if (error.status === 400 || error.status === 422) {
      return "참여 이름과 참여 코드를 다시 확인해 주세요.";
    }
    if (error.status === 429) {
      return "요청이 많아 잠시 참여할 수 없습니다. 잠시 후 다시 시도해 주세요.";
    }
    if (error.status >= 500) {
      return "참여 확인이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.";
    }
  }

  return "참여를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}
