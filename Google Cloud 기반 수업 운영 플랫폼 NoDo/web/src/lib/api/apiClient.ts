import type { User } from "firebase/auth";
import { runtimeMode, type NoDoRuntimeMode } from "../../config/runtimeMode";
import { getFirebaseAuth } from "../firebase/firebaseAuth";

function resolveConfiguredApiBaseUrl() {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  if (runtimeMode === "cloud-auth" && import.meta.env.PROD) {
    throw new Error("운영 NoDo API 주소가 설정되지 않았습니다.");
  }
  return runtimeMode === "cloud-auth"
    ? "http://localhost:8082"
    : "http://127.0.0.1:8080";
}

const configuredApiBaseUrl = resolveConfiguredApiBaseUrl();

export function assertLocalApiBaseUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "8080"
  ) {
    throw new Error("NoDo_01 FastAPI 연결은 127.0.0.1:8080 로컬 서버만 허용됩니다.");
  }
  return url.origin;
}

export function assertApiBaseUrl(
  value: string,
  mode: NoDoRuntimeMode = runtimeMode,
) {
  if (mode === "emulator") {
    return assertLocalApiBaseUrl(value);
  }

  const url = new URL(value);
  const isDirectBackend =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    url.port === "8082";
  const isCloudAuthDevProxy =
    url.protocol === "http:" &&
    url.hostname === "localhost" &&
    url.port === "5175";
  const isNoDoCloudRunService =
    url.protocol === "https:" &&
    (/^nodo-api-[a-z0-9-]+\.a\.run\.app$/.test(url.hostname) ||
      /^nodo-api-\d+\.asia-northeast3\.run\.app$/.test(url.hostname));
  if (!isDirectBackend && !isCloudAuthDevProxy && !isNoDoCloudRunService) {
    throw new Error(
      "NoDo_02 cloud-auth는 고정된 로컬 인증 서버 또는 개발 프록시, 그리고 NoDo Cloud Run만 사용할 수 있습니다.",
    );
  }
  return url.origin;
}

const API_BASE_URL = assertApiBaseUrl(configuredApiBaseUrl);

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export type FileUploadProgress = {
  loadedBytes: number;
  totalBytes: number;
};

export type BlobApiResponse = {
  blob: Blob;
  contentDisposition: string | null;
};

type ApiRequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  authUser?: User | null;
  onIdTokenStatus?: (status: "success" | "failure") => void;
};

function getErrorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const detail = record.detail ?? record.message;
    if (typeof detail === "string") {
      return detail;
    }
  }
  return `요청을 처리하지 못했습니다. (${status})`;
}

export async function requestApi<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const {
    authUser = getFirebaseAuth().currentUser,
    body,
    headers,
    onIdTokenStatus,
    ...init
  } = options;
  let token: string | null = null;
  if (authUser) {
    try {
      token = await authUser.getIdToken();
      onIdTokenStatus?.("success");
    } catch {
      onIdTokenStatus?.("failure");
      throw new ApiError(
        "Firebase ID token을 확인하지 못했습니다.",
        0,
        { code: "ID_TOKEN_UNAVAILABLE" },
      );
    }
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new ApiError(getErrorMessage(payload, response.status), response.status, payload);
  }

  return payload as T;
}

/** Fetch a private binary response through the same Firebase-token gateway.
 *
 * This is intentionally separate from `requestApi`: JSON endpoints stay
 * JSON-only while a PDF is kept in browser memory and never receives a
 * Storage URL or a persistent cache entry.
 */
export async function requestBlobApi(
  path: string,
  options: Omit<ApiRequestOptions, "body"> = {},
): Promise<Blob> {
  return (await requestBlobApiResponse(path, options)).blob;
}

/** Keep binary payloads in memory while exposing only a safe response header. */
export async function requestBlobApiResponse(
  path: string,
  options: Omit<ApiRequestOptions, "body"> = {},
): Promise<BlobApiResponse> {
  const { authUser = getFirebaseAuth().currentUser, headers, onIdTokenStatus, ...init } = options;
  let token: string | null = null;
  if (authUser) {
    try {
      token = await authUser.getIdToken();
      onIdTokenStatus?.("success");
    } catch {
      onIdTokenStatus?.("failure");
      throw new ApiError("Firebase ID token을 확인하지 못했습니다.", 0, { code: "ID_TOKEN_UNAVAILABLE" });
    }
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/pdf, application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    throw new ApiError(getErrorMessage(payload, response.status), response.status, payload);
  }
  return {
    blob: await response.blob(),
    contentDisposition: response.headers.get("content-disposition"),
  };
}

export async function uploadFileApi<T>(
  path: string,
  file: File,
  options: {
    authUser?: User | null;
    onProgress?: (progress: FileUploadProgress) => void;
  } = {},
): Promise<T> {
  const authUser = options.authUser ?? getFirebaseAuth().currentUser;
  if (!authUser) {
    throw new ApiError("Firebase 로그인 정보를 확인하지 못했습니다.", 401);
  }

  let token: string;
  try {
    token = await authUser.getIdToken();
  } catch {
    throw new ApiError(
      "Firebase ID token을 확인하지 못했습니다.",
      0,
      { code: "ID_TOKEN_UNAVAILABLE" },
    );
  }

  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${API_BASE_URL}${path}`);
    request.responseType = "text";
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.setRequestHeader("X-NoDo-Upload-Filename", encodeURIComponent(file.name));
    request.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        options.onProgress?.({
          loadedBytes: event.loaded,
          totalBytes: event.total,
        });
      }
    });
    request.addEventListener("error", () => {
      reject(
        new ApiError("자료 파일을 전송하지 못했습니다.", 0, {
          code: "UPLOAD_NETWORK_ERROR",
        }),
      );
    });
    request.addEventListener("load", () => {
      let payload: unknown = request.responseText;
      try {
        payload = JSON.parse(request.responseText) as unknown;
      } catch {
        // A text-only gateway error is still represented safely below.
      }
      if (request.status < 200 || request.status >= 300) {
        reject(
          new ApiError(
            getErrorMessage(payload, request.status),
            request.status,
            payload,
          ),
        );
        return;
      }
      resolve(payload as T);
    });
    request.send(file);
  });
}
