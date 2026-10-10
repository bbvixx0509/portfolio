from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, TypeVar

import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1 import FieldFilter

from app.core.config import Settings
from app.services.cloud_course_service import CloudCourseTransaction
from app.services.cloud_material_course_draft_service import DraftGenerationClaim
from app.services.cloud_material_extraction_service import ExtractionClaim
from app.services.cloud_organization_service import (
    CloudOrganizationTransaction,
    OwnerDocuments,
)
from app.services.cloud_question_service import CloudQuestionTransaction
from app.services.cloud_room_service import CloudRoomTransaction
from app.services.cloud_student_participant_service import (
    CloudStudentParticipantTransaction,
)

CLOUD_FIRESTORE_FIREBASE_APP_NAME = "nodo-cloud-firestore"
TransactionResult = TypeVar("TransactionResult")


def get_cloud_firestore_app(runtime_settings: Settings) -> firebase_admin.App:
    """Return the ADC-only app used exclusively for real Firestore access."""

    runtime_settings.ensure_cloud_auth_only()
    try:
        app = firebase_admin.get_app(CLOUD_FIRESTORE_FIREBASE_APP_NAME)
    except ValueError:
        app = firebase_admin.initialize_app(
            credentials.ApplicationDefault(),
            {"projectId": runtime_settings.firebase_project_id},
            name=CLOUD_FIRESTORE_FIREBASE_APP_NAME,
        )
    if app.project_id != runtime_settings.firebase_project_id:
        raise RuntimeError("The Cloud Firestore app project is not allowed")
    return app


def get_cloud_firestore_client(runtime_settings: Settings) -> Any:
    runtime_settings.ensure_cloud_auth_only()
    return firestore.client(
        app=get_cloud_firestore_app(runtime_settings),
        database_id=runtime_settings.firestore_database_id,
    )


def _document(snapshot: Any) -> Mapping[str, Any] | None:
    if not snapshot.exists:
        return None
    return snapshot.to_dict() or {}


def _references(
    client: Any, *, org_id: str, uid: str, audit_log_id: str
) -> tuple[Any, Any, Any]:
    organization_ref = client.collection("organizations").document(org_id)
    user_ref = client.collection("users").document(uid)
    audit_log_ref = organization_ref.collection("auditLogs").document(audit_log_id)
    return organization_ref, user_ref, audit_log_ref


class _FirestoreCloudOrganizationTransaction:
    def __init__(self, client: Any, transaction: Any) -> None:
        self.client = client
        self.transaction = transaction

    @property
    def server_timestamp(self) -> object:
        return firestore.SERVER_TIMESTAMP

    def read_owner_documents(
        self, *, org_id: str, uid: str, audit_log_id: str
    ) -> OwnerDocuments:
        organization_ref, user_ref, audit_log_ref = _references(
            self.client,
            org_id=org_id,
            uid=uid,
            audit_log_id=audit_log_id,
        )
        return OwnerDocuments(
            organization=_document(organization_ref.get(transaction=self.transaction)),
            user=_document(user_ref.get(transaction=self.transaction)),
            audit_log=_document(audit_log_ref.get(transaction=self.transaction)),
        )

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        self.transaction.create(self.client.document(path), dict(document))

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return _document(self.client.document(path).get(transaction=self.transaction))

    def find_users_by_email(
        self, *, org_id: str, email: str
    ) -> list[Mapping[str, Any]]:
        query = self.client.collection("users").where(
            filter=FieldFilter("email", "==", email)
        )
        return [
            document
            for snapshot in self.transaction.get(query)
            if (document := _document(snapshot)) is not None
            and document.get("orgId") == org_id
        ]

    def find_staff_invitations_by_token_hash(
        self, *, org_id: str, token_hash: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("staffInvitations")
            .where(filter=FieldFilter("tokenHash", "==", token_hash))
        )
        return [
            document
            for snapshot in self.transaction.get(query)
            if (document := _document(snapshot)) is not None
            and document.get("orgId") == org_id
        ]

    def list_expired_reservations(
        self, *, collection_path: str, before: datetime
    ) -> list[tuple[str, Mapping[str, Any]]]:
        query = self.client.collection(collection_path).where(
            filter=FieldFilter("expiresAt", "<=", before)
        )
        return [
            (snapshot.reference.path, document)
            for snapshot in self.transaction.get(query)
            if (document := _document(snapshot)) is not None
            and document.get("status") == "RESERVED"
        ]

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        self.transaction.update(self.client.document(path), dict(changes))

    def list_active_rooms(self, *, org_id: str) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("rooms")
            .where(filter=FieldFilter("status", "in", ["READY", "LIVE"]))
        )
        return [
            document
            for snapshot in self.transaction.get(query)
            if (document := _document(snapshot)) is not None
            and document.get("orgId") == org_id
        ]


class FirestoreCloudOrganizationRepository:
    def __init__(self, client: Any) -> None:
        self.client = client

    @classmethod
    def from_settings(
        cls, runtime_settings: Settings
    ) -> "FirestoreCloudOrganizationRepository":
        return cls(get_cloud_firestore_client(runtime_settings))

    def read_owner_documents(
        self, *, org_id: str, uid: str, audit_log_id: str
    ) -> OwnerDocuments:
        references = _references(
            self.client,
            org_id=org_id,
            uid=uid,
            audit_log_id=audit_log_id,
        )
        snapshots = self.client.get_all(references)
        documents = {
            snapshot.reference.path: _document(snapshot) for snapshot in snapshots
        }
        return OwnerDocuments(
            organization=documents.get(references[0].path),
            user=documents.get(references[1].path),
            audit_log=documents.get(references[2].path),
        )

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return _document(self.client.document(path).get())

    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]:
        query = self.client.collection("users").where(
            filter=FieldFilter("orgId", "==", org_id)
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
            and document.get("accountType") == "STAFF"
        ]

    def find_users_by_email(
        self, *, org_id: str, email: str
    ) -> list[Mapping[str, Any]]:
        query = self.client.collection("users").where(
            filter=FieldFilter("email", "==", email)
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
            and document.get("orgId") == org_id
        ]

    def list_staff_invitations(self, *, org_id: str) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("staffInvitations")
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
            and document.get("orgId") == org_id
        ]

    def run_transaction(
        self,
        callback: Callable[[CloudOrganizationTransaction], TransactionResult],
    ) -> TransactionResult:
        transaction = self.client.transaction()

        @firestore.transactional
        def run(current_transaction: Any) -> TransactionResult:
            adapter = _FirestoreCloudOrganizationTransaction(
                self.client, current_transaction
            )
            return callback(adapter)

        return run(transaction)


class FirestoreCloudCourseRepository:
    """Server-only course repository; React never receives this client."""

    def __init__(self, client: Any) -> None:
        self.client = client

    @classmethod
    def from_settings(
        cls, runtime_settings: Settings
    ) -> "FirestoreCloudCourseRepository":
        return cls(get_cloud_firestore_client(runtime_settings))

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return _document(self.client.document(path).get())

    def list_courses(self, *, org_id: str) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("courses")
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
            and document.get("orgId") == org_id
        ]

    def run_transaction(
        self, callback: Callable[[CloudCourseTransaction], TransactionResult]
    ) -> TransactionResult:
        transaction = self.client.transaction()

        @firestore.transactional
        def run(current_transaction: Any) -> TransactionResult:
            return callback(
                _FirestoreCloudOrganizationTransaction(self.client, current_transaction)
            )

        return run(transaction)


class FirestoreCloudMaterialUploadRepository:
    """Metadata-only repository for private NoDo material uploads."""

    def __init__(self, client: Any) -> None:
        self.client = client

    @classmethod
    def from_settings(
        cls, runtime_settings: Settings
    ) -> "FirestoreCloudMaterialUploadRepository":
        runtime_settings.ensure_cloud_auth_only()
        return cls(get_cloud_firestore_client(runtime_settings))

    @property
    def server_timestamp(self) -> object:
        return firestore.SERVER_TIMESTAMP

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return _document(self.client.document(path).get())

    def list_material_uploads(self, *, org_id: str) -> list[Mapping[str, Any]]:
        """Return only NoDo upload metadata for quota baseline accounting."""

        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("materialUploads")
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
            and document.get("orgId") == org_id
        ]

    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]:
        """Read staff profiles for an organization without changing quota state."""

        query = self.client.collection("users").where(
            filter=FieldFilter("orgId", "==", org_id)
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
            and document.get("accountType") == "STAFF"
        ]

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        self.client.document(path).create(dict(document))

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        self.client.document(path).update(dict(changes))

    def run_transaction(
        self, callback: Callable[[CloudCourseTransaction], TransactionResult]
    ) -> TransactionResult:
        """Use the same server-only transaction adapter as course mutations.

        Material draft application touches both the private draft collection and
        the reusable course collection.  Keeping this method on the material
        repository lets that cross-collection state change remain atomic.
        """

        transaction = self.client.transaction()

        @firestore.transactional
        def run(current_transaction: Any) -> TransactionResult:
            return callback(
                _FirestoreCloudOrganizationTransaction(self.client, current_transaction)
            )

        return run(transaction)

    def claim_extraction(self, path: str) -> ExtractionClaim:
        """Move a stored upload to EXTRACTING exactly once.

        The claim is the only synchronisation point for a server-side
        extraction. A transaction retry can therefore never cause two workers
        to write a separate extraction result for the same source generation.
        """

        transaction = self.client.transaction()
        reference = self.client.document(path)

        @firestore.transactional
        def run(current_transaction: Any) -> ExtractionClaim:
            document = _document(reference.get(transaction=current_transaction))
            if document is None:
                return ExtractionClaim(document=None, started=False)
            if document.get("status") not in {"STORED", "EXTRACTION_FAILED"}:
                return ExtractionClaim(document=document, started=False)
            changes = {
                "status": "EXTRACTING",
                "extractionStatus": "EXTRACTING",
                "extractionVersion": 1,
                "failureCode": None,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            }
            current_transaction.update(reference, changes)
            return ExtractionClaim(document={**document, **changes}, started=True)

        return run(transaction)

    def claim_course_draft(
        self,
        *,
        org_id: str,
        material_id: str,
        draft_path: str,
        document: Mapping[str, Any],
    ) -> DraftGenerationClaim:
        """Create one active draft per material inside a Firestore transaction.

        The claim and initial ``GENERATING`` record are deliberately one
        operation.  Retried browser requests and Firestore transaction retries
        therefore reuse an existing active result instead of calling Gemini a
        second time.
        """

        transaction = self.client.transaction()
        material_reference = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("materialUploads")
            .document(material_id)
        )
        drafts_query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("materialCourseDrafts")
            .where(filter=FieldFilter("materialId", "==", material_id))
        )

        @firestore.transactional
        def run(current_transaction: Any) -> DraftGenerationClaim:
            material = _document(
                material_reference.get(transaction=current_transaction)
            )
            if material is None or (
                material.get("status") != "EXTRACTED"
                or material.get("extractionStatus") != "EXTRACTED"
            ):
                return DraftGenerationClaim(document=None, started=False)

            existing = [
                item
                for snapshot in current_transaction.get(drafts_query)
                if (item := _document(snapshot)) is not None
                and item.get("orgId") == org_id
                and item.get("status") in {"GENERATING", "GENERATED"}
            ]
            if existing:
                return DraftGenerationClaim(document=existing[0], started=False)

            current_transaction.create(self.client.document(draft_path), dict(document))
            return DraftGenerationClaim(document=document, started=True)

        return run(transaction)

    def list_owned_uploads(
        self, *, org_id: str, owner_staff_uid: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("materialUploads")
            .where(filter=FieldFilter("ownerStaffUid", "==", owner_staff_uid))
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
            and document.get("orgId") == org_id
        ]


class FirestoreCloudRoomRepository:
    """Server-only room repository; React never receives this client."""

    def __init__(self, client: Any) -> None:
        self.client = client

    @classmethod
    def from_settings(
        cls, runtime_settings: Settings
    ) -> "FirestoreCloudRoomRepository":
        return cls(get_cloud_firestore_client(runtime_settings))

    @classmethod
    def from_emulator_settings(
        cls, runtime_settings: Settings
    ) -> "FirestoreCloudRoomRepository":
        runtime_settings.ensure_emulator_only()
        from app.adapters.firebase_emulator import get_firestore_client

        return cls(get_firestore_client())

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return _document(self.client.document(path).get())

    def list_rooms(self, *, org_id: str) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations").document(org_id).collection("rooms")
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
            and document.get("orgId") == org_id
        ]

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("rooms")
            .document(room_id)
            .collection("flowItems")
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
        ]

    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]:
        query = self.client.collection("users").where(
            filter=FieldFilter("orgId", "==", org_id)
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
            and document.get("accountType") == "STAFF"
        ]

    def _room_collection(
        self, *, org_id: str, room_id: str, name: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("rooms")
            .document(room_id)
            .collection(name)
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
        ]

    def list_room_questions(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        return self._room_collection(org_id=org_id, room_id=room_id, name="questions")

    def list_room_participants(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        return self._room_collection(
            org_id=org_id, room_id=room_id, name="participants"
        )

    def run_transaction(
        self, callback: Callable[[CloudRoomTransaction], TransactionResult]
    ) -> TransactionResult:
        transaction = self.client.transaction()

        @firestore.transactional
        def run(current_transaction: Any) -> TransactionResult:
            return callback(
                _FirestoreCloudRoomTransaction(self.client, current_transaction)
            )

        return run(transaction)


class _FirestoreCloudRoomTransaction(_FirestoreCloudOrganizationTransaction):
    """Room-scoped transaction reads keep checklist ordering atomic."""

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("rooms")
            .document(room_id)
            .collection("flowItems")
            .order_by("__name__")
        )
        return [
            document
            for snapshot in self.transaction.get(query)
            if (document := _document(snapshot)) is not None
        ]


class _FirestoreCloudQuestionTransaction(_FirestoreCloudOrganizationTransaction):
    """Question reads share the room transaction boundary."""

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("rooms")
            .document(room_id)
            .collection("flowItems")
            .order_by("__name__")
        )
        return [
            document
            for snapshot in self.transaction.get(query)
            if (document := _document(snapshot)) is not None
        ]

    def list_room_questions(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("rooms")
            .document(room_id)
            .collection("questions")
            .order_by("__name__")
        )
        return [
            document
            for snapshot in self.transaction.get(query)
            if (document := _document(snapshot)) is not None
        ]

    def list_question_authors(
        self, *, org_id: str, room_id: str, author_uid: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("rooms")
            .document(room_id)
            .collection("questionAuthors")
            .where(filter=FieldFilter("authorUid", "==", author_uid))
        )
        return [
            document
            for snapshot in self.transaction.get(query)
            if (document := _document(snapshot)) is not None
        ]


class FirestoreCloudQuestionRepository:
    """Cloud-auth question repository. React never receives this client."""

    def __init__(self, client: Any) -> None:
        self.client = client

    @classmethod
    def from_settings(
        cls, runtime_settings: Settings
    ) -> "FirestoreCloudQuestionRepository":
        return cls(get_cloud_firestore_client(runtime_settings))

    @classmethod
    def from_emulator_settings(
        cls, runtime_settings: Settings
    ) -> "FirestoreCloudQuestionRepository":
        runtime_settings.ensure_emulator_only()
        from app.adapters.firebase_emulator import get_firestore_client

        return cls(get_firestore_client())

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return _document(self.client.document(path).get())

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("rooms")
            .document(room_id)
            .collection("flowItems")
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
        ]

    def list_room_questions(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        query = (
            self.client.collection("organizations")
            .document(org_id)
            .collection("rooms")
            .document(room_id)
            .collection("questions")
        )
        return [
            document
            for snapshot in query.stream()
            if (document := _document(snapshot)) is not None
        ]

    def run_transaction(
        self, callback: Callable[[CloudQuestionTransaction], TransactionResult]
    ) -> TransactionResult:
        transaction = self.client.transaction()

        @firestore.transactional
        def run(current_transaction: Any) -> TransactionResult:
            return callback(
                _FirestoreCloudQuestionTransaction(self.client, current_transaction)
            )

        return run(transaction)


class _FirestoreCloudStudentParticipantTransaction:
    def __init__(self, client: Any, transaction: Any) -> None:
        self.client = client
        self.transaction = transaction

    @property
    def server_timestamp(self) -> object:
        return firestore.SERVER_TIMESTAMP

    @property
    def server_now(self) -> datetime:
        """Use the FastAPI server clock, never a browser-supplied presence time."""

        return datetime.now(UTC)

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return _document(self.client.document(path).get(transaction=self.transaction))

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        self.transaction.create(self.client.document(path), dict(document))

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        self.transaction.update(self.client.document(path), dict(changes))

    def find_participants_by_nickname(
        self, *, room_path: str, nickname_normalized: str
    ) -> list[Mapping[str, Any]]:
        query = self.client.collection(f"{room_path}/participants").where(
            filter=FieldFilter("nicknameNormalized", "==", nickname_normalized)
        )
        matches: list[Mapping[str, Any]] = []
        for snapshot in self.transaction.get(query):
            document = _document(snapshot)
            if document is not None:
                matches.append({**document, "_documentId": snapshot.id})
        return matches

    def list_room_participants(self, *, room_path: str) -> list[Mapping[str, Any]]:
        query = self.client.collection(f"{room_path}/participants").order_by("__name__")
        participants: list[Mapping[str, Any]] = []
        for snapshot in self.transaction.get(query):
            document = _document(snapshot)
            if document is not None:
                participants.append({**document, "_documentId": snapshot.id})
        return participants


class FirestoreCloudStudentParticipantRepository:
    """Server-only anonymous participant access for the selected database."""

    def __init__(self, client: Any) -> None:
        self.client = client

    @classmethod
    def from_settings(
        cls, runtime_settings: Settings
    ) -> "FirestoreCloudStudentParticipantRepository":
        return cls(get_cloud_firestore_client(runtime_settings))

    @classmethod
    def from_emulator_settings(
        cls, runtime_settings: Settings
    ) -> "FirestoreCloudStudentParticipantRepository":
        runtime_settings.ensure_emulator_only()
        from app.adapters.firebase_emulator import get_firestore_client

        return cls(get_firestore_client())

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return _document(self.client.document(path).get())

    def run_transaction(
        self,
        callback: Callable[[CloudStudentParticipantTransaction], TransactionResult],
    ) -> TransactionResult:
        transaction = self.client.transaction()

        @firestore.transactional
        def run(current_transaction: Any) -> TransactionResult:
            return callback(
                _FirestoreCloudStudentParticipantTransaction(
                    self.client, current_transaction
                )
            )

        return run(transaction)
