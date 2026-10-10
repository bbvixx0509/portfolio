import { describe, expect, it } from "vitest";
import {
  createRandomParticipantNickname,
  validateParticipantNickname,
} from "./participantNickname";

describe("02-7A participant nickname contract", () => {
  it("creates a general-word random nickname and permits normal plain text", () => {
    expect(createRandomParticipantNickname(() => 0)).toBe("맑은 구름");
    expect(createRandomParticipantNickname(() => 0.999)).toBe("고요한 바람");
    expect(validateParticipantNickname("  학생 101  ")).toEqual({
      valid: true,
      nickname: "학생 101",
    });
  });

  it("rejects blank, length, control, URL, and HTML-like values without a profanity policy", () => {
    for (const value of ["", " ", "가", "가".repeat(17), "별빛\n구름", "별빛\u200b구름", "https://example.test", "<b>별빛</b>"]) {
      expect(validateParticipantNickname(value)).toMatchObject({ valid: false });
    }
    expect(validateParticipantNickname("관리자")).toEqual({ valid: true, nickname: "관리자" });
    expect(validateParticipantNickname("별빛욕설노트")).toEqual({ valid: true, nickname: "별빛욕설노트" });
  });
});
