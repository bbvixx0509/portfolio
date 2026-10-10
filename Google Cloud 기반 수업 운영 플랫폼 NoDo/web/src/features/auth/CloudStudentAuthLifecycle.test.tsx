import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api/apiClient";

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null as null | Record<string, unknown> },
  observer: null as null | ((user: Record<string, unknown> | null) => void),
  requestApi: vi.fn(),
  checkLocalCloudApiHealth: vi.fn(),
  isLocalCloudApiRecoveryEnabled: vi.fn(),
  getRedirectResult: vi.fn(),
  onAuthStateChanged: vi.fn(),
  setPersistence: vi.fn().mockResolvedValue(undefined),
  signInAnonymously: vi.fn(),
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
  signOut: vi.fn(),
  sessionPersistence: { name: "session" },
  localPersistence: { name: "local" },
}));

vi.mock("../../config/runtimeMode", () => ({
  runtimeMode: "cloud-auth",
  isCloudAuthMode: true,
}));
vi.mock("../../lib/firebase/firebaseAuth", () => ({
  getCloudFirebaseAuth: () => mocks.auth,
  getLocalFirebaseAuth: () => mocks.auth,
}));
vi.mock("../../lib/api/apiClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api/apiClient")>();
  return { ...original, requestApi: mocks.requestApi };
});
vi.mock("./localCloudApiHealth", () => ({
  checkLocalCloudApiHealth: mocks.checkLocalCloudApiHealth,
  isLocalCloudApiRecoveryEnabled: mocks.isLocalCloudApiRecoveryEnabled,
}));
vi.mock("firebase/auth", () => ({
  browserLocalPersistence: mocks.localPersistence,
  browserSessionPersistence: mocks.sessionPersistence,
  getRedirectResult: mocks.getRedirectResult,
  GoogleAuthProvider: class {
    setCustomParameters() {}
  },
  onAuthStateChanged: vi.fn(
    (_auth, next: (user: Record<string, unknown> | null) => void) => {
      return mocks.onAuthStateChanged(_auth, next);
    },
  ),
  setPersistence: mocks.setPersistence,
  signInAnonymously: mocks.signInAnonymously,
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: mocks.signInWithPopup,
  signInWithRedirect: mocks.signInWithRedirect,
  signOut: mocks.signOut,
}));

import {
  AuthProvider,
  googleAuthErrorMessage,
  GOOGLE_AUTH_BOOTSTRAP_TIMEOUT_MS,
  useAuth,
} from "./AuthContext";

const studentResponse = {
  accountType: "STUDENT",
  isAnonymous: true,
  identityVerified: true,
  provider: "anonymous",
  scope: "AUTH_ONLY",
  roomAuthorized: false,
  nickname: "차분한 별빛",
  roomCode: "TEST123",
};

function anonymousUser() {
  return {
    uid: "masked-student",
    isAnonymous: true,
    providerData: [],
    getIdToken: vi.fn().mockResolvedValue("masked-token"),
    getIdTokenResult: vi.fn().mockResolvedValue({
      claims: {
        aud: "example-gcp-project",
        iss: "https://securetoken.google.com/example-gcp-project",
      },
    }),
  };
}

function googleUser() {
  return {
    uid: "masked-staff",
    isAnonymous: false,
    email: "masked@example.test",
    displayName: "NoDo 관리자",
    photoURL: null,
    providerData: [{ providerId: "google.com" }],
    getIdToken: vi.fn().mockResolvedValue("masked-token"),
    getIdTokenResult: vi.fn().mockResolvedValue({
      claims: {
        aud: "example-gcp-project",
        iss: "https://securetoken.google.com/example-gcp-project",
      },
    }),
  };
}

function permanentStaffResponse(user = googleUser()) {
  return {
    uid: user.uid,
    orgId: "demo",
    displayName: user.displayName,
    email: user.email,
    accountType: "STAFF",
    organizationRole: "ADMIN",
    isAdmin: true,
    isAnonymous: false,
    provider: "google.com",
    emailVerified: true,
    authorized: true,
  };
}

function Probe() {
  const {
    identityKind,
    studentSession,
    profile,
    organizationInvitation,
    isLoading,
    isBootstrappingOrganization,
    isGoogleRedirecting,
    googleLoginRecoveryAvailable,
    localApiRecoveryAvailable,
    authDiagnostics,
    error,
    startStudentSession,
    endStudentSession,
    loginWithGoogle,
    reconnectLocalApi,
    loginWithGoogleRedirect,
    acceptOrganizationInvitation,
  } = useAuth();
  const [actionError, setActionError] = useState("");
  return (
    <>
      <output data-testid="identity">{identityKind}</output>
      <output data-testid="loading">{String(isLoading)}</output>
      <output data-testid="student">{studentSession?.nickname ?? "none"}</output>
      <output data-testid="staff-uid">{profile?.uid ?? "none"}</output>
      <output data-testid="staff-org">{profile?.orgId ?? "none"}</output>
      <output data-testid="invitation">
        {organizationInvitation?.organizationName ?? "none"}
      </output>
      <output data-testid="bootstrap">
        {isBootstrappingOrganization ? "조직 설정 중..." : "none"}
      </output>
      <output data-testid="google-redirecting">{String(isGoogleRedirecting)}</output>
      <output data-testid="google-recovery">{String(googleLoginRecoveryAvailable)}</output>
      <output data-testid="local-api-recovery">{String(localApiRecoveryAvailable)}</output>
      <output data-testid="auth-diagnostics">{JSON.stringify(authDiagnostics)}</output>
      <output data-testid="action-error">{actionError}</output>
      <output data-testid="auth-error">{error ?? "none"}</output>
      <button
        type="button"
        onClick={() => void startStudentSession("TEST123", "차분한 별빛").catch(
          (error: unknown) => setActionError(error instanceof Error ? error.message : "error"),
        )}
      >학생 시작</button>
      <button
        type="button"
        onClick={() => void endStudentSession().catch(
          (nextError: unknown) => setActionError(
            nextError instanceof Error ? nextError.message : "error",
          ),
        )}
      >학생 종료</button>
      <button
        type="button"
        onClick={() => void loginWithGoogle().catch(
          (error: unknown) => setActionError(error instanceof Error ? error.message : "error"),
        )}
      >강사 로그인</button>
      <button
        type="button"
        onClick={() => void reconnectLocalApi().catch(
          (error: unknown) => setActionError(error instanceof Error ? error.message : "error"),
        )}
      >로컬 연결 확인</button>
      <button
        type="button"
        onClick={() => void loginWithGoogleRedirect().catch(
          (nextError: unknown) => setActionError(
            nextError instanceof Error ? nextError.message : "error",
          ),
        )}
      >강사 리디렉션 로그인</button>
      <button
        type="button"
        onClick={() => void acceptOrganizationInvitation().catch(
          (nextError: unknown) => setActionError(
            nextError instanceof Error ? nextError.message : "error",
          ),
        )}
      >조직 가입</button>
    </>
  );
}

function renderProvider() {
  return render(<AuthProvider><Probe /></AuthProvider>);
}

describe("cloud-auth 학생 수명 주기", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    window.history.replaceState({}, "", "/?authDebug=1");
    sessionStorage.clear();
    mocks.auth.currentUser = null;
    mocks.observer = null;
    mocks.requestApi.mockReset();
    mocks.checkLocalCloudApiHealth.mockReset().mockResolvedValue(undefined);
    mocks.isLocalCloudApiRecoveryEnabled.mockReset().mockReturnValue(false);
    mocks.getRedirectResult.mockReset().mockResolvedValue(null);
    mocks.onAuthStateChanged.mockReset().mockImplementation(
      (_auth, next: (user: Record<string, unknown> | null) => void) => {
        mocks.observer = next;
        next(mocks.auth.currentUser);
        return () => undefined;
      },
    );
    mocks.setPersistence.mockReset().mockResolvedValue(undefined);
    mocks.signInAnonymously.mockReset().mockImplementation(async () => {
      const user = anonymousUser();
      mocks.auth.currentUser = user;
      mocks.observer?.(user);
      return { user };
    });
    mocks.signInWithPopup.mockReset();
    mocks.signInWithRedirect.mockReset();
    mocks.signOut.mockReset().mockImplementation(async () => {
      mocks.auth.currentUser = null;
      mocks.observer?.(null);
    });
  });

  it("Google 로그인 오류를 계정 정보 없이 복구 가능한 안내로 변환한다", () => {
    expect(googleAuthErrorMessage({ code: "auth/popup-closed-by-user" })).toBe(
      "Google 로그인이 취소되었습니다.",
    );
    expect(googleAuthErrorMessage({ code: "auth/popup-blocked" })).toBe(
      "브라우저에서 로그인 팝업이 차단되었습니다. 주소창에서 팝업을 허용한 뒤 다시 시도해 주세요.",
    );
    expect(googleAuthErrorMessage({ code: "auth/unauthorized-domain" })).toBe(
      "현재 접속 주소가 Firebase 승인 도메인과 일치하지 않습니다.",
    );
    expect(googleAuthErrorMessage(new ApiError("private", 0, {
      code: "ID_TOKEN_UNAVAILABLE",
    }))).toBe("Google 로그인 정보 확인에 실패했습니다. 다시 로그인해 주세요.");
    expect(googleAuthErrorMessage(new ApiError("private", 401))).toBe(
      "로그인 세션을 다시 확인해 주세요.",
    );
    expect(googleAuthErrorMessage(new ApiError("private", 403))).toBe(
      "승인된 회사 Google 계정으로 로그인해 주세요.",
    );
    expect(googleAuthErrorMessage(new ApiError("private", 409, {
      code: "invitation_expired",
    }))).toBe(
      "조직 로그인 승인이 만료되었습니다. 관리자에게 새 승인을 요청해 주세요.",
    );
    expect(googleAuthErrorMessage(new ApiError("private", 409))).toContain(
      "조직 로그인 승인 또는 역할 전환 확인",
    );
  });

  it("참여 버튼 전에는 사용자를 만들지 않고 session persistence 다음에만 시작한다", async () => {
    mocks.requestApi.mockResolvedValue(studentResponse);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "학생 시작" }));
    await waitFor(() => expect(screen.getByTestId("student")).toHaveTextContent("차분한 별빛"));

    expect(mocks.setPersistence).toHaveBeenCalledWith(mocks.auth, mocks.sessionPersistence);
    expect(mocks.setPersistence.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signInAnonymously.mock.invocationCallOrder[0],
    );
    expect(mocks.signInAnonymously.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestApi.mock.invocationCallOrder[0],
    );
    expect(mocks.requestApi).toHaveBeenCalledWith("/api/auth/student-session", {
      method: "POST",
      body: { nickname: "차분한 별빛", roomCode: "TEST123" },
      authUser: expect.objectContaining({ isAnonymous: true }),
    });
    expect(mocks.requestApi).not.toHaveBeenCalledWith("/api/auth/me", expect.anything());
    expect(mocks.requestApi).not.toHaveBeenCalledWith(
      "/api/auth/bootstrap-organization",
      expect.anything(),
    );
    expect(mocks.requestApi).not.toHaveBeenCalledWith(
      "/api/auth/accept-organization-invitation",
      expect.anything(),
    );
    expect(sessionStorage.getItem("nodo.student.nickname")).toBe("차분한 별빛");
    expect(sessionStorage.getItem("nodo.student.room-code")).toBe("TEST123");
  });

  it("같은 탭에서 복원된 학생을 저장된 최소 정보로 다시 확인한다", async () => {
    const restored = anonymousUser();
    mocks.auth.currentUser = restored;
    sessionStorage.setItem("nodo.student.nickname", "차분한 별빛");
    sessionStorage.setItem("nodo.student.room-code", "TEST123");
    mocks.requestApi.mockResolvedValue(studentResponse);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("student")).toHaveTextContent("차분한 별빛"));
    expect(mocks.requestApi).toHaveBeenCalledTimes(1);
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
    expect(mocks.requestApi).toHaveBeenCalledWith("/api/auth/student-session", {
      method: "POST",
      body: { nickname: "차분한 별빛", roomCode: "TEST123" },
      authUser: restored,
    });
    expect(mocks.requestApi).not.toHaveBeenCalledWith(
      "/api/auth/me",
      expect.anything(),
    );
    expect(mocks.requestApi).not.toHaveBeenCalledWith(
      "/api/auth/bootstrap-organization",
      expect.anything(),
    );
    expect(mocks.requestApi).not.toHaveBeenCalledWith(
      "/api/auth/accept-organization-invitation",
      expect.anything(),
    );
  });

  it("학생 참여 종료 시 로그아웃하고 별명과 참여 코드를 삭제한다", async () => {
    const restored = anonymousUser();
    mocks.auth.currentUser = restored;
    sessionStorage.setItem("nodo.student.nickname", "차분한 별빛");
    sessionStorage.setItem("nodo.student.room-code", "TEST123");
    mocks.requestApi.mockResolvedValue(studentResponse);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("student")).toHaveTextContent("차분한 별빛"));

    fireEvent.click(screen.getByRole("button", { name: "학생 종료" }));
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("nodo.student.nickname")).toBeNull();
    expect(sessionStorage.getItem("nodo.student.room-code")).toBeNull();
  });

  it("학생 참여 종료의 signOut이 실패하면 복원 정보와 학생 상태를 유지한다", async () => {
    const restored = anonymousUser();
    mocks.auth.currentUser = restored;
    sessionStorage.setItem("nodo.student.nickname", "차분한 별빛");
    sessionStorage.setItem("nodo.student.room-code", "TEST123");
    mocks.requestApi.mockResolvedValue(studentResponse);
    mocks.signOut.mockReset().mockRejectedValue(new Error("signout-failed"));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("student")).toHaveTextContent("차분한 별빛"));

    fireEvent.click(screen.getByRole("button", { name: "학생 종료" }));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("종료하지 못했습니다"));
    expect(screen.getByTestId("identity")).toHaveTextContent("student");
    expect(screen.getByTestId("student")).toHaveTextContent("차분한 별빛");
    expect(sessionStorage.getItem("nodo.student.nickname")).toBe("차분한 별빛");
    expect(sessionStorage.getItem("nodo.student.room-code")).toBe("TEST123");
    expect(mocks.auth.currentUser).toBe(restored);
  });

  it("학생 세션 확인 실패 시 생성된 상태를 남기지 않고 안전한 오류만 표시한다", async () => {
    mocks.requestApi.mockRejectedValue(new Error("internal-sensitive-detail"));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByRole("button", { name: "학생 시작" }));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent(
      "참여를 완료하지 못했습니다",
    ));
    expect(screen.getByTestId("action-error")).not.toHaveTextContent("internal-sensitive-detail");
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("nodo.student.nickname")).toBeNull();
    expect(sessionStorage.getItem("nodo.student.room-code")).toBeNull();
  });

  it("학생 세션 확인 실패 후 signOut도 실패하면 실제 학생 사용자를 유지한다", async () => {
    mocks.requestApi.mockRejectedValue(new Error("verification-failed"));
    mocks.signOut.mockReset().mockRejectedValue(new Error("signout-failed"));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByRole("button", { name: "학생 시작" }));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("참여를 완료하지 못했습니다"));
    expect(screen.getByTestId("identity")).toHaveTextContent("student");
    expect(mocks.auth.currentUser).toMatchObject({ isAnonymous: true });
    expect(sessionStorage.getItem("nodo.student.nickname")).toBeNull();
    expect(sessionStorage.getItem("nodo.student.room-code")).toBeNull();
  });

  it("복원 검증 실패 후 signOut도 실패하면 저장 값을 지우지 않는다", async () => {
    const restored = anonymousUser();
    mocks.auth.currentUser = restored;
    sessionStorage.setItem("nodo.student.nickname", "차분한 별빛");
    sessionStorage.setItem("nodo.student.room-code", "TEST123");
    mocks.requestApi.mockRejectedValue(new Error("verification-failed"));
    mocks.signOut.mockReset().mockRejectedValue(new Error("signout-failed"));
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("auth-error")).toHaveTextContent("참여를 완료하지 못했습니다"));
    expect(screen.getByTestId("identity")).toHaveTextContent("student");
    expect(sessionStorage.getItem("nodo.student.nickname")).toBe("차분한 별빛");
    expect(sessionStorage.getItem("nodo.student.room-code")).toBe("TEST123");
    expect(mocks.auth.currentUser).toBe(restored);
  });

  it("정확한 Bootstrap 409에서만 조직을 생성한 뒤 영구 프로필을 다시 조회한다", async () => {
    const staff = googleUser();
    mocks.auth.currentUser = staff;
    let resolveBootstrap!: () => void;
    const pendingBootstrap = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });
    let profileRequestCount = 0;
    mocks.requestApi.mockImplementation(
      (path: string, options: Record<string, unknown>) => {
        if (path === "/api/auth/me") {
          profileRequestCount += 1;
          if (profileRequestCount === 1) {
            return Promise.reject(new ApiError(
              "organization bootstrap required",
              409,
              { code: "ORGANIZATION_BOOTSTRAP_REQUIRED" },
            ));
          }
          return Promise.resolve(permanentStaffResponse(staff));
        }
        if (path === "/api/auth/bootstrap-organization") {
          expect(options).toEqual({ method: "POST", authUser: staff });
          expect(options).not.toHaveProperty("body");
          return pendingBootstrap;
        }
        return Promise.reject(new Error(`unexpected path: ${path}`));
      },
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("bootstrap")).toHaveTextContent(
      "조직 설정 중...",
    ));
    expect(screen.getByTestId("identity")).toHaveTextContent("loading");

    await act(async () => {
      resolveBootstrap();
      await pendingBootstrap;
    });

    await waitFor(() => expect(screen.getByTestId("staff-org")).toHaveTextContent("demo"));
    expect(screen.getByTestId("staff-uid")).toHaveTextContent(staff.uid);
    expect(screen.getByTestId("bootstrap")).toHaveTextContent("none");
    expect(mocks.requestApi.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/me",
      "/api/auth/bootstrap-organization",
      "/api/auth/me",
    ]);
  });

  it("승인 409에서는 같은 Google 세션으로 자동 활성화 API를 정확히 한 번 호출한다", async () => {
    const staff = googleUser();
    const expiresAt = "2030-01-01T00:00:00.000Z";
    mocks.auth.currentUser = staff;
    mocks.requestApi.mockImplementation((path: string) => {
      if (path === "/api/auth/me") {
        return Promise.reject(new ApiError(
          "invitation acceptance required",
          409,
          {
            code: "ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED",
            organizationName: "DEMO",
            expiresAt,
          },
        ));
      }
      if (path === "/api/auth/accept-organization-invitation") {
        return Promise.resolve({
          ...permanentStaffResponse(staff),
          organizationRole: "INSTRUCTOR",
          isAdmin: false,
        });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    expect(screen.getByTestId("staff-org")).toHaveTextContent("demo");
    expect(screen.getByTestId("invitation")).toHaveTextContent("none");
    expect(mocks.auth.currentUser).toBe(staff);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.requestApi).toHaveBeenCalledTimes(2);
    expect(mocks.requestApi).toHaveBeenCalledWith(
      "/api/auth/accept-organization-invitation",
      { method: "POST", authUser: staff },
    );
    const acceptanceOptions = mocks.requestApi.mock.calls.find(
      ([path]) => path === "/api/auth/accept-organization-invitation",
    )?.[1];
    expect(acceptanceOptions).not.toHaveProperty("body");
  });

  it("자동 활성화 실패 시 권한을 만들지 않고 Firebase 세션을 유지한다", async () => {
    const staff = googleUser();
    mocks.auth.currentUser = staff;
    mocks.requestApi.mockImplementation((path: string) => {
      if (path === "/api/auth/me") {
        return Promise.reject(new ApiError(
          "invitation acceptance required",
          409,
          {
            code: "ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED",
            organizationName: "DEMO",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        ));
      }
      if (path === "/api/auth/accept-organization-invitation") {
        return Promise.reject(new ApiError("invitation unavailable", 403, {
          code: "access_denied",
        }));
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff-verification-failed"));
    expect(screen.getByTestId("auth-error")).toHaveTextContent(
      "승인된 회사 Google 계정으로 로그인해 주세요.",
    );
    expect(screen.getByTestId("staff-uid")).toHaveTextContent("none");
    expect(mocks.auth.currentUser).toBe(staff);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.requestApi.mock.calls.filter(
      ([path]) => path === "/api/auth/accept-organization-invitation",
    )).toHaveLength(1);
  });

  it.each([
    ["403", new ApiError("forbidden", 403, {
      code: "ORGANIZATION_BOOTSTRAP_REQUIRED",
    })],
    ["다른 409", new ApiError("conflict", 409, { code: "conflict" })],
    ["네트워크 오류", new Error("network failed")],
  ])("%s 오류에는 Firebase STAFF 세션을 지우지 않고 조직 Bootstrap도 호출하지 않는다", async (_label, requestError) => {
    const staff = googleUser();
    mocks.auth.currentUser = staff;
    mocks.requestApi.mockRejectedValue(requestError);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff-verification-failed"));
    expect(mocks.requestApi).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ authUser: staff }),
    );
    expect(mocks.requestApi).not.toHaveBeenCalledWith(
      "/api/auth/bootstrap-organization",
      expect.anything(),
    );
    expect(mocks.auth.currentUser).toBe(staff);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("복원된 STAFF의 401은 새 ID Token으로 한 번 재시도하고 세션을 유지한다", async () => {
    const staff = googleUser();
    mocks.auth.currentUser = staff;
    mocks.requestApi
      .mockRejectedValueOnce(new ApiError("private", 401))
      .mockResolvedValueOnce(permanentStaffResponse(staff));

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    expect(staff.getIdTokenResult).toHaveBeenCalledWith(true);
    expect(mocks.requestApi).toHaveBeenCalledTimes(2);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
  });

  it("/api/auth/me 502는 Google 세션을 유지하고 health 확인 뒤 팝업 없이 복구한다", async () => {
    const staff = googleUser();
    mocks.auth.currentUser = staff;
    mocks.isLocalCloudApiRecoveryEnabled.mockReturnValue(true);
    mocks.requestApi
      .mockRejectedValueOnce(new ApiError("proxy unavailable", 502))
      .mockResolvedValueOnce(permanentStaffResponse(staff));

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff-verification-failed"));
    expect(screen.getByTestId("local-api-recovery")).toHaveTextContent("true");
    expect(screen.getByTestId("auth-error")).toHaveTextContent("로컬 서버에 연결할 수 없습니다");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "로컬 연결 확인" }));

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    expect(mocks.checkLocalCloudApiHealth).toHaveBeenCalledTimes(2);
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
  });

  it("401 재시도 버튼은 기존 STAFF 세션을 다시 확인하고 새 팝업을 열지 않는다", async () => {
    const staff = googleUser();
    let profileRequestCount = 0;
    mocks.auth.currentUser = staff;
    mocks.requestApi.mockImplementation(() => {
      profileRequestCount += 1;
      return profileRequestCount <= 2
        ? Promise.reject(new ApiError("private", 401))
        : Promise.resolve(permanentStaffResponse(staff));
    });

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff-verification-failed"));
    expect(screen.getByTestId("google-recovery")).toHaveTextContent("true");

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    expect(profileRequestCount).toBe(3);
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("이전 Google 사용자의 늦은 409가 새 사용자를 로그아웃하거나 Bootstrap하지 않는다", async () => {
    const previousStaff = googleUser();
    const nextStaff = {
      ...googleUser(),
      uid: "masked-staff-next",
      email: "masked-next@example.test",
      displayName: "다음 관리자",
    };
    let rejectPreviousProfile!: (reason: unknown) => void;
    const pendingPreviousProfile = new Promise((_, reject) => {
      rejectPreviousProfile = reject;
    });
    mocks.auth.currentUser = previousStaff;
    mocks.requestApi.mockImplementation(
      (path: string, options: { authUser?: { uid?: string } }) => {
        if (path !== "/api/auth/me") {
          return Promise.reject(new Error(`unexpected path: ${path}`));
        }
        return options.authUser?.uid === previousStaff.uid
          ? pendingPreviousProfile
          : Promise.resolve(permanentStaffResponse(nextStaff));
      },
    );

    renderProvider();
    await waitFor(() => expect(mocks.requestApi).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ authUser: previousStaff }),
    ));

    await act(async () => {
      mocks.auth.currentUser = nextStaff;
      mocks.observer?.(nextStaff);
    });
    await waitFor(() => expect(screen.getByTestId("staff-uid")).toHaveTextContent(nextStaff.uid));

    await act(async () => {
      rejectPreviousProfile(new ApiError(
        "organization bootstrap required",
        409,
        { code: "ORGANIZATION_BOOTSTRAP_REQUIRED" },
      ));
      await Promise.resolve();
    });

    expect(screen.getByTestId("staff-uid")).toHaveTextContent(nextStaff.uid);
    expect(mocks.requestApi).not.toHaveBeenCalledWith(
      "/api/auth/bootstrap-organization",
      expect.anything(),
    );
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.auth.currentUser).toBe(nextStaff);
  });

  it("늦은 학생 응답이 새 Google 세션을 되살리거나 로그아웃하지 않는다", async () => {
    let resolveStudent!: (value: unknown) => void;
    const pendingStudent = new Promise((resolve) => { resolveStudent = resolve; });
    const staff = googleUser();
    mocks.requestApi.mockImplementation((path: string) => {
      if (path === "/api/auth/student-session") return pendingStudent;
      return Promise.resolve(permanentStaffResponse(staff));
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));
    fireEvent.click(screen.getByRole("button", { name: "학생 시작" }));
    await waitFor(() => expect(mocks.signInAnonymously).toHaveBeenCalledTimes(1));

    await act(async () => {
      mocks.auth.currentUser = staff;
      mocks.observer?.(staff);
    });
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    await act(async () => { resolveStudent(studentResponse); await pendingStudent; });

    await waitFor(() => expect(screen.getByTestId("student")).toHaveTextContent("none"));
    expect(screen.getByTestId("identity")).toHaveTextContent("staff");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.auth.currentUser).toBe(staff);
    expect(sessionStorage.getItem("nodo.student.nickname")).toBeNull();
  });

  it("Google 사용자가 있으면 persistence와 학생 로그인을 모두 바꾸지 않는다", async () => {
    const staff = googleUser();
    mocks.auth.currentUser = staff;
    mocks.requestApi.mockResolvedValue(permanentStaffResponse(staff));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    mocks.setPersistence.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "학생 시작" }));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent(
      "현재 강사 계정으로 로그인되어 있습니다",
    ));
    expect(mocks.setPersistence).not.toHaveBeenCalled();
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
    expect(mocks.requestApi).not.toHaveBeenCalledWith(
      "/api/auth/bootstrap-organization",
      expect.anything(),
    );
  });

  it("학생 사용자가 있으면 Google 로그인과 local persistence를 시작하지 않는다", async () => {
    const student = anonymousUser();
    mocks.auth.currentUser = student;
    sessionStorage.setItem("nodo.student.nickname", "차분한 별빛");
    sessionStorage.setItem("nodo.student.room-code", "TEST123");
    mocks.requestApi.mockResolvedValue(studentResponse);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("student"));
    mocks.setPersistence.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent(
      "현재 학생으로 참여 중입니다",
    ));
    expect(mocks.setPersistence).not.toHaveBeenCalled();
    expect(mocks.signInWithPopup).not.toHaveBeenCalled();
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();
  });

  it("Google 팝업이 취소되어도 signed-out 상태로 돌아와 학생 화면을 막지 않는다", async () => {
    mocks.signInWithPopup.mockRejectedValue({ code: "auth/popup-closed-by-user" });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("취소되었습니다"));
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("auth/popup-closed-by-user");
    expect(screen.getByTestId("identity")).toHaveTextContent("signed-out");
    expect(mocks.setPersistence).not.toHaveBeenCalled();
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });

  it("local persistence 완료를 기다리지 않고 클릭 직후 Google 팝업을 연다", async () => {
    const staff = googleUser();
    const callOrder: string[] = [];
    let resolvePopup!: (value: { user: typeof staff }) => void;
    mocks.signInWithPopup.mockImplementation(
      () =>
        new Promise<{ user: typeof staff }>((resolve) => {
          callOrder.push("popup");
          resolvePopup = resolve;
        }),
    );
    mocks.requestApi.mockResolvedValue(permanentStaffResponse(staff));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await waitFor(() => expect(mocks.signInWithPopup).toHaveBeenCalledTimes(1));
    expect(callOrder[0]).toBe("popup");
    expect(mocks.setPersistence).not.toHaveBeenCalled();

    await act(async () => {
      mocks.auth.currentUser = staff;
      resolvePopup({ user: staff });
    });
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    expect(mocks.setPersistence).not.toHaveBeenCalled();
  });

  it("Google 팝업 네트워크 오류는 안전한 안내로 끝내고 재시도 상태를 남긴다", async () => {
    mocks.signInWithPopup.mockRejectedValue({ code: "auth/network-request-failed" });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("네트워크 연결"));
    expect(screen.getByTestId("google-recovery")).toHaveTextContent("true");
    expect(screen.getByTestId("action-error")).not.toHaveTextContent("token");
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("auth/network-request-failed");
  });

  it("팝업 차단 오류는 리디렉션으로 전환하지 않고 재시도 상태를 남긴다", async () => {
    mocks.signInWithPopup.mockRejectedValue({ code: "auth/popup-blocked" });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("팝업이 차단"));
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("google-redirecting")).toHaveTextContent("false");
    expect(screen.getByTestId("google-recovery")).toHaveTextContent("true");
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("auth/popup-blocked");
  });

  it("팝업 로그인 성공 뒤에만 /api/auth/me으로 ADMIN 프로필을 확인한다", async () => {
    const staff = googleUser();
    mocks.signInWithPopup.mockImplementation(async () => {
      mocks.auth.currentUser = staff;
      mocks.observer?.(staff);
      return { user: staff };
    });
    mocks.requestApi.mockResolvedValue(permanentStaffResponse(staff));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    expect(mocks.requestApi).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ authUser: staff }),
    );
    expect(screen.getByTestId("staff-org")).toHaveTextContent("demo");
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("로그인 버튼 클릭");
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("Firebase 인증 상태 알림");
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("HTTP 200");
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("관리자");
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("로그인 성공");
  });

  it("popup 결과 Promise가 멈춰도 같은 시도의 Firebase STAFF 상태로 권한을 확인한다", async () => {
    const staff = googleUser();
    mocks.signInWithPopup.mockReturnValue(new Promise(() => undefined));
    mocks.requestApi.mockResolvedValue(permanentStaffResponse(staff));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await act(async () => {
      mocks.auth.currentUser = staff;
      mocks.observer?.(staff);
    });

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    expect(mocks.requestApi).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ authUser: staff }),
    );
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent(
      "Firebase 세션 반환으로 복구됨",
    );
  });

  it("45초 팝업 시간 초과 뒤에는 무한 대기를 끝내고 재시도할 수 있다", async () => {
    vi.useFakeTimers();
    let resolvePopup!: (value: { user: ReturnType<typeof googleUser> }) => void;
    const pendingPopup = new Promise<{ user: ReturnType<typeof googleUser> }>((resolve) => {
      resolvePopup = resolve;
    });
    mocks.signInWithPopup
      .mockImplementationOnce(() => pendingPopup)
      .mockImplementationOnce(async () => {
        const staff = googleUser();
        mocks.auth.currentUser = staff;
        return { user: staff };
      });
    mocks.requestApi.mockResolvedValue(permanentStaffResponse());
    renderProvider();
    await act(async () => { await vi.runAllTicks(); });

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(screen.getByTestId("google-recovery")).toHaveTextContent("true");
    expect(screen.getByTestId("action-error")).toHaveTextContent("인증 창이 완료되지 않았습니다");
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("45초 시간 초과");

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await act(async () => {});
    expect(mocks.signInWithPopup).toHaveBeenCalledTimes(2);
    resolvePopup({ user: googleUser() });
    vi.useRealTimers();
  });

  it("시간 초과된 이전 팝업의 늦은 성공은 새 로그인 결과를 덮어쓰지 않는다", async () => {
    vi.useFakeTimers();
    const oldStaff = { ...googleUser(), uid: "old-staff" };
    const newStaff = { ...googleUser(), uid: "new-staff" };
    let resolveOldPopup!: (value: { user: typeof oldStaff }) => void;
    const oldPopup = new Promise<{ user: typeof oldStaff }>((resolve) => {
      resolveOldPopup = resolve;
    });
    mocks.signInWithPopup
      .mockImplementationOnce(() => oldPopup)
      .mockImplementationOnce(async () => {
        mocks.auth.currentUser = newStaff;
        return { user: newStaff };
      });
    mocks.requestApi.mockImplementation((path: string, options: { authUser?: { uid?: string } }) => {
      if (path !== "/api/auth/me") return Promise.reject(new Error("unexpected path"));
      return Promise.resolve({
        ...permanentStaffResponse(newStaff),
        uid: options.authUser?.uid,
      });
    });
    renderProvider();
    await act(async () => { await vi.runAllTicks(); });

    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    fireEvent.click(screen.getByRole("button", { name: "강사 로그인" }));
    await act(async () => {});
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByTestId("staff-uid")).toHaveTextContent("new-staff"));

    resolveOldPopup({ user: oldStaff });
    await act(async () => {});
    expect(screen.getByTestId("staff-uid")).toHaveTextContent("new-staff");
  });

  it("명시적 리디렉션 로그인은 local persistence 다음에만 시작한다", async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));

    fireEvent.click(screen.getByRole("button", { name: "강사 리디렉션 로그인" }));
    await waitFor(() => expect(mocks.signInWithRedirect).toHaveBeenCalledTimes(1));
    expect(mocks.setPersistence).toHaveBeenCalledWith(mocks.auth, mocks.localPersistence);
    expect(screen.getByTestId("google-redirecting")).toHaveTextContent("true");
  });

  it("리디렉션 복귀 credential은 기존 INSTRUCTOR 권한 검증 흐름으로 연결한다", async () => {
    const staff = googleUser();
    mocks.auth.currentUser = staff;
    mocks.getRedirectResult.mockResolvedValue({ user: staff });
    mocks.requestApi.mockResolvedValue({
      ...permanentStaffResponse(staff),
      organizationRole: "INSTRUCTOR",
      isAdmin: false,
    });
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    expect(mocks.requestApi).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ authUser: staff }),
    );
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("일반 강사");
  });

  it("초기 null observer 뒤에도 리디렉션 credential로 Google 세션을 검증한다", async () => {
    const staff = googleUser();
    let resolveRedirect!: (value: { user: typeof staff }) => void;
    mocks.getRedirectResult.mockReturnValue(new Promise((resolve) => {
      resolveRedirect = resolve;
    }));
    mocks.requestApi.mockResolvedValue(permanentStaffResponse(staff));

    renderProvider();
    await waitFor(() => expect(mocks.onAuthStateChanged).toHaveBeenCalledTimes(1));
    expect(mocks.observer).not.toBeNull();

    await act(async () => {
      mocks.auth.currentUser = staff;
      resolveRedirect({ user: staff });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("staff"));
    expect(mocks.requestApi).toHaveBeenCalledTimes(1);
  });

  it("리디렉션 결과가 null이면 오류 없이 signed-out 상태를 유지한다", async () => {
    mocks.getRedirectResult.mockResolvedValue(null);
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));
    expect(screen.getByTestId("auth-error")).toHaveTextContent("none");
    expect(screen.getByTestId("auth-diagnostics")).toHaveTextContent("결과 없음(정상)");
  });

  it("리디렉션 결과가 멈춰도 observer가 로그인 화면을 복구한다", async () => {
    mocks.getRedirectResult.mockReturnValue(new Promise(() => undefined));
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("signed-out"));
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("Firebase 로그인 상태 알림이 멈춰도 제한 시간 뒤 로그인 버튼을 다시 사용할 수 있게 한다", async () => {
    vi.useFakeTimers();
    mocks.onAuthStateChanged.mockImplementation(
      (_auth, next: (user: Record<string, unknown> | null) => void) => {
        mocks.observer = next;
        return () => undefined;
      },
    );
    renderProvider();

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(GOOGLE_AUTH_BOOTSTRAP_TIMEOUT_MS);
    });

    expect(screen.getByTestId("identity")).toHaveTextContent("signed-out");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("리디렉션 결과 오류는 민감정보 없이 안내하고 로그인 상태를 복구한다", async () => {
    mocks.getRedirectResult.mockRejectedValue({ code: "auth/network-request-failed" });
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("auth-error")).toHaveTextContent("네트워크 연결"));
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(screen.getByTestId("google-recovery")).toHaveTextContent("true");
    expect(screen.getByTestId("auth-error")).not.toHaveTextContent("token");
  });

  it("초기 fetch 오류는 원문을 노출하지 않고 재시도 상태로 바꾼다", async () => {
    mocks.getRedirectResult.mockRejectedValue(new TypeError("Failed to fetch"));
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("auth-error")).toHaveTextContent("인증 서비스에 연결"));
    expect(screen.getByTestId("auth-error")).not.toHaveTextContent("Failed to fetch");
    expect(screen.getByTestId("google-recovery")).toHaveTextContent("true");
    expect(mocks.requestApi).not.toHaveBeenCalled();
  });

  it("미지원 provider는 어느 서버 권한 API에도 보내지 않는다", async () => {
    mocks.auth.currentUser = {
      uid: "masked-other",
      isAnonymous: false,
      providerData: [{ providerId: "password" }],
    };
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("identity")).toHaveTextContent("unsupported"));
    expect(mocks.requestApi).not.toHaveBeenCalled();
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });
});
