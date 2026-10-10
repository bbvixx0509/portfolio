import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudRoomMaterial: vi.fn(),
  getCloudRoomPptxUnit: vi.fn(),
  getStudentRoomMaterial: vi.fn(),
  getStudentRoomPptxUnit: vi.fn(),
  updateCloudRoomMaterialPosition: vi.fn(),
}));
vi.mock("./roomMaterialApi", () => ({
  ...mocks,
  getCloudRoomPdf: vi.fn(),
  getStudentRoomPdf: vi.fn(),
}));

import { LiveRoomMaterialPane } from "./LiveRoomMaterialPane";

const user = { getIdToken: vi.fn() } as never;
const leadMaterial = {
  displayTitle: "강의 슬라이드",
  fileType: "pptx" as const,
  totalUnits: 2,
  currentUnitNumber: 1,
  materialRevision: 1,
  canControl: true,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("LiveRoomMaterialPane", () => {
  it("shows the current extracted PPTX unit and only sends a lead-controlled move", async () => {
    mocks.getCloudRoomMaterial.mockResolvedValue(leadMaterial);
    mocks.getCloudRoomPptxUnit.mockResolvedValue({ unitNumber: 1, title: "첫 페이지", text: "실제 추출 텍스트" });
    mocks.updateCloudRoomMaterialPosition.mockResolvedValue({ ...leadMaterial, currentUnitNumber: 2, materialRevision: 2 });

    render(<LiveRoomMaterialPane user={user} scope={{ mode: "staff", roomId: "room-1" }} />);
    expect(await screen.findByRole("heading", { name: "강의 슬라이드" })).toBeInTheDocument();
    expect(await screen.findByText("실제 추출 텍스트")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /다음/ }));
    await waitFor(() => expect(mocks.updateCloudRoomMaterialPosition).toHaveBeenCalledWith(user, "room-1", 2, 1));
  });

  it("keeps student material navigation read-only and renders no fake material for legacy rooms", async () => {
    mocks.getStudentRoomMaterial.mockResolvedValue({ ...leadMaterial, canControl: false });
    mocks.getStudentRoomPptxUnit.mockResolvedValue({ unitNumber: 1, title: null, text: "학생용 텍스트" });
    const { unmount } = render(<LiveRoomMaterialPane user={user} scope={{ mode: "student", orgId: "demo", roomCode: "ABCDEFGH" }} />);
    await screen.findByText("학생용 텍스트");
    expect(screen.getByRole("button", { name: /다음/ })).toBeDisabled();
    expect(mocks.updateCloudRoomMaterialPosition).not.toHaveBeenCalled();
    mocks.getStudentRoomMaterial.mockResolvedValue(null);
    unmount();
    render(<LiveRoomMaterialPane user={user} scope={{ mode: "student", orgId: "demo", roomCode: "ABCDEFGH" }} />);
    await waitFor(() => expect(screen.getByLabelText("연결된 수업 자료 없음")).toBeInTheDocument());
  });
});
