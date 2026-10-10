import { describe, expect, it } from "vitest";
import { normalizeInstructorStorageLimit, normalizeStorageUsage } from "./storageQuotaApi";

describe("normalizeInstructorStorageLimit", () => {
  it("accepts the quota PATCH response without a baseline state", () => {
    expect(normalizeInstructorStorageLimit({ usedBytes: 1, reservedBytes: 0, limitBytes: 2, remainingBytes: 1 })).toEqual({ usedBytes: 1, reservedBytes: 0, limitBytes: 2, remainingBytes: 1 });
  });
  it("rejects malformed quota PATCH responses", () => {
    expect(() => normalizeInstructorStorageLimit({ limitBytes: 2 })).toThrow();
  });
});

describe("normalizeStorageUsage", () => {
  it("accepts the BASELINED state returned by the read-only quota endpoint", () => {
    expect(normalizeStorageUsage({
      usedBytes: 16 * 1024 ** 2,
      reservedBytes: 0,
      limitBytes: 5 * 1024 ** 3,
      remainingBytes: 5 * 1024 ** 3 - 16 * 1024 ** 2,
      baselineState: "BASELINED",
    })).toMatchObject({ baselineState: "BASELINED" });
  });
});
