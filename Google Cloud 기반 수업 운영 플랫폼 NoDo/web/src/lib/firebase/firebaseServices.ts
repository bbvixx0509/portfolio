import { getLocalFirebaseApp } from "./firebaseApp";
import { getLocalFirebaseAuth } from "./firebaseAuth";
import { getLocalFirebaseFirestore } from "./firebaseFirestore";
import { getLocalFirebaseStorage } from "./firebaseStorage";

export function getLocalFirebaseServices() {
  return {
    app: getLocalFirebaseApp(),
    auth: getLocalFirebaseAuth(),
    firestore: getLocalFirebaseFirestore(),
    storage: getLocalFirebaseStorage(),
  };
}

