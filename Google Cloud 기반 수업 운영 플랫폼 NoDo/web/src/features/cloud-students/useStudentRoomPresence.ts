import type { User } from "firebase/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import { heartbeatStudentPresence, leaveStudentRoom } from "./cloudStudentApi";

const HEARTBEAT_MIN_MS = 28_000;
const HEARTBEAT_JITTER_MS = 4_000;

function nextHeartbeatDelay() {
  return HEARTBEAT_MIN_MS + Math.round(Math.random() * HEARTBEAT_JITTER_MS);
}

/** Keeps one visible student screen present without creating hidden background loops. */
export function useStudentRoomPresence(
  user: User | null,
  orgId: string,
  roomCode: string,
) {
  const timerRef = useRef<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const stoppedRef = useRef(false);
  const [leaving, setLeaving] = useState(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    if (!user) return undefined;

    const schedule = () => {
      clearTimer();
      if (stoppedRef.current || document.visibilityState !== "visible") return;
      timerRef.current = window.setTimeout(() => void heartbeat(), nextHeartbeatDelay());
    };
    const heartbeat = async () => {
      if (stoppedRef.current || inFlightRef.current || document.visibilityState !== "visible") return;
      inFlightRef.current = true;
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        await heartbeatStudentPresence(user, orgId, roomCode, controller.signal);
      } catch {
        // The read-only screen keeps its last state; the next visible heartbeat retries.
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        inFlightRef.current = false;
        schedule();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void heartbeat();
      else {
        clearTimer();
        controllerRef.current?.abort();
      }
    };

    void heartbeat();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stoppedRef.current = true;
      clearTimer();
      controllerRef.current?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [clearTimer, orgId, roomCode, user]);

  const leave = useCallback(async () => {
    if (!user || leaving) return;
    stoppedRef.current = true;
    clearTimer();
    controllerRef.current?.abort();
    setLeaving(true);
    try {
      await leaveStudentRoom(user, orgId, roomCode);
    } finally {
      setLeaving(false);
    }
  }, [clearTimer, leaving, orgId, roomCode, user]);

  return { leave, leaving };
}
