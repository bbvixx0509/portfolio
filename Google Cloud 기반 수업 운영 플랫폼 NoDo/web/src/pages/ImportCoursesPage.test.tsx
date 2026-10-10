import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  getImportCourseCounts,
  importCourseMocks,
} from "../data/importPageMocks";
import { ImportCoursesPage } from "./ImportCoursesPage";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/courses/import"]}>
      <ImportCoursesPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function getVisibleCourseIds() {
  return within(
    screen.getByRole("radiogroup", { name: "기존 목록 선택" }),
  )
    .getAllByRole<HTMLInputElement>("radio")
    .map((radio) => radio.value);
}

describe("ImportCoursesPage", () => {
  it("화면 제목과 mock 강의 5개를 표시한다", () => {
    renderPage();

    expect(
      screen.getByRole("heading", {
        name: "만들었던 로드맵을 다시 불러와요",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(5);

    for (const course of importCourseMocks) {
      expect(screen.getByText(course.title)).toBeInTheDocument();
    }
  });

  it("생성 방식, 완료 상태와 강의 상세 정보를 표시한다", () => {
    renderPage();

    expect(screen.getAllByText("AI 생성")).toHaveLength(3);
    expect(screen.getAllByText("직접 입력")).toHaveLength(2);
    expect(screen.getAllByText("완료")).toHaveLength(2);
    expect(screen.getByText("12개 항목")).toBeInTheDocument();
    expect(screen.getByText("어제 사용")).toBeInTheDocument();
  });

  it("검색어 앞뒤 공백과 대소문자를 무시한다", () => {
    renderPage();

    fireEvent.change(screen.getByRole("searchbox", { name: "강의명으로 검색" }), {
      target: { value: "  api  " },
    });

    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByText("백엔드 API 설계 기초")).toBeInTheDocument();
    expect(screen.queryByText("프론트엔드 입문반")).not.toBeInTheDocument();
  });

  it("검색 결과가 없으면 빈 상태를 표시한다", () => {
    renderPage();

    fireEvent.change(screen.getByRole("searchbox", { name: "강의명으로 검색" }), {
      target: { value: "존재하지 않는 강의" },
    });

    expect(
      screen.getByRole("status", { name: "검색 결과 없음" }),
    ).toHaveTextContent("검색 조건에 맞는 강의가 없어요");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("필터 숫자를 전체 mock 데이터에서 계산한다", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "전체 5" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "이어서 진행 중 3" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "완료 2" })).toBeInTheDocument();

    expect(getImportCourseCounts(importCourseMocks.slice(0, 2))).toEqual({
      total: 2,
      inProgress: 1,
      completed: 1,
    });
  });

  it("이어서 진행 중 필터에 해당하는 강의 3개만 표시한다", () => {
    renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: "이어서 진행 중 3" }),
    );

    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "이어서 진행 중 3" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("프론트엔드 입문반")).not.toBeInTheDocument();
  });

  it("완료 필터와 전체 필터를 전환한다", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "완료 2" }));
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByText("프론트엔드 입문반")).toBeInTheDocument();
    expect(screen.getByText("UX 리서치 워크숍")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "전체 5" }));
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "전체 5" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("최근 사용순을 기본 정렬로 사용한다", () => {
    renderPage();

    expect(screen.getByRole("combobox", { name: "목록 정렬" })).toHaveValue(
      "RECENT",
    );
    expect(getVisibleCourseIds()).toEqual([
      "vector-rag-practice",
      "frontend-basics",
      "backend-api-basics",
      "python-data-camp",
      "ux-research-workshop",
    ]);
  });

  it("오래된 사용순으로 정렬한다", () => {
    renderPage();

    fireEvent.change(screen.getByRole("combobox", { name: "목록 정렬" }), {
      target: { value: "OLDEST" },
    });

    expect(getVisibleCourseIds()).toEqual([
      "ux-research-workshop",
      "python-data-camp",
      "backend-api-basics",
      "frontend-basics",
      "vector-rag-practice",
    ]);
  });

  it("이름순으로 정렬한다", () => {
    renderPage();

    fireEvent.change(screen.getByRole("combobox", { name: "목록 정렬" }), {
      target: { value: "NAME" },
    });

    const expectedIds = [...importCourseMocks]
      .sort((first, second) => first.title.localeCompare(second.title, "ko-KR"))
      .map((course) => course.id);
    expect(getVisibleCourseIds()).toEqual(expectedIds);
  });

  it("행을 눌러도 하나의 목록만 선택한다", () => {
    renderPage();

    fireEvent.click(screen.getByText("벡터DB & RAG 실무 강의"));
    const firstRadio = screen.getByRole("radio", {
      name: "벡터DB & RAG 실무 강의 선택",
    });
    expect(firstRadio).toBeChecked();

    fireEvent.click(screen.getByText("프론트엔드 입문반"));
    expect(firstRadio).not.toBeChecked();
    expect(
      screen.getByRole("radio", { name: "프론트엔드 입문반 선택" }),
    ).toBeChecked();
    expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
  });

  it("선택 전에는 불러오기 버튼이 비활성화되고 선택 후 활성화된다", () => {
    renderPage();

    const importButton = screen.getByRole("button", {
      name: "이 목록 불러오기",
    });
    expect(importButton).toBeDisabled();

    fireEvent.click(
      screen.getByRole("radio", { name: "백엔드 API 설계 기초 선택" }),
    );

    expect(importButton).toBeEnabled();
    expect(screen.getByText(/선택된 강의/)).toHaveTextContent(
      "백엔드 API 설계 기초",
    );
  });

  it("선택한 목록의 준비 경로로 이동한다", () => {
    renderPage();

    fireEvent.click(
      screen.getByRole("radio", { name: "백엔드 API 설계 기초 선택" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "이 목록 불러오기" }),
    );

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/courses/backend-api-basics/prepare",
    );
  });

  it("시작 화면과 새로 만들기 경로로 이동한다", () => {
    renderPage();

    fireEvent.click(screen.getByRole("link", { name: "시작 화면으로" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/");

    fireEvent.click(screen.getByRole("link", { name: "새로 만들기" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/create/manual");
  });

  it("각 강의의 진행률을 의미 있는 값으로 제공한다", () => {
    renderPage();

    expect(
      screen.getByRole("progressbar", {
        name: "벡터DB & RAG 실무 강의 진행률",
      }),
    ).toHaveAttribute("value", "65");
    expect(screen.getAllByRole("progressbar")).toHaveLength(5);
  });
});
