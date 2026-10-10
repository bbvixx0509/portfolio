import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/apiClient";

const authState = vi.hoisted(() => ({
  user: {
    uid: "masked-invited-staff",
    displayName: "초대 직원",
    email: "employee@nodo-company.test",
  } as null | Record<string, unknown>,
  profile: null as null | Record<string, unknown>,
  organizationInvitation: {
    organizationName: "DEMO",
    expiresAt: "2030-01-01T00:00:00.000Z",
  } as null | { organizationName: string; expiresAt: string },
  identityKind: "invited-staff" as
    | "loading"
    | "signed-out"
    | "staff"
    | "invited-staff",
  isLoading: false,
  acceptOrganizationInvitation: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../features/auth/AuthContext", () => ({ useAuth: () => authState }));

import {
  isInvitationExpired,
  OrganizationJoinPage,
  organizationJoinFailure,
} from "./OrganizationJoinPage";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/join-organization"]}>
      <Routes>
        <Route path="/join-organization" element={<OrganizationJoinPage />} />
        <Route path="/" element={<h1>NoDo 시작</h1>} />
        <Route path="/login" element={<h1>Google 로그인</h1>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("조직 가입 수락 화면", () => {
  beforeEach(() => {
    authState.user = {
      uid: "masked-invited-staff",
      displayName: "초대 직원",
      email: "employee@nodo-company.test",
    };
    authState.profile = null;
    authState.organizationInvitation = {
      organizationName: "DEMO",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    authState.identityKind = "invited-staff";
    authState.isLoading = false;
    authState.acceptOrganizationInvitation.mockReset().mockResolvedValue({
      accountType: "STAFF",
      organizationRole: "INSTRUCTOR",
    });
    authState.logout.mockReset().mockResolvedValue(undefined);
    sessionStorage.clear();
  });

  it("조직명·로그인 사용자·이메일·만료와 가입 및 로그아웃 동작을 표시한다", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "DEMO 조직에 초대되었습니다" })).toBeInTheDocument();
    expect(screen.getByText("초대 직원")).toBeInTheDocument();
    expect(screen.getByText("employee@nodo-company.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "조직 가입하기" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeEnabled();
    expect(screen.queryByText(/Firebase|Firestore|ID Token|UID/u)).not.toBeInTheDocument();
  });

  it("사용자가 가입 버튼을 누르기 전에는 수락 API를 호출하지 않고 성공 후 시작 화면으로 이동한다", async () => {
    renderPage();
    expect(authState.acceptOrganizationInvitation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "조직 가입하기" }));
    await waitFor(() => expect(authState.acceptOrganizationInvitation).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "NoDo 시작" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });

  it("만료되거나 취소된 초대는 가입 버튼 없이 안전하게 안내한다", () => {
    authState.organizationInvitation = {
      organizationName: "DEMO",
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    renderPage();
    expect(screen.getByRole("heading", { name: "초대가 만료되었거나 취소되었습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "조직 가입하기" })).not.toBeInTheDocument();
    expect(authState.acceptOrganizationInvitation).not.toHaveBeenCalled();
  });

  it("서버가 취소·만료를 거부하면 권한을 부여하지 않고 같은 상태를 표시한다", async () => {
    authState.acceptOrganizationInvitation.mockRejectedValue(new ApiError(
      "invitation unavailable",
      403,
      { code: "access_denied" },
    ));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "조직 가입하기" }));

    expect(await screen.findByRole("heading", { name: "초대가 만료되었거나 취소되었습니다" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/join-organization");
  });

  it("네트워크 오류는 다시 시도 가능한 오류로 표시하고 세션을 유지한다", async () => {
    authState.acceptOrganizationInvitation.mockRejectedValue(new Error("network"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "조직 가입하기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("네트워크 연결");
    expect(screen.getByRole("button", { name: "조직 가입하기" })).toBeEnabled();
    expect(authState.logout).not.toHaveBeenCalled();
  });

  it("이미 가입된 STAFF는 재수락 대신 시작 화면 이동을 안내한다", () => {
    authState.profile = {
      uid: "masked-staff",
      orgId: "demo",
      accountType: "STAFF",
      organizationRole: "INSTRUCTOR",
      authorized: true,
    };
    authState.organizationInvitation = null;
    authState.identityKind = "staff";
    renderPage();

    expect(screen.getByRole("heading", { name: "이미 DEMO 조직에 가입되어 있습니다" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "NoDo 시작하기" })).toHaveAttribute("href", "/");
    expect(authState.acceptOrganizationInvitation).not.toHaveBeenCalled();
  });

  it("로그아웃 버튼은 세션을 종료하고 로그인 화면으로 이동한다", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(authState.logout).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Google 로그인" })).toBeInTheDocument();
  });

  it("미로그인 사용자는 가입 화면 대신 기존 Google 로그인으로 이동한다", async () => {
    authState.user = null;
    authState.organizationInvitation = null;
    authState.identityKind = "signed-out";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Google 로그인" })).toBeInTheDocument();
    expect(authState.acceptOrganizationInvitation).not.toHaveBeenCalled();
  });

  it("만료 및 오류 상태 판정은 서버 내부 정보 없이 상태 코드만 사용한다", () => {
    expect(isInvitationExpired("2020-01-01T00:00:00.000Z", Date.parse("2021-01-01"))).toBe(true);
    expect(isInvitationExpired("2030-01-01T00:00:00.000Z", Date.parse("2021-01-01"))).toBe(false);
    expect(organizationJoinFailure(new ApiError("forbidden", 403))).toBe("UNAVAILABLE");
    expect(organizationJoinFailure(new ApiError("conflict", 409))).toBe("ALREADY_JOINED");
    expect(organizationJoinFailure(new Error("network"))).toBe("NETWORK");
  });
});
