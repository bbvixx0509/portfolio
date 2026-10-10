from typing import Any

import pytest

from app.adapters import firebase_cloud_firestore
from app.adapters.firebase_cloud_firestore import (
    CLOUD_FIRESTORE_FIREBASE_APP_NAME,
    FirestoreCloudMaterialUploadRepository,
    FirestoreCloudOrganizationRepository,
    get_cloud_firestore_app,
    get_cloud_firestore_client,
)
from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EXPECTED_CLOUD_AUTH_DEVELOPMENT_ORIGIN,
    Settings,
)
from app.services.cloud_organization_service import BOOTSTRAP_AUDIT_LOG_ID


def cloud_settings() -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id="example-gcp-project",
        firestore_database_id="(default)",
        bootstrap_org_id="demo",
        bootstrap_org_name="DEMO",
        bootstrap_enabled=False,
        bootstrap_org_owner_emails=frozenset(),
        cors_origins=(EXPECTED_CLOUD_AUTH_DEVELOPMENT_ORIGIN,),
    )


@pytest.fixture(autouse=True)
def clear_forbidden_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "FIREBASE_AUTH_EMULATOR_HOST",
        "FIRESTORE_EMULATOR_HOST",
        "FIREBASE_STORAGE_EMULATOR_HOST",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        monkeypatch.delenv(name, raising=False)


def test_firestore_uses_a_separate_named_app_and_adc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credential = object()
    initialized: dict[str, Any] = {}
    app = type("FakeApp", (), {"project_id": "example-gcp-project"})()

    def missing_app(name: str) -> None:
        assert name == CLOUD_FIRESTORE_FIREBASE_APP_NAME
        raise ValueError("missing")

    def initialize_app(
        actual_credential: object,
        options: dict[str, str],
        *,
        name: str,
    ) -> object:
        initialized.update(
            credential=actual_credential,
            options=options,
            name=name,
        )
        return app

    monkeypatch.setattr(firebase_cloud_firestore.firebase_admin, "get_app", missing_app)
    monkeypatch.setattr(
        firebase_cloud_firestore.credentials,
        "ApplicationDefault",
        lambda: credential,
    )
    monkeypatch.setattr(
        firebase_cloud_firestore.firebase_admin,
        "initialize_app",
        initialize_app,
    )

    result = get_cloud_firestore_app(cloud_settings())

    assert result is app
    assert initialized == {
        "credential": credential,
        "options": {"projectId": "example-gcp-project"},
        "name": "nodo-cloud-firestore",
    }
    assert initialized["name"] != "nodo-cloud-auth"


def test_firestore_client_receives_the_explicit_default_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = object()
    client = object()
    captured: dict[str, Any] = {}
    monkeypatch.setattr(
        firebase_cloud_firestore,
        "get_cloud_firestore_app",
        lambda _settings: app,
    )

    def firestore_client(*, app: object, database_id: str) -> object:
        captured.update(app=app, database_id=database_id)
        return client

    monkeypatch.setattr(
        firebase_cloud_firestore.firestore, "client", firestore_client
    )

    assert get_cloud_firestore_client(cloud_settings()) is client
    assert captured == {"app": app, "database_id": "(default)"}


@pytest.mark.parametrize(
    ("settings_override", "message"),
    [
        ({"firebase_project_id": "wrong-project"}, "project"),
        ({"firestore_database_id": "other"}, "database"),
        ({"bootstrap_org_id": "other"}, "organization id"),
        ({"bootstrap_org_name": "Other"}, "organization name"),
    ],
)
def test_cloud_firestore_fails_closed_for_wrong_fixed_configuration(
    settings_override: dict[str, Any], message: str
) -> None:
    values = {
        "runtime_mode": CLOUD_AUTH_RUNTIME_MODE,
        "firebase_project_id": "example-gcp-project",
        "firestore_database_id": "(default)",
        "bootstrap_org_id": "demo",
        "bootstrap_org_name": "DEMO",
        "bootstrap_enabled": False,
        "bootstrap_org_owner_emails": frozenset(),
    }
    values.update(settings_override)

    with pytest.raises(RuntimeError, match=message):
        get_cloud_firestore_app(Settings(**values))


def test_cloud_firestore_rejects_emulator_and_service_account_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8081")
    with pytest.raises(RuntimeError, match="Emulator"):
        get_cloud_firestore_app(cloud_settings())

    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST")
    monkeypatch.setenv(
        "GOOGLE_APPLICATION_CREDENTIALS", "synthetic-service-account.json"
    )
    with pytest.raises(RuntimeError, match="Service account JSON"):
        get_cloud_firestore_app(cloud_settings())


class FakeSnapshot:
    def __init__(self, reference: "FakeReference", value: Any = None) -> None:
        self.reference = reference
        self.value = value
        self.exists = value is not None

    def to_dict(self) -> Any:
        return self.value


class FakeReference:
    def __init__(self, client: "FakeClient", path: str) -> None:
        self.client = client
        self.path = path

    def collection(self, name: str) -> "FakeCollection":
        return FakeCollection(self.client, f"{self.path}/{name}")

    def get(self, *, transaction: object | None = None) -> FakeSnapshot:
        self.client.events.append(("read", self.path, transaction))
        return FakeSnapshot(self, self.client.values.get(self.path))


class FakeCollection:
    def __init__(self, client: "FakeClient", path: str) -> None:
        self.client = client
        self.path = path

    def document(self, document_id: str) -> FakeReference:
        return FakeReference(self.client, f"{self.path}/{document_id}")

    def where(self, *, filter: Any) -> "FakeQuery":
        return FakeQuery(self.client, self.path, filter)

    def stream(self) -> list[FakeSnapshot]:
        prefix = f"{self.path}/"
        return [
            FakeSnapshot(FakeReference(self.client, path), value)
            for path, value in self.client.values.items()
            if path.startswith(prefix) and "/" not in path[len(prefix) :]
        ]


class FakeQuery:
    def __init__(self, client: "FakeClient", path: str, filter: Any) -> None:
        self.client = client
        self.path = path
        self.filter = filter

    def stream(self) -> list[FakeSnapshot]:
        return [
            snapshot
            for snapshot in FakeCollection(self.client, self.path).stream()
            if (
                snapshot.value.get(self.filter.field_path) in self.filter.value
                if self.filter.op_string == "in"
                else snapshot.value.get(self.filter.field_path) == self.filter.value
            )
        ]


class FakeTransaction:
    def __init__(self, events: list[tuple[Any, ...]]) -> None:
        self.events = events

    def create(self, reference: FakeReference, document: dict[str, Any]) -> None:
        self.events.append(("create", reference.path, document))

    def get(self, query: FakeQuery) -> list[FakeSnapshot]:
        self.events.append(
            (
                "query",
                query.path,
                query.filter.field_path,
                query.filter.value,
            )
        )
        return query.stream()

    def update(self, reference: FakeReference, changes: dict[str, Any]) -> None:
        self.events.append(("update", reference.path, changes))


class FakeClient:
    def __init__(self) -> None:
        self.events: list[tuple[Any, ...]] = []
        self.values: dict[str, dict[str, Any]] = {}
        self.transaction_value = FakeTransaction(self.events)

    def collection(self, name: str) -> FakeCollection:
        return FakeCollection(self, name)

    def document(self, path: str) -> FakeReference:
        return FakeReference(self, path)

    def transaction(self) -> FakeTransaction:
        return self.transaction_value


def test_repository_transaction_reads_before_atomic_creates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = FakeClient()
    repository = FirestoreCloudOrganizationRepository(client)
    monkeypatch.setattr(
        firebase_cloud_firestore.firestore,
        "transactional",
        lambda callback: lambda transaction: callback(transaction),
    )

    def callback(transaction: Any) -> str:
        documents = transaction.read_owner_documents(
            org_id="demo",
            uid="synthetic-owner",
            audit_log_id=BOOTSTRAP_AUDIT_LOG_ID,
        )
        assert documents.organization is None
        assert documents.user is None
        assert documents.audit_log is None
        for path in (
            "organizations/demo",
            "users/synthetic-owner",
            f"organizations/demo/auditLogs/{BOOTSTRAP_AUDIT_LOG_ID}",
        ):
            transaction.create_document(path, {"path": path})
        return "committed"

    assert repository.run_transaction(callback) == "committed"
    assert [event[0] for event in client.events] == [
        "read",
        "read",
        "read",
        "create",
        "create",
        "create",
    ]
    assert [event[1] for event in client.events[3:]] == [
        "organizations/demo",
        "users/synthetic-owner",
        f"organizations/demo/auditLogs/{BOOTSTRAP_AUDIT_LOG_ID}",
    ]


def test_material_draft_claim_creates_one_active_draft_in_its_transaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = FakeClient()
    client.values = {
        "organizations/demo/materialUploads/material-1": {
            "id": "material-1",
            "orgId": "demo",
            "status": "EXTRACTED",
            "extractionStatus": "EXTRACTED",
        }
    }
    repository = FirestoreCloudMaterialUploadRepository(client)
    monkeypatch.setattr(
        firebase_cloud_firestore.firestore,
        "transactional",
        lambda callback: lambda transaction: callback(transaction),
    )
    path = "organizations/demo/materialCourseDrafts/draft-1"

    claimed = repository.claim_course_draft(
        org_id="demo",
        material_id="material-1",
        draft_path=path,
        document={
            "id": "draft-1",
            "orgId": "demo",
            "materialId": "material-1",
            "status": "GENERATING",
        },
    )

    assert claimed.started is True
    assert [event[0] for event in client.events] == ["read", "query", "create"]
    assert client.events[-1][1] == path


def test_material_upload_repository_lists_only_direct_org_upload_metadata() -> None:
    client = FakeClient()
    client.values = {
        "organizations/demo/materialUploads/valid": {"orgId": "demo", "id": "valid"},
        "organizations/demo/materialUploads/wrong": {"orgId": "other", "id": "wrong"},
        "organizations/demo/materialUploads/valid/nested": {
            "orgId": "demo",
            "id": "nested",
        },
    }

    result = FirestoreCloudMaterialUploadRepository(client).list_material_uploads(
        org_id="demo"
    )

    assert result == [{"orgId": "demo", "id": "valid"}]


def test_material_repository_filters_staff_by_organization() -> None:
    client = FakeClient()
    client.values = {
        "users/admin": {
            "uid": "admin",
            "orgId": "demo",
            "accountType": "STAFF",
        },
        "users/instructor": {
            "uid": "instructor",
            "orgId": "demo",
            "accountType": "STAFF",
        },
        "users/student": {
            "uid": "student",
            "orgId": "demo",
            "accountType": "STUDENT",
        },
        "users/other-org": {
            "uid": "other-org",
            "orgId": "other",
            "accountType": "STAFF",
        },
    }

    result = FirestoreCloudMaterialUploadRepository(client).list_staff_members(
        org_id="demo"
    )

    assert result == [
        {"uid": "admin", "orgId": "demo", "accountType": "STAFF"},
        {"uid": "instructor", "orgId": "demo", "accountType": "STAFF"},
    ]


def test_staff_transaction_adapter_reads_queries_and_updates_atomically(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = FakeClient()
    client.values = {
        "organizations/demo/staffInvitations/invitation": {
            "id": "invitation",
            "orgId": "demo",
        },
        "users/staff": {
            "uid": "staff",
            "orgId": "demo",
            "email": "employee@nodo-company.test",
        },
        "users/other-org": {
            "uid": "other-org",
            "orgId": "other",
            "email": "employee@nodo-company.test",
        },
    }
    repository = FirestoreCloudOrganizationRepository(client)
    monkeypatch.setattr(
        firebase_cloud_firestore.firestore,
        "transactional",
        lambda callback: lambda transaction: callback(transaction),
    )

    def callback(transaction: Any) -> None:
        invitation = transaction.read_document(
            "organizations/demo/staffInvitations/invitation"
        )
        users = transaction.find_users_by_email(
            org_id="demo", email="employee@nodo-company.test"
        )
        assert invitation == {"id": "invitation", "orgId": "demo"}
        assert users == [
            {
                "uid": "staff",
                "orgId": "demo",
                "email": "employee@nodo-company.test",
            }
        ]
        transaction.update_document(
            "organizations/demo/staffInvitations/invitation",
            {"status": "REVOKED"},
        )

    repository.run_transaction(callback)

    assert [event[0] for event in client.events] == ["read", "query", "update"]
    assert client.events[-1] == (
        "update",
        "organizations/demo/staffInvitations/invitation",
        {"status": "REVOKED"},
    )


def test_staff_transaction_queries_invitation_token_hash_inside_transaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token_hash = "a" * 64
    client = FakeClient()
    client.values = {
        "organizations/demo/staffInvitations/match": {
            "id": "match",
            "orgId": "demo",
            "tokenHash": token_hash,
        },
        "organizations/demo/staffInvitations/other": {
            "id": "other",
            "orgId": "demo",
            "tokenHash": "b" * 64,
        },
    }
    repository = FirestoreCloudOrganizationRepository(client)
    monkeypatch.setattr(
        firebase_cloud_firestore.firestore,
        "transactional",
        lambda callback: lambda transaction: callback(transaction),
    )

    def callback(transaction: Any) -> None:
        invitations = transaction.find_staff_invitations_by_token_hash(
            org_id="demo", token_hash=token_hash
        )
        assert invitations == [
            {"id": "match", "orgId": "demo", "tokenHash": token_hash}
        ]

    repository.run_transaction(callback)

    assert client.events == [
        (
            "query",
            "organizations/demo/staffInvitations",
            "tokenHash",
            token_hash,
        )
    ]


def test_organization_transaction_lists_only_ready_and_live_rooms_before_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = FakeClient()
    client.values = {
        "organizations/demo/rooms/ready": {
            "id": "ready",
            "orgId": "demo",
            "status": "READY",
        },
        "organizations/demo/rooms/live": {
            "id": "live",
            "orgId": "demo",
            "status": "LIVE",
        },
        "organizations/demo/rooms/ended": {
            "id": "ended",
            "orgId": "demo",
            "status": "ENDED",
        },
        "organizations/demo/rooms/wrong-org": {
            "id": "wrong-org",
            "orgId": "other",
            "status": "READY",
        },
        "users/staff": {"uid": "staff"},
    }
    repository = FirestoreCloudOrganizationRepository(client)
    monkeypatch.setattr(
        firebase_cloud_firestore.firestore,
        "transactional",
        lambda callback: lambda transaction: callback(transaction),
    )

    def callback(transaction: Any) -> None:
        rooms = transaction.list_active_rooms(org_id="demo")
        assert [room["id"] for room in rooms] == ["ready", "live"]
        transaction.update_document(
            "users/staff",
            {"membershipStatus": "REMOVED"},
        )

    repository.run_transaction(callback)

    assert [event[0] for event in client.events] == ["query", "update"]
    assert client.events[0][2:] == ("status", ["READY", "LIVE"])
