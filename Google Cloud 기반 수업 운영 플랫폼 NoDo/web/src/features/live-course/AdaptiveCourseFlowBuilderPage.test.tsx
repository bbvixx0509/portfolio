import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { uid: "lead-instructor" },
    profile: {
      uid: "lead-instructor",
      orgId: "org-nodo",
      accountType: "STAFF",
      organizationRole: "INSTRUCTOR",
      displayName: "김민준",
    },
    error: null,
  }),
}));

vi.mock("./LiveCourseFlowEditorPage", () => ({
  LiveCourseFlowEditorPage: () => (
    <main>
      <h1>실제 수업 흐름 편집기</h1>
    </main>
  ),
}));

import { AdaptiveCourseFlowBuilderPage } from "./AdaptiveCourseFlowBuilderPage";

describe("AdaptiveCourseFlowBuilderPage 인증 경로", () => {
  it("로그인한 주 강사가 /courses/demo-course/prepare에서 실제 편집기를 연다", async () => {
    render(
      <MemoryRouter initialEntries={["/courses/demo-course/prepare"]}>
        <Routes>
          <Route
            path="/courses/:courseId/prepare"
            element={<AdaptiveCourseFlowBuilderPage />}
          />
          <Route path="*" element={<h1>404</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "실제 수업 흐름 편집기" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "404" })).not.toBeInTheDocument();
  });
});
