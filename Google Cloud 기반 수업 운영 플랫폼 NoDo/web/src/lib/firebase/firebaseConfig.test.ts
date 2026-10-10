import { describe, expect, it } from "vitest";
import {
  assertLocalFirebaseEnvironment,
  CLOUD_FIREBASE_PROJECT_ID,
  readCloudFirebaseConfig,
  type LocalFirebaseGuardInput,
} from "./firebaseConfig";
import { getLocalFirebaseServices } from "./firebaseServices";

const validEnvironment: LocalFirebaseGuardInput = {
  isDevelopment: true,
  projectId: "demo-nodo",
  useEmulators: true,
  authHost: "127.0.0.1",
  authPort: 9099,
  firestoreHost: "127.0.0.1",
  firestorePort: 8081,
  storageHost: "127.0.0.1",
  storagePort: 9199,
};

describe("Firebase 로컬 전용 설정", () => {
  it("demo-nodo와 고정 Emulator 주소만 허용한다", () => {
    expect(() => assertLocalFirebaseEnvironment(validEnvironment)).not.toThrow();
  });

  it("실제 클라우드 프로젝트 ID를 차단한다", () => {
    expect(() =>
      assertLocalFirebaseEnvironment({
        ...validEnvironment,
        projectId: "company-production-project",
      }),
    ).toThrow(/실제 클라우드 연결을 차단했습니다/);
  });

  it("Emulator 사용 설정이 꺼져 있으면 차단한다", () => {
    expect(() =>
      assertLocalFirebaseEnvironment({
        ...validEnvironment,
        useEmulators: false,
      }),
    ).toThrow(/Emulator 설정이 꺼져 있습니다/);
  });

  it("고정 로컬 주소가 아닌 서비스 연결을 차단한다", () => {
    expect(() =>
      assertLocalFirebaseEnvironment({
        ...validEnvironment,
        firestoreHost: "firestore.googleapis.com",
      }),
    ).toThrow(/Firestore 연결을 차단했습니다/);
  });

  it("개발 환경 밖에서는 초기화를 차단한다", () => {
    expect(() =>
      assertLocalFirebaseEnvironment({
        ...validEnvironment,
        isDevelopment: false,
      }),
    ).toThrow(/개발 환경의 로컬 Emulator/);
  });

  it("여러 번 초기화해도 같은 앱과 서비스 인스턴스를 반환한다", () => {
    const first = getLocalFirebaseServices();
    const second = getLocalFirebaseServices();

    expect(second.app).toBe(first.app);
    expect(second.auth).toBe(first.auth);
    expect(second.firestore).toBe(first.firestore);
    expect(second.storage).toBe(first.storage);
  });
});

describe("Firebase cloud-auth 설정", () => {
  const validCloudEnvironment = {
    VITE_FIREBASE_API_KEY: "test-api-key",
    VITE_FIREBASE_AUTH_DOMAIN: "test.firebaseapp.com",
    VITE_FIREBASE_PROJECT_ID: CLOUD_FIREBASE_PROJECT_ID,
    VITE_FIREBASE_STORAGE_BUCKET: "test.firebasestorage.app",
    VITE_FIREBASE_MESSAGING_SENDER_ID: "000000000000",
    VITE_FIREBASE_APP_ID: "1:000000000000:web:test",
  };

  it("고정 프로젝트와 필요한 웹 앱 설정이 모두 있을 때만 허용한다", () => {
    expect(readCloudFirebaseConfig(validCloudEnvironment)).toEqual({
      apiKey: "test-api-key",
      authDomain: "test.firebaseapp.com",
      projectId: CLOUD_FIREBASE_PROJECT_ID,
      storageBucket: "test.firebasestorage.app",
      messagingSenderId: "000000000000",
      appId: "1:000000000000:web:test",
    });
  });

  it("설정 누락과 다른 프로젝트를 앱 초기화 전에 차단한다", () => {
    expect(() =>
      readCloudFirebaseConfig({
        ...validCloudEnvironment,
        VITE_FIREBASE_API_KEY: "",
      }),
    ).toThrow(/VITE_FIREBASE_API_KEY/);
    expect(() =>
      readCloudFirebaseConfig({
        ...validCloudEnvironment,
        VITE_FIREBASE_PROJECT_ID: "another-project",
      }),
    ).toThrow(/허용되지 않은 Firebase 프로젝트/);
  });
});
