import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { profileState } = vi.hoisted(() => ({
  profileState: {
    uid: "staff-two",
    orgId: "org-nodo",
    accountType: "STAFF" as "STAFF" | "STUDENT",
    organizationRole: "INSTRUCTOR" as const,
    displayName: "동료 직원",
  },
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { uid: profileState.uid },
    profile: profileState,
    error: null,
    isRestoringSession: false,
  }),
}));

import { AdaptiveNewCoursePage } from "./AdaptiveNewCoursePage";

describe("AdaptiveNewCoursePage 직원 생성 권한", () => {
  beforeEach(() => {
    profileState.accountType = "STAFF";
    profileState.organizationRole = "INSTRUCTOR";
  });

  it("전역 주 강사 역할 없이 모든 직원에게 강의 생성 양식을 제공한다", () => {
    render(<MemoryRouter><AdaptiveNewCoursePage source="manual" /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: /강의 만들기/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /강의 생성 후 편집/ })).toBeInTheDocument();
  });

  it("수강생 계정에는 강의 생성 양식을 제공하지 않는다", () => {
    profileState.accountType = "STUDENT";
    render(<MemoryRouter><AdaptiveNewCoursePage source="manual" /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "새 강의를 만들 수 없습니다" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /강의 생성 후 편집/ })).not.toBeInTheDocument();
  });
});
