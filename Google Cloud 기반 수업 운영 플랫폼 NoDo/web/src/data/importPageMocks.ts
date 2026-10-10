export type ImportCourseCreationMode = "AI" | "MANUAL";

export type ImportCourseStatus = "IN_PROGRESS" | "COMPLETED";

export type ImportCourse = Readonly<{
  id: string;
  title: string;
  creationMode: ImportCourseCreationMode;
  itemCount: number;
  progressPercent: number;
  status: ImportCourseStatus;
  lastUsedAt: string;
  lastUsedLabel: string;
}>;

export const importCourseMocks: readonly ImportCourse[] = [
  {
    id: "vector-rag-practice",
    title: "벡터DB & RAG 실무 강의",
    creationMode: "AI",
    itemCount: 12,
    progressPercent: 65,
    status: "IN_PROGRESS",
    lastUsedAt: "2026-07-14T09:30:00+09:00",
    lastUsedLabel: "어제 사용",
  },
  {
    id: "frontend-basics",
    title: "프론트엔드 입문반",
    creationMode: "MANUAL",
    itemCount: 8,
    progressPercent: 100,
    status: "COMPLETED",
    lastUsedAt: "2026-07-12T14:00:00+09:00",
    lastUsedLabel: "3일 전",
  },
  {
    id: "backend-api-basics",
    title: "백엔드 API 설계 기초",
    creationMode: "AI",
    itemCount: 15,
    progressPercent: 40,
    status: "IN_PROGRESS",
    lastUsedAt: "2026-07-08T11:15:00+09:00",
    lastUsedLabel: "1주 전",
  },
  {
    id: "python-data-camp",
    title: "데이터 분석 파이썬 캠프",
    creationMode: "AI",
    itemCount: 20,
    progressPercent: 90,
    status: "IN_PROGRESS",
    lastUsedAt: "2026-07-01T10:00:00+09:00",
    lastUsedLabel: "2주 전",
  },
  {
    id: "ux-research-workshop",
    title: "UX 리서치 워크숍",
    creationMode: "MANUAL",
    itemCount: 6,
    progressPercent: 100,
    status: "COMPLETED",
    lastUsedAt: "2026-06-24T16:20:00+09:00",
    lastUsedLabel: "3주 전",
  },
];

export function getImportCourseCounts(courses: readonly ImportCourse[]) {
  return courses.reduce(
    (counts, course) => {
      counts.total += 1;
      if (course.status === "COMPLETED") {
        counts.completed += 1;
      } else {
        counts.inProgress += 1;
      }
      return counts;
    },
    { total: 0, inProgress: 0, completed: 0 },
  );
}
