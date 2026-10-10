import {
  connectAuthEmulator,
  getAuth,
  type Auth,
} from "firebase/auth";
import { connectEmulatorOnce } from "./emulatorRuntime";
import { runtimeMode } from "../../config/runtimeMode";
import { getCloudFirebaseApp, getLocalFirebaseApp } from "./firebaseApp";
import { localFirebaseEnvironment } from "./firebaseConfig";

export function getLocalFirebaseAuth(): Auth {
  const auth = getAuth(getLocalFirebaseApp());

  connectEmulatorOnce("auth", auth, () => {
    connectAuthEmulator(
      auth,
      `http://${localFirebaseEnvironment.authHost}:${localFirebaseEnvironment.authPort}`,
      { disableWarnings: true },
    );
  });

  return auth;
}

export function getCloudFirebaseAuth(): Auth {
  if (runtimeMode !== "cloud-auth") {
    throw new Error("Cloud Authentication은 cloud-auth 모드에서만 사용할 수 있습니다.");
  }
  return getAuth(getCloudFirebaseApp());
}

export function getFirebaseAuth(): Auth {
  return runtimeMode === "cloud-auth"
    ? getCloudFirebaseAuth()
    : getLocalFirebaseAuth();
}
