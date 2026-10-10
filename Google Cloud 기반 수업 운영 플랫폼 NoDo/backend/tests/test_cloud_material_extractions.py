from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from io import BytesIO
from typing import Any, BinaryIO
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    EXPECTED_CLOUD_STORAGE_BUCKET,
    Settings,
)
from app.domain.errors import AccessDenied, InvalidOperation
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_material_extraction_service import (
    CloudMaterialExtractionService,
    ExtractionClaim,
    SourceObjectInfo,
)

IDENTITY = VerifiedCloudIdentity(
    uid="staff-uid",
    email="staff@example.test",
    display_name="강사",
    photo_url=None,
)
OTHER_IDENTITY = VerifiedCloudIdentity(
    uid="other-staff-uid",
    email="other@example.test",
    display_name="다른 강사",
    photo_url=None,
)
NOW = datetime(2026, 7, 27, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def cloud_storage_unit_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "FIREBASE_AUTH_EMULATOR_HOST",
        "FIRESTORE_EMULATOR_HOST",
        "FIREBASE_STORAGE_EMULATOR_HOST",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        monkeypatch.delenv(name, raising=False)


def cloud_storage_settings(*, bucket: str | None = None) -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        storage_mode="cloud",
        storage_bucket=bucket or EXPECTED_CLOUD_STORAGE_BUCKET,
        google_cloud_project=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    )


class Repository:
    def __init__(self, *, extension: str = "pdf") -> None:
        self.upload_id = "upload-1"
        self.path = f"organizations/demo/materialUploads/{self.upload_id}"
        self.source_path = (
            f"organizations/demo/material-uploads/{self.upload_id}/source.{extension}"
        )
        self.documents: dict[str, dict[str, Any]] = {
            "users/staff-uid": {
                "orgId": "demo",
                "accountType": "STAFF",
                "organizationRole": "INSTRUCTOR",
            },
            "users/other-staff-uid": {
                "orgId": "demo",
                "accountType": "STAFF",
                "organizationRole": "INSTRUCTOR",
            },
            self.path: {
                "id": self.upload_id,
                "orgId": "demo",
                "ownerStaffUid": "staff-uid",
                "normalizedExtension": extension,
                "storageObjectPath": self.source_path,
                "status": "STORED",
                "createdAt": NOW,
            },
        }
        self.claims = 0

    @property
    def server_timestamp(self) -> object:
        return NOW

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return self.documents.get(path)

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        self.documents[path] = {**self.documents[path], **dict(changes)}

    def claim_extraction(self, path: str) -> ExtractionClaim:
        document = self.documents.get(path)
        if document is None or document.get("status") not in {
            "STORED",
            "EXTRACTION_FAILED",
        }:
            return ExtractionClaim(document=document, started=False)
        self.claims += 1
        updated = {
            **document,
            "status": "EXTRACTING",
            "extractionStatus": "EXTRACTING",
            "extractionVersion": 1,
            "failureCode": None,
        }
        self.documents[path] = updated
        return ExtractionClaim(document=updated, started=True)

    def list_owned_uploads(
        self, *, org_id: str, owner_staff_uid: str
    ) -> list[Mapping[str, Any]]:
        return [
            document
            for document in self.documents.values()
            if document.get("orgId") == org_id
            and document.get("ownerStaffUid") == owner_staff_uid
        ]


class Storage:
    def __init__(self, *, fail_extraction_upload: bool = False) -> None:
        self.sources: dict[str, bytes] = {}
        self.extractions: dict[str, bytes] = {}
        self.fail_extraction_upload = fail_extraction_upload
        self.downloads = 0

    def download_source(
        self, *, object_path: str, destination: BinaryIO
    ) -> SourceObjectInfo:
        self.downloads += 1
        content = self.sources[object_path]
        destination.write(content)
        return SourceObjectInfo(generation="1", size_bytes=len(content))

    def upload_extraction(self, *, object_path: str, source: BinaryIO) -> None:
        if self.fail_extraction_upload:
            raise RuntimeError("provider path should not be exposed")
        self.extractions[object_path] = source.read()


def pdf(pages: list[str]) -> bytes:
    writer = PdfWriter()
    for value in pages:
        page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {
                NameObject("/Font"): DictionaryObject(
                    {NameObject("/F1"): font}
                )
            }
        )
        stream = DecodedStreamObject()
        escaped = value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream.set_data(f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode())
        page[NameObject("/Contents")] = stream
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def pptx(slides: list[tuple[str | None, str]]) -> bytes:
    output = BytesIO()
    relationships = "".join(
        f'<Relationship Id="rId{index}" Type="slide" Target="slides/slide{index}.xml"/>'
        for index in range(1, len(slides) + 1)
    )
    identifiers = "".join(
        f'<p:sldId id="{255 + index}" r:id="rId{index}"/>'
        for index in range(1, len(slides) + 1)
    )
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr(
            "ppt/presentation.xml",
            '<p:presentation xmlns:p="http://schemas.openxmlformats.org/'
            'presentationml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f"<p:sldIdLst>{identifiers}</p:sldIdLst></p:presentation>",
        )
        archive.writestr(
            "ppt/_rels/presentation.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{relationships}</Relationships>",
        )
        for index, (title, text) in enumerate(slides, start=1):
            title_shape = ""
            if title is not None:
                title_shape = (
                    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>'
                    f"<p:txBody><a:p><a:r><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp>"
                )
            archive.writestr(
                f"ppt/slides/slide{index}.xml",
                '<p:sld xmlns:p="http://schemas.openxmlformats.org/'
                'presentationml/2006/main" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                f"<p:cSld><p:spTree>{title_shape}"
                f"<p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>"
                "</p:spTree></p:cSld></p:sld>",
            )
    return output.getvalue()


def service(*, extension: str = "pdf", fail_extraction_upload: bool = False):
    repository = Repository(extension=extension)
    storage = Storage(fail_extraction_upload=fail_extraction_upload)
    return (
        CloudMaterialExtractionService(repository, storage, cloud_storage_settings()),
        repository,
        storage,
    )


def test_pdf_extraction_keeps_text_in_private_json_and_metadata_summary_only() -> None:
    value, repository, storage = service()
    storage.sources[repository.source_path] = pdf(["First page", "Second page"])

    result = value.start(IDENTITY, repository.upload_id)

    assert result == {
        "uploadId": "upload-1",
        "status": "EXTRACTED",
        "normalizedExtension": "pdf",
        "pageCount": 2,
        "slideCount": None,
        "extractedCharacterCount": len("First page") + len("Second page"),
        "failureCode": None,
    }
    extraction = json.loads(next(iter(storage.extractions.values())))
    assert [page["pageNumber"] for page in extraction["pages"]] == [1, 2]
    assert extraction["pages"][0]["text"] == "First page"
    metadata = repository.documents[repository.path]
    assert metadata["status"] == "EXTRACTED"
    assert metadata["pageCount"] == 2
    assert "pages" not in metadata
    assert "storageObjectPath" not in result
    assert "text" not in result


def test_pptx_extraction_preserves_slide_order_and_title_candidates() -> None:
    value, repository, storage = service(extension="pptx")
    storage.sources[repository.source_path] = pptx(
        [("첫 제목", "첫 본문"), (None, "둘째 본문")]
    )

    result = value.start(IDENTITY, repository.upload_id)

    extraction = json.loads(next(iter(storage.extractions.values())))
    assert result["slideCount"] == 2
    assert [slide["slideNumber"] for slide in extraction["slides"]] == [1, 2]
    assert extraction["slides"][0]["titleCandidate"] == "첫 제목"
    assert extraction["slides"][1]["titleCandidate"] == "둘째 본문"


@pytest.mark.parametrize(
    ("extension", "source"),
    [("pdf", lambda: pdf([""])), ("pptx", lambda: pptx([(None, "")]))],
)
def test_empty_text_documents_complete_safely(extension: str, source: Any) -> None:
    value, repository, storage = service(extension=extension)
    storage.sources[repository.source_path] = source()

    result = value.start(IDENTITY, repository.upload_id)

    assert result["status"] == "EXTRACTED"
    assert result["extractedCharacterCount"] == 0


def test_corrupt_or_storage_failed_source_becomes_safe_retryable_failure() -> None:
    value, repository, storage = service()
    storage.sources[repository.source_path] = b"%PDF-not-a-valid-document"

    result = value.start(IDENTITY, repository.upload_id)

    assert result["status"] == "EXTRACTION_FAILED"
    assert result["failureCode"] == "PDF_INVALID"
    assert "not-a-valid" not in str(repository.documents[repository.path])

    failing, failing_repository, failing_storage = service(fail_extraction_upload=True)
    failing_storage.sources[failing_repository.source_path] = pdf(["본문"])
    failed = failing.start(IDENTITY, failing_repository.upload_id)
    assert failed["failureCode"] == "EXTRACTION_UNAVAILABLE"


def test_page_and_character_limits_fail_without_private_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, repository, storage = service()
    storage.sources[repository.source_path] = pdf(["a", "b"])
    monkeypatch.setattr(
        "app.services.cloud_material_extraction_service.MAX_EXTRACTED_UNITS", 1
    )

    result = value.start(IDENTITY, repository.upload_id)
    assert result["failureCode"] == "PAGE_LIMIT_EXCEEDED"
    assert storage.extractions == {}

    value, repository, storage = service()
    storage.sources[repository.source_path] = pdf(["too long"])
    monkeypatch.setattr(
        "app.services.cloud_material_extraction_service.MAX_EXTRACTED_UNITS", 300
    )
    monkeypatch.setattr(
        "app.services.cloud_material_extraction_service.MAX_EXTRACTED_CHARACTERS", 2
    )
    result = value.start(IDENTITY, repository.upload_id)
    assert result["failureCode"] == "CHARACTER_LIMIT_EXCEEDED"


def test_duplicate_requests_do_not_re_read_or_rewrite_completed_extraction() -> None:
    value, repository, storage = service()
    storage.sources[repository.source_path] = pdf(["본문"])

    first = value.start(IDENTITY, repository.upload_id)
    second = value.start(IDENTITY, repository.upload_id)

    assert first["status"] == second["status"] == "EXTRACTED"
    assert repository.claims == 1
    assert storage.downloads == 1
    assert len(storage.extractions) == 1


@pytest.mark.parametrize("identity", [OTHER_IDENTITY, IDENTITY])
def test_owner_and_staff_boundaries_are_enforced(
    identity: VerifiedCloudIdentity,
) -> None:
    value, repository, storage = service()
    storage.sources[repository.source_path] = pdf(["본문"])
    if identity is IDENTITY:
        repository.documents["users/staff-uid"]["accountType"] = "STUDENT"
    with pytest.raises(AccessDenied):
        value.start(identity, repository.upload_id)


def test_invalid_source_path_and_wrong_bucket_fail_closed() -> None:
    value, repository, storage = service()
    storage.sources[repository.source_path] = pdf(["본문"])
    repository.documents[repository.path]["storageObjectPath"] = "other/path.pdf"
    result = value.start(IDENTITY, repository.upload_id)
    assert result["failureCode"] == "SOURCE_PATH_INVALID"

    bad_settings = CloudMaterialExtractionService(
        repository,
        storage,
        cloud_storage_settings(bucket="not-nodo"),
    )
    with pytest.raises(InvalidOperation):
        bad_settings.get_status(IDENTITY, repository.upload_id)


def test_latest_only_returns_the_authenticated_owner_safe_summary() -> None:
    value, repository, storage = service()
    storage.sources[repository.source_path] = pdf(["본문"])
    latest = value.latest(IDENTITY)
    assert latest["uploadId"] == repository.upload_id
    assert "storageObjectPath" not in latest
    with pytest.raises(InvalidOperation):
        value.latest(OTHER_IDENTITY)
