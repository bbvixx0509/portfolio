import { describe, expect, it } from "vitest";
import type { LiveChapter, LiveCourseItem } from "./liveCourseTypes";
import {
  createCourseItemNumberMap,
  numberedCourseItemLabel,
} from "./courseItemNumbers";

const chapters: LiveChapter[] = [
  { id: "chapter-second", title: "둘째", order: 20 },
  { id: "chapter-first", title: "첫째", order: 10 },
];

function item(
  id: string,
  chapterId: string,
  order: number,
  title: string,
): LiveCourseItem {
  return {
    id,
    chapterId,
    order,
    title,
    description: "",
    materialLabel: title,
    kind: "SLIDE",
    isCompleted: false,
  };
}

describe("course item numbers", () => {
  it("chapter order and in-chapter item order produce stable 1.1 numbers", () => {
    const items = [
      item("second-one", "chapter-second", 0, "둘째 챕터 항목"),
      item("first-two", "chapter-first", 30, "두 번째 항목"),
      item("first-one", "chapter-first", 10, "첫 번째 항목"),
    ];

    const numbers = createCourseItemNumberMap(chapters, items);

    expect(Object.fromEntries(numbers)).toEqual({
      "first-one": "1.1",
      "first-two": "1.2",
      "second-one": "2.1",
    });
    expect(numberedCourseItemLabel(items[0], numbers)).toBe(
      "2.1 둘째 챕터 항목",
    );
  });
});
