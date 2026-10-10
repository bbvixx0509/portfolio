import type { RoomPermissions } from "../auth/authTypes";

export type LiveRoom = {
  id: string;
  orgId: string;
  courseId: string;
  title: string;
  leadInstructorId: string;
  status: string;
  currentItemId: string | null;
  itemOrder: string[];
};

export type LiveChapter = {
  id: string;
  title: string;
  order: number;
};

export type LiveCourseItem = {
  id: string;
  chapterId: string;
  title: string;
  description: string;
  materialLabel: string;
  kind: string;
  order: number;
  isCompleted: boolean;
};

export type LiveStaffMember = {
  userId: string;
  displayName: string;
  email: string | null;
  permissions: RoomPermissions;
  updatedAt: string | null;
  updatedBy: string | null;
  changerDisplayName?: string | null;
  grantedAt: string | null;
  grantedBy: string | null;
};

export type AvailableStaffCandidate = {
  userId: string;
  displayName: string;
  email: string | null;
};

export type QuestionVisibility = "PUBLIC" | "STAFF_ONLY";

export type QuestionModerationStatus =
  | "APPROVED"
  | "NEEDS_REVIEW"
  | "BLOCKED";

export type LiveQuestionAnswer = {
  content: string;
  instructorDisplayName: string;
  roomRole: "LEAD" | "ASSISTANT";
  answeredAt: string | null;
};

/**
 * Firestore의 공개 질문 문서만 표현한다.
 * 작성자와 답변자의 Firebase UID·이메일은 의도적으로 포함하지 않는다.
 */
export type LiveQuestion = {
  id: string;
  roomId: string;
  courseId: string;
  orgId: string;
  content: string;
  nicknameSnapshot: string;
  isGeneral: boolean;
  itemId: string | null;
  itemNumberSnapshot: string | null;
  itemTitleSnapshot: string | null;
  chapterTitleSnapshot: string | null;
  materialLabelSnapshot: string | null;
  visibility: QuestionVisibility;
  moderationStatus: QuestionModerationStatus;
  isAnswered: boolean;
  answer: LiveQuestionAnswer | null;
  isHidden: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  createdAtMillis: number;
  schemaVersion: number;
};

export type LiveParticipant = {
  participantId: string;
  nickname: string;
  status: "ACTIVE" | "LEFT" | string;
  isQuestionRestricted: boolean;
};

export type RoomSummaryItemCount = {
  itemId: string | null;
  itemNumber: string | null;
  itemTitle: string;
  questionCount: number;
};

export type LiveRoomSummary = {
  roomId: string;
  roomTitle: string;
  participantCount: number;
  totalQuestionCount: number;
  publicQuestionCount: number;
  reviewQuestionCount: number;
  hiddenQuestionCount: number;
  answeredQuestionCount: number;
  unansweredQuestionCount: number;
  checklistTotalCount: number;
  checklistCompletedCount: number;
  itemQuestionCounts: RoomSummaryItemCount[];
  endedAt: string | null;
  endedByDisplayName: string;
  exportStatus: "NOT_CONFIGURED" | string;
};
