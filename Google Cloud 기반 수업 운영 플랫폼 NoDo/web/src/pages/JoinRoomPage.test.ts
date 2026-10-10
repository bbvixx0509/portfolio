import { describe, expect, it } from "vitest";
import { createRandomNickname } from "./JoinRoomPage";

describe("createRandomNickname", () => {
  it("주어진 난수에 따라 재현 가능한 익명 별명을 만든다", () => {
    expect(createRandomNickname(() => 0)).toBe("용감한 수달");
    expect(createRandomNickname(() => 0.99)).toBe("든든한 판다");
  });
});
