import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loginMock } = vi.hoisted(() => ({ loginMock: vi.fn() }));

vi.mock("../features/auth/AuthContext", () => ({
  useAuth: () => ({ login: loginMock, isLoading: false }),
}));

import { LoginPage } from "./LoginPage";

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/courses/import" element={<h1>강의 목록</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => loginMock.mockReset());

  it("역할·테스트 계정 선택 없이 직원 인증 필드와 참여 링크만 표시한다", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "직원 로그인" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "이메일" })).toHaveValue("");
    expect(screen.getByLabelText("비밀번호")).toHaveValue("");
    expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "참여 코드로 입장" })).toBeInTheDocument();
    expect(screen.queryByLabelText("로컬 테스트 계정")).not.toBeInTheDocument();
    for (const removedLabel of [
      "관리자",
      "주 강사",
      "권한 없는 보조 강사",
      "일부 권한 보조 강사",
      "다른 조직 강사",
      "lead@nodo.test",
      "NoDo01!LocalOnly",
    ]) {
      expect(screen.queryByText(removedLabel)).not.toBeInTheDocument();
    }
  });

  it("계정 유형을 고르지 않고 입력한 인증 정보로 직원 로그인한다", async () => {
    loginMock.mockResolvedValue({
      uid: "staff-one",
      orgId: "org-nodo",
      accountType: "STAFF",
      organizationRole: "INSTRUCTOR",
      displayName: "김직원",
    });
    renderPage();
    fireEvent.change(screen.getByRole("textbox", { name: "이메일" }), {
      target: { value: "staff@nodo.test" },
    });
    fireEvent.change(screen.getByLabelText("비밀번호"), {
      target: { value: "local-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith(
      "staff@nodo.test",
      "local-password",
    ));
    expect(await screen.findByRole("heading", { name: "강의 목록" })).toBeInTheDocument();
  });
});
