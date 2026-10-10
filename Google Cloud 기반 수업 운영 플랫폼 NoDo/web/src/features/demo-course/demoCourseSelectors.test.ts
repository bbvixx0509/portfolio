import { describe, expect, it } from "vitest";
import type {
  CourseFlowItem,
  DemoCourseState,
} from "./demoCourseTypes";
import {
  getChapterCompletedCount,
  getCompletedFlowItemCount,
  getCourseCompletionPercent,
  getCurrentProgressItem,
  getDisplayedFlowItem,
  getIsCourseCompleted,
  getIsItemCompletionToggleEnabled,
  getOrderedFlowItems,
} from "./demoCourseSelectors";

function makeItem(
  id: string,
  chapterId: string,
  isCompleted: boolean,
): CourseFlowItem {
  return {
    id,
    chapterId,
    title: id,
    description: `${id} 설명`,
    kind: "SLIDE",
    isCompleted,
    materialLabel: id,
  };
}

function makeState(): DemoCourseState {
  return {
    source: "demo",
    course: {
      id: "selector-course",
      title: "selector 테스트 강의",
      status: "LIVE",
      roomCode: "000000",
    },
    chapters: [
      { id: "chapter-a", title: "A", itemIds: ["item-b", "item-a"] },
      { id: "chapter-b", title: "B", itemIds: ["item-c"] },
    ],
    items: [
      makeItem("item-a", "chapter-a", false),
      makeItem("item-c", "chapter-b", false),
      makeItem("item-b", "chapter-a", true),
    ],
    materials: [],
    questions: [],
    selectedItemId: null,
    isPanelExpanded: false,
    nextSequence: 1,
  };
}

describe("demoCourseSelectors 순차 완료 계산", () => {
  it("items 배열이 아니라 챕터와 itemIds 표시 순서로 첫 미완료를 찾는다", () => {
    const state = makeState();

    expect(getOrderedFlowItems(state).map((item) => item.id)).toEqual([
      "item-b",
      "item-a",
      "item-c",
    ]);
    expect(getCurrentProgressItem(state)?.id).toBe("item-a");
    expect(getCompletedFlowItemCount(state)).toBe(1);
  });

  it("완료 항목과 현재 항목만 체크 가능하고 미래·없는 항목은 막는다", () => {
    const state = makeState();

    expect(getIsItemCompletionToggleEnabled(state, "item-b")).toBe(true);
    expect(getIsItemCompletionToggleEnabled(state, "item-a")).toBe(true);
    expect(getIsItemCompletionToggleEnabled(state, "item-c")).toBe(false);
    expect(getIsItemCompletionToggleEnabled(state, "missing-item")).toBe(false);
  });

  it("선택한 자료와 실제 현재 진행 항목을 서로 독립적으로 계산한다", () => {
    const state = { ...makeState(), selectedItemId: "item-c" };

    expect(getCurrentProgressItem(state)?.id).toBe("item-a");
    expect(getDisplayedFlowItem(state)?.id).toBe("item-c");
    expect(getDisplayedFlowItem({ ...state, selectedItemId: null })?.id).toBe(
      "item-a",
    );
  });

  it("챕터 완료 수와 전체 진행률을 계산한다", () => {
    const state = makeState();

    expect(getChapterCompletedCount(state, "chapter-a")).toBe(1);
    expect(getChapterCompletedCount(state, "chapter-b")).toBe(0);
    expect(getChapterCompletedCount(state, "missing-chapter")).toBe(0);
    expect(getCourseCompletionPercent(state)).toBe(33);
    expect(getIsCourseCompleted(state)).toBe(false);
  });

  it("전체 완료와 빈 강의를 구분한다", () => {
    const completedState = {
      ...makeState(),
      items: makeState().items.map((item) => ({ ...item, isCompleted: true })),
    };
    const emptyState = {
      ...makeState(),
      chapters: [],
      items: [],
      selectedItemId: null,
    };

    expect(getCurrentProgressItem(completedState)).toBeNull();
    expect(getCourseCompletionPercent(completedState)).toBe(100);
    expect(getIsCourseCompleted(completedState)).toBe(true);
    expect(getCurrentProgressItem(emptyState)).toBeNull();
    expect(getCourseCompletionPercent(emptyState)).toBe(0);
    expect(getIsCourseCompleted(emptyState)).toBe(false);
  });
});
