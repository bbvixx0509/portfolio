import { describe, expect, it } from "vitest";
import {
  normalizeLiveQuestion,
  questionContextId,
  questionIsUnread,
} from "./useLiveQuestions";

describe("실시간 공개 질문 정규화", () => {
  it("공개 필드와 답변 표시 정보만 정규화하고 문맥 스냅샷을 유지한다", () => {
    const question = normalizeLiveQuestion("question-one", {
      roomId: "room-one",
      courseId: "course-one",
      orgId: "org-one",
      content: "스냅샷 질문",
      nicknameSnapshot: "익명 판다",
      isGeneral: false,
      itemId: "item-one",
      itemNumberSnapshot: "2.3",
      itemTitleSnapshot: "질문 당시 제목",
      chapterTitleSnapshot: "질문 당시 챕터",
      materialLabelSnapshot: "슬라이드 3",
      visibility: "PUBLIC",
      moderationStatus: "APPROVED",
      isAnswered: true,
      answer: {
        content: "강사 답변",
        staffDisplayName: "김강사",
        staffRole: "LEAD_INSTRUCTOR",
        answeredAt: "2026-07-15T02:00:00.000Z",
        staffUid: "private-answer-uid",
      },
      isHidden: false,
      createdAt: "2026-07-15T01:00:00.000Z",
      updatedAt: "2026-07-15T02:00:00.000Z",
      schemaVersion: 1,
      authorUid: "private-author-uid",
      email: "private@nodo.test",
    });

    expect(question.itemTitleSnapshot).toBe("질문 당시 제목");
    expect(question.itemNumberSnapshot).toBe("2.3");
    expect(question.answer).toEqual(
      expect.objectContaining({
        content: "강사 답변",
        instructorDisplayName: "김강사",
        roomRole: "LEAD",
      }),
    );
    expect(question).not.toHaveProperty("authorUid");
    expect(question).not.toHaveProperty("email");
    expect(question.answer).not.toHaveProperty("staffUid");
  });

  it("GENERAL·항목 context와 ALL fallback으로 미확인을 계산한다", () => {
    const itemQuestion = normalizeLiveQuestion("item-question", {
      content: "항목 질문",
      itemId: "item-one",
      createdAt: "2026-07-15T03:00:00.000Z",
    });
    const generalQuestion = normalizeLiveQuestion("general-question", {
      content: "일반 질문",
      isGeneral: true,
      createdAt: "2026-07-15T03:00:00.000Z",
    });
    expect(questionContextId(itemQuestion)).toBe("item-one");
    expect(questionContextId(generalQuestion)).toBe("GENERAL");
    expect(questionIsUnread(itemQuestion, {
      "item-one": {
        observedAtMillis: Date.parse("2026-07-15T02:00:00.000Z"),
        observedQuestionId: "older-question",
      },
    })).toBe(true);
    expect(questionIsUnread(itemQuestion, {
      ALL: {
        observedAtMillis: Date.parse("2026-07-15T04:00:00.000Z"),
        observedQuestionId: "newer-question",
      },
    })).toBe(false);
    expect(questionIsUnread(itemQuestion, {
      ALL: {
        observedAtMillis: itemQuestion.createdAtMillis,
        observedQuestionId: "item-question",
      },
    })).toBe(false);
    expect(questionIsUnread(itemQuestion, {
      ALL: {
        observedAtMillis: itemQuestion.createdAtMillis,
        observedQuestionId: "earlier-at-same-time",
      },
    })).toBe(true);
  });

  it("새 roomRole을 우선하고 과거 답변 역할은 호환 규칙으로 변환한다", () => {
    const current = normalizeLiveQuestion("current", {
      isAnswered: true,
      answer: {
        content: "현재 답변",
        roomRole: "ASSISTANT",
        staffRole: "LEAD_INSTRUCTOR",
      },
    });
    const legacy = normalizeLiveQuestion("legacy", {
      isAnswered: true,
      answer: {
        content: "과거 답변",
        instructorRole: "ASSISTANT_INSTRUCTOR",
      },
    });

    expect(current.answer?.roomRole).toBe("ASSISTANT");
    expect(legacy.answer?.roomRole).toBe("ASSISTANT");
  });
});
