import { describe, expect, it } from "vitest";
import { resolveRuntimeMode } from "./runtimeMode";

describe("NoDo 실행 모드", () => {
  it("설정이 없으면 기존 Emulator 모드를 기본값으로 사용한다", () => {
    expect(resolveRuntimeMode(undefined)).toBe("emulator");
    expect(resolveRuntimeMode("")).toBe("emulator");
  });

  it("cloud-auth를 명시한 경우에만 실제 Google 인증 모드를 사용한다", () => {
    expect(resolveRuntimeMode("cloud-auth")).toBe("cloud-auth");
  });

  it("알 수 없는 실행 모드는 앱 시작 전에 차단한다", () => {
    expect(() => resolveRuntimeMode("production")).toThrow(/emulator 또는 cloud-auth/);
  });
});

