import type { User } from "firebase/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, assertApiBaseUrl, assertLocalApiBaseUrl, requestApi } from "./apiClient";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FastAPI client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Firebase ID token을 Bearer 헤더로 전달한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const authUser = {
      getIdToken: vi.fn().mockResolvedValue("local-id-token"),
    } as unknown as User;

    await expect(
      requestApi("/api/me", { authUser }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/api/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer local-id-token",
        }),
      }),
    );
  });

  it("403 응답을 상태 코드가 보존된 ApiError로 반환한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ detail: "권한이 없습니다." }, 403)),
    );
    const authUser = {
      getIdToken: vi.fn().mockResolvedValue("local-id-token"),
    } as unknown as User;

    const promise = requestApi("/api/courses", { authUser });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 403 });
  });

  it("ID token 획득 실패를 안전한 오류 코드와 진단 상태로 반환한다", async () => {
    const onIdTokenStatus = vi.fn();
    const authUser = {
      getIdToken: vi.fn().mockRejectedValue(new Error("token must stay private")),
    } as unknown as User;

    await expect(requestApi("/api/auth/me", { authUser, onIdTokenStatus }))
      .rejects.toMatchObject({ status: 0, details: { code: "ID_TOKEN_UNAVAILABLE" } });
    expect(onIdTokenStatus).toHaveBeenCalledWith("failure");
  });

  it("409 응답의 구조화된 오류 코드를 details에 보존한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({
        code: "ORGANIZATION_BOOTSTRAP_REQUIRED",
        detail: "organization bootstrap required",
      }, 409)),
    );
    const authUser = {
      getIdToken: vi.fn().mockResolvedValue("local-id-token"),
    } as unknown as User;

    await expect(requestApi("/api/auth/me", { authUser })).rejects.toMatchObject({
      status: 409,
      details: { code: "ORGANIZATION_BOOTSTRAP_REQUIRED" },
    });
  });

  it("로컬 8080이 아닌 API 주소를 차단한다", () => {
    expect(assertLocalApiBaseUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
    expect(() => assertLocalApiBaseUrl("https://api.example.com")).toThrow(
      /로컬 서버만 허용/,
    );
  });

  it("cloud-auth도 고정 로컬 인증 서버 외의 연결을 차단한다", () => {
    expect(assertApiBaseUrl("http://localhost:8082", "cloud-auth")).toBe(
      "http://localhost:8082",
    );
    expect(assertApiBaseUrl("http://localhost:5175", "cloud-auth")).toBe(
      "http://localhost:5175",
    );
    expect(
      assertApiBaseUrl(
        "https://nodo-api-000000000000.asia-northeast3.run.app",
        "cloud-auth",
      ),
    ).toBe("https://nodo-api-000000000000.asia-northeast3.run.app");
    expect(() =>
      assertApiBaseUrl("https://api.example.com", "cloud-auth"),
    ).toThrow(/로컬 인증 서버 또는 개발 프록시/);
    expect(() =>
      assertApiBaseUrl("http://localhost:8080", "cloud-auth"),
    ).toThrow(/로컬 인증 서버 또는 개발 프록시/);
    expect(() =>
      assertApiBaseUrl("http://127.0.0.1:5175", "cloud-auth"),
    ).toThrow(/로컬 인증 서버 또는 개발 프록시/);
  });
});
