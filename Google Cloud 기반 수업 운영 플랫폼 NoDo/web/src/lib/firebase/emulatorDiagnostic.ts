import { signInAnonymously, signOut } from "firebase/auth";
import {
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import {
  LOCAL_FIREBASE_PROJECT_ID,
  assertLocalFirebaseEnvironment,
} from "./firebaseConfig";
import { getLocalFirebaseServices } from "./firebaseServices";

export type EmulatorDiagnosticStepId =
  | "app"
  | "authConnection"
  | "firestoreConnection"
  | "storageConnection"
  | "anonymousAuth"
  | "documentWrite"
  | "documentRead"
  | "documentDelete";

export type EmulatorDiagnosticStepState =
  | "idle"
  | "running"
  | "success"
  | "error";

export interface EmulatorDiagnosticStepUpdate {
  id: EmulatorDiagnosticStepId;
  state: EmulatorDiagnosticStepState;
  message: string;
}

export interface EmulatorDiagnosticResult {
  projectId: string;
  uid: string;
  cloudConnectionBlocked: true;
  completedAt: string;
}

type StepListener = (update: EmulatorDiagnosticStepUpdate) => void;

let activeDiagnostic: Promise<EmulatorDiagnosticResult> | null = null;

async function performDiagnostic(
  onStep?: StepListener,
): Promise<EmulatorDiagnosticResult> {
  let activeStep: EmulatorDiagnosticStepId = "app";

  const report = (
    id: EmulatorDiagnosticStepId,
    state: EmulatorDiagnosticStepState,
    message: string,
  ) => onStep?.({ id, state, message });

  const begin = (id: EmulatorDiagnosticStepId, message: string) => {
    activeStep = id;
    report(id, "running", message);
  };

  try {
    begin("app", "로컬 전용 설정과 Firebase 앱을 확인하는 중입니다.");
    assertLocalFirebaseEnvironment();
    const services = getLocalFirebaseServices();
    report("app", "success", "Firebase 앱 초기화 완료");

    begin("authConnection", "Authentication Emulator 연결을 확인합니다.");
    void services.auth;
    report("authConnection", "success", "127.0.0.1:9099 연결 설정 완료");

    begin("firestoreConnection", "Firestore Emulator 연결을 확인합니다.");
    void services.firestore;
    report(
      "firestoreConnection",
      "success",
      "127.0.0.1:8081 연결 설정 완료",
    );

    begin("storageConnection", "Storage Emulator 연결을 확인합니다.");
    void services.storage;
    report(
      "storageConnection",
      "success",
      "127.0.0.1:9199 연결 설정 완료",
    );

    begin("anonymousAuth", "로컬 익명 사용자를 생성하는 중입니다.");
    const credential = await signInAnonymously(services.auth);
    const uid = credential.user.uid;
    report("anonymousAuth", "success", `익명 인증 완료 (${uid})`);

    const checkReference = doc(
      services.firestore,
      "emulatorChecks",
      uid,
    );
    let documentDeleted = false;

    try {
      begin("documentWrite", "사용자 전용 진단 문서를 작성하는 중입니다.");
      await setDoc(checkReference, {
        ownerUid: uid,
        source: "NoDo_01-dev-emulator",
        checkedAt: Timestamp.now(),
      });
      report("documentWrite", "success", "진단 문서 작성 완료");

      begin("documentRead", "작성한 진단 문서를 다시 읽는 중입니다.");
      const snapshot = await getDoc(checkReference);
      const data = snapshot.data();

      if (
        !snapshot.exists() ||
        data?.ownerUid !== uid ||
        data.source !== "NoDo_01-dev-emulator"
      ) {
        throw new Error("읽은 진단 문서의 값이 작성한 값과 다릅니다.");
      }

      report("documentRead", "success", "진단 문서 읽기와 값 확인 완료");

      begin("documentDelete", "진단 문서를 삭제하는 중입니다.");
      await deleteDoc(checkReference);
      documentDeleted = true;
      report("documentDelete", "success", "진단 문서 삭제 완료");
    } finally {
      if (!documentDeleted) {
        await deleteDoc(checkReference).catch(() => undefined);
      }
      await signOut(services.auth).catch(() => undefined);
    }

    return {
      projectId: LOCAL_FIREBASE_PROJECT_ID,
      uid,
      cloudConnectionBlocked: true,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "알 수 없는 진단 오류입니다.";
    report(activeStep, "error", message);
    throw error;
  }
}

export function runEmulatorDiagnostic(onStep?: StepListener) {
  if (activeDiagnostic) {
    return activeDiagnostic;
  }

  activeDiagnostic = performDiagnostic(onStep).finally(() => {
    activeDiagnostic = null;
  });

  return activeDiagnostic;
}
