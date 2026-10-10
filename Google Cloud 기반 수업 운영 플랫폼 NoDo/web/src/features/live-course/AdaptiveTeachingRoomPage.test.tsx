import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  user: null as unknown,
  profile: null as unknown,
  error: null as string | null,
  isLoading: true,
  isRestoringSession: true,
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => authState,
}));

vi.mock("../demo-course/TeachingRoomPage", () => ({
  TeachingRoomPage: () => <div>NoDo_00 mock 강의 화면</div>,
}));

import { AdaptiveTeachingRoomPage } from "./AdaptiveTeachingRoomPage";

describe("AdaptiveTeachingRoomPage 인증 복원 분기", () => {
  it("인증 세션을 복원하는 동안 demo mock 화면을 표시하지 않는다", () => {
    render(<AdaptiveTeachingRoomPage view="CHAT" />);

    expect(screen.getByRole("status")).toHaveTextContent("인증 세션 확인 중");
    expect(screen.queryByText("NoDo_00 mock 강의 화면")).not.toBeInTheDocument();
  });
});
