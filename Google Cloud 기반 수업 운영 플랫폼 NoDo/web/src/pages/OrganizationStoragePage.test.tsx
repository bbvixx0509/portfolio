import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationStoragePage } from "./OrganizationStoragePage";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  update: vi.fn(),
  useAuth: vi.fn(),
}));
vi.mock("../features/auth/AuthContext", () => ({ useAuth: mocks.useAuth }));
vi.mock("../features/material-selection/storageQuotaApi", () => ({
  loadInstructorStorageUsage: mocks.load,
  updateInstructorStorageLimit: mocks.update,
  storageLabel: (bytes: number) => `${bytes / 1024 ** 3}GB`,
}));

const items = [{ memberKey: "opaque-member", displayName: "강사 A", usedBytes: 2 * 1024 ** 3, reservedBytes: 0, limitBytes: 5 * 1024 ** 3, remainingBytes: 3 * 1024 ** 3 }];
function renderPage() { return render(<MemoryRouter><OrganizationStoragePage /></MemoryRouter>); }

describe("OrganizationStoragePage", () => {
  beforeEach(() => { mocks.useAuth.mockReturnValue({ profile: { organizationRole: "ADMIN" } }); mocks.load.mockResolvedValue(items); mocks.update.mockResolvedValue({}); });
  it("관리자에게 표시명과 집계 및 10/20/50GB·직접 입력 제어만 표시한다", async () => {
    renderPage(); expect(await screen.findByText("강사 A")).toBeInTheDocument();
    for (const label of ["10GB", "20GB", "50GB"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    expect(screen.getByLabelText("강사 A 직접 한도")).toBeInTheDocument();
    for (const secret of ["파일명", "추출 텍스트", "다운로드 이력", "@", "uid"]) expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });
  it("조회 실패 뒤 안전한 안내와 다시 시도 버튼으로 목록을 복구한다", async () => {
    mocks.load.mockRejectedValueOnce(new Error("internal failure")).mockResolvedValueOnce(items);
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("자료 용량 정보를 불러오지 못했습니다");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("강사 A")).toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
  it("빠른 선택과 유효한 직접 입력은 저장 버튼으로만 서버 한도 변경을 요청한다", async () => {
    renderPage(); await screen.findByText("강사 A"); fireEvent.click(screen.getByRole("button", { name: "20GB" }));
    expect(mocks.update).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("opaque-member", 20 * 1024 ** 3));
    const input = screen.getByLabelText("강사 A 직접 한도"); fireEvent.change(input, { target: { value: "37" } }); fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("opaque-member", 37 * 1024 ** 3));
  });
  it("일반 강사는 화면 내용을 볼 수 없다", () => { mocks.useAuth.mockReturnValue({ profile: { organizationRole: "INSTRUCTOR" } }); renderPage(); expect(screen.getByText("조직 관리 권한이 없습니다.")).toBeInTheDocument(); expect(screen.queryByText("강사 A")).not.toBeInTheDocument(); });
});
