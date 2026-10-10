from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any, BinaryIO, Protocol
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from app.core.config import Settings
from app.domain.errors import AccessDenied, InvalidOperation
from app.domain.staff_membership import has_active_membership
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_material_upload_service import (
    MAX_UPLOAD_BYTES,
    SUPPORTED_EXTENSIONS,
    validate_source_file,
)

EXTRACTION_VERSION = 1
EXTRACTION_SCHEMA_VERSION = 1
MAX_EXTRACTED_UNITS = 300
MAX_EXTRACTED_CHARACTERS = 1_000_000

_PPTX_NAMESPACES = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


@dataclass(frozen=True)
class SourceObjectInfo:
    generation: str | None
    size_bytes: int | None


@dataclass(frozen=True)
class ExtractionClaim:
    document: Mapping[str, Any] | None
    started: bool


class CloudMaterialExtractionRepository(Protocol):
    @property
    def server_timestamp(self) -> object: ...

    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None: ...

    def claim_extraction(self, path: str) -> ExtractionClaim: ...

    def list_owned_uploads(
        self, *, org_id: str, owner_staff_uid: str
    ) -> list[Mapping[str, Any]]: ...


class PrivateExtractionStorage(Protocol):
    def download_source(
        self, *, object_path: str, destination: BinaryIO
    ) -> SourceObjectInfo: ...

    def upload_extraction(
        self, *, object_path: str, source: BinaryIO
    ) -> None: ...


class ExtractionFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class CloudMaterialExtractionService:
    """Server-only, bounded text extraction for one private material upload."""

    def __init__(
        self,
        repository: CloudMaterialExtractionRepository,
        storage: PrivateExtractionStorage | None,
        settings: Settings,
    ) -> None:
        self.repository = repository
        self.storage = storage
        self.settings = settings

    def start(self, identity: VerifiedCloudIdentity, upload_id: str) -> dict[str, Any]:
        self._require_storage()
        path = self._path(upload_id)
        document = self._read_owned_stored_upload(identity, path)
        if document["status"] == "EXTRACTED":
            return self._summary(upload_id, document)
        if document["status"] in {"EXTRACTING", "EXTRACTION_QUEUED"}:
            return self._summary(upload_id, document)

        claim = self.repository.claim_extraction(path)
        claimed_document = claim.document
        if claimed_document is None:
            raise InvalidOperation("자료 추출 상태를 확인할 수 없습니다.")
        self._assert_owner(identity, claimed_document)
        if not claim.started:
            return self._summary(upload_id, claimed_document)

        try:
            result, source_info = self._extract(claimed_document)
            extraction_path = self._extraction_path(upload_id)
            with TemporaryDirectory(prefix="nodo-material-extraction-") as directory:
                result_path = Path(directory) / "extraction.json"
                with result_path.open("w", encoding="utf-8") as output:
                    json.dump(
                        result,
                        output,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                with result_path.open("rb") as output:
                    self.storage.upload_extraction(
                        object_path=extraction_path,
                        source=output,
                    )
        except ExtractionFailure as error:
            return self._mark_failed(path, upload_id, claimed_document, error.code)
        except Exception:
            # Provider and parser details can contain internal paths.  They are
            # deliberately not persisted or returned to the browser.
            return self._mark_failed(
                path,
                upload_id,
                claimed_document,
                "EXTRACTION_UNAVAILABLE",
            )

        summary_changes = {
            "status": "EXTRACTED",
            "extractionStatus": "EXTRACTED",
            "extractionVersion": EXTRACTION_VERSION,
            "sourceObjectGeneration": source_info.generation,
            "pageCount": result.get("pageCount"),
            "slideCount": result.get("slideCount"),
            "extractedCharacterCount": result["extractedCharacterCount"],
            "completedAt": self.repository.server_timestamp,
            "updatedAt": self.repository.server_timestamp,
            "failureCode": None,
        }
        self.repository.update_document(path, summary_changes)
        return self._summary(upload_id, {**claimed_document, **summary_changes})

    def get_status(
        self, identity: VerifiedCloudIdentity, upload_id: str
    ) -> dict[str, Any]:
        self._require_storage()
        document = self._read_owned_stored_upload(identity, self._path(upload_id))
        return self._summary(upload_id, document)

    def latest(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        """Return one safe, owner-only metadata summary for the upload screen."""

        self._require_storage()
        self._require_staff(identity)
        documents = [
            document
            for document in self.repository.list_owned_uploads(
                org_id=self.settings.bootstrap_org_id,
                owner_staff_uid=identity.uid,
            )
            if document.get("orgId") == self.settings.bootstrap_org_id
            and document.get("status")
            in {
                "STORED",
                "EXTRACTION_QUEUED",
                "EXTRACTING",
                "EXTRACTED",
                "EXTRACTION_FAILED",
            }
        ]
        if not documents:
            raise InvalidOperation("읽을 수 있는 저장 자료가 없습니다.")
        document = max(documents, key=_created_at_sort_key)
        self._assert_owner(identity, document)
        return self._summary(self._upload_id(document), document)

    def _extract(
        self, document: Mapping[str, Any]
    ) -> tuple[dict[str, Any], SourceObjectInfo]:
        extension = self._extension(document)
        upload_id = self._upload_id(document)
        expected_source_path = self._source_path(upload_id, extension)
        if document.get("storageObjectPath") != expected_source_path:
            raise ExtractionFailure("SOURCE_PATH_INVALID")
        if self.storage is None:
            raise ExtractionFailure("STORAGE_UNAVAILABLE")

        with TemporaryDirectory(prefix="nodo-material-source-") as directory:
            source_path = Path(directory) / f"source{extension}"
            with source_path.open("w+b") as destination:
                source_info = self.storage.download_source(
                    object_path=expected_source_path,
                    destination=destination,
                )
            size_bytes = source_info.size_bytes
            if (
                not isinstance(size_bytes, int)
                or not 0 < size_bytes <= MAX_UPLOAD_BYTES
            ):
                raise ExtractionFailure("SOURCE_SIZE_INVALID")
            with source_path.open("rb") as source:
                try:
                    validate_source_file(
                        source=source,
                        extension=extension,
                        size_bytes=size_bytes,
                    )
                except InvalidOperation as error:
                    raise ExtractionFailure("SOURCE_VALIDATION_FAILED") from error
            if extension == ".pdf":
                result = _extract_pdf(source_path)
            else:
                result = _extract_pptx(source_path)
        return result, source_info

    def _mark_failed(
        self,
        path: str,
        upload_id: str,
        document: Mapping[str, Any],
        failure_code: str,
    ) -> dict[str, Any]:
        changes = {
            "status": "EXTRACTION_FAILED",
            "extractionStatus": "EXTRACTION_FAILED",
            "failureCode": failure_code,
            "updatedAt": self.repository.server_timestamp,
        }
        self.repository.update_document(path, changes)
        return self._summary(upload_id, {**document, **changes})

    def _read_owned_stored_upload(
        self, identity: VerifiedCloudIdentity, path: str
    ) -> Mapping[str, Any]:
        document = self.repository.read_document(path)
        if document is None:
            raise InvalidOperation("자료를 찾을 수 없습니다.")
        self._assert_owner(identity, document)
        if document.get("status") not in {
            "STORED",
            "EXTRACTION_QUEUED",
            "EXTRACTING",
            "EXTRACTED",
            "EXTRACTION_FAILED",
        }:
            raise InvalidOperation("저장 완료된 자료만 읽을 수 있습니다.")
        return document

    def _assert_owner(
        self, identity: VerifiedCloudIdentity, document: Mapping[str, Any]
    ) -> None:
        profile = self.repository.read_document(f"users/{identity.uid}")
        if (
            profile is None
            or profile.get("orgId") != self.settings.bootstrap_org_id
            or profile.get("accountType") != "STAFF"
            or not has_active_membership(profile)
            or profile.get("organizationRole") not in {"ADMIN", "INSTRUCTOR"}
            or document.get("orgId") != self.settings.bootstrap_org_id
            or document.get("ownerStaffUid") != identity.uid
        ):
            raise AccessDenied("자료 추출 권한이 없습니다.")

    def _require_staff(self, identity: VerifiedCloudIdentity) -> None:
        profile = self.repository.read_document(f"users/{identity.uid}")
        if (
            profile is None
            or profile.get("orgId") != self.settings.bootstrap_org_id
            or profile.get("accountType") != "STAFF"
            or not has_active_membership(profile)
            or profile.get("organizationRole") not in {"ADMIN", "INSTRUCTOR"}
        ):
            raise AccessDenied("자료 추출 권한이 없습니다.")

    def _require_storage(self) -> None:
        try:
            self.settings.ensure_private_storage_uploads_enabled()
        except RuntimeError as error:
            raise InvalidOperation(
                "자료 추출 저장소가 아직 준비되지 않았습니다."
            ) from error
        if self.storage is None:
            raise InvalidOperation("자료 추출 저장소가 아직 준비되지 않았습니다.")

    def _extension(self, document: Mapping[str, Any]) -> str:
        normalized_extension = document.get("normalizedExtension")
        if not isinstance(normalized_extension, str):
            raise ExtractionFailure("SOURCE_METADATA_INVALID")
        extension = f".{normalized_extension.lower()}"
        if extension not in SUPPORTED_EXTENSIONS:
            raise ExtractionFailure("SOURCE_METADATA_INVALID")
        return extension

    def _upload_id(self, document: Mapping[str, Any]) -> str:
        upload_id = document.get("id")
        if not isinstance(upload_id, str) or not upload_id:
            raise ExtractionFailure("SOURCE_METADATA_INVALID")
        return upload_id

    def _path(self, upload_id: str) -> str:
        if not upload_id or any(value in upload_id for value in ("/", "\\", "\x00")):
            raise InvalidOperation("자료 식별자를 확인해 주세요.")
        return (
            f"organizations/{self.settings.bootstrap_org_id}/materialUploads/{upload_id}"
        )

    def _source_path(self, upload_id: str, extension: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/material-uploads/"
            f"{upload_id}/source{extension}"
        )

    def _extraction_path(self, upload_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/material-uploads/"
            f"{upload_id}/extraction.json"
        )

    @staticmethod
    def _summary(upload_id: str, document: Mapping[str, Any]) -> dict[str, Any]:
        summary = {
            "uploadId": upload_id,
            "status": document.get("status"),
            "normalizedExtension": document.get("normalizedExtension"),
            "pageCount": document.get("pageCount"),
            "slideCount": document.get("slideCount"),
            "extractedCharacterCount": document.get("extractedCharacterCount"),
            "failureCode": document.get("failureCode"),
        }
        # Internal object names and complete extraction content stay in Storage.
        return summary


def _extract_pdf(source_path: Path) -> dict[str, Any]:
    try:
        with source_path.open("rb") as source:
            reader = PdfReader(source, strict=True)
            if reader.is_encrypted:
                raise ExtractionFailure("PDF_ENCRYPTED")
            if len(reader.pages) > MAX_EXTRACTED_UNITS:
                raise ExtractionFailure("PAGE_LIMIT_EXCEEDED")
            pages: list[dict[str, Any]] = []
            character_count = 0
            for page_number, page in enumerate(reader.pages, start=1):
                text = page.extract_text() or ""
                character_count = _bounded_character_count(character_count, text)
                pages.append({"pageNumber": page_number, "text": text})
    except ExtractionFailure:
        raise
    except (PdfReadError, OSError, ValueError) as error:
        raise ExtractionFailure("PDF_INVALID") from error
    return {
        "schemaVersion": EXTRACTION_SCHEMA_VERSION,
        "kind": "PDF",
        "pageCount": len(pages),
        "extractedCharacterCount": character_count,
        "pages": pages,
    }


def _extract_pptx(source_path: Path) -> dict[str, Any]:
    try:
        with ZipFile(source_path) as archive:
            names = set(archive.namelist())
            slide_paths = _pptx_slide_paths(archive, names)
            if len(slide_paths) > MAX_EXTRACTED_UNITS:
                raise ExtractionFailure("SLIDE_LIMIT_EXCEEDED")
            slides: list[dict[str, Any]] = []
            character_count = 0
            for slide_number, slide_path in enumerate(slide_paths, start=1):
                root = ElementTree.fromstring(archive.read(slide_path))
                text = _slide_text(root)
                character_count = _bounded_character_count(character_count, text)
                slides.append(
                    {
                        "slideNumber": slide_number,
                        "titleCandidate": _slide_title_candidate(root, text),
                        "text": text,
                    }
                )
    except ExtractionFailure:
        raise
    except (BadZipFile, ElementTree.ParseError, KeyError, OSError) as error:
        raise ExtractionFailure("PPTX_INVALID") from error
    return {
        "schemaVersion": EXTRACTION_SCHEMA_VERSION,
        "kind": "PPTX",
        "slideCount": len(slides),
        "extractedCharacterCount": character_count,
        "slides": slides,
    }


def _pptx_slide_paths(archive: ZipFile, names: set[str]) -> list[str]:
    try:
        presentation = ElementTree.fromstring(archive.read("ppt/presentation.xml"))
        relationships = ElementTree.fromstring(
            archive.read("ppt/_rels/presentation.xml.rels")
        )
    except (KeyError, ElementTree.ParseError) as error:
        raise ExtractionFailure("PPTX_INVALID") from error
    targets = {
        relationship.attrib.get("Id"): relationship.attrib.get("Target")
        for relationship in relationships.findall("rel:Relationship", _PPTX_NAMESPACES)
    }
    paths: list[str] = []
    for slide in presentation.findall(".//p:sldId", _PPTX_NAMESPACES):
        relationship_id = slide.attrib.get(
            f"{{{_PPTX_NAMESPACES['r']}}}id"
        )
        target = targets.get(relationship_id)
        if not isinstance(target, str):
            raise ExtractionFailure("PPTX_INVALID")
        candidate = PurePosixPath("ppt") / PurePosixPath(target)
        normalized = candidate.as_posix()
        if (
            candidate.is_absolute()
            or ".." in candidate.parts
            or not normalized.startswith("ppt/slides/")
            or normalized not in names
        ):
            raise ExtractionFailure("PPTX_INVALID")
        paths.append(normalized)
    if not paths:
        raise ExtractionFailure("PPTX_INVALID")
    return paths


def _slide_text(root: ElementTree.Element) -> str:
    parts = [
        value.text or ""
        for value in root.findall(".//a:t", _PPTX_NAMESPACES)
        if value.text
    ]
    return "\n".join(parts)


def _slide_title_candidate(root: ElementTree.Element, fallback_text: str) -> str | None:
    for shape in root.findall(".//p:sp", _PPTX_NAMESPACES):
        placeholder = shape.find(".//p:nvPr/p:ph", _PPTX_NAMESPACES)
        if placeholder is None or placeholder.attrib.get("type") not in {
            "title",
            "ctrTitle",
        }:
            continue
        value = _slide_text(shape).strip()
        if value:
            return value
    for line in fallback_text.splitlines():
        if line.strip():
            return line.strip()
    return None


def _bounded_character_count(current: int, value: str) -> int:
    next_value = current + len(value)
    if next_value > MAX_EXTRACTED_CHARACTERS:
        raise ExtractionFailure("CHARACTER_LIMIT_EXCEEDED")
    return next_value


def _created_at_sort_key(document: Mapping[str, Any]) -> str:
    value = document.get("createdAt")
    if hasattr(value, "isoformat"):
        return str(value.isoformat())
    return str(value or "")
