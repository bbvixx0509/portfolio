import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudRoomCapacity: vi.fn(),
  keepCloudRoomCapacity: vi.fn(),
  increaseCloudRoomCapacity: vi.fn(),
}));
const user = { uid: "masked-staff" } as never;

vi.mock("./roomApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./roomApi")>();
  return { ...original, ...mocks };
});

import { CloudRoomCapacityPanel } from "./CloudRoomCapacityPanel";

const pendingCapacity = {
  activeParticipantCount: 50,
  maxActiveParticipants: 50,
  canManageCapacity: true,
  capacityAlert: {
    status: "PENDING" as const,
    activeParticipantCount: 50,
    maxActiveParticipants: 50,
  },
};

describe("CloudRoomCapacityPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCloudRoomCapacity.mockResolvedValue(pendingCapacity);
    mocks.keepCloudRoomCapacity.mockResolvedValue({ ...pendingCapacity, capacityAlert: null });
    mocks.increaseCloudRoomCapacity.mockResolvedValue({
      activeParticipantCount: 50,
      maxActiveParticipants: 100,
      canManageCapacity: true,
      capacityAlert: null,
    });
  });

  it("shows aggregate capacity only and lets an assigned instructor resolve or increase", async () => {
    render(<CloudRoomCapacityPanel user={user} roomId="room-1" />);

    expect(await screen.findByText("현재 접속")).toHaveTextContent("50 / 50명");
    expect(screen.getByText("정원 초과 알림")).toBeInTheDocument();
    expect(screen.queryByText("masked-staff")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "새 동시 참여 정원" }), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "정원 늘리기" }));
    await waitFor(() => expect(mocks.increaseCloudRoomCapacity).toHaveBeenCalledWith(user, "room-1", 100));
  });

  it("does not expose management controls to an unassigned admin", async () => {
    mocks.getCloudRoomCapacity.mockResolvedValue({
      activeParticipantCount: 12,
      maxActiveParticipants: 50,
      canManageCapacity: false,
      capacityAlert: null,
    });
    render(<CloudRoomCapacityPanel user={user} roomId="room-1" />);

    expect(await screen.findByText("현재 접속")).toHaveTextContent("12 / 50명");
    expect(screen.queryByRole("button", { name: "현재 정원 유지" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "정원 늘리기" })).not.toBeInTheDocument();
  });

  it("keeps the increase control available after an instructor keeps the current capacity", async () => {
    mocks.getCloudRoomCapacity.mockResolvedValue({
      ...pendingCapacity,
      capacityAlert: null,
    });
    render(<CloudRoomCapacityPanel user={user} roomId="room-1" />);

    expect(await screen.findByText("정원 설정")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "새 동시 참여 정원" }), { target: { value: "51" } });
    fireEvent.click(screen.getByRole("button", { name: "정원 늘리기" }));
    await waitFor(() => expect(mocks.increaseCloudRoomCapacity).toHaveBeenCalledWith(user, "room-1", 51));
  });
});
