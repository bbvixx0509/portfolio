import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPermissions } from "../auth/authTypes";
import type { LiveQuestion } from "./liveCourseTypes";

const { authMock, liveMock, questionMock, requestApiMock } = vi.hoisted(() => {
  const emptyPermissions = {
    canEditCourse: false,
    canEditCourseFlow: false,
    canManageMaterials: false,
    canShareRoom: false,
    canControlProgress: false,
    canAnswerQuestions: false,
    canModerateQuestions: false,
    canAnnotate: false,
    canManageParticipants: false,
    canEndRoom: false,
    canViewReports: false,
    canExportResults: false,
  };
  return {
    authMock: {
      profile: { uid: "assistant-limited", orgId: "org-nodo", accountType: "STAFF", organizationRole: "INSTRUCTOR", displayName: "이보조", email: "assistant.limited@nodo.test", nickname: null },
      user: { uid: "assistant-limited" },
      updateNickname: vi.fn(),
    },
    liveMock: {
    room: {
      id: "demo-room",
      orgId: "org-nodo",
      courseId: "demo-course",
      title: "생성형 AI 실습",
      leadInstructorId: "lead-instructor",
      status: "ACTIVE",
      joinCode: "NODO01",
      currentItemId: "item-current",
      itemOrder: ["item-done", "item-current", "item-future"],
    },
    courseTitle: "생성형 AI 실습",
    chapters: [{ id: "chapter-one", title: "첫 챕터", order: 0 }],
    items: [
      { id: "item-done", chapterId: "chapter-one", title: "완료 항목", description: "", materialLabel: "완료", kind: "SLIDE", order: 0, isCompleted: true },
      { id: "item-current", chapterId: "chapter-one", title: "현재 항목", description: "", materialLabel: "현재", kind: "SLIDE", order: 1, isCompleted: false },
      { id: "item-future", chapterId: "chapter-one", title: "미래 항목", description: "", materialLabel: "미래", kind: "SLIDE", order: 2, isCompleted: false },
    ],
    permissions: { ...emptyPermissions, canControlProgress: true },
    permissionUpdatedAt: "2026-07-15T00:00:00.000Z",
    isLead: false,
    roomRole: "ASSISTANT" as const,
    isLoading: false,
    error: null,
  },
    questionMock: {
      questions: [] as LiveQuestion[],
      readWatermarkByContext: {},
      isQuestionRestricted: false,
      isLoading: false,
      error: null,
    },
    requestApiMock: vi.fn(),
  };
});

vi.mock("./useLiveRoom", () => ({ useLiveRoom: () => liveMock }));
vi.mock("./useLiveQuestions", async (importOriginal) => {
  const original = await importOriginal<typeof import("./useLiveQuestions")>();
  return { ...original, useLiveQuestions: () => questionMock };
});
vi.mock("../../lib/api/apiClient", () => ({ requestApi: requestApiMock }));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => authMock,
}));

import { LiveTeachingRoomPage } from "./LiveTeachingRoomPage";

function renderPage(view: "CHECKLIST" | "CHAT" = "CHECKLIST") {
  return render(
    <MemoryRouter initialEntries={[`/rooms/demo-room/${view.toLowerCase()}`]}>
      <Routes><Route path="/rooms/:roomId/:view" element={<LiveTeachingRoomPage view={view} />} /></Routes>
    </MemoryRouter>,
  );
}

describe("LiveTeachingRoomPage 권한 게이트", () => {
  beforeEach(() => {
    requestApiMock.mockReset().mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/share")
          ? { joinCode: "NODO01", joinPath: "/join/NODO01" }
          : path.endsWith("/end-preview")
            ? {
                roomId: "demo-room",
                unansweredQuestionCount: 1,
                incompleteChecklistCount: 2,
              }
          : {},
      ),
    );
    liveMock.permissions = { ...createEmptyPermissions(), canControlProgress: true };
    liveMock.room.status = "ACTIVE";
    questionMock.questions = [];
    questionMock.readWatermarkByContext = {};
    questionMock.isQuestionRestricted = false;
    questionMock.isLoading = false;
    questionMock.error = null;
  });

  it("ACTIVE 강의와 현재 역할을 표시하고 현재·완료 항목만 체크할 수 있다", () => {
    renderPage();
    expect(screen.getByText("● 진행 중")).toBeInTheDocument();
    expect(screen.getByText("보조 강사")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "1.1 완료 항목 완료" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "1.2 현재 항목 완료" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "1.3 미래 항목 완료" })).toBeDisabled();
  });

  it("세부 권한이 없는 기능은 숨기고 진행 권한 회수는 즉시 읽기 전용으로 반영한다", () => {
    const rendered = renderPage();
    expect(screen.queryByRole("link", { name: /수업 흐름 편집/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "자료 관리" })).not.toBeInTheDocument();
    expect(screen.queryByText("NODO01")).not.toBeInTheDocument();

    liveMock.permissions = createEmptyPermissions();
    rendered.rerender(
      <MemoryRouter initialEntries={["/rooms/demo-room/checklist"]}>
        <Routes><Route path="/rooms/:roomId/:view" element={<LiveTeachingRoomPage view="CHECKLIST" />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/진행 제어 권한이 없어 읽기 전용/)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").every((input) => (input as HTMLInputElement).disabled)).toBe(true);
  });

  it("편집·자료·공유 권한이 있으면 연결된 기능만 표시한다", async () => {
    liveMock.permissions = {
      ...createEmptyPermissions(),
      canEditCourseFlow: true,
      canManageMaterials: true,
      canShareRoom: true,
    };
    renderPage();

    expect(screen.getByRole("link", { name: /수업 흐름 편집/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "자료 관리" })).toBeInTheDocument();
    expect(await screen.findByText("NODO01")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").every((input) => (input as HTMLInputElement).disabled)).toBe(true);
  });

  it("Firestore 실시간 질문을 표시하고 mock 안내를 남기지 않는다", () => {
    questionMock.questions = [{
      id: "question-one", roomId: "demo-room", courseId: "demo-course", orgId: "org-nodo",
      content: "실시간으로 연결된 질문", nicknameSnapshot: "궁금한 수달", isGeneral: true,
      itemId: null, itemNumberSnapshot: null, itemTitleSnapshot: null, chapterTitleSnapshot: null, materialLabelSnapshot: null,
      visibility: "PUBLIC", moderationStatus: "APPROVED", isAnswered: false, answer: null,
      isHidden: false, createdAt: "2026-07-15T00:00:00.000Z", updatedAt: null,
      createdAtMillis: Date.parse("2026-07-15T00:00:00.000Z"), schemaVersion: 1,
    }];
    renderPage("CHAT");
    expect(screen.getByText("실시간으로 연결된 질문")).toBeInTheDocument();
    expect(screen.queryByText(/MOCK CHAT/)).not.toBeInTheDocument();
  });

  it("답변·숨김 권한에 따라 중요 쓰기를 FastAPI로 보낸다", async () => {
    liveMock.permissions = { ...createEmptyPermissions(), canAnswerQuestions: true, canModerateQuestions: true };
    questionMock.questions = [{
      id: "question-one", roomId: "demo-room", courseId: "demo-course", orgId: "org-nodo",
      content: "답변이 필요한 질문", nicknameSnapshot: "차분한 판다", isGeneral: false,
      itemId: "item-current", itemNumberSnapshot: "1.2", itemTitleSnapshot: "현재 항목", chapterTitleSnapshot: "첫 챕터", materialLabelSnapshot: "현재",
      visibility: "PUBLIC", moderationStatus: "APPROVED", isAnswered: false, answer: null,
      isHidden: false, createdAt: "2026-07-15T00:00:00.000Z", updatedAt: null,
      createdAtMillis: Date.parse("2026-07-15T00:00:00.000Z"), schemaVersion: 1,
    }];
    renderPage("CHAT");
    fireEvent.change(screen.getByRole("textbox", { name: "차분한 판다 질문 답변" }), { target: { value: "강사 답변입니다." } });
    fireEvent.click(screen.getByRole("button", { name: "답변 등록" }));
    await waitFor(() => expect(requestApiMock).toHaveBeenCalledWith(
      "/api/rooms/demo-room/questions/question-one/answer",
      expect.objectContaining({ method: "PUT", body: { answer: "강사 답변입니다." } }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "질문 숨김" }));
    await waitFor(() => expect(requestApiMock).toHaveBeenCalledWith(
      "/api/rooms/demo-room/questions/question-one/hide",
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("종료 후 체크·질문 관리를 읽기 전용으로 바꾼다", () => {
    liveMock.room.status = "ENDED";
    liveMock.permissions = { ...createEmptyPermissions(), canControlProgress: true, canAnswerQuestions: true, canModerateQuestions: true };
    renderPage("CHAT");
    expect(screen.getByText(/질문과 답변은 읽기 전용/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "강의 종료" })).not.toBeInTheDocument();
  });

  it("로드맵 질문 배지가 해당 항목 필터 URL과 전체·미확인 수를 제공한다", () => {
    questionMock.questions = [{
      id: "question-current", roomId: "demo-room", courseId: "demo-course", orgId: "org-nodo",
      content: "현재 항목 질문", nicknameSnapshot: "익명 수달", isGeneral: false,
      itemId: "item-current", itemNumberSnapshot: "1.2", itemTitleSnapshot: "현재 항목", chapterTitleSnapshot: "첫 챕터", materialLabelSnapshot: "현재",
      visibility: "PUBLIC", moderationStatus: "APPROVED", isAnswered: false, answer: null,
      isHidden: false, createdAt: "2026-07-15T00:00:00.000Z", updatedAt: null,
      createdAtMillis: Date.parse("2026-07-15T00:00:00.000Z"), schemaVersion: 1,
    }];
    renderPage();
    const link = screen.getByRole("link", { name: /1\.2 현재 항목 질문 1개, 미확인 1개/ });
    expect(link).toHaveAttribute("href", "/rooms/demo-room/chat?itemId=item-current");
  });

  it("강의 종료 확인창에 미답변·미완료 수와 차단 안내를 표시하고 FastAPI로 종료한다", async () => {
    liveMock.permissions = { ...createEmptyPermissions(), canEndRoom: true };
    questionMock.questions = [{
      id: "unanswered", roomId: "demo-room", courseId: "demo-course", orgId: "org-nodo",
      content: "미답변 질문", nicknameSnapshot: "익명 수달", isGeneral: true,
      itemId: null, itemNumberSnapshot: null, itemTitleSnapshot: null, chapterTitleSnapshot: null, materialLabelSnapshot: null,
      visibility: "PUBLIC", moderationStatus: "APPROVED", isAnswered: false, answer: null,
      isHidden: true, createdAt: "2026-07-15T00:00:00.000Z", updatedAt: null,
      createdAtMillis: Date.parse("2026-07-15T00:00:00.000Z"), schemaVersion: 1,
    }];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "강의 종료" }));
    const dialog = screen.getByRole("dialog", { name: "정말 강의를 종료할까요?" });
    expect(dialog).toHaveTextContent("전체 질문과 로드맵 현황을 확인하는 중");
    await waitFor(() => expect(dialog).toHaveTextContent("1미답변 질문"));
    expect(dialog).toHaveTextContent("2미완료 로드맵");
    expect(dialog).toHaveTextContent("새 참여·질문·로드맵 변경이 차단");
    expect(requestApiMock).toHaveBeenCalledWith(
      "/api/rooms/demo-room/end-preview",
      expect.objectContaining({ authUser: authMock.user }),
    );
    fireEvent.click(screen.getByRole("button", { name: "강의 종료 확인" }));
    await waitFor(() => expect(requestApiMock).toHaveBeenCalledWith(
      "/api/rooms/demo-room/end",
      expect.objectContaining({ method: "POST", body: {} }),
    ));
  });
});
