import type { FirebaseOptions } from "firebase/app";

export const CLOUD_FIREBASE_PROJECT_ID = "example-gcp-project";

export const LOCAL_FIREBASE_PROJECT_ID = "demo-nodo";

export const LOCAL_EMULATOR_ENDPOINTS = {
  auth: { host: "127.0.0.1", port: 9099 },
  firestore: { host: "127.0.0.1", port: 8081 },
  storage: { host: "127.0.0.1", port: 9199 },
} as const;

export interface LocalFirebaseGuardInput {
  isDevelopment: boolean;
  projectId: string;
  useEmulators: boolean;
  authHost: string;
  authPort: number;
  firestoreHost: string;
  firestorePort: number;
  storageHost: string;
  storagePort: number;
}

function readPort(name: string, value: string | undefined, fallback: number) {
  const port = Number(value ?? fallback);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} 포트 값이 올바르지 않습니다.`);
  }

  return port;
}

export const firebaseClientConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "local-demo-api-key",
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "demo-nodo.localhost",
  projectId:
    import.meta.env.VITE_FIREBASE_PROJECT_ID ?? LOCAL_FIREBASE_PROJECT_ID,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "demo-nodo.appspot.com",
  appId:
    import.meta.env.VITE_FIREBASE_APP_ID ??
    "1:000000000000:web:local-nodo-01",
};

type FirebaseEnvironment = Record<string, string | undefined>;

const cloudConfigKeys = [
  ["apiKey", "VITE_FIREBASE_API_KEY"],
  ["authDomain", "VITE_FIREBASE_AUTH_DOMAIN"],
  ["projectId", "VITE_FIREBASE_PROJECT_ID"],
  ["storageBucket", "VITE_FIREBASE_STORAGE_BUCKET"],
  ["messagingSenderId", "VITE_FIREBASE_MESSAGING_SENDER_ID"],
  ["appId", "VITE_FIREBASE_APP_ID"],
] as const;

export function readCloudFirebaseConfig(
  environment: FirebaseEnvironment,
): FirebaseOptions {
  const config: Record<string, string> = {};
  const missing: string[] = [];

  for (const [configKey, environmentKey] of cloudConfigKeys) {
    const value = environment[environmentKey]?.trim();
    if (!value) {
      missing.push(environmentKey);
      continue;
    }
    config[configKey] = value;
  }

  if (missing.length > 0) {
    throw new Error(
      `Google 인증 설정이 누락되었습니다: ${missing.join(", ")}`,
    );
  }

  if (config.projectId !== CLOUD_FIREBASE_PROJECT_ID) {
    throw new Error(
      `허용되지 않은 Firebase 프로젝트입니다. ${CLOUD_FIREBASE_PROJECT_ID}만 사용할 수 있습니다.`,
    );
  }

  return config;
}

export function getCloudFirebaseConfig(): FirebaseOptions {
  return readCloudFirebaseConfig(import.meta.env);
}

export const localFirebaseEnvironment: LocalFirebaseGuardInput = {
  isDevelopment: import.meta.env.DEV,
  projectId: firebaseClientConfig.projectId ?? "",
  useEmulators:
    (import.meta.env.VITE_USE_FIREBASE_EMULATORS ?? "true") === "true",
  authHost:
    import.meta.env.VITE_FIREBASE_AUTH_HOST ??
    LOCAL_EMULATOR_ENDPOINTS.auth.host,
  authPort: readPort(
    "Authentication Emulator",
    import.meta.env.VITE_FIREBASE_AUTH_PORT,
    LOCAL_EMULATOR_ENDPOINTS.auth.port,
  ),
  firestoreHost:
    import.meta.env.VITE_FIREBASE_FIRESTORE_HOST ??
    LOCAL_EMULATOR_ENDPOINTS.firestore.host,
  firestorePort: readPort(
    "Firestore Emulator",
    import.meta.env.VITE_FIREBASE_FIRESTORE_PORT,
    LOCAL_EMULATOR_ENDPOINTS.firestore.port,
  ),
  storageHost:
    import.meta.env.VITE_FIREBASE_STORAGE_HOST ??
    LOCAL_EMULATOR_ENDPOINTS.storage.host,
  storagePort: readPort(
    "Storage Emulator",
    import.meta.env.VITE_FIREBASE_STORAGE_PORT,
    LOCAL_EMULATOR_ENDPOINTS.storage.port,
  ),
};

export function assertLocalFirebaseEnvironment(
  environment: LocalFirebaseGuardInput = localFirebaseEnvironment,
) {
  if (!environment.isDevelopment) {
    throw new Error(
      "NoDo_01 Firebase 연결은 개발 환경의 로컬 Emulator에서만 허용됩니다.",
    );
  }

  if (environment.projectId !== LOCAL_FIREBASE_PROJECT_ID) {
    throw new Error(
      `실제 클라우드 연결을 차단했습니다. 프로젝트 ID는 ${LOCAL_FIREBASE_PROJECT_ID}만 허용됩니다.`,
    );
  }

  if (!environment.useEmulators) {
    throw new Error(
      "실제 클라우드 연결을 차단했습니다. Firebase Emulator 설정이 꺼져 있습니다.",
    );
  }

  const endpointChecks = [
    [
      "Authentication",
      environment.authHost,
      environment.authPort,
      LOCAL_EMULATOR_ENDPOINTS.auth,
    ],
    [
      "Firestore",
      environment.firestoreHost,
      environment.firestorePort,
      LOCAL_EMULATOR_ENDPOINTS.firestore,
    ],
    [
      "Storage",
      environment.storageHost,
      environment.storagePort,
      LOCAL_EMULATOR_ENDPOINTS.storage,
    ],
  ] as const;

  for (const [name, host, port, expected] of endpointChecks) {
    if (host !== expected.host || port !== expected.port) {
      throw new Error(
        `${name} 연결을 차단했습니다. ${expected.host}:${expected.port} 로컬 Emulator만 허용됩니다.`,
      );
    }
  }
}
