import type { User } from "firebase/auth";
import { requestApi } from "../../lib/api/apiClient";

export type PublicRoom = {
  title: string;
  status: "READY" | "LIVE" | "ENDED";
  joinAllowed: true;
};

export type StudentParticipantSession = {
  nickname: string;
  roomTitle: string;
  roomStatus: "READY" | "LIVE" | "ENDED";
  participantStatus: "JOINED";
  accessMode?: "ACTIVE" | "READ_ONLY";
};

export type StudentPresenceReceipt = {
  presenceStatus: "ACTIVE";
};

export type StudentChecklistItem = {
  chapterId: string;
  chapterTitle: string;
  chapterPosition: number;
  itemId: string;
  itemTitle: string;
  itemDescription: string;
  sourcePageOrSlideNumbers?: number[];
  itemPosition: number;
  itemNumber: string;
  isCompleted: boolean;
};

export type StudentRoomChecklist = {
  roomTitle: string;
  roomStatus: "READY" | "LIVE" | "ENDED";
  flowItems: StudentChecklistItem[];
  currentItemId: string | null;
  isComplete: boolean;
  summary: {
    allCount: number;
    itemCounts: Array<{ itemId: string; totalCount: number }>;
  };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function publicRoom(value: unknown): PublicRoom {
  const data = record(value);
  if (
    typeof data.title !== "string" ||
    !data.title.trim() ||
    (data.status !== "READY" && data.status !== "LIVE") ||
    data.joinAllowed !== true
  ) {
    throw new Error("강의방 정보를 확인하지 못했습니다.");
  }
  return { title: data.title, status: data.status, joinAllowed: true };
}

function studentSession(value: unknown): StudentParticipantSession {
  const data = record(value);
  if (
    typeof data.nickname !== "string" ||
    typeof data.roomTitle !== "string" ||
    (data.roomStatus !== "READY" && data.roomStatus !== "LIVE") ||
    data.participantStatus !== "JOINED"
  ) {
    throw new Error("참여 정보를 확인하지 못했습니다.");
  }
  return {
    nickname: data.nickname,
    roomTitle: data.roomTitle,
    roomStatus: data.roomStatus,
    participantStatus: "JOINED",
  };
}

function studentPresenceReceipt(value: unknown): StudentPresenceReceipt {
  const data = record(value);
  if (data.presenceStatus !== "ACTIVE") {
    throw new Error("참여 상태를 갱신하지 못했습니다.");
  }
  return { presenceStatus: "ACTIVE" };
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function number(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function studentChecklist(value: unknown): StudentRoomChecklist {
  const data = record(value);
  const flowItems = Array.isArray(data.flowItems) ? data.flowItems : [];
  const summary = record(data.summary);
  const itemCounts = Array.isArray(summary.itemCounts) ? summary.itemCounts : [];
  if (
    !text(data.roomTitle) ||
    (data.roomStatus !== "READY" && data.roomStatus !== "LIVE" && data.roomStatus !== "ENDED")
  ) {
    throw new Error("학생 로드맵을 확인하지 못했습니다.");
  }
  return {
    roomTitle: text(data.roomTitle),
    roomStatus: data.roomStatus,
    currentItemId: typeof data.currentItemId === "string" ? data.currentItemId : null,
    isComplete: data.isComplete === true,
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
        itemNumber: text(item.itemNumber),
        isCompleted: item.isCompleted === true,
      };
    }),
    summary: {
      allCount: number(summary.allCount),
      itemCounts: itemCounts.map((value) => {
        const count = record(value);
        return { itemId: text(count.itemId), totalCount: number(count.totalCount) };
      }),
    },
  };
}

function roomPath(orgId: string, roomCode: string) {
  return `/api/public/rooms/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}`;
}

export async function loadPublicRoom(orgId: string, roomCode: string) {
  return publicRoom(await requestApi<unknown>(roomPath(orgId, roomCode)));
}

export async function joinPublicRoom(
  user: User,
  orgId: string,
  roomCode: string,
  nickname: string,
) {
  return studentSession(
    await requestApi<unknown>(`${roomPath(orgId, roomCode)}/participants`, {
      method: "POST",
      body: { nickname },
      authUser: user,
    }),
  );
}

export async function loadStudentParticipantSession(
  user: User,
  orgId: string,
  roomCode: string,
  signal?: AbortSignal,
) {
  return studentSession(
    await requestApi<unknown>(`${roomPath(orgId, roomCode)}/session`, {
      authUser: user,
      signal,
    }),
  );
}

export async function heartbeatStudentPresence(
  user: User,
  orgId: string,
  roomCode: string,
  signal?: AbortSignal,
) {
  return studentPresenceReceipt(
    await requestApi<unknown>(`${roomPath(orgId, roomCode)}/heartbeat`, {
      method: "POST",
      authUser: user,
      signal,
    }),
  );
}

export async function leaveStudentRoom(
  user: User,
  orgId: string,
  roomCode: string,
) {
  const data = record(
    await requestApi<unknown>(`${roomPath(orgId, roomCode)}/leave`, {
      method: "POST",
      authUser: user,
    }),
  );
  if (typeof data.left !== "boolean") {
    throw new Error("강의방 나가기 상태를 확인하지 못했습니다.");
  }
  return { left: data.left };
}

export async function loadStudentRoomChecklist(
  user: User | null,
  orgId: string,
  roomCode: string,
  signal?: AbortSignal,
) {
  return studentChecklist(
    await requestApi<unknown>(`${roomPath(orgId, roomCode)}/checklist`, {
      authUser: user,
      signal,
    }),
  );
}
