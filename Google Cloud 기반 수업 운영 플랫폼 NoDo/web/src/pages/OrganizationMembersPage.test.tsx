import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/apiClient";

const mocks = vi.hoisted(() => ({
  user: { uid: "admin-uid" },
  profile: {
    uid: "admin-uid",
    email: "admin@nodo-company.test",
    organizationRole: "ADMIN",
    isAdmin: true,
  },
  loadOrganizationMembers: vi.fn(),
  loadStaffInvitations: vi.fn(),
  createStaffInvitation: vi.fn(),
  resendStaffInvitation: vi.fn(),
  revokeStaffInvitation: vi.fn(),
  updateOrganizationRole: vi.fn(),
  removeOrganizationMember: vi.fn(),
}));

vi.mock("../features/auth/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, profile: mocks.profile }),
}));
vi.mock("../features/organization/organizationApi", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../features/organization/organizationApi")
  >();
  return {
    ...original,
    loadOrganizationMembers: mocks.loadOrganizationMembers,
    loadStaffInvitations: mocks.loadStaffInvitations,
    createStaffInvitation: mocks.createStaffInvitation,
    resendStaffInvitation: mocks.resendStaffInvitation,
    revokeStaffInvitation: mocks.revokeStaffInvitation,
    updateOrganizationRole: mocks.updateOrganizationRole,
    removeOrganizationMember: mocks.removeOrganizationMember,
  };
});

import { OrganizationMembersPage } from "./OrganizationMembersPage";

const snapshot = {
  members: [{
    uid: "admin-uid",
    email: "admin@nodo-company.test",
    displayName: "테스트 관리자",
    photoURL: null,
    organizationRole: "ADMIN",
    organizationRoleRevision: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
  }],
  count: 1,
};
const pendingInvitation = {
  id: "pending-id",
  email: "employee@nodo-company.test",
  status: "PENDING" as const,
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
  expiresAt: "2030-07-23T00:00:00.000Z",
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
};
const revokedInvitation = {
  ...pendingInvitation,
  id: "revoked-id",
  email: "former@nodo-company.test",
  status: "REVOKED" as const,
  revokedAt: "2026-07-17T00:00:00.000Z",
};
const employee = {
  uid: "employee-uid",
  email: "employee@nodo-company.test",
  displayName: "직원",
  photoURL: null,
  organizationRole: "INSTRUCTOR" as const,
  organizationRoleRevision: 1,
  createdAt: "2026-07-16T00:00:00.000Z",
};

function renderPage() {
  return render(
    <MemoryRouter><OrganizationMembersPage /></MemoryRouter>,
  );
}

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

describe("조직 구성원 관리 화면", () => {
  beforeEach(() => {
    mocks.loadOrganizationMembers.mockReset().mockResolvedValue(snapshot);
    mocks.loadStaffInvitations.mockReset().mockResolvedValue([
      pendingInvitation,
      revokedInvitation,
    ]);
    mocks.createStaffInvitation.mockReset().mockResolvedValue(pendingInvitation);
    mocks.resendStaffInvitation.mockReset().mockResolvedValue(pendingInvitation);
    mocks.revokeStaffInvitation.mockReset().mockResolvedValue({
      ...pendingInvitation,
      status: "REVOKED",
      revokedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    mocks.updateOrganizationRole.mockReset();
    mocks.removeOrganizationMember.mockReset().mockResolvedValue({ removed: true });
    mocks.profile = {
      uid: "admin-uid",
      email: "admin@nodo-company.test",
      organizationRole: "ADMIN",
      isAdmin: true,
    };
  });

  it("로딩 후 구성원 수·가입 목록·대기 및 취소 승인을 표시한다", async () => {
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");

    expect(await screen.findByRole("heading", { name: "가입한 구성원" })).toBeInTheDocument();
    expect(screen.getByLabelText("현재 구성원 수")).toHaveTextContent("1명");
    expect(screen.getAllByText("관리자")).toHaveLength(1);
    expect(screen.getByText("employee@nodo-company.test")).toBeInTheDocument();
    expect(screen.getByText("former@nodo-company.test")).toBeInTheDocument();
    expect(screen.getByText("취소됨")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /테스트 관리자 구성원 제거/ })).not.toBeInTheDocument();
  });

  it("잘못된 도메인과 소유자 자신·이미 가입한 직원은 API 전에 차단한다", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "가입한 구성원" });
    const input = screen.getByLabelText("회사 Google 이메일");
    const submit = screen.getByRole("button", { name: "승인 등록" });

    fireEvent.change(input, { target: { value: "person@gmail.com" } });
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("@nodo-company.test");

    fireEvent.change(input, { target: { value: "ADMIN@NODO-COMPANY.TEST" } });
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("자신의 이메일");

    fireEvent.change(input, { target: { value: "admin@nodo-company.test" } });
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("자신의 이메일");
    expect(mocks.createStaffInvitation).not.toHaveBeenCalled();
  });

  it("회사 이메일을 정규화해 등록하고 성공 상태를 표시한다", async () => {
    mocks.createStaffInvitation.mockResolvedValue({
      ...pendingInvitation,
      id: "new-id",
      email: "new.employee@nodo-company.test",
    });
    renderPage();
    await screen.findByRole("heading", { name: "가입한 구성원" });

    fireEvent.change(screen.getByLabelText("회사 Google 이메일"), {
      target: { value: "  New.Employee@NODO-COMPANY.TEST  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "승인 등록" }));

    await waitFor(() => expect(mocks.createStaffInvitation).toHaveBeenCalledWith(
      mocks.user,
      "new.employee@nodo-company.test",
    ));
    expect(await screen.findByText(/조직 로그인 승인을 등록했습니다/)).toBeInTheDocument();
    expect(screen.getByText("new.employee@nodo-company.test")).toBeInTheDocument();
  });

  it("이미 가입한 직원 이메일은 새 초대 API 전에 차단한다", async () => {
    mocks.loadOrganizationMembers.mockResolvedValue({
      ...snapshot,
      members: [
        ...snapshot.members,
        {
          uid: "joined-uid",
          email: "joined@nodo-company.test",
          displayName: "가입 직원",
          photoURL: null,
          organizationRole: "INSTRUCTOR" as const,
          organizationRoleRevision: 1,
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      ],
      count: 2,
    });
    renderPage();
    await screen.findByText("가입 직원");
    fireEvent.change(screen.getByLabelText("회사 Google 이메일"), {
      target: { value: "JOINED@NODO-COMPANY.TEST" },
    });
    fireEvent.click(screen.getByRole("button", { name: "승인 등록" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("이미 DEMO 조직에 가입");
    expect(mocks.createStaffInvitation).not.toHaveBeenCalled();
  });

  it("PENDING 승인을 취소하고 취소된 기록으로 이동한다", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "대기 중인 승인" });
    fireEvent.click(screen.getByRole("button", { name: "employee@nodo-company.test 승인 취소" }));

    await waitFor(() => expect(mocks.revokeStaffInvitation).toHaveBeenCalledWith(
      mocks.user,
      "pending-id",
    ));
    expect(await screen.findByText(/조직 로그인 승인을 취소했습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "employee@nodo-company.test 승인 취소" })).not.toBeInTheDocument();
  });

  it("PENDING 승인을 이메일 발송 없이 갱신한다", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "대기 중인 승인" });
    fireEvent.click(screen.getByRole("button", { name: "employee@nodo-company.test 승인 갱신" }));

    await waitFor(() => expect(mocks.resendStaffInvitation).toHaveBeenCalledWith(
      mocks.user,
      "pending-id",
    ));
    expect(await screen.findByText(/조직 로그인 승인을 갱신했습니다/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/token|토큰/u);
  });

  it("이미 대기 중인 이메일은 중복 생성하지 않고 승인 갱신을 안내한다", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "대기 중인 승인" });
    fireEvent.change(screen.getByLabelText("회사 Google 이메일"), {
      target: { value: "employee@nodo-company.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "승인 등록" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "이미 대기 중인 승인입니다. 대기 목록에서 승인 갱신을 사용해 주세요.",
    );
    expect(mocks.createStaffInvitation).not.toHaveBeenCalled();
  });

  it("수락·거절·만료·취소 상태를 서로 구분해 표시한다", async () => {
    mocks.loadStaffInvitations.mockResolvedValue([
      {
        ...pendingInvitation,
        id: "accepted-id",
        email: "accepted@nodo-company.test",
        status: "ACCEPTED",
        acceptedAt: "2026-07-17T00:00:00.000Z",
      },
      {
        ...pendingInvitation,
        id: "declined-id",
        email: "declined@nodo-company.test",
        status: "DECLINED",
        declinedAt: "2026-07-17T00:00:00.000Z",
      },
      {
        ...pendingInvitation,
        id: "expired-id",
        email: "expired@nodo-company.test",
        status: "EXPIRED",
      },
      revokedInvitation,
    ]);
    renderPage();

    await screen.findByText("accepted@nodo-company.test");
    expect(screen.getByText("수락됨")).toBeInTheDocument();
    expect(screen.getByText("거절됨")).toBeInTheDocument();
    expect(screen.getByText("만료됨")).toBeInTheDocument();
    expect(screen.getByText("취소됨")).toBeInTheDocument();
  });

  it("승인 등록 서버 오류를 성공으로 오해하지 않게 안내한다", async () => {
    mocks.createStaffInvitation.mockRejectedValue(new ApiError(
      "server unavailable",
      500,
      { code: "temporarily_unavailable" },
    ));
    renderPage();
    await screen.findByRole("heading", { name: "가입한 구성원" });

    fireEvent.change(screen.getByLabelText("회사 Google 이메일"), {
      target: { value: "new@nodo-company.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "승인 등록" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "조직 정보를 불러오지 못했습니다",
    );
    expect(screen.queryByText(/조직 로그인 승인을 등록했습니다/)).not.toBeInTheDocument();
  });

  it("구성원과 초대가 없으면 각 목록의 빈 상태를 표시한다", async () => {
    mocks.loadOrganizationMembers.mockResolvedValue({
      organization: { id: "demo", name: "DEMO" },
      members: [],
      count: 0,
    });
    mocks.loadStaffInvitations.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("아직 가입한 구성원이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("대기 중인 조직 로그인 승인이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("완료되거나 취소된 승인이 없습니다.")).toBeInTheDocument();
  });

  it("관리자는 일반 강사를 관리자로 지정하고 해제 확인을 요청한다", async () => {
    const initialSnapshot = {
      ...snapshot,
      members: [...snapshot.members, employee],
      count: 2,
    };
    const managerSnapshot = {
      ...snapshot,
      members: [...snapshot.members, { ...employee, organizationRole: "ADMIN" as const, organizationRoleRevision: 2 }],
      count: 2,
    };
    mocks.loadOrganizationMembers.mockReset()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(managerSnapshot)
      .mockResolvedValueOnce(initialSnapshot);
    mocks.updateOrganizationRole.mockResolvedValue({
      ...employee,
      organizationRole: "ADMIN",
      organizationRoleRevision: 2,
    });
    renderPage();
    await screen.findByRole("button", { name: "employee@nodo-company.test 관리자로 지정" });

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "employee@nodo-company.test 관리자로 지정" }));
    await waitFor(() => expect(mocks.updateOrganizationRole).toHaveBeenCalledWith(
      mocks.user,
      "employee-uid", "ADMIN", 1,
    ));
    expect(await screen.findByText(/역할을 관리자로 변경했습니다/)).toBeInTheDocument();

    mocks.updateOrganizationRole.mockResolvedValue({ ...employee, organizationRole: "INSTRUCTOR", organizationRoleRevision: 3 });
    await screen.findByRole("button", { name: "employee@nodo-company.test 일반 강사로 변경" });
    fireEvent.click(screen.getByRole("button", { name: "employee@nodo-company.test 일반 강사로 변경" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("마지막 관리자"));
    await waitFor(() => expect(mocks.updateOrganizationRole).toHaveBeenLastCalledWith(
      mocks.user,
      "employee-uid", "INSTRUCTOR", 2,
    ));
    confirm.mockRestore();
  });

  it("관리자는 승인 등록과 구성원 역할 변경 버튼을 함께 볼 수 있다", async () => {
    mocks.profile = {
      uid: "manager-uid",
      email: "manager@nodo-company.test",
      organizationRole: "ADMIN",
      isAdmin: true,
    };
    mocks.loadOrganizationMembers.mockResolvedValue({
      ...snapshot,
      members: [
        ...snapshot.members,
        {
          uid: "employee-uid",
          email: "employee@nodo-company.test",
          displayName: "직원",
          photoURL: null,
          organizationRole: "INSTRUCTOR" as const,
          organizationRoleRevision: 1,
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      ],
      count: 2,
    });
    renderPage();
    await screen.findByRole("heading", { name: "가입한 구성원" });

    expect(screen.getByRole("button", { name: "승인 등록" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "employee@nodo-company.test 관리자로 지정" })).toBeInTheDocument();
  });

  it("본인에게는 제거 버튼을 숨기고 다른 구성원에게만 표시한다", async () => {
    mocks.loadOrganizationMembers.mockResolvedValue({
      members: [...snapshot.members, employee],
      count: 2,
    });

    renderPage();
    await screen.findByText("직원");

    expect(screen.queryByRole("button", { name: "테스트 관리자 구성원 제거" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "직원 구성원 제거" })).toBeEnabled();
  });

  it("구성원 제거 확인 대화상자에서 취소하면 요청하지 않는다", async () => {
    mocks.loadOrganizationMembers.mockResolvedValue({
      members: [...snapshot.members, employee],
      count: 2,
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "직원 구성원 제거" }));

    expect(screen.getByRole("heading", { name: "구성원을 제거할까요?" })).toBeInTheDocument();
    expect(screen.getByText(/Firebase 또는 Google 계정은 삭제되지 않습니다/)).toBeInTheDocument();
    expect(screen.getByText(
      /진행 중이거나 준비 중인 수업의 주 강사 권한이 현재 관리자에게\s*자동 이관됩니다/,
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "구성원 제거" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.removeOrganizationMember).not.toHaveBeenCalled();
  });

  it("제거 성공 뒤 구성원 목록과 인원 수를 즉시 갱신한다", async () => {
    mocks.loadOrganizationMembers.mockResolvedValue({
      members: [...snapshot.members, employee],
      count: 2,
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "직원 구성원 제거" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "구성원 제거" }));

    await waitFor(() => expect(mocks.removeOrganizationMember).toHaveBeenCalledWith(
      mocks.user,
      "employee-uid",
    ));
    expect(await screen.findByText(
      "구성원을 제거했습니다. NoDo 조직 접근 권한이 해제되었습니다.",
    )).toBeInTheDocument();
    expect(screen.queryByText("직원")).not.toBeInTheDocument();
    expect(screen.getByLabelText("현재 구성원 수")).toHaveTextContent("1명");
  });

  it("마지막 관리자 제거를 비활성화하고 이유를 표시한다", async () => {
    mocks.loadOrganizationMembers.mockResolvedValue({
      members: [{
        ...employee,
        uid: "last-admin-uid",
        displayName: "마지막 관리자",
        organizationRole: "ADMIN" as const,
      }],
      count: 1,
    });

    renderPage();

    expect(await screen.findByRole("button", { name: "마지막 관리자 구성원 제거" })).toBeDisabled();
    expect(screen.getByText("조직의 마지막 관리자입니다. 다른 관리자를 먼저 지정한 뒤 제거해 주세요.")).toBeInTheDocument();
  });

  it("일시 오류 뒤 입력 상태를 유지하고 제거 요청을 재시도할 수 있다", async () => {
    mocks.loadOrganizationMembers.mockResolvedValue({
      members: [...snapshot.members, employee],
      count: 2,
    });
    mocks.removeOrganizationMember
      .mockRejectedValueOnce(new ApiError(
        "internal-uid should not render",
        500,
      ))
      .mockResolvedValueOnce({ removed: true });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "직원 구성원 제거" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "구성원 제거" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "구성원을 제거하지 못했습니다.",
    );
    expect(document.body).not.toHaveTextContent("internal-uid");

    fireEvent.click(screen.getByRole("button", { name: "구성원 제거" }));
    await waitFor(() => expect(mocks.removeOrganizationMember).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/NoDo 조직 접근 권한이 해제되었습니다/)).toBeInTheDocument();
  });

  it("관리자에게 자료 용량 관리 버튼을 표시하고 해당 화면으로 이동한다", async () => {
    render(
      <MemoryRouter initialEntries={["/organization/members"]}>
        <OrganizationMembersPage />
        <CurrentPath />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "가입한 구성원" });
    fireEvent.click(screen.getByRole("link", { name: "자료 용량 관리" }));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/organization/storage");
  });

  it("일반 강사에게 자료 용량 관리 버튼을 표시하지 않는다", async () => {
    mocks.profile = {
      uid: "instructor-uid",
      email: "instructor@nodo-company.test",
      organizationRole: "INSTRUCTOR",
      isAdmin: false,
    };
    renderPage();
    await screen.findByRole("heading", { name: "가입한 구성원" });
    expect(screen.queryByRole("link", { name: "자료 용량 관리" })).not.toBeInTheDocument();
  });

  it("빈 목록과 불러오기 오류·재시도 상태를 제공한다", async () => {
    mocks.loadOrganizationMembers.mockRejectedValueOnce(new Error("network"));
    renderPage();
    expect(await screen.findByRole("heading", { name: "조직 정보를 불러오지 못했습니다" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("heading", { name: "가입한 구성원" });
    expect(mocks.loadOrganizationMembers).toHaveBeenCalledTimes(2);
  });
});
