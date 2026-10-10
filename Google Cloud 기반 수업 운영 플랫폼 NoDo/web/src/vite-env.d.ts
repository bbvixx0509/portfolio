/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NODO_RUNTIME_MODE?: "emulator" | "cloud-auth";
  readonly VITE_LOCAL_REAL_NODO_CLOUD?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_USE_FIREBASE_EMULATORS?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_AUTH_HOST?: string;
  readonly VITE_FIREBASE_AUTH_PORT?: string;
  readonly VITE_FIREBASE_FIRESTORE_HOST?: string;
  readonly VITE_FIREBASE_FIRESTORE_PORT?: string;
  readonly VITE_FIREBASE_STORAGE_HOST?: string;
  readonly VITE_FIREBASE_STORAGE_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
