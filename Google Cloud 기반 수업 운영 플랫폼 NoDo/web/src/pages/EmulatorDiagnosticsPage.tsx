import {
  CheckCircle2,
  CircleDashed,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NODO_APP_NAME, NODO_APP_VERSION } from "../config/appInfo";
import {
  LOCAL_FIREBASE_PROJECT_ID,
  localFirebaseEnvironment,
} from "../lib/firebase/firebaseConfig";
import {
  runEmulatorDiagnostic,
  type EmulatorDiagnosticResult,
  type EmulatorDiagnosticStepId,
  type EmulatorDiagnosticStepUpdate,
} from "../lib/firebase/emulatorDiagnostic";
import styles from "./EmulatorDiagnosticsPage.module.css";

const DIAGNOSTIC_STEPS: ReadonlyArray<{
  id: EmulatorDiagnosticStepId;
  label: string;
}> = [
  { id: "app", label: "Firebase 앱 초기화" },
  { id: "authConnection", label: "Authentication Emulator 연결" },
  { id: "firestoreConnection", label: "Firestore Emulator 연결" },
  { id: "storageConnection", label: "Storage Emulator 설정" },
  { id: "anonymousAuth", label: "익명 사용자 생성" },
  { id: "documentWrite", label: "사용자 전용 진단 문서 작성" },
  { id: "documentRead", label: "진단 문서 다시 읽기" },
  { id: "documentDelete", label: "진단 문서 삭제" },
];

function initialUpdates() {
  return Object.fromEntries(
    DIAGNOSTIC_STEPS.map(({ id }) => [
      id,
      { id, state: "idle", message: "대기 중" },
    ]),
  ) as Record<EmulatorDiagnosticStepId, EmulatorDiagnosticStepUpdate>;
}

function StepIcon({ update }: { update: EmulatorDiagnosticStepUpdate }) {
  if (update.state === "success") {
    return <CheckCircle2 aria-hidden="true" />;
  }

  if (update.state === "running") {
    return <LoaderCircle aria-hidden="true" className={styles.spinner} />;
  }

  if (update.state === "error") {
    return <TriangleAlert aria-hidden="true" />;
  }

  return <CircleDashed aria-hidden="true" />;
}

export function EmulatorDiagnosticsPage() {
  const [updates, setUpdates] = useState(initialUpdates);
  const [result, setResult] = useState<EmulatorDiagnosticResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const startedRef = useRef(false);

  const executeDiagnostic = useCallback(async () => {
    setUpdates(initialUpdates());
    setResult(null);
    setErrorMessage(null);
    setIsRunning(true);

    try {
      const nextResult = await runEmulatorDiagnostic((update) => {
        setUpdates((current) => ({ ...current, [update.id]: update }));
      });
      setResult(nextResult);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "로컬 Emulator 진단에 실패했습니다.",
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }

    startedRef.current = true;
    void executeDiagnostic();
  }, [executeDiagnostic]);

  return (
    <main className={styles.page}>
      <section className={styles.shell} aria-labelledby="diagnostic-title">
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>
              {NODO_APP_NAME} {NODO_APP_VERSION} · 개발 전용
            </p>
            <h1 id="diagnostic-title">Firebase Emulator 연결 진단</h1>
            <p>
              이 경로는 사용자 메뉴에 노출되지 않으며 로컬 개발 환경에서만
              작동합니다.
            </p>
          </div>
          <ShieldCheck aria-hidden="true" className={styles.shield} />
        </header>

        <div className={styles.guardGrid} aria-label="로컬 연결 안전 설정">
          <article>
            <span>프로젝트 ID</span>
            <strong>{LOCAL_FIREBASE_PROJECT_ID}</strong>
          </article>
          <article>
            <span>연결 모드</span>
            <strong>
              {localFirebaseEnvironment.useEmulators
                ? "로컬 Emulator 전용"
                : "차단됨"}
            </strong>
          </article>
          <article>
            <span>실제 클라우드</span>
            <strong>연결 차단</strong>
          </article>
        </div>

        <ol className={styles.stepList} aria-label="진단 단계">
          {DIAGNOSTIC_STEPS.map((step) => {
            const update = updates[step.id];
            return (
              <li
                key={step.id}
                className={styles[update.state]}
                data-state={update.state}
              >
                <StepIcon update={update} />
                <div>
                  <strong>{step.label}</strong>
                  <span>{update.message}</span>
                </div>
              </li>
            );
          })}
        </ol>

        <div className={styles.result} aria-live="polite">
          {isRunning && <p>로컬 연결을 순서대로 확인하고 있습니다.</p>}
          {result && (
            <div className={styles.successMessage}>
              <CheckCircle2 aria-hidden="true" />
              <div>
                <strong>모든 로컬 진단을 통과했습니다.</strong>
                <span>익명 UID: {result.uid}</span>
              </div>
            </div>
          )}
          {errorMessage && (
            <div className={styles.errorMessage} role="alert">
              <TriangleAlert aria-hidden="true" />
              <div>
                <strong>진단에 실패했습니다.</strong>
                <span>{errorMessage}</span>
              </div>
            </div>
          )}
        </div>

        <button
          className={styles.retryButton}
          type="button"
          onClick={() => void executeDiagnostic()}
          disabled={isRunning}
        >
          <RefreshCw aria-hidden="true" />
          {isRunning ? "진단 진행 중" : "진단 다시 실행"}
        </button>
      </section>
    </main>
  );
}

