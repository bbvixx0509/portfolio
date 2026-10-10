import type { User } from "firebase/auth";
import { ApiError, requestApi } from "../../lib/api/apiClient";

export type StudentAssistantReply = {
  reply: string;
  context: {
    itemId: string | null;
    itemTitle: string | null;
  };
  notice: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function reply(value: unknown): StudentAssistantReply {
  const data = record(value);
  const context = record(data.context);
  if (typeof data.reply !== "string" || !data.reply.trim()) {
    throw new Error("AI 도우미 답변을 확인하지 못했습니다.");
  }
  return {
    reply: data.reply,
    context: {
      itemId: typeof context.itemId === "string" ? context.itemId : null,
      itemTitle: typeof context.itemTitle === "string" ? context.itemTitle : null,
    },
    notice: typeof data.notice === "string" ? data.notice : "AI 답변은 학습 보조용입니다.",
  };
}

function path(orgId: string, roomCode: string) {
  return `/api/public/rooms/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}/ai-assistant`;
}

export function studentAssistantErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if ([401, 403, 404, 409].includes(error.status)) {
      return "현재 강의방에서는 AI 도우미를 이용할 수 없습니다.";
    }
    if (error.status >= 500) {
      return "AI 도우미가 답변을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
    if (error.status === 0) return "연결을 확인한 뒤 다시 시도해 주세요.";
    return "질문 내용을 확인한 뒤 다시 시도해 주세요.";
  }
  return "AI 도우미가 답변을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export async function askStudentRoomAssistant(
  user: User | null,
  orgId: string,
  roomCode: string,
  content: string,
  itemId: string | null,
) {
  return reply(await requestApi<unknown>(path(orgId, roomCode), {
    method: "POST",
    authUser: user,
    body: { content: content.trim(), itemId },
  }));
}
