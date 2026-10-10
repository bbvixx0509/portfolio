import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { NotFoundPage } from "./NotFoundPage";

function renderPage() {
  render(
    <MemoryRouter>
      <NotFoundPage />
    </MemoryRouter>,
  );
}

describe("NotFoundPage", () => {
  it('"404"를 표시한다', () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "404" })).toBeInTheDocument();
  });

  it('"페이지를 찾을 수 없습니다."를 표시한다', () => {
    renderPage();

    expect(screen.getByText("페이지를 찾을 수 없습니다.")).toBeInTheDocument();
  });

  it("홈으로 돌아가는 링크를 제공한다", () => {
    renderPage();

    expect(
      screen.getByRole("link", { name: "NoDo 홈으로 돌아가기" }),
    ).toHaveAttribute("href", "/");
  });
});
