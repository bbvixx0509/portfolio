import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestApiMock, authUser, authProfile } = vi.hoisted(() => ({
  requestApiMock: vi.fn(),
  authUser: { uid: "lead-instructor" },
  authProfile: {
    uid: "lead-instructor",
    orgId: "org-nodo",
    accountType: "STAFF",
    organizationRole: "INSTRUCTOR",
    displayName: "김주강",
    email: "lead@nodo.test",
  },
}));

vi.mock("../lib/api/apiClient", () => ({ requestApi: requestApiMock }));
vi.mock("../lib/firebase/firebaseFirestore", () => ({
  getLocalFirebaseFirestore: () => ({}),
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(() => ({})),
  onSnapshot: vi.fn(() => () => undefined),
}));
vi.mock("../features/auth/AuthContext", () => ({
  useAuth: () => ({
    profile: authProfile,
    user: authUser,
    isLoading: false,
  }),
}));

import { RoomStaffPage } from "./RoomStaffPage";

const staffResponse = {
  lead: {
    userId: "lead-instructor",
    displayName: "김주강",
    email: "lead@nodo.test",
  },
  staff: [
    {
      userId: "assistant-none",
      displayName: "박보조",
      email: "assistant.none@nodo.test",
      permissions: { canAnswerQuestions: true },
      updatedBy: "lead-instructor",
    },
  ],
  availableInstructors: [
    {
      userId: "staff-candidate",
      displayName: "최동료",
      email: "coworker@nodo.test",
    },
  ],
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/rooms/demo-room/staff"]}>
      <Routes>
        <Route path="/rooms/:roomId/staff" element={<RoomStaffPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RoomStaffPage", () => {
  beforeEach(() => {
    requestApiMock.mockReset();
    requestApiMock.mockResolvedValue(staffResponse);
  });

  it("12개 위임 권한만 표시하고 주 강사·소유권 권한은 표시하지 않는다", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "보조 강사 권한 관리" })).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "추가 권한 설정" }));
    const permissionToggles = screen.getAllByRole<HTMLInputElement>("checkbox");
    expect(permissionToggles).toHaveLength(12);
    expect(screen.getByRole("checkbox", { name: "질문 답변" })).toBeChecked();
    expect(permissionToggles.filter((toggle) => toggle.checked)).toHaveLength(1);
    expect(screen.getAllByText("권한만 저장 · 후속 단계")).toHaveLength(2);
    expect(screen.queryByText(/주 강사 변경|소유권 이전|다른 보조 강사 초대/)).not.toBeInTheDocument();
    expect(screen.getByText("미저장 변경과 서버에 저장된 권한을 구분해서 표시합니다.")).toBeInTheDocument();
  });

  it("전체 선택 후 12개 boolean을 FastAPI 저장 요청으로 보낸다", async () => {
    renderPage();
    await screen.findByText("박보조");
    fireEvent.click(screen.getByRole("button", { name: "추가 권한 설정" }));
    fireEvent.click(screen.getByRole("button", { name: "전체 권한 선택" }));

    expect(screen.getAllByRole<HTMLInputElement>("checkbox").every((input) => input.checked)).toBe(true);
    expect(screen.getByText("저장 전")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() =>
      expect(requestApiMock).toHaveBeenCalledWith(
        "/api/rooms/demo-room/staff/assistant-none/permissions",
        expect.objectContaining({
          method: "PUT",
          body: {
            permissions: expect.objectContaining({
              canEditCourse: true,
              canEditCourseFlow: true,
              canManageMaterials: true,
              canShareRoom: true,
              canControlProgress: true,
              canAnswerQuestions: true,
              canModerateQuestions: true,
              canAnnotate: true,
              canManageParticipants: true,
              canEndRoom: true,
              canViewReports: true,
              canExportResults: true,
            }),
          },
        }),
      ),
    );
  });

  it("단일·복수 선택과 전체 해제를 미저장 상태로 구분한다", async () => {
    renderPage();
    await screen.findByText("박보조");
    fireEvent.click(screen.getByRole("button", { name: "추가 권한 설정" }));
    const checkboxes = screen.getAllByRole<HTMLInputElement>("checkbox");
    expect(checkboxes.filter((input) => input.checked)).toHaveLength(1);

    fireEvent.click(checkboxes[0]);
    expect(checkboxes.filter((input) => input.checked)).toHaveLength(2);
    fireEvent.click(checkboxes[1]);
    expect(checkboxes.filter((input) => input.checked)).toHaveLength(3);
    expect(screen.getByText("저장 전")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "전체 권한 선택" }));
    expect(checkboxes.every((input) => input.checked)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "전체 권한 해제" }));
    expect(checkboxes.every((input) => !input.checked)).toBe(true);
  });

  it("같은 조직 직원을 권한 payload 없이 서버 기본 권한으로 초대한다", async () => {
    renderPage();
    await screen.findByText("최동료 · coworker@nodo.test");
    expect(screen.getByText("기본 권한: 강의 조회 및 질문 답변")).toBeInTheDocument();
    expect(screen.getByText("추가 권한은 초대 후 설정할 수 있습니다.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "초대할 직원" }), {
      target: { value: "staff-candidate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "보조 강사 초대" }));
    await waitFor(() => expect(requestApiMock).toHaveBeenCalledWith(
      "/api/rooms/demo-room/staff",
      expect.objectContaining({
        method: "POST",
        body: { userId: "staff-candidate" },
      }),
    ));
    const inviteCall = requestApiMock.mock.calls.find(
      ([path, options]) => path === "/api/rooms/demo-room/staff" && options?.method === "POST",
    );
    expect(inviteCall?.[1].body).not.toHaveProperty("permissions");
  });
});
