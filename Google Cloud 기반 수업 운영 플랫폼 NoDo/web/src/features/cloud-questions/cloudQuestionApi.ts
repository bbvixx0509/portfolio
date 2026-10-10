import type { User } from "firebase/auth";
import { ApiError, requestApi, requestBlobApiResponse } from "../../lib/api/apiClient";

export type CloudQuestionFlowItem = {
  chapterId: string;
  chapterTitle: string;
  chapterPosition: number;
  itemId: string;
  itemTitle: string;
  itemDescription: string;
  sourcePageOrSlideNumbers?: number[];
  itemPosition: number;
  itemNumber: string;
};

export type CloudQuestionAnswer = {
  content: string;
  /** Student feeds intentionally omit the staff display name. */
  staffDisplayName?: string;
  roomRole: "LEAD" | "ASSISTANT";
  answeredAt: string | null;
};

export type CloudQuestion = {
  id: string;
  content: string;
  nicknameSnapshot: string;
  isGeneral: boolean;
  itemId: string | null;
  itemNumberSnapshot: string | null;
  itemTitleSnapshot: string | null;
  chapterTitleSnapshot: string | null;
  isAnswered: boolean;
  answer: CloudQuestionAnswer | null;
  createdAt: string | null;
  /** Staff-only fields are intentionally absent in student API responses. */
  visibility?: "PUBLIC" | "STAFF_ONLY";
  moderationStatus?: "APPROVED" | "NEEDS_REVIEW";
  isHidden?: boolean;
};

export type CloudQuestionSummary = {
  allCount: number;
  newCount: number;
  generalCount: number;
  generalNewCount: number;
  itemCounts: Array<{ itemId: string; itemNumber: string; totalCount: number; newCount: number }>;
};

export type CloudQuestionReadReceipt = {
  contextId: string;
  marked: boolean;
};

export type StaffQuestionFeed = {
  roomTitle: string;
  roomStatus: "READY" | "LIVE" | "ENDED";
  currentRole: "LEAD_INSTRUCTOR" | "ASSISTANT" | "ADMIN";
  roomPermissions: {
    questionOperations: boolean;
    checklistProgress: boolean;
    capacityOperations: boolean;
  };
  flowItems: CloudQuestionFlowItem[];
  questions: CloudQuestion[];
  summary: CloudQuestionSummary;
};

export type StudentQuestionFeed = {
  roomTitle: string;
  roomStatus?: "READY" | "LIVE" | "ENDED";
  nickname: string;
  flowItems: CloudQuestionFlowItem[];
  questions: CloudQuestion[];
};

export type CloudQuestionInput = {
  content: string;
  itemId: string | null;
  clientRequestId: string;
};

export type CloudQuestionCsvExport = {
  blob: Blob;
  filename: string;
};

const FALLBACK_CSV_FILENAME = "nodo-chat-history.csv";

function hasControlCharacter(value: string) {
  return [...value].some((character) => character.codePointAt(0)! < 32);
}

/** Keep transport and server details out of the student-facing chat UI. */
export function studentQuestionSubmitErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if ([401, 403, 404, 409].includes(error.status)) {
      return "현재 이 강의방에는 질문을 남길 수 없습니다.";
    }
    if (error.status >= 500) {
      return "질문을 전송하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
    if (error.status === 0) {
      return "연결을 확인한 뒤 다시 시도해 주세요.";
    }
    return "질문 내용을 확인한 뒤 다시 시도해 주세요.";
  }
  return "연결을 확인한 뒤 다시 시도해 주세요.";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function number(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function nullableText(value: unknown) {
  return typeof value === "string" ? value : null;
}

function flowItem(value: unknown): CloudQuestionFlowItem {
  const item = record(value);
  return {
    chapterId: text(item.chapterId),
    chapterTitle: text(item.chapterTitle),
    chapterPosition: number(item.chapterPosition),
    itemId: text(item.itemId),
    itemTitle: text(item.itemTitle),
    itemDescription: text(item.itemDescription),
    sourcePageOrSlideNumbers: Array.isArray(item.sourcePageOrSlideNumbers)
      ? item.sourcePageOrSlideNumbers.filter((value): value is number => Number.isInteger(value) && value >= 1)
      : [],
    itemPosition: number(item.itemPosition),
    itemNumber: text(item.itemNumber),
  };
}

function question(value: unknown): CloudQuestion {
  const item = record(value);
  const answerData = record(item.answer);
  const hasAnswer = typeof answerData.content === "string";
  return {
    id: text(item.id),
    content: text(item.content),
    nicknameSnapshot: text(item.nicknameSnapshot),
    isGeneral: item.isGeneral === true,
    itemId: nullableText(item.itemId),
    itemNumberSnapshot: nullableText(item.itemNumberSnapshot),
    itemTitleSnapshot: nullableText(item.itemTitleSnapshot),
    chapterTitleSnapshot: nullableText(item.chapterTitleSnapshot),
    isAnswered: item.isAnswered === true,
    answer: hasAnswer
      ? {
          content: text(answerData.content),
          staffDisplayName: text(answerData.staffDisplayName),
          roomRole: answerData.roomRole === "ASSISTANT" ? "ASSISTANT" : "LEAD",
          answeredAt: nullableText(answerData.answeredAt),
        }
      : null,
    createdAt: nullableText(item.createdAt),
    visibility:
      item.visibility === "STAFF_ONLY" || item.visibility === "PUBLIC"
        ? item.visibility
        : undefined,
    moderationStatus:
      item.moderationStatus === "NEEDS_REVIEW" || item.moderationStatus === "APPROVED"
        ? item.moderationStatus
        : undefined,
    isHidden: typeof item.isHidden === "boolean" ? item.isHidden : undefined,
  };
}

function summary(value: unknown): CloudQuestionSummary {
  const data = record(value);
  const itemCounts = Array.isArray(data.itemCounts) ? data.itemCounts : [];
  return {
    allCount: number(data.allCount),
    newCount: number(data.newCount),
    generalCount: number(data.generalCount),
    generalNewCount: number(data.generalNewCount),
    itemCounts: itemCounts.map((value) => {
      const item = record(value);
      return {
        itemId: text(item.itemId),
        itemNumber: text(item.itemNumber),
        totalCount: number(item.totalCount),
        newCount: number(item.newCount),
      };
    }),
  };
}

function questionReadReceipt(value: unknown): CloudQuestionReadReceipt {
  const data = record(value);
  return { contextId: text(data.contextId), marked: data.marked === true };
}

function staffFeed(value: unknown): StaffQuestionFeed {
  const data = record(value);
  const permissions = record(data.roomPermissions);
  return {
    roomTitle: text(data.roomTitle),
    roomStatus: data.roomStatus === "LIVE" || data.roomStatus === "ENDED" ? data.roomStatus : "READY",
    currentRole:
      data.currentRole === "ASSISTANT"
        ? "ASSISTANT"
        : data.currentRole === "ADMIN"
          ? "ADMIN"
          : "LEAD_INSTRUCTOR",
    roomPermissions: {
      questionOperations: permissions.questionOperations === true,
      checklistProgress: permissions.checklistProgress === true,
      capacityOperations: permissions.capacityOperations === true,
    },
    flowItems: (Array.isArray(data.flowItems) ? data.flowItems : []).map(flowItem),
    questions: (Array.isArray(data.questions) ? data.questions : []).map(question),
    summary: summary(data.summary),
  };
}

function studentFeed(value: unknown): StudentQuestionFeed {
  const data = record(value);
  return {
    roomTitle: text(data.roomTitle),
    roomStatus: data.roomStatus === "LIVE" || data.roomStatus === "ENDED" ? data.roomStatus : "READY",
    nickname: text(data.nickname),
    flowItems: (Array.isArray(data.flowItems) ? data.flowItems : []).map(flowItem),
    questions: (Array.isArray(data.questions) ? data.questions : []).map(question),
  };
}

function cloudQuestionPath(roomId: string) {
  return `/api/cloud/rooms/${encodeURIComponent(roomId)}/questions`;
}

export function csvExportFilename(contentDisposition: string | null) {
  const encoded = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = contentDisposition?.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = encoded ?? quoted ?? "";
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    return FALLBACK_CSV_FILENAME;
  }
  const filename = candidate.trim();
  return (
    filename
    && filename.toLowerCase().endsWith(".csv")
    && !/[\\/:*?"<>|]/.test(filename)
    && !hasControlCharacter(filename)
  )
    ? filename
    : FALLBACK_CSV_FILENAME;
}

export function csvExportErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if ([401, 403, 404, 409].includes(error.status)) {
      return "현재 채팅 기록을 내보낼 수 없습니다.";
    }
    if (error.status === 0) return "연결을 확인한 뒤 다시 시도해 주세요.";
  }
  return "채팅 기록을 내보내지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function studentQuestionPath(orgId: string, roomCode: string) {
  return `/api/public/rooms/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}/questions`;
}

export function toCloudQuestionInput(
  content: string,
  itemId: string | null,
  clientRequestId: string,
): CloudQuestionInput {
  return { content: content.trim(), itemId, clientRequestId };
}

export function createQuestionRequestId() {
  return globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    ?? `${Date.now()}${Math.random().toString(36).slice(2)}`;
}

export async function getCloudRoomQuestions(user: User | null, roomId: string) {
  return staffFeed(await requestApi<unknown>(cloudQuestionPath(roomId), { authUser: user }));
}

export async function getCloudRoomQuestionSummary(user: User | null, roomId: string) {
  return summary(await requestApi<unknown>(`${cloudQuestionPath(roomId)}/summary`, { authUser: user }));
}

export async function exportCloudRoomQuestionsCsv(
  user: User | null,
  roomId: string,
): Promise<CloudQuestionCsvExport> {
  const response = await requestBlobApiResponse(`${cloudQuestionPath(roomId)}/export`, {
    authUser: user,
    headers: { Accept: "text/csv, application/json" },
  });
  return {
    blob: response.blob,
    filename: csvExportFilename(response.contentDisposition),
  };
}

export async function answerCloudRoomQuestion(user: User | null, roomId: string, questionId: string, content: string) {
  return question(await requestApi<unknown>(`${cloudQuestionPath(roomId)}/${encodeURIComponent(questionId)}/answer`, {
    method: "POST", body: { content: content.trim() }, authUser: user,
  }));
}

export async function cancelCloudRoomQuestionAnswer(user: User | null, roomId: string, questionId: string) {
  return question(await requestApi<unknown>(`${cloudQuestionPath(roomId)}/${encodeURIComponent(questionId)}/answer`, {
    method: "DELETE", authUser: user,
  }));
}

export async function setCloudRoomQuestionHidden(user: User | null, roomId: string, questionId: string, hidden: boolean) {
  return question(await requestApi<unknown>(`${cloudQuestionPath(roomId)}/${encodeURIComponent(questionId)}/${hidden ? "hide" : "restore"}`, {
    method: "POST", authUser: user,
  }));
}

export async function markCloudRoomQuestionsRead(
  user: User | null,
  roomId: string,
  contextId: string,
  observedQuestionId: string,
) {
  return questionReadReceipt(await requestApi<unknown>(`${cloudQuestionPath(roomId)}/read`, {
    method: "POST", body: { contextId, observedQuestionId }, authUser: user,
  }));
}

export async function getStudentRoomQuestions(
  user: User | null,
  orgId: string,
  roomCode: string,
  signal?: AbortSignal,
) {
  return studentFeed(await requestApi<unknown>(studentQuestionPath(orgId, roomCode), {
    authUser: user,
    signal,
  }));
}

export async function createStudentRoomQuestion(
  user: User | null,
  orgId: string,
  roomCode: string,
  input: CloudQuestionInput,
) {
  return requestApi<unknown>(studentQuestionPath(orgId, roomCode), {
    method: "POST", body: input, authUser: user,
  });
}
