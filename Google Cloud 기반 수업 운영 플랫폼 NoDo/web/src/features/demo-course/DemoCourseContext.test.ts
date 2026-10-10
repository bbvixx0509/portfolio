import { describe, expect, it } from "vitest";
import {
  createInitialDemoCourseState,
  demoCourseReducer,
} from "./DemoCourseContext";
import {
  getCourseCompletionPercent,
  getCurrentProgressItem,
  getIsCourseCompleted,
  getOrderedFlowItems,
} from "./demoCourseSelectors";
import type { DemoCourseState } from "./demoCourseTypes";

function completionBits(state: DemoCourseState) {
  return getOrderedFlowItems(state)
    .map((item) => (item.isCompleted ? "1" : "0"))
    .join("");
}

function toggle(state: DemoCourseState, itemId: string) {
  return demoCourseReducer(state, {
    type: "TOGGLE_ITEM_COMPLETION",
    itemId,
  });
}

describe("DemoCourse reducer 순차 완료 불변식", () => {
  it("패널 확대 상태만 하나의 토글 액션으로 변경한다", () => {
    const initialState = createInitialDemoCourseState();
    const expandedState = demoCourseReducer(initialState, {
      type: "TOGGLE_PANEL_EXPANDED",
    });
    const restoredState = demoCourseReducer(expandedState, {
      type: "TOGGLE_PANEL_EXPANDED",
    });

    expect(initialState.isPanelExpanded).toBe(false);
    expect(expandedState.isPanelExpanded).toBe(true);
    expect(restoredState.isPanelExpanded).toBe(false);
    expect(expandedState.items).toBe(initialState.items);
    expect(expandedState.questions).toBe(initialState.questions);
    expect(expandedState.selectedItemId).toBe(initialState.selectedItemId);
  });

  it("현재 항목만 순서대로 완료해 다음 항목으로 이동하고 전체 완료한다", () => {
    let state = createInitialDemoCourseState();

    expect(completionBits(state)).toBe("111110");
    expect(getCurrentProgressItem(state)?.id).toBe("flow-code");

    state = toggle(state, "flow-code");

    expect(completionBits(state)).toBe("111111");
    expect(getCurrentProgressItem(state)).toBeNull();
    expect(getCourseCompletionPercent(state)).toBe(100);
    expect(getIsCourseCompleted(state)).toBe(true);
  });

  it("미래 항목 완료 요청은 reducer에서도 상태를 바꾸지 않는다", () => {
    const rolledBack = toggle(createInitialDemoCourseState(), "flow-rag");

    expect(completionBits(rolledBack)).toBe("111000");
    expect(getCurrentProgressItem(rolledBack)?.id).toBe("flow-rag");

    const attemptedFutureToggle = toggle(rolledBack, "flow-code");
    expect(attemptedFutureToggle).toBe(rolledBack);
    expect(completionBits(attemptedFutureToggle)).toBe("111000");
    expect(getCurrentProgressItem(attemptedFutureToggle)?.id).toBe("flow-rag");
  });

  it("완료 항목을 해제하면 해당 항목부터 이후 항목을 모두 미완료로 만든다", () => {
    const state = toggle(createInitialDemoCourseState(), "flow-rag");

    expect(completionBits(state)).toBe("111000");
    expect(getCurrentProgressItem(state)?.id).toBe("flow-rag");
    expect(state.selectedItemId).toBe("flow-rag");
  });

  it("되돌린 현재 항목을 체크하면 다음 미완료로 순차 이동한다", () => {
    let state = toggle(createInitialDemoCourseState(), "flow-rag");
    state = toggle(state, "flow-rag");

    expect(completionBits(state)).toBe("111100");
    expect(getCurrentProgressItem(state)?.id).toBe("flow-prompt");
    expect(state.selectedItemId).toBe("flow-prompt");

    state = toggle(state, "flow-prompt");
    expect(completionBits(state)).toBe("111110");
    expect(getCurrentProgressItem(state)?.id).toBe("flow-code");
  });

  it("전체 완료 뒤 이전 항목을 해제해도 이후 완료를 함께 취소한다", () => {
    let state = toggle(createInitialDemoCourseState(), "flow-code");
    state = toggle(state, "flow-prompt");

    expect(completionBits(state)).toBe("111100");
    expect(getCurrentProgressItem(state)?.id).toBe("flow-prompt");
    expect(getIsCourseCompleted(state)).toBe(false);
  });

  it("표시 순서를 바꾸면 완료 상태를 새 순서에 맞게 연속 구간으로 정규화한다", () => {
    const state = demoCourseReducer(createInitialDemoCourseState(), {
      type: "MOVE_ITEM",
      itemId: "flow-code",
      direction: "UP",
    });

    expect(getOrderedFlowItems(state).map((item) => item.id).slice(-3)).toEqual([
      "flow-rag",
      "flow-code",
      "flow-prompt",
    ]);
    expect(completionBits(state)).toBe("111100");
    expect(getCurrentProgressItem(state)?.id).toBe("flow-code");
  });

  it("전체 완료 뒤 추가한 새 항목은 미완료인 현재 항목이 된다", () => {
    const completedState = toggle(createInitialDemoCourseState(), "flow-code");
    const state = demoCourseReducer(completedState, {
      type: "ADD_ITEM",
      chapterId: "chapter-rag",
      title: "새 실습",
    });

    expect(completionBits(state)).toBe("1111110");
    expect(getCurrentProgressItem(state)?.title).toBe("새 실습");
    expect(getIsCourseCompleted(state)).toBe(false);
  });

  it("앞 챕터에 항목을 추가하면 뒤쪽 완료 상태를 순서에 맞게 되돌린다", () => {
    const state = demoCourseReducer(createInitialDemoCourseState(), {
      type: "ADD_ITEM",
      chapterId: "chapter-vector",
      title: "추가 개념 확인",
    });

    expect(completionBits(state)).toBe("1110000");
    expect(getCurrentProgressItem(state)?.title).toBe("추가 개념 확인");
    expect(
      getOrderedFlowItems(state)
        .slice(4)
        .every((item) => !item.isCompleted),
    ).toBe(true);
  });
});
