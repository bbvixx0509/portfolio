import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCloudCourse: vi.fn(),
  attachCloudCourseMaterial: vi.fn(),
  detachCloudCourseMaterial: vi.fn(),
  getCloudCourse: vi.fn(),
  listCloudCourseMaterials: vi.fn(),
  loadCloudCourseMaterialContent: vi.fn(),
  updateCloudCourse: vi.fn(),
  uploadMaterialFile: vi.fn(),
}));
const authUser = { uid: "masked-author" };

vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: authUser }) }));
vi.mock("../cloud-courses/courseApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloud-courses/courseApi")>()),
  ...mocks,
}));
vi.mock("./materialUploadApi", () => ({ uploadMaterialFile: mocks.uploadMaterialFile }));

import { CourseFlowEditorPage } from "./CourseFlowEditorPage";

const course = {
  id: "course-1",
  title: "자료 기반 수업",
  description: "로드맵 설명",
  createdByDisplayNameSnapshot: "강사",
  chapterCount: 2,
  itemCount: 2,
  updatedAt: "2026-07-29T00:00:00.000Z",
  archivedAt: null,
  status: "ACTIVE" as const,
  isMine: true,
  revision: 1,
  chapters: [{
    id: "chapter-1",
    title: "첫 챕터",
    position: 0,
    items: [{
      id: "item-1",
      title: "첫 항목",
      description: "항목 설명",
      position: 0,
      sourcePageOrSlideNumbers: [3, 1],
    }],
  }, {
    id: "chapter-2",
    title: "둘째 챕터",
    position: 1,
    items: [{
      id: "item-2",
      title: "둘째 항목",
      description: "둘째 설명",
      position: 0,
      sourcePageOrSlideNumbers: [5],
    }],
  }],
};

function renderPage(path = "/courses/course-1/edit", state?: unknown) {
  return render(<MemoryRouter initialEntries={[{ pathname: path, state }]}><Routes>
    <Route path="/courses/:courseId/edit" element={<CourseFlowEditorPage />} />
    <Route path="/courses/:courseId/rooms/new" element={<p>강의방 만들기 화면</p>} />
    <Route path="/courses/import" element={<p>수업 목록 화면</p>} />
  </Routes><LocationProbe /></MemoryRouter>);
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

describe("CourseFlowEditorPage", () => {
  beforeEach(() => {
    mocks.createCloudCourse.mockReset();
    mocks.getCloudCourse.mockReset().mockResolvedValue(course);
    mocks.updateCloudCourse.mockReset().mockResolvedValue({ ...course, revision: 2 });
    mocks.listCloudCourseMaterials.mockReset().mockResolvedValue({ materials: [], unavailableMaterialCount: 0 });
    mocks.attachCloudCourseMaterial.mockReset();
    mocks.detachCloudCourseMaterial.mockReset();
    mocks.loadCloudCourseMaterialContent.mockReset().mockResolvedValue(new Blob(["pdf"]));
    mocks.uploadMaterialFile.mockReset();
  });

  it("자료가 없을 때 가짜 슬라이드 없이 같은 2패널에서 저장한다", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "로드맵 편집" })).toBeInTheDocument();
    expect(screen.getByText("강의 자료 추가")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "자료 선택" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "수업 흐름 목록" })).not.toBeInTheDocument();
    expect(screen.queryByText("학습 목표")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "목표 추가" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "수업 제목" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "수업 설명" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "수업 제목 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "수업 제목" }), { target: { value: "수정한 수업" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(mocks.updateCloudCourse).toHaveBeenCalledTimes(1));
    expect(mocks.updateCloudCourse).toHaveBeenCalledWith(authUser, "course-1", expect.objectContaining({
      title: "수정한 수업",
      description: "로드맵 설명",
      chapters: expect.arrayContaining([expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ sourcePageOrSlideNumbers: [3, 1] })]) })]),
    }), 1);
    expect(screen.getByTestId("location")).toHaveTextContent("/courses/course-1/edit");
    expect(screen.queryByText("수업 흐름을 저장했습니다. 강의방은 필요할 때 별도로 만들어 주세요.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "수업 목록으로 가기" })).toHaveAttribute("href", "/courses/import");
    expect(screen.getByRole("link", { name: "수업 열기" })).toHaveAttribute("href", "/courses/course-1/rooms/new");
  });

  it("수업 목록 이동과 현재 로드맵의 수업 열기 경로를 분리한다", async () => {
    const firstRender = renderPage();
    await screen.findByRole("heading", { name: "로드맵 편집" });

    fireEvent.click(screen.getByRole("link", { name: "수업 목록으로 가기" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/courses/import");
    expect(mocks.createCloudCourse).not.toHaveBeenCalled();
    expect(mocks.updateCloudCourse).not.toHaveBeenCalled();

    firstRender.unmount();
    renderPage();
    await screen.findByRole("heading", { name: "로드맵 편집" });

    fireEvent.click(screen.getByRole("link", { name: "수업 열기" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/courses/course-1/rooms/new");
    expect(mocks.createCloudCourse).not.toHaveBeenCalled();
    expect(mocks.updateCloudCourse).not.toHaveBeenCalled();
  });

  it("연결 자료 조회 중에는 빈 자료 상태 대신 가벼운 로딩 상태를 표시한다", async () => {
    mocks.listCloudCourseMaterials.mockReturnValue(new Promise(() => undefined));
    renderPage();

    expect(await screen.findByText("연결된 자료 정보를 불러오는 중입니다.")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-course-materials")).not.toBeInTheDocument();
  });

  it("이전 저장 화면의 history 안내는 다시 표시하지 않는다", async () => {
    renderPage("/courses/course-1/edit", {
      notice: "수업 흐름을 저장했습니다. 강의방은 필요할 때 별도로 만들어 주세요.",
    });

    await screen.findByRole("heading", { name: "로드맵 편집" });
    expect(screen.queryByText("수업 흐름을 저장했습니다. 강의방은 필요할 때 별도로 만들어 주세요.")).not.toBeInTheDocument();
  });

  it("현재 작업 챕터만 기본으로 펼치고 다른 챕터를 선택하면 전환한다", async () => {
    renderPage();

    await screen.findByRole("heading", { name: "로드맵 편집" });
    expect(screen.getByRole("button", { name: "챕터 01 접기" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "챕터 02 펼치기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("첫 항목")).toBeInTheDocument();
    expect(screen.queryByText("둘째 항목")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "챕터 02 펼치기" }));
    expect(screen.queryByText("첫 항목")).not.toBeInTheDocument();
    expect(screen.getByText("둘째 항목")).toBeInTheDocument();
  });

  it("선택한 항목만 상세 편집하고 취소와 적용으로 값을 제어한다", async () => {
    renderPage();

    await screen.findByRole("heading", { name: "로드맵 편집" });
    fireEvent.click(screen.getByText("첫 항목").closest("button")!);
    expect(screen.getAllByTestId("selected-checklist-item-editor")).toHaveLength(1);
    const title = screen.getByLabelText("챕터 1 항목 1 제목");
    fireEvent.change(title, { target: { value: "취소할 제목" } });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByTestId("selected-checklist-item-editor")).not.toBeInTheDocument();
    expect(screen.queryByText("취소할 제목")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("첫 항목").closest("button")!);
    fireEvent.change(screen.getByLabelText("챕터 1 항목 1 제목"), { target: { value: "적용한 제목" } });
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(screen.queryByTestId("selected-checklist-item-editor")).not.toBeInTheDocument();
    expect(screen.getByText("적용한 제목")).toBeInTheDocument();
  });

  it("챕터와 항목 추가, 드래그 핸들 및 고정 저장 영역을 유지한다", async () => {
    renderPage();

    await screen.findByRole("heading", { name: "로드맵 편집" });
    expect(screen.getByTestId("course-flow-editor-actions")).toContainElement(screen.getByRole("button", { name: "저장" }));
    expect(screen.getAllByRole("button", { name: "순서 변경" })[0]).toHaveAttribute("title", "순서 변경");
    expect(screen.queryByRole("button", { name: /위로 이동|아래로 이동/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "챕터 추가" }));
    expect(screen.getByDisplayValue("새 로드맵 항목")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "적용" })).toBeEnabled();
  });

  it("로드맵 패널 리사이저가 380px~작업 영역 48% 범위에서 너비를 조절한다", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    try {
      renderPage();
      await screen.findByRole("heading", { name: "로드맵 편집" });

      const resizer = screen.getByRole("separator", { name: "로드맵 패널 너비 조절" });
      expect(resizer).toHaveAttribute("aria-valuenow", "440");
      expect(resizer).toHaveAttribute("aria-valuemin", "380");
      expect(resizer).toHaveAttribute("aria-valuemax", "491");

      fireEvent.pointerDown(resizer, { button: 0, clientX: 600 });
      fireEvent.pointerMove(window, { clientX: 560 });
      expect(resizer).toHaveAttribute("aria-valuenow", "480");
      fireEvent.pointerUp(window);

      fireEvent.keyDown(resizer, { key: "End" });
      expect(resizer).toHaveAttribute("aria-valuenow", "491");
      fireEvent.keyDown(resizer, { key: "Home" });
      expect(resizer).toHaveAttribute("aria-valuenow", "380");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
    }
  });

  it("연결된 자료를 안전한 이름과 형식으로 선택하고 현재 로드맵에서만 연결 해제한다", async () => {
    mocks.listCloudCourseMaterials.mockResolvedValue({
      materials: [
        { id: "material-1", filename: "첫 자료.pdf", normalizedExtension: "pdf", sizeBytes: 1024 },
        { id: "material-2", filename: "둘째 자료.pptx", normalizedExtension: "pptx", sizeBytes: 2048 },
      ],
      unavailableMaterialCount: 0,
    });
    mocks.detachCloudCourseMaterial.mockResolvedValue([
      { id: "material-1", filename: "첫 자료.pdf", normalizedExtension: "pdf", sizeBytes: 1024 },
    ]);
    renderPage();

    expect(await screen.findByRole("button", { name: /PDF · 첫 자료.pdf/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /PPTX · 둘째 자료.pptx/ }));
    expect(screen.getByText("선택한 PPTX 자료")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "자료 연결 해제" }));

    await waitFor(() => expect(mocks.detachCloudCourseMaterial).toHaveBeenCalledWith(authUser, "course-1", "material-2"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /PPTX · 둘째 자료.pptx/ })).not.toBeInTheDocument());
  });

  it("연결 자료 조회 실패를 빈 자료 상태로 바꾸지 않고 재시도한다", async () => {
    mocks.listCloudCourseMaterials.mockRejectedValueOnce(new Error("unavailable"));
    renderPage();

    expect(await screen.findByTestId("course-material-load-error")).toHaveTextContent("연결된 자료 정보를 불러오지 못했습니다.");
    expect(screen.queryByTestId("empty-course-materials")).not.toBeInTheDocument();
    mocks.listCloudCourseMaterials.mockResolvedValueOnce({
      materials: [{ id: "material-1", filename: "기존 자료.pdf", normalizedExtension: "pdf", sizeBytes: 1024 }],
      unavailableMaterialCount: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(await screen.findByRole("button", { name: /PDF · 기존 자료.pdf/ })).toBeInTheDocument();
  });

  it("누락된 연결 자료를 빈 상태로 오인하지 않고 안전한 안내를 표시한다", async () => {
    mocks.listCloudCourseMaterials.mockResolvedValueOnce({ materials: [], unavailableMaterialCount: 1 });
    renderPage();

    expect(await screen.findByTestId("course-material-load-error")).toHaveTextContent("연결된 자료를 찾을 수 없습니다. 자료를 다시 연결해 주세요.");
    expect(screen.queryByTestId("empty-course-materials")).not.toBeInTheDocument();
  });

  it("명시적 업로드 뒤에만 자료를 현재 로드맵에 연결하고 미리보기를 선택한다", async () => {
    const file = new File(["%PDF-1.7\n"], "새 자료.pdf", { type: "application/pdf" });
    mocks.uploadMaterialFile.mockResolvedValue({ uploadId: "material-new", normalizedExtension: "pdf", sizeBytes: file.size });
    mocks.attachCloudCourseMaterial.mockResolvedValue([{ id: "material-new", filename: "새 자료.pdf", normalizedExtension: "pdf", sizeBytes: file.size }]);
    renderPage();

    await screen.findByText("강의 자료 추가");
    fireEvent.change(screen.getByLabelText("자료 파일 선택"), { target: { files: [file] } });
    expect(await screen.findByRole("button", { name: "자료 업로드" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "자료 업로드" }));

    await waitFor(() => expect(mocks.uploadMaterialFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.attachCloudCourseMaterial).toHaveBeenCalledWith(authUser, "course-1", "material-new"));
    expect(await screen.findByTitle("새 자료.pdf")).toBeInTheDocument();
  });
});
