import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  profile: null as null | Record<string, unknown>,
  organizationInvitation: null as null | Record<string, unknown>,
  studentSession: null as null | Record<string, unknown>,
  identityKind: "signed-out" as "loading" | "signed-out" | "staff" | "invited-staff" | "student" | "unsupported",
  isLoading: false,
  isBootstrappingOrganization: false,
  isRestoringSession: false,
  error: null,
  runtimeMode: "cloud-auth",
  startStudentSession: vi.fn(),
  endStudentSession: vi.fn(),
  logout: vi.fn(),
  loginWithGoogle: vi.fn(),
  acceptOrganizationInvitation: vi.fn(),
}));

vi.mock("../config/runtimeMode", () => ({
  isCloudAuthMode: true,
  runtimeMode: "cloud-auth",
}));
vi.mock("../features/auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => authState,
}));
vi.mock("../pages/OrganizationMembersPage", () => ({
  OrganizationMembersPage: () => <h1>DEMO 구성원 관리</h1>,
}));
vi.mock("../pages/OrganizationJoinPage", () => ({
  OrganizationJoinPage: () => <h1>DEMO 조직 가입</h1>,
}));
vi.mock("../pages/OrganizationInvitationActionPage", () => ({
  OrganizationInvitationActionPage: ({ action }: { action: "accept" | "decline" }) => (
    <h1>{action === "accept" ? "조직 초대 수락" : "조직 초대 거절"}</h1>
  ),
  OrganizationInvitationDeclinedPage: () => <h1>초대를 거절했습니다</h1>,
}));
vi.mock("../features/cloud-rooms/CloudRoomPages", () => ({
  CloudRoomCreatePage: () => <h1>새 수업 열기</h1>,
  CloudRoomListPage: () => <h1>강의방 목록</h1>,
  CloudRoomPreparePage: () => <h1>강의방 준비</h1>,
}));
vi.mock("../features/cloud-students/CloudStudentEntryPage", () => ({
  CloudStudentEntryPage: () => <h1>학생 입장</h1>,
}));
vi.mock("../features/cloud-students/CloudStudentChecklistPage", () => ({
  CloudStudentChecklistPage: () => <h1>학생 통합 강의방</h1>,
}));
vi.mock("../features/cloud-questions/CloudStudentQuestionsPage", () => ({
  CloudStudentQuestionsPage: () => <h1>학생 채팅</h1>,
}));

import { AppRoutes } from "./AppRoutes";

function renderRoutes(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function signInAs(role: "ADMIN" | "INSTRUCTOR") {
  authState.user = { uid: `masked-${role.toLowerCase()}`, isAnonymous: false };
  authState.profile = {
    uid: `masked-${role.toLowerCase()}`,
    orgId: "demo",
    accountType: "STAFF",
    displayName: role === "ADMIN" ? "테스트 관리자" : "테스트 강사",
    email: "hidden@nodo-company.test",
    authorized: true,
    organizationRole: role,
    isAdmin: role === "ADMIN",
  };
  authState.identityKind = "staff";
}

describe("cloud-auth 02-3·02-7·02-8 경로 경계", () => {
  beforeEach(() => {
    sessionStorage.clear();
    authState.user = null;
    authState.profile = null;
    authState.organizationInvitation = null;
    authState.studentSession = null;
    authState.identityKind = "signed-out";
    authState.isLoading = false;
    authState.isBootstrappingOrganization = false;
    authState.startStudentSession.mockReset();
    authState.endStudentSession.mockReset().mockResolvedValue(undefined);
    authState.logout.mockReset().mockResolvedValue(undefined);
    authState.acceptOrganizationInvitation.mockReset();
  });

  it("/join/:roomCode는 직원 로그인 없이 학생 참여 화면을 표시한다", () => {
    renderRoutes("/join/TEST123");
    expect(screen.getByRole("heading", { name: "강의에 참여할 이름을 확인해 주세요" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "참여하기" })).toBeInTheDocument();
    expect(screen.queryByText(/Google 인증이 완료되었습니다/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /직원 로그인/ })).not.toBeInTheDocument();
  });

  it("학생 통합 로드맵·채팅 경로와 기존 questions 호환 redirect를 유지한다", async () => {
    const checklist = renderRoutes("/join/demo/ABCDEFGH/checklist");
    expect(screen.getByRole("heading", { name: "학생 통합 강의방" })).toBeInTheDocument();
    checklist.unmount();

    const chat = renderRoutes("/join/demo/ABCDEFGH/chat");
    expect(screen.getByRole("heading", { name: "학생 통합 강의방" })).toBeInTheDocument();
    chat.unmount();

    renderRoutes("/join/demo/ABCDEFGH/questions");
    expect(await screen.findByRole("heading", { name: "학생 통합 강의방" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/join/demo/ABCDEFGH/chat");
  });

  it("미인증 사용자는 /에서 Google 로그인으로 이동한다", async () => {
    renderRoutes("/");

    expect(await screen.findByRole("heading", { name: "Google 로그인" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });

  it("ADMIN은 실제 프로필 기반 v2 시작 화면과 구성원 관리 진입을 본다", () => {
    signInAs("ADMIN");
    renderRoutes("/");

    expect(screen.getByRole("heading", { name: /오늘 강의할 로드맵/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "현재 사용자: 테스트 관리자, 관리자" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "조직 구성원 관리" })).toHaveAttribute("href", "/organization/members");
    expect(screen.getByRole("button", { name: "로그아웃" })).toBeInTheDocument();
    expect(screen.queryByText("hidden@nodo-company.test")).not.toBeInTheDocument();
    expect(screen.queryByText(/Google 인증이 완료되었습니다/)).not.toBeInTheDocument();
  });

  it("INSTRUCTOR는 v2 시작 화면을 보지만 구성원 관리 진입은 보지 않는다", () => {
    signInAs("INSTRUCTOR");
    renderRoutes("/");

    expect(screen.getByRole("group", { name: "현재 사용자: 테스트 강사, 일반 강사" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "조직 구성원 관리" })).not.toBeInTheDocument();
  });

  it("시작 카드 세 개가 각 강의 생성 경로로 이동한다", async () => {
    signInAs("ADMIN");

    const cases = [
      ["자료 올리기", "/create/material"],
      ["항목 입력하기", "/create/manual"],
      ["전체 목록 보기", "/courses/import"],
    ] as const;

    for (const [label, path] of cases) {
      const view = renderRoutes("/");
      fireEvent.click(screen.getByRole("link", { name: label }));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(path));
      view.unmount();
    }
  });

  it("로그인한 STAFF가 /login에 오면 시작 화면으로 이동한다", async () => {
    signInAs("INSTRUCTOR");
    renderRoutes("/login");

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/"));
    expect(screen.getByRole("heading", { name: /오늘 강의할 로드맵/ })).toBeInTheDocument();
  });

  it("안전한 보호 경로는 로그인 뒤 복귀 대상으로 유지한다", async () => {
    sessionStorage.setItem("nodo.cloud-auth.return-to", "/create/material?from=start");
    signInAs("ADMIN");
    renderRoutes("/login");

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/create/material?from=start"));
  });

  it("외부 복귀 경로는 /로 정규화한다", async () => {
    sessionStorage.setItem("nodo.cloud-auth.return-to", "https://unsafe.example");
    signInAs("ADMIN");
    renderRoutes("/login");

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/"));
  });

  it("시작 화면 로그아웃은 로그인 화면으로 이동한다", async () => {
    signInAs("ADMIN");
    authState.logout.mockImplementation(async () => {
      authState.user = null;
      authState.profile = null;
      authState.identityKind = "signed-out";
    });
    renderRoutes("/");

    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await waitFor(() => expect(authState.logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
  });

  it("학생은 기존 강사 경로에서 보호 화면 내용을 볼 수 없다", () => {
    authState.user = { uid: "masked-student", isAnonymous: true };
    authState.identityKind = "student";
    renderRoutes("/courses/import");
    expect(screen.getByRole("heading", { name: "권한이 없습니다" })).toBeInTheDocument();
    expect(screen.queryByText(/Google 인증이 완료되었습니다/)).not.toBeInTheDocument();
  });

  it("검증된 일반 STAFF도 /create/material에서 자료 선택 화면을 본다", async () => {
    authState.user = { uid: "masked-staff", isAnonymous: false };
    authState.profile = {
      uid: "masked-staff",
      orgId: "demo",
      accountType: "STAFF",
      displayName: "테스트 강사",
      email: "masked@example.invalid",
      authorized: true,
      organizationRole: "INSTRUCTOR",
      isAdmin: false,
    };
    authState.identityKind = "staff";

    renderRoutes("/create/material");

    expect(await screen.findByRole("heading", { name: "강의 자료 선택" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "파일 선택하기" })).toBeInTheDocument();
  });

  it("관리자만 /organization/members 내용을 볼 수 있다", async () => {
    authState.user = { uid: "masked-admin", isAnonymous: false };
    authState.profile = {
      uid: "masked-admin",
      orgId: "demo",
      accountType: "STAFF",
      displayName: "테스트 관리자",
      email: "masked@example.invalid",
      authorized: true,
      organizationRole: "ADMIN",
      isAdmin: true,
    };
    authState.identityKind = "staff";
    renderRoutes("/organization/members");
    expect(await screen.findByRole("heading", { name: "DEMO 구성원 관리" })).toBeInTheDocument();
  });

  it("초대 토큰 수락·거절 경로는 STAFF 권한 전에도 공개 화면을 렌더링한다", async () => {
    const accept = renderRoutes("/organization/invitations/sensitive-token/accept");
    expect(await screen.findByRole("heading", { name: "조직 초대 수락" })).toBeInTheDocument();
    accept.unmount();

    renderRoutes("/organization/invitations/sensitive-token/decline");
    expect(await screen.findByRole("heading", { name: "조직 초대 거절" })).toBeInTheDocument();
  });

  it("토큰 없는 초대 거절 완료 경로를 공개 화면으로 렌더링한다", async () => {
    renderRoutes("/organization/invitations/declined");
    expect(await screen.findByRole("heading", { name: "초대를 거절했습니다" })).toBeInTheDocument();
  });

  it("일반 STAFF는 /organization/members에서 소유자 전용 안내만 본다", () => {
    authState.user = { uid: "masked-staff", isAnonymous: false };
    authState.profile = {
      uid: "masked-staff",
      orgId: "demo",
      accountType: "STAFF",
      authorized: true,
      organizationRole: "INSTRUCTOR",
      isAdmin: false,
    };
    authState.identityKind = "staff";
    renderRoutes("/organization/members");
    expect(screen.getByRole("heading", { name: "조직 관리 권한이 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "DEMO 구성원 관리" })).not.toBeInTheDocument();
  });

  it("미로그인 사용자는 /organization/members에서 로그인 화면으로 이동한다", async () => {
    renderRoutes("/organization/members");
    expect(await screen.findByRole("heading", { name: "Google 로그인" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "DEMO 구성원 관리" })).not.toBeInTheDocument();
  });

  it("Anonymous 학생은 /organization/members 내용을 볼 수 없다", () => {
    authState.user = { uid: "masked-student", isAnonymous: true };
    authState.identityKind = "student";
    renderRoutes("/organization/members");
    expect(screen.getByRole("heading", { name: "권한이 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "DEMO 구성원 관리" })).not.toBeInTheDocument();
  });

  it("초대 대기 STAFF는 기존 보호 경로 대신 조직 가입 화면으로 이동한다", async () => {
    authState.user = { uid: "masked-invited", isAnonymous: false };
    authState.organizationInvitation = {
      organizationName: "DEMO",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    authState.identityKind = "invited-staff";
    renderRoutes("/create/material");
    expect(await screen.findByRole("heading", { name: "DEMO 조직 가입" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "강의 자료 선택" })).not.toBeInTheDocument();
  });

  it("미인증 사용자는 /create/material에서 로그인으로 이동하고 복귀 경로를 기억한다", async () => {
    renderRoutes("/create/material");

    expect(
      await screen.findByRole("heading", { name: "Google 로그인" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "강의 자료 선택" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(sessionStorage.getItem("nodo.cloud-auth.return-to")).toBe(
        "/create/material",
      ),
    );
  });

  it("Anonymous 학생은 /create/material 자료 선택 화면을 볼 수 없다", () => {
    authState.user = { uid: "masked-student", isAnonymous: true };
    authState.identityKind = "student";

    renderRoutes("/create/material");

    expect(screen.getByRole("heading", { name: "권한이 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "강의 자료 선택" })).not.toBeInTheDocument();
  });

  it("ADMIN과 INSTRUCTOR만 새 강의방 화면에 접근하고 학생은 차단된다", () => {
    signInAs("ADMIN");
    const admin = renderRoutes("/rooms");
    expect(screen.getByRole("heading", { name: "강의방 목록" })).toBeInTheDocument();
    admin.unmount();

    signInAs("INSTRUCTOR");
    const instructor = renderRoutes("/rooms");
    expect(screen.getByRole("heading", { name: "강의방 목록" })).toBeInTheDocument();
    instructor.unmount();

    authState.user = { uid: "masked-student", isAnonymous: true };
    authState.profile = null;
    authState.identityKind = "student";
    renderRoutes("/rooms/room-1/prepare");
    expect(screen.getByRole("heading", { name: "권한이 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "강의방 준비" })).not.toBeInTheDocument();
  });
});
