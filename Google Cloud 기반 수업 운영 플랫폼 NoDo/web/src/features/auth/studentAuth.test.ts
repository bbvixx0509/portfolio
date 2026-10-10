import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearStoredStudentSession,
  cloudUserKind,
  createRandomStudentNickname,
  normalizeStudentAuthSession,
  readStoredStudentSession,
  storeStudentSession,
  STUDENT_NICKNAME_KEY,
  STUDENT_ROOM_CODE_KEY,
  validateStudentNickname,
  validateStudentRoomCode,
} from "./studentAuth";

const validResponse = {
  accountType: "STUDENT",
  isAnonymous: true,
  identityVerified: true,
  provider: "anonymous",
  scope: "AUTH_ONLY",
  roomAuthorized: false,
  nickname: "차분한 별빛",
  roomCode: "TEST123",
} as const;

describe("02-7 학생 참여 입력", () => {
  beforeEach(() => sessionStorage.clear());

  it("형용사와 명사를 조합한 읽기 쉬운 랜덤 별명을 만든다", () => {
    expect(createRandomStudentNickname(() => 0)).toBe("차분한 별빛");
    expect(createRandomStudentNickname(() => 0.999)).toBe("조용한 키보드");
  });

  it("별명을 trim 기준 2~16자로 정규화한다", () => {
    expect(validateStudentNickname("  푸른 연필  ")).toEqual({
      valid: true,
      nickname: "푸른 연필",
    });
    expect(validateStudentNickname(" ")).toMatchObject({ valid: false });
    expect(validateStudentNickname("한")).toMatchObject({ valid: false });
    expect(validateStudentNickname("가".repeat(17))).toMatchObject({ valid: false });
  });

  it("줄바꿈과 Cc·Cf·Cs 제어 문자를 거부한다", () => {
    expect(validateStudentNickname("푸른\n연필")).toMatchObject({ valid: false });
    expect(validateStudentNickname("푸른\u0000연필")).toMatchObject({ valid: false });
    expect(validateStudentNickname("푸른\u200b연필")).toMatchObject({ valid: false });
  });

  it("서버와 같은 기본 금칙어와 운영진 사칭 키를 적용한다", () => {
    for (const value of ["관리자", "NoDo 운영자", "공식 강사", "별빛욕설노트"]) {
      expect(validateStudentNickname(value)).toMatchObject({ valid: false });
    }
    expect(validateStudentNickname("관리자동화")).toEqual({
      valid: true,
      nickname: "관리자동화",
    });
    expect(validateStudentNickname("관리자 도우미")).toEqual({
      valid: true,
      nickname: "관리자 도우미",
    });
    expect(validateStudentNickname("<b>별빛</b>")).toEqual({
      valid: true,
      nickname: "<b>별빛</b>",
    });
  });

  it("참여 코드를 안전하게 디코딩하고 영문·숫자 4~12자로 제한한다", () => {
    expect(validateStudentRoomCode(" test123 ")).toEqual({
      valid: true,
      roomCode: "TEST123",
    });
    expect(validateStudentRoomCode("%54EST123")).toEqual({
      valid: true,
      roomCode: "TEST123",
    });
    expect(validateStudentRoomCode("ABC")).toMatchObject({ valid: false });
    expect(validateStudentRoomCode("TEST-123")).toMatchObject({ valid: false });
    expect(validateStudentRoomCode("%E0%A4%A")).toMatchObject({ valid: false });
  });
});

describe("02-7 학생 세션 계약", () => {
  beforeEach(() => sessionStorage.clear());

  it("서버가 판단한 최소 응답만 학생 세션으로 정규화한다", () => {
    expect(normalizeStudentAuthSession({
      ...validResponse,
      nickname: "  차분한 별빛  ",
      roomCode: "test123",
    })).toEqual(validResponse);
  });

  it("실제 강의방 권한 또는 다른 provider를 주장하는 응답을 거부한다", () => {
    expect(() => normalizeStudentAuthSession({
      ...validResponse,
      roomAuthorized: true,
    })).toThrow(/올바르지/);
    expect(() => normalizeStudentAuthSession({
      ...validResponse,
      provider: "google.com",
    })).toThrow(/올바르지/);
  });

  it("별명과 참여 코드만 sessionStorage에 저장하고 정리한다", () => {
    const session = normalizeStudentAuthSession(validResponse);
    storeStudentSession(session);

    expect(sessionStorage.getItem(STUDENT_NICKNAME_KEY)).toBe("차분한 별빛");
    expect(sessionStorage.getItem(STUDENT_ROOM_CODE_KEY)).toBe("TEST123");
    expect(readStoredStudentSession()).toEqual({
      nickname: "차분한 별빛",
      roomCode: "TEST123",
    });
    expect(Object.keys(sessionStorage).some((key) => /token|uid|email/i.test(key))).toBe(false);

    clearStoredStudentSession();
    expect(readStoredStudentSession()).toBeNull();
  });

  it("변조되거나 일부만 남은 저장 값을 복원하지 않는다", () => {
    sessionStorage.setItem(STUDENT_NICKNAME_KEY, "관리자");
    sessionStorage.setItem(STUDENT_ROOM_CODE_KEY, "TEST123");
    expect(readStoredStudentSession()).toBeNull();
    expect(sessionStorage.getItem(STUDENT_NICKNAME_KEY)).toBeNull();
  });

  it("클라이언트 provider는 직원·학생·미지원으로만 구분한다", () => {
    const student = { isAnonymous: true, providerData: [] } as unknown as User;
    const staff = {
      isAnonymous: false,
      providerData: [{ providerId: "google.com" }],
    } as User;
    const unsupported = {
      isAnonymous: false,
      providerData: [{ providerId: "password" }],
    } as User;
    expect(cloudUserKind(student)).toBe("student");
    expect(cloudUserKind(staff)).toBe("staff");
    expect(cloudUserKind(unsupported)).toBe("unsupported");
  });
});
