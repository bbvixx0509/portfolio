import {
  connectStorageEmulator,
  getStorage,
  type FirebaseStorage,
} from "firebase/storage";
import { connectEmulatorOnce } from "./emulatorRuntime";
import { getLocalFirebaseApp } from "./firebaseApp";
import { localFirebaseEnvironment } from "./firebaseConfig";

export function getLocalFirebaseStorage(): FirebaseStorage {
  const storage = getStorage(getLocalFirebaseApp());

  connectEmulatorOnce("storage", storage, () => {
    connectStorageEmulator(
      storage,
      localFirebaseEnvironment.storageHost,
      localFirebaseEnvironment.storagePort,
    );
  });

  return storage;
}

