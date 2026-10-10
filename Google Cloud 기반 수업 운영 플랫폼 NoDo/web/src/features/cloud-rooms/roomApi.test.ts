import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestApi: vi.fn() }));

vi.mock("../../lib/api/apiClient", () => mocks);

import {
  cloudRoomShareLink,
  completeCloudRoomChecklistItem,
  copyCloudRoomValue,
  createCloudRoom,
  endCloudRoom,
  getCloudRoomChecklist,
  getCloudRoom,
  getCloudRoomShare,
  getCloudRoomCapacity,
  increaseCloudRoomCapacity,
  isValidCloudRoomTitle,
  keepCloudRoomCapacity,
  listCloudRooms,
  reopenCloudRoom,
  startCloudRoom,
  toCloudRoomRevisionInput,
  toCloudRoomCreateInput,
  undoCloudRoomChecklistItem,
  validActiveParticipantCapacity,
} from "./roomApi";

const authUser = { uid: "masked-staff" } as never;

afterEach(() => {
  mocks.requestApi.mockReset();
  vi.restoreAllMocks();
});

describe("cloud room API contract", () => {
  it("생성 요청에는 서버 검증용 정원과 최소 수업 정보를 보낸다", async () => {
    mocks.requestApi.mockResolvedValue({ id: "room-1", roomCode: "ABCDEFGH" });

    await createCloudRoom(authUser, "course-1", "  7월 강의방  ");

    expect(toCloudRoomCreateInput("course-1", "  7월 강의방  ")).toEqual({
      sourceCourseId: "course-1",
      title: "7월 강의방",
      maxActiveParticipants: 50,
    });
    expect(mocks.requestApi).toHaveBeenCalledWith("/api/cloud/rooms", {
      method: "POST",
      body: { sourceCourseId: "course-1", title: "7월 강의방", maxActiveParticipants: 50 },
      authUser,
    });
  });

  it("목록은 서버가 판단한 관계만 받고 상세·공유 조회는 server roomCode를 사용한다", async () => {
    mocks.requestApi
      .mockResolvedValueOnce({
        rooms: [{
          id: "room-1",
          relationship: "ASSIGNED",
          sourceCourseId: "course-1",
        }],
      })
      .mockResolvedValueOnce({ id: "room-1", roomCode: "ABCDEFGH", flowItems: [] })
      .mockResolvedValueOnce({ roomId: "room-1", orgId: "demo", roomCode: "ABCDEFGH", joinPath: "/join/demo/ABCDEFGH" });

    await expect(listCloudRooms(authUser)).resolves.toMatchObject([
      {
        id: "room-1",
        relationship: "ASSIGNED",
        sourceCourseId: "course-1",
      },
    ]);
    expect((await getCloudRoom(authUser, "room/1")).roomCode).toBe("ABCDEFGH");
    expect(await getCloudRoomShare(authUser, "room/1")).toMatchObject({
      joinPath: "/join/demo/ABCDEFGH",
    });
    expect(mocks.requestApi.mock.calls).toEqual([
      ["/api/cloud/rooms", { authUser }],
      ["/api/cloud/rooms/room%2F1", { authUser }],
      ["/api/cloud/rooms/room%2F1/share", { authUser }],
    ]);
  });

  it("로드맵 변경에는 expectedRevision만 보내고 서버 상태를 받는다", async () => {
    mocks.requestApi
      .mockResolvedValueOnce({ id: "room-1", status: "READY", revision: 4, flowItems: [] })
      .mockResolvedValueOnce({ id: "room-1", status: "LIVE", revision: 5, flowItems: [] })
      .mockResolvedValueOnce({ id: "room-1", status: "LIVE", revision: 6, flowItems: [] })
      .mockResolvedValueOnce({ id: "room-1", status: "LIVE", revision: 7, flowItems: [] });

    expect(toCloudRoomRevisionInput(4)).toEqual({ expectedRevision: 4 });
    expect((await getCloudRoomChecklist(authUser, "room/1")).status).toBe("READY");
    expect((await startCloudRoom(authUser, "room/1", 4)).status).toBe("LIVE");
    await completeCloudRoomChecklistItem(authUser, "room/1", "item/1", 5);
    await undoCloudRoomChecklistItem(authUser, "room/1", "item/1", 6);

    expect(mocks.requestApi.mock.calls).toEqual([
      ["/api/cloud/rooms/room%2F1/checklist", { authUser }],
      ["/api/cloud/rooms/room%2F1/start", { method: "POST", body: { expectedRevision: 4 }, authUser }],
      ["/api/cloud/rooms/room%2F1/checklist/item%2F1/complete", { method: "POST", body: { expectedRevision: 5 }, authUser }],
      ["/api/cloud/rooms/room%2F1/checklist/item%2F1/undo", { method: "POST", body: { expectedRevision: 6 }, authUser }],
    ]);
  });

  it("강의 종료는 기존 학생 자료 열람 기간 계약만 함께 보낸다", async () => {
    mocks.requestApi.mockResolvedValue({
      id: "room-1",
      status: "ENDED",
      revision: 5,
      flowItems: [],
    });

    await endCloudRoom(authUser, "room/1", 4, {
      studentAccessWindow: "CUSTOM",
      studentAccessUntil: "2099-01-01T09:00:00+09:00",
    });

    expect(mocks.requestApi).toHaveBeenCalledWith("/api/cloud/rooms/room%2F1/end", {
      method: "POST",
      body: {
        expectedRevision: 4,
        studentAccessWindow: "CUSTOM",
        studentAccessUntil: "2099-01-01T09:00:00+09:00",
      },
      authUser,
    });
  });

  it("종료 취소는 revision만 보내고 LIVE 상태를 받는다", async () => {
    mocks.requestApi.mockResolvedValue({ id: "room-1", status: "LIVE", revision: 6, flowItems: [] });

    await expect(reopenCloudRoom(authUser, "room/1", 5)).resolves.toMatchObject({
      status: "LIVE",
      revision: 6,
    });

    expect(mocks.requestApi).toHaveBeenCalledWith("/api/cloud/rooms/room%2F1/reopen", {
      method: "POST",
      body: { expectedRevision: 5 },
      authUser,
    });
  });

  it("현재 origin 기준 공유 링크와 방 이름 유효성을 만든다", () => {
    expect(cloudRoomShareLink("/join/demo/ABCDEFGH", "http://localhost:5175")).toBe(
      "http://localhost:5175/join/demo/ABCDEFGH",
    );
    expect(isValidCloudRoomTitle("  준비 강의방  ")).toBe(true);
    expect(isValidCloudRoomTitle("   ")).toBe(false);
    expect(isValidCloudRoomTitle("a".repeat(101))).toBe(false);
    expect(validActiveParticipantCapacity(1)).toBe(true);
    expect(validActiveParticipantCapacity(300)).toBe(true);
    expect(validActiveParticipantCapacity(0)).toBe(false);
    expect(validActiveParticipantCapacity(20.5)).toBe(false);
  });

  it("정원 조회·유지·증가는 별도 FastAPI 계약만 사용한다", async () => {
    mocks.requestApi
      .mockResolvedValueOnce({ activeParticipantCount: 20, maxActiveParticipants: 50, canManageCapacity: true, capacityAlert: { status: "PENDING", activeParticipantCount: 20, maxActiveParticipants: 50 } })
      .mockResolvedValueOnce({ activeParticipantCount: 20, maxActiveParticipants: 50, canManageCapacity: true, capacityAlert: null })
      .mockResolvedValueOnce({ activeParticipantCount: 20, maxActiveParticipants: 100, canManageCapacity: true, capacityAlert: null });

    expect((await getCloudRoomCapacity(authUser, "room/1")).activeParticipantCount).toBe(20);
    await keepCloudRoomCapacity(authUser, "room/1");
    expect((await increaseCloudRoomCapacity(authUser, "room/1", 100)).maxActiveParticipants).toBe(100);
    expect(mocks.requestApi.mock.calls).toEqual([
      ["/api/cloud/rooms/room%2F1/capacity", { authUser }],
      ["/api/cloud/rooms/room%2F1/capacity/keep", { method: "POST", authUser }],
      ["/api/cloud/rooms/room%2F1/capacity/increase", { method: "POST", body: { maxActiveParticipants: 100 }, authUser }],
    ]);
  });

  it("Clipboard API와 안전한 fallback의 실패를 호출자에게 전달한다", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    await copyCloudRoomValue("ABCDEFGH");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ABCDEFGH");

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    await expect(copyCloudRoomValue("ABCDEFGH")).rejects.toThrow("복사 기능");
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
  });
});
