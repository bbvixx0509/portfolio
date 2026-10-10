import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestApiMock } = vi.hoisted(() => ({ requestApiMock: vi.fn() }));
vi.mock("../../lib/api/apiClient", () => ({ requestApi: requestApiMock }));

import { RoomParticipantsPanel } from "./RoomParticipantsPanel";

const user = { uid: "staff-private-id" } as unknown as User;

describe("RoomParticipantsPanel", () => {
  beforeEach(() => {
    requestApiMock.mockReset().mockImplementation((path: string) => {
      if (path.endsWith("/participants")) {
        return Promise.resolve({
          participants: [
            {
              participantId: "internal-participant-id",
              nickname: "익명 여우",
              status: "ACTIVE",
              isQuestionRestricted: false,
              email: "must-not-show@nodo.test",
            },
          ],
        });
      }
      return Promise.resolve({
        participantId: "internal-participant-id",
        nickname: "익명 여우",
        status: "ACTIVE",
        isQuestionRestricted: true,
      });
    });
  });

  it("익명 별명과 상태만 표시하고 비식별 ID·이메일은 UI에 노출하지 않는다", async () => {
    render(
      <RoomParticipantsPanel
        roomId="room-one"
        user={user}
        open
        isRoomActive
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("익명 여우")).toBeInTheDocument();
    expect(screen.getByText("참여 중")).toBeInTheDocument();
    expect(screen.queryByText("internal-participant-id")).not.toBeInTheDocument();
    expect(screen.queryByText("must-not-show@nodo.test")).not.toBeInTheDocument();
  });

  it("질문 제한 변경을 비식별 participantId API로 보내고 종료 후에는 비활성화한다", async () => {
    const rendered = render(
      <RoomParticipantsPanel
        roomId="room-one"
        user={user}
        open
        isRoomActive
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("익명 여우");
    fireEvent.click(screen.getByRole("button", { name: "질문 제한" }));
    await waitFor(() => expect(requestApiMock).toHaveBeenCalledWith(
      "/api/rooms/room-one/participants/internal-participant-id",
      expect.objectContaining({
        method: "PATCH",
        body: { isQuestionRestricted: true },
      }),
    ));
    expect(await screen.findByRole("button", { name: "질문 제한 해제" })).toBeInTheDocument();

    rendered.rerender(
      <RoomParticipantsPanel
        roomId="room-one"
        user={user}
        open
        isRoomActive={false}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "질문 제한 해제" })).toBeDisabled();
    expect(screen.getByText(/종료된 강의에서는 참여자 제한을 변경할 수 없습니다/)).toBeInTheDocument();
  });
});
