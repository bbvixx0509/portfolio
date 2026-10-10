export type AccountType = "STAFF" | "STUDENT";

export const accountTypeLabels: Record<AccountType, string> = {
  STAFF: "직원",
  STUDENT: "수강생",
};

export function profileAccountLabel(profile: Pick<AuthProfile, "accountType" | "organizationRole">) {
  if (profile.accountType === "STUDENT") return accountTypeLabels.STUDENT;
  return profile.organizationRole === "ADMIN" ? "관리자" : "일반 강사";
}

export const delegatedPermissionGroups = [
  {
    label: "강의 준비",
    permissions: [
      ["canEditCourse", "강의 정보 수정"],
      ["canEditCourseFlow", "수업 흐름 편집"],
      ["canManageMaterials", "자료 관리"],
    ],
  },
  {
    label: "강의 진행",
    permissions: [
      ["canShareRoom", "참여 링크 공유"],
      ["canControlProgress", "로드맵 진행 제어"],
      ["canAnnotate", "판서"],
      ["canManageParticipants", "참여자 관리"],
    ],
  },
  {
    label: "질문 관리",
    permissions: [
      ["canAnswerQuestions", "질문 답변"],
      ["canModerateQuestions", "질문 검토·숨김"],
    ],
  },
  {
    label: "종료와 기록",
    permissions: [
      ["canEndRoom", "강의 종료"],
      ["canViewReports", "리포트 조회"],
      ["canExportResults", "결과 내보내기"],
    ],
  },
] as const;

export type DelegatedPermission =
  (typeof delegatedPermissionGroups)[number]["permissions"][number][0];

export type RoomPermissions = Record<DelegatedPermission, boolean>;

export const delegatedPermissionKeys = delegatedPermissionGroups.flatMap(
  (group) => group.permissions.map(([key]) => key),
);

export function createEmptyPermissions(): RoomPermissions {
  return Object.fromEntries(
    delegatedPermissionKeys.map((key) => [key, false]),
  ) as RoomPermissions;
}

export function createDefaultAssistantPermissions(): RoomPermissions {
  return {
    ...createEmptyPermissions(),
    canAnswerQuestions: true,
  };
}

export function normalizePermissions(
  permissions: Partial<Record<DelegatedPermission, unknown>> | undefined,
): RoomPermissions {
  const normalized = createEmptyPermissions();
  for (const key of delegatedPermissionKeys) {
    normalized[key] = permissions?.[key] === true;
  }
  return normalized;
}

export type AuthProfile = {
  uid: string;
  email: string | null;
  displayName: string;
  nickname: string | null;
  accountType: AccountType;
  organizationRole?: "ADMIN" | "INSTRUCTOR";
  isAdmin?: boolean;
  orgId: string;
  photoURL?: string | null;
  authorized?: boolean;
};

export function isAccountType(value: unknown): value is AccountType {
  return value === "STAFF" || value === "STUDENT";
}

export function validateNickname(value: string) {
  const nickname = value.trim();
  const length = Array.from(nickname).length;
  if (length < 2) {
    return { valid: false as const, message: "익명 별명은 2자 이상 입력해 주세요." };
  }
  if (length > 20) {
    return { valid: false as const, message: "익명 별명은 20자 이하로 입력해 주세요." };
  }
  return { valid: true as const, nickname };
}
