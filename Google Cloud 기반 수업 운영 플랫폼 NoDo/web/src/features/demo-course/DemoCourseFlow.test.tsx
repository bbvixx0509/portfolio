import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../../app/AppRoutes";
import roomStyles from "./TeachingRoomPage.module.css";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="demo-location">{location.pathname}</output>;
}

function renderRoute(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function addManualItem(title: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "새 항목 이름" }), {
    target: { value: title },
  });
  fireEvent.click(screen.getByRole("button", { name: "항목 추가" }));
}

describe("NoDo 00-7 demo course flow", () => {
  it.each([
    ["/create/material", "자료로 만들기"],
    ["/create/manual", "직접 만들기"],
    ["/courses/vector-rag-practice/prepare", "기존 목록 이어서 만들기"],
  ])("%s 경로에서 실제 제작 화면을 표시한다", (path, sourceLabel) => {
    renderRoute(path);

    expect(
      screen.getByRole("heading", { name: "Make RoadMap" }),
    ).toBeInTheDocument();
    expect(screen.getByText(sourceLabel)).toBeInTheDocument();
  });

  it("불러온 강의의 항목 수와 주제에 맞는 mock 흐름을 표시한다", () => {
    const { container } = renderRoute("/courses/frontend-basics/prepare");

    expect(screen.getByText("HTML 문서 구조")).toBeInTheDocument();
    expect(screen.getByText("미니 화면 프로젝트")).toBeInTheDocument();
    expect(screen.queryByText("RAG 개념과 구조")).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-flow-item-id]")).toHaveLength(8);
  });

  it("선택한 파일의 이름과 형식만 mock 상태에 저장한다", () => {
    renderRoute("/create/material");
    const file = new File(["파일 내용은 읽지 않습니다"], "lecture-plan.pdf", {
      type: "application/pdf",
    });

    fireEvent.change(screen.getByLabelText("자료 파일 선택"), {
      target: { files: [file] },
    });

    expect(screen.getByText("lecture-plan.pdf")).toBeInTheDocument();
    expect(screen.getByText("PDF")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "자동 저장 상태" }),
    ).toHaveTextContent(
      "파일 내용은 읽거나 전송하지 않았습니다",
    );
  });

  it("파일 선택 후 AI 대신 mock 수업 흐름을 생성한다", () => {
    renderRoute("/create/material");
    const file = new File(["mock"], "slides.pptx");
    fireEvent.change(screen.getByLabelText("자료 파일 선택"), {
      target: { files: [file] },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "AI로 mock 수업 흐름 생성" }),
    );

    expect(screen.getByText("벡터DB란 무엇인가")).toBeInTheDocument();
    expect(screen.getByText("실습 코드: prompt_lab.py")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "자동 저장 상태" }),
    ).toHaveTextContent("mock 수업 흐름 6개");
  });

  it("직접 만든 항목을 추가하고 수정하고 삭제한다", () => {
    renderRoute("/create/manual");
    addManualItem("첫 실습 항목");

    fireEvent.click(
      screen.getByRole("button", { name: "첫 실습 항목 수정" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "첫 실습 항목 새 이름" }),
      { target: { value: "수정된 실습 항목" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(screen.getByText("수정된 실습 항목")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "수정된 실습 항목 삭제" }),
    );
    expect(screen.queryByText("수정된 실습 항목")).not.toBeInTheDocument();
  });

  it("챕터 안에서 항목 순서를 위아래로 변경한다", () => {
    const { container } = renderRoute("/create/manual");
    addManualItem("첫 번째 항목");
    addManualItem("두 번째 항목");

    fireEvent.click(
      screen.getByRole("button", { name: "두 번째 항목 위로 이동" }),
    );

    const orderedIds = [...container.querySelectorAll("[data-flow-item-id]")].map(
      (element) => element.getAttribute("data-flow-item-id"),
    );
    expect(orderedIds).toEqual(["flow-custom-101", "flow-custom-100"]);
  });

  it("새 챕터를 추가한다", () => {
    renderRoute("/create/manual");
    fireEvent.change(screen.getByRole("textbox", { name: "새 챕터 이름" }), {
      target: { value: "실전 프로젝트" },
    });
    fireEvent.click(screen.getByRole("button", { name: "챕터 추가" }));

    expect(
      screen.getByRole("heading", { name: "실전 프로젝트" }),
    ).toBeInTheDocument();
  });

  it("항목이 있으면 강의를 시작해 로드맵으로 이동한다", () => {
    renderRoute("/create/manual");
    expect(screen.getByRole("button", { name: "강의 시작" })).toBeDisabled();
    addManualItem("오리엔테이션");

    fireEvent.click(screen.getByRole("button", { name: "강의 시작" }));

    expect(screen.getByTestId("demo-location")).toHaveTextContent(
      "/rooms/demo-room/checklist",
    );
    expect(
      screen.getByRole("heading", { name: "챕터별 전체 로드맵" }),
    ).toBeInTheDocument();
  });

  it("제작 화면과 로드맵에서 항목 상태 드롭다운을 제거한다", () => {
    const { container, unmount } = renderRoute(
      "/courses/vector-rag-practice/prepare",
    );

    expect(
      screen.queryByRole("combobox", { name: /항목.*상태|상태 변경/ }),
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-flow-item-id] select")).toHaveLength(
      0,
    );

    unmount();
    renderRoute("/rooms/demo-room/checklist");
    expect(
      screen.queryByRole("combobox", { name: /항목.*상태|상태 변경/ }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
  });

  it("첫 번째 미완료 항목을 현재 진행으로 표시하고 완료·현재 디자인을 구분한다", () => {
    const { container } = renderRoute("/rooms/demo-room/checklist");
    const completedItem = container.querySelector(
      '[data-checklist-item-id="flow-vector"]',
    );
    const currentItem = container.querySelector(
      '[data-checklist-item-id="flow-code"]',
    );

    expect(completedItem).toHaveAttribute("data-completion-state", "completed");
    expect(completedItem).toHaveClass(roomStyles.completedChecklistItem);
    expect(currentItem).toHaveAttribute("data-completion-state", "current");
    expect(currentItem).toHaveClass(roomStyles.currentChecklistItem);
    expect(
      within(currentItem as HTMLElement).getByText("현재 진행"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "벡터DB란 무엇인가 완료" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "실습 코드: prompt_lab.py 완료",
      }),
    ).not.toBeChecked();
  });

  it("완료 항목을 해제하면 해당 항목 이후를 미완료로 만들고 미래 체크를 막는다", () => {
    const { container } = renderRoute("/rooms/demo-room/checklist");

    fireEvent.click(
      screen.getByRole("checkbox", { name: "RAG 개념과 구조 완료" }),
    );

    expect(
      screen.getByRole("checkbox", { name: "실습: Pinecone 연동 완료" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "RAG 개념과 구조 완료" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "프롬프트 설계 실습 완료" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", {
        name: "실습 코드: prompt_lab.py 완료",
      }),
    ).toBeDisabled();
    expect(
      container.querySelector('[data-checklist-item-id="flow-rag"]'),
    ).toHaveAttribute("data-completion-state", "current");
    expect(
      container.querySelector('[data-checklist-item-id="flow-prompt"]'),
    ).toHaveAttribute("data-completion-state", "future");
  });

  it("현재 항목을 체크하면 다음 미완료 항목과 자료 화면이 자동으로 이동한다", () => {
    const { container } = renderRoute("/rooms/demo-room/checklist");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "RAG 개념과 구조 완료" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "RAG 개념과 구조 완료" }),
    );

    expect(
      container.querySelector('[data-checklist-item-id="flow-rag"]'),
    ).toHaveAttribute("data-completion-state", "completed");
    expect(
      container.querySelector('[data-checklist-item-id="flow-prompt"]'),
    ).toHaveAttribute("data-completion-state", "current");
    expect(
      screen.getByRole("checkbox", { name: "프롬프트 설계 실습 완료" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("checkbox", {
        name: "실습 코드: prompt_lab.py 완료",
      }),
    ).toBeDisabled();

    const material = screen.getByRole("article", { name: "현재 자료" });
    expect(
      within(material).getByRole("heading", { name: "프롬프트 설계 실습" }),
    ).toBeInTheDocument();
    expect(within(material).getByText("현재 진행")).toBeInTheDocument();
  });

  it("챕터별 완료 개수와 전체 진행률을 순차 체크 결과로 계산한다", () => {
    renderRoute("/rooms/demo-room/checklist");

    expect(
      screen.getByRole("progressbar", { name: "벡터 DB 개념 완료 진행률" }),
    ).toHaveAttribute("value", "3");
    expect(
      screen.getByRole("progressbar", { name: "RAG 파이프라인 완료 진행률" }),
    ).toHaveAttribute("value", "2");
    expect(
      screen.getByRole("progressbar", { name: "전체 수업 흐름 완료 진행률" }),
    ).toHaveAttribute("value", "5");
    expect(screen.getByText("83%", { selector: "strong" })).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "RAG 개념과 구조 완료" }),
    );

    expect(
      screen.getByRole("progressbar", { name: "벡터 DB 개념 완료 진행률" }),
    ).toHaveAttribute("value", "3");
    expect(
      screen.getByRole("progressbar", { name: "RAG 파이프라인 완료 진행률" }),
    ).toHaveAttribute("value", "0");
    expect(
      screen.getByRole("progressbar", { name: "전체 수업 흐름 완료 진행률" }),
    ).toHaveAttribute("value", "3");
    expect(screen.getByText("50%", { selector: "strong" })).toBeInTheDocument();
  });

  it("마지막 미완료 항목을 체크하면 현재 항목 없이 강의 완료를 표시한다", () => {
    const { container } = renderRoute("/rooms/demo-room/checklist");

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "실습 코드: prompt_lab.py 완료",
      }),
    );

    expect(
      screen.getByRole("progressbar", { name: "전체 수업 흐름 완료 진행률" }),
    ).toHaveAttribute("value", "6");
    expect(screen.getByText("100%", { selector: "strong" })).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("tabpanel", { name: "로드맵" }),
      ).getByRole("status"),
    ).toHaveTextContent("모든 항목을 완료했어요");
    expect(
      container.querySelector('[data-completion-state="current"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-completion-state="completed"]'),
    ).toHaveLength(6);
  });

  it("항목 선택은 자료만 바꾸고 실제 현재 진행 항목은 유지한다", () => {
    const { container } = renderRoute("/rooms/demo-room/checklist");
    const vectorItem = container.querySelector<HTMLElement>(
      '[data-checklist-item-id="flow-vector"]',
    );
    expect(vectorItem).not.toBeNull();
    fireEvent.click(
      within(vectorItem!).getByRole("button", {
        name: /^1\.1 벡터DB란 무엇인가/,
      }),
    );

    const material = screen.getByRole("article", { name: "현재 자료" });
    expect(
      within(material).getByRole("heading", { name: "벡터DB란 무엇인가" }),
    ).toBeInTheDocument();
    expect(within(material).getByText("선택한 항목 미리보기")).toBeInTheDocument();
    expect(
      container.querySelector('[data-checklist-item-id="flow-code"]'),
    ).toHaveAttribute("data-completion-state", "current");
    expect(
      container.querySelector('[data-checklist-item-id="flow-vector"]'),
    ).toHaveAttribute("data-completion-state", "completed");
  });

  it("채팅 화면에 자동 계산한 현재 진행 항목을 표시한다", () => {
    renderRoute("/rooms/demo-room/chat");

    expect(
      screen.getByText("현재 진행 · 2 실습 코드: prompt_lab.py"),
    ).toBeInTheDocument();
  });

  it("질문 배지를 누르면 선택 항목을 유지해 채팅으로 이동한다", () => {
    renderRoute("/rooms/demo-room/checklist");
    fireEvent.click(
      screen.getByRole("button", {
        name: "프롬프트 설계 실습 질문 5개, 미확인 2개 보기",
      }),
    );

    expect(screen.getByTestId("demo-location")).toHaveTextContent(
      "/rooms/demo-room/chat",
    );
    expect(screen.getByRole("combobox", { name: "질문 연결 대상" })).toHaveValue(
      "flow-prompt",
    );
  });

  it.each([
    ["/rooms/demo-room/checklist", "로드맵 크게 보기"],
    ["/rooms/demo-room/chat", "채팅 크게 보기"],
  ])("%s 화면에 접근 가능한 통합 버튼 하나만 표시한다", (path, label) => {
    renderRoute(path);
    const toolbar = screen.getByRole("toolbar", { name: "수업 화면 배치" });
    const button = within(toolbar).getByRole("button", { name: label });

    expect(within(toolbar).getAllByRole("button")).toHaveLength(1);
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("aria-pressed", "false");
    button.focus();
    expect(button).toHaveFocus();

    for (const oldLabel of [
      "자료 영역 숨기기",
      "자료 영역 표시",
      "로드맵 패널 전체 화면",
      "로드맵 패널 원래 크기",
      "채팅 패널 전체 화면",
      "채팅 패널 원래 크기",
    ]) {
      expect(
        screen.queryByRole("button", { name: oldLabel }),
      ).not.toBeInTheDocument();
    }
  });

  it("로드맵을 크게 보고 자료와 함께 보는 상태로 복원한다", () => {
    const { container } = renderRoute("/rooms/demo-room/checklist");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "RAG 개념과 구조 완료" }),
    );
    const vectorItem = container.querySelector<HTMLElement>(
      '[data-checklist-item-id="flow-vector"]',
    );
    fireEvent.click(
      within(vectorItem!).getByRole("button", {
        name: /^1\.1 벡터DB란 무엇인가/,
      }),
    );

    const expandButton = screen.getByRole("button", {
      name: "로드맵 크게 보기",
    });
    fireEvent.click(expandButton);

    const roomLayout = container.querySelector("main[data-panel-expanded]");
    expect(roomLayout).toHaveAttribute("data-panel-expanded", "true");
    expect(roomLayout).toHaveClass(roomStyles.panelOnly);
    expect(expandButton).toHaveAccessibleName("자료와 함께 보기");
    expect(expandButton).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("article", { name: "현재 자료" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "RAG 개념과 구조 완료" }),
    ).not.toBeChecked();

    fireEvent.click(expandButton);
    expect(roomLayout).toHaveAttribute("data-panel-expanded", "false");
    expect(expandButton).toHaveAccessibleName("로드맵 크게 보기");
    expect(expandButton).toHaveAttribute("aria-pressed", "false");
    expect(
      within(screen.getByRole("article", { name: "현재 자료" })).getByRole(
        "heading",
        { name: "벡터DB란 무엇인가" },
      ),
    ).toBeInTheDocument();
  });

  it("채팅 통합 버튼으로 패널을 확대하고 자료를 복원한다", () => {
    const { container } = renderRoute("/rooms/demo-room/chat");
    const expandButton = screen.getByRole("button", {
      name: "채팅 크게 보기",
    });
    fireEvent.click(expandButton);

    expect(
      container.querySelector("main[data-panel-expanded]"),
    ).toHaveAttribute("data-panel-expanded", "true");
    expect(expandButton).toHaveAccessibleName("자료와 함께 보기");
    expect(expandButton).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("article", { name: "현재 자료" }),
    ).not.toBeInTheDocument();

    fireEvent.click(expandButton);
    expect(expandButton).toHaveAccessibleName("채팅 크게 보기");
    expect(expandButton).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("article", { name: "현재 자료" }),
    ).toBeInTheDocument();
  });

  it("확대 상태와 체크·질문·선택 항목을 탭 이동 중 유지한다", () => {
    const { container } = renderRoute("/rooms/demo-room/checklist");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "실습 코드: prompt_lab.py 완료",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "프롬프트 설계 실습 질문 5개, 미확인 2개 보기",
      }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "질문 입력" }), {
      target: { value: "확대 상태에서도 질문이 유지되나요?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));
    fireEvent.click(screen.getByRole("button", { name: "채팅 크게 보기" }));

    fireEvent.click(screen.getByRole("tab", { name: "로드맵" }));
    const sharedExpandButton = screen.getByRole("button", {
      name: "자료와 함께 보기",
    });
    expect(sharedExpandButton).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("checkbox", {
        name: "실습 코드: prompt_lab.py 완료",
      }),
    ).toBeChecked();
    const promptItem = container.querySelector<HTMLElement>(
      '[data-checklist-item-id="flow-prompt"]',
    );
    expect(
      within(promptItem!).getByRole("button", {
        name: /^2\.2 프롬프트 설계 실습/,
      }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("tab", { name: /채팅/ }));
    expect(
      screen.getByText("확대 상태에서도 질문이 유지되나요?"),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "질문 연결 대상" })).toHaveValue(
      "flow-prompt",
    );
    expect(
      screen.getByRole("button", { name: "자료와 함께 보기" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "자료와 함께 보기" }));
    expect(
      within(screen.getByRole("article", { name: "현재 자료" })).getByRole(
        "heading",
        { name: "프롬프트 설계 실습" },
      ),
    ).toBeInTheDocument();
  });

  it("선택된 항목 태그로 mock 질문을 작성한다", () => {
    renderRoute("/rooms/demo-room/chat");
    fireEvent.change(screen.getByRole("textbox", { name: "질문 입력" }), {
      target: { value: "코드 예제를 다시 설명해 주세요" },
    });
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));

    const question = screen
      .getByText("코드 예제를 다시 설명해 주세요")
      .closest("article");
    expect(question).not.toBeNull();
    expect(
      within(question!).getByText("CODE · 실습 코드: prompt_lab.py 관련 질문"),
    ).toBeInTheDocument();
  });

  it("일반 질문을 선택해 작성한다", () => {
    renderRoute("/rooms/demo-room/chat");
    fireEvent.change(
      screen.getByRole("combobox", { name: "질문 연결 대상" }),
      { target: { value: "GENERAL" } },
    );
    fireEvent.change(screen.getByRole("textbox", { name: "질문 입력" }), {
      target: { value: "수업 자료는 언제 받을 수 있나요?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));

    const question = screen
      .getByText("수업 자료는 언제 받을 수 있나요?")
      .closest("article");
    expect(question).not.toBeNull();
    expect(within(question!).getByText("일반 질문")).toBeInTheDocument();
  });

  it("빈 질문은 추가하지 않는다", () => {
    renderRoute("/rooms/demo-room/chat");
    const beforeCount = document.querySelectorAll("[data-question-id]").length;
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));

    expect(
      screen.getByRole("status", { name: "질문 전송 상태" }),
    ).toHaveTextContent(
      "질문 내용을 입력해 주세요",
    );
    expect(document.querySelectorAll("[data-question-id]")).toHaveLength(
      beforeCount,
    );
  });

  it("mock 욕설 규칙에 해당하는 질문을 차단한다", () => {
    renderRoute("/rooms/demo-room/chat");
    fireEvent.change(screen.getByRole("textbox", { name: "질문 입력" }), {
      target: { value: "바보 같은 질문" },
    });
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));

    expect(
      screen.getByRole("status", { name: "질문 전송 상태" }),
    ).toHaveTextContent("mock 욕설 규칙");
    expect(screen.queryByText("바보 같은 질문")).not.toBeInTheDocument();
  });

  it("동일 질문 반복 전송을 mock 도배로 차단한다", () => {
    renderRoute("/rooms/demo-room/chat");
    const input = screen.getByRole("textbox", { name: "질문 입력" });
    fireEvent.change(input, { target: { value: "같은 질문을 반복합니다" } });
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));
    fireEvent.change(input, { target: { value: "같은 질문을 반복합니다" } });
    fireEvent.click(screen.getByRole("button", { name: "질문 전송" }));

    expect(
      screen.getByRole("status", { name: "질문 전송 상태" }),
    ).toHaveTextContent("동일 질문");
    expect(screen.getAllByText("같은 질문을 반복합니다")).toHaveLength(1);
  });

  it("질문의 답변 완료 상태를 변경한다", () => {
    renderRoute("/rooms/demo-room/chat");
    const question = screen
      .getByText("few-shot이랑 zero-shot 차이가 헷갈려요")
      .closest("article");
    expect(question).not.toBeNull();
    fireEvent.click(
      within(question!).getByRole("button", { name: "답변 완료로 변경" }),
    );

    expect(within(question!).getByText("답변 완료")).toBeInTheDocument();
    expect(
      within(question!).getByText(
        "확인했습니다. 수업이 끝난 뒤에도 다시 설명해 드릴게요.",
      ),
    ).toBeInTheDocument();
  });

  it("질문을 숨겼다가 복구한다", () => {
    renderRoute("/rooms/demo-room/chat");
    const content = "few-shot이랑 zero-shot 차이가 헷갈려요";
    const question = screen.getByText(content).closest("article");
    expect(question).not.toBeNull();
    fireEvent.click(
      within(question!).getByRole("button", {
        name: "배고픈 여우 질문 숨기기",
      }),
    );

    expect(screen.queryByText(content)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "배고픈 여우 질문 복구" }),
    );
    expect(screen.getByText(content)).toBeInTheDocument();
  });

  it("채팅과 로드맵 탭을 이동한다", () => {
    renderRoute("/rooms/demo-room/chat");
    fireEvent.click(screen.getByRole("tab", { name: "로드맵" }));

    expect(screen.getByTestId("demo-location")).toHaveTextContent(
      "/rooms/demo-room/checklist",
    );
    expect(
      screen.getByRole("heading", { name: "챕터별 전체 로드맵" }),
    ).toBeInTheDocument();
  });
});
