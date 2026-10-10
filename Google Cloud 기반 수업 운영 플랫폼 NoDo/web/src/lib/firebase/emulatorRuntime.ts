type FirebaseServiceKind = "auth" | "firestore" | "storage";

interface NoDoFirebaseRuntime {
  auth: WeakSet<object>;
  firestore: WeakSet<object>;
  storage: WeakSet<object>;
}

interface NoDoGlobalScope {
  __NODO_01_FIREBASE_RUNTIME__?: NoDoFirebaseRuntime;
}

const globalScope = globalThis as typeof globalThis & NoDoGlobalScope;

const runtime =
  globalScope.__NODO_01_FIREBASE_RUNTIME__ ??
  (globalScope.__NODO_01_FIREBASE_RUNTIME__ = {
    auth: new WeakSet<object>(),
    firestore: new WeakSet<object>(),
    storage: new WeakSet<object>(),
  });

export function connectEmulatorOnce<T extends object>(
  kind: FirebaseServiceKind,
  service: T,
  connect: () => void,
) {
  if (runtime[kind].has(service)) {
    return false;
  }

  connect();
  runtime[kind].add(service);
  return true;
}

