import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  identityKind: "signed-out" as "loading" | "signed-out" | "staff" | "invited-staff" | "student" | "unsupported",
  studentSession: null as null | Record<string, unknown>,
  isLoading: false,
  startStudentSession: vi.fn(),
  endStudentSession: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../features/auth/AuthContext", () => ({
  useAuth: () => authMocks,
}));

import { StudentEntryPage } from "./StudentEntryPage";

function renderPage(path = "/join/TEST123") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/join/:roomCode" element={<StudentEntryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("02-7 학생 참여 화면", () => {
  beforeEach(() => {
    authMocks.identityKind = "signed-out";
    authMocks.studentSession = null;
    authMocks.isLoading = false;
    authMocks.startStudentSession.mockReset().mockResolvedValue({});
    authMocks.endStudentSession.mockReset().mockResolvedValue(undefined);
    authMocks.logout.mockReset().mockResolvedValue(undefined);
  });

  it("랜덤 별명을 미리 표시하고 주요 참여 버튼 하나만 제공한다", () => {
    renderPage();

    const input = screen.getByRole("textbox", { name: "참여 이름" });
    expect((input as HTMLInputElement).value).toMatch(/^\S+(?: \S+)+$/);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "참여하기" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /추천|다른 별명|다시/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Firebase|Anonymous|익명 인증|회원가입|계정 생성|ID Token|UID/);
  });

  it("별명을 수정하고 trim된 이름과 정규화된 코드만 전달한다", async () => {
    renderPage("/join/test123");
    const input = screen.getByRole("textbox", { name: "참여 이름" });
    fireEvent.change(input, { target: { value: "  맑은 구름  " } });
    expect(screen.getByText("5/16")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "참여하기" }));
    await waitFor(() => expect(authMocks.startStudentSession).toHaveBeenCalledWith(
      "TEST123",
      "맑은 구름",
    ));
  });

  it("빈 값·짧거나 긴 값·금칙어를 참여 전에 차단한다", () => {
    renderPage();
    const input = screen.getByRole("textbox", { name: "참여 이름" });
    const button = screen.getByRole("button", { name: "참여하기" });

    for (const value of [" ", "한", "가".repeat(17), "관리자", "별빛욕설노트", "푸른\u200b연필"]) {
      fireEvent.change(input, { target: { value } });
      expect(button).toBeDisabled();
      expect(input).toHaveAttribute("aria-invalid", "true");
    }
  });

  it("일반 Enter는 제출하고 한글 조합·IME 229 Enter와 처리 중 중복 요청은 막는다", async () => {
    let resolveRequest!: () => void;
    authMocks.startStudentSession.mockImplementation(
      () => new Promise<void>((resolve) => { resolveRequest = resolve; }),
    );
    renderPage();
    const input = screen.getByRole("textbox", { name: "참여 이름" });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
    expect(authMocks.startStudentSession).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);

    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
    await waitFor(() => expect(screen.getByRole("button", { name: "참여 중..." })).toBeDisabled());
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(authMocks.startStudentSession).toHaveBeenCalledTimes(1);
    resolveRequest();
    await waitFor(() => expect(screen.getByRole("button", { name: "참여하기" })).toBeEnabled());
  });

  it("서버 확인 뒤 준비 완료 정보와 종료 동작만 표시한다", async () => {
    authMocks.identityKind = "student";
    authMocks.studentSession = {
      accountType: "STUDENT",
      isAnonymous: true,
      identityVerified: true,
      provider: "anonymous",
      scope: "AUTH_ONLY",
      roomAuthorized: false,
      nickname: "차분한 별빛",
      roomCode: "TEST123",
    };
    renderPage();

    expect(screen.getByRole("heading", { name: "참여 준비가 완료되었습니다." })).toBeInTheDocument();
    expect(screen.getByText("차분한 별빛")).toBeInTheDocument();
    expect(screen.getByText("실제 강의방 데이터 연결은 이후 단계에서 제공됩니다.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/입장 완료|출석 완료|질문 전송 가능|동기화 완료/);

    fireEvent.click(screen.getByRole("button", { name: "학생 참여 종료" }));
    await waitFor(() => expect(authMocks.endStudentSession).toHaveBeenCalledTimes(1));
  });

  it("학생 세션이 생기면 제출 Promise가 끝나기 전에도 입력 폼을 함께 표시하지 않는다", async () => {
    let resolveRequest!: () => void;
    authMocks.startStudentSession.mockImplementation(() => {
      authMocks.identityKind = "student";
      authMocks.studentSession = {
        accountType: "STUDENT",
        isAnonymous: true,
        identityVerified: true,
        provider: "anonymous",
        scope: "AUTH_ONLY",
        roomAuthorized: false,
        nickname: "차분한 별빛",
        roomCode: "TEST123",
      };
      return new Promise<void>((resolve) => { resolveRequest = resolve; });
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "참여하기" }));

    await waitFor(() => expect(
      screen.getByRole("heading", { name: "참여 준비가 완료되었습니다." }),
    ).toBeInTheDocument());
    expect(screen.queryByRole("textbox", { name: "참여 이름" })).not.toBeInTheDocument();
    await act(async () => { resolveRequest(); });
  });

  it("태그 모양 별명도 HTML로 실행하지 않고 일반 문자열로 표시한다", () => {
    authMocks.identityKind = "student";
    authMocks.studentSession = {
      accountType: "STUDENT",
      isAnonymous: true,
      identityVerified: true,
      provider: "anonymous",
      scope: "AUTH_ONLY",
      roomAuthorized: false,
      nickname: "<b>별빛</b>",
      roomCode: "TEST123",
    };
    renderPage();
    expect(screen.getByText("<b>별빛</b>")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("현재 경로와 복원된 참여 코드가 다르면 성공으로 표시하지 않고 종료를 안내한다", () => {
    authMocks.identityKind = "student";
    authMocks.studentSession = {
      accountType: "STUDENT",
      isAnonymous: true,
      identityVerified: true,
      provider: "anonymous",
      scope: "AUTH_ONLY",
      roomAuthorized: false,
      nickname: "차분한 별빛",
      roomCode: "OLD123",
    };
    renderPage("/join/NEW123");

    expect(screen.getByRole("heading", { name: "현재 다른 참여를 준비하고 있습니다." })).toBeInTheDocument();
    expect(screen.queryByText("참여 준비가 완료되었습니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "학생 참여 종료" })).toBeInTheDocument();
  });

  it("강사 로그인 상태에서는 교체하지 않고 명시적 로그아웃을 안내한다", async () => {
    authMocks.identityKind = "staff";
    renderPage();

    expect(screen.getByText(/현재 강사 계정으로 로그인되어 있습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "참여하기" })).not.toBeInTheDocument();
    expect(authMocks.startStudentSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "강사 계정에서 로그아웃" }));
    await waitFor(() => expect(authMocks.logout).toHaveBeenCalledTimes(1));
  });

  it("조직 초대 수락 대기 Google 세션도 학생 계정으로 교체하지 않는다", () => {
    authMocks.identityKind = "invited-staff";
    renderPage();

    expect(screen.getByText(/현재 강사 계정으로 로그인되어 있습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "참여하기" })).not.toBeInTheDocument();
    expect(authMocks.startStudentSession).not.toHaveBeenCalled();
  });

  it("잘못된 참여 코드에서는 요청을 시작하지 않는다", () => {
    const invalidCode = "THIS-IS-A-VERY-LONG-INVALID-CODE";
    renderPage(`/join/${invalidCode}`);
    expect(screen.getByRole("button", { name: "참여하기" })).toBeDisabled();
    expect(screen.getByText("참여 코드 확인 필요")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(invalidCode);
    expect(screen.getByRole("alert")).toHaveTextContent(/영문과 숫자 4~12자/);
  });
});
