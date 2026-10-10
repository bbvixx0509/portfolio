import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/apiClient";

const mocks = vi.hoisted(() => ({
  user: null as null | {
    uid: string;
    isAnonymous: boolean;
  },
  identityKind: "signed-out",
  isLoading: false,
  loginWithGoogle: vi.fn(),
  logout: vi.fn(),
  refreshProfile: vi.fn(),
  respond: vi.fn(),
}));

vi.mock("../features/auth/AuthContext", () => ({
  useAuth: () => ({
    user: mocks.user,
    identityKind: mocks.identityKind,
    isLoading: mocks.isLoading,
    loginWithGoogle: mocks.loginWithGoogle,
    logout: mocks.logout,
    refreshProfile: mocks.refreshProfile,
  }),
}));
vi.mock("../features/organization/organizationApi", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../features/organization/organizationApi")
  >();
  return {
    ...original,
    respondToStaffInvitation: mocks.respond,
  };
});

import {
  OrganizationInvitationActionPage,
  OrganizationInvitationDeclinedPage,
} from "./OrganizationInvitationActionPage";

const rawToken = "raw-secret-token";
const acceptedInvitation = {
  id: "masked-invitation",
  email: "invited@nodo-company.test",
  status: "ACCEPTED",
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  expiresAt: "2026-08-07T00:00:00.000Z",
  acceptedAt: "2026-07-31T00:01:00.000Z",
  declinedAt: null,
  revokedAt: null,
};

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderPage(action: "accept" | "decline") {
  return render(
    <MemoryRouter
      initialEntries={[`/organization/invitations/${rawToken}/${action}`]}
    >
      <Routes>
        <Route
          path="/organization/invitations/:rawToken/:action"
          element={<OrganizationInvitationActionPage action={action} />}
        />
        <Route
          path="/organization/invitations/declined"
          element={<OrganizationInvitationDeclinedPage />}
        />
        <Route path="/" element={<h1>NoDo 시작 화면</h1>} />
        <Route path="/login" element={<h1>NoDo 로그인</h1>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("조직 이메일 초대 수락·거절 화면", () => {
  beforeEach(() => {
    mocks.user = null;
    mocks.identityKind = "signed-out";
    mocks.isLoading = false;
    mocks.loginWithGoogle.mockReset().mockResolvedValue(null);
    mocks.logout.mockReset().mockResolvedValue(undefined);
    mocks.refreshProfile.mockReset().mockResolvedValue({
      organizationRole: "INSTRUCTOR",
    });
    mocks.respond.mockReset();
  });

  it("로그인 전에는 초대를 처리하지 않고 Google 로그인을 요구한다", async () => {
    renderPage("accept");

    expect(screen.getByRole("heading", { name: "조직 초대를 수락할까요?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Google 계정으로 로그인" })).toBeEnabled();
    expect(mocks.respond).not.toHaveBeenCalled();
    expect(screen.getByRole("main")).not.toHaveTextContent(rawToken);

    fireEvent.click(screen.getByRole("button", { name: "Google 계정으로 로그인" }));
    await waitFor(() => expect(mocks.loginWithGoogle).toHaveBeenCalledTimes(1));
    expect(mocks.respond).not.toHaveBeenCalled();
  });

  it("로그인한 사용자가 명시적으로 수락하면 서버 검증 후 시작 화면으로 이동한다", async () => {
    mocks.user = { uid: "masked-user", isAnonymous: false };
    mocks.identityKind = "invited-staff";
    mocks.respond.mockResolvedValue(acceptedInvitation);
    renderPage("accept");

    expect(mocks.respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));

    await waitFor(() => expect(mocks.respond).toHaveBeenCalledWith(
      mocks.user,
      rawToken,
      "accept",
    ));
    expect(mocks.refreshProfile).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "NoDo 시작 화면" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/");
  });

  it("거절 성공 시 멤버십이 생성되지 않았다는 완료 상태를 표시한다", async () => {
    mocks.user = { uid: "masked-user", isAnonymous: false };
    mocks.identityKind = "invited-staff";
    mocks.respond.mockResolvedValue({
      ...acceptedInvitation,
      status: "DECLINED",
      acceptedAt: null,
      declinedAt: "2026-07-31T00:01:00.000Z",
    });
    renderPage("decline");

    fireEvent.click(screen.getByRole("button", { name: "초대 거절" }));
    expect(await screen.findByRole("heading", { name: "초대를 거절했습니다" })).toBeInTheDocument();
    expect(screen.getByText("조직 멤버십은 생성되지 않았습니다.")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/organization/invitations/declined");
    expect(screen.getByTestId("location")).not.toHaveTextContent(rawToken);
    expect(mocks.refreshProfile).not.toHaveBeenCalled();
  });

  it("수락 후 프로필 갱신 실패 시 토큰 URL에서 재시도하고 이동하지 않는다", async () => {
    mocks.user = { uid: "masked-user", isAnonymous: false };
    mocks.identityKind = "invited-staff";
    mocks.respond.mockResolvedValue(acceptedInvitation);
    mocks.refreshProfile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ organizationRole: "INSTRUCTOR" });
    renderPage("accept");

    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("다시 시도");
    expect(screen.getByTestId("location")).toHaveTextContent(rawToken);

    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));
    expect(await screen.findByRole("heading", { name: "NoDo 시작 화면" })).toBeInTheDocument();
    expect(mocks.respond).toHaveBeenCalledTimes(2);
    expect(mocks.refreshProfile).toHaveBeenCalledTimes(2);
  });

  it("이메일 불일치와 만료 오류를 내부 정보 없이 구분한다", async () => {
    mocks.user = { uid: "masked-user", isAnonymous: false };
    mocks.identityKind = "invited-staff";
    mocks.respond.mockRejectedValueOnce(new ApiError(
      "forbidden",
      403,
      { detail: { code: "invitation_email_mismatch" } },
    ));
    const mismatch = renderPage("accept");
    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "로그인한 이메일이 초대받은 이메일과 일치하지 않습니다",
    );
    expect(screen.getByRole("button", { name: "다른 Google 계정으로 로그인" })).toBeEnabled();
    expect(screen.getByRole("main")).not.toHaveTextContent(rawToken);
    fireEvent.click(screen.getByRole("button", { name: "다른 Google 계정으로 로그인" }));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
    mismatch.unmount();

    mocks.respond.mockRejectedValueOnce(new ApiError(
      "expired",
      410,
      { detail: { code: "invitation_expired" } },
    ));
    renderPage("accept");
    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("초대가 만료되었습니다");
    expect(screen.queryByRole("button", { name: "초대 수락" })).not.toBeInTheDocument();
  });

  it("일시 실패는 같은 Firebase 세션으로 다시 시도할 수 있다", async () => {
    mocks.user = { uid: "masked-user", isAnonymous: false };
    mocks.identityKind = "invited-staff";
    mocks.respond
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(acceptedInvitation);
    renderPage("accept");

    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("다시 시도");
    expect(screen.getByRole("button", { name: "초대 수락" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "초대 수락" }));
    await waitFor(() => expect(mocks.respond).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: "NoDo 시작 화면" })).toBeInTheDocument();
  });
});
