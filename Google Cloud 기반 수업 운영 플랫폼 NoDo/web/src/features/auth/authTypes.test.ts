import { describe, expect, it } from "vitest";
import {
  createEmptyPermissions,
  createDefaultAssistantPermissions,
  delegatedPermissionGroups,
  delegatedPermissionKeys,
  normalizePermissions,
  validateNickname,
} from "./authTypes";

describe("보조 강사 위임 권한", () => {
  it("요구된 12개 권한만 네 그룹에 제공한다", () => {
    expect(delegatedPermissionKeys).toHaveLength(12);
    expect(new Set(delegatedPermissionKeys)).toHaveLength(12);
    expect(delegatedPermissionGroups.map((group) => group.label)).toEqual([
      "강의 준비",
      "강의 진행",
      "질문 관리",
      "종료와 기록",
    ]);
    expect(delegatedPermissionKeys).not.toContain("canTransferOwnership");
    expect(delegatedPermissionKeys).not.toContain("canManageOtherStaff");
    expect(delegatedPermissionKeys).not.toContain("canChangeLeadInstructor");
  });

  it("저장되지 않은 권한은 모두 false로 정규화한다", () => {
    const permissions = createEmptyPermissions();
    expect(Object.values(permissions).every((value) => value === false)).toBe(true);
    expect(normalizePermissions({ canControlProgress: true })).toEqual({
      ...permissions,
      canControlProgress: true,
    });
  });

  it("새 보조 강사의 서버 기본 권한과 같은 질문 답변 권한만 활성화한다", () => {
    const permissions = createDefaultAssistantPermissions();
    expect(permissions.canAnswerQuestions).toBe(true);
    expect(
      Object.entries(permissions)
        .filter(([key]) => key !== "canAnswerQuestions")
        .every(([, enabled]) => enabled === false),
    ).toBe(true);
  });

  it("별명은 trim 기준 2~20자로 제한한다", () => {
    expect(validateNickname(" 한 ")).toEqual({
      valid: false,
      message: "익명 별명은 2자 이상 입력해 주세요.",
    });
    expect(validateNickname("가".repeat(21))).toEqual({
      valid: false,
      message: "익명 별명은 20자 이하로 입력해 주세요.",
    });
    expect(validateNickname("  용감한 수달  ")).toEqual({
      valid: true,
      nickname: "용감한 수달",
    });
  });
});
