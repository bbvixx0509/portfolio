import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestApiMock, navigateMock, authUser, profile } = vi.hoisted(() => ({
  requestApiMock: vi.fn(),
  navigateMock: vi.fn(),
  authUser: { uid: "lead-instructor" },
  profile: {
    uid: "lead-instructor",
    orgId: "org-nodo",
    accountType: "STAFF",
    organizationRole: "INSTRUCTOR",
    displayName: "김주강",
  },
}));

vi.mock("../../lib/api/apiClient", () => ({ requestApi: requestApiMock }));
vi.mock("../../lib/firebase/firebaseFirestore", () => ({
  getLocalFirebaseFirestore: () => ({}),
}));
vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: authUser,
    profile,
  }),
}));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn((_firestore, ...segments: string[]) => ({
    kind: "collection",
    path: segments.join("/"),
  })),
  doc: vi.fn((_firestore, ...segments: string[]) => ({
    kind: "doc",
    path: segments.join("/"),
  })),
  onSnapshot: vi.fn(
    (
      reference: { kind: string; path: string },
      next: (snapshot: unknown) => void,
    ) => {
      if (reference.path === "courses/draft-course") {
        next({
          id: "draft-course",
          exists: () => true,
          data: () => ({
            title: "준비 강의",
            status: "PREPARING",
            leadInstructorId: "lead-instructor",
            activeRoomId: null,
          }),
        });
      } else if (reference.kind === "collection") {
        next({ docs: [] });
      } else {
        next({ exists: () => false, data: () => ({}) });
      }
      return () => undefined;
    },
  ),
}));
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateMock };
});

import { LiveCourseFlowEditorPage } from "./LiveCourseFlowEditorPage";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/courses/draft-course/prepare"]}>
      <Routes>
        <Route
          path="/courses/:courseId/prepare"
          element={<LiveCourseFlowEditorPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LiveCourseFlowEditorPage 강의방 생성", () => {
  beforeEach(() => {
    requestApiMock.mockReset();
    navigateMock.mockReset();
  });

  it("연속 클릭은 한 요청으로 합치고 언마운트 뒤 성공 상태를 반영하지 않는다", async () => {
    let resolveRequest: (payload: Record<string, unknown>) => void = () =>
      undefined;
    const request = new Promise<Record<string, unknown>>((resolve) => {
      resolveRequest = resolve;
    });
    requestApiMock.mockReturnValue(request);
    const view = renderPage();
    const createButton = await screen.findByRole("button", {
      name: "강의방 생성",
    });

    act(() => {
      createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      createButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(requestApiMock).toHaveBeenCalledTimes(1);
    expect(requestApiMock).toHaveBeenCalledWith(
      "/api/courses/draft-course/rooms",
      expect.objectContaining({ method: "POST", body: {} }),
    );
    expect(
      screen.getByRole("button", { name: "강의방 생성 중" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "강의방 생성 중" }),
    ).toHaveAttribute("aria-busy", "true");

    view.unmount();
    await act(async () => {
      resolveRequest({ room: { roomId: "created-after-unmount" } });
      await request;
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
