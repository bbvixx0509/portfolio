import {
  browserLocalPersistence,
  browserSessionPersistence,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, requestApi } from "../../lib/api/apiClient";
import { runtimeMode, type NoDoRuntimeMode } from "../../config/runtimeMode";
import {
  getCloudFirebaseAuth,
  getLocalFirebaseAuth,
} from "../../lib/firebase/firebaseAuth";
import {
  CLOUD_FIREBASE_PROJECT_ID,
  getCloudFirebaseConfig,
} from "../../lib/firebase/firebaseConfig";
import {
  createAuthDiagnostics,
  isAuthDiagnosticsEnabled,
  resetAuthDiagnostics,
  updateAuthDiagnostic,
  type AuthDiagnosticStatus,
  type AuthDiagnostics,
} from "./authDiagnostics";
import {
  type AuthProfile,
  isAccountType,
} from "./authTypes";
import {
  AuthConflictError,
  clearStoredStudentSession,
  cloudUserKind,
  type CloudIdentityKind,
  normalizeStudentAuthSession,
  readStoredStudentSession,
  storeStudentSession,
  type StudentAuthSession,
  studentAuthErrorMessage,
  validateStudentNickname,
  validateStudentRoomCode,
} from "./studentAuth";

type JoinRoomResult = {
  roomId: string;
  nickname: string;
};

export type OrganizationInvitationSummary = {
  organizationName: string;
  expiresAt: string;
};

type AuthContextValue = {
  runtimeMode: NoDoRuntimeMode;
  user: User | null;
  profile: AuthProfile | null;
  organizationInvitation: OrganizationInvitationSummary | null;
  studentSession: StudentAuthSession | null;
  identityKind: CloudIdentityKind;
  isLoading: boolean;
  isBootstrappingOrganization: boolean;
  isGoogleRedirecting: boolean;
  googleLoginRecoveryAvailable: boolean;
  localApiRecoveryAvailable: boolean;
  authDiagnostics: AuthDiagnostics;
  isRestoringSession: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<AuthProfile>;
  loginWithGoogle: () => Promise<AuthProfile | null>;
  reconnectLocalApi: () => Promise<AuthProfile | null>;
  loginWithGoogleRedirect: () => Promise<void>;
  acceptOrganizationInvitation: () => Promise<AuthProfile>;
  startStudentSession: (
    roomCode: string,
    nickname: string,
  ) => Promise<StudentAuthSession>;
  endStudentSession: () => Promise<void>;
  joinRoom: (roomCode: string, nickname: string) => Promise<JoinRoomResult>;
  updateNickname: (roomId: string, nickname: string) => Promise<string>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<AuthProfile | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
let persistenceReady: Promise<void> | null = null;
const SESSION_EXPECTATION_KEY = "nodo.firebase-session";
export const GOOGLE_POPUP_TIMEOUT_MS = 45_000;
export const GOOGLE_POPUP_TIMEOUT_MESSAGE =
  "Google 인증 창이 완료되지 않았습니다. 로그인 창을 닫지 않았는지 확인한 뒤 다시 시도해 주세요.";
export const GOOGLE_AUTH_BOOTSTRAP_TIMEOUT_MS = 5_000;

function initialAuthDiagnostics() {
  const enabled = isAuthDiagnosticsEnabled({
    development: import.meta.env.DEV,
    runtimeMode,
    search: globalThis.location?.search ?? "",
  });
  if (!enabled) return createAuthDiagnostics({ enabled, hostname: undefined });

  try {
    return createAuthDiagnostics({
      enabled,
      hostname: globalThis.location?.hostname,
      firebaseConfig: getCloudFirebaseConfig(),
    });
  } catch {
    return createAuthDiagnostics({
      enabled,
      hostname: globalThis.location?.hostname,
    });
  }
}

function hasSessionExpectation() {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_EXPECTATION_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberSession() {
  try {
    globalThis.sessionStorage?.setItem(SESSION_EXPECTATION_KEY, "1");
  } catch {
    // 저장소를 사용할 수 없어도 현재 탭 인증은 계속 사용할 수 있다.
  }
}

function forgetSession() {
  try {
    globalThis.sessionStorage?.removeItem(SESSION_EXPECTATION_KEY);
  } catch {
    // 저장소를 사용할 수 없어도 Firebase 로그아웃은 계속 진행한다.
  }
}

function ensureSessionPersistence() {
  if (!persistenceReady) {
    persistenceReady = setPersistence(
      getLocalFirebaseAuth(),
      browserSessionPersistence,
    );
  }
  return persistenceReady;
}

function setCloudStaffPersistence() {
  return setPersistence(getCloudFirebaseAuth(), browserLocalPersistence);
}

function setCloudStudentPersistence() {
  return setPersistence(getCloudFirebaseAuth(), browserSessionPersistence);
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

export function normalizeAuthProfile(
  payload: unknown,
  firebaseUser?: User | null,
): AuthProfile {
  const root =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const nested =
    root.user && typeof root.user === "object"
      ? (root.user as Record<string, unknown>)
      : root.me && typeof root.me === "object"
        ? (root.me as Record<string, unknown>)
        : root;
  const accountType = nested.accountType;
  if (!isAccountType(accountType)) {
    throw new Error("서버가 반환한 사용자 계정 유형을 확인할 수 없습니다.");
  }
  const organizationRole = nested.organizationRole;
  if (
    accountType === "STAFF" &&
    organizationRole !== "ADMIN" &&
    organizationRole !== "INSTRUCTOR"
  ) {
    throw new Error("서버가 반환한 조직 역할 정보를 확인할 수 없습니다.");
  }

  const uid = readString(nested, "uid", "userId") ?? firebaseUser?.uid;
  const orgId = readString(nested, "orgId");
  if (!uid || !orgId) {
    throw new Error("서버가 반환한 사용자 식별 정보가 올바르지 않습니다.");
  }

  const nickname = readString(nested, "nickname") ?? null;
  return {
    uid,
    orgId,
    accountType,
    organizationRole:
      organizationRole === "ADMIN" || organizationRole === "INSTRUCTOR"
        ? organizationRole
        : undefined,
    isAdmin: organizationRole === "ADMIN",
    email: readString(nested, "email") ?? firebaseUser?.email ?? null,
    displayName:
      readString(nested, "displayName", "name") ?? nickname ?? "NoDo 사용자",
    nickname,
  };
}

export function normalizeCloudAuthProfile(
  payload: unknown,
  firebaseUser: User,
): AuthProfile {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};

  if (
    record.authorized !== true ||
    record.accountType !== "STAFF" ||
    (record.organizationRole !== "ADMIN" && record.organizationRole !== "INSTRUCTOR") ||
    record.isAdmin !== (record.organizationRole === "ADMIN") ||
    record.isAnonymous !== false ||
    record.provider !== "google.com" ||
    record.emailVerified !== true
  ) {
    throw new Error("이 계정에는 NoDo 조직 접근 권한이 없습니다.");
  }

  const uid = readString(record, "uid");
  const orgId = readString(record, "orgId");
  const email = readString(record, "email");
  if (!uid || uid !== firebaseUser.uid || !orgId || !email) {
    throw new Error("서버가 확인한 Google 계정 정보가 일치하지 않습니다.");
  }

  return {
    uid,
    orgId,
    accountType: "STAFF",
    organizationRole: record.organizationRole,
    isAdmin: record.isAdmin,
    authorized: true,
    email,
    displayName:
      readString(record, "displayName") ??
      firebaseUser.displayName ??
      "NoDo 회사 직원",
    nickname: null,
    photoURL: readString(record, "photoURL") ?? firebaseUser.photoURL,
  };
}

const ORGANIZATION_BOOTSTRAP_REQUIRED =
  "ORGANIZATION_BOOTSTRAP_REQUIRED";
const ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED =
  "ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED";

export function isOrganizationBootstrapRequiredError(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  const details = error.details;
  return Boolean(
    details &&
      typeof details === "object" &&
      (details as Record<string, unknown>).code ===
        ORGANIZATION_BOOTSTRAP_REQUIRED,
  );
}

export function organizationInvitationFromError(
  error: unknown,
): OrganizationInvitationSummary | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = error.details;
  if (!details || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  if (record.code !== ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED) return null;
  if (
    typeof record.organizationName !== "string" ||
    !record.organizationName.trim() ||
    typeof record.expiresAt !== "string" ||
    Number.isNaN(Date.parse(record.expiresAt))
  ) {
    return null;
  }
  return {
    organizationName: record.organizationName.trim(),
    expiresAt: record.expiresAt,
  };
}

function firebaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isFetchTransportError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /failed to fetch|networkerror|load failed/i.test(error.message);
}

function isRetryableGoogleVerificationError(error: unknown) {
  if (error instanceof ApiError) {
    return error.status === 0 || error.status === 401;
  }
  return firebaseErrorCode(error) === "auth/network-request-failed" ||
    isFetchTransportError(error);
}

function isLocalApiConnectionFailure(error: unknown) {
  if (!isLocalCloudApiRecoveryEnabled()) return false;
  if (error instanceof ApiError) {
    const code =
      error.details && typeof error.details === "object"
        ? (error.details as Record<string, unknown>).code
        : null;
    if (code === "ID_TOKEN_UNAVAILABLE") return false;
    return error.status === 0 || [502, 503, 504].includes(error.status);
  }
  return isFetchTransportError(error);
}

const loadLocalCloudApiHealth = import.meta.env.DEV
  ? () => import("./localCloudApiHealth")
  : null;

const LOCAL_API_RECOVERY_ERROR_MESSAGE =
  "로컬 서버에 연결할 수 없습니다. FastAPI 8082 실행 상태를 확인해 주세요.";

function isLocalCloudApiRecoveryEnabled() {
  return Boolean(
    loadLocalCloudApiHealth &&
      runtimeMode === "cloud-auth" &&
      globalThis.location?.hostname === "localhost",
  );
}

async function checkLocalCloudApiHealth() {
  if (!loadLocalCloudApiHealth) return;
  const localHealth = await loadLocalCloudApiHealth();
  await localHealth.checkLocalCloudApiHealth();
}

class GooglePopupTimeoutError extends Error {
  constructor() {
    super(GOOGLE_POPUP_TIMEOUT_MESSAGE);
    this.name = "GooglePopupTimeoutError";
  }
}

function waitForGooglePopup<T>(popupResult: Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(
      () => reject(new GooglePopupTimeoutError()),
      GOOGLE_POPUP_TIMEOUT_MS,
    );
    popupResult.then(
      (result) => {
        globalThis.clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function googleAuthErrorMessage(error: unknown) {
  if (error instanceof GooglePopupTimeoutError) return error.message;
  if (error instanceof ApiError) {
    const details = error.details;
    const code =
      details && typeof details === "object"
        ? (details as Record<string, unknown>).code
        : null;
    if (code === "ID_TOKEN_UNAVAILABLE") {
      return "Google 로그인 정보 확인에 실패했습니다. 다시 로그인해 주세요.";
    }
    if (error.status === 401) {
      return "로그인 세션을 다시 확인해 주세요.";
    }
    if (error.status === 403) {
      return "승인된 회사 Google 계정으로 로그인해 주세요.";
    }
    if (error.status === 500) {
      return "권한 확인 중 서버 오류가 발생했습니다.";
    }
    if (error.status === 409) {
      if (code === "invitation_expired") {
        return "조직 로그인 승인이 만료되었습니다. 관리자에게 새 승인을 요청해 주세요.";
      }
      return "조직 로그인 승인 또는 역할 전환 확인이 필요합니다. 관리자에게 문의해 주세요.";
    }
  }
  switch (firebaseErrorCode(error)) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google 로그인이 취소되었습니다.";
    case "auth/popup-blocked":
      return "브라우저에서 로그인 팝업이 차단되었습니다. 주소창에서 팝업을 허용한 뒤 다시 시도해 주세요.";
    case "auth/network-request-failed":
      return "네트워크 연결을 확인한 뒤 다시 시도해 주세요.";
    case "auth/unauthorized-domain":
      return "현재 접속 주소가 Firebase 승인 도메인과 일치하지 않습니다.";
    case "auth/account-exists-with-different-credential":
      return "같은 이메일이 다른 로그인 방식에 연결되어 있습니다.";
    default:
      return isFetchTransportError(error)
        ? "인증 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."
        : messageFromError(error);
  }
}

function authDiagnosticFailureDetail(error: unknown) {
  if (error instanceof GooglePopupTimeoutError) return "45초 시간 초과";
  if (error instanceof ApiError) {
    if (error.status === 0) return "ID_TOKEN_UNAVAILABLE";
    return `HTTP ${error.status}`;
  }
  switch (firebaseErrorCode(error)) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/popup-blocked":
    case "auth/unauthorized-domain":
    case "auth/network-request-failed":
      return firebaseErrorCode(error) ?? "Firebase 오류";
    default:
      return "확인 실패";
  }
}

export function shouldClearAnonymousObserverLoading(
  joinInProgress: boolean,
) {
  return !joinInProgress;
}

function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "인증 요청을 처리하지 못했습니다.";
}

class StaleStudentVerificationError extends Error {
  constructor() {
    super("학생 참여 상태가 변경되었습니다.");
    this.name = "StaleStudentVerificationError";
  }
}

class StaleStaffVerificationError extends Error {
  constructor() {
    super("Google 인증 상태가 변경되었습니다.");
    this.name = "StaleStaffVerificationError";
  }
}

function EmulatorAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRestoringSession, setIsRestoringSession] = useState(
    hasSessionExpectation,
  );
  const [error, setError] = useState<string | null>(null);
  const joinInProgressRef = useRef(false);

  const loadProfile = useCallback(async (authUser: User | null) => {
    if (!authUser) {
      setProfile(null);
      return null;
    }
    const payload = await requestApi<unknown>("/api/me", { authUser });
    const nextProfile = normalizeAuthProfile(payload, authUser);
    setProfile(nextProfile);
    return nextProfile;
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => undefined;

    void ensureSessionPersistence()
      .then(() => {
        if (!active) {
          return;
        }
        unsubscribe = onAuthStateChanged(
          getLocalFirebaseAuth(),
          (nextUser) => {
            if (!active) {
              return;
            }
            setUser(nextUser);
            if (!nextUser) {
              forgetSession();
              setProfile(null);
              setIsRestoringSession(false);
              setIsLoading(false);
              return;
            }
            // 익명 사용자는 join API가 users/participants 문서를 만든 뒤에만
            // /api/me를 조회할 수 있다. Auth observer의 선행 호출을 막는다.
            if (nextUser.isAnonymous) {
              if (!shouldClearAnonymousObserverLoading(joinInProgressRef.current)) {
                return;
              }
              void loadProfile(nextUser)
                .catch((nextError: unknown) => {
                  if (active) {
                    setError(messageFromError(nextError));
                    setProfile(null);
                  }
                })
                .finally(() => {
                  if (active) {
                    setIsRestoringSession(false);
                    setIsLoading(false);
                  }
                });
              return;
            }
            void loadProfile(nextUser)
              .catch((nextError: unknown) => {
                if (active) {
                  setError(messageFromError(nextError));
                  setProfile(null);
                }
              })
              .finally(() => {
                if (active) {
                  setIsRestoringSession(false);
                  setIsLoading(false);
                }
              });
          },
          (nextError) => {
            if (active) {
              setError(nextError.message);
              setIsRestoringSession(false);
              setIsLoading(false);
            }
          },
        );
      })
      .catch((nextError: unknown) => {
        if (active) {
          setError(messageFromError(nextError));
          setIsRestoringSession(false);
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [loadProfile]);

  const login = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setIsLoading(true);
      try {
        await ensureSessionPersistence();
        const credential = await signInWithEmailAndPassword(
          getLocalFirebaseAuth(),
          email,
          password,
        );
        setUser(credential.user);
        const nextProfile = await loadProfile(credential.user);
        if (!nextProfile) {
          throw new Error("로그인한 사용자 정보를 확인할 수 없습니다.");
        }
        rememberSession();
        return nextProfile;
      } catch (nextError) {
        const message = messageFromError(nextError);
        setError(message);
        throw nextError;
      } finally {
        setIsLoading(false);
      }
    },
    [loadProfile],
  );

  const joinRoom = useCallback(
    async (roomCode: string, nickname: string) => {
      if (joinInProgressRef.current) {
        throw new Error("강의방 입장 요청이 이미 진행 중입니다.");
      }
      setError(null);
      setIsLoading(true);
      joinInProgressRef.current = true;
      let anonymousUser: User | null = null;
      try {
        await ensureSessionPersistence();
        const credential = await signInAnonymously(getLocalFirebaseAuth());
        anonymousUser = credential.user;
        setUser(credential.user);
        const response = await requestApi<Record<string, unknown>>(
          "/api/rooms/join",
          {
            method: "POST",
            body: { roomCode, nickname },
            authUser: credential.user,
          },
        );
        rememberSession();
        const joinedProfile = await loadProfile(credential.user);
        const room =
          response.room && typeof response.room === "object"
            ? (response.room as Record<string, unknown>)
            : response;
        const roomId = readString(room, "roomId", "id");
        if (!roomId) {
          throw new Error("입장한 강의방 ID를 확인할 수 없습니다.");
        }
        const joinedNickname = readString(response, "nickname") ?? nickname;
        if (joinedProfile) {
          setProfile({
            ...joinedProfile,
            nickname: joinedNickname,
            displayName: joinedNickname,
          });
        }
        return {
          roomId,
          nickname: joinedNickname,
        };
      } catch (nextError) {
        forgetSession();
        if (
          anonymousUser &&
          getLocalFirebaseAuth().currentUser?.uid === anonymousUser.uid
        ) {
          await Promise.resolve(signOut(getLocalFirebaseAuth())).catch(
            () => undefined,
          );
          setUser(null);
          setProfile(null);
        }
        const message = messageFromError(nextError);
        setError(message);
        throw nextError;
      } finally {
        joinInProgressRef.current = false;
        setIsLoading(false);
      }
    },
    [loadProfile],
  );

  const updateNickname = useCallback(
    async (roomId: string, nickname: string) => {
      const response = await requestApi<Record<string, unknown>>(
        `/api/rooms/${encodeURIComponent(roomId)}/participants/me`,
        { method: "PUT", body: { nickname }, authUser: user },
      );
      const nextNickname = readString(response, "nickname") ?? nickname;
      setProfile((current) =>
        current
          ? { ...current, nickname: nextNickname, displayName: nextNickname }
          : current,
      );
      return nextNickname;
    },
    [user],
  );

  const logout = useCallback(async () => {
    setError(null);
    await signOut(getLocalFirebaseAuth());
    forgetSession();
    setUser(null);
    setProfile(null);
  }, []);

  const refreshProfile = useCallback(
    () => loadProfile(getLocalFirebaseAuth().currentUser),
    [loadProfile],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      runtimeMode: "emulator",
      user,
      profile,
      organizationInvitation: null,
      studentSession: null,
      identityKind: isLoading
        ? "loading"
        : user?.isAnonymous
          ? "student"
          : user
            ? "staff"
            : "signed-out",
      isLoading,
      isBootstrappingOrganization: false,
      isGoogleRedirecting: false,
      googleLoginRecoveryAvailable: false,
      localApiRecoveryAvailable: false,
      authDiagnostics: { enabled: false, steps: [] },
      isRestoringSession,
      error,
      login,
      loginWithGoogle: async () => {
        throw new Error("Google 로그인은 cloud-auth 모드에서만 사용할 수 있습니다.");
      },
      reconnectLocalApi: async () => {
        throw new Error("로컬 서버 재연결은 cloud-auth 개발 모드에서만 사용할 수 있습니다.");
      },
      loginWithGoogleRedirect: async () => {
        throw new Error("Google 로그인은 cloud-auth 모드에서만 사용할 수 있습니다.");
      },
      acceptOrganizationInvitation: async () => {
        throw new Error("조직 가입은 cloud-auth 모드에서만 사용할 수 있습니다.");
      },
      startStudentSession: async () => {
        throw new Error("학생 참여 확인은 cloud-auth 모드에서만 사용할 수 있습니다.");
      },
      endStudentSession: async () => {
        throw new Error("학생 참여 확인은 cloud-auth 모드에서만 사용할 수 있습니다.");
      },
      joinRoom,
      updateNickname,
      logout,
      refreshProfile,
    }),
    [
      error,
      isLoading,
      isRestoringSession,
      joinRoom,
      login,
      logout,
      profile,
      refreshProfile,
      updateNickname,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function CloudAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [organizationInvitation, setOrganizationInvitation] =
    useState<OrganizationInvitationSummary | null>(null);
  const [studentSession, setStudentSession] = useState<StudentAuthSession | null>(null);
  const [identityKind, setIdentityKind] = useState<CloudIdentityKind>("loading");
  const [isLoading, setIsLoading] = useState(true);
  const [isBootstrappingOrganization, setIsBootstrappingOrganization] =
    useState(false);
  const [isGoogleRedirecting, setIsGoogleRedirecting] = useState(false);
  const [googleLoginRecoveryAvailable, setGoogleLoginRecoveryAvailable] =
    useState(false);
  const [localApiRecoveryAvailable, setLocalApiRecoveryAvailable] =
    useState(false);
  const [authDiagnostics, setAuthDiagnostics] = useState<AuthDiagnostics>(
    initialAuthDiagnostics,
  );
  const [error, setError] = useState<string | null>(null);
  const googleLoginAttemptRef = useRef(0);
  const activeGooglePopupAttemptRef = useRef<number | null>(null);
  const expiredGooglePopupAttemptRef = useRef<number | null>(null);
  const observedGooglePopupUserRef = useRef<{
    attempt: number;
    resolve: (user: User) => void;
  } | null>(null);
  const acceptedGoogleLoginAttemptRef = useRef(0);
  const pendingRedirectUserRef = useRef<User | null>(null);
  const studentJoinInProgressRef = useRef(false);
  const studentRequestGenerationRef = useRef(0);
  const staffVerificationGenerationRef = useRef(0);
  const diagnosticAttemptRef = useRef(0);

  const updateDiagnostic = useCallback(
    (
      id: Parameters<typeof updateAuthDiagnostic>[1],
      status: AuthDiagnosticStatus,
      detail: string,
      attempt?: number,
    ) => {
      if (attempt !== undefined && diagnosticAttemptRef.current !== attempt) return;
      setAuthDiagnostics((current) =>
        updateAuthDiagnostic(current, id, status, detail),
      );
    },
    [],
  );

  const beginGoogleDiagnostic = useCallback((attempt: number) => {
    diagnosticAttemptRef.current = attempt;
    setAuthDiagnostics((current) => resetAuthDiagnostics(current));
  }, []);

  const verifyUser = useCallback(async (
    authUser: User,
    skipLocalHealthCheck = false,
  ) => {
    const generation = staffVerificationGenerationRef.current + 1;
    staffVerificationGenerationRef.current = generation;
    setIsBootstrappingOrganization(false);

    const assertCurrentStaffUser = () => {
      const currentUser = getCloudFirebaseAuth().currentUser;
      if (
        staffVerificationGenerationRef.current !== generation ||
        !currentUser ||
        currentUser.uid !== authUser.uid ||
        cloudUserKind(currentUser) !== "staff"
      ) {
        throw new StaleStaffVerificationError();
      }
    };

    const diagnosticAttempt = googleLoginAttemptRef.current || undefined;
    const requestProfile = async (idTokenSuccessDetail = "확인됨") => {
      updateDiagnostic("profile-request", "pending", "요청 시작", diagnosticAttempt);
      try {
        const payload = await requestApi<unknown>("/api/auth/me", {
          authUser,
          onIdTokenStatus: (status) =>
            updateDiagnostic(
              "id-token",
              status,
              status === "success" ? idTokenSuccessDetail : "확인 실패",
              diagnosticAttempt,
            ),
        });
        updateDiagnostic("profile-request", "success", "요청 전송됨", diagnosticAttempt);
        updateDiagnostic("profile-response", "success", "HTTP 200", diagnosticAttempt);
        assertCurrentStaffUser();
        return payload;
      } catch (profileError) {
        const detail = authDiagnosticFailureDetail(profileError);
        updateDiagnostic("profile-request", "failure", detail, diagnosticAttempt);
        updateDiagnostic("profile-response", "failure", detail, diagnosticAttempt);
        throw profileError;
      }
    };
    const activateApprovedStaff = async () => {
      updateDiagnostic(
        "organization-role",
        "pending",
        "조직 로그인 승인 활성화 중",
        diagnosticAttempt,
      );
      const activated = await requestApi<unknown>(
        "/api/auth/accept-organization-invitation",
        { method: "POST", authUser },
      );
      assertCurrentStaffUser();
      updateDiagnostic(
        "organization-role",
        "success",
        "조직 로그인 승인 활성화 완료",
        diagnosticAttempt,
      );
      return activated;
    };

    assertCurrentStaffUser();
    if (!skipLocalHealthCheck) {
      await checkLocalCloudApiHealth();
      assertCurrentStaffUser();
    }
    let payload: unknown = null;
    let profileError: unknown | null = null;
    let refreshedTokenDetail: string;
    try {
      payload = await requestProfile();
    } catch (initialProfileError) {
      profileError = initialProfileError;
    }

    if (profileError instanceof ApiError && profileError.status === 401) {
      assertCurrentStaffUser();
      // Firebase의 로컬 세션은 유효하지만 캐시된 ID Token이 FastAPI에서 거부될 수
      // 있다. 새 토큰을 한 번만 확인해 같은 STAFF 세션으로 재시도한다.
      updateDiagnostic("id-token", "pending", "새 토큰 확인 중", diagnosticAttempt);
      try {
        const refreshedToken = await authUser.getIdTokenResult(true);
        const claims = refreshedToken.claims as Record<string, unknown>;
        const projectMatches =
          claims.aud === CLOUD_FIREBASE_PROJECT_ID &&
          claims.iss === `https://securetoken.google.com/${CLOUD_FIREBASE_PROJECT_ID}`;
        refreshedTokenDetail = projectMatches
          ? "새 토큰·프로젝트 일치"
          : "새 토큰·프로젝트 불일치";
        updateDiagnostic(
          "id-token",
          "success",
          refreshedTokenDetail,
          diagnosticAttempt,
        );
      } catch (tokenRefreshError) {
        updateDiagnostic("id-token", "failure", "새 토큰 확인 실패", diagnosticAttempt);
        throw tokenRefreshError;
      }
      assertCurrentStaffUser();
      try {
        payload = await requestProfile(refreshedTokenDetail);
        profileError = null;
      } catch (refreshedProfileError) {
        profileError = refreshedProfileError;
      }
    }

    if (profileError) {
      assertCurrentStaffUser();
      const invitation = organizationInvitationFromError(profileError);
      if (invitation) {
        payload = await activateApprovedStaff();
        profileError = null;
      }
      if (profileError && !isOrganizationBootstrapRequiredError(profileError)) {
        throw profileError;
      }

      if (profileError) {
        setIsBootstrappingOrganization(true);
        try {
          await requestApi<unknown>("/api/auth/bootstrap-organization", {
            method: "POST",
            authUser,
          });
          assertCurrentStaffUser();
          payload = await requestProfile();
        } catch (bootstrapError) {
          assertCurrentStaffUser();
          const bootstrapInvitation =
            organizationInvitationFromError(bootstrapError);
          if (bootstrapInvitation) {
            payload = await activateApprovedStaff();
          } else {
            throw bootstrapError;
          }
        } finally {
          if (staffVerificationGenerationRef.current === generation) {
            setIsBootstrappingOrganization(false);
          }
        }
      }
    }

    assertCurrentStaffUser();
    const nextProfile = normalizeCloudAuthProfile(payload, authUser);
    assertCurrentStaffUser();
    setProfile(nextProfile);
    setOrganizationInvitation(null);
    setStudentSession(null);
    setIdentityKind("staff");
    updateDiagnostic(
      "organization-role",
      "success",
      nextProfile.organizationRole === "ADMIN" ? "관리자" : "일반 강사",
      diagnosticAttempt,
    );
    updateDiagnostic("final-result", "success", "로그인 성공", diagnosticAttempt);
    return nextProfile;
  }, [updateDiagnostic]);

  const requestStudentSession = useCallback(
    async (authUser: User, input: { roomCode: string; nickname: string }) => {
      const payload = await requestApi<unknown>("/api/auth/student-session", {
        method: "POST",
        body: input,
        authUser,
      });
      return normalizeStudentAuthSession(payload);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => undefined;
    let authStateObserved = false;
    let authStateFallbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

    const markAuthStateObserved = () => {
      authStateObserved = true;
      if (authStateFallbackTimer !== null) {
        globalThis.clearTimeout(authStateFallbackTimer);
        authStateFallbackTimer = null;
      }
    };

    // 리디렉션 결과보다 먼저 observer를 등록한다. Google 복귀 후 결과 처리가
    // 느려도 Firebase 사용자를 놓치지 않고 권한 검증을 시작할 수 있어야 한다.
    let handledAuthUserUid: string | null = null;
    const handleAuthState = (nextUser: User | null) => {
            if (!active) return;
            markAuthStateObserved();
            updateDiagnostic(
              "auth-state",
              "success",
              nextUser ? "사용자 상태 수신됨" : "로그아웃 상태 수신됨",
              googleLoginAttemptRef.current || undefined,
            );
            const nextUserUid = nextUser?.uid ?? null;
            if (nextUserUid !== null && handledAuthUserUid === nextUserUid) return;
            handledAuthUserUid = nextUserUid;
            staffVerificationGenerationRef.current += 1;
            setIsBootstrappingOrganization(false);
            setUser(nextUser);
            setOrganizationInvitation(null);
            if (!nextUser) {
              studentRequestGenerationRef.current += 1;
              setProfile(null);
              setStudentSession(null);
              setIdentityKind("signed-out");
              setIsLoading(false);
              return;
            }

            const nextIdentity = cloudUserKind(nextUser);
            if (nextIdentity === "unsupported") {
              studentRequestGenerationRef.current += 1;
              setProfile(null);
              setStudentSession(null);
              setIdentityKind("unsupported");
              setError("현재 로그인 상태로는 NoDo를 사용할 수 없습니다.");
              setIsLoading(false);
              return;
            }

            const activePopupAttempt = activeGooglePopupAttemptRef.current;
            const observedPopupUser = observedGooglePopupUserRef.current;
            if (
              nextIdentity === "staff" &&
              activePopupAttempt !== null &&
              observedPopupUser?.attempt === activePopupAttempt
            ) {
              // 일부 Chrome 환경에서는 popup 창이 정상적으로 닫힌 뒤에도
              // signInWithPopup Promise가 끝나지 않는다. Firebase observer가
              // 받은 같은 시도의 STAFF 사용자는 ID Token과 FastAPI 권한 검증을
              // 시작할 수 있는 안전한 반환 신호다.
              updateDiagnostic("firebase-user", "success", "사용자 확인됨", activePopupAttempt);
              observedPopupUser.resolve(nextUser);
              return;
            }

            setIsLoading(true);
            setIdentityKind(nextIdentity === "staff" ? "loading" : "student");
            if (nextIdentity === "student") {
              setProfile(null);
              if (studentJoinInProgressRef.current) return;

              const storedSession = readStoredStudentSession();
              if (!storedSession) {
                setStudentSession(null);
                setError(null);
                setIsLoading(false);
                return;
              }

              const generation = studentRequestGenerationRef.current + 1;
              studentRequestGenerationRef.current = generation;
              const expectedUid = nextUser.uid;
              void requestStudentSession(nextUser, storedSession)
                .then((nextSession) => {
                  if (
                    !active ||
                    studentRequestGenerationRef.current !== generation ||
                    getCloudFirebaseAuth().currentUser?.uid !== expectedUid
                  ) {
                    throw new StaleStudentVerificationError();
                  }
                  setProfile(null);
                  setStudentSession(nextSession);
                  setIdentityKind("student");
                  setError(null);
                })
                .catch(async (verificationError: unknown) => {
                  if (!active) return;
                  if (verificationError instanceof StaleStudentVerificationError) return;
                  if (
                    studentRequestGenerationRef.current !== generation ||
                    getCloudFirebaseAuth().currentUser?.uid !== expectedUid
                  ) return;
                  setError(studentAuthErrorMessage(verificationError));
                  try {
                    await signOut(getCloudFirebaseAuth());
                    if (getCloudFirebaseAuth().currentUser) return;
                    clearStoredStudentSession();
                    if (!active) return;
                    setStudentSession(null);
                    setUser(null);
                    setIdentityKind("signed-out");
                  } catch {
                    if (
                      !active ||
                      studentRequestGenerationRef.current !== generation ||
                      getCloudFirebaseAuth().currentUser?.uid !== expectedUid
                    ) return;
                    setUser(getCloudFirebaseAuth().currentUser);
                    setIdentityKind("student");
                  }
                })
                .finally(() => {
                  if (
                    active &&
                    studentRequestGenerationRef.current === generation
                  ) setIsLoading(false);
                });
              return;
            }

            studentRequestGenerationRef.current += 1;
            setStudentSession(null);
            clearStoredStudentSession();
            updateDiagnostic("firebase-user", "success", "사용자 확인됨");
            if (activeGooglePopupAttemptRef.current !== null) return;
            if (expiredGooglePopupAttemptRef.current !== null) return;
            setGoogleLoginRecoveryAvailable(false);
            setLocalApiRecoveryAvailable(false);
            const redirectUser = pendingRedirectUserRef.current;
            const verificationUser =
              redirectUser?.uid === nextUser.uid ? redirectUser : nextUser;
            if (redirectUser?.uid === nextUser.uid) {
              pendingRedirectUserRef.current = null;
            }
            const expectedUid = verificationUser.uid;
            void verifyUser(verificationUser)
              .then(() => {
                if (active) setError(null);
              })
              .catch(async (verificationError: unknown) => {
                if (!active) return;
                if (verificationError instanceof StaleStaffVerificationError) {
                  return;
                }
                if (
                  getCloudFirebaseAuth().currentUser?.uid !== expectedUid
                ) {
                  return;
                }
                updateDiagnostic(
                  "final-result",
                  "failure",
                  authDiagnosticFailureDetail(verificationError),
                );
                const localApiFailure = isLocalApiConnectionFailure(verificationError);
                setError(
                  localApiFailure
                    ? LOCAL_API_RECOVERY_ERROR_MESSAGE
                    : googleAuthErrorMessage(verificationError),
                );
                setProfile(null);
                // FastAPI 권한 확인 실패는 Firebase 로그아웃 신호가 아니다.
                // 네트워크·일시 서버 오류나 자료 탭 진입 중의 재확인 실패가
                // 유효한 Google STAFF 세션까지 지우면 안 된다. 실제 세션 종료는
                // onAuthStateChanged(null) 또는 명시적 logout만 처리한다.
                setIdentityKind("staff-verification-failed");
                setLocalApiRecoveryAvailable(localApiFailure);
                setGoogleLoginRecoveryAvailable(
                  !localApiFailure &&
                    isRetryableGoogleVerificationError(verificationError),
                );
              })
              .finally(() => {
                const currentUser = getCloudFirebaseAuth().currentUser;
                if (
                  active &&
                  (!currentUser || currentUser.uid === expectedUid)
                ) {
                  setIsLoading(false);
                }
              });
    };

    unsubscribe = onAuthStateChanged(
      getCloudFirebaseAuth(),
      handleAuthState,
      (observerError) => {
            if (!active) return;
            markAuthStateObserved();
            staffVerificationGenerationRef.current += 1;
            studentRequestGenerationRef.current += 1;
            setIsBootstrappingOrganization(false);
            updateDiagnostic(
              "final-result",
              "failure",
              authDiagnosticFailureDetail(observerError),
            );
            setError(googleAuthErrorMessage(observerError));
            setProfile(null);
            setOrganizationInvitation(null);
            setStudentSession(null);
            setIdentityKind("signed-out");
            setIsLoading(false);
      },
    );

    authStateFallbackTimer = globalThis.setTimeout(() => {
      if (!active || authStateObserved) return;
      setProfile(null);
      setStudentSession(null);
      setIdentityKind("signed-out");
      setIsGoogleRedirecting(false);
      setIsLoading(false);
    }, GOOGLE_AUTH_BOOTSTRAP_TIMEOUT_MS);

    void (async () => {
      try {
        const redirectCredential = await getRedirectResult(getCloudFirebaseAuth());
        if (!active) return;
        updateDiagnostic("firebase-initialization", "success", "초기화 완료");
        updateDiagnostic(
          "redirect-result",
          "success",
          redirectCredential?.user ? "사용자 결과 확인" : "결과 없음(정상)",
        );
        if (redirectCredential?.user) {
          pendingRedirectUserRef.current = redirectCredential.user;
          updateDiagnostic("firebase-user", "success", "사용자 확인됨");
          setIsGoogleRedirecting(false);
          // 일부 브라우저는 초기 null observer 뒤에 redirect 사용자를 다시 알리지
          // 않는다. 반환된 credential을 같은 검증 경로로 직접 전달한다.
          if (handledAuthUserUid !== redirectCredential.user.uid) {
            handleAuthState(redirectCredential.user);
          }
        }
      } catch (initializationError) {
        if (!active) return;
        staffVerificationGenerationRef.current += 1;
        studentRequestGenerationRef.current += 1;
        setIsBootstrappingOrganization(false);
        updateDiagnostic(
          "firebase-initialization",
          "failure",
          authDiagnosticFailureDetail(initializationError),
        );
        updateDiagnostic(
          "final-result",
          "failure",
          authDiagnosticFailureDetail(initializationError),
        );
        setError(googleAuthErrorMessage(initializationError));
        // 로그인 전 Firebase 초기화가 일시적으로 실패한 경우에도 원문 오류를
        // 노출하지 않고, 사용자가 명시적으로 Google 로그인 흐름을 다시 시작할
        // 수 있게 한다. 이 상태는 Firebase signOut 신호가 아니다.
        setGoogleLoginRecoveryAvailable(true);
        setProfile(null);
        setOrganizationInvitation(null);
        setStudentSession(null);
        setIdentityKind("signed-out");
        setIsLoading(false);
      }
    })();

    return () => {
      active = false;
      if (authStateFallbackTimer !== null) {
        globalThis.clearTimeout(authStateFallbackTimer);
      }
      unsubscribe();
    };
  }, [requestStudentSession, updateDiagnostic, verifyUser]);

  const retryExistingStaffSession = useCallback(
    async (currentUser: User, skipLocalHealthCheck = false) => {
      const auth = getCloudFirebaseAuth();
      const attempt = googleLoginAttemptRef.current + 1;
      googleLoginAttemptRef.current = attempt;
      beginGoogleDiagnostic(attempt);
      updateDiagnostic("button-click", "success", "기존 세션 재시도", attempt);
      activeGooglePopupAttemptRef.current = null;
      expiredGooglePopupAttemptRef.current = null;
      setError(null);
      setGoogleLoginRecoveryAvailable(false);
      setLocalApiRecoveryAvailable(false);
      setIsGoogleRedirecting(false);
      setIsLoading(true);
      setIdentityKind("loading");
      setUser(currentUser);
      setIsBootstrappingOrganization(false);

      try {
        const nextProfile = await verifyUser(currentUser, skipLocalHealthCheck);
        acceptedGoogleLoginAttemptRef.current = attempt;
        setError(null);
        return nextProfile;
      } catch (verificationError) {
        if (verificationError instanceof StaleStaffVerificationError) return null;
        if (auth.currentUser?.uid !== currentUser.uid) return null;
        const localApiFailure = isLocalApiConnectionFailure(verificationError);
        const message = localApiFailure
          ? LOCAL_API_RECOVERY_ERROR_MESSAGE
          : googleAuthErrorMessage(verificationError);
        updateDiagnostic(
          "final-result",
          "failure",
          authDiagnosticFailureDetail(verificationError),
          attempt,
        );
        setError(message);
        setProfile(null);
        setIdentityKind("staff-verification-failed");
        setLocalApiRecoveryAvailable(localApiFailure);
        setGoogleLoginRecoveryAvailable(
          !localApiFailure &&
            isRetryableGoogleVerificationError(verificationError),
        );
        throw new Error(message, { cause: verificationError });
      } finally {
        const activeUser = auth.currentUser;
        if (!activeUser || activeUser.uid === currentUser.uid) {
          setIsLoading(false);
        }
      }
    },
    [beginGoogleDiagnostic, updateDiagnostic, verifyUser],
  );

  const reconnectLocalApi = useCallback(async () => {
    const auth = getCloudFirebaseAuth();
    const currentUser = auth.currentUser;
    if (!currentUser || cloudUserKind(currentUser) !== "staff") {
      throw new Error("다시 확인할 Google 로그인 세션이 없습니다.");
    }

    setError(null);
    setLocalApiRecoveryAvailable(false);
    try {
      // The recovery action must not re-open Google or sign the user out.
      await checkLocalCloudApiHealth();
    } catch (healthError) {
      if (auth.currentUser?.uid === currentUser.uid) {
        setError(LOCAL_API_RECOVERY_ERROR_MESSAGE);
        setProfile(null);
        setIdentityKind("staff-verification-failed");
        setLocalApiRecoveryAvailable(true);
        setGoogleLoginRecoveryAvailable(false);
      }
      throw new Error(LOCAL_API_RECOVERY_ERROR_MESSAGE, { cause: healthError });
    }

    return retryExistingStaffSession(currentUser, true);
  }, [retryExistingStaffSession]);

  const loginWithGoogle = useCallback(async () => {
    const auth = getCloudFirebaseAuth();
    const currentUser = auth.currentUser;
    if (currentUser) {
      const currentIdentity = cloudUserKind(currentUser);
      if (currentIdentity === "student") {
        const conflict = new AuthConflictError(
          "STUDENT_ON_STAFF_LOGIN",
          "현재 학생으로 참여 중입니다. 강사로 로그인하려면 학생 참여를 먼저 종료해 주세요.",
        );
        setError(conflict.message);
        throw conflict;
      }
      if (currentIdentity === "unsupported") {
        const conflict = new AuthConflictError(
          "UNSUPPORTED_PROVIDER",
          "현재 로그인 상태로는 강사 로그인을 시작할 수 없습니다.",
        );
        setError(conflict.message);
        throw conflict;
      }
      if (identityKind === "invited-staff" && organizationInvitation) {
        return null;
      }
      if (profile) return profile;
      return retryExistingStaffSession(currentUser);
    }

    const attempt = googleLoginAttemptRef.current + 1;
    googleLoginAttemptRef.current = attempt;
    beginGoogleDiagnostic(attempt);
    updateDiagnostic("button-click", "success", "수신됨", attempt);
    activeGooglePopupAttemptRef.current = attempt;
    expiredGooglePopupAttemptRef.current = null;
    setError(null);
    setGoogleLoginRecoveryAvailable(false);
    setLocalApiRecoveryAvailable(false);
    setIsGoogleRedirecting(false);
    setIsLoading(true);
    setIdentityKind("loading");
    staffVerificationGenerationRef.current += 1;
    studentRequestGenerationRef.current += 1;
    setIsBootstrappingOrganization(false);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    let expectedUid: string | null = null;

    try {
      // 브라우저의 popup 허용은 클릭 이벤트의 동기 구간에서만 보장된다.
      // getAuth의 기본 browser local persistence를 그대로 사용한다. 클릭 시
      // setPersistence를 호출하면 일부 Chrome 환경에서 auth helper의 popup
      // 반환 채널과 경합할 수 있으므로, staff popup 흐름에서는 명시적
      // persistence migration을 시작하거나 기다리지 않는다.
      const observedAuthStateUser = new Promise<User>((resolve) => {
        observedGooglePopupUserRef.current = { attempt, resolve };
      });
      const popupResult = signInWithPopup(auth, provider);
      updateDiagnostic("popup-start", "success", "시작됨", attempt);
      void popupResult.then(
        async (credential) => {
          if (
            (googleLoginAttemptRef.current === attempt &&
              expiredGooglePopupAttemptRef.current !== attempt) ||
            acceptedGoogleLoginAttemptRef.current >= attempt ||
            activeGooglePopupAttemptRef.current !== null
          ) {
            return;
          }
          if (
            expiredGooglePopupAttemptRef.current === attempt &&
            auth.currentUser?.uid === credential.user.uid
          ) {
            await Promise.resolve(signOut(auth)).catch(() => undefined);
          }
          if (expiredGooglePopupAttemptRef.current === attempt) {
            expiredGooglePopupAttemptRef.current = null;
          }
        },
        () => {
          if (expiredGooglePopupAttemptRef.current === attempt) {
            expiredGooglePopupAttemptRef.current = null;
          }
        },
      );

      let loginResult: {
        source: "popup" | "auth-state";
        credential: { user: User };
      };
      try {
        loginResult = await Promise.race([
          waitForGooglePopup(popupResult).then((credential) => ({
            source: "popup" as const,
            credential,
          })),
          observedAuthStateUser.then((user) => ({
            source: "auth-state" as const,
            credential: { user },
          })),
        ]);
      } catch (popupError) {
        if (googleLoginAttemptRef.current !== attempt) return null;
        if (popupError instanceof GooglePopupTimeoutError) {
          updateDiagnostic("popup-result", "failure", "45초 시간 초과", attempt);
          updateDiagnostic("final-result", "failure", "로그인 미완료", attempt);
          activeGooglePopupAttemptRef.current = null;
          expiredGooglePopupAttemptRef.current = attempt;
          setGoogleLoginRecoveryAvailable(true);
          setIdentityKind("signed-out");
          throw popupError;
        }
        updateDiagnostic(
          "popup-result",
          "failure",
          authDiagnosticFailureDetail(popupError),
          attempt,
        );
        updateDiagnostic(
          "final-result",
          "failure",
          authDiagnosticFailureDetail(popupError),
          attempt,
        );
        setGoogleLoginRecoveryAvailable(true);
        throw popupError;
      }

      if (googleLoginAttemptRef.current !== attempt) return null;
      const credential = loginResult.credential;
      updateDiagnostic(
        "popup-result",
        "success",
        loginResult.source === "popup"
          ? "사용자 결과 확인"
          : "Firebase 세션 반환으로 복구됨",
        attempt,
      );
      updateDiagnostic("firebase-user", "success", "사용자 확인됨", attempt);
      setUser(credential.user);
      expectedUid = credential.user.uid;
      const nextProfile = await verifyUser(credential.user);
      if (googleLoginAttemptRef.current !== attempt) return null;
      acceptedGoogleLoginAttemptRef.current = attempt;
      setError(null);
      return nextProfile;
    } catch (loginError) {
      if (googleLoginAttemptRef.current !== attempt) return null;
      if (loginError instanceof StaleStaffVerificationError) {
        return null;
      }
      const localApiFailure = isLocalApiConnectionFailure(loginError);
      const message = localApiFailure
        ? LOCAL_API_RECOVERY_ERROR_MESSAGE
        : googleAuthErrorMessage(loginError);
      updateDiagnostic(
        "final-result",
        "failure",
        authDiagnosticFailureDetail(loginError),
        attempt,
      );
      setError(message);
      setProfile(null);
      // 이 흐름은 시작 시에는 사용자가 없었지만, popup Promise를 기다리는 동안
      // Firebase가 STAFF 사용자를 설정할 수 있다.
      const activeStaffUser = auth.currentUser as User | null;
      if (
        activeStaffUser &&
        cloudUserKind(activeStaffUser) === "staff" &&
        (!expectedUid || activeStaffUser.uid === expectedUid)
      ) {
        // FastAPI 권한 확인 실패는 Firebase 로그아웃 신호가 아니다. 새로 얻은
        // STAFF 세션도 유지해 "다시 시도"에서 같은 세션을 안전하게 재검증한다.
        setUser(activeStaffUser);
        setIdentityKind("staff-verification-failed");
        setLocalApiRecoveryAvailable(localApiFailure);
        setGoogleLoginRecoveryAvailable(
          !localApiFailure && isRetryableGoogleVerificationError(loginError),
        );
      } else if (!activeStaffUser) {
        setIdentityKind("signed-out");
      }
      throw new Error(message, { cause: loginError });
    } finally {
      if (observedGooglePopupUserRef.current?.attempt === attempt) {
        observedGooglePopupUserRef.current = null;
      }
      if (activeGooglePopupAttemptRef.current === attempt) {
        activeGooglePopupAttemptRef.current = null;
      }
      const currentAuthUser = auth.currentUser as User | null;
      if (
          googleLoginAttemptRef.current === attempt &&
        (!expectedUid || !currentAuthUser || currentAuthUser.uid === expectedUid)
      ) {
        setIsLoading(false);
      }
    }
  }, [
    beginGoogleDiagnostic,
    identityKind,
    organizationInvitation,
    profile,
    retryExistingStaffSession,
    updateDiagnostic,
    verifyUser,
  ]);

  const loginWithGoogleRedirect = useCallback(async () => {
    const auth = getCloudFirebaseAuth();
    const currentUser = auth.currentUser;
    if (currentUser) {
      const currentIdentity = cloudUserKind(currentUser);
      if (currentIdentity === "student") {
        const conflict = new AuthConflictError(
          "STUDENT_ON_STAFF_LOGIN",
          "현재 학생으로 참여 중입니다. 강사로 로그인하려면 학생 참여를 먼저 종료해 주세요.",
        );
        setError(conflict.message);
        throw conflict;
      }
      if (currentIdentity === "unsupported") {
        const conflict = new AuthConflictError(
          "UNSUPPORTED_PROVIDER",
          "현재 로그인 상태로는 강사 로그인을 시작할 수 없습니다.",
        );
        setError(conflict.message);
        throw conflict;
      }
      if (identityKind === "invited-staff" && organizationInvitation) return;
      if (profile) return;
      await retryExistingStaffSession(currentUser);
      return;
    }

    const attempt = googleLoginAttemptRef.current + 1;
    googleLoginAttemptRef.current = attempt;
    beginGoogleDiagnostic(attempt);
    activeGooglePopupAttemptRef.current = null;
    expiredGooglePopupAttemptRef.current = null;
    setError(null);
    setGoogleLoginRecoveryAvailable(false);
    setLocalApiRecoveryAvailable(false);
    setIsGoogleRedirecting(true);
    setIsLoading(true);
    setIdentityKind("loading");
    staffVerificationGenerationRef.current += 1;
    studentRequestGenerationRef.current += 1;
    setIsBootstrappingOrganization(false);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });

    try {
      await setCloudStaffPersistence();
      if (googleLoginAttemptRef.current !== attempt) return;
      updateDiagnostic("redirect-result", "pending", "리디렉션 시작", attempt);
      await signInWithRedirect(auth, provider);
    } catch (redirectError) {
      if (googleLoginAttemptRef.current !== attempt) return;
      const message = googleAuthErrorMessage(redirectError);
      updateDiagnostic(
        "redirect-result",
        "failure",
        authDiagnosticFailureDetail(redirectError),
        attempt,
      );
      updateDiagnostic(
        "final-result",
        "failure",
        authDiagnosticFailureDetail(redirectError),
        attempt,
      );
      setError(message);
      setGoogleLoginRecoveryAvailable(true);
      setIsGoogleRedirecting(false);
      if (!auth.currentUser) setIdentityKind("signed-out");
      setIsLoading(false);
      throw new Error(message, { cause: redirectError });
    }
  }, [
    beginGoogleDiagnostic,
    identityKind,
    organizationInvitation,
    profile,
    retryExistingStaffSession,
    updateDiagnostic,
  ]);

  const acceptOrganizationInvitation = useCallback(async () => {
    const auth = getCloudFirebaseAuth();
    const currentUser = auth.currentUser;
    if (
      !currentUser ||
      cloudUserKind(currentUser) !== "staff" ||
      identityKind !== "invited-staff" ||
      !organizationInvitation
    ) {
      throw new Error("수락할 수 있는 조직 초대를 확인하지 못했습니다.");
    }

    const generation = staffVerificationGenerationRef.current + 1;
    staffVerificationGenerationRef.current = generation;
    const expectedUid = currentUser.uid;
    const assertCurrentInvitedUser = () => {
      const activeUser = auth.currentUser;
      if (
        staffVerificationGenerationRef.current !== generation ||
        !activeUser ||
        activeUser.uid !== expectedUid ||
        cloudUserKind(activeUser) !== "staff"
      ) {
        throw new StaleStaffVerificationError();
      }
    };

    setError(null);
    setIsLoading(true);
    try {
      assertCurrentInvitedUser();
      const payload = await requestApi<unknown>(
        "/api/auth/accept-organization-invitation",
        { method: "POST", authUser: currentUser },
      );
      assertCurrentInvitedUser();
      const nextProfile = normalizeCloudAuthProfile(payload, currentUser);
      assertCurrentInvitedUser();
      setProfile(nextProfile);
      setOrganizationInvitation(null);
      setStudentSession(null);
      clearStoredStudentSession();
      setIdentityKind("staff");
      return nextProfile;
    } finally {
      const activeUser = auth.currentUser;
      if (
        staffVerificationGenerationRef.current === generation &&
        (!activeUser || activeUser.uid === expectedUid)
      ) {
        setIsLoading(false);
      }
    }
  }, [identityKind, organizationInvitation]);

  const startStudentSession = useCallback(
    async (roomCode: string, nickname: string) => {
      if (studentJoinInProgressRef.current) {
        throw new Error("참여 요청이 이미 진행 중입니다.");
      }

      const nicknameResult = validateStudentNickname(nickname);
      const roomCodeResult = validateStudentRoomCode(roomCode);
      if (!nicknameResult.valid) throw new Error(nicknameResult.message);
      if (!roomCodeResult.valid) throw new Error(roomCodeResult.message);

      const auth = getCloudFirebaseAuth();
      const currentUser = auth.currentUser;
      if (currentUser) {
        const currentIdentity = cloudUserKind(currentUser);
        if (currentIdentity === "staff") {
          const conflict = new AuthConflictError(
            "STAFF_ON_STUDENT_ENTRY",
            "현재 강사 계정으로 로그인되어 있습니다. 학생으로 참여하려면 강사 계정에서 먼저 로그아웃해 주세요.",
          );
          setError(conflict.message);
          throw conflict;
        }
        if (currentIdentity === "student") {
          throw new AuthConflictError(
            "STUDENT_ON_STAFF_LOGIN",
            "현재 학생으로 참여 중입니다. 다른 참여를 시작하려면 학생 참여를 먼저 종료해 주세요.",
          );
        }
        throw new AuthConflictError(
          "UNSUPPORTED_PROVIDER",
          "현재 로그인 상태로는 학생 참여를 시작할 수 없습니다.",
        );
      }

      clearStoredStudentSession();
      staffVerificationGenerationRef.current += 1;
      setIsBootstrappingOrganization(false);
      setOrganizationInvitation(null);
      setError(null);
      setIsLoading(true);
      setIdentityKind("loading");
      studentJoinInProgressRef.current = true;
      const generation = studentRequestGenerationRef.current + 1;
      studentRequestGenerationRef.current = generation;
      let expectedUid = "";
      try {
        await setCloudStudentPersistence();
        const credential = await signInAnonymously(auth);
        expectedUid = credential.user.uid;
        setUser(credential.user);
        const nextSession = await requestStudentSession(
          credential.user,
          {
            nickname: nicknameResult.nickname,
            roomCode: roomCodeResult.roomCode,
          },
        );
        if (
          studentRequestGenerationRef.current !== generation ||
          (auth.currentUser as User | null)?.uid !== expectedUid
        ) throw new StaleStudentVerificationError();
        setProfile(null);
        setStudentSession(nextSession);
        setIdentityKind("student");
        storeStudentSession(nextSession);
        setError(null);
        return nextSession;
      } catch (studentError) {
        if (studentError instanceof StaleStudentVerificationError) {
          throw studentError;
        }
        const message = studentAuthErrorMessage(studentError);
        setError(message);
        const activeUser = auth.currentUser as User | null;
        if (expectedUid && activeUser?.uid === expectedUid) {
          try {
            await signOut(auth);
            if (auth.currentUser) {
              throw new StaleStudentVerificationError();
            }
            clearStoredStudentSession();
            setUser(null);
            setProfile(null);
            setStudentSession(null);
            setIdentityKind("signed-out");
          } catch (logoutError) {
            if (
              logoutError instanceof StaleStudentVerificationError ||
              studentRequestGenerationRef.current !== generation
            ) throw new StaleStudentVerificationError();
            const remainingUser = auth.currentUser as User | null;
            setUser(remainingUser);
            setProfile(null);
            setStudentSession(null);
            setIdentityKind(
              remainingUser ? cloudUserKind(remainingUser) : "signed-out",
            );
          }
        } else if (!expectedUid && !activeUser) {
          setIdentityKind("signed-out");
        }
        throw new Error(message, { cause: studentError });
      } finally {
        studentJoinInProgressRef.current = false;
        if (studentRequestGenerationRef.current === generation) {
          setIsLoading(false);
        }
      }
    },
    [requestStudentSession],
  );

  const endStudentSession = useCallback(async () => {
    const auth = getCloudFirebaseAuth();
    const currentUser = auth.currentUser;
    if (currentUser && cloudUserKind(currentUser) !== "student") {
      throw new Error("현재 학생 참여 상태가 아닙니다.");
    }

    setError(null);
    setIsLoading(true);
    staffVerificationGenerationRef.current += 1;
    setIsBootstrappingOrganization(false);
    const generation = studentRequestGenerationRef.current + 1;
    studentRequestGenerationRef.current = generation;
    try {
      if (currentUser) await signOut(auth);
      if (auth.currentUser) throw new StaleStudentVerificationError();
      clearStoredStudentSession();
      setUser(null);
      setProfile(null);
      setOrganizationInvitation(null);
      setStudentSession(null);
      setIdentityKind("signed-out");
    } catch (logoutError) {
      const message = "학생 참여를 종료하지 못했습니다. 다시 시도해 주세요.";
      setError(message);
      if (studentRequestGenerationRef.current === generation) {
        const remainingUser = auth.currentUser;
        setUser(remainingUser);
        setIdentityKind(
          remainingUser ? cloudUserKind(remainingUser) : "signed-out",
        );
      }
      throw new Error(message, { cause: logoutError });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setError(null);
    googleLoginAttemptRef.current += 1;
    activeGooglePopupAttemptRef.current = null;
    expiredGooglePopupAttemptRef.current = null;
    setGoogleLoginRecoveryAvailable(false);
    setLocalApiRecoveryAvailable(false);
    setIsGoogleRedirecting(false);
    staffVerificationGenerationRef.current += 1;
    studentRequestGenerationRef.current += 1;
    setIsBootstrappingOrganization(false);
    await signOut(getCloudFirebaseAuth());
    clearStoredStudentSession();
    setUser(null);
    setProfile(null);
    setOrganizationInvitation(null);
    setStudentSession(null);
    setIdentityKind("signed-out");
  }, []);

  const unsupported = useCallback(async () => {
    throw new Error("이 기능은 Firebase Emulator 모드에서만 사용할 수 있습니다.");
  }, []);

  const refreshProfile = useCallback(
    async () => {
      const currentUser = getCloudFirebaseAuth().currentUser;
      return currentUser && cloudUserKind(currentUser) === "staff"
        ? verifyUser(currentUser)
        : null;
    },
    [verifyUser],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      runtimeMode: "cloud-auth",
      user,
      profile,
      organizationInvitation,
      studentSession,
      identityKind,
      isLoading,
      isBootstrappingOrganization,
      isGoogleRedirecting,
      googleLoginRecoveryAvailable,
      localApiRecoveryAvailable,
      authDiagnostics,
      isRestoringSession: isLoading,
      error,
      login: unsupported,
      loginWithGoogle,
      reconnectLocalApi,
      loginWithGoogleRedirect,
      acceptOrganizationInvitation,
      startStudentSession,
      endStudentSession,
      joinRoom: unsupported,
      updateNickname: unsupported,
      logout,
      refreshProfile,
    }),
    [
      acceptOrganizationInvitation,
      authDiagnostics,
      endStudentSession,
      error,
      googleLoginRecoveryAvailable,
      identityKind,
      isBootstrappingOrganization,
      isGoogleRedirecting,
      isLoading,
      loginWithGoogle,
      loginWithGoogleRedirect,
      localApiRecoveryAvailable,
      logout,
      organizationInvitation,
      profile,
      reconnectLocalApi,
      refreshProfile,
      startStudentSession,
      studentSession,
      unsupported,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return runtimeMode === "cloud-auth" ? (
    <CloudAuthProvider>{children}</CloudAuthProvider>
  ) : (
    <EmulatorAuthProvider>{children}</EmulatorAuthProvider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth는 AuthProvider 안에서 사용해야 합니다.");
  }
  return context;
}
