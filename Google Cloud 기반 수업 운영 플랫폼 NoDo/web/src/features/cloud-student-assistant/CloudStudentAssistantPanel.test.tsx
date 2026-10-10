import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  askStudentRoomAssistant: vi.fn(),
  studentAssistantErrorMessage: vi.fn(() => "AI 도우미 오류"),
}));

vi.mock("./cloudStudentAssistantApi", () => mocks);

import { CloudStudentAssistantPanel } from "./CloudStudentAssistantPanel";

const flowItems = [
  { itemId: "item-1", itemNumber: "1.1", itemTitle: "첫 항목", itemDescription: "첫 설명" },
  { itemId: "item-2", itemNumber: "1.2", itemTitle: "현재 항목", itemDescription: "현재 설명" },
];

describe("CloudStudentAssistantPanel", () => {
  it("current lesson context is sent to the private AI assistant endpoint", async () => {
    mocks.askStudentRoomAssistant.mockResolvedValue({
      reply: "핵심을 먼저 정리한 뒤 예시를 떠올려 보세요.",
      context: { itemId: "item-2", itemTitle: "현재 항목" },
      notice: "AI 답변은 학습 보조용입니다.",
    });
    render(
      <CloudStudentAssistantPanel
        user={{ uid: "masked-student" } as never}
        orgId="demo"
        roomCode="ABCDEFGH"
        roomStatus="LIVE"
        currentItemId="item-2"
        flowItems={flowItems}
      />,
    );

    fireEvent.change(screen.getByLabelText("AI 도우미 질문"), { target: { value: "핵심이 무엇인가요?" } });
    fireEvent.click(screen.getByRole("button", { name: "AI 도우미에게 질문 전송" }));

    expect(await screen.findByText("핵심을 먼저 정리한 뒤 예시를 떠올려 보세요.")).toBeInTheDocument();
    expect(mocks.askStudentRoomAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ uid: "masked-student" }),
      "demo",
      "ABCDEFGH",
      "핵심이 무엇인가요?",
      "item-2",
    );
  });

  it("does not offer a send control after the lesson has ended", () => {
    render(
      <CloudStudentAssistantPanel
        user={null}
        orgId="demo"
        roomCode="ABCDEFGH"
        roomStatus="ENDED"
        currentItemId={null}
        flowItems={flowItems}
      />,
    );

    expect(screen.getByText("종료된 강의에서는 새 AI 질문을 남길 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI 도우미에게 질문 전송" })).not.toBeInTheDocument();
  });
});
