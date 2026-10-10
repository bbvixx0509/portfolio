import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LocalRealCloudBadge } from "./LocalRealCloudBadge";

describe("LocalRealCloudBadge", () => {
  it("실제 Cloud 개발 모드에서만 식별 문구를 표시한다", () => {
    const { rerender } = render(<LocalRealCloudBadge visible />);
    expect(screen.getByRole("status")).toHaveTextContent("LOCAL · REAL NODO CLOUD");

    rerender(<LocalRealCloudBadge visible={false} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
