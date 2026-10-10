import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkLocalCloudApiHealth,
  isLocalCloudApiRecoveryEnabled,
} from "./localCloudApiHealth";

vi.mock("../../config/runtimeMode", () => ({ runtimeMode: "cloud-auth" }));

describe("로컬 cloud-auth FastAPI health 확인", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("개발 localhost에서만 토큰 없이 Vite health 프록시를 확인한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: "ok", service: "nodo" }),
      { headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    expect(isLocalCloudApiRecoveryEnabled()).toBe(true);
    await expect(checkLocalCloudApiHealth()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/health", expect.objectContaining({
      cache: "no-store",
      headers: { Accept: "application/json" },
    }));
  });

  it("프록시 502를 구조화된 로컬 API 오류로 변환한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkLocalCloudApiHealth()).rejects.toMatchObject({
      status: 502,
      details: { code: "LOCAL_API_UNAVAILABLE" },
    });
  });
});
