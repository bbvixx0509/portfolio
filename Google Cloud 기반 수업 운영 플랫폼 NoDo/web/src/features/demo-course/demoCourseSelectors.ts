import type {
  CourseFlowItem,
  DemoCourseState,
} from "./demoCourseTypes";

export function getOrderedFlowItems(state: DemoCourseState) {
  const itemMap = new Map(state.items.map((item) => [item.id, item]));
  return state.chapters.flatMap((chapter) =>
    chapter.itemIds
      .map((itemId) => itemMap.get(itemId))
      .filter((item): item is CourseFlowItem => item !== undefined),
  );
}

export function getQuestionCountsForItem(
  state: DemoCourseState,
  itemId: string,
) {
  const questions = state.questions.filter(
    (question) => question.itemId === itemId,
  );
  return {
    total: questions.length,
    unread: questions.filter((question) => question.unread).length,
  };
}

export function getUnreadQuestionCount(state: DemoCourseState) {
  return state.questions.filter((question) => question.unread).length;
}

export function getCompletedFlowItemCount(state: DemoCourseState) {
  return getOrderedFlowItems(state).filter((item) => item.isCompleted).length;
}

export function getChapterCompletedCount(
  state: DemoCourseState,
  chapterId: string,
) {
  const chapter = state.chapters.find((candidate) => candidate.id === chapterId);
  if (!chapter) {
    return 0;
  }
  const itemMap = new Map(state.items.map((item) => [item.id, item]));
  return chapter.itemIds.filter((itemId) => itemMap.get(itemId)?.isCompleted)
    .length;
}

export function getCurrentProgressItem(state: DemoCourseState) {
  return getOrderedFlowItems(state).find((item) => !item.isCompleted) ?? null;
}

export function getIsItemCompletionToggleEnabled(
  state: DemoCourseState,
  itemId: string,
) {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    return false;
  }
  return item.isCompleted || getCurrentProgressItem(state)?.id === itemId;
}

export function getCourseCompletionPercent(state: DemoCourseState) {
  const orderedItems = getOrderedFlowItems(state);
  if (orderedItems.length === 0) {
    return 0;
  }
  const completedCount = orderedItems.filter((item) => item.isCompleted).length;
  return Math.round((completedCount / orderedItems.length) * 100);
}

export function getIsCourseCompleted(state: DemoCourseState) {
  const orderedItems = getOrderedFlowItems(state);
  return (
    orderedItems.length > 0 &&
    orderedItems.every((item) => item.isCompleted)
  );
}

export function getDisplayedFlowItem(state: DemoCourseState) {
  const selectedItem = state.items.find(
    (item) => item.id === state.selectedItemId,
  );
  return (
    selectedItem ??
    getCurrentProgressItem(state) ??
    getOrderedFlowItems(state)[0] ??
    null
  );
}
