import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudCourse: vi.fn(),
  createCloudRoom: vi.fn(),
  listCloudRooms: vi.fn(),
  getCloudRoom: vi.fn(),
  getCloudRoomShare: vi.fn(),
  getCloudRoomInstructorManagement: vi.fn(),
  addCloudRoomAssistant: vi.fn(),
  updateCloudRoomAssistantPermissions: vi.fn(),
  grantCloudRoomAssistantFullAccess: vi.fn(),
  revokeCloudRoomAssistantFullAccess: vi.fn(),
  removeCloudRoomAssistant: vi.fn(),
  transferCloudRoomLead: vi.fn(),
  copyCloudRoomValue: vi.fn(),
  reopenCloudRoom: vi.fn(),
}));
const authUser = { uid: "masked-staff" };

vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: authUser }) }));
vi.mock("../cloud-courses/courseApi", () => ({ getCloudCourse: mocks.getCloudCourse }));
vi.mock("./roomApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./roomApi")>();
  return { ...original, ...mocks };
});

import {
  CloudRoomCreatePage,
  CloudRoomListPage,
  CloudRoomPreparePage,
} from "./CloudRoomPages";

const activeCourse = {
  id: "course-1",
  title: "활성 React 수업",
  status: "ACTIVE" as const,
};
const archivedCourse = { ...activeCourse, status: "ARCHIVED" as const };
const room = {
  id: "room-1",
  title: "7월 React 강의방",
  status: "READY" as const,
  roomCode: "ABCDEFGH",
  sourceCourseId: "course-1",
  sourceCourseRevision: 3,
  sourceCourseTitle: activeCourse.title,
  leadInstructorDisplayNameSnapshot: "테스트 강사",
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
  revision: 1,
  relationship: "CREATED" as const,
  flowItems: [],
  currentRole: "LEAD_INSTRUCTOR" as const,
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("CloudRoom pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCloudCourse.mockResolvedValue(activeCourse);
    mocks.createCloudRoom.mockResolvedValue(room);
    mocks.listCloudRooms.mockResolvedValue([room]);
    mocks.getCloudRoom.mockResolvedValue(room);
    mocks.getCloudRoomShare.mockResolvedValue({
      roomId: room.id,
      orgId: "demo",
      roomCode: room.roomCode,
      joinPath: "/join/demo/ABCDEFGH",
    });
    mocks.getCloudRoomInstructorManagement.mockResolvedValue({
      roomId: room.id,
      revision: 1,
      instructors: [
        { userId: "masked-lead", displayName: "테스트 강사", role: "LEAD", permissions: { questionOperations: true, checklistProgress: true, capacityOperations: true } },
        { userId: "masked-assistant", displayName: "보조 강사", role: "ASSISTANT", permissions: { questionOperations: true, checklistProgress: false, capacityOperations: false } },
      ],
      candidates: [{ userId: "masked-candidate", displayName: "초대 강사", organizationRole: "INSTRUCTOR" }],
    });
    mocks.grantCloudRoomAssistantFullAccess.mockResolvedValue({
      roomId: room.id,
      revision: 2,
      instructors: [
        { userId: "masked-lead", displayName: "테스트 강사", role: "LEAD", permissions: { questionOperations: true, checklistProgress: true, capacityOperations: true } },
        { userId: "masked-assistant", displayName: "보조 강사", role: "ASSISTANT", permissions: { questionOperations: true, checklistProgress: true, capacityOperations: true } },
      ],
      candidates: [{ userId: "masked-candidate", displayName: "초대 강사", organizationRole: "INSTRUCTOR" }],
    });
    mocks.copyCloudRoomValue.mockResolvedValue(undefined);
    mocks.reopenCloudRoom.mockResolvedValue({ ...room, status: "LIVE", revision: 2 });
  });

  it("활성 수업에서만 방을 만들고 정원 계약을 함께 보낸다", async () => {
    render(<MemoryRouter initialEntries={["/courses/course-1/rooms/new"]}><Routes><Route path="/courses/:courseId/rooms/new" element={<CloudRoomCreatePage />} /></Routes><LocationProbe /></MemoryRouter>);

    const sourceCourse = await screen.findByRole("region", { name: "원본 수업 흐름" });
    expect(within(sourceCourse).getByText("활성 React 수업")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "수업 이름" }), { target: { value: "  7월 강의방  " } });
    fireEvent.click(screen.getByRole("button", { name: "새 수업 열기" }));

    await waitFor(() => expect(mocks.createCloudRoom).toHaveBeenCalledWith(authUser, "course-1", "  7월 강의방  ", 50));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/rooms/room-1/prepare"));
  });

  it("ARCHIVED 수업에서는 방 만들기 진입과 생성 버튼을 막는다", async () => {
    mocks.getCloudCourse.mockResolvedValue(archivedCourse);
    render(<MemoryRouter initialEntries={["/courses/course-1/rooms/new"]}><Routes><Route path="/courses/:courseId/rooms/new" element={<CloudRoomCreatePage />} /></Routes></MemoryRouter>);

    expect(await screen.findByRole("alert")).toHaveTextContent("보관된 수업 흐름에서는 새 수업을 열 수 없습니다.");
    expect(screen.getByRole("button", { name: "새 수업 열기" })).toBeDisabled();
  });

  it("빠른 정원 선택과 1~300 정수 검증을 제공한다", async () => {
    render(<MemoryRouter initialEntries={["/courses/course-1/rooms/new"]}><Routes><Route path="/courses/:courseId/rooms/new" element={<CloudRoomCreatePage />} /></Routes></MemoryRouter>);

    await screen.findByRole("region", { name: "원본 수업 흐름" });
    expect(screen.getByRole("button", { name: "50명" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("textbox", { name: "동시 참여 정원" }), { target: { value: "301" } });
    expect(screen.getByRole("alert")).toHaveTextContent("1~300명의 정수");
    expect(screen.getByRole("button", { name: "새 수업 열기" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "100명" }));
    fireEvent.click(screen.getByRole("button", { name: "새 수업 열기" }));
    await waitFor(() => expect(mocks.createCloudRoom).toHaveBeenCalledWith(authUser, "course-1", "활성 React 수업 강의방", 100));
  });

  it("내 접근 범위의 방만 상태별 구역으로 분리하고 개인정보를 표시하지 않는다", async () => {
    mocks.listCloudRooms.mockResolvedValue([
      room,
      { ...room, id: "live-1", title: "진행 강의방", status: "LIVE", currentRole: "ASSISTANT", relationship: "ASSIGNED", startedAt: "2026-07-25T01:00:00.000Z" },
      { ...room, id: "ended-1", title: "종료 강의방", status: "ENDED", currentRole: "LEAD_INSTRUCTOR", endedAt: "2026-07-25T02:00:00.000Z", downloadAvailableUntil: "2026-08-01T02:00:00.000Z", canReopen: true },
    ]);
    render(<MemoryRouter><CloudRoomListPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: room.title })).toBeInTheDocument();
    const active = screen.getByRole("region", { name: "진행 중인 강의방" });
    const ended = screen.getByRole("region", { name: "종료된 강의방" });
    expect(within(active).getByRole("heading", { name: room.title })).toBeInTheDocument();
    expect(within(active).getByRole("heading", { name: "진행 강의방" })).toBeInTheDocument();
    expect(within(ended).getByRole("heading", { name: "종료 강의방" })).toBeInTheDocument();
    expect(within(ended).getByRole("link", { name: "종료 요약 보기" })).toHaveAttribute("href", "/rooms/ended-1/summary");
    expect(within(ended).getByRole("button", { name: "종료 취소" })).toBeVisible();
    expect(screen.queryByText(/테스트 강사/)).not.toBeInTheDocument();
    expect(screen.queryByText("ABCDEFGH")).not.toBeInTheDocument();
    expect(within(active).getAllByRole("link", { name: "강의방 열기" })[0]).toHaveAttribute("href", "/rooms/room-1/prepare");
  });

  it("두 상태 구역에 최신순·오래된순·가나다순 정렬과 개별 빈 상태를 적용한다", async () => {
    mocks.listCloudRooms.mockResolvedValue([
      { ...room, id: "active-old", title: "강의방 10", updatedAt: "2026-07-01T00:00:00.000Z" },
      { ...room, id: "active-new", title: "강의방 2", updatedAt: "2026-07-03T00:00:00.000Z" },
      { ...room, id: "ended-old", title: "종료 10", status: "ENDED", endedAt: "2026-07-01T00:00:00.000Z", currentRole: "LEAD_INSTRUCTOR" },
      { ...room, id: "ended-new", title: "종료 2", status: "ENDED", endedAt: "2026-07-03T00:00:00.000Z", currentRole: "LEAD_INSTRUCTOR" },
    ]);
    render(<MemoryRouter><CloudRoomListPage /></MemoryRouter>);

    await screen.findByRole("heading", { name: "강의방 2" });
    const owned = screen.getByRole("region", { name: "진행 중인 강의방" });
    const assigned = screen.getByRole("region", { name: "종료된 강의방" });
    const titles = (section: HTMLElement) => within(section).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(titles(owned)).toEqual(["강의방 2", "강의방 10"]);
    expect(titles(assigned)).toEqual(["종료 2", "종료 10"]);

    fireEvent.change(screen.getByRole("combobox", { name: "강의방 정렬" }), { target: { value: "OLDEST" } });
    expect(titles(owned)).toEqual(["강의방 10", "강의방 2"]);
    expect(titles(assigned)).toEqual(["종료 10", "종료 2"]);

    fireEvent.change(screen.getByRole("combobox", { name: "강의방 정렬" }), { target: { value: "TITLE_KO" } });
    expect(titles(owned)).toEqual(["강의방 2", "강의방 10"]);
    expect(titles(assigned)).toEqual(["종료 2", "종료 10"]);
  });

  it("종료 요약 전 확인 뒤에만 복구를 요청하고 조건이 없으면 버튼을 숨긴다", async () => {
    mocks.listCloudRooms.mockResolvedValue([
      { ...room, id: "ended-lead", status: "ENDED", currentRole: "LEAD_INSTRUCTOR", canReopen: true, endedAt: "2026-07-25T01:00:00.000Z" },
      { ...room, id: "ended-assistant", status: "ENDED", currentRole: "ASSISTANT", canReopen: true, endedAt: "2026-07-25T01:00:00.000Z" },
      { ...room, id: "ended-expired", status: "ENDED", currentRole: "LEAD_INSTRUCTOR", canReopen: false, endedAt: "2026-07-25T01:00:00.000Z" },
    ]);
    render(<MemoryRouter><CloudRoomListPage /></MemoryRouter>);

    const button = await screen.findByRole("button", { name: "종료 취소" });
    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "이 강의방을 다시 열까요?" })).toBeInTheDocument();
    expect(mocks.reopenCloudRoom).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(mocks.reopenCloudRoom).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "종료 취소" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "이 강의방을 다시 열까요?" })).getByRole("button", { name: "종료 취소" }));
    await waitFor(() => expect(mocks.reopenCloudRoom).toHaveBeenCalledWith(authUser, "ended-lead", 1));
    expect(screen.getAllByRole("button", { name: "종료 취소" })).toHaveLength(1);
  });

  it("각 상태 구역에 독립된 빈 상태를 표시한다", async () => {
    mocks.listCloudRooms.mockResolvedValue([room]);
    render(<MemoryRouter><CloudRoomListPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: room.title })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "종료된 강의방" })).getByText("표시할 강의방이 없습니다.")).toBeInTheDocument();
  });

  it("준비 화면은 공유 정보를 표시하고 링크와 코드 복사 상태를 알린다", async () => {
    render(<MemoryRouter initialEntries={["/rooms/room-1/prepare"]}><Routes><Route path="/rooms/:roomId/prepare" element={<CloudRoomPreparePage />} /></Routes></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: room.title })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "방 코드" })).toHaveValue("ABCDEFGH");
    expect(screen.getByRole("textbox", { name: "공유 링크" })).toHaveValue("http://localhost:3000/join/demo/ABCDEFGH");
    expect(screen.queryByRole("link", { name: "강의방 목록" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "로드맵 열기" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "링크 복사" }));
    await waitFor(() => expect(mocks.copyCloudRoomValue).toHaveBeenCalledWith("http://localhost:3000/join/demo/ABCDEFGH"));
    expect(screen.getByRole("status")).toHaveTextContent("공유 링크을 복사했습니다.");
  });

  it("복사 실패와 모바일 폭에서도 입력·복사 조작을 유지한다", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    mocks.copyCloudRoomValue.mockRejectedValue(new Error("denied"));
    render(<MemoryRouter initialEntries={["/rooms/room-1/prepare"]}><Routes><Route path="/rooms/:roomId/prepare" element={<CloudRoomPreparePage />} /></Routes></MemoryRouter>);

    await screen.findByRole("heading", { name: room.title });
    expect(screen.getByRole("textbox", { name: "방 코드" })).toBeVisible();
    expect(screen.getByRole("button", { name: "방 코드 복사" })).toBeVisible();
    expect(screen.getByRole("button", { name: "링크 복사" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "방 코드 복사" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("방 코드을 복사하지 못했습니다.");
  });

  it("주 강사에게만 강사 관리 진입점과 전체 권한 확인 흐름을 제공한다", async () => {
    render(<MemoryRouter initialEntries={["/rooms/room-1/prepare"]}><Routes><Route path="/rooms/:roomId/prepare" element={<CloudRoomPreparePage />} /></Routes></MemoryRouter>);

    await screen.findByRole("heading", { name: room.title });
    fireEvent.click(screen.getByRole("button", { name: "강사 관리 열기" }));
    expect(await screen.findByRole("heading", { name: "강사 관리" })).toBeInTheDocument();
    expect(screen.getAllByText("보조 강사")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "전체 권한 부여" }));
    expect(screen.getByRole("dialog", { name: /전체 권한 부여 확인/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "확인" }));
    await waitFor(() => expect(mocks.grantCloudRoomAssistantFullAccess).toHaveBeenCalledWith(authUser, "room-1", "masked-assistant", 1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "전체 권한 회수" }),
      ).toBeInTheDocument(),
    );
  });

  it("보조 강사와 배정되지 않은 ADMIN에는 강사 관리 버튼을 표시하지 않는다", async () => {
    mocks.getCloudRoom.mockResolvedValue({ ...room, currentRole: "ASSISTANT" });
    const assistantView = render(<MemoryRouter initialEntries={["/rooms/room-1/prepare"]}><Routes><Route path="/rooms/:roomId/prepare" element={<CloudRoomPreparePage />} /></Routes></MemoryRouter>);
    await screen.findByRole("heading", { name: room.title });
    expect(screen.queryByRole("button", { name: "강사 관리 열기" })).not.toBeInTheDocument();
    assistantView.unmount();

    mocks.getCloudRoom.mockResolvedValue({ ...room, currentRole: "ADMIN" });
    render(<MemoryRouter initialEntries={["/rooms/room-1/prepare"]}><Routes><Route path="/rooms/:roomId/prepare" element={<CloudRoomPreparePage />} /></Routes></MemoryRouter>);
    await screen.findByRole("heading", { name: room.title });
    expect(screen.queryByRole("button", { name: "강사 관리 열기" })).not.toBeInTheDocument();
  });
});
