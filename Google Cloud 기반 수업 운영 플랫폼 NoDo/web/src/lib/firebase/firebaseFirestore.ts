import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from "firebase/firestore";
import { connectEmulatorOnce } from "./emulatorRuntime";
import { getLocalFirebaseApp } from "./firebaseApp";
import { localFirebaseEnvironment } from "./firebaseConfig";

export function getLocalFirebaseFirestore(): Firestore {
  const firestore = getFirestore(getLocalFirebaseApp());

  connectEmulatorOnce("firestore", firestore, () => {
    connectFirestoreEmulator(
      firestore,
      localFirebaseEnvironment.firestoreHost,
      localFirebaseEnvironment.firestorePort,
    );
  });

  return firestore;
}

