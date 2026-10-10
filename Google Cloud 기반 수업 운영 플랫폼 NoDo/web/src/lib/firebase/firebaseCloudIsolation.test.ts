import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  initializeApp: vi.fn(() => ({ name: "nodo-02-cloud-auth" })),
  getAuth: vi.fn(() => ({ name: "cloud-auth" })),
  getFirestore: vi.fn(),
  getStorage: vi.fn(),
}));

vi.mock("../../config/runtimeMode", () => ({ runtimeMode: "cloud-auth" }));
vi.mock("./firebaseConfig", () => ({
  getCloudFirebaseConfig: () => ({
    apiKey: "test",
    authDomain: "test.firebaseapp.com",
    projectId: "example-gcp-project",
    storageBucket: "test.firebasestorage.app",
    messagingSenderId: "0",
    appId: "test",
  }),
  localFirebaseEnvironment: {},
}));
vi.mock("firebase/app", () => ({
  getApps: () => [],
  initializeApp: serviceMocks.initializeApp,
}));
vi.mock("firebase/auth", () => ({
  connectAuthEmulator: vi.fn(),
  getAuth: serviceMocks.getAuth,
}));
vi.mock("firebase/firestore", () => ({ getFirestore: serviceMocks.getFirestore }));
vi.mock("firebase/storage", () => ({ getStorage: serviceMocks.getStorage }));

describe("cloud-auth Firebase 서비스 격리", () => {
  beforeEach(() => vi.clearAllMocks());

  it("App과 Authentication만 초기화하고 Firestore·Storage는 0회 유지한다", async () => {
    const { getFirebaseAuth } = await import("./firebaseAuth");

    expect(getFirebaseAuth()).toEqual({ name: "cloud-auth" });
    expect(serviceMocks.initializeApp).toHaveBeenCalledTimes(1);
    expect(serviceMocks.getAuth).toHaveBeenCalledTimes(1);
    expect(serviceMocks.getFirestore).not.toHaveBeenCalled();
    expect(serviceMocks.getStorage).not.toHaveBeenCalled();
  });
});

