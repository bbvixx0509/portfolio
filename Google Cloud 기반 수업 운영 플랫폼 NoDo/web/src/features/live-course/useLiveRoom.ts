import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
  type Timestamp,
} from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { getLocalFirebaseFirestore } from "../../lib/firebase/firebaseFirestore";
import type { AuthProfile } from "../auth/authTypes";
import {
  createEmptyPermissions,
  normalizePermissions,
  type RoomPermissions,
} from "../auth/authTypes";
import type {
  LiveChapter,
  LiveCourseItem,
  LiveRoom,
} from "./liveCourseTypes";

function stringValue(data: DocumentData, key: string, fallback = "") {
  return typeof data[key] === "string" ? data[key] : fallback;
}

function numberValue(data: DocumentData, key: string, fallback = 0) {
  return typeof data[key] === "number" ? data[key] : fallback;
}

function parseRoom(id: string, data: DocumentData): LiveRoom {
  const itemOrder = Array.isArray(data.itemOrder)
    ? data.itemOrder.filter((value: unknown): value is string => typeof value === "string")
    : [];
  return {
    id,
    orgId: stringValue(data, "orgId"),
    courseId: stringValue(data, "courseId"),
    title: stringValue(data, "title", "NoDo 실시간 강의"),
    leadInstructorId: stringValue(data, "leadInstructorId"),
    status: stringValue(data, "status", "PREPARING"),
    currentItemId: typeof data.currentItemId === "string" ? data.currentItemId : null,
    itemOrder,
  };
}

function parseChapter(id: string, data: DocumentData): LiveChapter {
  return {
    id,
    title: stringValue(data, "title", "이름 없는 챕터"),
    order: numberValue(data, "order"),
  };
}

function parseItem(id: string, data: DocumentData): LiveCourseItem {
  return {
    id,
    chapterId: stringValue(data, "chapterId"),
    title: stringValue(data, "title", "이름 없는 항목"),
    description: stringValue(data, "description"),
    materialLabel: stringValue(data, "materialLabel", stringValue(data, "title", "항목")),
    kind: stringValue(data, "kind", "SLIDE"),
    order: numberValue(data, "order"),
    isCompleted: data.isCompleted === true,
  };
}

function timeValue(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as Timestamp).toDate().toISOString();
  }
  return typeof value === "string" ? value : null;
}

export type LiveRoomState = {
  room: LiveRoom | null;
  courseTitle: string;
  chapters: LiveChapter[];
  items: LiveCourseItem[];
  permissions: RoomPermissions;
  permissionUpdatedAt: string | null;
  isLead: boolean;
  roomRole: "LEAD" | "ASSISTANT" | null;
  isLoading: boolean;
  error: string | null;
};

export function useLiveRoom(
  roomId: string,
  profile: AuthProfile | null,
): LiveRoomState {
  const [room, setRoom] = useState<LiveRoom | null>(null);
  const [courseTitle, setCourseTitle] = useState("NoDo 실시간 강의");
  const [chapters, setChapters] = useState<LiveChapter[]>([]);
  const [items, setItems] = useState<LiveCourseItem[]>([]);
  const [staffPermissions, setStaffPermissions] = useState(createEmptyPermissions);
  const [permissionUpdatedAt, setPermissionUpdatedAt] = useState<string | null>(null);
  const [hasStaffRelation, setHasStaffRelation] = useState(false);
  const [isRoomLoading, setIsRoomLoading] = useState(true);
  const [settledRoomId, setSettledRoomId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsRoomLoading(true);
    setSettledRoomId(null);
    setError(null);
    setRoom(null);
    setCourseTitle("NoDo 실시간 강의");
    setChapters([]);
    setItems([]);
    return onSnapshot(
      doc(getLocalFirebaseFirestore(), "rooms", roomId),
      (snapshot) => {
        if (!snapshot.exists()) {
          setRoom(null);
          setError("강의방을 찾을 수 없습니다.");
        } else {
          setRoom(parseRoom(snapshot.id, snapshot.data()));
        }
        setSettledRoomId(roomId);
        setIsRoomLoading(false);
      },
      (snapshotError) => {
        setRoom(null);
        setError(snapshotError.message);
        setSettledRoomId(roomId);
        setIsRoomLoading(false);
      },
    );
  }, [roomId]);

  useEffect(() => {
    if (!room?.courseId) {
      setChapters([]);
      setItems([]);
      return;
    }
    const firestore = getLocalFirebaseFirestore();
    const unsubscribers = [
      onSnapshot(
        doc(firestore, "courses", room.courseId),
        (snapshot) => {
          if (snapshot.exists()) {
            setCourseTitle(stringValue(snapshot.data(), "title", room.title));
          }
        },
        (snapshotError) => setError(snapshotError.message),
      ),
      onSnapshot(
        collection(firestore, "courses", room.courseId, "chapters"),
        (snapshot) => {
          setChapters(
            snapshot.docs
              .map((chapter) => parseChapter(chapter.id, chapter.data()))
              .sort((first, second) => first.order - second.order),
          );
        },
        (snapshotError) => setError(snapshotError.message),
      ),
      onSnapshot(
        collection(firestore, "courses", room.courseId, "items"),
        (snapshot) => {
          setItems(snapshot.docs.map((item) => parseItem(item.id, item.data())));
        },
        (snapshotError) => setError(snapshotError.message),
      ),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [room?.courseId, room?.title]);

  const activeRoom =
    settledRoomId === roomId && room?.id === roomId ? room : null;

  useEffect(() => {
    setStaffPermissions(createEmptyPermissions());
    setPermissionUpdatedAt(null);
    setHasStaffRelation(false);
    if (
      !profile ||
      profile.accountType !== "STAFF" ||
      !activeRoom ||
      profile.orgId !== activeRoom.orgId ||
      profile.uid === activeRoom.leadInstructorId
    ) {
      return;
    }
    return onSnapshot(
      doc(getLocalFirebaseFirestore(), "rooms", roomId, "staff", profile.uid),
      (snapshot) => {
        if (!snapshot.exists()) {
          setStaffPermissions(createEmptyPermissions());
          setPermissionUpdatedAt(null);
          setHasStaffRelation(false);
          return;
        }
        const data = snapshot.data();
        setHasStaffRelation(true);
        setStaffPermissions(normalizePermissions(data.permissions));
        setPermissionUpdatedAt(timeValue(data.updatedAt));
      },
      () => {
        setHasStaffRelation(false);
        setStaffPermissions(createEmptyPermissions());
        setPermissionUpdatedAt(null);
      },
    );
  }, [activeRoom, profile, roomId]);

  const isLead = Boolean(
    profile &&
      activeRoom &&
      profile.accountType === "STAFF" &&
      profile.orgId === activeRoom.orgId &&
      profile.uid === activeRoom.leadInstructorId,
  );
  const roomRole = activeRoom
    ? isLead
      ? "LEAD"
      : hasStaffRelation
        ? "ASSISTANT"
        : null
    : null;
  const permissions = useMemo(() => {
    if (!activeRoom) return createEmptyPermissions();
    if (isLead) {
      return Object.fromEntries(
        Object.keys(createEmptyPermissions()).map((key) => [key, true]),
      ) as RoomPermissions;
    }
    return staffPermissions;
  }, [activeRoom, isLead, staffPermissions]);

  const orderedItems = useMemo(() => {
    if (!activeRoom) return [];
    if (activeRoom.itemOrder.length === 0) {
      return [...items].sort((first, second) => first.order - second.order);
    }
    const orderById = new Map(activeRoom.itemOrder.map((id, index) => [id, index]));
    return [...items].sort(
      (first, second) =>
        (orderById.get(first.id) ?? Number.MAX_SAFE_INTEGER) -
        (orderById.get(second.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [activeRoom, items]);

  return {
    room: activeRoom,
    courseTitle: activeRoom ? courseTitle : "NoDo 실시간 강의",
    chapters: activeRoom ? chapters : [],
    items: orderedItems,
    permissions,
    permissionUpdatedAt,
    isLead,
    roomRole,
    isLoading: isRoomLoading || settledRoomId !== roomId,
    error,
  };
}
