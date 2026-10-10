import type { LiveChapter, LiveCourseItem } from "./liveCourseTypes";

function compareOrderThenId(
  first: Pick<LiveChapter, "id" | "order">,
  second: Pick<LiveChapter, "id" | "order">,
) {
  return first.order - second.order || first.id.localeCompare(second.id);
}

/**
 * Visible course-flow numbers are derived from chapter order and item order.
 * They are never included in a question write request; the server snapshots
 * the authoritative number when it creates the question.
 */
export function createCourseItemNumberMap(
  chapters: LiveChapter[],
  items: LiveCourseItem[],
) {
  const result = new Map<string, string>();
  const sortedChapters = [...chapters].sort(compareOrderThenId);

  sortedChapters.forEach((chapter, chapterIndex) => {
    const chapterItems = items
      .filter((item) => item.chapterId === chapter.id)
      .sort(compareOrderThenId);
    chapterItems.forEach((item, itemIndex) => {
      result.set(item.id, `${chapterIndex + 1}.${itemIndex + 1}`);
    });
  });

  return result;
}

export function numberedCourseItemLabel(
  item: Pick<LiveCourseItem, "id" | "title">,
  itemNumberById: ReadonlyMap<string, string>,
) {
  const itemNumber = itemNumberById.get(item.id);
  return itemNumber ? `${itemNumber} ${item.title}` : item.title;
}
