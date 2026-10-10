from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import PurePath
from typing import Any, BinaryIO, Protocol
from uuid import uuid4
from zipfile import BadZipFile, ZipFile

from app.core.config import Settings
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    ServiceTemporarilyUnavailable,
)
from app.domain.staff_membership import has_active_membership
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_material_storage_quota_service import (
    CloudMaterialStorageQuotaService,
)

MAX_UPLOAD_BYTES = 30 * 1024 * 1024
MAX_FILENAME_LENGTH = 255
MAX_ZIP_ENTRIES = 1_000
MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
MAX_ZIP_COMPRESSION_RATIO = 100
UPLOAD_SCHEMA_VERSION = 1
SUPPORTED_EXTENSIONS = {
    ".pdf": "application/pdf",
    ".pptx": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ),
}


class CloudMaterialUploadRepository(Protocol):
    @property
    def server_timestamp(self) -> object: ...

    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def create_document(self, path: str, document: Mapping[str, Any]) -> None: ...

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None: ...

    def run_transaction(self, callback: Any) -> Any: ...

    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]: ...


class PrivateStorage(Protocol):
    def upload_source(
        self, *, object_path: str, content_type: str, source: BinaryIO
    ) -> None: ...


def normalize_original_filename(value: object) -> str:
    if not isinstance(value, str):
        raise InvalidOperation("파일 이름을 확인해 주세요.")
    name = value.strip()
    if not name or len(name) > MAX_FILENAME_LENGTH:
        raise InvalidOperation("파일 이름은 1~255자로 사용해 주세요.")
    if any(character in name for character in ("/", "\\", "\x00", "\r", "\n")):
        raise InvalidOperation("파일 이름을 확인해 주세요.")
    return name


def extension_for_filename(filename: str) -> str:
    extension = PurePath(filename).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise InvalidOperation("PPTX 또는 PDF 파일만 업로드할 수 있습니다.")
    return extension


def validate_source_file(*, source: BinaryIO, extension: str, size_bytes: int) -> None:
    if size_bytes <= 0:
        raise InvalidOperation("내용이 없는 파일은 업로드할 수 없습니다.")
    if size_bytes > MAX_UPLOAD_BYTES:
        raise InvalidOperation("파일은 30MB 이하만 업로드할 수 있습니다.")
    source.seek(0)
    if extension == ".pdf":
        if source.read(5) != b"%PDF-":
            raise InvalidOperation("PDF 파일 형식을 확인할 수 없습니다.")
    else:
        _validate_pptx(source)
    source.seek(0)


def _validate_pptx(source: BinaryIO) -> None:
    try:
        with ZipFile(source) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > MAX_ZIP_ENTRIES:
                raise InvalidOperation("PPTX 내부 파일 수가 허용 범위를 벗어났습니다.")
            names = {entry.filename for entry in entries}
            if (
                "[Content_Types].xml" not in names
                or "ppt/presentation.xml" not in names
            ):
                raise InvalidOperation("PPTX 파일 형식을 확인할 수 없습니다.")
            total_uncompressed = sum(entry.file_size for entry in entries)
            total_compressed = sum(entry.compress_size for entry in entries)
            if total_uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES:
                raise InvalidOperation(
                    "PPTX 압축 해제 크기가 허용 범위를 벗어났습니다."
                )
            if total_uncompressed and (
                total_compressed == 0
                or total_uncompressed > total_compressed * MAX_ZIP_COMPRESSION_RATIO
            ):
                raise InvalidOperation("PPTX 압축 비율이 허용 범위를 벗어났습니다.")
    except BadZipFile as error:
        raise InvalidOperation("PPTX 파일 형식을 확인할 수 없습니다.") from error


class CloudMaterialUploadService:
    def __init__(
        self,
        repository: CloudMaterialUploadRepository,
        storage: PrivateStorage | None,
        settings: Settings,
    ) -> None:
        self.repository = repository
        self.storage = storage
        self.settings = settings
        # Unit-only repositories which predate quota transactions still exercise
        # file validation. Production repositories always implement this contract.
        self.quota = (
            CloudMaterialStorageQuotaService(repository, settings)
            if hasattr(repository, "run_transaction")
            else None
        )

    def upload(
        self,
        identity: VerifiedCloudIdentity,
        *,
        original_filename: object,
        content_type_hint: str | None,
        size_bytes: int,
        source: BinaryIO,
    ) -> dict[str, Any]:
        self._require_staff(identity)
        try:
            self.settings.ensure_private_storage_uploads_enabled()
        except RuntimeError as error:
            raise ServiceTemporarilyUnavailable(
                "자료 업로드 저장소가 아직 준비되지 않았습니다."
            ) from error
        if self.storage is None:
            raise ServiceTemporarilyUnavailable(
                "자료 업로드 저장소가 아직 준비되지 않았습니다."
            )

        filename = normalize_original_filename(original_filename)
        extension = extension_for_filename(filename)
        validate_source_file(source=source, extension=extension, size_bytes=size_bytes)

        upload_id = uuid4().hex
        scope_id = f"draft-{upload_id}"
        reservation_id = (
            self.quota.reserve_upload(
                identity, scope_id=scope_id, bytes_count=size_bytes
            )
            if self.quota is not None
            else None
        )
        object_path = (
            f"organizations/{self.settings.bootstrap_org_id}/material-uploads/"
            f"{upload_id}/source{extension}"
        )
        content_type = SUPPORTED_EXTENSIONS[extension]
        timestamp = self.repository.server_timestamp
        document = {
            "id": upload_id,
            "orgId": self.settings.bootstrap_org_id,
            "ownerStaffUid": identity.uid,
            "originalFilename": filename,
            "normalizedExtension": extension.removeprefix("."),
            "sizeBytes": size_bytes,
            "contentType": content_type,
            "storageObjectPath": object_path,
            "status": "UPLOADING",
            "storageQuotaScopeId": scope_id,
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "schemaVersion": UPLOAD_SCHEMA_VERSION,
        }
        metadata_path = self._path(upload_id)
        self.repository.create_document(metadata_path, document)
        try:
            self.storage.upload_source(
                object_path=object_path,
                content_type=content_type,
                source=source,
            )
        except Exception as error:
            # A safe status is useful for retry UI; never persist provider errors,
            # credentials, filename paths, or file content.
            self.repository.update_document(
                metadata_path,
                {"status": "FAILED", "updatedAt": self.repository.server_timestamp},
            )
            if reservation_id and self.quota is not None:
                self.quota.release_upload(
                    identity, scope_id=scope_id, reservation_id=reservation_id
                )
            raise ServiceTemporarilyUnavailable(
                "자료 파일을 저장하지 못했습니다. 다시 시도해 주세요."
            ) from error

        self.repository.update_document(
            metadata_path,
            {"status": "STORED", "updatedAt": self.repository.server_timestamp},
        )
        if reservation_id and self.quota is not None:
            self.quota.confirm_upload(
                identity,
                scope_id=scope_id,
                reservation_id=reservation_id,
                actual_bytes=size_bytes,
            )
        return {
            "uploadId": upload_id,
            "status": "STORED",
            "normalizedExtension": extension.removeprefix("."),
            "sizeBytes": size_bytes,
            "createdAt": _iso_or_none(timestamp),
        }

    def _require_staff(self, identity: VerifiedCloudIdentity) -> None:
        profile = self.repository.read_document(f"users/{identity.uid}")
        if (
            profile is None
            or profile.get("orgId") != self.settings.bootstrap_org_id
            or profile.get("accountType") != "STAFF"
            or not has_active_membership(profile)
            or profile.get("organizationRole") not in {"ADMIN", "INSTRUCTOR"}
        ):
            raise AccessDenied("자료 업로드 권한이 없습니다.")

    def _path(self, upload_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/materialUploads/"
            f"{upload_id}"
        )


def _iso_or_none(value: object) -> str | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.isoformat()
    return None
