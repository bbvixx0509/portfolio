import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadStudentParticipantSession: vi.fn(),
  loadStudentRoomChecklist: vi.fn(),
}));
const user = { uid: "masked-anonymous", isAnonymous: true };

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user, identityKind: "student" }),
}));
vi.mock("./cloudStudentApi", () => mocks);

import { CloudStudentChecklistPage } from "./CloudStudentChecklistPage";

const checklist = {
  roomTitle: "학생 로드맵 테스트",
  roomStatus: "LIVE" as const,
  currentItemId: "item-2",
  isComplete: false,
  summary: { allCount: 3, itemCounts: [{ itemId: "item-1", totalCount: 1 }, { itemId: "item-2", totalCount: 2 }, { itemId: "item-3", totalCount: 0 }] },
  flowItems: [
    { chapterId: "chapter-1", chapterTitle: "첫 챕터", chapterPosition: 0, itemId: "item-1", itemTitle: "완료 항목", itemDescription: "완료 설명", itemPosition: 0, itemNumber: "1.1", isCompleted: true },
    { chapterId: "chapter-1", chapterTitle: "첫 챕터", chapterPosition: 0, itemId: "item-2", itemTitle: "현재 항목", itemDescription: "현재 설명", itemPosition: 1, itemNumber: "1.2", isCompleted: false },
    { chapterId: "chapter-2", chapterTitle: "둘째 챕터", chapterPosition: 1, itemId: "item-3", itemTitle: "미래 항목", itemDescription: "미래 설명", itemPosition: 0, itemNumber: "2.1", isCompleted: false },
  ],
};

function renderPage() {
  return render(<MemoryRouter initialEntries={["/join/demo/ABCDEFGH/checklist"]}><Routes><Route path="/join/:orgId/:roomCode/checklist" element={<CloudStudentChecklistPage />} /><Route path="/join/:orgId/:roomCode/chat" element={<p>학생 채팅 화면</p>} /></Routes></MemoryRouter>);
}

describe("CloudStudentChecklistPage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    mocks.loadStudentRoomChecklist.mockReset().mockResolvedValue(checklist);
    mocks.loadStudentParticipantSession.mockReset().mockResolvedValue({ nickname: "차분한 연필" });
  });
  afterEach(() => vi.useRealTimers());

  it("renders the complete, current, and future student checklist as read-only", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "학생 로드맵 테스트" });

    expect(screen.getByText("완료 항목").closest("li")).toHaveAttribute("data-state", "complete");
    const currentItemInChecklist = screen.getAllByText("현재 항목").find((element) => element.closest("li"));
    expect(currentItemInChecklist?.closest("li")).toHaveAttribute("data-state", "current");
    fireEvent.click(screen.getByRole("button", { name: "챕터 펼치기" }));
    expect(screen.getByText("미래 항목").closest("li")).toHaveAttribute("data-state", "future");
    expect(screen.getByText("현재 진행")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /현재 항목:/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/leadInstructorUid|roomCreatorUid|auditLogs|새 질문/);
  });

  it("opens the selected item chat context and uses the shared workspace separator", async () => {
    renderPage();
    const questionLink = await screen.findByRole("link", { name: "현재 항목 질문 2개 보기" });
    expect(questionLink).toHaveAttribute("href", "/join/demo/ABCDEFGH/chat?context=ITEM%3Aitem-2");
    expect(screen.getByTestId("live-room-shell")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "작업 패널 너비 조절" })).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.queryByRole("button", { name: "작업 패널 넓게 보기" })).not.toBeInTheDocument();
  });

  it("opens only the current chapter initially and retains question data when chapters are toggled", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "학생 로드맵 테스트" });

    const currentChapterToggle = screen.getByRole("button", { name: "챕터 접기" });
    expect(currentChapterToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "챕터 펼치기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("미래 항목")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "챕터 펼치기" }));
    expect(await screen.findByText("미래 항목")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "미래 항목 질문 0개 보기" })).toBeInTheDocument();
    fireEvent.click(currentChapterToggle);
    expect(screen.queryByText("현재 항목")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "챕터 펼치기" })).toBeInTheDocument();
  });

  it("polls only while visible and clears its timer after unmount", async () => {
    vi.useFakeTimers();
    const view = renderPage();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); await Promise.resolve(); });
    expect(mocks.loadStudentRoomChecklist).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mocks.loadStudentRoomChecklist).toHaveBeenCalledTimes(2);
  });
});
