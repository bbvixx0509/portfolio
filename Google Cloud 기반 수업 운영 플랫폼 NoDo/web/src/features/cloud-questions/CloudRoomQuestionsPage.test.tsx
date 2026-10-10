import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudRoomQuestions: vi.fn(),
  markCloudRoomQuestionsRead: vi.fn(),
  answerCloudRoomQuestion: vi.fn(),
  cancelCloudRoomQuestionAnswer: vi.fn(),
  setCloudRoomQuestionHidden: vi.fn(),
}));
const user = { uid: "masked-lead" };

vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user }) }));
vi.mock("./cloudQuestionApi", () => mocks);

import { CloudRoomQuestionsPage } from "./CloudRoomQuestionsPage";

const feed = {
  roomTitle: "질문 테스트 강의방", roomStatus: "LIVE" as const, currentRole: "LEAD_INSTRUCTOR" as const,
  roomPermissions: { questionOperations: true, checklistProgress: true, capacityOperations: true },
  flowItems: [{ chapterId: "chapter-1", chapterTitle: "첫 챕터", chapterPosition: 0, itemId: "item-1", itemTitle: "첫 항목", itemDescription: "설명", itemPosition: 0, itemNumber: "1.1" }],
  questions: [
    { id: "question-1", content: "첫 항목을 다시 설명해 주세요.", nicknameSnapshot: "차분한 연필", isGeneral: false, itemId: "item-1", itemNumberSnapshot: "1.1", itemTitleSnapshot: "첫 항목", chapterTitleSnapshot: "첫 챕터", isAnswered: false, answer: null, createdAt: null, visibility: "PUBLIC" as const, moderationStatus: "APPROVED" as const, isHidden: false },
    { id: "question-2", content: "검토가 필요한 질문", nicknameSnapshot: "맑은 구름", isGeneral: true, itemId: null, itemNumberSnapshot: null, itemTitleSnapshot: null, chapterTitleSnapshot: null, isAnswered: false, answer: null, createdAt: null, visibility: "STAFF_ONLY" as const, moderationStatus: "NEEDS_REVIEW" as const, isHidden: true },
  ],
  summary: { allCount: 2, newCount: 1, generalCount: 1, generalNewCount: 0, itemCounts: [{ itemId: "item-1", itemNumber: "1.1", totalCount: 1, newCount: 1 }] },
};

function renderPage(path = "/rooms/room-1/chat") {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/rooms/:roomId/chat" element={<CloudRoomQuestionsPage />} /></Routes></MemoryRouter>);
}

describe("CloudRoomQuestionsPage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getCloudRoomQuestions.mockResolvedValue(feed);
    mocks.markCloudRoomQuestionsRead.mockResolvedValue({ marked: true });
    mocks.answerCloudRoomQuestion.mockResolvedValue({ ...feed.questions[0], isAnswered: true, answer: { content: "순서대로 안내하겠습니다.", staffDisplayName: "강사", roomRole: "LEAD", answeredAt: null } });
    mocks.cancelCloudRoomQuestionAnswer.mockResolvedValue(feed.questions[0]);
    mocks.setCloudRoomQuestionHidden.mockResolvedValue(feed.questions[0]);
  });
  afterEach(() => vi.useRealTimers());

  it("cloud-auth chat route renders instead of the start page and filters an item context", async () => {
    renderPage("/rooms/room-1/chat?item=item-1");
    expect(await screen.findByRole("heading", { name: "질문과 답변" })).toBeInTheDocument();
    await waitFor(() => expect(mocks.markCloudRoomQuestionsRead).toHaveBeenCalledWith(user, "room-1", "ITEM:item-1", "question-1"));
    expect(screen.getByText("첫 항목을 다시 설명해 주세요.")).toBeInTheDocument();
    expect(screen.queryByText("검토가 필요한 질문")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1.1 첫 항목/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("uses the latest observed question for ALL and GENERAL read requests", async () => {
    const view = renderPage();
    await screen.findByRole("heading", { name: "질문과 답변" });
    await waitFor(() => expect(mocks.markCloudRoomQuestionsRead).toHaveBeenCalledWith(user, "room-1", "ALL", "question-2"));
    view.unmount();

    mocks.getCloudRoomQuestions.mockClear();
    mocks.markCloudRoomQuestionsRead.mockClear();
    mocks.getCloudRoomQuestions.mockResolvedValue({
      ...feed,
      summary: { ...feed.summary, newCount: 1, generalNewCount: 1, itemCounts: [{ ...feed.summary.itemCounts[0], newCount: 0 }] },
    });
    renderPage("/rooms/room-1/chat?filter=GENERAL");
    await screen.findByRole("heading", { name: "질문과 답변" });
    await waitFor(() => expect(mocks.markCloudRoomQuestionsRead).toHaveBeenCalledWith(user, "room-1", "GENERAL", "question-2"));
  });

  it("shows staff-only moderation to staff, saves an answer, and hides a question", async () => {
    renderPage();
    await screen.findByText("검토가 필요한 질문");
    fireEvent.click(screen.getAllByRole("button", { name: "답변하기" })[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "공식 답변" }), { target: { value: "순서대로 안내하겠습니다." } });
    fireEvent.click(screen.getByRole("button", { name: "답변 저장" }));
    await waitFor(() => expect(mocks.answerCloudRoomQuestion).toHaveBeenCalledWith(user, "room-1", "question-1", "순서대로 안내하겠습니다."));
    fireEvent.click(screen.getAllByRole("button", { name: "숨김" })[0]);
    await waitFor(() => expect(mocks.setCloudRoomQuestionHidden).toHaveBeenCalledWith(user, "room-1", "question-1", true));
  });

  it("polls only while mounted and keeps the layout visible at 390px", async () => {
    vi.useFakeTimers();
    mocks.markCloudRoomQuestionsRead.mockResolvedValue({ marked: false });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const view = renderPage();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mocks.getCloudRoomQuestions).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /전체/ })).toBeVisible();
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mocks.getCloudRoomQuestions).toHaveBeenCalledTimes(2);
  });

  it("uses the shared accessible workspace separator for rooms without materials", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "질문과 답변" });
    expect(screen.getByTestId("live-room-shell")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "작업 패널 너비 조절" })).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.queryByRole("button", { name: "작업 패널 넓게 보기" })).not.toBeInTheDocument();
  });

  it("keeps the answer editor inside the independently scrollable question list", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    renderPage();
    await screen.findByRole("heading", { name: "질문과 답변" });
    fireEvent.click(screen.getAllByRole("button", { name: "답변하기" })[0]);

    const list = screen.getByTestId("staff-question-message-list");
    expect(list).toContainElement(screen.getByRole("textbox", { name: "공식 답변" }));
    expect(screen.getByRole("button", { name: "답변 저장" })).toBeVisible();
  });

  it("assistant question permission controls question operations without treating an org admin as room staff", async () => {
    mocks.getCloudRoomQuestions.mockResolvedValue({
      ...feed,
      currentRole: "ASSISTANT",
      roomPermissions: { questionOperations: true, checklistProgress: false, capacityOperations: false },
    });
    const view = renderPage();
    await screen.findByText("검토가 필요한 질문");
    expect(screen.getAllByRole("button", { name: "답변하기" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "공유하기" })).toBeInTheDocument();
    view.unmount();
    mocks.markCloudRoomQuestionsRead.mockClear();

    mocks.getCloudRoomQuestions.mockResolvedValue({
      ...feed,
      currentRole: "ADMIN",
      roomPermissions: { questionOperations: false, checklistProgress: false, capacityOperations: false },
    });
    renderPage();
    expect(await screen.findByText(/질문을 읽을 수 있지만/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "답변하기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "공유하기" })).not.toBeInTheDocument();
    expect(mocks.markCloudRoomQuestionsRead).not.toHaveBeenCalled();
  });
});
