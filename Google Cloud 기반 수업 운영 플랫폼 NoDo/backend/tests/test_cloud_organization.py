import copy
import threading
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any, TypeVar

import pytest

from app.core.config import CLOUD_AUTH_RUNTIME_MODE, Settings
from app.domain.errors import (
    AccessDenied,
    OrganizationBootstrapRequired,
    ResourceConflict,
)
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import (
    BOOTSTRAP_AUDIT_LOG_ID,
    CloudOrganizationService,
    CloudOrganizationTransaction,
    OwnerDocuments,
)

OWNER_EMAIL = "owner@example.test"
SECOND_EMAIL = "second@example.test"
OWNER_UID = "owner-uid"
SECOND_UID = "second-uid"
FIXED_TIMESTAMP = datetime(2026, 7, 16, 12, 0, tzinfo=UTC)
TransactionResult = TypeVar("TransactionResult")


def cloud_settings(
    *,
    enabled: bool = True,
    emails: frozenset[str] = frozenset({OWNER_EMAIL}),
) -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id="example-gcp-project",
        firestore_database_id="(default)",
        bootstrap_org_id="demo",
        bootstrap_org_name="DEMO",
        bootstrap_enabled=enabled,
        bootstrap_org_owner_emails=emails,
    )


def identity(
    uid: str = OWNER_UID, email: str = OWNER_EMAIL
) -> VerifiedCloudIdentity:
    return VerifiedCloudIdentity(
        uid=uid,
        email=email,
        display_name="Synthetic Owner",
        photo_url="https://example.test/avatar.png",
    )


def owner_paths(uid: str = OWNER_UID) -> tuple[str, str, str]:
    return (
        "organizations/demo",
        f"users/{uid}",
        f"organizations/demo/auditLogs/{BOOTSTRAP_AUDIT_LOG_ID}",
    )


class InMemoryTransaction:
    def __init__(self, documents: dict[str, dict[str, Any]]) -> None:
        self.documents = documents
        self.pending: dict[str, dict[str, Any]] = {}

    @property
    def server_timestamp(self) -> object:
        return FIXED_TIMESTAMP

    def read_owner_documents(
        self, *, org_id: str, uid: str, audit_log_id: str
    ) -> OwnerDocuments:
        paths = (
            f"organizations/{org_id}",
            f"users/{uid}",
            f"organizations/{org_id}/auditLogs/{audit_log_id}",
        )
        values = [self.documents.get(path) for path in paths]
        return OwnerDocuments(
            organization=copy.deepcopy(values[0]),
            user=copy.deepcopy(values[1]),
            audit_log=copy.deepcopy(values[2]),
        )

    def create_document(
        self, path: str, document: Mapping[str, Any]
    ) -> None:
        if path in self.documents or path in self.pending:
            raise ResourceConflict("A Bootstrap document already exists")
        self.pending[path] = copy.deepcopy(dict(document))


class InMemoryRepository:
    def __init__(self, *, fail_on_commit: bool = False) -> None:
        self.documents: dict[str, dict[str, Any]] = {}
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
            next_documents.update(transaction.pending)
            self.documents = next_documents
            return result


def test_missing_organization_requires_bootstrap_only_for_allowed_email() -> None:
    repository = InMemoryRepository()
    service = CloudOrganizationService(repository, cloud_settings())

    with pytest.raises(OrganizationBootstrapRequired) as error:
        service.authenticated_user(identity())
    assert error.value.status_code == 409
    assert error.value.code == "ORGANIZATION_BOOTSTRAP_REQUIRED"

    with pytest.raises(AccessDenied):
        service.authenticated_user(identity(email="other@example.test"))
    assert repository.documents == {}


def test_bootstrap_creates_only_the_three_required_documents() -> None:
    repository = InMemoryRepository()
    service = CloudOrganizationService(repository, cloud_settings())

    response = service.bootstrap_organization(identity())

    assert set(repository.documents) == set(owner_paths())
    organization = repository.documents[owner_paths()[0]]
    user = repository.documents[owner_paths()[1]]
    audit_log = repository.documents[owner_paths()[2]]
    assert organization == {
        "id": "demo",
        "orgId": "demo",
        "name": "DEMO",
        "adminCount": 1,
        "bootstrapState": "COMPLETED",
        "schemaVersion": 1,
        "createdAt": FIXED_TIMESTAMP,
        "updatedAt": FIXED_TIMESTAMP,
    }
    assert user["email"] == OWNER_EMAIL
    assert user["accountType"] == "STAFF"
    assert user["organizationRole"] == "ADMIN"
    assert user["organizationRoleRevision"] == 1
    assert user["isAnonymous"] is False
    assert audit_log["before"] is None
    assert audit_log["after"] == {
        "accountType": "STAFF",
        "organizationRole": "ADMIN",
    }
    assert "email" not in organization
    assert "email" not in audit_log
    assert "token" not in audit_log
    assert response["orgId"] == "demo"
    assert response["organizationRole"] == "ADMIN"
    assert response["isAdmin"] is True
    assert response["authorized"] is True


def test_same_uid_bootstrap_is_idempotent_without_duplicate_audit_log() -> None:
    repository = InMemoryRepository()
    service = CloudOrganizationService(repository, cloud_settings())

    first = service.bootstrap_organization(identity())
    first_documents = copy.deepcopy(repository.documents)
    second = service.bootstrap_organization(identity())

    assert second == first
    assert repository.documents == first_documents
    assert repository.transaction_count == 2
    assert sum("/auditLogs/" in path for path in repository.documents) == 1


def test_different_uid_cannot_replace_existing_administrator() -> None:
    repository = InMemoryRepository()
    settings = cloud_settings(
        emails=frozenset({OWNER_EMAIL, SECOND_EMAIL})
    )
    service = CloudOrganizationService(repository, settings)
    service.bootstrap_organization(identity())
    original = copy.deepcopy(repository.documents)

    with pytest.raises(ResourceConflict, match="inconsistent"):
        service.bootstrap_organization(identity(SECOND_UID, SECOND_EMAIL))

    assert repository.documents == original
    assert f"users/{SECOND_UID}" not in repository.documents


def test_same_email_with_different_uid_does_not_grant_permanent_owner() -> None:
    repository = InMemoryRepository()
    service = CloudOrganizationService(repository, cloud_settings())
    service.bootstrap_organization(identity())

    with pytest.raises(AccessDenied):
        service.authenticated_user(identity(SECOND_UID, OWNER_EMAIL))
    with pytest.raises(ResourceConflict):
        service.bootstrap_organization(identity(SECOND_UID, OWNER_EMAIL))


def test_incomplete_existing_state_stops_without_automatic_repair() -> None:
    repository = InMemoryRepository()
    repository.documents[owner_paths()[0]] = {
        "id": "demo",
        "orgId": "demo",
        "name": "DEMO",
        "bootstrapState": "COMPLETED",
        "schemaVersion": 1,
        "createdAt": FIXED_TIMESTAMP,
        "updatedAt": FIXED_TIMESTAMP,
    }
    original = copy.deepcopy(repository.documents)
    service = CloudOrganizationService(repository, cloud_settings())

    with pytest.raises(ResourceConflict, match="inconsistent"):
        service.bootstrap_organization(identity())

    assert repository.documents == original


def test_transaction_failure_leaves_no_partial_documents() -> None:
    repository = InMemoryRepository(fail_on_commit=True)
    service = CloudOrganizationService(repository, cloud_settings())

    with pytest.raises(RuntimeError, match="commit failure"):
        service.bootstrap_organization(identity())

    assert repository.documents == {}


def test_disabled_bootstrap_rejects_creation_but_keeps_existing_uid_login() -> None:
    repository = InMemoryRepository()
    enabled_service = CloudOrganizationService(repository, cloud_settings())
    enabled_service.bootstrap_organization(identity())

    disabled_service = CloudOrganizationService(
        repository,
        cloud_settings(enabled=False, emails=frozenset()),
    )
    response = disabled_service.authenticated_user(
        identity(email="renamed-owner@example.test")
    )

    assert response["uid"] == OWNER_UID
    assert response["organizationRole"] == "ADMIN"
    with pytest.raises(AccessDenied):
        CloudOrganizationService(
            InMemoryRepository(),
            cloud_settings(enabled=False, emails=frozenset()),
        ).bootstrap_organization(identity())


def test_company_admin_staff_authentication_reflects_latest_admin_flag() -> None:
    repository = InMemoryRepository()
    service = CloudOrganizationService(repository, cloud_settings())
    service.bootstrap_organization(identity())
    repository.documents[f"users/{SECOND_UID}"] = {
        "uid": SECOND_UID,
        "orgId": "demo",
        "accountType": "STAFF",
            "organizationRole": "ADMIN",
            "organizationRoleRevision": 1,
        "isAnonymous": False,
        "email": SECOND_EMAIL,
        "displayName": "Company Admin",
        "photoURL": None,
        "joinedByInvitationId": "a" * 64,
        "schemaVersion": 1,
        "createdAt": FIXED_TIMESTAMP,
        "updatedAt": FIXED_TIMESTAMP,
    }

    granted = service.authenticated_user(identity(SECOND_UID, SECOND_EMAIL))
    repository.documents[f"users/{SECOND_UID}"]["organizationRole"] = "INSTRUCTOR"
    revoked = service.authenticated_user(identity(SECOND_UID, SECOND_EMAIL))

    assert granted["organizationRole"] == "ADMIN"
    assert granted["isAdmin"] is True
    assert revoked["organizationRole"] == "INSTRUCTOR"


def test_two_concurrent_users_result_in_exactly_one_admin() -> None:
    repository = InMemoryRepository()
    service = CloudOrganizationService(
        repository,
        cloud_settings(emails=frozenset({OWNER_EMAIL, SECOND_EMAIL})),
    )
    start = threading.Barrier(2)

    def attempt(candidate: VerifiedCloudIdentity) -> str:
        start.wait()
        try:
            service.bootstrap_organization(candidate)
        except ResourceConflict:
            return "conflict"
        return "success"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                attempt,
                [identity(), identity(SECOND_UID, SECOND_EMAIL)],
            )
        )

    assert sorted(results) == ["conflict", "success"]
    assert len(repository.documents) == 3
    organization = repository.documents["organizations/demo"]
    assert organization["adminCount"] == 1
    assert sum(path.startswith("users/") for path in repository.documents) == 1
    assert sum("/auditLogs/" in path for path in repository.documents) == 1


def test_two_concurrent_calls_for_same_uid_are_both_idempotent_successes() -> None:
    repository = InMemoryRepository()
    service = CloudOrganizationService(repository, cloud_settings())
    start = threading.Barrier(2)

    def attempt() -> dict[str, Any]:
        start.wait()
        return service.bootstrap_organization(identity())

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _index: attempt(), range(2)))

    assert all(result["uid"] == OWNER_UID for result in results)
    assert len(repository.documents) == 3
    assert sum("/auditLogs/" in path for path in repository.documents) == 1
