import {
  collection,
  doc,
  onSnapshot,
  query,
  type DocumentData,
  type QueryConstraint,
  type Timestamp,
  where,
} from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { getLocalFirebaseFirestore } from "../../lib/firebase/firebaseFirestore";
import type { AuthProfile } from "../auth/authTypes";
import type {
  LiveQuestion,
  LiveQuestionAnswer,
  QuestionModerationStatus,
  QuestionVisibility,
} from "./liveCourseTypes";

function stringValue(data: DocumentData, key: string, fallback = "") {
  return typeof data[key] === "string" ? data[key] : fallback;
}

function nullableString(data: DocumentData, key: string) {
  return typeof data[key] === "string" ? data[key] : null;
}

function timestampValue(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value) {
    const date = (value as Timestamp).toDate();
    return { iso: date.toISOString(), millis: date.getTime() };
  }
  if (typeof value === "string") {
    const millis = Date.parse(value);
    return { iso: value, millis: Number.isNaN(millis) ? 0 : millis };
  }
  return { iso: null, millis: 0 };
}

function normalizeAnswer(data: DocumentData): LiveQuestionAnswer | null {
  if (!data.isAnswered) return null;
  const answer =
    data.answer && typeof data.answer === "object"
      ? (data.answer as DocumentData)
      : data;
  const content = stringValue(answer, "content", stringValue(data, "answer"));
  if (!content) return null;
  const storedRoomRole = stringValue(answer, "roomRole");
  const legacyRole = stringValue(
    answer,
    "staffRole",
    stringValue(answer, "instructorRole", stringValue(answer, "role")),
  );
  const roomRole =
    storedRoomRole === "LEAD" || storedRoomRole === "ASSISTANT"
      ? storedRoomRole
      : legacyRole === "ASSISTANT_INSTRUCTOR"
        ? "ASSISTANT"
        : "LEAD";
  return {
    content,
    instructorDisplayName: stringValue(
      answer,
      "staffDisplayName",
      stringValue(
        answer,
        "instructorDisplayName",
        stringValue(answer, "displayName", "강사"),
      ),
    ),
    roomRole,
    answeredAt: timestampValue(answer.answeredAt ?? data.answeredAt).iso,
  };
}

export function normalizeLiveQuestion(
  id: string,
  data: DocumentData,
): LiveQuestion {
  const createdAt = timestampValue(data.createdAt);
  const moderationStatus = stringValue(
    data,
    "moderationStatus",
    "APPROVED",
  ) as QuestionModerationStatus;
  const visibility = stringValue(
    data,
    "visibility",
    "PUBLIC",
  ) as QuestionVisibility;
  return {
    id,
    roomId: stringValue(data, "roomId"),
    courseId: stringValue(data, "courseId"),
    orgId: stringValue(data, "orgId"),
    content: stringValue(data, "content"),
    nicknameSnapshot: stringValue(data, "nicknameSnapshot", "익명 수강생"),
    isGeneral: data.isGeneral === true,
    itemId: nullableString(data, "itemId"),
    itemNumberSnapshot: nullableString(data, "itemNumberSnapshot"),
    itemTitleSnapshot: nullableString(data, "itemTitleSnapshot"),
    chapterTitleSnapshot: nullableString(data, "chapterTitleSnapshot"),
    materialLabelSnapshot: nullableString(data, "materialLabelSnapshot"),
    visibility,
    moderationStatus,
    isAnswered: data.isAnswered === true,
    answer: normalizeAnswer(data),
    isHidden: data.isHidden === true,
    createdAt: createdAt.iso,
    updatedAt: timestampValue(data.updatedAt).iso,
    createdAtMillis: createdAt.millis,
    schemaVersion:
      typeof data.schemaVersion === "number" ? data.schemaVersion : 1,
  };
}

export type QuestionReadWatermark = {
  observedAtMillis: number;
  observedQuestionId: string;
};

function readWatermark(data: DocumentData): QuestionReadWatermark {
  return {
    observedAtMillis: timestampValue(
      data.readAt ?? data.lastReadAt ?? data.updatedAt,
    ).millis,
    observedQuestionId: stringValue(data, "lastReadQuestionId"),
  };
}

export type UseLiveQuestionsOptions = {
  canModerateQuestions: boolean;
  canReadQuestions: boolean;
  profile: AuthProfile | null;
};

export function useLiveQuestions(
  roomId: string,
  options: UseLiveQuestionsOptions,
) {
  const [questions, setQuestions] = useState<LiveQuestion[]>([]);
  const [readWatermarkByContext, setReadWatermarkByContext] = useState<
    Record<string, QuestionReadWatermark>
  >({});
  const [isQuestionRestricted, setIsQuestionRestricted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!options.canReadQuestions || !roomId) {
      setQuestions([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    // 검토 권한이 회수되면 이전 STAFF_ONLY 스냅샷이 다음 쿼리 결과를
    // 기다리는 동안 잠깐 남지 않도록 즉시 비운다.
    setQuestions([]);
    const base = collection(
      getLocalFirebaseFirestore(),
      "rooms",
      roomId,
      "questions",
    );
    const constraintsBySubscription: QueryConstraint[][] = options.canModerateQuestions
      ? [
          [where("visibility", "==", "PUBLIC")],
          [where("visibility", "==", "STAFF_ONLY")],
        ]
      : [
          [
            where("visibility", "==", "PUBLIC"),
            where("isHidden", "==", false),
          ],
        ];
    const results = constraintsBySubscription.map(
      () => new Map<string, LiveQuestion>(),
    );
    const loaded = constraintsBySubscription.map(() => false);
    const publish = () => {
      const merged = new Map<string, LiveQuestion>();
      for (const result of results) {
        for (const [id, question] of result) merged.set(id, question);
      }
      setQuestions(
        [...merged.values()].sort((first, second) =>
          compareQuestionKeys(
            {
              observedAtMillis: first.createdAtMillis,
              observedQuestionId: first.id,
            },
            {
              observedAtMillis: second.createdAtMillis,
              observedQuestionId: second.id,
            },
          ),
        ),
      );
      if (loaded.every(Boolean)) setIsLoading(false);
    };
    const unsubscribers = constraintsBySubscription.map(
      (constraints, index) =>
        onSnapshot(
          query(base, ...constraints),
          (snapshot) => {
            results[index] = new Map(
              snapshot.docs.map((entry) => [
                entry.id,
                normalizeLiveQuestion(entry.id, entry.data()),
              ]),
            );
            loaded[index] = true;
            publish();
          },
          (snapshotError) => {
            setError(snapshotError.message);
            setIsLoading(false);
          },
        ),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [options.canModerateQuestions, options.canReadQuestions, roomId]);

  const isRoomStaff =
    options.profile?.accountType === "STAFF" && options.canReadQuestions;

  useEffect(() => {
    if (!isRoomStaff || !options.profile || !roomId) {
      setReadWatermarkByContext({});
      return;
    }
    return onSnapshot(
      collection(
        getLocalFirebaseFirestore(),
        "rooms",
        roomId,
        "questionReads",
        options.profile.uid,
        "contexts",
      ),
      (snapshot) => {
        setReadWatermarkByContext(
          Object.fromEntries(
            snapshot.docs.map((entry) => [
              stringValue(entry.data(), "contextId", entry.id),
              readWatermark(entry.data()),
            ]),
          ),
        );
      },
      () => setReadWatermarkByContext({}),
    );
  }, [isRoomStaff, options.profile, roomId]);

  useEffect(() => {
    if (options.profile?.accountType !== "STUDENT" || !roomId) {
      setIsQuestionRestricted(false);
      return;
    }
    return onSnapshot(
      doc(
        getLocalFirebaseFirestore(),
        "rooms",
        roomId,
        "participants",
        options.profile.uid,
      ),
      (snapshot) => {
        const data = snapshot.data();
        setIsQuestionRestricted(
          Boolean(
            data?.isQuestionRestricted === true ||
              data?.questionRestricted === true,
          ),
        );
      },
      () => setIsQuestionRestricted(false),
    );
  }, [options.profile, roomId]);

  return useMemo(
    () => ({
      questions,
      readWatermarkByContext,
      isQuestionRestricted,
      isLoading,
      error,
    }),
    [
      error,
      isLoading,
      isQuestionRestricted,
      questions,
      readWatermarkByContext,
    ],
  );
}

export function questionContextId(question: Pick<LiveQuestion, "isGeneral" | "itemId">) {
  return question.isGeneral || !question.itemId ? "GENERAL" : question.itemId;
}

export function questionIsUnread(
  question: LiveQuestion,
  readWatermarkByContext: Record<string, QuestionReadWatermark>,
) {
  const emptyWatermark: QuestionReadWatermark = {
    observedAtMillis: 0,
    observedQuestionId: "",
  };
  const contextWatermark =
    readWatermarkByContext[questionContextId(question)] ?? emptyWatermark;
  const allWatermark = readWatermarkByContext.ALL ?? emptyWatermark;
  const readWatermark =
    compareQuestionKeys(contextWatermark, allWatermark) >= 0
      ? contextWatermark
      : allWatermark;
  return (
    compareQuestionKeys(
      {
        observedAtMillis: question.createdAtMillis,
        observedQuestionId: question.id,
      },
      readWatermark,
    ) > 0
  );
}

export function compareQuestionKeys(
  first: QuestionReadWatermark,
  second: QuestionReadWatermark,
) {
  if (first.observedAtMillis !== second.observedAtMillis) {
    return first.observedAtMillis - second.observedAtMillis;
  }
  if (first.observedQuestionId === second.observedQuestionId) return 0;
  return first.observedQuestionId > second.observedQuestionId ? 1 : -1;
}
