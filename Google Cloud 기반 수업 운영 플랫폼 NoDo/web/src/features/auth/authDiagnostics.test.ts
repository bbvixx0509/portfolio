import { describe, expect, it } from "vitest";
import {
  createAuthDiagnostics,
  isAuthDiagnosticsEnabled,
  updateAuthDiagnostic,
} from "./authDiagnostics";

describe("Google 로그인 진단 설정", () => {
  it("개발 cloud-auth의 authDebug=1에서만 진단을 활성화한다", () => {
    expect(isAuthDiagnosticsEnabled({
      development: true,
      runtimeMode: "cloud-auth",
      search: "?authDebug=1",
    })).toBe(true);
    expect(isAuthDiagnosticsEnabled({
      development: false,
      runtimeMode: "cloud-auth",
      search: "?authDebug=1",
    })).toBe(false);
    expect(isAuthDiagnosticsEnabled({
      development: true,
      runtimeMode: "emulator",
      search: "?authDebug=1",
    })).toBe(false);
  });

  it("안전한 상태만 유지하고 계정 식별자는 포함하지 않는다", () => {
    const diagnostics = updateAuthDiagnostic(
      createAuthDiagnostics({
        enabled: true,
        hostname: "localhost",
        firebaseConfig: {
          apiKey: "not-rendered",
          authDomain: "example-gcp-project.firebaseapp.com",
          projectId: "example-gcp-project",
        },
      }),
      "profile-response",
      "failure",
      "HTTP 403",
    );

    expect(diagnostics.steps).toHaveLength(15);
    expect(JSON.stringify(diagnostics)).toContain("HTTP 403");
    expect(JSON.stringify(diagnostics)).not.toContain("not-rendered");
    expect(JSON.stringify(diagnostics)).not.toContain("firebaseapp.com");
  });
});
