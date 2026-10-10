import {
  getApps,
  initializeApp,
  type FirebaseApp,
} from "firebase/app";
import { runtimeMode } from "../../config/runtimeMode";
import {
  assertLocalFirebaseEnvironment,
  firebaseClientConfig,
  getCloudFirebaseConfig,
} from "./firebaseConfig";

const FIREBASE_APP_NAME = "nodo-01-local-emulator";
const CLOUD_FIREBASE_APP_NAME = "nodo-02-cloud-auth";

export function getLocalFirebaseApp(): FirebaseApp {
  assertLocalFirebaseEnvironment();

  return (
    getApps().find((app) => app.name === FIREBASE_APP_NAME) ??
    initializeApp(firebaseClientConfig, FIREBASE_APP_NAME)
  );
}

export function getCloudFirebaseApp(): FirebaseApp {
  if (runtimeMode !== "cloud-auth") {
    throw new Error("Cloud Authentication 앱은 cloud-auth 모드에서만 초기화할 수 있습니다.");
  }

  return (
    getApps().find((app) => app.name === CLOUD_FIREBASE_APP_NAME) ??
    initializeApp(getCloudFirebaseConfig(), CLOUD_FIREBASE_APP_NAME)
  );
}

export function getFirebaseApp(): FirebaseApp {
  return runtimeMode === "cloud-auth"
    ? getCloudFirebaseApp()
    : getLocalFirebaseApp();
}
