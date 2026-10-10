import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestApi: vi.fn() }));
vi.mock("../../lib/api/apiClient", () => mocks);

import {
  joinPublicRoom,
  heartbeatStudentPresence,
  leaveStudentRoom,
  loadPublicRoom,
  loadStudentRoomChecklist,
  loadStudentParticipantSession,
} from "./cloudStudentApi";

const user = { uid: "must-not-be-sent" } as never;

afterEach(() => mocks.requestApi.mockReset());

describe("public anonymous room API contract", () => {
  it("keeps public room output minimal", async () => {
    mocks.requestApi.mockResolvedValue({ title: "공개 강의방", status: "READY", joinAllowed: true, roomId: "must-not-use" });
    await expect(loadPublicRoom("demo", "ABCDEFGH")).resolves.toEqual({
      title: "공개 강의방", status: "READY", joinAllowed: true,
    });
    expect(mocks.requestApi).toHaveBeenCalledWith("/api/public/rooms/demo/ABCDEFGH");
  });

  it("sends only nickname for join and uses the anonymous Firebase user only as auth", async () => {
    mocks.requestApi.mockResolvedValue({ nickname: "맑은 구름", roomTitle: "공개 강의방", roomStatus: "LIVE", participantStatus: "JOINED" });
    await joinPublicRoom(user, "demo", "AB/CD", "맑은 구름");
    await loadStudentParticipantSession(user, "demo", "AB/CD");
    expect(mocks.requestApi.mock.calls).toEqual([
      ["/api/public/rooms/demo/AB%2FCD/participants", { method: "POST", body: { nickname: "맑은 구름" }, authUser: user }],
      ["/api/public/rooms/demo/AB%2FCD/session", { authUser: user }],
    ]);
  });

  it("maps the read-only checklist without accepting instructor or audit fields", async () => {
    mocks.requestApi.mockResolvedValue({
      roomTitle: "실습 강의방",
      roomStatus: "LIVE",
      currentItemId: "item-1",
      isComplete: false,
      flowItems: [{
        chapterId: "chapter-1", chapterTitle: "첫 챕터", chapterPosition: 0,
        itemId: "item-1", itemTitle: "첫 항목", itemDescription: "설명",
        itemPosition: 0, itemNumber: "1.1", isCompleted: false,
        leadInstructorUid: "must-not-use",
      }],
      summary: { allCount: 2, itemCounts: [{ itemId: "item-1", totalCount: 1, newCount: 9 }] },
      auditLogs: ["must-not-use"],
    });

    await expect(loadStudentRoomChecklist(user, "demo", "ABCDEFGH")).resolves.toEqual({
      roomTitle: "실습 강의방", roomStatus: "LIVE", currentItemId: "item-1", isComplete: false,
      flowItems: [{
        chapterId: "chapter-1", chapterTitle: "첫 챕터", chapterPosition: 0,
        itemId: "item-1", itemTitle: "첫 항목", itemDescription: "설명",
        itemPosition: 0, itemNumber: "1.1", isCompleted: false, sourcePageOrSlideNumbers: [],
      }],
      summary: { allCount: 2, itemCounts: [{ itemId: "item-1", totalCount: 1 }] },
    });
    expect(mocks.requestApi).toHaveBeenCalledWith(
      "/api/public/rooms/demo/ABCDEFGH/checklist",
      { authUser: user, signal: undefined },
    );
  });

  it("presence heartbeat and leave send no browser clock, UID, or room state", async () => {
    mocks.requestApi
      .mockResolvedValueOnce({ presenceStatus: "ACTIVE", uid: "must-not-use" })
      .mockResolvedValueOnce({ left: true, activeParticipantCount: 99 });

    await expect(heartbeatStudentPresence(user, "demo", "AB/CD")).resolves.toEqual({ presenceStatus: "ACTIVE" });
    await expect(leaveStudentRoom(user, "demo", "AB/CD")).resolves.toEqual({ left: true });
    expect(mocks.requestApi.mock.calls).toEqual([
      ["/api/public/rooms/demo/AB%2FCD/heartbeat", { method: "POST", authUser: user, signal: undefined }],
      ["/api/public/rooms/demo/AB%2FCD/leave", { method: "POST", authUser: user }],
    ]);
  });
});
