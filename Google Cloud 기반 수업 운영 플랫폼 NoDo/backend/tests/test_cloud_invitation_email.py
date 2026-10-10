import copy
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, TypeVar

import pytest

from app.adapters.invitation_email import DisabledInvitationEmailSender
from app.core.config import CLOUD_AUTH_RUNTIME_MODE, Settings
from app.domain.errors import (
    InvalidInvitationToken,
    InvitationAlreadyProcessed,
    InvitationEmailMismatch,
    InvitationExpired,
    InvitationRevoked,
    OrganizationInvitationAcceptanceRequired,
)
from app.domain.staff_invitations import invitation_token_hash, staff_invitation_id
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_invitation_service import CloudInvitationService
from app.services.cloud_organization_service import (
    BOOTSTRAP_AUDIT_LOG_ID,
    CloudOrganizationService,
    CloudOrganizationTransaction,
    OwnerDocuments,
)
from app.services.cloud_staff_service import CloudStaffService

ORG_ID = "demo"
ADMIN_UID = "admin"
ADMIN_EMAIL = "admin@nodo-company.test"
MEMBER_UID = "member"
MEMBER_EMAIL = "member@nodo-company.test"
NOW = datetime(2026, 7, 31, 2, 0, tzinfo=UTC)
TOKEN_A = "a" * 43
TOKEN_B = "b" * 43
TransactionResult = TypeVar("TransactionResult")


def settings() -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id="example-gcp-project",
        firestore_database_id="(default)",
        bootstrap_org_id=ORG_ID,
        bootstrap_org_name="DEMO",
        staff_email_domains=frozenset({"nodo-company.test"}),
        public_app_url="http://localhost:5175",
    )


def identity(
    uid: str = ADMIN_UID,
    email: str = ADMIN_EMAIL,
) -> VerifiedCloudIdentity:
    return VerifiedCloudIdentity(
        uid=uid,
        email=email,
        display_name="Synthetic User",
        photo_url=None,
    )


def documents() -> dict[str, dict[str, Any]]:
    return {
        f"organizations/{ORG_ID}": {
            "id": ORG_ID,
            "orgId": ORG_ID,
            "name": "DEMO",
            "bootstrapState": "COMPLETED",
            "adminCount": 1,
            "schemaVersion": 1,
            "createdAt": NOW,
            "updatedAt": NOW,
        },
        f"users/{ADMIN_UID}": {
            "uid": ADMIN_UID,
            "orgId": ORG_ID,
            "accountType": "STAFF",
            "membershipStatus": "ACTIVE",
            "organizationRole": "ADMIN",
            "organizationRoleRevision": 1,
            "isAnonymous": False,
            "email": ADMIN_EMAIL,
            "displayName": "Administrator",
            "photoURL": None,
            "schemaVersion": 1,
            "createdAt": NOW,
            "updatedAt": NOW,
        },
        f"organizations/{ORG_ID}/auditLogs/{BOOTSTRAP_AUDIT_LOG_ID}": {
            "eventType": "BOOTSTRAP_ORGANIZATION_CREATED",
            "orgId": ORG_ID,
            "createdAt": NOW,
        },
    }


class MemoryTransaction:
    def __init__(self, values: dict[str, dict[str, Any]]) -> None:
        self.values = values
        self.creates: dict[str, dict[str, Any]] = {}
        self.updates: dict[str, dict[str, Any]] = {}
        self.has_written = False

    @property
    def server_timestamp(self) -> object:
        return NOW

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
        if self.has_written:
            raise AssertionError("Firestore transaction read occurred after a write")
        if path in self.creates:
            return copy.deepcopy(self.creates[path])
        value = self.values.get(path)
        if value is None:
            return None
        result = copy.deepcopy(value)
        result.update(copy.deepcopy(self.updates.get(path, {})))
        return result

    def find_users_by_email(
        self, *, org_id: str, email: str
    ) -> list[Mapping[str, Any]]:
        if self.has_written:
            raise AssertionError("Firestore transaction query occurred after a write")
        return [
            copy.deepcopy(value)
            for path, value in self.values.items()
            if path.startswith("users/")
            and value.get("orgId") == org_id
            and value.get("email") == email
        ]

    def find_staff_invitations_by_token_hash(
        self, *, org_id: str, token_hash: str
    ) -> list[Mapping[str, Any]]:
        if self.has_written:
            raise AssertionError("Firestore transaction query occurred after a write")
        prefix = f"organizations/{org_id}/staffInvitations/"
        candidates = {
            **{
                path: copy.deepcopy(value)
                for path, value in self.values.items()
                if path.startswith(prefix)
            },
            **{
                path: copy.deepcopy(value)
                for path, value in self.creates.items()
                if path.startswith(prefix)
            },
        }
        for path, changes in self.updates.items():
            if path in candidates:
                candidates[path].update(copy.deepcopy(changes))
        return [
            value
            for value in candidates.values()
            if value.get("orgId") == org_id
            and value.get("tokenHash") == token_hash
        ]

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        if path in self.values or path in self.creates:
            raise RuntimeError("duplicate create")
        self.has_written = True
        self.creates[path] = copy.deepcopy(dict(document))

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        if path not in self.values:
            raise RuntimeError("missing update")
        self.has_written = True
        self.updates.setdefault(path, {}).update(copy.deepcopy(dict(changes)))

    def list_active_rooms(self, *, org_id: str) -> list[Mapping[str, Any]]:
        del org_id
        return []


class MemoryRepository:
    def __init__(self) -> None:
        self.documents = documents()
        self.transaction_count = 0
        self.retry_next = False
        self.discarded_audit_paths: list[str] = []

    def read_owner_documents(
        self, *, org_id: str, uid: str, audit_log_id: str
    ) -> OwnerDocuments:
        return MemoryTransaction(self.documents).read_owner_documents(
            org_id=org_id,
            uid=uid,
            audit_log_id=audit_log_id,
        )

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        value = self.documents.get(path)
        return copy.deepcopy(value) if value is not None else None

    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]:
        return [
            copy.deepcopy(value)
            for path, value in self.documents.items()
            if path.startswith("users/") and value.get("orgId") == org_id
        ]

    def find_users_by_email(
        self, *, org_id: str, email: str
    ) -> list[Mapping[str, Any]]:
        return MemoryTransaction(self.documents).find_users_by_email(
            org_id=org_id, email=email
        )

    def list_staff_invitations(self, *, org_id: str) -> list[Mapping[str, Any]]:
        prefix = f"organizations/{org_id}/staffInvitations/"
        return [
            copy.deepcopy(value)
            for path, value in self.documents.items()
            if path.startswith(prefix)
        ]

    def run_transaction(
        self,
        callback: Callable[[CloudOrganizationTransaction], TransactionResult],
    ) -> TransactionResult:
        if self.retry_next:
            self.retry_next = False
            discarded = MemoryTransaction(self.documents)
            callback(discarded)
            self.discarded_audit_paths = [
                path for path in discarded.creates if "/auditLogs/" in path
            ]
        self.transaction_count += 1
        transaction = MemoryTransaction(self.documents)
        result = callback(transaction)
        next_values = copy.deepcopy(self.documents)
        for path, changes in transaction.updates.items():
            next_values[path].update(changes)
        next_values.update(copy.deepcopy(transaction.creates))
        self.documents = next_values
        return result


class FakeEmailSender:
    def __init__(self) -> None:
        self.messages: list[dict[str, str]] = []

    def ensure_configured(self) -> None:
        return None

    def send_invitation(
        self,
        *,
        recipient: str,
        accept_url: str,
        decline_url: str,
        idempotency_key: str,
    ) -> None:
        self.messages.append(
            {
                "recipient": recipient,
                "acceptUrl": accept_url,
                "declineUrl": decline_url,
                "idempotencyKey": idempotency_key,
            }
        )


def service(
    repository: MemoryRepository,
    sender: FakeEmailSender | DisabledInvitationEmailSender,
    *,
    tokens: list[str] | None = None,
) -> CloudInvitationService:
    token_values = iter(tokens or [TOKEN_A])
    return CloudInvitationService(
        repository,
        sender,
        settings(),
        clock=lambda: NOW,
        token_factory=lambda: next(token_values),
    )


def invitation_path() -> str:
    invitation_id = staff_invitation_id(ORG_ID, MEMBER_EMAIL)
    return f"organizations/{ORG_ID}/staffInvitations/{invitation_id}"


def invitation_audits(repository: MemoryRepository) -> list[dict[str, Any]]:
    return [
        document
        for path, document in repository.documents.items()
        if "/auditLogs/staff-invitation-" in path
    ]


def test_disabled_email_provider_still_registers_login_approval() -> None:
    repository = MemoryRepository()
    invitation_service = service(repository, DisabledInvitationEmailSender())

    created = invitation_service.create_invitation(identity(), MEMBER_EMAIL)

    assert created["status"] == "PENDING"
    assert repository.transaction_count == 1
    assert invitation_path() in repository.documents


def test_create_registers_seven_day_login_approval_without_sending_email() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()

    response = service(repository, sender).create_invitation(
        identity(), " MEMBER@NODO-COMPANY.TEST "
    )

    stored = repository.documents[invitation_path()]
    serialized_documents = repr(repository.documents)
    assert response == {
        "id": staff_invitation_id(ORG_ID, MEMBER_EMAIL),
        "email": MEMBER_EMAIL,
        "status": "PENDING",
        "expiresAt": NOW + timedelta(days=7),
        "createdAt": NOW,
        "updatedAt": NOW,
        "acceptedAt": None,
        "declinedAt": None,
        "revokedAt": None,
    }
    assert stored["tokenHash"] == invitation_token_hash(TOKEN_A)
    assert stored["invitedOrganizationRole"] == "INSTRUCTOR"
    assert "rawToken" not in stored
    assert TOKEN_A not in serialized_documents
    assert sender.messages == []
    assert "tokenHash" not in response
    assert invitation_audits(repository)[0]["eventType"] == (
        "ORGANIZATION_INVITATION_CREATED"
    )
    assert "email" not in invitation_audits(repository)[0]
    assert "token" not in repr(invitation_audits(repository)[0])


def test_pending_duplicate_requires_resend_without_second_email() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()
    invitation_service = service(repository, sender, tokens=[TOKEN_A, TOKEN_B])

    invitation_service.create_invitation(identity(), MEMBER_EMAIL)
    with pytest.raises(InvitationAlreadyProcessed, match="승인 갱신"):
        invitation_service.create_invitation(identity(), MEMBER_EMAIL)

    assert sender.messages == []
    assert len(invitation_audits(repository)) == 1
    assert repository.documents[invitation_path()]["tokenHash"] == (
        invitation_token_hash(TOKEN_A)
    )


def test_auth_me_recognizes_new_token_invitation_without_exposing_token() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()
    invitation_service = service(repository, sender)
    invitation_service.create_invitation(identity(), MEMBER_EMAIL)
    organization = CloudOrganizationService(
        repository, settings(), clock=lambda: NOW
    )

    with pytest.raises(OrganizationInvitationAcceptanceRequired) as error:
        organization.authenticated_user(identity(MEMBER_UID, MEMBER_EMAIL))

    assert error.value.public_details == {
        "organizationName": "DEMO",
        "expiresAt": (NOW + timedelta(days=7)).isoformat(),
    }
    assert TOKEN_A not in repr(error.value.public_details)


def test_pending_login_approval_accepts_exact_google_email_without_link() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()
    service(repository, sender).create_invitation(identity(), MEMBER_EMAIL)
    legacy_staff_service = CloudStaffService(
        repository, settings(), clock=lambda: NOW
    )

    profile = legacy_staff_service.accept_invitation(
        identity(MEMBER_UID, MEMBER_EMAIL)
    )

    assert profile["accountType"] == "STAFF"
    assert profile["organizationRole"] == "INSTRUCTOR"
    assert repository.documents[f"users/{MEMBER_UID}"]["membershipStatus"] == "ACTIVE"


def test_approval_refresh_rotates_internal_token_without_sending_email() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()
    invitation_service = service(repository, sender, tokens=[TOKEN_A, TOKEN_B])
    created = invitation_service.create_invitation(identity(), MEMBER_EMAIL)

    resent = invitation_service.resend_invitation(identity(), created["id"])

    assert resent["status"] == "PENDING"
    assert repository.documents[invitation_path()]["revision"] == 2
    assert repository.documents[invitation_path()]["tokenHash"] == (
        invitation_token_hash(TOKEN_B)
    )
    assert sender.messages == []
    assert [audit["eventType"] for audit in invitation_audits(repository)] == [
        "ORGANIZATION_INVITATION_CREATED",
        "ORGANIZATION_INVITATION_RESENT",
    ]


def test_accept_requires_matching_email_and_is_retry_idempotent() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()
    invitation_service = service(repository, sender)
    invitation_service.create_invitation(identity(), MEMBER_EMAIL)
    snapshot = copy.deepcopy(repository.documents)

    with pytest.raises(InvitationEmailMismatch):
        invitation_service.accept_invitation(
            identity("other", "other@nodo-company.test"), TOKEN_A
        )
    assert repository.documents == snapshot

    accepted = invitation_service.accept_invitation(
        identity(MEMBER_UID, MEMBER_EMAIL), TOKEN_A
    )
    repeated = invitation_service.accept_invitation(
        identity(MEMBER_UID, MEMBER_EMAIL), TOKEN_A
    )

    assert accepted["status"] == repeated["status"] == "ACCEPTED"
    assert repository.documents[f"users/{MEMBER_UID}"]["organizationRole"] == (
        "INSTRUCTOR"
    )
    accepted_audits = [
        audit
        for audit in invitation_audits(repository)
        if audit["eventType"] == "ORGANIZATION_INVITATION_ACCEPTED"
    ]
    assert len(accepted_audits) == 1


def test_decline_creates_no_membership_and_cannot_then_accept() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()
    invitation_service = service(repository, sender)
    invitation_service.create_invitation(identity(), MEMBER_EMAIL)

    declined = invitation_service.decline_invitation(
        identity(MEMBER_UID, MEMBER_EMAIL), TOKEN_A
    )

    assert declined["status"] == "DECLINED"
    assert f"users/{MEMBER_UID}" not in repository.documents
    with pytest.raises(InvitationAlreadyProcessed):
        invitation_service.accept_invitation(
            identity(MEMBER_UID, MEMBER_EMAIL), TOKEN_A
        )


def test_revoked_and_invalid_tokens_return_specific_safe_errors() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()
    invitation_service = service(repository, sender)
    created = invitation_service.create_invitation(identity(), MEMBER_EMAIL)
    invitation_service.revoke_invitation(identity(), created["id"])

    with pytest.raises(InvitationRevoked):
        invitation_service.accept_invitation(
            identity(MEMBER_UID, MEMBER_EMAIL), TOKEN_A
        )
    with pytest.raises(InvalidInvitationToken):
        invitation_service.accept_invitation(
            identity(MEMBER_UID, MEMBER_EMAIL), "z" * 43
        )

    assert f"users/{MEMBER_UID}" not in repository.documents


def test_expired_invitation_lists_as_expired_and_cannot_be_accepted() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()
    invitation_service = service(repository, sender)
    invitation_service.create_invitation(identity(), MEMBER_EMAIL)
    repository.documents[invitation_path()]["expiresAt"] = NOW - timedelta(seconds=1)

    listed = invitation_service.list_invitations(identity())

    assert listed["invitations"][0]["status"] == "EXPIRED"
    with pytest.raises(InvitationExpired):
        invitation_service.accept_invitation(
            identity(MEMBER_UID, MEMBER_EMAIL), TOKEN_A
        )
    assert f"users/{MEMBER_UID}" not in repository.documents


def test_accept_restores_removed_membership_without_touching_history() -> None:
    repository = MemoryRepository()
    sender = FakeEmailSender()
    repository.documents[f"users/{MEMBER_UID}"] = {
        "uid": MEMBER_UID,
        "orgId": ORG_ID,
        "accountType": "STAFF",
        "membershipStatus": "REMOVED",
        "organizationRole": "INSTRUCTOR",
        "organizationRoleRevision": 4,
        "isAnonymous": False,
        "email": MEMBER_EMAIL,
        "displayName": "Old name",
        "photoURL": None,
        "schemaVersion": 1,
        "createdAt": NOW - timedelta(days=30),
        "updatedAt": NOW - timedelta(days=1),
        "historicalMarker": "preserve",
    }
    invitation_service = service(repository, sender)
    invitation_service.create_invitation(identity(), MEMBER_EMAIL)

    invitation_service.accept_invitation(
        identity(MEMBER_UID, MEMBER_EMAIL), TOKEN_A
    )

    restored = repository.documents[f"users/{MEMBER_UID}"]
    assert restored["membershipStatus"] == "ACTIVE"
    assert restored["organizationRole"] == "INSTRUCTOR"
    assert restored["organizationRoleRevision"] == 5
    assert restored["historicalMarker"] == "preserve"
    assert restored["createdAt"] == NOW - timedelta(days=30)


def test_revoke_and_transaction_retry_keep_one_audit_per_operation() -> None:
    repository = MemoryRepository()
    repository.retry_next = True
    sender = FakeEmailSender()
    invitation_service = service(repository, sender)

    created = invitation_service.create_invitation(identity(), MEMBER_EMAIL)

    committed_paths = [
        path
        for path in repository.documents
        if "/auditLogs/staff-invitation-created-" in path
    ]
    assert repository.discarded_audit_paths == committed_paths
    assert len(committed_paths) == 1

    revoked = invitation_service.revoke_invitation(identity(), created["id"])
    repeated = invitation_service.revoke_invitation(identity(), created["id"])
    assert revoked["status"] == repeated["status"] == "REVOKED"
    revoked_audits = [
        audit
        for audit in invitation_audits(repository)
        if audit["eventType"] == "ORGANIZATION_INVITATION_REVOKED"
    ]
    assert len(revoked_audits) == 1
