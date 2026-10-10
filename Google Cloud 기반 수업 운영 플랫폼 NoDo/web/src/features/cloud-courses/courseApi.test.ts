import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestApi: vi.fn(), requestBlobApi: vi.fn() }));
vi.mock("../../lib/api/apiClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api/apiClient")>();
  return { ...original, requestApi: mocks.requestApi, requestBlobApi: mocks.requestBlobApi };
});

import {
  archiveCloudCourse,
  attachCloudCourseMaterial,
  createCloudCourse,
  detachCloudCourseMaterial,
  duplicateCloudCourse,
  getCloudCourse,
  listCloudCourses,
  listCloudCourseMaterials,
  loadCloudCourseMaterialContent,
  toCloudCourseInput,
  updateCloudCourse,
} from "./courseApi";

const authUser = { uid: "masked-staff" } as unknown as User;
const record = {
  id: "course-1",
  title: "React 수업",
  description: "기초",
  createdByDisplayNameSnapshot: "관리자",
  chapterCount: 1,
  itemCount: 1,
  updatedAt: "2026-07-22T00:00:00.000Z",
  isMine: true,
  revision: 1,
  chapters: [
    {
      id: "chapter-1",
      title: "첫 챕터",
      position: 0,
      items: [
        { id: "item-1", title: "첫 항목", description: "소개", position: 0 },
      ],
    },
  ],
};

describe("cloud course API 계약", () => {
  beforeEach(() => { mocks.requestApi.mockReset(); mocks.requestBlobApi.mockReset(); });

  it("생성·수정 요청에서 화면용 position과 서버 전용 필드를 제거한다", () => {
    const unsafeDraft = {
      title: record.title,
      description: record.description,
      organizationId: "ignored-org",
      chapters: [
        {
          id: "chapter-second",
          title: "두 번째 챕터",
          position: 99,
          creatorUid: "ignored-uid",
          items: [
            { id: "item-second", title: "두 번째 항목", description: "둘", position: 8 },
            { id: "item-first", title: "첫 번째 항목", description: "하나", position: 7 },
          ],
        },
        {
          id: "chapter-first",
          title: "첫 번째 챕터",
          position: 3,
          items: [],
        },
      ],
    };
    const input = toCloudCourseInput(unsafeDraft);

    expect(input).toEqual({
      title: record.title,
      description: record.description,
      chapters: [
        {
          id: "chapter-second",
          title: "두 번째 챕터",
          items: [
          { id: "item-second", title: "두 번째 항목", description: "둘", sourcePageOrSlideNumbers: [] },
          { id: "item-first", title: "첫 번째 항목", description: "하나", sourcePageOrSlideNumbers: [] },
          ],
        },
        { id: "chapter-first", title: "첫 번째 챕터", items: [] },
      ],
    });
    expect(JSON.stringify(input)).not.toContain("position");
    expect(JSON.stringify(input)).not.toContain("organizationId");
    expect(JSON.stringify(input)).not.toContain("creatorUid");
  });

  it("목록·조회·저장·복사·보관 요청을 FastAPI 경로와 입력 계약으로만 보낸다", async () => {
    mocks.requestApi
      .mockResolvedValueOnce({ courses: [record] })
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce({ ...record, revision: 2 })
      .mockResolvedValueOnce({ ...record, id: "course-copy", isMine: true })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ materials: [{ id: "material-1", filename: "자료.pdf", normalizedExtension: "pdf", sizeBytes: 1024 }] })
      .mockResolvedValueOnce({ materials: [] });
    mocks.requestBlobApi.mockResolvedValueOnce(new Blob(["pdf"]));
    const draft = {
      title: record.title,
      description: record.description,
      chapters: record.chapters,
    };
    const input = toCloudCourseInput(draft);

    expect(await listCloudCourses(authUser)).toHaveLength(1);
    await getCloudCourse(authUser, "course/a");
    await createCloudCourse(authUser, draft, ["material-1"]);
    await updateCloudCourse(authUser, "course/a", draft, 1);
    await duplicateCloudCourse(authUser, "course/a");
    await archiveCloudCourse(authUser, "course/a", 2);
    expect(await listCloudCourseMaterials(authUser, "course/a")).toEqual({
      materials: [{ id: "material-1", filename: "자료.pdf", normalizedExtension: "pdf", sizeBytes: 1024 }],
      unavailableMaterialCount: 0,
    });
    await attachCloudCourseMaterial(authUser, "course/a", "material-1");
    await detachCloudCourseMaterial(authUser, "course/a", "material-1");
    await loadCloudCourseMaterialContent(authUser, "course/a", "material-1");

    expect(mocks.requestApi.mock.calls).toEqual([
      ["/api/cloud/courses", { authUser }],
      ["/api/cloud/courses/course%2Fa", { authUser }],
      ["/api/cloud/courses", { method: "POST", body: { ...input, materialIds: ["material-1"] }, authUser }],
      ["/api/cloud/courses/course%2Fa", {
        method: "PUT",
        body: { ...input, expectedRevision: 1 },
        authUser,
      }],
      ["/api/cloud/courses/course%2Fa/duplicate", { method: "POST", authUser }],
      ["/api/cloud/courses/course%2Fa/archive", {
        method: "POST",
        body: { expectedRevision: 2 },
        authUser,
      }],
      ["/api/cloud/courses/course%2Fa/materials", { authUser }],
      ["/api/cloud/courses/course%2Fa/materials", { method: "POST", body: { materialId: "material-1" }, authUser }],
      ["/api/cloud/courses/course%2Fa/materials/material-1", { method: "DELETE", authUser }],
    ]);
    expect(mocks.requestBlobApi).toHaveBeenCalledWith("/api/cloud/courses/course%2Fa/materials/material-1/content", { authUser });
  });

  it("응답의 position은 화면 정렬 상태로 계속 보존한다", async () => {
    const response = {
      ...record,
      chapters: [
        {
          ...record.chapters[0],
          position: 4,
          items: [{ ...record.chapters[0].items[0], position: 7 }],
        },
      ],
    };
    mocks.requestApi.mockResolvedValue({ courses: [response] });

    const [course] = await listCloudCourses(authUser);

    expect(course).toMatchObject({
      createdByDisplayNameSnapshot: "관리자",
      chapterCount: 1,
      itemCount: 1,
      isMine: true,
    });
    expect(course.chapters[0]).toMatchObject({ position: 4 });
    expect(course.chapters[0].items[0]).toMatchObject({ position: 7 });
  });

  it("목록 응답의 최신 접근 가능 강의방 상태와 안전한 필드만 매핑한다", async () => {
    mocks.requestApi.mockResolvedValue({
      courses: [{
        ...record,
        latestAccessibleRoom: {
          roomId: "room-live",
          status: "LIVE",
          downloadAvailableUntil: null,
          endedAt: null,
          roomCode: "not-exposed",
          participants: ["not-exposed"],
        },
      }],
    });

    const [course] = await listCloudCourses(authUser);

    expect(course.latestAccessibleRoom).toEqual({
      roomId: "room-live",
      status: "LIVE",
      downloadAvailableUntil: null,
      endedAt: null,
    });
    expect(JSON.stringify(course.latestAccessibleRoom)).not.toContain("roomCode");
    expect(JSON.stringify(course.latestAccessibleRoom)).not.toContain("participants");
  });
});
