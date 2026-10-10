export type MockStartUser = Readonly<{
  source: "mock";
  name: string;
  avatarLabel: string;
}>;

export type MockRecentCourse = Readonly<{
  id: string;
  title: string;
  lastUsedDate: string;
  lastUsedLabel: string;
}>;

export const mockStartUser: MockStartUser = {
  source: "mock",
  name: "노두",
  avatarLabel: "노",
};

export const mockRecentCourses: readonly MockRecentCourse[] = [
  {
    id: "vector-rag-practice",
    title: "벡터DB & RAG 실무 강의",
    lastUsedDate: "2026-07-14",
    lastUsedLabel: "어제",
  },
  {
    id: "frontend-basics",
    title: "프론트엔드 입문반",
    lastUsedDate: "2026-07-12",
    lastUsedLabel: "3일 전",
  },
];
