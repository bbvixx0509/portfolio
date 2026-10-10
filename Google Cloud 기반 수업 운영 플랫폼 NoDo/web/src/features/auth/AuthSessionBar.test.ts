import { describe, expect, it } from "vitest";
import { shouldHideAuthSessionBar } from "./AuthSessionBar";

describe("AuthSessionBar 표시 경계", () => {
  it("학생 참여 경로에서는 두 모드 모두 전역 로그인 UI를 숨긴다", () => {
    expect(shouldHideAuthSessionBar("cloud-auth", "/join/ROOM01")).toBe(true);
    expect(shouldHideAuthSessionBar("emulator", "/join/ROOM01")).toBe(true);
  });

  it("두 모드의 강의 화면에서는 헤더 계정 UI와 중복되지 않게 숨긴다", () => {
    expect(shouldHideAuthSessionBar("emulator", "/join/ROOM01")).toBe(true);
    expect(shouldHideAuthSessionBar("emulator", "/rooms/demo/chat")).toBe(true);
    expect(shouldHideAuthSessionBar("cloud-auth", "/rooms/room-1/checklist")).toBe(true);
  });

  it("로그인 화면에서는 두 모드 모두 숨긴다", () => {
    expect(shouldHideAuthSessionBar("emulator", "/login")).toBe(true);
    expect(shouldHideAuthSessionBar("cloud-auth", "/login")).toBe(true);
    expect(shouldHideAuthSessionBar("cloud-auth", "/join-organization")).toBe(true);
  });

  it("cloud-auth 시작 화면에서는 v2 상단 계정 영역과 중복되지 않게 숨긴다", () => {
    expect(shouldHideAuthSessionBar("cloud-auth", "/")).toBe(true);
    expect(shouldHideAuthSessionBar("emulator", "/")).toBe(false);
  });
});
