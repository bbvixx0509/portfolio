from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from io import BytesIO
from typing import Any, BinaryIO
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    EXPECTED_CLOUD_STORAGE_BUCKET,
    Settings,
)
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    ServiceTemporarilyUnavailable,
)
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_material_upload_service import (
    MAX_UPLOAD_BYTES,
    MAX_ZIP_ENTRIES,
    CloudMaterialUploadService,
)

IDENTITY = VerifiedCloudIdentity(
    uid="staff-uid",
    email="staff@example.test",
    display_name="강사",
    photo_url=None,
)
NOW = datetime(2026, 7, 27, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def cloud_storage_unit_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Exercise the cloud-auth contract without inheriting Emulator test vars."""

    for name in (
        "FIREBASE_AUTH_EMULATOR_HOST",
        "FIRESTORE_EMULATOR_HOST",
        "FIREBASE_STORAGE_EMULATOR_HOST",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        monkeypatch.delenv(name, raising=False)


def cloud_storage_settings(
    *, storage_mode: str = "cloud", bucket: str | None = None
) -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        storage_mode=storage_mode,
        storage_bucket=bucket or EXPECTED_CLOUD_STORAGE_BUCKET,
        google_cloud_project=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        cors_origins=("http://localhost:5175",),
    )


class Repository:
    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {
            "users/staff-uid": {
                "orgId": "demo",
                "accountType": "STAFF",
                "organizationRole": "INSTRUCTOR",
            }
        }

    @property
    def server_timestamp(self) -> object:
        return NOW

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return self.documents.get(path)

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        if path in self.documents:
            raise RuntimeError("duplicate metadata")
        self.documents[path] = dict(document)

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        self.documents[path] = {**self.documents[path], **dict(changes)}


class TransactionalQuotaRepository(Repository):
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


class Storage:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.saved: dict[str, bytes] = {}

    def upload_source(
        self, *, object_path: str, content_type: str, source: BinaryIO
    ) -> None:
        if self.fail:
            raise RuntimeError("provider detail must not persist")
        self.saved[object_path] = source.read()


def pptx() -> BytesIO:
    source = BytesIO()
    with ZipFile(source, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("ppt/presentation.xml", "<p:presentation/>")
    source.seek(0)
    return source


def zip_source(entries: dict[str, bytes]) -> BytesIO:
    source = BytesIO()
    with ZipFile(source, "w", compression=ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    source.seek(0)
    return source


def service(*, fail_storage: bool = False, settings: Settings | None = None):
    repository = Repository()
    storage = Storage(fail=fail_storage)
    return (
        CloudMaterialUploadService(
            repository, storage, settings or cloud_storage_settings()
        ),
        repository,
        storage,
    )


def test_pptx_upload_uses_server_path_and_minimal_metadata() -> None:
    value, repository, storage = service()
    source = pptx()

    result = value.upload(
        IDENTITY,
        original_filename="수업자료.PPTX",
        content_type_hint="application/zip",
        size_bytes=len(source.getvalue()),
        source=source,
    )

    assert result["status"] == "STORED"
    assert len(storage.saved) == 1
    object_path = next(iter(storage.saved))
    assert object_path.startswith("organizations/demo/material-uploads/")
    assert object_path.endswith("/source.pptx")
    metadata = next(
        document
        for path, document in repository.documents.items()
        if "/materialUploads/" in path
    )
    assert metadata["status"] == "STORED"
    assert metadata["storageObjectPath"] == object_path
    assert "email" not in metadata
    assert "token" not in metadata
    assert "file" not in metadata


def test_upload_reserves_before_storage_and_confirms_after_success() -> None:
    repository = TransactionalQuotaRepository()
    storage = Storage()
    value = CloudMaterialUploadService(repository, storage, cloud_storage_settings())

    result = value.upload(
        IDENTITY,
        original_filename="lesson.pdf",
        content_type_hint="application/pdf",
        size_bytes=8,
        source=BytesIO(b"%PDF-1.7"),
    )

    assert result["status"] == "STORED"
    assert len(storage.saved) == 1
    reservations = [
        document
        for path, document in repository.documents.items()
        if "/storageQuotaReservations/" in path
    ]
    assert len(reservations) == 1
    assert reservations[0]["status"] == "CONFIRMED"


def test_pdf_signature_and_pptx_ooxml_are_required() -> None:
    value, _, _ = service()
    with pytest.raises(InvalidOperation):
        value.upload(
            IDENTITY,
            original_filename="spoof.pdf",
            content_type_hint=None,
            size_bytes=5,
            source=BytesIO(b"hello"),
        )


def test_upload_limits_and_zip_bombs_are_rejected_before_storage() -> None:
    value, _, storage = service()
    with pytest.raises(InvalidOperation):
        value.upload(
            IDENTITY,
            original_filename="empty.pdf",
            content_type_hint=None,
            size_bytes=0,
            source=BytesIO(),
        )
    with pytest.raises(InvalidOperation):
        value.upload(
            IDENTITY,
            original_filename="large.pdf",
            content_type_hint=None,
            size_bytes=MAX_UPLOAD_BYTES + 1,
            source=BytesIO(b"%PDF-1.7"),
        )

    entries = {
        "[Content_Types].xml": b"<Types/>",
        "ppt/presentation.xml": b"<p:presentation/>",
        **{f"ppt/slides/slide-{index}.xml": b"x" for index in range(MAX_ZIP_ENTRIES)},
    }
    too_many_entries = zip_source(entries)
    with pytest.raises(InvalidOperation):
        value.upload(
            IDENTITY,
            original_filename="many.pptx",
            content_type_hint=None,
            size_bytes=len(too_many_entries.getvalue()),
            source=too_many_entries,
        )
    high_ratio = zip_source(
        {
            "[Content_Types].xml": b"<Types/>",
            "ppt/presentation.xml": b"A" * 1_000_000,
        }
    )
    with pytest.raises(InvalidOperation):
        value.upload(
            IDENTITY,
            original_filename="ratio.pptx",
            content_type_hint=None,
            size_bytes=len(high_ratio.getvalue()),
            source=high_ratio,
        )
    assert storage.saved == {}
    with pytest.raises(InvalidOperation):
        value.upload(
            IDENTITY,
            original_filename="spoof.pptx",
            content_type_hint=None,
            size_bytes=4,
            source=BytesIO(b"PK\x03\x04"),
        )


def test_storage_failure_marks_metadata_failed_without_provider_detail() -> None:
    value, repository, _ = service(fail_storage=True)
    with pytest.raises(ServiceTemporarilyUnavailable):
        value.upload(
            IDENTITY,
            original_filename="lesson.pdf",
            content_type_hint="application/pdf",
            size_bytes=8,
            source=BytesIO(b"%PDF-1.7"),
        )
    metadata = next(
        document
        for path, document in repository.documents.items()
        if "/materialUploads/" in path
    )
    assert metadata["status"] == "FAILED"
    assert "provider detail" not in str(metadata)


def test_non_staff_and_disabled_or_wrong_bucket_are_fail_closed() -> None:
    value, repository, _ = service()
    repository.documents["users/staff-uid"]["accountType"] = "STUDENT"
    with pytest.raises(AccessDenied):
        value.upload(
            IDENTITY,
            original_filename="lesson.pdf",
            content_type_hint=None,
            size_bytes=8,
            source=BytesIO(b"%PDF-1.7"),
        )

    disabled, _, _ = service(settings=cloud_storage_settings(storage_mode="disabled"))
    with pytest.raises(ServiceTemporarilyUnavailable):
        disabled.upload(
            IDENTITY,
            original_filename="lesson.pdf",
            content_type_hint=None,
            size_bytes=8,
            source=BytesIO(b"%PDF-1.7"),
        )
    mismatched, _, _ = service(settings=cloud_storage_settings(bucket="wrong-bucket"))
    with pytest.raises(ServiceTemporarilyUnavailable):
        mismatched.upload(
            IDENTITY,
            original_filename="lesson.pdf",
            content_type_hint=None,
            size_bytes=8,
            source=BytesIO(b"%PDF-1.7"),
        )
