import type { User } from "firebase/auth";
import { requestApi } from "../../lib/api/apiClient";

export type CloudRoomFlowItem = {
  chapterId: string;
  chapterTitle: string;
  chapterPosition: number;
  itemId: string;
  itemTitle: string;
  itemDescription: string;
  sourcePageOrSlideNumbers?: number[];
  itemPosition: number;
  isCompleted: boolean;
};

export type CloudRoomSummary = {
  id: string;
  title: string;
  status: "READY" | "LIVE" | "ENDED";
  roomCode: string;
  sourceCourseId: string;
  sourceCourseRevision: number;
  sourceCourseTitle: string;
  leadInstructorDisplayNameSnapshot: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  downloadAvailableUntil?: string | null;
  revision: number;
  maxActiveParticipants?: number;
  relationship?: "CREATED" | "ASSIGNED";
  currentRole?: "LEAD_INSTRUCTOR" | "ASSISTANT" | "ADMIN";
  canReopen?: boolean;
};

export type CloudRoomRecord = CloudRoomSummary & {
  flowItems: CloudRoomFlowItem[];
  roomPermissions?: CloudRoomPermissions;
  currentItemId?: string | null;
  isComplete?: boolean;
};

export type CloudRoomPermissions = {
  questionOperations: boolean;
  checklistProgress: boolean;
  capacityOperations: boolean;
};

export type CloudRoomInstructor = {
  userId: string;
  displayName: string;
  role: "LEAD" | "ASSISTANT";
  permissions: CloudRoomPermissions;
};

export type CloudRoomInstructorCandidate = {
  userId: string;
  displayName: string;
  organizationRole: "ADMIN" | "INSTRUCTOR";
};

export type CloudRoomInstructorManagement = {
  roomId: string;
  revision: number;
  instructors: CloudRoomInstructor[];
  candidates: CloudRoomInstructorCandidate[];
};

export type CloudRoomCreateInput = {
  sourceCourseId: string;
  title: string;
  maxActiveParticipants: number;
};

export type CloudRoomCapacity = {
  activeParticipantCount: number;
  maxActiveParticipants: number;
  canManageCapacity: boolean;
  capacityAlert: {
    status: "PENDING";
    activeParticipantCount: number;
    maxActiveParticipants: number;
  } | null;
};

export type CloudRoomRevisionInput = {
  expectedRevision: number;
};

export type StudentAccessWindow =
  | "IMMEDIATE"
  | "ONE_DAY"
  | "SEVEN_DAYS"
  | "THIRTY_DAYS"
  | "CUSTOM";

export type CloudRoomEndInput = {
  studentAccessWindow: StudentAccessWindow;
  studentAccessUntil?: string;
};

export type CloudRoomShare = {
  roomId: string;
  orgId: string;
  roomCode: string;
  joinPath: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function number(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function roomPermissions(value: unknown): CloudRoomPermissions {
  const data = record(value);
  return {
    questionOperations: data.questionOperations === true,
    checklistProgress: data.checklistProgress === true,
    capacityOperations: data.capacityOperations === true,
  };
}

function cloudRoom(value: unknown): CloudRoomRecord {
  const data = record(value);
  const flowItems = Array.isArray(data.flowItems) ? data.flowItems : [];
  return {
    id: text(data.id),
    title: text(data.title),
    status:
      data.status === "LIVE" || data.status === "ENDED" ? data.status : "READY",
    roomCode: text(data.roomCode),
    sourceCourseId: text(data.sourceCourseId),
    sourceCourseRevision: number(data.sourceCourseRevision),
    sourceCourseTitle: text(data.sourceCourseTitle),
    leadInstructorDisplayNameSnapshot:
      typeof data.leadInstructorDisplayNameSnapshot === "string"
        ? data.leadInstructorDisplayNameSnapshot
        : null,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
    startedAt: typeof data.startedAt === "string" ? data.startedAt : null,
    endedAt: typeof data.endedAt === "string" ? data.endedAt : null,
    downloadAvailableUntil:
      typeof data.downloadAvailableUntil === "string"
        ? data.downloadAvailableUntil
        : null,
    revision: number(data.revision),
    maxActiveParticipants: validActiveParticipantCapacity(data.maxActiveParticipants)
      ? data.maxActiveParticipants
      : 50,
    relationship:
      data.relationship === "CREATED" || data.relationship === "ASSIGNED"
        ? data.relationship
        : undefined,
    currentRole:
      data.currentRole === "LEAD_INSTRUCTOR" || data.currentRole === "ASSISTANT" || data.currentRole === "ADMIN"
        ? data.currentRole
        : undefined,
    roomPermissions: roomPermissions(data.roomPermissions),
    currentItemId: typeof data.currentItemId === "string" ? data.currentItemId : null,
    isComplete: data.isComplete === true,
    canReopen: data.canReopen === true,
    flowItems: flowItems.map((value) => {
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
        isCompleted: item.isCompleted === true,
      };
    }),
  };
}

function cloudRoomInstructorManagement(value: unknown): CloudRoomInstructorManagement {
  const data = record(value);
  const instructors = Array.isArray(data.instructors) ? data.instructors : [];
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  return {
    roomId: text(data.roomId),
    revision: number(data.revision),
    instructors: instructors.flatMap((value) => {
      const item = record(value);
      if (item.role !== "LEAD" && item.role !== "ASSISTANT") return [];
      return [{
        userId: text(item.userId),
        displayName: text(item.displayName) || "이름 미등록",
        role: item.role,
        permissions: roomPermissions(item.permissions),
      }];
    }),
    candidates: candidates.flatMap((value) => {
      const item = record(value);
      if (item.organizationRole !== "ADMIN" && item.organizationRole !== "INSTRUCTOR") return [];
      return [{
        userId: text(item.userId),
        displayName: text(item.displayName) || "이름 미등록",
        organizationRole: item.organizationRole,
      }];
    }),
  };
}

function roomShare(value: unknown): CloudRoomShare {
  const data = record(value);
  return {
    roomId: text(data.roomId),
    orgId: text(data.orgId),
    roomCode: text(data.roomCode),
    joinPath: text(data.joinPath),
  };
}

export function toCloudRoomCreateInput(
  sourceCourseId: string,
  title: string,
  maxActiveParticipants = 50,
): CloudRoomCreateInput {
  return { sourceCourseId, title: title.trim(), maxActiveParticipants };
}

export function toCloudRoomRevisionInput(revision: number): CloudRoomRevisionInput {
  return { expectedRevision: revision };
}

export function isValidCloudRoomTitle(title: string) {
  const normalized = title.trim();
  return normalized.length >= 1 && normalized.length <= 100;
}

export function validActiveParticipantCapacity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 300;
}

function cloudRoomCapacity(value: unknown): CloudRoomCapacity {
  const data = record(value);
  const alert = record(data.capacityAlert);
  return {
    activeParticipantCount: typeof data.activeParticipantCount === "number" ? data.activeParticipantCount : 0,
    maxActiveParticipants: validActiveParticipantCapacity(data.maxActiveParticipants)
      ? data.maxActiveParticipants
      : 50,
    canManageCapacity: data.canManageCapacity === true,
    capacityAlert: alert.status === "PENDING"
      ? {
          status: "PENDING",
          activeParticipantCount: typeof alert.activeParticipantCount === "number" ? alert.activeParticipantCount : 0,
          maxActiveParticipants: validActiveParticipantCapacity(alert.maxActiveParticipants)
            ? alert.maxActiveParticipants
            : 50,
        }
      : null,
  };
}

export function cloudRoomShareLink(
  joinPath: string,
  origin = globalThis.location?.origin,
) {
  if (!origin || !joinPath.startsWith("/")) return joinPath;
  return new URL(joinPath, origin).toString();
}

export async function copyCloudRoomValue(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const element = document.createElement("textarea");
  element.value = value;
  element.setAttribute("readonly", "");
  element.style.position = "fixed";
  element.style.opacity = "0";
  document.body.append(element);
  element.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("복사 기능을 사용할 수 없습니다.");
    }
  } finally {
    element.remove();
  }
}

export async function listCloudRooms(user: User | null) {
  const payload = record(await requestApi<unknown>("/api/cloud/rooms", { authUser: user }));
  return (Array.isArray(payload.rooms) ? payload.rooms : []).map(cloudRoom);
}

export async function createCloudRoom(
  user: User | null,
  sourceCourseId: string,
  title: string,
  maxActiveParticipants = 50,
) {
  return cloudRoom(
    await requestApi<unknown>("/api/cloud/rooms", {
      method: "POST",
      body: toCloudRoomCreateInput(sourceCourseId, title, maxActiveParticipants),
      authUser: user,
    }),
  );
}

export async function getCloudRoomCapacity(user: User | null, roomId: string) {
  return cloudRoomCapacity(
    await requestApi<unknown>(`/api/cloud/rooms/${encodeURIComponent(roomId)}/capacity`, {
      authUser: user,
    }),
  );
}

export async function keepCloudRoomCapacity(user: User | null, roomId: string) {
  return cloudRoomCapacity(
    await requestApi<unknown>(`/api/cloud/rooms/${encodeURIComponent(roomId)}/capacity/keep`, {
      method: "POST",
      authUser: user,
    }),
  );
}

export async function increaseCloudRoomCapacity(
  user: User | null,
  roomId: string,
  maxActiveParticipants: number,
) {
  return cloudRoomCapacity(
    await requestApi<unknown>(`/api/cloud/rooms/${encodeURIComponent(roomId)}/capacity/increase`, {
      method: "POST",
      body: { maxActiveParticipants },
      authUser: user,
    }),
  );
}

export async function getCloudRoom(user: User | null, roomId: string) {
  return cloudRoom(
    await requestApi<unknown>(`/api/cloud/rooms/${encodeURIComponent(roomId)}`, {
      authUser: user,
    }),
  );
}

export async function getCloudRoomInstructorManagement(user: User | null, roomId: string) {
  return cloudRoomInstructorManagement(
    await requestApi<unknown>(`/api/cloud/rooms/${encodeURIComponent(roomId)}/instructors`, {
      authUser: user,
    }),
  );
}

async function mutateCloudRoomInstructors(
  user: User | null,
  roomId: string,
  path: string,
  body: Record<string, unknown>,
  method = "POST",
) {
  return cloudRoomInstructorManagement(
    await requestApi<unknown>(`/api/cloud/rooms/${encodeURIComponent(roomId)}/instructors/${path}`, {
      method,
      body,
      authUser: user,
    }),
  );
}

export async function addCloudRoomAssistant(
  user: User | null,
  roomId: string,
  targetUserId: string,
  expectedRevision: number,
) {
  return mutateCloudRoomInstructors(user, roomId, "assistants", { targetUserId, expectedRevision });
}

export async function updateCloudRoomAssistantPermissions(
  user: User | null,
  roomId: string,
  targetUserId: string,
  permissions: CloudRoomPermissions,
  expectedRevision: number,
) {
  return mutateCloudRoomInstructors(user, roomId, "assistants/permissions", { targetUserId, permissions, expectedRevision }, "PUT");
}

export async function grantCloudRoomAssistantFullAccess(
  user: User | null,
  roomId: string,
  targetUserId: string,
  expectedRevision: number,
) {
  return mutateCloudRoomInstructors(user, roomId, "assistants/full-access/grant", { targetUserId, expectedRevision });
}

export async function revokeCloudRoomAssistantFullAccess(
  user: User | null,
  roomId: string,
  targetUserId: string,
  expectedRevision: number,
) {
  return mutateCloudRoomInstructors(user, roomId, "assistants/full-access/revoke", { targetUserId, expectedRevision });
}

export async function removeCloudRoomAssistant(
  user: User | null,
  roomId: string,
  targetUserId: string,
  expectedRevision: number,
) {
  return mutateCloudRoomInstructors(user, roomId, "assistants", { targetUserId, expectedRevision }, "DELETE");
}

export async function transferCloudRoomLead(
  user: User | null,
  roomId: string,
  targetUserId: string,
  expectedRevision: number,
) {
  return cloudRoom(
    await requestApi<unknown>(`/api/cloud/rooms/${encodeURIComponent(roomId)}/instructors/lead-transfer`, {
      method: "POST",
      body: { targetUserId, expectedRevision },
      authUser: user,
    }),
  );
}

export async function getCloudRoomShare(user: User | null, roomId: string) {
  return roomShare(
    await requestApi<unknown>(
      `/api/cloud/rooms/${encodeURIComponent(roomId)}/share`,
      { authUser: user },
    ),
  );
}

export async function getCloudRoomChecklist(user: User | null, roomId: string) {
  return cloudRoom(
    await requestApi<unknown>(
      `/api/cloud/rooms/${encodeURIComponent(roomId)}/checklist`,
      { authUser: user },
    ),
  );
}

async function changeCloudRoomChecklist(
  user: User | null,
  path: string,
  expectedRevision: number,
) {
  return cloudRoom(
    await requestApi<unknown>(path, {
      method: "POST",
      body: toCloudRoomRevisionInput(expectedRevision),
      authUser: user,
    }),
  );
}

export async function startCloudRoom(
  user: User | null,
  roomId: string,
  expectedRevision: number,
) {
  return changeCloudRoomChecklist(
    user,
    `/api/cloud/rooms/${encodeURIComponent(roomId)}/start`,
    expectedRevision,
  );
}

export type CloudRoomEndSummary = {
  roomId: string;
  title: string;
  status: "ENDED";
  startedAt: string | null;
  endedAt: string | null;
  checklistCompletedCount: number;
  checklistTotalCount: number;
  completionRate: number;
  totalQuestionCount: number;
  answeredQuestionCount: number;
  participantCount: number;
  activeParticipantCount: number;
  downloadEnabled: boolean;
  downloadAvailableUntil: string | null;
};

export async function endCloudRoom(
  user: User | null,
  roomId: string,
  expectedRevision: number,
  input: CloudRoomEndInput,
) {
  return cloudRoom(
    await requestApi<unknown>(`/api/cloud/rooms/${encodeURIComponent(roomId)}/end`, {
      method: "POST",
      body: {
        expectedRevision,
        studentAccessWindow: input.studentAccessWindow,
        ...(input.studentAccessUntil
          ? { studentAccessUntil: input.studentAccessUntil }
          : {}),
      },
      authUser: user,
    }),
  );
}

export async function reopenCloudRoom(
  user: User | null,
  roomId: string,
  expectedRevision: number,
) {
  return cloudRoom(
    await requestApi<unknown>(`/api/cloud/rooms/${encodeURIComponent(roomId)}/reopen`, {
      method: "POST",
      body: toCloudRoomRevisionInput(expectedRevision),
      authUser: user,
    }),
  );
}

export async function getCloudRoomEndSummary(user: User | null, roomId: string) {
  return requestApi<CloudRoomEndSummary>(
    `/api/cloud/rooms/${encodeURIComponent(roomId)}/end-summary`,
    { authUser: user },
  );
}

export async function completeCloudRoomChecklistItem(
  user: User | null,
  roomId: string,
  itemId: string,
  expectedRevision: number,
) {
  return changeCloudRoomChecklist(
    user,
    `/api/cloud/rooms/${encodeURIComponent(roomId)}/checklist/${encodeURIComponent(itemId)}/complete`,
    expectedRevision,
  );
}

export async function undoCloudRoomChecklistItem(
  user: User | null,
  roomId: string,
  itemId: string,
  expectedRevision: number,
) {
  return changeCloudRoomChecklist(
    user,
    `/api/cloud/rooms/${encodeURIComponent(roomId)}/checklist/${encodeURIComponent(itemId)}/undo`,
    expectedRevision,
  );
}
