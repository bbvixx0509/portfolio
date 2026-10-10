import { runtimeMode } from "../../config/runtimeMode";
import { ApiError } from "../../lib/api/apiClient";

export const LOCAL_CLOUD_API_UNAVAILABLE_MESSAGE =
  "NoDo 로컬 FastAPI(127.0.0.1:8082)가 실행 중인지 확인한 뒤 다시 연결해 주세요.";

/** This recovery check exists only for Vite cloud-auth development. */
export function isLocalCloudApiRecoveryEnabled() {
  return (
    runtimeMode === "cloud-auth" &&
    import.meta.env.DEV &&
    globalThis.location?.hostname === "localhost"
  );
}

/**
 * Vite proxies this public, dependency-free check to the fixed local FastAPI
 * listener. It deliberately sends no Firebase token and accesses no data.
 */
export async function checkLocalCloudApiHealth() {
  if (!isLocalCloudApiRecoveryEnabled()) return;

  let response: Response;
  try {
    response = await fetch("/health", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(LOCAL_CLOUD_API_UNAVAILABLE_MESSAGE, 0, {
      code: "LOCAL_API_UNAVAILABLE",
    });
  }

  if (!response.ok) {
    throw new ApiError(LOCAL_CLOUD_API_UNAVAILABLE_MESSAGE, response.status, {
      code: "LOCAL_API_UNAVAILABLE",
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(LOCAL_CLOUD_API_UNAVAILABLE_MESSAGE, 503, {
      code: "LOCAL_API_UNAVAILABLE",
    });
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as { status?: unknown }).status !== "ok" ||
    (payload as { service?: unknown }).service !== "nodo"
  ) {
    throw new ApiError(LOCAL_CLOUD_API_UNAVAILABLE_MESSAGE, 503, {
      code: "LOCAL_API_UNAVAILABLE",
    });
  }
}
