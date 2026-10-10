import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCloudReturnPath,
  readCloudReturnPath,
  rememberCloudReturnPath,
  safeCloudReturnPath,
} from "./cloudAuthNavigation";

describe("cloud-auth 원래 경로 복원", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("보호 경로와 query/hash를 같은 탭에서 복원한다", () => {
    rememberCloudReturnPath("/courses/course-one/prepare?tab=flow#current");
    expect(readCloudReturnPath(null)).toBe(
      "/courses/course-one/prepare?tab=flow#current",
    );
    clearCloudReturnPath();
    expect(readCloudReturnPath(null)).toBe("/");
  });

  it("외부 URL, 프로토콜 상대 URL과 로그인 재귀를 시작 화면으로 바꾼다", () => {
    expect(safeCloudReturnPath("https://example.test")).toBe("/");
    expect(safeCloudReturnPath("//example.test/path")).toBe("/");
    expect(safeCloudReturnPath("/login")).toBe("/");
  });

  it("Router state를 저장값보다 우선한다", () => {
    rememberCloudReturnPath("/courses/import");
    expect(readCloudReturnPath({ from: "/rooms/room-one/staff" })).toBe(
      "/rooms/room-one/staff",
    );
  });
});

