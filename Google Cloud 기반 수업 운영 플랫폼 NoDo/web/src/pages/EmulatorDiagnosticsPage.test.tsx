import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runEmulatorDiagnostic,
  type EmulatorDiagnosticStepId,
} from "../lib/firebase/emulatorDiagnostic";
import { EmulatorDiagnosticsPage } from "./EmulatorDiagnosticsPage";

vi.mock("../lib/firebase/emulatorDiagnostic", () => ({
  runEmulatorDiagnostic: vi.fn(),
}));

const stepIds: EmulatorDiagnosticStepId[] = [
  "app",
  "authConnection",
  "firestoreConnection",
  "storageConnection",
  "anonymousAuth",
  "documentWrite",
  "documentRead",
  "documentDelete",
];

describe("EmulatorDiagnosticsPage", () => {
  beforeEach(() => {
    vi.mocked(runEmulatorDiagnostic).mockReset();
  });

  it("NoDo 01 로컬 전용 진단 정보와 성공 결과를 표시한다", async () => {
    vi.mocked(runEmulatorDiagnostic).mockImplementation(async (onStep) => {
      for (const id of stepIds) {
        onStep?.({ id, state: "success", message: `${id} 성공` });
      }

      return {
        projectId: "demo-nodo",
        uid: "anonymous-test-uid",
        cloudConnectionBlocked: true,
        completedAt: "2026-07-15T00:00:00.000Z",
      };
    });

    render(<EmulatorDiagnosticsPage />);

    expect(
      screen.getByText("NoDo 02 · 개발 전용"),
    ).toBeInTheDocument();
    expect(screen.getByText("demo-nodo")).toBeInTheDocument();
    expect(screen.getByText("실제 클라우드")).toBeInTheDocument();
    expect(
      await screen.findByText("모든 로컬 진단을 통과했습니다."),
    ).toBeInTheDocument();
    expect(screen.getByText(/anonymous-test-uid/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
  });

  it("진단 실패 원인을 개발 화면에 표시한다", async () => {
    vi.mocked(runEmulatorDiagnostic).mockRejectedValue(
      new Error("Authentication Emulator에 연결할 수 없습니다."),
    );

    render(<EmulatorDiagnosticsPage />);

    expect(
      await screen.findByText("진단에 실패했습니다."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Authentication Emulator에 연결할 수 없습니다."),
    ).toBeInTheDocument();
  });
});
