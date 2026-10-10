import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppRoutes } from "./AppRoutes";

vi.mock("../lib/firebase/emulatorDiagnostic", () => ({
  runEmulatorDiagnostic: vi.fn().mockResolvedValue({
    projectId: "demo-nodo",
    uid: "route-test-uid",
    cloudConnectionBlocked: true,
    completedAt: "2026-07-15T00:00:00.000Z",
  }),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderRoutes(initialPath = "/") {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("AppRoutes", () => {
  it('"/"에서 StartPage를 표시한다', () => {
    renderRoutes();

    expect(
      screen.getByRole("heading", { name: /어떻게 만들어볼까요\?/ }),
    ).toBeInTheDocument();
  });

  it.each([
    ["자료 올리기", "/create/material", "자료로 만들기"],
    ["항목 입력하기", "/create/manual", "직접 만들기"],
  ])("%s 링크가 %s 제작 화면으로 이동한다", (linkName, path, sourceLabel) => {
    renderRoutes();

    fireEvent.click(screen.getByRole("link", { name: linkName }));

    expect(screen.getByTestId("location")).toHaveTextContent(path);
    expect(
      screen.getByRole("heading", { name: "Make RoadMap" }),
    ).toBeInTheDocument();
    expect(screen.getByText(sourceLabel)).toBeInTheDocument();
  });

  it("전체 목록 보기 링크가 실제 import 화면으로 이동한다", () => {
    renderRoutes();

    fireEvent.click(screen.getByRole("link", { name: "전체 목록 보기" }));

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/courses/import",
    );
    expect(
      screen.getByRole("heading", {
        name: "만들었던 로드맵을 다시 불러와요",
      }),
    ).toBeInTheDocument();
  });

  it("직접 만들기 화면에서 시작 화면으로 돌아간다", () => {
    renderRoutes("/create/manual");

    fireEvent.click(
      screen.getByRole("link", { name: "시작 화면으로 돌아가기" }),
    );

    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(
      screen.getByRole("heading", { name: /어떻게 만들어볼까요\?/ }),
    ).toBeInTheDocument();
  });

  it("선택한 강의를 실제 수업 흐름 제작 화면에 표시한다", () => {
    renderRoutes("/courses/vector-rag-practice/prepare");

    expect(
      screen.getByRole("heading", { name: "Make RoadMap" }),
    ).toBeInTheDocument();
    expect(screen.getByText("vector-rag-practice")).toBeInTheDocument();
    expect(screen.getAllByText("벡터DB & RAG 실무 강의").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("실습 코드: prompt_lab.py")).toBeInTheDocument();
  });

  it("준비 화면에서 목록 화면으로 돌아간다", () => {
    renderRoutes("/courses/frontend-basics/prepare");

    fireEvent.click(
      screen.getByRole("link", { name: "목록 화면으로 돌아가기" }),
    );

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/courses/import",
    );
    expect(
      screen.getByRole("heading", {
        name: "만들었던 로드맵을 다시 불러와요",
      }),
    ).toBeInTheDocument();
  });

  it("준비 화면에서 시작 화면으로 돌아간다", () => {
    renderRoutes("/courses/frontend-basics/prepare");

    fireEvent.click(
      screen.getByRole("link", { name: "시작 화면으로 돌아가기" }),
    );

    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(
      screen.getByRole("heading", { name: /어떻게 만들어볼까요\?/ }),
    ).toBeInTheDocument();
  });

  it("존재하지 않는 강의 준비 경로에서 404를 표시한다", () => {
    renderRoutes("/courses/unknown-course/prepare");

    expect(screen.getByRole("heading", { name: "404" })).toBeInTheDocument();
  });

  it("존재하지 않는 경로에서 NotFoundPage를 표시한다", () => {
    renderRoutes("/not-found");

    expect(screen.getByRole("heading", { name: "404" })).toBeInTheDocument();
  });

  it("역할 선택이 없는 로컬 직원 로그인 경로를 표시한다", () => {
    renderRoutes("/login");

    expect(screen.getByRole("heading", { name: "직원 로그인" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "이메일" })).toHaveValue("");
    expect(screen.queryByText("lead@nodo.test")).not.toBeInTheDocument();
  });

  it("참여 코드가 포함된 익명 수강생 입장 경로를 표시한다", () => {
    renderRoutes("/join/NODO01");

    expect(screen.getByRole("heading", { name: "강의방 입장" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("NODO01")).toBeInTheDocument();
  });

  it("개발 환경에서 사용자 메뉴와 분리된 Emulator 진단 경로를 표시한다", async () => {
    renderRoutes("/dev/emulator");

    expect(screen.getByTestId("location")).toHaveTextContent("/dev/emulator");
    expect(
      await screen.findByRole("heading", {
        name: "Firebase Emulator 연결 진단",
      }),
    ).toBeInTheDocument();
  });
});
