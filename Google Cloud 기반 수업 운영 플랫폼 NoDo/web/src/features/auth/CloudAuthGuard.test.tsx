import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  value: {
    user: null,
    profile: null,
    organizationInvitation: null,
    identityKind: "signed-out",
    isLoading: false,
    isBootstrappingOrganization: false,
    endStudentSession: vi.fn(),
    logout: vi.fn(),
  } as {
    user: unknown;
    profile: unknown;
    organizationInvitation: unknown;
    identityKind: "loading" | "signed-out" | "staff" | "staff-verification-failed" | "invited-staff" | "student" | "unsupported";
    isLoading: boolean;
    isBootstrappingOrganization: boolean;
    endStudentSession: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("./AuthContext", () => ({ useAuth: () => authState.value }));

import { CloudAuthGuard, OrganizationManagementGuard } from "./CloudAuthGuard";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderGuard(path = "/courses/import") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/courses/import"
          element={<CloudAuthGuard><h1>보호 화면</h1></CloudAuthGuard>}
        />
        <Route path="/login" element={<h1>Google 로그인</h1>} />
        <Route path="/join-organization" element={<h1>조직 가입</h1>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function renderOwnerGuard() {
  render(
    <MemoryRouter initialEntries={["/organization/members"]}>
      <Routes>
        <Route
          path="/organization/members"
          element={<OrganizationManagementGuard><h1>구성원 관리</h1></OrganizationManagementGuard>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CloudAuthGuard", () => {
  beforeEach(() => {
    sessionStorage.clear();
    authState.value = {
      user: null,
      profile: null,
      organizationInvitation: null,
      identityKind: "signed-out",
      isLoading: false,
      isBootstrappingOrganization: false,
      endStudentSession: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("인증 확인 중에는 보호 화면을 먼저 노출하지 않는다", () => {
    authState.value = {
      ...authState.value,
      identityKind: "loading",
      isLoading: true,
    };
    renderGuard();
    expect(screen.getByText(/회사 직원 권한 확인 중/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "보호 화면" })).not.toBeInTheDocument();
  });

  it("조직 Bootstrap 중에는 보호 화면 대신 조직 설정 상태를 표시한다", () => {
    authState.value = {
      ...authState.value,
      identityKind: "loading",
      isLoading: true,
      isBootstrappingOrganization: true,
    };
    renderGuard();
    expect(screen.getByText("조직 설정 중...")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "보호 화면" })).not.toBeInTheDocument();
  });

  it("미인증 직접 URL을 로그인으로 바꾸고 원래 경로를 기억한다", async () => {
    renderGuard();
    expect(await screen.findByRole("heading", { name: "Google 로그인" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/login");
    await waitFor(() =>
      expect(sessionStorage.getItem("nodo.cloud-auth.return-to")).toBe("/courses/import"),
    );
  });

  it("일반 STAFF도 서버 승인 프로필이 있으면 보호 화면을 표시한다", () => {
    authState.value = {
      user: { uid: "approved" },
      profile: {
        uid: "approved",
        orgId: "demo",
        accountType: "STAFF",
        authorized: true,
        organizationRole: "INSTRUCTOR",
        isAdmin: false,
      },
      organizationInvitation: null,
      identityKind: "staff",
      isLoading: false,
      isBootstrappingOrganization: false,
      endStudentSession: vi.fn(),
      logout: vi.fn(),
    };
    renderGuard();
    expect(screen.getByRole("heading", { name: "보호 화면" })).toBeInTheDocument();
  });

  it("초대 수락 대기 사용자는 세션을 유지한 채 조직 가입 화면으로 이동한다", async () => {
    authState.value = {
      ...authState.value,
      user: { uid: "invited-staff", isAnonymous: false },
      organizationInvitation: {
        organizationName: "DEMO",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      identityKind: "invited-staff",
    };
    renderGuard();

    expect(await screen.findByRole("heading", { name: "조직 가입" })).toBeInTheDocument();
    expect(authState.value.logout).not.toHaveBeenCalled();
  });

  it("STAFF 권한 확인의 일시 실패는 로그인 화면으로 보내거나 로그아웃하지 않는다", () => {
    authState.value = {
      ...authState.value,
      user: { uid: "verified-staff", isAnonymous: false },
      identityKind: "staff-verification-failed",
    };
    renderGuard();
    expect(screen.getByRole("heading", { name: "직원 권한을 다시 확인하지 못했습니다" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/courses/import");
    expect(authState.value.logout).not.toHaveBeenCalled();
  });

  it("일반 STAFF는 구성원 관리 내용을 볼 수 없다", () => {
    authState.value = {
      ...authState.value,
      user: { uid: "staff", isAnonymous: false },
      profile: {
        uid: "staff",
        orgId: "demo",
        accountType: "STAFF",
        authorized: true,
        organizationRole: "INSTRUCTOR",
        isAdmin: false,
      },
      identityKind: "staff",
    };
    renderOwnerGuard();
    expect(screen.getByRole("heading", { name: "조직 관리 권한이 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "구성원 관리" })).not.toBeInTheDocument();
  });

  it("관리자는 구성원 관리 내용을 볼 수 있다", () => {
    authState.value = {
      ...authState.value,
      user: { uid: "admin", isAnonymous: false },
      profile: {
        uid: "admin",
        orgId: "demo",
        accountType: "STAFF",
        authorized: true,
        organizationRole: "ADMIN",
        isAdmin: true,
      },
      identityKind: "staff",
    };
    renderOwnerGuard();
    expect(screen.getByRole("heading", { name: "구성원 관리" })).toBeInTheDocument();
  });

  it("학생이 강사 URL에 접근하면 권한 없음만 표시하고 보호 화면을 숨긴다", async () => {
    const endStudentSession = vi.fn().mockResolvedValue(undefined);
    authState.value = {
      user: { uid: "student", isAnonymous: true },
      profile: null,
      organizationInvitation: null,
      identityKind: "student",
      isLoading: false,
      isBootstrappingOrganization: false,
      endStudentSession,
      logout: vi.fn(),
    };
    renderGuard();

    expect(screen.getByRole("heading", { name: "권한이 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "보호 화면" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/courses/import");
    expect(sessionStorage.getItem("nodo.cloud-auth.return-to")).toBeNull();
    screen.getByRole("button", { name: "현재 상태 종료" }).click();
    await waitFor(() => expect(endStudentSession).toHaveBeenCalledTimes(1));
  });
});
