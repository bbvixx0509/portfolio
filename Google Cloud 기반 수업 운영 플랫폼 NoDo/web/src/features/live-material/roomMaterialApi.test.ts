import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestApi: vi.fn(), requestBlobApi: vi.fn() }));
vi.mock("../../lib/api/apiClient", () => mocks);

import {
  getCloudRoomMaterial,
  getCloudRoomMaterialAccess,
  getCloudRoomPdf,
  getStudentRoomMaterial,
  getStudentRoomPptxUnit,
  updateCloudRoomMaterialPosition,
} from "./roomMaterialApi";

const user = { uid: "masked-user" } as never;
const safeMaterial = {
  material: {
    displayTitle: "lecture.pdf",
    fileType: "pdf",
    totalUnits: 3,
    currentUnitNumber: 1,
    materialRevision: 2,
    canControl: true,
  },
};

afterEach(() => {
  mocks.requestApi.mockReset();
  mocks.requestBlobApi.mockReset();
});

describe("room material API contract", () => {
  it("uses only the FastAPI metadata and position contracts", async () => {
    mocks.requestApi.mockResolvedValueOnce(safeMaterial).mockResolvedValueOnce({
      material: { ...safeMaterial.material, currentUnitNumber: 2, materialRevision: 3 },
    });

    expect(await getCloudRoomMaterial(user, "room/1")).toEqual(safeMaterial.material);
    expect(await updateCloudRoomMaterialPosition(user, "room/1", 2, 2)).toMatchObject({
      currentUnitNumber: 2,
      materialRevision: 3,
    });
    expect(mocks.requestApi.mock.calls).toEqual([
      ["/api/cloud/rooms/room%2F1/material", { authUser: user, cache: "no-store" }],
      ["/api/cloud/rooms/room%2F1/material-position", {
        method: "PATCH",
        body: { unitNumber: 2, expectedMaterialRevision: 2 },
        authUser: user,
      }],
    ]);
  });

  it("uses the existing Firebase-authenticated API helper for staff material access", async () => {
    mocks.requestApi.mockResolvedValueOnce({ material: null });

    await expect(getCloudRoomMaterialAccess(user, "room/1")).resolves.toEqual({ material: null });
    expect(mocks.requestApi).toHaveBeenCalledWith(
      "/api/cloud/rooms/room%2F1/material-access",
      { authUser: user, cache: "no-store" },
    );
  });

  it("uses anonymous FastAPI routes and never turns private content into a URL", async () => {
    mocks.requestApi.mockResolvedValueOnce({ material: { ...safeMaterial.material, canControl: false } })
      .mockResolvedValueOnce({ unitNumber: 2, title: "슬라이드", text: "필요한 텍스트만" });
    const blob = new Blob(["%PDF"], { type: "application/pdf" });
    mocks.requestBlobApi.mockResolvedValueOnce(blob);

    expect(await getStudentRoomMaterial(user, "demo", "ABCDEFGH")).toMatchObject({ canControl: false });
    expect(await getStudentRoomPptxUnit(user, "demo", "ABCDEFGH")).toEqual({ unitNumber: 2, title: "슬라이드", text: "필요한 텍스트만" });
    expect(await getCloudRoomPdf(user, "room-1")).toBe(blob);
    expect(mocks.requestApi.mock.calls[0]).toEqual([
      "/api/public/rooms/demo/ABCDEFGH/material", { authUser: user, cache: "no-store" },
    ]);
    expect(mocks.requestApi.mock.calls[1]).toEqual([
      "/api/public/rooms/demo/ABCDEFGH/material/content", { authUser: user, cache: "no-store" },
    ]);
    expect(mocks.requestBlobApi).toHaveBeenCalledWith(
      "/api/cloud/rooms/room-1/material/content", { authUser: user },
    );
  });

  it("rejects unsafe metadata instead of exposing a server-owned source value", async () => {
    mocks.requestApi.mockResolvedValue({ material: { ...safeMaterial.material, sourceObjectPath: "private/path" } });
    await expect(getCloudRoomMaterial(user, "room-1")).resolves.toMatchObject({ displayTitle: "lecture.pdf" });
  });
});
