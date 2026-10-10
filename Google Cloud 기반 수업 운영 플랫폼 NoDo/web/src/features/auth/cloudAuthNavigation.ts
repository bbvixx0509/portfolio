export const CLOUD_AUTH_RETURN_TO_KEY = "nodo.cloud-auth.return-to";

export function safeCloudReturnPath(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value === "/login" ||
    value.startsWith("/login?")
  ) {
    return "/";
  }
  return value;
}

export function rememberCloudReturnPath(path: string) {
  try {
    globalThis.sessionStorage?.setItem(
      CLOUD_AUTH_RETURN_TO_KEY,
      safeCloudReturnPath(path),
    );
  } catch {
    // 저장소가 차단되어도 Router state로 같은 탭 이동을 계속 지원한다.
  }
}

export function readCloudReturnPath(routerState: unknown) {
  if (routerState && typeof routerState === "object") {
    const from = (routerState as { from?: unknown }).from;
    if (typeof from === "string") return safeCloudReturnPath(from);
  }

  try {
    return safeCloudReturnPath(
      globalThis.sessionStorage?.getItem(CLOUD_AUTH_RETURN_TO_KEY),
    );
  } catch {
    return "/";
  }
}

export function clearCloudReturnPath() {
  try {
    globalThis.sessionStorage?.removeItem(CLOUD_AUTH_RETURN_TO_KEY);
  } catch {
    // 인증 성공 후 저장소 정리가 실패해도 이동은 계속한다.
  }
}

