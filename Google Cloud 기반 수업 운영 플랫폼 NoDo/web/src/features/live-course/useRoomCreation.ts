import type { User } from "firebase/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestApi } from "../../lib/api/apiClient";

type RoomCreationOptions = {
  authUser: User | null;
  onCreated: (roomId: string) => void;
  onNotice: (message: string) => void;
};

function readRoomId(payload: Record<string, unknown>) {
  const room =
    payload.room && typeof payload.room === "object"
      ? (payload.room as Record<string, unknown>)
      : payload;
  if (typeof room.roomId === "string") return room.roomId;
  if (typeof room.id === "string") return room.id;
  return null;
}

export function useRoomCreation({
  authUser,
  onCreated,
  onNotice,
}: RoomCreationOptions) {
  const [pendingCourseId, setPendingCourseId] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const createRoom = useCallback(
    async (courseId: string) => {
      // React 상태 반영 전 같은 이벤트 루프에서 다시 눌러도 요청을 보내지 않는다.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      if (isMountedRef.current) {
        setPendingCourseId(courseId);
        onNotice("강의방을 생성하고 있습니다.");
      }

      try {
        const payload = await requestApi<Record<string, unknown>>(
          `/api/courses/${encodeURIComponent(courseId)}/rooms`,
          { method: "POST", body: {}, authUser },
        );
        const roomId = readRoomId(payload);
        if (!roomId) {
          throw new Error("생성된 강의방 ID를 확인할 수 없습니다.");
        }
        if (isMountedRef.current) onCreated(roomId);
      } catch (error) {
        if (isMountedRef.current) {
          onNotice(
            error instanceof Error
              ? error.message
              : "강의방을 만들지 못했습니다.",
          );
        }
      } finally {
        inFlightRef.current = false;
        if (isMountedRef.current) setPendingCourseId(null);
      }
    },
    [authUser, onCreated, onNotice],
  );

  return { createRoom, pendingCourseId };
}
