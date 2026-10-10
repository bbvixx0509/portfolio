import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api/apiClient";

const mocks = vi.hoisted(() => ({ getCloudRoomMaterialAccess: vi.fn(), updateCloudRoomMaterialDownloadPolicy: vi.fn(), authUser: { getIdToken: vi.fn() } }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: mocks.authUser }) }));
vi.mock("./roomMaterialApi", () => mocks);
vi.mock("./LiveRoomMaterialPane", () => ({ LiveRoomMaterialPane: () => <p>자료 보기</p> }));
vi.mock("../live-room/LiveRoomShell", () => ({ LiveRoomShell: ({ context, panel }: { context: ReactNode; panel: ReactNode }) => <main>{context}{panel}</main> }));

import { StaffRoomMaterialPage } from "./RoomMaterialPage";

const material = { displayTitle: "자료", fileType: "pdf", totalUnits: 1, currentUnitNumber: 1, materialRevision: 1, canManageDownloadPolicy: true, canViewDownloadPolicy: true, downloadPolicyLocked: false, downloadAllowed: true, downloadEnabled: true, downloadAvailableFrom: null, downloadAvailableUntil: null, downloadPolicyRevision: 4 };
function renderPage() { return render(<MemoryRouter initialEntries={["/rooms/room-1/material"]}><Routes><Route path="/rooms/:roomId/material" element={<StaffRoomMaterialPage />} /></Routes></MemoryRouter>); }
afterEach(() => vi.resetAllMocks());

describe("StaffRoomMaterialPage", () => {
  it.each(["지금부터 1일", "7일", "30일"])("saves the %s quick deadline with the observed revision", async (preset) => {
    mocks.getCloudRoomMaterialAccess.mockResolvedValue({ material });
    mocks.updateCloudRoomMaterialDownloadPolicy.mockResolvedValue({ material: { ...material, downloadPolicyRevision: 5 } });
    renderPage();
    await screen.findByRole("heading", { name: "자료 다운로드 기간" });
    fireEvent.click(screen.getByRole("button", { name: preset }));
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(mocks.updateCloudRoomMaterialDownloadPolicy).toHaveBeenCalledWith(expect.anything(), "room-1", expect.objectContaining({ downloadEnabled: true, expectedDownloadPolicyRevision: 4, downloadAvailableUntil: expect.any(String) })));
  });

  it("converts a direct Korean deadline to the server UTC contract", async () => {
    mocks.getCloudRoomMaterialAccess.mockResolvedValue({ material });
    mocks.updateCloudRoomMaterialDownloadPolicy.mockResolvedValue({ material: { ...material, downloadPolicyRevision: 5 } });
    renderPage();
    await screen.findByRole("heading", { name: "자료 다운로드 기간" });
    const direct = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() + 2 * 86_400_000)).replace(" ", "T");
    fireEvent.change(screen.getByLabelText("직접 마감 날짜·시간"), { target: { value: direct } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(mocks.updateCloudRoomMaterialDownloadPolicy).toHaveBeenCalledWith(expect.anything(), "room-1", expect.objectContaining({ downloadAvailableUntil: new Date(`${direct}:00+09:00`).toISOString() })));
  });

  it("hides controls for non-leads and rooms without material", async () => {
    mocks.getCloudRoomMaterialAccess.mockResolvedValueOnce({ material: { ...material, canManageDownloadPolicy: false } });
    const view = renderPage();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "자료 다운로드 기간" })).not.toBeInTheDocument());
    view.unmount(); mocks.getCloudRoomMaterialAccess.mockResolvedValueOnce({ material: null }); renderPage();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "자료 다운로드 기간" })).not.toBeInTheDocument());
  });

  it("shows an ended lead the policy deadline as read-only without edit controls", async () => {
    mocks.getCloudRoomMaterialAccess.mockResolvedValue({ material: { ...material, canManageDownloadPolicy: false, downloadPolicyLocked: true, downloadAvailableUntil: "2030-01-01T09:00:00+00:00" } });
    renderPage();
    expect(await screen.findByText("강의가 종료되어 다운로드 기간은 읽기 전용입니다.")).toBeInTheDocument();
    expect(screen.getByText(/자료 다운로드 가능:/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "다운로드 허용" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "설정 저장" })).not.toBeInTheDocument();
  });

  it.each([
    ["권한 없음", new ApiError("forbidden", 403)],
    ["일시 서버 오류", new ApiError("unavailable", 503)],
  ])("keeps the staff material route visible for a %s material access error", async (_label, error) => {
    mocks.getCloudRoomMaterialAccess.mockRejectedValueOnce(error).mockResolvedValueOnce({ material });
    renderPage();
    expect(await screen.findByText("다운로드 설정을 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "강의 자료 보기" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Google 로그인" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다운로드 설정 다시 시도" }));
    expect(await screen.findByRole("heading", { name: "자료 다운로드 기간" })).toBeInTheDocument();
  });

  it("disables duplicate saves, validates invalid dates, handles disable, and shows safe failures", async () => {
    mocks.getCloudRoomMaterialAccess.mockResolvedValue({ material });
    let finish!: (value: unknown) => void;
    mocks.updateCloudRoomMaterialDownloadPolicy
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ material: { ...material, downloadEnabled: false, downloadPolicyRevision: 5 } });
    renderPage(); await screen.findByRole("heading", { name: "자료 다운로드 기간" });
    const date = screen.getByLabelText("직접 마감 날짜·시간");
    fireEvent.change(date, { target: { value: "2000-01-01T00:00" } }); fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    expect(await screen.findByText("마감 시간은 지금 이후 365일 이내로 선택해 주세요.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "7일" })); fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    expect(screen.getByRole("button", { name: "저장 중" })).toBeDisabled(); finish({ material });
    await screen.findByText("다운로드 기간을 저장했습니다.");
    fireEvent.click(screen.getByRole("checkbox", { name: "다운로드 허용" })); fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(mocks.updateCloudRoomMaterialDownloadPolicy).toHaveBeenLastCalledWith(expect.anything(), "room-1", expect.objectContaining({ downloadEnabled: false, downloadAvailableUntil: null })));
    mocks.updateCloudRoomMaterialDownloadPolicy.mockRejectedValueOnce(new Error("no")); fireEvent.click(screen.getByRole("checkbox", { name: "다운로드 허용" })); fireEvent.click(screen.getByRole("button", { name: "7일" })); fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    expect(await screen.findByText("다운로드 설정을 저장하지 못했습니다. 최신 상태를 확인해 주세요.")).toBeInTheDocument();
  });
});
