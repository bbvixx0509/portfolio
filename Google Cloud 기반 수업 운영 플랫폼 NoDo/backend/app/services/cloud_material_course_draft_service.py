from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, BinaryIO, Protocol, TypeVar
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.config import Settings
from app.domain.errors import AccessDenied, InvalidOperation, ResourceConflict
from app.domain.staff_membership import has_active_membership
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_course_service import CloudCourseTransaction
from app.services.cloud_organization_service import SCHEMA_VERSION

PROMPT_VERSION = "material-course-draft-v1"
MAX_CHAPTERS = 8
MAX_ITEMS_PER_CHAPTER = 10
MAX_TOTAL_ITEMS = 40
MAX_SOURCE_REFERENCES = 20
TransactionResult = TypeVar("TransactionResult")


@dataclass(frozen=True)
class DraftGenerationClaim:
    document: Mapping[str, Any] | None
    started: bool


class CloudMaterialCourseDraftRepository(Protocol):
    @property
    def server_timestamp(self) -> object: ...

    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None: ...

    def claim_course_draft(
        self,
        *,
        org_id: str,
        material_id: str,
        draft_path: str,
        document: Mapping[str, Any],
    ) -> DraftGenerationClaim: ...

    def run_transaction(
        self,
        callback: Callable[[CloudCourseTransaction], TransactionResult],
    ) -> TransactionResult: ...


class PrivateDraftExtractionStorage(Protocol):
    def download_extraction(
        self, *, object_path: str, destination: BinaryIO
    ) -> None: ...


class GeminiCourseDraftAdapter(Protocol):
    model_id: str

    def generate_course_draft(self, *, prompt: str) -> str: ...


class DraftGenerationFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class GeneratedCourseItem(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=600)
    sourcePageOrSlideNumbers: list[int] = Field(min_length=1, max_length=20)


class GeneratedCourseChapter(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=160)
    items: list[GeneratedCourseItem] = Field(
        min_length=1, max_length=MAX_ITEMS_PER_CHAPTER
    )


class GeneratedCourseDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    suggestedTitle: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=1_500)
    chapters: list[GeneratedCourseChapter] = Field(
        min_length=1, max_length=MAX_CHAPTERS
    )


class CloudMaterialCourseDraftService:
    """Server-only Gemini course-draft generation from private extraction JSON."""

    def __init__(
        self,
        repository: CloudMaterialCourseDraftRepository,
        storage: PrivateDraftExtractionStorage | None,
        gemini: GeminiCourseDraftAdapter | None,
        settings: Settings,
    ) -> None:
        self.repository = repository
        self.storage = storage
        self.gemini = gemini
        self.settings = settings

    def create(
        self, identity: VerifiedCloudIdentity, material_id: str
    ) -> dict[str, Any]:
        self._require_vertex()
        material_path = self._material_path(material_id)
        material = self.repository.read_document(material_path)
        if material is None:
            raise InvalidOperation("자료를 찾을 수 없습니다.")
        self._assert_material_access(identity, material)
        self._assert_extractable(material, material_id)

        draft_id = uuid4().hex
        draft_path = self._draft_path(draft_id)
        initial_document = {
            "id": draft_id,
            "orgId": self.settings.bootstrap_org_id,
            "materialId": material_id,
            "status": "GENERATING",
            "modelId": self.gemini.model_id if self.gemini else None,
            "promptVersion": PROMPT_VERSION,
            "sourceMaterialRevision": self._source_revision(material),
            "sourceWasTruncated": False,
            "creatorUid": identity.uid,
            "failureCode": None,
            "revision": 1,
            "createdAt": self.repository.server_timestamp,
            "updatedAt": self.repository.server_timestamp,
        }
        claim = self.repository.claim_course_draft(
            org_id=self.settings.bootstrap_org_id,
            material_id=material_id,
            draft_path=draft_path,
            document=initial_document,
        )
        if claim.document is None:
            raise InvalidOperation("자료 초안 생성 상태를 확인할 수 없습니다.")
        self._assert_draft_access(identity, claim.document)
        if not claim.started:
            return self._summary(claim.document)

        try:
            normalized, was_truncated, max_unit_number = self._normalized_extraction(
                material, material_id
            )
            response_text = self.gemini.generate_course_draft(
                prompt=_draft_prompt(normalized)
            )
            generated = _validated_generated_draft(response_text, max_unit_number)
        except DraftGenerationFailure as error:
            return self._mark_failed(draft_path, initial_document, error.code)
        except Exception:
            # Provider details can include request or infrastructure identifiers.
            # Keep them server-side and expose only a stable failure category.
            return self._mark_failed(
                draft_path, initial_document, "GENERATION_UNAVAILABLE"
            )

        changes = {
            "status": "GENERATED",
            "suggestedTitle": generated["suggestedTitle"],
            "summary": generated["summary"],
            "chapters": generated["chapters"],
            "sourceWasTruncated": was_truncated,
            "failureCode": None,
            "revision": 2,
            "updatedAt": self.repository.server_timestamp,
        }
        self.repository.update_document(draft_path, changes)
        return self._summary({**initial_document, **changes})

    def get(self, identity: VerifiedCloudIdentity, draft_id: str) -> dict[str, Any]:
        document = self.repository.read_document(self._draft_path(draft_id))
        if document is None:
            raise InvalidOperation("자료 초안을 찾을 수 없습니다.")
        self._assert_draft_access(identity, document)
        return self._summary(document)

    def apply(
        self,
        identity: VerifiedCloudIdentity,
        draft_id: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Turn one generated draft into one editable, reusable course.

        A draft may only be applied once.  The course, draft status change, and
        audit document deliberately share the same Firestore transaction so a
        retry cannot create a second course or a partial audit trail.
        """

        self._assert_identifier(draft_id, "초안")
        course_id = uuid4().hex
        expected_revision = self._expected_revision(payload)

        def apply(transaction: CloudCourseTransaction) -> None:
            draft_path = self._draft_path(draft_id)
            draft = transaction.read_document(draft_path)
            self._assert_transaction_draft_access(transaction, identity, draft)
            self._require_generated_draft(draft, draft_id, expected_revision)
            material_id = self._draft_material_id(draft)
            material = transaction.read_document(self._material_path(material_id))
            source_file_type = self._source_file_type(material, material_id)
            normalized = self._normalize_apply_payload(payload, draft)
            timestamp = transaction.server_timestamp
            transaction.create_document(
                self._course_path(course_id),
                self._new_course_document(
                    course_id=course_id,
                    identity=identity,
                    draft_id=draft_id,
                    material_id=material_id,
                    source_file_type=source_file_type,
                    normalized=normalized,
                    timestamp=timestamp,
                ),
            )
            transaction.update_document(
                draft_path,
                {
                    "status": "APPLIED",
                    "appliedCourseId": course_id,
                    "appliedAt": timestamp,
                    "updatedAt": timestamp,
                    "revision": expected_revision + 1,
                },
            )
            self._audit(
                transaction,
                event="MATERIAL_DRAFT_APPLIED",
                draft_id=draft_id,
                course_id=course_id,
                identity=identity,
                revision=expected_revision + 1,
                timestamp=timestamp,
            )

        self.repository.run_transaction(apply)
        document = self.repository.read_document(self._draft_path(draft_id))
        if document is None:
            raise InvalidOperation("적용한 자료 초안을 확인할 수 없습니다.")
        self._assert_draft_access(identity, document)
        course = self.repository.read_document(self._course_path(course_id))
        if course is None:
            raise InvalidOperation("적용한 수업을 확인할 수 없습니다.")
        return {
            "draft": self._summary(document),
            "course": {
                "id": course_id,
                "title": course.get("title"),
                "status": "ACTIVE",
                "revision": 1,
            },
        }

    def discard(
        self,
        identity: VerifiedCloudIdentity,
        draft_id: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        """Mark a generated draft as discarded without deleting its record."""

        self._assert_identifier(draft_id, "초안")

        def discard(transaction: CloudCourseTransaction) -> None:
            draft_path = self._draft_path(draft_id)
            draft = transaction.read_document(draft_path)
            self._assert_transaction_draft_access(transaction, identity, draft)
            self._require_generated_draft(draft, draft_id, expected_revision)
            timestamp = transaction.server_timestamp
            transaction.update_document(
                draft_path,
                {
                    "status": "DISCARDED",
                    "discardedAt": timestamp,
                    "discardedByUid": identity.uid,
                    "updatedAt": timestamp,
                    "revision": expected_revision + 1,
                },
            )
            self._audit(
                transaction,
                event="MATERIAL_DRAFT_DISCARDED",
                draft_id=draft_id,
                course_id=None,
                identity=identity,
                revision=expected_revision + 1,
                timestamp=timestamp,
            )

        self.repository.run_transaction(discard)
        document = self.repository.read_document(self._draft_path(draft_id))
        if document is None:
            raise InvalidOperation("폐기한 자료 초안을 확인할 수 없습니다.")
        self._assert_draft_access(identity, document)
        return self._summary(document)

    def _normalized_extraction(
        self, material: Mapping[str, Any], material_id: str
    ) -> tuple[dict[str, Any], bool, int]:
        if self.storage is None:
            raise DraftGenerationFailure("EXTRACTION_UNAVAILABLE")
        extension = material.get("normalizedExtension")
        if extension not in {"pdf", "pptx"}:
            raise DraftGenerationFailure("EXTRACTION_INVALID")
        with TemporaryDirectory(prefix="nodo-material-draft-") as directory:
            extraction_path = Path(directory) / "extraction.json"
            with extraction_path.open("w+b") as destination:
                self.storage.download_extraction(
                    object_path=self._extraction_path(material_id),
                    destination=destination,
                )
            try:
                parsed = json.loads(extraction_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise DraftGenerationFailure("EXTRACTION_INVALID") from error
        return _normalized_extraction_input(
            parsed,
            document_title=_safe_material_title(material),
            max_characters=self.settings.vertex_ai_max_input_characters,
        )

    def _mark_failed(
        self,
        draft_path: str,
        document: Mapping[str, Any],
        failure_code: str,
    ) -> dict[str, Any]:
        changes = {
            "status": "FAILED",
            "failureCode": failure_code,
            "revision": 2,
            "updatedAt": self.repository.server_timestamp,
        }
        self.repository.update_document(draft_path, changes)
        return self._summary({**document, **changes})

    def _require_vertex(self) -> None:
        try:
            self.settings.ensure_vertex_ai_drafts_enabled()
        except RuntimeError as error:
            raise InvalidOperation(
                "AI 수업 흐름 초안 생성은 아직 준비되지 않았습니다."
            ) from error
        if self.storage is None or self.gemini is None:
            raise InvalidOperation("AI 수업 흐름 초안 생성은 아직 준비되지 않았습니다.")

    def _assert_material_access(
        self, identity: VerifiedCloudIdentity, material: Mapping[str, Any]
    ) -> None:
        profile = self.repository.read_document(f"users/{identity.uid}")
        if (
            profile is None
            or profile.get("orgId") != self.settings.bootstrap_org_id
            or profile.get("accountType") != "STAFF"
            or not has_active_membership(profile)
            or profile.get("organizationRole") not in {"ADMIN", "INSTRUCTOR"}
            or material.get("orgId") != self.settings.bootstrap_org_id
            or material.get("ownerStaffUid") != identity.uid
        ):
            raise AccessDenied("자료 초안 생성 권한이 없습니다.")

    def _assert_draft_access(
        self, identity: VerifiedCloudIdentity, draft: Mapping[str, Any]
    ) -> None:
        profile = self.repository.read_document(f"users/{identity.uid}")
        if (
            profile is None
            or profile.get("orgId") != self.settings.bootstrap_org_id
            or profile.get("accountType") != "STAFF"
            or not has_active_membership(profile)
            or profile.get("organizationRole") not in {"ADMIN", "INSTRUCTOR"}
            or draft.get("orgId") != self.settings.bootstrap_org_id
            or draft.get("creatorUid") != identity.uid
        ):
            raise AccessDenied("자료 초안 조회 권한이 없습니다.")

    def _assert_transaction_draft_access(
        self,
        transaction: CloudCourseTransaction,
        identity: VerifiedCloudIdentity,
        draft: Mapping[str, Any] | None,
    ) -> None:
        profile = transaction.read_document(f"users/{identity.uid}")
        if (
            draft is None
            or profile is None
            or profile.get("orgId") != self.settings.bootstrap_org_id
            or profile.get("accountType") != "STAFF"
            or not has_active_membership(profile)
            or profile.get("organizationRole") not in {"ADMIN", "INSTRUCTOR"}
            or draft.get("orgId") != self.settings.bootstrap_org_id
            or draft.get("creatorUid") != identity.uid
        ):
            raise AccessDenied("자료 초안 편집 권한이 없습니다.")

    def _require_generated_draft(
        self,
        draft: Mapping[str, Any] | None,
        draft_id: str,
        expected_revision: int,
    ) -> None:
        if draft is None or draft.get("id") != draft_id:
            raise InvalidOperation("자료 초안을 찾을 수 없습니다.")
        if draft.get("status") != "GENERATED":
            raise ResourceConflict("생성 완료된 초안만 변경할 수 있습니다.")
        if draft.get("revision") != expected_revision:
            raise ResourceConflict("초안이 다른 요청으로 변경되었습니다.")

    def _normalize_apply_payload(
        self, payload: Mapping[str, Any], draft: Mapping[str, Any]
    ) -> dict[str, Any]:
        title = self._text(payload.get("title"), limit=100, required=True)
        description = self._text(
            payload.get("description", ""), limit=1000, required=False
        )
        raw_chapters = payload.get("chapters")
        if (
            not isinstance(raw_chapters, list)
            or not raw_chapters
            or len(raw_chapters) > MAX_CHAPTERS
        ):
            raise InvalidOperation("수업 챕터를 하나 이상 입력해 주세요.")

        allowed_references = self._source_reference_numbers(draft)
        chapters: list[dict[str, Any]] = []
        total_items = 0
        for chapter_position, chapter in enumerate(raw_chapters):
            if not isinstance(chapter, Mapping):
                raise InvalidOperation("챕터 형식을 확인해 주세요.")
            raw_items = chapter.get("items")
            if not isinstance(raw_items, list) or not raw_items:
                raise InvalidOperation("각 챕터에 항목을 하나 이상 입력해 주세요.")
            if len(raw_items) > MAX_ITEMS_PER_CHAPTER:
                raise InvalidOperation("챕터별 항목 수를 확인해 주세요.")
            total_items += len(raw_items)
            items: list[dict[str, Any]] = []
            for item_position, item in enumerate(raw_items):
                if not isinstance(item, Mapping):
                    raise InvalidOperation("수업 항목 형식을 확인해 주세요.")
                references = self._source_references(
                    item.get("sourcePageOrSlideNumbers", []), allowed_references
                )
                items.append(
                    {
                        "id": uuid4().hex,
                        "title": self._text(item.get("title"), 150, required=True),
                        "description": self._text(
                            item.get("description", ""), 1000, required=False
                        ),
                        "position": item_position,
                        "sourcePageOrSlideNumbers": references,
                    }
                )
            chapters.append(
                {
                    "id": uuid4().hex,
                    "title": self._text(chapter.get("title"), 100, required=True),
                    "position": chapter_position,
                    "items": items,
                }
            )
        if total_items > MAX_TOTAL_ITEMS:
            raise InvalidOperation("전체 수업 항목 수를 확인해 주세요.")
        return {
            "title": title,
            "description": description,
            "chapters": chapters,
        }

    @staticmethod
    def _source_reference_numbers(draft: Mapping[str, Any]) -> set[int]:
        chapters = draft.get("chapters")
        if not isinstance(chapters, list):
            return set()
        references: set[int] = set()
        for chapter in chapters:
            if not isinstance(chapter, Mapping):
                continue
            items = chapter.get("items")
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, Mapping):
                    continue
                values = item.get("sourcePageOrSlideNumbers")
                if isinstance(values, list):
                    references.update(
                        value
                        for value in values
                        if isinstance(value, int) and value > 0
                    )
        return references

    @staticmethod
    def _source_references(value: object, allowed: set[int]) -> list[int]:
        if not isinstance(value, list) or len(value) > MAX_SOURCE_REFERENCES:
            raise InvalidOperation("자료 참고 번호를 확인해 주세요.")
        if any(isinstance(item, bool) or not isinstance(item, int) for item in value):
            raise InvalidOperation("자료 참고 번호를 확인해 주세요.")
        references = sorted(set(value))
        if any(item < 1 or item not in allowed for item in references):
            raise InvalidOperation("자료 참고 번호를 확인해 주세요.")
        return references

    def _new_course_document(
        self,
        *,
        course_id: str,
        identity: VerifiedCloudIdentity,
        draft_id: str,
        material_id: str,
        source_file_type: str,
        normalized: Mapping[str, Any],
        timestamp: object,
    ) -> dict[str, Any]:
        return {
            "id": course_id,
            "orgId": self.settings.bootstrap_org_id,
            "schemaVersion": SCHEMA_VERSION,
            "status": "ACTIVE",
            **normalized,
            "sourceMaterialId": material_id,
            "sourceDraftId": draft_id,
            "sourceFileType": source_file_type,
            "createdByUid": identity.uid,
            "createdByDisplayNameSnapshot": identity.display_name,
            "updatedByUid": identity.uid,
            "revision": 1,
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }

    def _audit(
        self,
        transaction: CloudCourseTransaction,
        *,
        event: str,
        draft_id: str,
        course_id: str | None,
        identity: VerifiedCloudIdentity,
        revision: int,
        timestamp: object,
    ) -> None:
        audit_id = f"material-draft-{event.lower()}-{draft_id}-{revision}"
        document: dict[str, Any] = {
            "eventType": event,
            "orgId": self.settings.bootstrap_org_id,
            "actorUid": identity.uid,
            "draftId": draft_id,
            "revision": revision,
            "schemaVersion": SCHEMA_VERSION,
            "createdAt": timestamp,
        }
        if course_id is not None:
            document["courseId"] = course_id
        transaction.create_document(
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/{audit_id}",
            document,
        )

    def _draft_material_id(self, draft: Mapping[str, Any] | None) -> str:
        material_id = draft.get("materialId") if draft else None
        value = material_id if isinstance(material_id, str) else ""
        self._assert_identifier(value, "자료")
        return str(material_id)

    @staticmethod
    def _source_file_type(
        material: Mapping[str, Any] | None, material_id: str
    ) -> str:
        file_type = material.get("normalizedExtension") if material else None
        if (
            material is None
            or material.get("id") != material_id
            or file_type not in {"pdf", "pptx"}
        ):
            raise InvalidOperation("초안의 원본 자료를 확인할 수 없습니다.")
        return file_type

    def _expected_revision(self, payload: Mapping[str, Any]) -> int:
        revision = payload.get("expectedRevision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise InvalidOperation("현재 초안 버전을 확인해 주세요.")
        return revision

    @staticmethod
    def _text(value: object, limit: int, *, required: bool) -> str:
        if not isinstance(value, str):
            raise InvalidOperation("입력 내용을 확인해 주세요.")
        text = value.strip()
        if (required and not text) or len(text) > limit:
            raise InvalidOperation("입력 내용을 확인해 주세요.")
        return text

    @staticmethod
    def _assert_extractable(material: Mapping[str, Any], material_id: str) -> None:
        if (
            material.get("id") != material_id
            or material.get("status") != "EXTRACTED"
            or material.get("extractionStatus") != "EXTRACTED"
            or not material.get("sourceObjectGeneration")
        ):
            raise InvalidOperation(
                "텍스트 추출이 완료된 자료만 초안을 만들 수 있습니다."
            )

    @staticmethod
    def _source_revision(material: Mapping[str, Any]) -> str:
        generation = material.get("sourceObjectGeneration")
        version = material.get("extractionVersion")
        return f"{generation or 'unknown'}:{version or 'unknown'}"

    def _material_path(self, material_id: str) -> str:
        self._assert_identifier(material_id, "자료")
        return (
            f"organizations/{self.settings.bootstrap_org_id}/materialUploads/"
            f"{material_id}"
        )

    def _draft_path(self, draft_id: str) -> str:
        self._assert_identifier(draft_id, "초안")
        return (
            f"organizations/{self.settings.bootstrap_org_id}/materialCourseDrafts/"
            f"{draft_id}"
        )

    def _course_path(self, course_id: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/courses/{course_id}"

    def _extraction_path(self, material_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/material-uploads/"
            f"{material_id}/extraction.json"
        )

    @staticmethod
    def _assert_identifier(value: str, label: str) -> None:
        if not value or any(item in value for item in ("/", "\\", "\x00")):
            raise InvalidOperation(f"{label} 식별자를 확인해 주세요.")

    @staticmethod
    def _summary(document: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "draftId": document.get("id"),
            "status": document.get("status"),
            "suggestedTitle": document.get("suggestedTitle"),
            "summary": document.get("summary"),
            "chapters": document.get("chapters") or [],
            "modelId": document.get("modelId"),
            "promptVersion": document.get("promptVersion"),
            "failureCode": document.get("failureCode"),
            "revision": document.get("revision"),
            "appliedCourseId": document.get("appliedCourseId"),
        }


def _normalized_extraction_input(
    payload: object, *, document_title: str, max_characters: int
) -> tuple[dict[str, Any], bool, int]:
    if not isinstance(payload, Mapping):
        raise DraftGenerationFailure("EXTRACTION_INVALID")
    kind = payload.get("kind")
    collection_key, number_key = (
        ("pages", "pageNumber")
        if kind == "PDF"
        else ("slides", "slideNumber")
        if kind == "PPTX"
        else (None, None)
    )
    if collection_key is None or number_key is None:
        raise DraftGenerationFailure("EXTRACTION_INVALID")
    values = payload.get(collection_key)
    if not isinstance(values, list) or not values:
        raise DraftGenerationFailure("EXTRACTION_INVALID")

    units: list[dict[str, Any]] = []
    remaining = max_characters
    was_truncated = False
    max_unit_number = 0
    for value in values:
        if not isinstance(value, Mapping):
            raise DraftGenerationFailure("EXTRACTION_INVALID")
        number = value.get(number_key)
        text = value.get("text")
        if not isinstance(number, int) or number < 1 or not isinstance(text, str):
            raise DraftGenerationFailure("EXTRACTION_INVALID")
        max_unit_number = max(max_unit_number, number)
        title = value.get("titleCandidate")
        title_value = title.strip() if isinstance(title, str) else ""
        unit_text = text.strip()
        if not unit_text and not title_value:
            continue
        combined = (f"제목: {title_value}\n" if title_value else "") + unit_text
        if len(combined) > remaining:
            combined = combined[:remaining].rstrip()
            was_truncated = True
        if combined:
            units.append({"number": number, "text": combined})
        remaining -= len(combined)
        if remaining <= 0:
            was_truncated = True
            break
    if not units or max_unit_number < 1:
        raise DraftGenerationFailure("EXTRACTION_INVALID")
    return (
        {
            "documentTitle": document_title,
            "documentKind": kind,
            "units": units,
        },
        was_truncated,
        max_unit_number,
    )


def _validated_generated_draft(
    response_text: str, max_unit_number: int
) -> dict[str, Any]:
    try:
        draft = GeneratedCourseDraft.model_validate_json(response_text)
    except (ValidationError, ValueError, TypeError) as error:
        raise DraftGenerationFailure("MODEL_OUTPUT_INVALID") from error
    if len(draft.chapters) > MAX_CHAPTERS:
        raise DraftGenerationFailure("MODEL_OUTPUT_INVALID")
    total_items = sum(len(chapter.items) for chapter in draft.chapters)
    if total_items > MAX_TOTAL_ITEMS:
        raise DraftGenerationFailure("MODEL_OUTPUT_INVALID")
    chapters: list[dict[str, Any]] = []
    for chapter in draft.chapters:
        items: list[dict[str, Any]] = []
        for item in chapter.items:
            references = sorted(
                {
                    number
                    for number in item.sourcePageOrSlideNumbers
                    if 1 <= number <= max_unit_number
                }
            )
            if not references:
                raise DraftGenerationFailure("MODEL_REFERENCE_INVALID")
            items.append(
                {
                    "title": item.title,
                    "description": item.description,
                    "sourcePageOrSlideNumbers": references,
                }
            )
        chapters.append({"title": chapter.title, "items": items})
    return {
        "suggestedTitle": draft.suggestedTitle,
        "summary": draft.summary,
        "chapters": chapters,
    }


def _safe_material_title(material: Mapping[str, Any]) -> str:
    value = material.get("originalFilename")
    if not isinstance(value, str) or not value.strip():
        return "수업 자료"
    return value.strip()[:255]


def _draft_prompt(normalized: Mapping[str, Any]) -> str:
    # This string is never persisted, returned by the API, or exposed to React.
    return (
        "다음 정규화된 수업 자료만 근거로 교육 보조용 수업 흐름 초안을 만드세요. "
        "반드시 JSON 객체만 반환하고, 지정된 키 외의 키는 포함하지 마세요. "
        "chapters는 1~8개, 각 items는 1~10개, 전체 items는 40개 이하입니다. "
        "각 item의 sourcePageOrSlideNumbers는 제공된 unit number만 사용하세요.\n"
        "JSON 구조: {suggestedTitle,summary,chapters:[{title,items:"
        "[{title,description,sourcePageOrSlideNumbers}]}]}\n"
        "정규화 자료:\n"
        + json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    )
