import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  identityKind: "signed-out" as "signed-out" | "staff" | "student",
  user: null as null | { isAnonymous: boolean },
  loadPublicRoom: vi.fn(),
  loadStudentParticipantSession: vi.fn(),
  joinPublicRoom: vi.fn(),
  auth: { currentUser: null as null | { isAnonymous: boolean } },
  setPersistence: vi.fn(),
  signInAnonymously: vi.fn(),
}));

vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ identityKind: mocks.identityKind, user: mocks.user }) }));
vi.mock("./cloudStudentApi", () => ({
  loadPublicRoom: mocks.loadPublicRoom,
  loadStudentParticipantSession: mocks.loadStudentParticipantSession,
  joinPublicRoom: mocks.joinPublicRoom,
}));
vi.mock("../../lib/firebase/firebaseAuth", () => ({ getFirebaseAuth: () => mocks.auth }));
vi.mock("firebase/auth", () => ({
  browserSessionPersistence: "session",
  setPersistence: mocks.setPersistence,
  signInAnonymously: mocks.signInAnonymously,
}));

import { CloudStudentEntryPage } from "./CloudStudentEntryPage";

function renderPage() {
  return render(<MemoryRouter initialEntries={["/join/demo/ABCDEFGH"]}><Routes><Route path="/join/:orgId/:roomCode" element={<CloudStudentEntryPage />} /><Route path="/join/:orgId/:roomCode/checklist" element={<h1>학생 로드맵</h1>} /></Routes></MemoryRouter>);
}

describe("02-7A public student entry page", () => {
  beforeEach(() => {
    mocks.identityKind = "signed-out";
    mocks.user = null;
    mocks.auth.currentUser = null;
    mocks.loadPublicRoom.mockReset().mockResolvedValue({ title: "공개 강의방", status: "READY", joinAllowed: true });
    mocks.loadStudentParticipantSession.mockReset().mockRejectedValue(new Error("not joined"));
    mocks.joinPublicRoom.mockReset().mockResolvedValue({ nickname: "맑은 구름", roomTitle: "공개 강의방", roomStatus: "READY", participantStatus: "JOINED" });
    mocks.setPersistence.mockReset().mockResolvedValue(undefined);
    mocks.signInAnonymously.mockReset().mockResolvedValue({ user: { isAnonymous: true } });
  });

  it("shows only the room title and a configurable nickname form", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "공개 강의방" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "참여하기" })).toBeEnabled();
    expect(document.body).not.toHaveTextContent(/roomId|organizationId|UID|ID Token|강사/);
  });

  it("creates anonymous auth then sends the nickname-only join request", async () => {
    renderPage();
    const input = await screen.findByRole("textbox", { name: "별명" });
    fireEvent.change(input, { target: { value: "  맑은 구름  " } });
    fireEvent.click(screen.getByRole("button", { name: "참여하기" }));
    await waitFor(() => expect(mocks.joinPublicRoom).toHaveBeenCalledWith(
      { isAnonymous: true }, "demo", "ABCDEFGH", "맑은 구름",
    ));
    expect(await screen.findByRole("heading", { name: "학생 로드맵" })).toBeInTheDocument();
  });

  it("does not log out or switch a staff browser", async () => {
    mocks.identityKind = "staff";
    renderPage();
    expect(await screen.findByText("학생 참여는 별도의 브라우저 또는 기기에서 진행해 주세요.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /로그아웃/ })).not.toBeInTheDocument();
    expect(mocks.signInAnonymously).not.toHaveBeenCalled();
  });

  it("moves an existing anonymous participant directly to the checklist", async () => {
    mocks.user = { isAnonymous: true };
    mocks.auth.currentUser = mocks.user;
    mocks.identityKind = "student";
    mocks.loadStudentParticipantSession.mockResolvedValue({
      nickname: "이전 별명",
      roomTitle: "공개 강의방",
      roomStatus: "READY",
      participantStatus: "JOINED",
    });
    renderPage();

    expect(await screen.findByRole("heading", { name: "학생 로드맵" })).toBeInTheDocument();
    expect(mocks.joinPublicRoom).not.toHaveBeenCalled();
  });
});
