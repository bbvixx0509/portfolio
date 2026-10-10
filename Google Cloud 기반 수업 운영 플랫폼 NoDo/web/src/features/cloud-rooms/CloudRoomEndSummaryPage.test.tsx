import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exportCloudRoomQuestionsCsv: vi.fn(),
  getCloudRoom: vi.fn(),
  getCloudRoomEndSummary: vi.fn(),
  reopenCloudRoom: vi.fn(),
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ user: { uid: "masked-lead" } }),
}));
vi.mock("../cloud-questions/cloudQuestionApi", () => ({
  csvExportErrorMessage: () => "현재 채팅 기록을 내보낼 수 없습니다.",
  exportCloudRoomQuestionsCsv: mocks.exportCloudRoomQuestionsCsv,
}));
vi.mock("./roomApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./roomApi")>()),
  getCloudRoom: mocks.getCloudRoom,
  getCloudRoomEndSummary: mocks.getCloudRoomEndSummary,
  reopenCloudRoom: mocks.reopenCloudRoom,
}));

import { CloudRoomEndSummaryPage } from "./CloudRoomEndSummaryPage";

const endSummary = {
  roomId: "room-1",
  title: "종료 테스트 강의방",
  status: "ENDED" as const,
  startedAt: "2026-07-27T09:00:00Z",
  endedAt: "2026-07-27T10:00:00Z",
  checklistCompletedCount: 2,
  checklistTotalCount: 3,
  completionRate: 67,
  totalQuestionCount: 5,
  answeredQuestionCount: 4,
  participantCount: 12,
  activeParticipantCount: 0,
  downloadEnabled: true,
  downloadAvailableUntil: "2030-01-01T10:00:00Z",
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/rooms/room-1/summary"]}>
      <Routes>
        <Route path="/rooms/:roomId/summary" element={<CloudRoomEndSummaryPage />} />
        <Route path="/rooms/:roomId/checklist" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CloudRoomEndSummaryPage", () => {
  beforeEach(() => {
    mocks.getCloudRoomEndSummary.mockReset().mockResolvedValue(endSummary);
    mocks.getCloudRoom.mockReset().mockResolvedValue({
      id: "room-1",
      currentRole: "LEAD_INSTRUCTOR",
      canReopen: true,
      revision: 7,
      flowItems: [],
    });
    mocks.exportCloudRoomQuestionsCsv.mockReset().mockResolvedValue({
      blob: new Blob(["비공개 CSV 본문"], { type: "text/csv" }),
      filename: "ended-room-questions.csv",
    });
    mocks.reopenCloudRoom.mockReset().mockResolvedValue({
      id: "room-1", status: "LIVE", revision: 8, flowItems: [],
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:question-export"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ENDED LEAD에게 KST 마감과 채팅 기록 내보내기 버튼을 표시한다", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "종료 테스트 강의방" })).toBeInTheDocument();
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("5 / 4")).toBeInTheDocument();
    expect(screen.getByText("12명")).toBeInTheDocument();
    expect(screen.getByText(/학생 자료 열람·다운로드 마감: .*KST/)).toBeInTheDocument();
    expect(screen.getByText("채팅 기록은 자료 다운로드 마감 전까지 내보낼 수 있습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "채팅 기록 내보내기" })).toBeEnabled();
    expect(screen.queryByText(/masked-lead/)).not.toBeInTheDocument();
  });

  it("종료 취소는 확인 뒤 한 번만 호출하고 LIVE 화면으로 이동한다", async () => {
    renderPage();

    const button = await screen.findByRole("button", { name: "종료 취소" });
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "이 강의방을 다시 열까요?" })).toBeInTheDocument();
    expect(mocks.reopenCloudRoom).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    fireEvent.click(screen.getByRole("button", { name: "종료 취소" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "이 강의방을 다시 열까요?" })).getByRole("button", { name: "종료 취소" }));

    await waitFor(() => expect(mocks.reopenCloudRoom).toHaveBeenCalledWith({ uid: "masked-lead" }, "room-1", 7));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/rooms/room-1/checklist"));
  });

  it("복구에 실패하면 안전한 안내를 유지하고 다시 시도할 수 있다", async () => {
    mocks.reopenCloudRoom.mockRejectedValueOnce(new Error("private failure"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "종료 취소" }));
    const dialog = screen.getByRole("dialog", { name: "이 강의방을 다시 열까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "종료 취소" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("강의방을 다시 열지 못했습니다.");
    fireEvent.click(within(screen.getByRole("dialog", { name: "이 강의방을 다시 열까요?" })).getByRole("button", { name: "종료 취소" }));
    await waitFor(() => expect(mocks.reopenCloudRoom).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["LIVE", "LEAD_INSTRUCTOR"],
    ["ENDED", "ASSISTANT"],
    ["ENDED", "ADMIN"],
    ["ENDED", undefined],
  ] as const)("%s 상태와 %s 역할에는 내보내기 제어를 숨긴다", async (status, currentRole) => {
    mocks.getCloudRoomEndSummary.mockResolvedValue({ ...endSummary, status });
    mocks.getCloudRoom.mockResolvedValue({ id: "room-1", currentRole, flowItems: [] });

    renderPage();

    await screen.findByRole("heading", { name: "종료 테스트 강의방" });
    expect(screen.queryByRole("button", { name: "채팅 기록 내보내기" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("채팅 기록 내보내기")).not.toBeInTheDocument();
  });

  it.each([
    ["2030-01-01T10:00:00Z", "explicit deadline"],
    ["2020-01-01T10:00:00Z", "expired deadline"],
  ])("마감된 경우 버튼 대신 종료 안내를 표시한다 (%s)", async (downloadAvailableUntil) => {
    mocks.getCloudRoomEndSummary.mockResolvedValue({
      ...endSummary,
      downloadAvailableUntil,
    });

    renderPage();

    await screen.findByRole("heading", { name: "종료 테스트 강의방" });
    if (downloadAvailableUntil.startsWith("2020")) {
      expect(screen.getByText("채팅 기록 내보내기 기간이 종료되었습니다.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "채팅 기록 내보내기" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("button", { name: "채팅 기록 내보내기" })).toBeInTheDocument();
    }
  });

  it("레거시 종료 7일 fallback과 즉시 마감을 모두 안전하게 처리한다", async () => {
    mocks.getCloudRoomEndSummary.mockResolvedValue({
      ...endSummary,
      endedAt: "2020-01-01T10:00:00Z",
      downloadEnabled: false,
      downloadAvailableUntil: null,
    });

    renderPage();

    await screen.findByRole("heading", { name: "종료 테스트 강의방" });
    expect(screen.getByText("채팅 기록 내보내기 기간이 종료되었습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "채팅 기록 내보내기" })).not.toBeInTheDocument();
  });

  it("Blob을 한 번만 내려받고 본문을 화면에 표시하지 않는다", async () => {
    let finish!: (value: { blob: Blob; filename: string }) => void;
    mocks.exportCloudRoomQuestionsCsv.mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    renderPage();
    const button = await screen.findByRole("button", { name: "채팅 기록 내보내기" });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.exportCloudRoomQuestionsCsv).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "내보내는 중" })).toBeDisabled();
    finish({ blob: new Blob(["UID=hidden\ntoken=hidden"], { type: "text/csv" }), filename: "chat.csv" });

    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(document.body).not.toHaveTextContent("UID=hidden");
    expect(document.body).not.toHaveTextContent("token=hidden");
  });

  it("실패 뒤 현재 화면을 유지하고 안전한 오류와 다시 시도를 제공한다", async () => {
    mocks.exportCloudRoomQuestionsCsv.mockRejectedValueOnce(new Error("private failure"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "채팅 기록 내보내기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("현재 채팅 기록을 내보낼 수 없습니다.");
    expect(screen.getByRole("heading", { name: "종료 테스트 강의방" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(mocks.exportCloudRoomQuestionsCsv).toHaveBeenCalledTimes(2));
  });
});
