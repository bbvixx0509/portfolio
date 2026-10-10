# ruff: noqa: E501
from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pytest

from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    EXPECTED_CLOUD_STORAGE_BUCKET,
    Settings,
)
from app.domain.errors import AccessDenied, InvalidOperation, StorageQuotaExceeded
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_material_storage_quota_service import (
    DEFAULT_INSTRUCTOR_LIMIT_BYTES,
    GIB,
    MIB,
    ORGANIZATION_LIMIT_BYTES,
    PERSONAL_QUOTA_MESSAGE,
    CloudMaterialStorageQuotaService,
)


class Repository:
    server_timestamp = datetime(2026, 7, 28, tzinfo=UTC)

    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {
            "users/lead": {
                "uid": "lead",
                "orgId": "demo",
                "accountType": "STAFF",
                "organizationRole": "INSTRUCTOR",
            },
            "users/admin": {
                "uid": "admin",
                "orgId": "demo",
                "accountType": "STAFF",
                "organizationRole": "ADMIN",
            },
        }
        self.material_uploads: list[dict[str, Any]] = []

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return self.documents.get(path)

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        self.documents[path] = dict(document)

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        self.documents[path] = {**self.documents[path], **dict(changes)}

    def list_expired_reservations(self, *, collection_path: str, before: datetime):
        return [
            (path, document)
            for path, document in self.documents.items()
            if path.startswith(f"{collection_path}/")
            and document.get("status") == "RESERVED"
            and isinstance(document.get("expiresAt"), datetime)
            and document["expiresAt"] <= before
        ]

    def run_transaction(self, callback):
        return callback(self)

    def list_staff_members(self, *, org_id: str):
        return [
            item
            for item in self.documents.values()
            if item.get("orgId") == org_id and item.get("accountType") == "STAFF"
        ]

    def list_material_uploads(self, *, org_id: str):
        return [
            item for item in self.material_uploads if item.get("orgId") == org_id
        ]


class ReadBeforeWriteRepository(Repository):
    """Fake that enforces the Firestore transaction read-before-write rule."""

    def __init__(self) -> None:
        super().__init__()
        self._in_transaction = False
        self._has_written = False

    def _assert_read_is_allowed(self) -> None:
        if self._in_transaction and self._has_written:
            raise RuntimeError("read after write")

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        self._assert_read_is_allowed()
        return super().read_document(path)

    def list_expired_reservations(self, *, collection_path: str, before: datetime):
        self._assert_read_is_allowed()
        return super().list_expired_reservations(
            collection_path=collection_path, before=before
        )

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        self._has_written = True
        super().create_document(path, document)

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        self._has_written = True
        super().update_document(path, changes)

    def run_transaction(self, callback):
        self._in_transaction = True
        self._has_written = False
        try:
            return callback(self)
        finally:
            self._in_transaction = False


def identity(uid="lead"):
    return VerifiedCloudIdentity(
        uid=uid, email=f"{uid}@example.test", display_name="강사", photo_url=None
    )


def settings():
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        storage_mode="cloud",
        storage_bucket=EXPECTED_CLOUD_STORAGE_BUCKET,
        google_cloud_project=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    )


def service(repository: Repository | None = None):
    return CloudMaterialStorageQuotaService(repository or Repository(), settings())


def test_default_reservation_confirm_and_release() -> None:
    value = service()
    reservation = value.reserve_upload(
        identity(), scope_id="draft-a", bytes_count=30 * MIB
    )
    assert value.own_usage(identity())["reservedBytes"] == 30 * MIB
    value.confirm_upload(
        identity(),
        scope_id="draft-a",
        reservation_id=reservation,
        actual_bytes=30 * MIB,
    )
    assert value.own_usage(identity())["usedBytes"] == 30 * MIB
    second = value.reserve_upload(identity(), scope_id="draft-b", bytes_count=MIB)
    value.release_upload(identity(), scope_id="draft-b", reservation_id=second)
    assert value.own_usage(identity())["reservedBytes"] == 0


def test_own_usage_marks_a_missing_personal_counter_as_pending_without_writing() -> None:
    repo = Repository()
    before = {path: dict(document) for path, document in repo.documents.items()}

    result = service(repo).own_usage(identity())

    assert result == {
        "usedBytes": 0,
        "reservedBytes": 0,
        "limitBytes": DEFAULT_INSTRUCTOR_LIMIT_BYTES,
        "remainingBytes": DEFAULT_INSTRUCTOR_LIMIT_BYTES,
        "baselineState": "PENDING_BASELINE",
    }
    assert repo.documents == before


def test_reservation_lifecycle_reads_all_documents_before_transaction_writes() -> None:
    value = service(ReadBeforeWriteRepository())
    reservation = value.reserve_upload(
        identity(), scope_id="draft-a", bytes_count=30 * MIB
    )
    value.confirm_upload(
        identity(),
        scope_id="draft-a",
        reservation_id=reservation,
        actual_bytes=30 * MIB,
    )
    second = value.reserve_upload(identity(), scope_id="draft-b", bytes_count=MIB)
    value.release_upload(identity(), scope_id="draft-b", reservation_id=second)
    assert value.own_usage(identity())["usedBytes"] == 30 * MIB


def test_personal_and_scope_and_organization_limits_are_safe() -> None:
    value = service()
    repo = value.repository
    repo.documents[value._instructor_path("lead")] = {
        "usedBytes": DEFAULT_INSTRUCTOR_LIMIT_BYTES - 10 * MIB,
        "reservedBytes": 0,
        "limitBytes": DEFAULT_INSTRUCTOR_LIMIT_BYTES,
        "baselineState": "READY",
    }
    with pytest.raises(StorageQuotaExceeded, match=PERSONAL_QUOTA_MESSAGE):
        value.reserve_upload(identity(), scope_id="draft-a", bytes_count=11 * MIB)
    repo.documents[value._instructor_path("lead")] = {
        "usedBytes": 0,
        "reservedBytes": 0,
        "limitBytes": DEFAULT_INSTRUCTOR_LIMIT_BYTES,
        "baselineState": "READY",
    }
    with pytest.raises(StorageQuotaExceeded):
        value.reserve_upload(identity(), scope_id="draft-a", bytes_count=301 * MIB)
    repo.documents[value._organization_path()] = {
        "usedBytes": ORGANIZATION_LIMIT_BYTES - MIB,
        "reservedBytes": 0,
        "limitBytes": ORGANIZATION_LIMIT_BYTES,
        "baselineState": "READY",
    }
    with pytest.raises(StorageQuotaExceeded):
        value.reserve_upload(identity(), scope_id="draft-b", bytes_count=2 * MIB)


def test_admin_limit_requires_admin_and_never_drops_under_usage() -> None:
    value = service()
    repo = value.repository
    value.set_instructor_limit(
        identity("admin"), target_key=value._member_key("lead"), limit_bytes=10 * GIB
    )
    assert value.own_usage(identity())["limitBytes"] == 10 * GIB
    repo.documents[value._instructor_path("lead")]["usedBytes"] = (
        2 * GIB
    )
    with pytest.raises(InvalidOperation):
        value.set_instructor_limit(
            identity("admin"), target_key=value._member_key("lead"), limit_bytes=GIB
        )
    with pytest.raises(AccessDenied):
        value.set_instructor_limit(
            identity(), target_key=value._member_key("lead"), limit_bytes=10 * GIB
        )
    assert all(
        "originalFilename" not in item and "email" not in item
        for path, item in repo.documents.items()
        if "auditLogs" in path
    )


def test_pending_baseline_is_not_silently_zeroed() -> None:
    value = service()
    value.repository.documents[value._instructor_path("lead")] = {
        "usedBytes": 0,
        "reservedBytes": 0,
        "limitBytes": DEFAULT_INSTRUCTOR_LIMIT_BYTES,
        "baselineState": "PENDING_BASELINE",
    }
    with pytest.raises(InvalidOperation):
        value.reserve_upload(identity(), scope_id="draft-a", bytes_count=MIB)


def test_new_instructor_receives_the_default_five_gib_limit() -> None:
    value = service()
    snapshot = value.own_usage(identity())
    assert snapshot["limitBytes"] == DEFAULT_INSTRUCTOR_LIMIT_BYTES == 5 * GIB
    assert snapshot["remainingBytes"] == 5 * GIB


def test_competing_reservations_only_allow_one_when_thirty_mebibytes_remain() -> None:
    value = service()
    value.repository.documents[value._instructor_path("lead")] = {
        "usedBytes": 0,
        "reservedBytes": 0,
        "limitBytes": 50 * MIB,
        "baselineState": "READY",
    }
    first = value.reserve_upload(identity(), scope_id="draft-a", bytes_count=30 * MIB)
    with pytest.raises(StorageQuotaExceeded, match=PERSONAL_QUOTA_MESSAGE):
        value.reserve_upload(identity(), scope_id="draft-b", bytes_count=30 * MIB)
    value.release_upload(identity(), scope_id="draft-a", reservation_id=first)
    assert value.own_usage(identity())["reservedBytes"] == 0


def test_quota_counter_paths_are_valid_firestore_document_paths() -> None:
    value = service()
    assert all(
        len(path.split("/")) % 2 == 0
        for path in value._paths("lead", "draft-a", "reservation-a")
    )


def test_expired_reservation_is_released_before_the_next_reservation() -> None:
    value = service(ReadBeforeWriteRepository())
    expired = value.reserve_upload(identity(), scope_id="draft-old", bytes_count=30 * MIB)
    _, _, _, expired_path = value._paths("lead", "draft-old", expired)
    value.repository.documents[expired_path]["expiresAt"] = datetime(2026, 1, 1, tzinfo=UTC)
    next_reservation = value.reserve_upload(
        identity(), scope_id="draft-new", bytes_count=30 * MIB
    )
    assert value.repository.documents[expired_path]["status"] == "EXPIRED"
    assert value.own_usage(identity())["reservedBytes"] == 30 * MIB
    assert next_reservation


def test_baseline_uses_storage_metadata_as_absolute_usage_and_preserves_reservations() -> None:
    repo = Repository()
    repo.material_uploads = [
        {
            "orgId": "demo",
            "ownerStaffUid": "lead",
            "sizeBytes": 12,
            "storageObjectPath": "organizations/demo/material-uploads/one/source.pdf",
        },
        {
            "orgId": "demo",
            "ownerStaffUid": "admin",
            "sizeBytes": 34,
            "storageObjectPath": "organizations/demo/material-uploads/two/source.pptx",
        },
    ]
    value = service(repo)
    lead_path = value._instructor_path("lead")
    repo.documents[lead_path] = {
        "usedBytes": 999,
        "reservedBytes": 7,
        "limitBytes": DEFAULT_INSTRUCTOR_LIMIT_BYTES,
        "baselineState": "PENDING_BASELINE",
    }
    sizes = {
        "organizations/demo/material-uploads/one/source.pdf": 12,
        "organizations/demo/material-uploads/two/source.pptx": 34,
    }

    baseline = value.calculate_baseline(object_size=sizes.get)

    assert baseline.material_count == 2
    assert baseline.confirmed_count == 2
    assert baseline.pending_count == 0
    assert baseline.instructor_used_bytes == {"lead": 12, "admin": 34}
    assert baseline.organization_used_bytes == 46
    value.apply_baseline(baseline)
    assert repo.documents[lead_path]["usedBytes"] == 12
    assert repo.documents[lead_path]["reservedBytes"] == 7
    assert repo.documents[lead_path]["baselineState"] == "BASELINED"
    assert repo.documents[value._organization_path()]["usedBytes"] == 46


@pytest.mark.parametrize(
    "material, sizes, reason",
    [
        (
            {"orgId": "demo", "sizeBytes": 1, "storageObjectPath": "organizations/demo/material-uploads/a/source.pdf"},
            {"organizations/demo/material-uploads/a/source.pdf": 1},
            "OWNER_MISSING",
        ),
        (
            {"orgId": "demo", "ownerStaffUid": "lead", "sizeBytes": 1, "storageObjectPath": "outside/source.pdf"},
            {"outside/source.pdf": 1},
            "OBJECT_PATH_INVALID",
        ),
        (
            {"orgId": "demo", "ownerStaffUid": "lead", "sizeBytes": 1, "storageObjectPath": "organizations/demo/material-uploads/a/source.pdf"},
            {"organizations/demo/material-uploads/a/source.pdf": 2},
            "OBJECT_SIZE_MISMATCH",
        ),
    ],
)
def test_baseline_keeps_mismatched_materials_pending_without_writing(
    material, sizes, reason
) -> None:
    repo = Repository()
    repo.material_uploads = [material]
    value = service(repo)
    baseline = value.calculate_baseline(object_size=sizes.get)

    assert baseline.pending_count == 1
    assert baseline.pending_reasons == {reason: 1}
    with pytest.raises(InvalidOperation):
        value.apply_baseline(baseline)
    assert value._organization_path() not in repo.documents


def test_baseline_is_idempotent_for_the_same_valid_snapshot() -> None:
    repo = Repository()
    path = "organizations/demo/material-uploads/a/source.pdf"
    repo.material_uploads = [
        {
            "orgId": "demo",
            "ownerStaffUid": "lead",
            "sizeBytes": 123,
            "storageObjectPath": path,
        }
    ]
    value = service(repo)

    first = value.calculate_baseline(object_size={path: 123}.get)
    value.apply_baseline(first)
    second = value.calculate_baseline(object_size={path: 123}.get)
    value.apply_baseline(second)

    assert repo.documents[value._organization_path()]["usedBytes"] == 123
    assert repo.documents[value._instructor_path("lead")]["usedBytes"] == 123


@pytest.mark.parametrize("limit_gib", [10, 20, 50, 37])
def test_admin_can_set_quick_or_direct_limits(limit_gib: int) -> None:
    value = service()
    result = value.set_instructor_limit(
        identity("admin"),
        target_key=value._member_key("lead"),
        limit_bytes=limit_gib * GIB,
    )
    assert result["limitBytes"] == limit_gib * GIB


def test_admin_usage_list_is_read_only() -> None:
    repo = Repository()
    before_documents = {path: dict(document) for path, document in repo.documents.items()}
    before_uploads = list(repo.material_uploads)

    result = service(repo).list_instructor_usage(identity("admin"))

    assert [item["memberKey"] for item in result["instructors"]]
    assert repo.documents == before_documents
    assert repo.material_uploads == before_uploads


@pytest.mark.parametrize("uid", ["student", "outside"])
def test_non_staff_or_other_org_cannot_manage_storage(uid: str) -> None:
    value = service()
    value.repository.documents[f"users/{uid}"] = {
        "uid": uid,
        "orgId": "other" if uid == "outside" else "demo",
        "accountType": "STUDENT" if uid == "student" else "STAFF",
        "organizationRole": "ADMIN",
    }
    with pytest.raises(AccessDenied):
        value.list_instructor_usage(identity(uid))
