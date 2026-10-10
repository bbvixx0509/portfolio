import copy
import threading
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any, TypeVar

import pytest

from app.core.config import CLOUD_AUTH_RUNTIME_MODE, Settings
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    InvitationExpired,
    LastOrganizationAdministrator,
    OrganizationInvitationAcceptanceRequired,
    ResourceConflict,
    ResourceNotFound,
    SelfMembershipRemoval,
)
from app.domain.staff_invitations import (
    StaffInvitationStatus,
    normalize_staff_email,
    staff_invitation_event_id,
    staff_invitation_id,
)
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_role_service import (
    CloudOrganizationRoleService,
)
from app.services.cloud_organization_service import (
    BOOTSTRAP_AUDIT_LOG_ID,
    CloudOrganizationService,
    CloudOrganizationTransaction,
    OwnerDocuments,
)
from app.services.cloud_staff_service import CloudStaffService

ORG_ID = "demo"
OWNER_UID = "owner-uid"
OWNER_EMAIL = "owner@nodo-company.test"
STAFF_UID = "staff-uid"
STAFF_EMAIL = "employee@nodo-company.test"
SECOND_STAFF_UID = "second-staff-uid"
SECOND_STAFF_EMAIL = "second@nodo-company.test"
FIXED_NOW = datetime(2026, 7, 16, 12, 0, tzinfo=UTC)
TransactionResult = TypeVar("TransactionResult")


def cloud_settings() -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id="example-gcp-project",
        firestore_database_id="(default)",
        bootstrap_org_id=ORG_ID,
        bootstrap_org_name="DEMO",
        bootstrap_enabled=False,
        bootstrap_org_owner_emails=frozenset(),
        staff_email_domains=frozenset({"nodo-company.test"}),
        staff_invitation_ttl_hours=168,
    )


def identity(
    uid: str = OWNER_UID,
    email: str = OWNER_EMAIL,
    *,
    display_name: str = "Synthetic User",
) -> VerifiedCloudIdentity:
    return VerifiedCloudIdentity(
        uid=uid,
        email=email,
        display_name=display_name,
        photo_url="https://example.test/avatar.png",
    )


def owner_documents() -> dict[str, dict[str, Any]]:
    return {
        f"organizations/{ORG_ID}": {
            "id": ORG_ID,
            "orgId": ORG_ID,
            "name": "DEMO",
            "bootstrapState": "COMPLETED",
            "adminCount": 1,
            "schemaVersion": 1,
            "createdAt": FIXED_NOW,
            "updatedAt": FIXED_NOW,
        },
        f"users/{OWNER_UID}": {
            "uid": OWNER_UID,
            "orgId": ORG_ID,
            "accountType": "STAFF",
            "organizationRole": "ADMIN",
            "organizationRoleRevision": 1,
            "isAnonymous": False,
            "email": OWNER_EMAIL,
            "displayName": "Synthetic Administrator",
            "photoURL": None,
            "schemaVersion": 1,
            "createdAt": FIXED_NOW,
            "updatedAt": FIXED_NOW,
        },
        (f"organizations/{ORG_ID}/auditLogs/{BOOTSTRAP_AUDIT_LOG_ID}"): {
            "eventType": "BOOTSTRAP_ORGANIZATION_CREATED",
            "orgId": ORG_ID,
            "actorUid": OWNER_UID,
            "targetUid": OWNER_UID,
            "before": None,
            "after": {
                "accountType": "STAFF",
                "organizationRole": "ADMIN",
            },
            "schemaVersion": 1,
            "createdAt": FIXED_NOW,
        },
    }


class InMemoryTransaction:
    def __init__(self, documents: dict[str, dict[str, Any]]) -> None:
        self.documents = documents
        self.creates: dict[str, dict[str, Any]] = {}
        self.updates: dict[str, dict[str, Any]] = {}

    @property
    def server_timestamp(self) -> object:
        return FIXED_NOW

    def read_owner_documents(
        self, *, org_id: str, uid: str, audit_log_id: str
    ) -> OwnerDocuments:
        return OwnerDocuments(
            organization=self.read_document(f"organizations/{org_id}"),
            user=self.read_document(f"users/{uid}"),
            audit_log=self.read_document(
                f"organizations/{org_id}/auditLogs/{audit_log_id}"
            ),
        )

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        document = self.documents.get(path)
        return copy.deepcopy(document) if document is not None else None

    def find_users_by_email(
        self, *, org_id: str, email: str
    ) -> list[Mapping[str, Any]]:
        return [
            copy.deepcopy(document)
            for path, document in self.documents.items()
            if path.startswith("users/")
            and document.get("orgId") == org_id
            and document.get("email") == email
        ]

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        if path in self.documents or path in self.creates:
            raise ResourceConflict("Document already exists")
        self.creates[path] = copy.deepcopy(dict(document))

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        if path not in self.documents:
            raise ResourceNotFound("Document does not exist")
        self.updates.setdefault(path, {}).update(copy.deepcopy(dict(changes)))

    def list_active_rooms(self, *, org_id: str) -> list[Mapping[str, Any]]:
        prefix = f"organizations/{org_id}/rooms/"
        return [
            copy.deepcopy(document)
            for path, document in self.documents.items()
            if path.startswith(prefix)
            and path.count("/") == 3
            and document.get("orgId") == org_id
            and document.get("status") in {"READY", "LIVE"}
        ]


class InMemoryRepository:
    def __init__(self, *, fail_on_commit: bool = False) -> None:
        self.documents = owner_documents()
        self.fail_on_commit = fail_on_commit
        self.lock = threading.Lock()
        self.transaction_count = 0

    def read_owner_documents(
        self, *, org_id: str, uid: str, audit_log_id: str
    ) -> OwnerDocuments:
        with self.lock:
            transaction = InMemoryTransaction(self.documents)
            return transaction.read_owner_documents(
                org_id=org_id,
                uid=uid,
                audit_log_id=audit_log_id,
            )

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        with self.lock:
            document = self.documents.get(path)
            return copy.deepcopy(document) if document is not None else None

    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]:
        with self.lock:
            return [
                copy.deepcopy(document)
                for path, document in self.documents.items()
                if path.startswith("users/")
                and document.get("orgId") == org_id
                and document.get("accountType") == "STAFF"
            ]

    def find_users_by_email(
        self, *, org_id: str, email: str
    ) -> list[Mapping[str, Any]]:
        with self.lock:
            return [
                copy.deepcopy(document)
                for path, document in self.documents.items()
                if path.startswith("users/")
                and document.get("orgId") == org_id
                and document.get("email") == email
            ]

    def list_staff_invitations(self, *, org_id: str) -> list[Mapping[str, Any]]:
        prefix = f"organizations/{org_id}/staffInvitations/"
        with self.lock:
            return [
                copy.deepcopy(document)
                for path, document in self.documents.items()
                if path.startswith(prefix)
            ]

    def run_transaction(
        self,
        callback: Callable[[CloudOrganizationTransaction], TransactionResult],
    ) -> TransactionResult:
        with self.lock:
            self.transaction_count += 1
            transaction = InMemoryTransaction(self.documents)
            result = callback(transaction)
            if self.fail_on_commit:
                raise RuntimeError("synthetic commit failure")
            next_documents = copy.deepcopy(self.documents)
            for path, changes in transaction.updates.items():
                next_documents[path].update(changes)
            next_documents.update(transaction.creates)
            self.documents = next_documents
            return result


class RetryingInMemoryRepository(InMemoryRepository):
    def __init__(self) -> None:
        super().__init__()
        self.retry_next_transaction = False
        self.discarded_creates: list[dict[str, dict[str, Any]]] = []

    def run_transaction(
        self,
        callback: Callable[[CloudOrganizationTransaction], TransactionResult],
    ) -> TransactionResult:
        if self.retry_next_transaction:
            self.retry_next_transaction = False
            discarded = InMemoryTransaction(self.documents)
            callback(discarded)
            self.discarded_creates.append(copy.deepcopy(discarded.creates))
        return super().run_transaction(callback)


def service(
    repository: InMemoryRepository, *, now: datetime = FIXED_NOW
) -> CloudStaffService:
    return CloudStaffService(repository, cloud_settings(), clock=lambda: now)


def invitation_path(email: str = STAFF_EMAIL) -> str:
    invitation_id = staff_invitation_id(ORG_ID, email)
    return f"organizations/{ORG_ID}/staffInvitations/{invitation_id}"


def audit_path(action: str, revision: int, email: str = STAFF_EMAIL) -> str:
    invitation_id = staff_invitation_id(ORG_ID, email)
    event_id = staff_invitation_event_id(action, invitation_id, revision)
    return f"organizations/{ORG_ID}/auditLogs/{event_id}"


def create_invitation(
    repository: InMemoryRepository, email: str = STAFF_EMAIL
) -> dict[str, Any]:
    return service(repository).create_invitation(identity(), email)


def test_company_email_normalization_and_deterministic_id() -> None:
    normalized = normalize_staff_email(
        "  EMPLOYEE@NODO-COMPANY.TEST  ", allowed_domains=frozenset({"nodo-company.test"})
    )

    assert normalized == STAFF_EMAIL
    assert staff_invitation_id(ORG_ID, normalized) == staff_invitation_id(
        ORG_ID, STAFF_EMAIL
    )
    assert len(staff_invitation_id(ORG_ID, normalized)) == 64


@pytest.mark.parametrize(
    ("domains", "ttl"),
    [
        (frozenset({"example.com"}), 168),
        (frozenset({"nodo-company.test", "example.com"}), 168),
        (frozenset({"nodo-company.test"}), 0),
        (frozenset({"nodo-company.test"}), 8761),
    ],
)
def test_cloud_settings_reject_unsafe_staff_invitation_configuration(
    monkeypatch: pytest.MonkeyPatch,
    domains: frozenset[str],
    ttl: int,
) -> None:
    for name in (
        "FIREBASE_AUTH_EMULATOR_HOST",
        "FIRESTORE_EMULATOR_HOST",
        "FIREBASE_STORAGE_EMULATOR_HOST",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        monkeypatch.delenv(name, raising=False)
    settings = cloud_settings()
    invalid = Settings(
        **{
            **settings.__dict__,
            "staff_email_domains": domains,
            "staff_invitation_ttl_hours": ttl,
        }
    )

    with pytest.raises(RuntimeError, match="staff"):
        invalid.ensure_cloud_auth_only()


@pytest.mark.parametrize(
    "candidate",
    [
        "employee@gmail.com",
        "employee@example.com",
        "employee@sub.nodo-company.test",
        "employee\n@nodo-company.test",
        "x" * 247 + "@nodo-company.test",
    ],
)
def test_invalid_company_email_is_rejected(candidate: str) -> None:
    repository = InMemoryRepository()

    with pytest.raises(InvalidOperation):
        service(repository).create_invitation(identity(), candidate)

    assert repository.documents == owner_documents()


def test_instructor_fails_before_target_email_validation_or_lookup() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = {
        "uid": STAFF_UID,
        "orgId": ORG_ID,
        "accountType": "STAFF",
        "organizationRole": "INSTRUCTOR",
        "organizationRoleRevision": 1,
        "isAnonymous": False,
        "email": STAFF_EMAIL,
        "displayName": "Employee",
        "photoURL": None,
        "joinedByInvitationId": "a" * 64,
        "schemaVersion": 1,
        "createdAt": FIXED_NOW,
        "updatedAt": FIXED_NOW,
    }

    with pytest.raises(AccessDenied, match="administrators"):
        service(repository).create_invitation(
            identity(STAFF_UID, STAFF_EMAIL), "not-an-email"
        )
    with pytest.raises(AccessDenied, match="administrators"):
        service(repository).revoke_invitation(
            identity(STAFF_UID, STAFF_EMAIL), "not-an-invitation-id"
        )

    assert repository.transaction_count == 0


def test_owner_creates_pending_invitation_and_email_free_audit() -> None:
    repository = InMemoryRepository()

    response = service(repository).create_invitation(identity(), "  EMPLOYEE@NODO-COMPANY.TEST  ")

    invitation_id = staff_invitation_id(ORG_ID, STAFF_EMAIL)
    invitation = repository.documents[invitation_path()]
    audit = repository.documents[audit_path("created", 1)]
    assert response == {
        "id": invitation_id,
        "emailNormalized": STAFF_EMAIL,
        "status": "PENDING",
        "revision": 1,
        "createdAt": FIXED_NOW,
        "updatedAt": FIXED_NOW,
        "expiresAt": FIXED_NOW + timedelta(hours=168),
        "acceptedAt": None,
        "revokedAt": None,
    }
    assert invitation["invitedByUid"] == OWNER_UID
    assert audit["eventType"] == "STAFF_INVITATION_CREATED"
    assert audit["invitationId"] == invitation_id
    assert audit["before"] is None
    assert audit["after"] == {"status": "PENDING", "revision": 1}
    assert "email" not in audit
    assert "token" not in audit


def test_active_pending_invitation_is_idempotent() -> None:
    repository = InMemoryRepository()
    first = create_invitation(repository)
    snapshot = copy.deepcopy(repository.documents)

    second = create_invitation(repository)

    assert second == first
    assert repository.documents == snapshot
    assert sum("staff-invitation-created" in path for path in snapshot) == 1


@pytest.mark.parametrize("previous_status", ["REVOKED", "PENDING"])
def test_revoked_or_expired_invitation_is_reissued(
    previous_status: str,
) -> None:
    repository = InMemoryRepository()
    create_invitation(repository)
    invitation = repository.documents[invitation_path()]
    if previous_status == "REVOKED":
        invitation.update(
            {
                "status": "REVOKED",
                "revokedAt": FIXED_NOW,
                "revokedByUid": OWNER_UID,
            }
        )
    else:
        invitation["expiresAt"] = FIXED_NOW - timedelta(seconds=1)

    response = service(repository).create_invitation(identity(), STAFF_EMAIL)

    updated = repository.documents[invitation_path()]
    assert response["revision"] == 2
    assert updated["status"] == "PENDING"
    assert updated["expiresAt"] == FIXED_NOW + timedelta(hours=168)
    assert updated["acceptedAt"] is None
    assert updated["acceptedByUid"] is None
    assert updated["revokedAt"] is None
    assert updated["revokedByUid"] is None
    assert (
        repository.documents[audit_path("reissued", 2)]["eventType"]
        == "STAFF_INVITATION_REISSUED"
    )


def test_admin_cannot_invite_self_or_existing_member() -> None:
    repository = InMemoryRepository()

    with pytest.raises(InvalidOperation, match="own account"):
        create_invitation(repository, OWNER_EMAIL)
    repository.documents[f"users/{STAFF_UID}"] = {
        "uid": STAFF_UID,
        "orgId": ORG_ID,
        "accountType": "STAFF",
        "email": STAFF_EMAIL,
    }
    with pytest.raises(ResourceConflict, match="already a member"):
        create_invitation(repository)


def test_concurrent_same_email_creation_produces_one_invitation_and_audit() -> None:
    repository = InMemoryRepository()
    staff_service = service(repository)
    start = threading.Barrier(2)

    def attempt() -> dict[str, Any]:
        start.wait()
        return staff_service.create_invitation(identity(), STAFF_EMAIL)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _index: attempt(), range(2)))

    assert results[0] == results[1]
    assert sum("/staffInvitations/" in path for path in repository.documents) == 1
    assert sum("staff-invitation-created" in path for path in repository.documents) == 1


def joined_staff_document(
    *,
    uid: str = STAFF_UID,
    email: str = STAFF_EMAIL,
    organization_role: str = "INSTRUCTOR",
) -> dict[str, Any]:
    return {
        "uid": uid,
        "orgId": ORG_ID,
        "accountType": "STAFF",
        "organizationRole": organization_role,
        "organizationRoleRevision": 1,
        "isAnonymous": False,
        "email": email,
        "displayName": "Employee",
        "photoURL": None,
        "joinedByInvitationId": "a" * 64,
        "schemaVersion": 1,
        "createdAt": FIXED_NOW,
        "updatedAt": FIXED_NOW,
    }


def room_with_instructor(
    target_uid: str,
    *,
    role: str,
    status: str,
    room_id: str = "room-1",
) -> dict[str, Any]:
    lead_uid = target_uid if role == "LEAD" else OWNER_UID
    instructors = [
        {
            "uid": lead_uid,
            "role": "LEAD",
            "permissions": {
                "questionOperations": True,
                "checklistProgress": True,
                "capacityOperations": True,
            },
            "displayNameSnapshot": "Lead",
        }
    ]
    if role == "ASSISTANT":
        instructors.append(
            {
                "uid": target_uid,
                "role": "ASSISTANT",
                "permissions": {
                    "questionOperations": True,
                    "checklistProgress": False,
                    "capacityOperations": False,
                },
                "displayNameSnapshot": "Assistant",
            }
        )
    return {
        "id": room_id,
        "orgId": ORG_ID,
        "title": f"Room {room_id}",
        "status": status,
        "roomCreatorUid": target_uid,
        "leadInstructorUid": lead_uid,
        "leadInstructorDisplayNameSnapshot": "Lead",
        "instructorMemberUids": [entry["uid"] for entry in instructors],
        "roomInstructors": instructors,
        "revision": 3,
        "updatedAt": FIXED_NOW - timedelta(minutes=5),
    }


def admin_audits(repository: InMemoryRepository) -> list[dict[str, Any]]:
    return [
        document
        for path, document in repository.documents.items()
        if path.startswith(f"organizations/{ORG_ID}/auditLogs/")
        and document.get("eventType")
        in {"ORGANIZATION_ADMIN_GRANTED", "ORGANIZATION_ADMIN_REVOKED"}
    ]


def removal_audits(repository: InMemoryRepository) -> list[dict[str, Any]]:
    return [
        document
        for path, document in repository.documents.items()
        if path.startswith(f"organizations/{ORG_ID}/auditLogs/")
        and document.get("eventType") == "ORGANIZATION_MEMBER_REMOVED"
    ]


def removal_lead_reassignment_audits(
    repository: InMemoryRepository,
) -> list[dict[str, Any]]:
    return [
        document
        for path, document in repository.documents.items()
        if path.startswith(f"organizations/{ORG_ID}/auditLogs/")
        and document.get("eventType")
        == "ROOM_LEAD_REASSIGNED_ON_MEMBER_REMOVAL"
    ]


def role_service(repository: InMemoryRepository) -> CloudOrganizationRoleService:
    return CloudOrganizationRoleService(repository, cloud_settings())


def test_admin_grants_and_revokes_staff_administrator_role_atomically() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()

    granted = role_service(repository).update_role(identity(), STAFF_UID, "ADMIN", 1)

    assert granted["organizationRole"] == "ADMIN"
    assert granted["organizationRoleRevision"] == 2
    assert repository.documents[f"users/{STAFF_UID}"]["organizationRole"] == "ADMIN"
    assert admin_audits(repository) == [
        {
            "eventType": "ORGANIZATION_ADMIN_GRANTED",
            "orgId": ORG_ID,
            "actorUid": OWNER_UID,
            "targetUid": STAFF_UID,
            "before": {"organizationRole": "INSTRUCTOR"},
            "after": {"organizationRole": "ADMIN"},
            "schemaVersion": 1,
            "createdAt": FIXED_NOW,
        }
    ]

    revoked = role_service(repository).update_role(
        identity(), STAFF_UID, "INSTRUCTOR", 2
    )

    assert revoked["organizationRole"] == "INSTRUCTOR"
    assert [audit["eventType"] for audit in admin_audits(repository)] == [
        "ORGANIZATION_ADMIN_GRANTED",
        "ORGANIZATION_ADMIN_REVOKED",
    ]


def test_role_change_rejects_stale_revision_without_audit() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document(
        organization_role="ADMIN"
    )
    with pytest.raises(ResourceConflict, match="another request"):
        role_service(repository).update_role(identity(), STAFF_UID, "INSTRUCTOR", 2)
    assert admin_audits(repository) == []


def test_role_change_rejects_self_and_last_admin() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document(
        organization_role="ADMIN"
    )

    with pytest.raises(InvalidOperation, match="own"):
        role_service(repository).update_role(identity(), OWNER_UID, "INSTRUCTOR", 1)
    with pytest.raises(ResourceConflict, match="At least one"):
        role_service(repository).update_role(identity(), STAFF_UID, "INSTRUCTOR", 1)

    assert admin_audits(repository) == []


def test_role_change_rejects_missing_member_and_failed_commit() -> None:
    repository = InMemoryRepository(fail_on_commit=True)
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    snapshot = copy.deepcopy(repository.documents)

    with pytest.raises(RuntimeError, match="commit"):
        role_service(repository).update_role(identity(), STAFF_UID, "ADMIN", 1)
    with pytest.raises(ResourceNotFound):
        role_service(repository).update_role(identity(), SECOND_STAFF_UID, "ADMIN", 1)

    assert repository.documents == snapshot


def test_admin_removes_instructor_without_deleting_existing_data() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    repository.documents[f"organizations/{ORG_ID}/courses/course-1"] = {
        "id": "course-1",
        "orgId": ORG_ID,
        "creatorUid": STAFF_UID,
    }
    repository.documents[f"organizations/{ORG_ID}/rooms/ended-room"] = (
        room_with_instructor(STAFF_UID, role="LEAD", status="ENDED")
    )
    repository.documents[
        f"organizations/{ORG_ID}/rooms/ended-room/questions/question-1"
    ] = {
        "id": "question-1",
        "orgId": ORG_ID,
        "roomId": "ended-room",
        "content": "보존할 질문",
    }
    repository.documents[f"organizations/{ORG_ID}/materialUploads/material-1"] = {
        "id": "material-1",
        "orgId": ORG_ID,
        "ownerStaffUid": STAFF_UID,
        "objectName": "private/material.pdf",
    }
    preserved = copy.deepcopy(
        {
            path: document
            for path, document in repository.documents.items()
            if path.startswith(f"organizations/{ORG_ID}/courses/")
            or path.startswith(f"organizations/{ORG_ID}/rooms/")
            or path.startswith(f"organizations/{ORG_ID}/materialUploads/")
        }
    )

    response = role_service(repository).remove_member(identity(), STAFF_UID)

    assert response == {"removed": True}
    removed = repository.documents[f"users/{STAFF_UID}"]
    assert removed["membershipStatus"] == "REMOVED"
    assert removed["email"] == STAFF_EMAIL
    assert removed["organizationRole"] == "INSTRUCTOR"
    assert {
        path: document
        for path, document in repository.documents.items()
        if path.startswith(f"organizations/{ORG_ID}/courses/")
        or path.startswith(f"organizations/{ORG_ID}/rooms/")
        or path.startswith(f"organizations/{ORG_ID}/materialUploads/")
    } == preserved
    assert role_service(repository).list_members(identity())["count"] == 1
    assert removal_audits(repository) == [
        {
            "eventType": "ORGANIZATION_MEMBER_REMOVED",
            "orgId": ORG_ID,
            "actorUid": OWNER_UID,
            "targetUid": STAFF_UID,
            "roleBefore": "INSTRUCTOR",
            "reason": "ORGANIZATION_ACCESS_REVOKED",
            "createdAt": FIXED_NOW,
        }
    ]


def test_admin_removes_another_admin_only_when_one_admin_remains() -> None:
    repository = InMemoryRepository()
    repository.documents[f"organizations/{ORG_ID}"]["adminCount"] = 2
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document(
        organization_role="ADMIN"
    )

    role_service(repository).remove_member(identity(), STAFF_UID)

    assert repository.documents[f"organizations/{ORG_ID}"]["adminCount"] == 1
    assert repository.documents[f"users/{STAFF_UID}"]["membershipStatus"] == "REMOVED"


def test_member_removal_rejects_self_last_admin_non_admin_and_other_org() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document(
        organization_role="ADMIN"
    )
    with pytest.raises(SelfMembershipRemoval):
        role_service(repository).remove_member(identity(), OWNER_UID)
    with pytest.raises(LastOrganizationAdministrator):
        role_service(repository).remove_member(identity(), STAFF_UID)

    repository.documents[f"users/{OWNER_UID}"]["organizationRole"] = "INSTRUCTOR"
    with pytest.raises(AccessDenied):
        role_service(repository).remove_member(identity(), STAFF_UID)
    repository.documents["users/student-uid"] = {
        "uid": "student-uid",
        "orgId": ORG_ID,
        "accountType": "STUDENT",
    }
    with pytest.raises(AccessDenied):
        role_service(repository).remove_member(
            identity("student-uid", "student@nodo-company.test"), STAFF_UID
        )

    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = {
        **joined_staff_document(),
        "orgId": "other-org",
    }
    with pytest.raises(ResourceNotFound):
        role_service(repository).remove_member(identity(), STAFF_UID)
    with pytest.raises(ResourceNotFound):
        role_service(repository).remove_member(identity(), SECOND_STAFF_UID)
    assert removal_audits(repository) == []


@pytest.mark.parametrize("status", ["READY", "LIVE"])
def test_member_removal_reassigns_ready_or_live_room_lead_to_admin(
    status: str,
) -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    room = room_with_instructor(STAFF_UID, role="LEAD", status=status)
    room["preservedState"] = {
        "material": "unchanged",
        "questions": 3,
        "participants": 4,
        "checklist": "unchanged",
    }
    repository.documents[f"organizations/{ORG_ID}/rooms/room-1"] = room

    role_service(repository).remove_member(identity(), STAFF_UID)

    assert repository.documents[f"users/{STAFF_UID}"]["membershipStatus"] == "REMOVED"
    reassigned = repository.documents[f"organizations/{ORG_ID}/rooms/room-1"]
    assert reassigned["status"] == status
    assert reassigned["roomCreatorUid"] == STAFF_UID
    assert reassigned["leadInstructorUid"] == OWNER_UID
    assert reassigned["leadInstructorDisplayNameSnapshot"] == (
        "Synthetic Administrator"
    )
    assert reassigned["instructorMemberUids"] == [OWNER_UID]
    assert reassigned["roomInstructors"] == [
        {
            "uid": OWNER_UID,
            "role": "LEAD",
            "permissions": {
                "questionOperations": True,
                "checklistProgress": True,
                "capacityOperations": True,
            },
            "displayNameSnapshot": "Synthetic Administrator",
        }
    ]
    assert reassigned["revision"] == 4
    assert reassigned["updatedAt"] == FIXED_NOW
    assert reassigned["preservedState"] == room["preservedState"]
    assert len(removal_audits(repository)) == 1
    assert removal_lead_reassignment_audits(repository) == [
        {
            "eventType": "ROOM_LEAD_REASSIGNED_ON_MEMBER_REMOVAL",
            "orgId": ORG_ID,
            "roomId": "room-1",
            "actorUid": OWNER_UID,
            "targetStaffUid": STAFF_UID,
            "beforeRoomRole": "LEAD",
            "afterRoomRole": None,
            "revision": 4,
            "schemaVersion": 1,
            "createdAt": FIXED_NOW,
        }
    ]


def test_member_removal_promotes_existing_admin_assistant_without_duplicates() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    room = room_with_instructor(STAFF_UID, role="LEAD", status="LIVE")
    room["roomInstructors"].append(
        {
            "uid": OWNER_UID,
            "role": "ASSISTANT",
            "permissions": {
                "questionOperations": True,
                "checklistProgress": False,
                "capacityOperations": False,
            },
            "displayNameSnapshot": "Old snapshot",
        }
    )
    room["instructorMemberUids"].append(OWNER_UID)
    repository.documents[f"organizations/{ORG_ID}/rooms/room-1"] = room

    role_service(repository).remove_member(identity(), STAFF_UID)

    reassigned = repository.documents[f"organizations/{ORG_ID}/rooms/room-1"]
    assert reassigned["instructorMemberUids"] == [OWNER_UID]
    assert [item["uid"] for item in reassigned["roomInstructors"]] == [OWNER_UID]
    assert reassigned["roomInstructors"][0]["role"] == "LEAD"
    assert all(reassigned["roomInstructors"][0]["permissions"].values())
    assert reassigned["roomInstructors"][0]["displayNameSnapshot"] == (
        "Synthetic Administrator"
    )


def test_member_removal_reassigns_every_active_lead_but_not_ended_history() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    for room_id, status in (
        ("ready-room", "READY"),
        ("live-room", "LIVE"),
        ("ended-room", "ENDED"),
    ):
        repository.documents[f"organizations/{ORG_ID}/rooms/{room_id}"] = (
            room_with_instructor(
                STAFF_UID,
                role="LEAD",
                status=status,
                room_id=room_id,
            )
        )
    ended_before = copy.deepcopy(
        repository.documents[f"organizations/{ORG_ID}/rooms/ended-room"]
    )

    role_service(repository).remove_member(identity(), STAFF_UID)

    assert (
        repository.documents[f"organizations/{ORG_ID}/rooms/ready-room"][
            "leadInstructorUid"
        ]
        == OWNER_UID
    )
    assert (
        repository.documents[f"organizations/{ORG_ID}/rooms/live-room"][
            "leadInstructorUid"
        ]
        == OWNER_UID
    )
    assert (
        repository.documents[f"organizations/{ORG_ID}/rooms/ended-room"]
        == ended_before
    )
    assert {
        audit["roomId"]
        for audit in removal_lead_reassignment_audits(repository)
    } == {"ready-room", "live-room"}


def test_member_removal_reassigns_a_legacy_active_lead() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    room = room_with_instructor(STAFF_UID, role="LEAD", status="READY")
    room.pop("roomInstructors")
    repository.documents[f"organizations/{ORG_ID}/rooms/room-1"] = room

    role_service(repository).remove_member(identity(), STAFF_UID)

    reassigned = repository.documents[f"organizations/{ORG_ID}/rooms/room-1"]
    assert reassigned["leadInstructorUid"] == OWNER_UID
    assert reassigned["instructorMemberUids"] == [OWNER_UID]
    assert reassigned["roomInstructors"][0]["role"] == "LEAD"


@pytest.mark.parametrize("status", ["READY", "LIVE", "ENDED"])
def test_member_removal_allows_assistant_or_ended_room_history(status: str) -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    role = "ASSISTANT" if status != "ENDED" else "LEAD"
    repository.documents[f"organizations/{ORG_ID}/rooms/room-1"] = (
        room_with_instructor(STAFF_UID, role=role, status=status)
    )

    role_service(repository).remove_member(identity(), STAFF_UID)

    assert repository.documents[f"users/{STAFF_UID}"]["membershipStatus"] == "REMOVED"


def test_member_removal_uses_room_instructors_not_stale_legacy_projection() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    room = room_with_instructor(STAFF_UID, role="ASSISTANT", status="LIVE")
    room["leadInstructorUid"] = STAFF_UID
    repository.documents[f"organizations/{ORG_ID}/rooms/room-1"] = room

    role_service(repository).remove_member(identity(), STAFF_UID)

    assert repository.documents[f"users/{STAFF_UID}"]["membershipStatus"] == "REMOVED"
    updated_room = repository.documents[
        f"organizations/{ORG_ID}/rooms/room-1"
    ]
    assert updated_room["leadInstructorUid"] == OWNER_UID
    assert updated_room["instructorMemberUids"] == [OWNER_UID]
    assert [entry["uid"] for entry in updated_room["roomInstructors"]] == [
        OWNER_UID
    ]
    assert updated_room["revision"] == 4
    assert removal_lead_reassignment_audits(repository) == []


def test_ended_room_assignment_does_not_block_member_removal() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    repository.documents[f"organizations/{ORG_ID}/rooms/room-1"] = (
        room_with_instructor(STAFF_UID, role="ASSISTANT", status="ENDED")
    )

    role_service(repository).remove_member(identity(), STAFF_UID)

    assert repository.documents[f"users/{STAFF_UID}"]["membershipStatus"] == "REMOVED"


def test_repeated_or_retried_removal_keeps_one_audit() -> None:
    repository = RetryingInMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    repository.retry_next_transaction = True

    first = role_service(repository).remove_member(identity(), STAFF_UID)
    second = role_service(repository).remove_member(identity(), STAFF_UID)

    assert first == second == {"removed": True}
    assert len(repository.discarded_creates) == 1
    discarded_audit_paths = [
        path
        for path in repository.discarded_creates[0]
        if "/auditLogs/organization-member-removed-" in path
    ]
    committed_audit_paths = [
        path
        for path, document in repository.documents.items()
        if document.get("eventType") == "ORGANIZATION_MEMBER_REMOVED"
    ]
    assert discarded_audit_paths == committed_audit_paths
    assert len(removal_audits(repository)) == 1


def test_reinvited_member_can_be_removed_with_a_new_idempotent_audit() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()

    role_service(repository).remove_member(identity(), STAFF_UID)
    repository.documents[f"users/{STAFF_UID}"].update(
        {
            "membershipStatus": "ACTIVE",
            "organizationRole": "INSTRUCTOR",
            "organizationRoleRevision": 2,
            "updatedAt": FIXED_NOW,
        }
    )
    role_service(repository).remove_member(identity(), STAFF_UID)

    assert len(removal_audits(repository)) == 2
    removal_paths = sorted(
        path
        for path, document in repository.documents.items()
        if document.get("eventType") == "ORGANIZATION_MEMBER_REMOVED"
    )
    assert removal_paths[0].endswith(
        f"organization-member-removed-{STAFF_UID}-r1"
    )
    assert removal_paths[1].endswith(
        f"organization-member-removed-{STAFF_UID}-r2"
    )


def test_retried_lead_removal_keeps_one_room_reassignment_audit() -> None:
    repository = RetryingInMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    repository.documents[f"organizations/{ORG_ID}/rooms/room-1"] = (
        room_with_instructor(STAFF_UID, role="LEAD", status="LIVE")
    )
    repository.retry_next_transaction = True

    first = role_service(repository).remove_member(identity(), STAFF_UID)
    second = role_service(repository).remove_member(identity(), STAFF_UID)

    assert first == second == {"removed": True}
    assert len(removal_lead_reassignment_audits(repository)) == 1
    discarded_room_audit_paths = [
        path
        for path, document in repository.discarded_creates[0].items()
        if document.get("eventType")
        == "ROOM_LEAD_REASSIGNED_ON_MEMBER_REMOVAL"
    ]
    committed_room_audit_paths = [
        path
        for path, document in repository.documents.items()
        if document.get("eventType")
        == "ROOM_LEAD_REASSIGNED_ON_MEMBER_REMOVAL"
    ]
    assert discarded_room_audit_paths == committed_room_audit_paths


def test_lead_removal_commit_failure_changes_nothing_atomically() -> None:
    repository = InMemoryRepository(fail_on_commit=True)
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    repository.documents[f"organizations/{ORG_ID}/rooms/room-1"] = (
        room_with_instructor(STAFF_UID, role="LEAD", status="READY")
    )
    before = copy.deepcopy(repository.documents)

    with pytest.raises(RuntimeError, match="commit"):
        role_service(repository).remove_member(identity(), STAFF_UID)

    assert repository.documents == before


def test_unrelated_malformed_active_room_does_not_block_member_removal() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    repository.documents[f"organizations/{ORG_ID}/rooms/unrelated-room"] = {
        "id": "unrelated-room",
        "orgId": ORG_ID,
        "status": "LIVE",
        "revision": "invalid",
        "roomInstructors": [{"uid": SECOND_STAFF_UID, "role": "UNKNOWN"}],
    }

    assert role_service(repository).remove_member(identity(), STAFF_UID) == {
        "removed": True
    }
    assert (
        repository.documents[f"users/{STAFF_UID}"]["membershipStatus"]
        == "REMOVED"
    )


def test_removed_member_is_denied_by_auth_profile() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document()
    role_service(repository).remove_member(identity(), STAFF_UID)
    organization = CloudOrganizationService(repository, cloud_settings())

    with pytest.raises(AccessDenied):
        organization.authenticated_user(identity(STAFF_UID, STAFF_EMAIL))
    with pytest.raises(AccessDenied):
        role_service(repository).list_members(identity(STAFF_UID, STAFF_EMAIL))


def test_admin_can_manage_invitations_and_roles() -> None:
    repository = InMemoryRepository()
    repository.documents[f"users/{STAFF_UID}"] = joined_staff_document(
        organization_role="ADMIN"
    )
    manager = identity(STAFF_UID, STAFF_EMAIL)

    assert service(repository).list_members(manager)["count"] == 2
    invitation = service(repository).create_invitation(manager, SECOND_STAFF_EMAIL)
    revoked = service(repository).revoke_invitation(manager, invitation["id"])
    assert revoked["status"] == "REVOKED"
    with pytest.raises(InvalidOperation, match="own"):
        role_service(repository).update_role(manager, STAFF_UID, "INSTRUCTOR", 1)


def test_pending_invitation_can_be_revoked_once_without_deletion() -> None:
    repository = InMemoryRepository()
    created = create_invitation(repository)

    response = service(repository).revoke_invitation(identity(), created["id"])

    invitation = repository.documents[invitation_path()]
    assert response["status"] == "REVOKED"
    assert invitation["revokedAt"] == FIXED_NOW
    assert invitation["revokedByUid"] == OWNER_UID
    assert (
        repository.documents[audit_path("revoked", 1)]["eventType"]
        == "STAFF_INVITATION_REVOKED"
    )
    snapshot = copy.deepcopy(repository.documents)
    with pytest.raises(ResourceConflict, match="pending"):
        service(repository).revoke_invitation(identity(), created["id"])
    assert repository.documents == snapshot


def test_invalid_missing_or_wrong_organization_invitation_cannot_be_revoked() -> None:
    repository = InMemoryRepository()
    with pytest.raises(ResourceNotFound):
        service(repository).revoke_invitation(identity(), "invalid")
    with pytest.raises(ResourceNotFound):
        service(repository).revoke_invitation(identity(), "a" * 64)

    created = create_invitation(repository)
    repository.documents[invitation_path()]["orgId"] = "other"
    with pytest.raises(ResourceConflict, match="inconsistent"):
        service(repository).revoke_invitation(identity(), created["id"])


def test_acceptance_creates_general_staff_and_updates_invitation_atomically() -> None:
    repository = InMemoryRepository()
    created = create_invitation(repository)

    response = service(repository).accept_invitation(
        identity(STAFF_UID, "EMPLOYEE@NODO-COMPANY.TEST", display_name="Employee")
    )

    user = repository.documents[f"users/{STAFF_UID}"]
    invitation = repository.documents[invitation_path()]
    audit = repository.documents[audit_path("accepted", 1)]
    assert user["organizationRole"] == "INSTRUCTOR"
    assert user["organizationRoleRevision"] == 1
    assert user["joinedByInvitationId"] == created["id"]
    assert invitation["status"] == StaffInvitationStatus.ACCEPTED.value
    assert invitation["acceptedAt"] == FIXED_NOW
    assert invitation["acceptedByUid"] == STAFF_UID
    assert audit["eventType"] == "STAFF_INVITATION_ACCEPTED"
    assert audit["targetUid"] == STAFF_UID
    assert "email" not in audit
    assert response["accountType"] == "STAFF"
    assert response["organizationRole"] == "INSTRUCTOR"
    assert response["isAdmin"] is False


def test_pending_approval_restores_removed_staff_without_deleting_history() -> None:
    repository = InMemoryRepository()
    create_invitation(repository)
    repository.documents[f"users/{STAFF_UID}"] = {
        "uid": STAFF_UID,
        "orgId": ORG_ID,
        "accountType": "STAFF",
        "membershipStatus": "REMOVED",
        "organizationRole": "INSTRUCTOR",
        "organizationRoleRevision": 4,
        "isAnonymous": False,
        "email": STAFF_EMAIL,
        "displayName": "Former employee",
        "photoURL": None,
        "schemaVersion": 1,
        "createdAt": FIXED_NOW - timedelta(days=30),
        "updatedAt": FIXED_NOW - timedelta(days=1),
        "historicalMarker": "preserve",
    }
    candidate = identity(STAFF_UID, STAFF_EMAIL, display_name="Employee")
    organization = CloudOrganizationService(
        repository, cloud_settings(), clock=lambda: FIXED_NOW
    )

    with pytest.raises(OrganizationInvitationAcceptanceRequired):
        organization.authenticated_user(candidate)

    response = service(repository).accept_invitation(candidate)

    restored = repository.documents[f"users/{STAFF_UID}"]
    assert response["organizationRole"] == "INSTRUCTOR"
    assert restored["membershipStatus"] == "ACTIVE"
    assert restored["organizationRole"] == "INSTRUCTOR"
    assert restored["organizationRoleRevision"] == 5
    assert restored["historicalMarker"] == "preserve"
    assert restored["createdAt"] == FIXED_NOW - timedelta(days=30)
    assert repository.documents[invitation_path()]["status"] == "ACCEPTED"
    assert repository.documents[audit_path("accepted", 1)]["eventType"] == (
        "STAFF_INVITATION_ACCEPTED"
    )


@pytest.mark.parametrize("mode", ["different", "revoked", "expired"])
def test_different_revoked_or_expired_invitation_cannot_be_accepted(
    mode: str,
) -> None:
    repository = InMemoryRepository()
    created = create_invitation(repository)
    if mode == "different":
        candidate = identity(SECOND_STAFF_UID, SECOND_STAFF_EMAIL)
    else:
        candidate = identity(STAFF_UID, STAFF_EMAIL)
        invitation = repository.documents[invitation_path()]
        if mode == "revoked":
            invitation.update(
                {
                    "status": "REVOKED",
                    "revokedAt": FIXED_NOW,
                    "revokedByUid": OWNER_UID,
                }
            )
        else:
            invitation["expiresAt"] = FIXED_NOW - timedelta(seconds=1)

    with pytest.raises(AccessDenied, match="active organization invitation"):
        service(repository).accept_invitation(candidate)

    assert f"users/{candidate.uid}" not in repository.documents
    assert repository.documents[invitation_path()]["status"] != "ACCEPTED"
    assert created["id"] not in {
        path.rsplit("/", maxsplit=1)[-1]
        for path in repository.documents
        if "staff-invitation-accepted" in path
    }


def test_gmail_account_cannot_accept_and_existing_user_cannot_reaccept() -> None:
    repository = InMemoryRepository()
    create_invitation(repository)

    with pytest.raises(AccessDenied):
        service(repository).accept_invitation(identity(STAFF_UID, "employee@gmail.com"))

    service(repository).accept_invitation(identity(STAFF_UID, STAFF_EMAIL))
    snapshot = copy.deepcopy(repository.documents)
    with pytest.raises(ResourceConflict, match="already a member"):
        service(repository).accept_invitation(identity(STAFF_UID, STAFF_EMAIL))
    assert repository.documents == snapshot


def test_acceptance_commit_failure_leaves_all_documents_unchanged() -> None:
    repository = InMemoryRepository()
    created = create_invitation(repository)
    original = copy.deepcopy(repository.documents)
    repository.fail_on_commit = True

    with pytest.raises(RuntimeError, match="commit failure"):
        service(repository).accept_invitation(identity(STAFF_UID, STAFF_EMAIL))

    assert repository.documents == original
    assert repository.documents[invitation_path()]["id"] == created["id"]
    assert f"users/{STAFF_UID}" not in repository.documents


def test_concurrent_acceptance_creates_one_user_and_one_audit() -> None:
    repository = InMemoryRepository()
    create_invitation(repository)
    staff_service = service(repository)
    start = threading.Barrier(2)

    def attempt() -> str:
        start.wait()
        try:
            staff_service.accept_invitation(identity(STAFF_UID, STAFF_EMAIL))
        except ResourceConflict:
            return "conflict"
        return "success"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _index: attempt(), range(2)))

    assert sorted(results) == ["conflict", "success"]
    assert f"users/{STAFF_UID}" in repository.documents
    accepted_audits = sum(
        "staff-invitation-accepted" in path for path in repository.documents
    )
    assert accepted_audits == 1


def test_auth_me_requires_acceptance_then_allows_persisted_staff() -> None:
    repository = InMemoryRepository()
    create_invitation(repository)
    organization_service = CloudOrganizationService(
        repository, cloud_settings(), clock=lambda: FIXED_NOW
    )
    staff_identity = identity(STAFF_UID, STAFF_EMAIL)

    with pytest.raises(OrganizationInvitationAcceptanceRequired) as error:
        organization_service.authenticated_user(staff_identity)
    assert error.value.status_code == 409
    assert error.value.code == "ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED"
    assert error.value.public_details == {
        "organizationName": "DEMO",
        "expiresAt": (FIXED_NOW + timedelta(hours=168)).isoformat(),
    }

    service(repository).accept_invitation(staff_identity)
    response = organization_service.authenticated_user(staff_identity)
    assert response["uid"] == STAFF_UID
    assert response["organizationRole"] == "INSTRUCTOR"
    assert response["isAdmin"] is False
    assert response["authorized"] is True


@pytest.mark.parametrize("mode", ["missing", "revoked", "expired", "gmail"])
def test_auth_me_denies_accounts_without_an_active_invitation(mode: str) -> None:
    repository = InMemoryRepository()
    candidate = identity(STAFF_UID, STAFF_EMAIL)
    if mode != "missing" and mode != "gmail":
        create_invitation(repository)
        invitation = repository.documents[invitation_path()]
        if mode == "revoked":
            invitation.update(
                {
                    "status": "REVOKED",
                    "revokedAt": FIXED_NOW,
                    "revokedByUid": OWNER_UID,
                }
            )
        else:
            invitation["expiresAt"] = FIXED_NOW - timedelta(seconds=1)
    if mode == "gmail":
        candidate = identity(STAFF_UID, "employee@gmail.com")
    organization_service = CloudOrganizationService(
        repository, cloud_settings(), clock=lambda: FIXED_NOW
    )

    expected_error = InvitationExpired if mode == "expired" else AccessDenied
    with pytest.raises(expected_error):
        organization_service.authenticated_user(candidate)


def test_owner_lists_only_safe_member_and_invitation_fields() -> None:
    repository = InMemoryRepository()
    create_invitation(repository)
    staff_service = service(repository)

    members = staff_service.list_members(identity())
    invitations = staff_service.list_invitations(identity())

    assert members["organization"] == {"id": ORG_ID, "name": "DEMO"}
    assert members["count"] == 1
    assert set(members["members"][0]) == {
        "email",
        "displayName",
        "photoURL",
        "organizationRole",
        "createdAt",
    }
    assert set(invitations) == {"invitations"}
    assert set(invitations["invitations"][0]) == {
        "id",
        "emailNormalized",
        "status",
        "revision",
        "createdAt",
        "updatedAt",
        "expiresAt",
        "acceptedAt",
        "revokedAt",
    }
    assert "invitedByUid" not in invitations["invitations"][0]
