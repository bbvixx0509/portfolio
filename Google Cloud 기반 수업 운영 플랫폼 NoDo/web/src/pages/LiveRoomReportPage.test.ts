import { describe, expect, it } from "vitest";
import { normalizeRoomSummary } from "./LiveRoomReportPage";

describe("LiveRoomReportPage 요약 정규화", () => {
  it("종료 요약과 항목별 질문 수를 공개 표시 구조로 변환한다", () => {
    const summary = normalizeRoomSummary({
      roomId: "room-one",
      roomTitle: "NoDo 실습",
      participantCount: 12,
      totalQuestionCount: 8,
      publicQuestionCount: 6,
      reviewQuestionCount: 1,
      hiddenQuestionCount: 1,
      answeredQuestionCount: 5,
      unansweredQuestionCount: 3,
      checklistTotalCount: 4,
      checklistCompletedCount: 3,
      itemQuestionCounts: [
        { itemId: "item-one", itemNumber: "1.1", itemTitle: "첫 항목", questionCount: 4 },
        { itemId: null, itemNumber: null, itemTitle: "일반 질문방", questionCount: 4 },
      ],
      endedAt: "2026-07-15T04:00:00.000Z",
      endedByDisplayName: "김강사",
      exportStatus: "NOT_CONFIGURED",
      endedByUid: "private-uid",
    });

    expect(summary.totalQuestionCount).toBe(8);
    expect(summary.itemQuestionCounts).toHaveLength(2);
    expect(summary.itemQuestionCounts[0].itemNumber).toBe("1.1");
    expect(summary.itemQuestionCounts[1].itemTitle).toBe("일반 질문방");
    expect(summary.checklistCompletedCount).toBe(3);
    expect(summary.exportStatus).toBe("NOT_CONFIGURED");
    expect(summary).not.toHaveProperty("endedByUid");
  });
});
