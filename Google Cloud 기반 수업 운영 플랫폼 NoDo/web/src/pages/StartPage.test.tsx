import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { StartPage } from "./StartPage";

function renderPage() {
  render(
    <MemoryRouter>
      <StartPage />
    </MemoryRouter>,
  );
}

describe("StartPage", () => {
  it("NoDo 서비스명을 표시한다", () => {
    renderPage();

    expect(screen.getByRole("link", { name: "NoDo" })).toBeInTheDocument();
  });

  it("시작 화면 제목을 표시한다", () => {
    renderPage();

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /오늘 강의할 로드맵,\s*어떻게 만들어볼까요\?/,
      }),
    ).toBeInTheDocument();
  });

  it("세 가지 시작 방식을 모두 표시한다", () => {
    renderPage();

    for (const name of [
      "자료로 만들기",
      "직접 만들기",
      "기존 목록 불러오기",
    ]) {
      expect(
        screen.getByRole("heading", { level: 2, name }),
      ).toBeInTheDocument();
    }
  });

  it("추천 표시를 제공한다", () => {
    renderPage();

    expect(screen.getByText("추천")).toBeInTheDocument();
  });

  it("mock 사용자 정보를 표시한다", () => {
    renderPage();

    expect(
      screen.getByRole("group", {
        name: "mock 사용자 정보: 노두 강사님, 안녕하세요",
      }),
    ).toHaveTextContent("노두 강사님, 안녕하세요");
  });

  it("mock 최근 목록을 표시한다", () => {
    renderPage();

    const recentList = screen.getByRole("list", { name: "최근 사용 목록" });
    expect(recentList).toHaveTextContent("벡터DB & RAG 실무 강의");
    expect(recentList).toHaveTextContent("프론트엔드 입문반");
  });
});
