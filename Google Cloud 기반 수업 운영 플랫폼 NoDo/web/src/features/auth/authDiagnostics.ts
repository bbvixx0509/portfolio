import type { FirebaseOptions } from "firebase/app";
import { CLOUD_FIREBASE_PROJECT_ID } from "../../lib/firebase/firebaseConfig";
import type { NoDoRuntimeMode } from "../../config/runtimeMode";

export const AUTH_DIAGNOSTIC_STEP_IDS = [
  "firebase-initialization",
  "local-address",
  "project-id",
  "auth-domain",
  "button-click",
  "popup-start",
  "popup-result",
  "redirect-result",
  "auth-state",
  "firebase-user",
  "id-token",
  "profile-request",
  "profile-response",
  "organization-role",
  "final-result",
] as const;

export type AuthDiagnosticStepId = (typeof AUTH_DIAGNOSTIC_STEP_IDS)[number];
export type AuthDiagnosticStatus = "pending" | "success" | "failure" | "not-run";

export type AuthDiagnosticStep = {
  id: AuthDiagnosticStepId;
  label: string;
  status: AuthDiagnosticStatus;
  detail: string;
};

export type AuthDiagnostics = {
  enabled: boolean;
  steps: AuthDiagnosticStep[];
};

const stepLabels: Record<AuthDiagnosticStepId, string> = {
  "firebase-initialization": "Firebase 초기화",
  "local-address": "로컬 접속 주소",
  "project-id": "Firebase 프로젝트 확인",
  "auth-domain": "authDomain 설정",
  "button-click": "로그인 버튼 클릭",
  "popup-start": "팝업 로그인 시작",
  "popup-result": "팝업 로그인 결과",
  "redirect-result": "리디렉션 로그인 결과",
  "auth-state": "Firebase 인증 상태 알림",
  "firebase-user": "Firebase 사용자 확인",
  "id-token": "로그인 토큰 확인",
  "profile-request": "/api/auth/me 요청",
  "profile-response": "/api/auth/me 응답",
  "organization-role": "조직 역할 확인",
  "final-result": "최종 로그인 결과",
};

function step(
  id: AuthDiagnosticStepId,
  status: AuthDiagnosticStatus = "not-run",
  detail = "아직 실행되지 않음",
): AuthDiagnosticStep {
  return { id, label: stepLabels[id], status, detail };
}

export function isAuthDiagnosticsEnabled(input: {
  development: boolean;
  runtimeMode: NoDoRuntimeMode;
  search: string;
}) {
  return (
    input.development &&
    input.runtimeMode === "cloud-auth" &&
    new URLSearchParams(input.search).get("authDebug") === "1"
  );
}

export function createAuthDiagnostics(input: {
  enabled: boolean;
  hostname: string | undefined;
  firebaseConfig?: FirebaseOptions;
}): AuthDiagnostics {
  if (!input.enabled) return { enabled: false, steps: [] };

  const localAddress = ["localhost", "127.0.0.1"].includes(
    input.hostname ?? "",
  );
  const projectMatches =
    input.firebaseConfig?.projectId === CLOUD_FIREBASE_PROJECT_ID;
  const authDomainConfigured = Boolean(input.firebaseConfig?.authDomain?.trim());

  return {
    enabled: true,
    steps: [
      step("firebase-initialization", "pending", "확인 중"),
      step(
        "local-address",
        localAddress ? "success" : "failure",
        localAddress ? "localhost 또는 127.0.0.1 확인" : "지원되지 않는 접속 주소",
      ),
      step(
        "project-id",
        projectMatches ? "success" : "failure",
        projectMatches ? "example-gcp-project 확인" : "허용된 프로젝트와 일치하지 않음",
      ),
      step(
        "auth-domain",
        authDomainConfigured ? "success" : "failure",
        authDomainConfigured ? "설정됨" : "설정되지 않음",
      ),
      ...AUTH_DIAGNOSTIC_STEP_IDS.slice(4).map((id) => step(id)),
    ],
  };
}

export function resetAuthDiagnostics(
  diagnostics: AuthDiagnostics,
): AuthDiagnostics {
  if (!diagnostics.enabled) return diagnostics;

  return {
    ...diagnostics,
    steps: diagnostics.steps.map((current) =>
      ["local-address", "project-id", "auth-domain"].includes(current.id)
        ? current
        : step(
            current.id,
            current.id === "firebase-initialization" ? "success" : "not-run",
            current.id === "firebase-initialization"
              ? "준비됨"
              : "아직 실행되지 않음",
          ),
    ),
  };
}

export function updateAuthDiagnostic(
  diagnostics: AuthDiagnostics,
  id: AuthDiagnosticStepId,
  status: AuthDiagnosticStatus,
  detail: string,
): AuthDiagnostics {
  if (!diagnostics.enabled) return diagnostics;
  return {
    ...diagnostics,
    steps: diagnostics.steps.map((current) =>
      current.id === id ? { ...current, status, detail } : current,
    ),
  };
}
