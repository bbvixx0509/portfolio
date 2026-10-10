import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { commonHeaderContext } from "./CommonHeader";
import { CommonHeader } from "./CommonHeader";

const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
}));

vi.mock("../../features/auth/AuthContext", () => ({
  useAuth: () => ({
    profile: {
      displayName: "관리자",
      organizationRole: "ADMIN",
      photoURL: null,
    },
    logout: mocks.logout,
  }),
}));

describe("commonHeaderContext", () => {
  it("uses compact shared labels for the primary staff locations", () => {
    expect(commonHeaderContext("/courses/import")).toBe("기존 목록 불러오기");
    expect(commonHeaderContext("/create/material")).toBe("강의 자료 선택");
    expect(commonHeaderContext("/rooms")).toBe("강의방 목록");
    expect(commonHeaderContext("/organization/storage")).toBe("자료 용량 관리");
  });

  it("keeps live-room and student routes out of the page title", () => {
    expect(commonHeaderContext("/rooms/room-1/checklist")).toBe("강의 운영");
    expect(commonHeaderContext("/join/org-1/room-1/checklist")).toBe("학생 강의");
  });

  it("uses the shared image mark with NoDo alternative text", () => {
    render(<MemoryRouter initialEntries={["/courses/import"]}><CommonHeader /></MemoryRouter>);

    const logo = screen.getByAltText("NoDo");
    expect(logo).toHaveAttribute("src", expect.stringContaining("nodo-mark"));
    expect(screen.queryByText("NO")).not.toBeInTheDocument();
    expect(screen.queryByText("DO")).not.toBeInTheDocument();
  });
});
