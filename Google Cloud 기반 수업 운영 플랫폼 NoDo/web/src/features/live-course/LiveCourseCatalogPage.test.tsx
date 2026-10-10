import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  profileState,
  authUser,
  requestApiMock,
  membershipListener,
  coursesState,
  whereMock,
} = vi.hoisted(() => ({
  profileState: {
    uid: "staff-one",
    orgId: "org-nodo",
    accountType: "STAFF" as "STAFF" | "STUDENT",
    organizationRole: "INSTRUCTOR" as "ADMIN" | "INSTRUCTOR",
    displayName: "테스트 직원",
  },
  authUser: { uid: "staff-one" },
  requestApiMock: vi.fn(),
  membershipListener: { current: null as null | (() => void) },
  coursesState: { current: [] as Record<string, unknown>[] },
  whereMock: vi.fn(() => ({ kind: "where" })),
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ profile: profileState, user: authUser }),
}));
vi.mock("../../lib/api/apiClient", () => ({ requestApi: requestApiMock }));
vi.mock("../../lib/firebase/firebaseFirestore", () => ({
  getLocalFirebaseFirestore: () => ({}),
}));
vi.mock("firebase/firestore", () => ({
  collectionGroup: vi.fn(() => ({ kind: "staff-group" })),
  query: vi.fn((reference) => reference),
  where: whereMock,
  onSnapshot: vi.fn((_reference, next: () => void) => {
    membershipListener.current = next;
    next();
    return () => undefined;
  }),
}));

import { LiveCourseCatalogPage } from "./LiveCourseCatalogPage";

function leadCourses() {
  return [
    { id: "active-course", title: "진행 강의", status: "ACTIVE", activeRoomId: "demo-room", leadInstructorId: "staff-one", roomRole: "LEAD" },
    { id: "draft-course", title: "준비 강의", status: "PREPARING", activeRoomId: null, leadInstructorId: "staff-one", roomRole: "LEAD" },
  ];
}

function renderPage() {
  render(<MemoryRouter><LiveCourseCatalogPage variant="dashboard" /></MemoryRouter>);
}

describe("LiveCourseCatalogPage 강의방별 담당 관계", () => {
  beforeEach(() => {
    profileState.uid = "staff-one";
    profileState.accountType = "STAFF";
    profileState.organizationRole = "INSTRUCTOR";
    authUser.uid = "staff-one";
    coursesState.current = leadCourses();
    membershipListener.current = null;
    whereMock.mockClear();
    requestApiMock.mockReset().mockImplementation(
      (path: string, options?: { method?: string }) => {
        if (path === "/api/courses" && options?.method === "POST") {
          return Promise.resolve({ id: "new-course", title: "새 강의", roomRole: "LEAD" });
        }
        if (path === "/api/courses") return Promise.resolve(coursesState.current);
        return Promise.resolve({});
      },
    );
  });

  it("모든 직원이 강의를 만들고 생성자가 담당인 강의는 주 강사로 표시한다", async () => {
    renderPage();
    await screen.findByText("진행 강의");
    expect(screen.getAllByText(/주 강사 ·/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: /새 강의 생성/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /수업 흐름 편집/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /강의방 생성/ })).toBeInTheDocument();
  });

  it("보조 강사는 초대된 방을 열고 별도의 새 강의도 만들 수 있다", async () => {
    profileState.uid = "staff-two";
    authUser.uid = "staff-two";
    coursesState.current = [{
      id: "active-course",
      title: "보조 강의",
      status: "ACTIVE",
      activeRoomId: "demo-room",
      leadInstructorId: "staff-one",
      roomRole: "ASSISTANT",
    }];
    renderPage();
    await screen.findByText("보조 강의");
    expect(screen.getByText(/보조 강사 ·/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /수업 흐름 보기/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /강의방 열기/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /새 강의 생성/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /강의방 생성/ })).not.toBeInTheDocument();
  });

  it("관리자는 방 담당 관계와 별개이며 생성자 본인이 새 강의 주 강사가 된다", async () => {
    profileState.organizationRole = "ADMIN";
    coursesState.current = [{
      id: "other-course",
      title: "다른 직원 강의",
      status: "ACTIVE",
      activeRoomId: "other-room",
      leadInstructorId: "staff-other",
      roomRole: null,
    }];
    renderPage();
    await screen.findByText("다른 직원 강의");
    expect(screen.getByText(/담당자 아님 ·/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /수업 흐름|강의방 열기/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "새 강의명" }), {
      target: { value: "관리자가 직접 맡는 강의" },
    });
    fireEvent.click(screen.getByRole("button", { name: "새 강의 생성" }));
    await waitFor(() => expect(requestApiMock).toHaveBeenCalledWith(
      "/api/courses",
      expect.objectContaining({
        method: "POST",
        body: { title: "관리자가 직접 맡는 강의" },
      }),
    ));
    const createCall = requestApiMock.mock.calls.find(
      ([path, options]) => path === "/api/courses" && options?.method === "POST",
    );
    expect(createCall?.[1].body).not.toHaveProperty("leadInstructorId");
  });

  it("일반 직원도 명시적 방 관계가 없으면 보조 강사로 추정하지 않는다", async () => {
    coursesState.current = [{
      id: "unrelated-course",
      title: "담당하지 않는 강의",
      status: "ACTIVE",
      activeRoomId: "unrelated-room",
      leadInstructorId: "staff-other",
      roomRole: null,
    }];
    renderPage();
    await screen.findByText("담당하지 않는 강의");
    expect(screen.getByText(/담당자 아님 ·/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /수업 흐름|강의방 열기/ })).not.toBeInTheDocument();
  });

  it("본인 staff 관계의 실시간 변경을 신호로 강의 목록을 다시 조회한다", async () => {
    profileState.uid = "staff-two";
    authUser.uid = "staff-two";
    coursesState.current = [];
    renderPage();
    await screen.findByText("아직 표시할 강의가 없습니다.");
    expect(whereMock).toHaveBeenCalledWith("userId", "==", "staff-two");
    expect(whereMock).toHaveBeenCalledWith("orgId", "==", "org-nodo");
    expect(whereMock).toHaveBeenCalledTimes(2);
    const callsBeforeInvite = requestApiMock.mock.calls.filter(([path]) => path === "/api/courses").length;
    coursesState.current = [{
      id: "invited-course",
      title: "방금 초대된 강의",
      status: "ACTIVE",
      activeRoomId: "invited-room",
      leadInstructorId: "staff-one",
      roomRole: "ASSISTANT",
    }];

    await act(async () => membershipListener.current?.());

    expect(await screen.findByText("방금 초대된 강의")).toBeInTheDocument();
    expect(requestApiMock.mock.calls.filter(([path]) => path === "/api/courses").length).toBeGreaterThan(callsBeforeInvite);
  });

  it("강의방 생성 버튼의 연속 클릭을 한 요청으로 합친다", async () => {
    let resolveCreation!: (value: unknown) => void;
    const creation = new Promise((resolve) => { resolveCreation = resolve; });
    requestApiMock.mockImplementation((path: string) => {
      if (path === "/api/courses") return Promise.resolve(coursesState.current);
      if (path === "/api/courses/draft-course/rooms") return creation;
      return Promise.resolve({});
    });
    renderPage();
    const createButton = await screen.findByRole("button", { name: "강의방 생성" });
    act(() => {
      createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(requestApiMock.mock.calls.filter(([path]) => path === "/api/courses/draft-course/rooms")).toHaveLength(1);
    await act(async () => resolveCreation({ room: { roomId: "new-room" } }));
  });
});
