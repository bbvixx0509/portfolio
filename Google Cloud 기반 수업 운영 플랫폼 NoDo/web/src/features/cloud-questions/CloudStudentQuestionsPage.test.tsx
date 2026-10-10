import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../../lib/api/apiClient";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStudentRoomQuestions: vi.fn(), createStudentRoomQuestion: vi.fn(), createQuestionRequestId: vi.fn() }));
const user = { uid: "masked-anonymous", isAnonymous: true };
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user, identityKind: "student" }) }));
vi.mock("./cloudQuestionApi", async (importOriginal) => ({ ...(await importOriginal<typeof import("./cloudQuestionApi")>()), ...mocks }));
import { CloudStudentQuestionsPage } from "./CloudStudentQuestionsPage";
import { studentQuestionSubmitErrorMessage } from "./cloudQuestionApi";

const feed = {
  roomTitle: "학생 질문 테스트", nickname: "차분한 연필",
  flowItems: [
    { chapterId: "c", chapterTitle: "챕터", chapterPosition: 0, itemId: "item-1", itemTitle: "첫 항목", itemDescription: "", itemPosition: 0, itemNumber: "1.1" },
    { chapterId: "c", chapterTitle: "챕터", chapterPosition: 0, itemId: "item-2", itemTitle: "둘째 항목", itemDescription: "", itemPosition: 1, itemNumber: "1.2" },
  ],
  questions: [
    { id: "public-1", content: "공개 질문", nicknameSnapshot: "맑은 구름", isGeneral: true, itemId: null, itemNumberSnapshot: null, itemTitleSnapshot: null, chapterTitleSnapshot: null, isAnswered: false, answer: null, createdAt: null },
    { id: "public-2", content: "항목 질문", nicknameSnapshot: "차분한 연필", isGeneral: false, itemId: "item-2", itemNumberSnapshot: "1.2", itemTitleSnapshot: "둘째 항목", chapterTitleSnapshot: "챕터", isAnswered: true, answer: { content: "공식 답변입니다.", staffDisplayName: "노출되면 안 되는 강사", roomRole: "LEAD", answeredAt: null }, createdAt: null },
  ],
};
function renderPage() { return render(<MemoryRouter initialEntries={["/join/demo/ABCDEFGH/questions"]}><Routes><Route path="/join/:orgId/:roomCode/questions" element={<CloudStudentQuestionsPage />} /></Routes></MemoryRouter>); }

describe("CloudStudentQuestionsPage", () => {
  beforeEach(() => { vi.useRealTimers(); mocks.getStudentRoomQuestions.mockReset().mockResolvedValue(feed); mocks.createStudentRoomQuestion.mockReset().mockResolvedValue({ accepted: true }); mocks.createQuestionRequestId.mockReset().mockReturnValue("request-00000001"); });
  afterEach(() => vi.useRealTimers());

  it("creates an item question once while the original request is pending", async () => {
    let resolveRequest: (() => void) | undefined;
    mocks.createStudentRoomQuestion.mockImplementation(() => new Promise<void>((resolve) => { resolveRequest = resolve; }));
    renderPage();
    await screen.findByRole("heading", { name: "질문과 답변" });
    fireEvent.change(screen.getByRole("combobox", { name: "질문 문맥" }), { target: { value: "item-2" } });
    fireEvent.change(screen.getByRole("textbox", { name: "질문 내용" }), { target: { value: "둘째 항목을 설명해 주세요." } });
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));
    fireEvent.click(screen.getByRole("button", { name: /전송 중|질문 전송/ }));
    await waitFor(() => expect(mocks.createStudentRoomQuestion).toHaveBeenCalledTimes(1));
    expect(mocks.createStudentRoomQuestion).toHaveBeenCalledWith(user, "demo", "ABCDEFGH", { content: "둘째 항목을 설명해 주세요.", itemId: "item-2", clientRequestId: "request-00000001" });
    resolveRequest?.();
  });

  it("keeps the failed item question and only retries when the student asks", async () => {
    vi.useFakeTimers();
    mocks.createStudentRoomQuestion.mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce({ accepted: true });
    const view = renderPage();
    await act(async () => { await Promise.resolve(); });
    const input = screen.getByRole("textbox", { name: "질문 내용" });
    fireEvent.change(screen.getByRole("combobox", { name: "질문 문맥" }), { target: { value: "item-1" } });
    fireEvent.change(input, { target: { value: "일반 질문입니다." } });
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));
    await act(async () => { await Promise.resolve(); });
    expect(input).toHaveValue("일반 질문입니다.");
    expect(screen.getByRole("combobox", { name: "질문 문맥" })).toHaveValue("item-1");
    expect(screen.getByRole("alert")).toHaveTextContent("연결을 확인한 뒤 다시 시도해 주세요.");
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    expect(mocks.createStudentRoomQuestion).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.createStudentRoomQuestion).toHaveBeenCalledTimes(2);
    expect(mocks.createStudentRoomQuestion.mock.calls[0][3]).toEqual(mocks.createStudentRoomQuestion.mock.calls[1][3]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mocks.getStudentRoomQuestions).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it("clears a successful general-question draft even when the following refresh fails", async () => {
    mocks.getStudentRoomQuestions.mockResolvedValueOnce(feed).mockRejectedValueOnce(new Error("temporary refresh"));
    renderPage();
    await screen.findByRole("heading", { name: "질문과 답변" });
    const input = screen.getByRole("textbox", { name: "질문 내용" });
    fireEvent.change(input, { target: { value: "일반 질문입니다." } });
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));
    await waitFor(() => expect(mocks.createStudentRoomQuestion).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue("");
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
  });

  it("maps server and transport failures to safe Korean submission messages", () => {
    expect(studentQuestionSubmitErrorMessage(new ApiError("private", 403))).toBe("현재 이 강의방에는 질문을 남길 수 없습니다.");
    expect(studentQuestionSubmitErrorMessage(new ApiError("private", 500))).toBe("질문을 전송하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    expect(studentQuestionSubmitErrorMessage(new Error("Failed to fetch"))).toBe("연결을 확인한 뒤 다시 시도해 주세요.");
  });

  it("does not render staff read-state badges for students", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "질문과 답변" });
    expect(screen.queryByText(/새 질문/)).not.toBeInTheDocument();
  });

  it("uses item context chips and shows the official answer directly below the question", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "질문과 답변" });
    fireEvent.click(screen.getByRole("button", { name: "1.2" }));
    expect(screen.getByText("항목 질문")).toBeInTheDocument();
    expect(screen.queryByText("공개 질문")).not.toBeInTheDocument();
    expect(screen.getByText("공식 답변입니다.")).toBeInTheDocument();
    expect(screen.queryByText("노출되면 안 되는 강사")).not.toBeInTheDocument();
    expect(screen.getByRole("form", { name: "질문 입력" })).toBeInTheDocument();
  });

  it("keeps the composer outside the independently scrollable question list", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "질문과 답변" });

    const list = screen.getByTestId("student-question-message-list");
    const composer = screen.getByTestId("student-question-composer");
    expect(list).not.toContainElement(composer);
    expect(composer).toHaveTextContent("0/500");
    expect(composer).toHaveTextContent("질문 전송");
    expect(screen.getByRole("combobox", { name: "질문 문맥" })).toBeInTheDocument();
    expect(screen.getByTestId("live-room-shell")).toBeInTheDocument();
  });

  it("keeps the mobile composer available beside a long question list", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    mocks.getStudentRoomQuestions.mockResolvedValue({
      ...feed,
      questions: Array.from({ length: 24 }, (_, index) => ({
        ...feed.questions[index % feed.questions.length],
        id: `long-question-${index}`,
        content: `긴 질문 목록 ${index + 1}`,
      })),
    });

    renderPage();
    await screen.findByText("긴 질문 목록 24");
    expect(screen.getByTestId("student-question-message-list")).toContainElement(screen.getByText("긴 질문 목록 24"));
    expect(screen.getByTestId("student-question-composer")).toBeVisible();
  });
});
