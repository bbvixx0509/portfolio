import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api/apiClient";
import { type CourseSummary } from "./courseApi";

const mocks = vi.hoisted(() => ({
  listCloudCourses: vi.fn(),
  createCloudCourse: vi.fn(),
  getCloudCourse: vi.fn(),
  updateCloudCourse: vi.fn(),
  duplicateCloudCourse: vi.fn(),
  archiveCloudCourse: vi.fn(),
  loadCloudCourseMaterialContent: vi.fn(),
  listCloudCourseMaterials: vi.fn(),
  loadOwnStorageUsage: vi.fn(),
}));
const authUser = { uid: "masked-staff" };

vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: authUser }) }));
vi.mock("./courseApi", () => ({ listCloudCourses: mocks.listCloudCourses, createCloudCourse: mocks.createCloudCourse, getCloudCourse: mocks.getCloudCourse, updateCloudCourse: mocks.updateCloudCourse, duplicateCloudCourse: mocks.duplicateCloudCourse, archiveCloudCourse: mocks.archiveCloudCourse, loadCloudCourseMaterialContent: mocks.loadCloudCourseMaterialContent, listCloudCourseMaterials: mocks.listCloudCourseMaterials }));
vi.mock("../material-selection/storageQuotaApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("../material-selection/storageQuotaApi")>();
  return { ...original, loadOwnStorageUsage: mocks.loadOwnStorageUsage };
});

import { CloudCourseCatalogPage, CloudCourseEditorPage } from "./CloudCoursePages";

const activeCourse = {
  id: "active-course",
  title: "ACTIVE React 수업",
  description: "활성 수업",
  createdByDisplayNameSnapshot: "강사",
  chapterCount: 1,
  itemCount: 2,
  updatedAt: "2026-07-25T00:00:00.000Z",
  archivedAt: null,
  status: "ACTIVE" as const,
  isMine: true,
  revision: 1,
};
const archivedCourse = {
  ...activeCourse,
  id: "archived-course",
  title: "ARCHIVED React 수업",
  status: "ARCHIVED" as const,
  archivedAt: "2026-07-25T01:00:00.000Z",
  isMine: false,
  revision: 2,
};

function renderCatalog() {
  return render(<MemoryRouter><CloudCourseCatalogPage /><LocationProbe /></MemoryRouter>);
}

function LocationProbe() { return <output data-testid="location">{useLocation().pathname}</output>; }

describe("CloudCourseCatalogPage", () => {
  beforeEach(() => {
    mocks.listCloudCourses.mockReset();
    mocks.loadOwnStorageUsage.mockReset().mockResolvedValue({
      usedBytes: 1.2 * 1024 ** 3,
      reservedBytes: 0,
      limitBytes: 5 * 1024 ** 3,
      remainingBytes: 3.8 * 1024 ** 3,
      baselineState: "BASELINED",
    });
    mocks.listCloudCourses.mockResolvedValue([activeCourse]);
  });

  it("서버가 반환한 내 목록을 상태 선택 없이 표시하고 제목을 대소문자 없이 검색한다", async () => {
    renderCatalog();

    expect(await screen.findByRole("heading", { name: activeCourse.title })).toBeInTheDocument();
    expect(mocks.listCloudCourses).toHaveBeenCalledWith(authUser);
    expect(screen.queryByRole("radio", { name: "활성 수업" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "보관된 수업" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "내가 만든 목록" })).not.toBeInTheDocument();
    expect(screen.queryByText(activeCourse.createdByDisplayNameSnapshot)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "수업 흐름 검색" }), { target: { value: "rEaCt" } });

    expect(screen.getByRole("heading", { name: activeCourse.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "열기" })).toBeInTheDocument();
  });

  it("검색과 정렬만 제공하고 상태 필터를 렌더링한다", async () => {
    renderCatalog();
    await screen.findByRole("heading", { name: activeCourse.title });
    const search = screen.getByRole("textbox", { name: "수업 흐름 검색" });
    const sort = screen.getByRole("combobox", { name: "수업 흐름 정렬" });
    const statusFilter = screen.getByRole("combobox", { name: "수업 상태 필터" });
    fireEvent.change(search, { target: { value: "ReAcT" } });

    expect(search).toHaveValue("ReAcT");
    expect(statusFilter).toBeInTheDocument();
    fireEvent.change(sort, { target: { value: "OLDEST" } });
    expect(sort).toHaveValue("OLDEST");
  });

  it("현재 상태 안에서 제목 검색 결과가 없을 때 빈 상태를 표시한다", async () => {
    renderCatalog();
    await screen.findByRole("heading", { name: activeCourse.title });
    fireEvent.change(screen.getByRole("textbox", { name: "수업 흐름 검색" }), { target: { value: "없는 제목" } });

    expect(screen.getByText("검색 결과가 없습니다.")).toBeInTheDocument();
  });

  it("코스에 최신 접근 가능 강의방 정보가 포함되어 있으면 해당 강의방을 연다", async () => {
    mocks.listCloudCourses.mockResolvedValue([{
      ...activeCourse,
      latestAccessibleRoom: {
        roomId: "room-latest",
        status: "LIVE",
      }
    } as unknown as CourseSummary]);
    renderCatalog();

    await screen.findByRole("heading", { name: activeCourse.title });
    expect(screen.getAllByText("진행 중")[0]).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "열기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "편집" })).toBeInTheDocument();
    expect(screen.queryByText("NOT-FOR-COURSE-LIST")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "열기" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/rooms/room-latest/checklist");
    fireEvent.click(screen.getByRole("button", { name: "편집" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/courses/active-course/edit");
  });

  it("접근 가능한 강의방이 없을 때만 시작 전 상태로 표시하고, 열기는 생성 화면으로 이동한다", async () => {
    renderCatalog();

    await screen.findByRole("heading", { name: activeCourse.title });
    expect(screen.getAllByText("시작 전").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/courses/active-course/rooms/new");
  });

  it("접근 가능한 강의방이 없으면 편집은 편집 화면으로 이동한다", async () => {
    renderCatalog();
    await screen.findByRole("heading", { name: activeCourse.title });
    fireEvent.click(screen.getByRole("button", { name: "편집" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/courses/active-course/edit");
  });

  it.each([
    ["READY", null, "시작 전", "/rooms/linked-room/checklist"],
    ["LIVE", null, "진행 중", "/rooms/linked-room/checklist"],
    ["ENDED", "2999-07-25T02:00:00.000Z", "자료 열람 가능", "/rooms/linked-room/summary"],
    ["ENDED", "2000-07-25T02:00:00.000Z", "종료됨", "/rooms/linked-room/summary"],
  ] as const)(
    "%s 최신 강의방은 %s 상태로 표시하고 알맞은 화면을 연다",
    async (status, downloadAvailableUntil, stateLabel, expectedPath) => {
      mocks.listCloudCourses.mockResolvedValue([{
        ...activeCourse,
        latestAccessibleRoom: {
          roomId: "linked-room",
          status,
          downloadAvailableUntil,
          endedAt: "2026-07-25T02:00:00.000Z",
        }
      } as unknown as CourseSummary]);
      renderCatalog();

      expect(await screen.findByText(stateLabel)).toBeInTheDocument();
      if (stateLabel === "자료 열람 가능") {
        expect(screen.getByText(/마감 전까지 열람 가능/)).toBeInTheDocument();
      }
      fireEvent.click(screen.getByRole("button", { name: "열기" }));
      expect(screen.getByTestId("location")).toHaveTextContent(expectedPath);
    },
  );

  it("상태 필터를 통해 각 상태의 수업만 볼 수 있다", async () => {
    const ready = { ...activeCourse, id: "ready-course", title: "준비 수업", latestAccessibleRoom: { roomId: "r1", status: "READY" } };
    const live = { ...activeCourse, id: "live-course", title: "진행 수업", latestAccessibleRoom: { roomId: "r2", status: "LIVE" } };
    const readable = { ...activeCourse, id: "readable-course", title: "열람 수업", latestAccessibleRoom: { roomId: "r3", status: "ENDED", downloadAvailableUntil: "2999-01-01T00:00:00Z", endedAt: "2026-07-25T02:00:00.000Z" } };
    const ended = { ...activeCourse, id: "ended-course", title: "종료 수업", latestAccessibleRoom: { roomId: "r4", status: "ENDED", downloadAvailableUntil: "2000-01-01T00:00:00Z", endedAt: "2026-07-25T02:00:00.000Z" } };
    mocks.listCloudCourses.mockResolvedValue([ready, live, readable, ended] as unknown as CourseSummary[]);
    renderCatalog();

    await screen.findByRole("heading", { name: "준비 수업" });
    const titles = () => screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(titles()).toEqual(expect.arrayContaining(["준비 수업", "진행 수업", "열람 수업", "종료 수업"]));

    const filter = screen.getByRole("combobox", { name: "수업 상태 필터" });

    fireEvent.change(filter, { target: { value: "LIVE" } });
    expect(titles()).toEqual(["진행 수업"]);

    fireEvent.change(filter, { target: { value: "NOT_STARTED" } });
    expect(titles()).toEqual(["준비 수업"]);

    fireEvent.change(filter, { target: { value: "DOWNLOAD_OPEN" } });
    expect(titles()).toEqual(["열람 수업"]);
  });

  it("최신순·오래된순·가나다순 정렬을 유지한다", async () => {
    const oldest = { ...activeCourse, id: "oldest", title: "다라마바사", updatedAt: "2026-07-23T00:00:00.000Z" };
    const recent = { ...activeCourse, id: "recent", title: "나다라마바사", updatedAt: "2026-07-27T00:00:00.000Z" };
    const alphabetic = { ...activeCourse, id: "alphabetic", title: "가나다", updatedAt: "2026-07-25T00:00:00.000Z" };
    mocks.listCloudCourses.mockResolvedValue([oldest, recent, alphabetic]);
    renderCatalog();

    await screen.findByRole("heading", { name: recent.title });
    const titles = () => screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(titles()).toEqual([recent.title, alphabetic.title, oldest.title]);
    const sort = screen.getByRole("combobox", { name: "수업 흐름 정렬" });
    fireEvent.change(sort, { target: { value: "OLDEST" } });
    expect(titles()).toEqual([oldest.title, alphabetic.title, recent.title]);
    fireEvent.change(sort, { target: { value: "TITLE_KO" } });
    expect(titles()).toEqual([alphabetic.title, recent.title, oldest.title]);
  });

  it("본인 자료 사용량·한도·남은 용량만 검색 영역 근처에 표시한다", async () => {
    renderCatalog();

    expect(await screen.findByLabelText("내 자료 용량")).toHaveTextContent("사용 중 1.2GB / 5.0GB");
    expect(screen.getByLabelText("내 자료 용량")).toHaveTextContent("남은 용량 3.8GB");
    expect(screen.getByLabelText("자료 용량 사용률 24%")).toBeInTheDocument();
    expect(screen.queryByText("다른 강사 사용량")).not.toBeInTheDocument();
  });

  it("사용률이 80% 이상이면 주의 안내를 표시한다", async () => {
    mocks.loadOwnStorageUsage.mockResolvedValueOnce({
      usedBytes: 4 * 1024 ** 3,
      reservedBytes: 0,
      limitBytes: 5 * 1024 ** 3,
      remainingBytes: 1024 ** 3,
      baselineState: "READY",
    });
    renderCatalog();

    expect(await screen.findByText("저장 공간이 얼마 남지 않았습니다.")).toBeInTheDocument();
  });

  it("남은 용량이 없으면 한도 도달 안내를 표시한다", async () => {
    mocks.loadOwnStorageUsage.mockResolvedValueOnce({
      usedBytes: 5 * 1024 ** 3,
      reservedBytes: 0,
      limitBytes: 5 * 1024 ** 3,
      remainingBytes: 0,
      baselineState: "READY",
    });
    renderCatalog();

    expect(await screen.findByText(/자료 저장 공간을 모두 사용했습니다/)).toBeInTheDocument();
  });

  it("quota counter가 준비되지 않았으면 임의의 0MB 사용량 대신 중립 안내를 표시한다", async () => {
    mocks.loadOwnStorageUsage.mockResolvedValueOnce({
      usedBytes: 0,
      reservedBytes: 0,
      limitBytes: 5 * 1024 ** 3,
      remainingBytes: 5 * 1024 ** 3,
      baselineState: "PENDING_BASELINE",
    });
    renderCatalog();

    expect(await screen.findByText("자료 사용량을 준비하고 있습니다.")).toBeInTheDocument();
    expect(screen.queryByText(/사용 중 0MB/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("자료 용량 사용률 0%")).not.toBeInTheDocument();
  });

  it("용량 조회 실패는 목록을 가리지 않고 다시 시도할 수 있다", async () => {
    mocks.loadOwnStorageUsage
      .mockRejectedValueOnce(new Error("internal usage path"))
      .mockResolvedValueOnce({
        usedBytes: 0,
        reservedBytes: 0,
        limitBytes: 5 * 1024 ** 3,
        remainingBytes: 5 * 1024 ** 3,
        baselineState: "READY",
      });
    renderCatalog();

    expect(await screen.findByText("자료 용량 정보를 불러오지 못했습니다.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: activeCourse.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(mocks.loadOwnStorageUsage).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("내 자료 용량")).toHaveTextContent("남은 용량 5.0GB");
    expect(screen.queryByText("internal usage path")).not.toBeInTheDocument();
  });

  it("401과 403을 용량 서비스 장애와 구분해 안전하게 안내한다", async () => {
    mocks.loadOwnStorageUsage.mockRejectedValueOnce(new ApiError("internal", 401));
    renderCatalog();
    expect(await screen.findByText("로그인 상태를 확인한 뒤 다시 시도해 주세요.")).toBeInTheDocument();

    mocks.loadOwnStorageUsage.mockRejectedValueOnce(new ApiError("internal", 403));
    renderCatalog();
    expect(await screen.findByText("자료 용량 조회 권한이 없습니다.")).toBeInTheDocument();
  });
});

describe("CloudCourseEditorPage", () => {
  beforeEach(() => mocks.getCloudCourse.mockReset());

  it("ARCHIVED 수업을 읽기 전용으로 열고 변경 동작을 숨긴다", async () => {
    mocks.getCloudCourse.mockResolvedValue({
      ...archivedCourse,
      chapters: [{
        id: "chapter-1",
        title: "보관 챕터",
        position: 0,
        items: [{ id: "item-1", title: "보관 항목", description: "설명", position: 0 }],
      }],
    });
    render(<MemoryRouter initialEntries={["/courses/archived-course/prepare"]}><Routes><Route path="/courses/:courseId/prepare" element={<CloudCourseEditorPage />} /></Routes></MemoryRouter>);

    expect(await screen.findByText("보관된 수업")).toBeInTheDocument();
    expect(screen.getByText("보관된 수업은 읽기 전용입니다. 수정하거나 다시 보관할 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "수업 제목" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "챕터 1 제목" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "항목 1 제목" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "저장하기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "삭제" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "챕터 추가" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "항목 추가" })).not.toBeInTheDocument();
  });

  it("보관 수업을 가져오는 FastAPI 응답을 한 번만 사용한다", async () => {
    mocks.getCloudCourse.mockResolvedValue({ ...archivedCourse, chapters: [] });
    render(<MemoryRouter initialEntries={["/courses/archived-course/prepare"]}><Routes><Route path="/courses/:courseId/prepare" element={<CloudCourseEditorPage />} /></Routes></MemoryRouter>);

    await waitFor(() => expect(mocks.getCloudCourse).toHaveBeenCalledWith(authUser, "archived-course"));
  });
});
