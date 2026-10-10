import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialCourseDraftEditorPage } from "./MaterialCourseDraftEditorPage";

const { applyMock, discardMock, getMock } = vi.hoisted(() => ({
  applyMock: vi.fn(),
  discardMock: vi.fn(),
  getMock: vi.fn(),
}));

vi.mock("./materialUploadApi", () => ({
  applyMaterialCourseDraft: applyMock,
  discardMaterialCourseDraft: discardMock,
  getMaterialCourseDraft: getMock,
}));

const generatedDraft = {
  draftId: "draft-1",
  status: "GENERATED" as const,
  suggestedTitle: "AI 제안 제목",
  summary: "AI 제안 설명",
  chapters: [
    { title: "첫 챕터", items: [{ title: "첫 항목", description: "첫 설명", sourcePageOrSlideNumbers: [1] }] },
    { title: "둘째 챕터", items: [{ title: "둘째 항목", description: "둘째 설명", sourcePageOrSlideNumbers: [2] }] },
  ],
  modelId: "gemini-2.5-flash",
  promptVersion: "material-course-draft-v1",
  failureCode: null,
  revision: 2,
  appliedCourseId: null,
};

const reorderableDraft = {
  ...generatedDraft,
  chapters: [
    {
      title: "첫 챕터",
      items: [
        { title: "첫 항목", description: "첫 설명", sourcePageOrSlideNumbers: [1] },
        { title: "둘째 항목", description: "둘째 설명", sourcePageOrSlideNumbers: [2] },
      ],
    },
    { title: "셋째 챕터", items: [{ title: "셋째 항목", description: "셋째 설명", sourcePageOrSlideNumbers: [3] }] },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/material-course-drafts/draft-1/edit"]}>
      <Routes><Route path="/material-course-drafts/:draftId/edit" element={<MaterialCourseDraftEditorPage />} /><Route path="/courses/:courseId/edit" element={<LocationProbe />} /></Routes>
    </MemoryRouter>,
  );
}

function LocationProbe() {
  return <p>{useLocation().pathname}</p>;
}

describe("MaterialCourseDraftEditorPage", () => {
  beforeEach(() => {
    getMock.mockReset();
    applyMock.mockReset();
    discardMock.mockReset();
    getMock.mockResolvedValue(generatedDraft);
  });

  it("학습 목표 없이 새 2패널 편집 화면을 저장하고 강의방은 만들지 않는다", async () => {
    applyMock.mockResolvedValue({
      draft: { ...generatedDraft, status: "APPLIED", revision: 3, appliedCourseId: "course-1" },
      course: { id: "course-1", title: "편집 제목", status: "ACTIVE", revision: 1 },
    });
    renderPage();

    const title = await screen.findByDisplayValue("AI 제안 제목");
    expect(screen.getByRole("heading", { name: "로드맵 편집" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "선택한 자료 보기" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "자료 선택으로" })).not.toBeInTheDocument();
    expect(screen.queryByText("학습 목표")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "목표 추가" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "수업 설명" })).not.toBeInTheDocument();
    fireEvent.change(title, { target: { value: "편집 제목" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await act(async () => {});
    expect(applyMock).toHaveBeenCalledTimes(1);
    const [, payload] = applyMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.title).toBe("편집 제목");
    expect(JSON.stringify(payload)).not.toContain("position");
    expect(JSON.stringify(payload)).not.toContain("learningObjectives");
    expect(JSON.stringify(payload)).toContain("sourcePageOrSlideNumbers");
    expect(await screen.findByText("/courses/course-1/edit")).toBeInTheDocument();
  });

  it("폐기는 확인 후 상태만 DISCARDED로 바꾼다", async () => {
    discardMock.mockResolvedValue({ ...generatedDraft, status: "DISCARDED", revision: 3 });
    renderPage();

    await screen.findByDisplayValue("AI 제안 제목");
    fireEvent.click(screen.getByRole("button", { name: "초안 폐기" }));
    fireEvent.click(screen.getAllByRole("button", { name: "초안 폐기" }).at(-1)!);

    await act(async () => {});
    expect(discardMock).toHaveBeenCalledWith("draft-1", 2);
    expect(await screen.findByText("폐기된 초안입니다")).toBeInTheDocument();
  });

  it("항목 추가·삭제와 모바일 저장 버튼을 유지한다", async () => {
    renderPage();
    await screen.findByDisplayValue("AI 제안 제목");
    fireEvent.click(screen.getAllByRole("button", { name: "항목 추가" })[0]);
    expect(screen.getByDisplayValue("새 로드맵 항목")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "항목 삭제" }).at(-1)!);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    expect(screen.getByRole("button", { name: "저장" })).toBeVisible();
  });

  it("첫 챕터만 기본으로 펼치고 챕터를 접거나 펼칠 수 있다", async () => {
    renderPage();

    await screen.findByDisplayValue("AI 제안 제목");
    expect(screen.getByRole("button", { name: "챕터 01 접기" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "챕터 01 접기" })).toHaveAttribute("title", "챕터 접기");
    expect(screen.getAllByText("1 / 1")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "챕터 02 펼치기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "챕터 02 펼치기" })).toHaveAttribute("title", "챕터 펼치기");
    expect(screen.getByText("첫 항목")).toBeInTheDocument();
    expect(screen.getByText("자료 참고 1")).toBeInTheDocument();
    expect(screen.getByText("질문 0")).toBeInTheDocument();
    expect(screen.queryByText("둘째 항목")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "챕터 02 펼치기" }));
    expect(screen.getByText("둘째 항목")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "챕터 01 접기" }));
    expect(screen.queryByText("첫 항목")).not.toBeInTheDocument();
  });

  it("선택한 항목만 상세 편집하고 입력값을 보존한다", async () => {
    renderPage();

    await screen.findByDisplayValue("AI 제안 제목");
    expect(screen.queryByTestId("selected-checklist-item-editor")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("첫 항목").closest("button")!);
    const firstTitle = screen.getByLabelText("챕터 1 항목 1 제목");
    const firstDescription = screen.getByLabelText("챕터 1 항목 1 설명");
    fireEvent.change(firstTitle, { target: { value: "수정한 첫 항목" } });
    fireEvent.change(firstDescription, { target: { value: "수정한 첫 설명" } });
    expect(screen.getAllByTestId("selected-checklist-item-editor")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "챕터 02 펼치기" }));
    fireEvent.click(screen.getByText("둘째 항목").closest("button")!);
    expect(screen.queryByLabelText("챕터 1 항목 1 제목")).not.toBeInTheDocument();
    expect(screen.getByLabelText("챕터 2 항목 1 제목")).toBeInTheDocument();

    fireEvent.click(screen.getByText("수정한 첫 항목").closest("button")!);
    expect(screen.getByDisplayValue("수정한 첫 항목")).toBeInTheDocument();
    expect(screen.getByDisplayValue("수정한 첫 설명")).toBeInTheDocument();
  });

  it("챕터와 항목의 추가·삭제 제어, 드래그 핸들 및 고정 저장 영역을 유지한다", async () => {
    renderPage();

    await screen.findByDisplayValue("AI 제안 제목");
    expect(screen.getByTestId("draft-editor-actions")).toContainElement(screen.getByRole("button", { name: "저장" }));
    expect(screen.getAllByRole("button", { name: "순서 변경" })[0]).toHaveAttribute("title", "순서 변경");
    expect(screen.queryByRole("button", { name: /위로 이동|아래로 이동/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "챕터 추가" }));
    expect(screen.getByDisplayValue("새 로드맵 항목")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "선택한 항목 삭제" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "챕터 01 접기" }));
    fireEvent.click(screen.getByRole("button", { name: "챕터 02 펼치기" }));
    fireEvent.click(screen.getAllByRole("button", { name: "항목 추가" })[0]);
    expect(screen.getAllByText("새 로드맵 항목")).toHaveLength(2);
    expect(screen.getAllByTestId("selected-checklist-item-editor")).toHaveLength(1);
  });

  it("키보드 드래그로 같은 챕터의 항목 순서를 바꾸고 선택한 항목을 유지한다", async () => {
    getMock.mockResolvedValue(reorderableDraft);
    renderPage();

    await screen.findByText("첫 항목");
    const listItems = screen.getAllByRole("listitem");
    listItems.forEach((item, index) => {
      Object.defineProperty(item, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: 0, y: index * 80, top: index * 80, left: 0, right: 320, bottom: (index + 1) * 80, width: 320, height: 80, toJSON: () => ({}) }),
      });
    });

    fireEvent.click(screen.getByText("첫 항목").closest("button")!);
    const firstHandle = screen.getAllByRole("button", { name: "순서 변경" })[1];
    fireEvent.keyDown(firstHandle, { key: " ", code: "Space" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.keyDown(firstHandle, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(firstHandle, { key: " ", code: "Space" });

    await waitFor(() => expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("둘째 항목"));
    expect(screen.getByDisplayValue("첫 항목")).toBeInTheDocument();
    expect(applyMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /위로 이동|아래로 이동/ })).not.toBeInTheDocument();
  });

  it("키보드 드래그로 챕터 순서를 바꾸고 저장을 자동 호출하지 않는다", async () => {
    getMock.mockResolvedValue(reorderableDraft);
    renderPage();

    await screen.findByText("첫 챕터");
    const chapterHandles = screen.getAllByRole("button", { name: "순서 변경" });
    chapterHandles.forEach((handle, index) => {
      const chapter = handle.closest("section")!;
      Object.defineProperty(chapter, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: 0, y: index * 100, top: index * 100, left: 0, right: 320, bottom: (index + 1) * 100, width: 320, height: 100, toJSON: () => ({}) }),
      });
    });

    fireEvent.keyDown(chapterHandles[0], { key: " ", code: "Space" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.keyDown(chapterHandles[0], { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(chapterHandles[0], { key: " ", code: "Space" });

    await waitFor(() => expect(screen.getAllByRole("button", { name: /챕터 \d{2} (접기|펼치기)/ })[0]).toHaveTextContent("셋째 챕터"));
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("드래그를 취소하면 항목 순서와 편집값을 유지한다", async () => {
    getMock.mockResolvedValue(reorderableDraft);
    renderPage();

    await screen.findByText("첫 항목");
    const listItems = screen.getAllByRole("listitem");
    listItems.forEach((item, index) => {
      Object.defineProperty(item, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: 0, y: index * 80, top: index * 80, left: 0, right: 320, bottom: (index + 1) * 80, width: 320, height: 80, toJSON: () => ({}) }),
      });
    });

    const firstHandle = screen.getAllByRole("button", { name: "순서 변경" })[1];
    fireEvent.keyDown(firstHandle, { key: " ", code: "Space" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.keyDown(firstHandle, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(firstHandle, { key: "Escape", code: "Escape" });

    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("첫 항목");
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("저장 중 중복 적용을 막고 실패해도 편집값을 유지한다", async () => {
    applyMock.mockRejectedValueOnce(new Error("저장 실패"));
    renderPage();

    const title = await screen.findByDisplayValue("AI 제안 제목");
    fireEvent.change(title, { target: { value: "다시 시도할 제목" } });
    const save = screen.getByRole("button", { name: "저장" });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("저장 실패");
    expect(screen.getByDisplayValue("다시 시도할 제목")).toBeInTheDocument();
  });
});
