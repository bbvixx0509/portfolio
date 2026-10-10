import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authState,
  onAuthStateChangedMock,
  requestApiMock,
  signInAnonymouslyMock,
} = vi.hoisted(() => ({
  authState: { currentUser: null as unknown },
  onAuthStateChangedMock: vi.fn(),
  requestApiMock: vi.fn(),
  signInAnonymouslyMock: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  browserSessionPersistence: {},
  setPersistence: vi.fn().mockResolvedValue(undefined),
  onAuthStateChanged: onAuthStateChangedMock,
  signInAnonymously: signInAnonymouslyMock,
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("../../lib/firebase/firebaseAuth", () => ({
  getLocalFirebaseAuth: () => authState,
}));
vi.mock("../../lib/api/apiClient", () => ({ requestApi: requestApiMock }));

import { AuthProvider, useAuth } from "./AuthContext";

function Probe() {
  const { isLoading, joinRoom, profile } = useAuth();
  return (
    <>
      <output data-testid="loading">{String(isLoading)}</output>
      <output data-testid="profile">{profile?.displayName ?? "none"}</output>
      <button type="button" onClick={() => void joinRoom("NODO01", "용감한 수달")}>입장</button>
    </>
  );
}

describe("AuthProvider anonymous join lifecycle", () => {
  beforeEach(() => {
    sessionStorage.clear();
    authState.currentUser = null;
    let observer: ((user: unknown) => void) | null = null;
    onAuthStateChangedMock.mockReset().mockImplementation(
      (_auth, next: (user: unknown) => void) => {
        observer = next;
        next(null);
        return () => undefined;
      },
    );
    signInAnonymouslyMock.mockReset().mockImplementation(async () => {
      const user = {
        uid: "student-anonymous",
        isAnonymous: true,
        email: null,
        getIdToken: vi.fn().mockResolvedValue("student-token"),
      };
      authState.currentUser = user;
      observer?.(user);
      return { user };
    });
  });

  it("Auth observer가 먼저 와도 join API 완료 전 loading을 해제하지 않는다", async () => {
    let resolveJoin!: (value: unknown) => void;
    const joinResponse = new Promise((resolve) => {
      resolveJoin = resolve;
    });
    requestApiMock.mockReset().mockImplementation((path: string) => {
      if (path === "/api/rooms/join") return joinResponse;
      return Promise.resolve({
        uid: "student-anonymous",
        orgId: "org-nodo",
        accountType: "STUDENT",
        displayName: "용감한 수달",
      });
    });

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    fireEvent.click(screen.getByRole("button", { name: "입장" }));
    await waitFor(() => expect(signInAnonymouslyMock).toHaveBeenCalled());
    expect(screen.getByTestId("loading")).toHaveTextContent("true");

    await act(async () => {
      resolveJoin({ room: { id: "demo-room" } });
      await joinResponse;
    });
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
  });

  it("새로고침으로 복원된 익명 세션의 프로필을 다시 조회한다", async () => {
    sessionStorage.setItem("nodo.firebase-session", "1");
    const restoredUser = {
      uid: "student-restored",
      isAnonymous: true,
      email: null,
      getIdToken: vi.fn().mockResolvedValue("restored-token"),
    };
    authState.currentUser = restoredUser;
    onAuthStateChangedMock.mockReset().mockImplementation(
      (_auth, next: (user: unknown) => void) => {
        next(restoredUser);
        return () => undefined;
      },
    );
    requestApiMock.mockReset().mockResolvedValue({
      uid: "student-restored",
      orgId: "org-nodo",
      accountType: "STUDENT",
      displayName: "복원된 수달",
      nickname: "복원된 수달",
    });

    render(<AuthProvider><Probe /></AuthProvider>);

    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("복원된 수달"));
    expect(requestApiMock).toHaveBeenCalledWith("/api/me", {
      authUser: restoredUser,
    });
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });
});
