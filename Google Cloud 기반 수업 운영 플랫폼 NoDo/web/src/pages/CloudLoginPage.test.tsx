import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  loginWithGoogle: vi.fn(),
  reconnectLocalApi: vi.fn(),
  loginWithGoogleRedirect: vi.fn(),
  endStudentSession: vi.fn(),
  profile: null as null | Record<string, unknown>,
  organizationInvitation: null as null | Record<string, unknown>,
  identityKind: "signed-out" as "signed-out" | "staff" | "invited-staff" | "student",
  isLoading: false,
  isBootstrappingOrganization: false,
  isGoogleRedirecting: false,
  googleLoginRecoveryAvailable: false,
  localApiRecoveryAvailable: false,
  error: null as string | null,
}));

vi.mock("../config/runtimeMode", () => ({ isCloudAuthMode: true }));
vi.mock("../features/auth/AuthContext", () => ({
  useAuth: () => ({
    profile: authMocks.profile,
    organizationInvitation: authMocks.organizationInvitation,
    identityKind: authMocks.identityKind,
    isLoading: authMocks.isLoading,
    isBootstrappingOrganization: authMocks.isBootstrappingOrganization,
    isGoogleRedirecting: authMocks.isGoogleRedirecting,
    googleLoginRecoveryAvailable: authMocks.googleLoginRecoveryAvailable,
    localApiRecoveryAvailable: authMocks.localApiRecoveryAvailable,
    error: authMocks.error,
    loginWithGoogle: authMocks.loginWithGoogle,
    reconnectLocalApi: authMocks.reconnectLocalApi,
    loginWithGoogleRedirect: authMocks.loginWithGoogleRedirect,
    endStudentSession: authMocks.endStudentSession,
  }),
}));

import { LoginPage } from "./LoginPage";

describe("cloud-auth Google 로그인 화면", () => {
  beforeEach(() => {
    authMocks.loginWithGoogle.mockReset();
    authMocks.reconnectLocalApi.mockReset();
    authMocks.loginWithGoogleRedirect.mockReset();
    authMocks.endStudentSession.mockReset().mockResolvedValue(undefined);
    authMocks.profile = null;
    authMocks.organizationInvitation = null;
    authMocks.identityKind = "signed-out";
    authMocks.isLoading = false;
    authMocks.isBootstrappingOrganization = false;
    authMocks.isGoogleRedirecting = false;
    authMocks.googleLoginRecoveryAvailable = false;
    authMocks.localApiRecoveryAvailable = false;
    authMocks.error = null;
    sessionStorage.clear();
  });

  it("역할·테스트 계정·비밀번호 없이 팝업 Google 로그인만 표시한다", () => {
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Google 로그인" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Google로 시작하기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "리디렉션으로 로그인" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("비밀번호")).not.toBeInTheDocument();
    expect(screen.queryByText(/테스트 계정/)).not.toBeInTheDocument();
  });

  it("Google 팝업 오류를 화면에서 다시 시도할 수 있게 안내한다", async () => {
    authMocks.loginWithGoogle.mockRejectedValue(new Error("Google 로그인이 취소되었습니다."));
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: "Google로 시작하기" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/취소되었습니다/),
    );
    expect(screen.getByRole("button", { name: "Google로 시작하기" })).toBeEnabled();
  });

  it("로그인 복구 상태에서는 팝업 재시도만 표시한다", async () => {
    authMocks.googleLoginRecoveryAvailable = true;
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);

    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(authMocks.loginWithGoogle).toHaveBeenCalledTimes(1);
  });

  it("초기 연결 오류는 원문 없이 재시도 동작을 표시한다", () => {
    authMocks.error = "인증 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    authMocks.googleLoginRecoveryAvailable = true;
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);

    expect(screen.getByRole("alert")).toHaveTextContent("인증 서비스에 연결");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Failed to fetch");
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  it("로컬 FastAPI 502는 Google 팝업 대신 연결 확인으로 복구한다", async () => {
    authMocks.localApiRecoveryAvailable = true;
    authMocks.error = "NoDo 로컬 FastAPI(127.0.0.1:8082)가 실행 중인지 확인한 뒤 다시 연결해 주세요.";
    authMocks.reconnectLocalApi.mockResolvedValue(undefined);
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);

    expect(await screen.findByRole("alert")).toHaveTextContent("로컬 서버에 연결하지 못했습니다.");
    expect(screen.getByRole("alert")).toHaveTextContent("127.0.0.1:8082");
    fireEvent.click(screen.getByRole("button", { name: "연결 다시 확인" }));
    await waitFor(() => expect(authMocks.reconnectLocalApi).toHaveBeenCalledTimes(1));
    expect(authMocks.loginWithGoogle).not.toHaveBeenCalled();
  });

  it("리디렉션 복귀 확인 상태도 접근 가능한 처리 메시지로 표시한다", () => {
    authMocks.isLoading = true;
    authMocks.isGoogleRedirecting = true;
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);

    expect(screen.getByRole("button", { name: "Google 로그인 확인 중" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Google 로그인 결과를 확인하고 있습니다");
  });

  it("초기 Firebase 확인이 지연돼도 Google 로그인을 시작할 수 있다", () => {
    authMocks.isLoading = true;
    authMocks.identityKind = "signed-out";
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);

    const button = screen.getByRole("button", { name: "Google로 시작하기" });
    expect(button).toBeEnabled();
    expect(screen.queryByText("Google 인증 결과를 안전하게 확인하고 있습니다.")).not.toBeInTheDocument();
  });

  it("조직 생성과 영구 프로필 재조회 중에는 전용 상태를 표시한다", () => {
    authMocks.isLoading = true;
    authMocks.isBootstrappingOrganization = true;
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);

    const button = screen.getByRole("button", { name: "조직 설정 중..." });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Google로 시작하기" })).not.toBeInTheDocument();
  });

  it("학생 참여 중에는 Google 로그인을 시작하지 않고 참여 종료를 요구한다", async () => {
    authMocks.identityKind = "student";
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);

    expect(screen.getByText(/현재 학생으로 참여 중입니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Google로 시작하기" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "학생 참여 종료" }));
    await waitFor(() => expect(authMocks.endStudentSession).toHaveBeenCalledTimes(1));
    expect(authMocks.loginWithGoogle).not.toHaveBeenCalled();
  });

  it("초대 수락 대기 세션은 로그아웃하지 않고 조직 가입 화면으로 이동한다", async () => {
    authMocks.identityKind = "invited-staff";
    authMocks.organizationInvitation = {
      organizationName: "DEMO",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/join-organization" element={<h1>조직 가입 화면</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "조직 가입 화면" })).toBeInTheDocument();
    expect(authMocks.loginWithGoogle).not.toHaveBeenCalled();
  });
});
