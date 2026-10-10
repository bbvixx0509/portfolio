from __future__ import annotations

import json
from collections.abc import Mapping
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any, BinaryIO

import pytest

from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EXPECTED_CLOUD_AUTH_DEVELOPMENT_ORIGIN,
    EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    EXPECTED_CLOUD_STORAGE_BUCKET,
    Settings,
)
from app.domain.errors import AccessDenied, InvalidOperation, ResourceConflict
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_material_course_draft_service import (
    CloudMaterialCourseDraftService,
    DraftGenerationClaim,
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


def draft_settings(*, max_input: int = 24_000) -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        google_cloud_project=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        storage_mode="cloud",
        storage_bucket=EXPECTED_CLOUD_STORAGE_BUCKET,
        vertex_ai_mode="vertex",
        vertex_ai_location="global",
        vertex_ai_model="gemini-2.5-flash",
        vertex_ai_max_input_characters=max_input,
        cors_origins=(EXPECTED_CLOUD_AUTH_DEVELOPMENT_ORIGIN,),
    )


class Repository:
    def __init__(self) -> None:
        self.material_id = "material-1"
        self.material_path = f"organizations/demo/materialUploads/{self.material_id}"
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
            self.material_path: {
                "id": self.material_id,
                "orgId": "demo",
                "ownerStaffUid": "staff-uid",
                "normalizedExtension": "pdf",
                "originalFilename": "private-lesson.pdf",
                "status": "EXTRACTED",
                "extractionStatus": "EXTRACTED",
                "sourceObjectGeneration": "1",
                "extractionVersion": 1,
            },
        }
        self.claims = 0
        self.fail_next_audit = False
        self.retry_next_transaction = False

    @property
    def server_timestamp(self) -> object:
        return NOW

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return self.documents.get(path)

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        self.documents[path] = {**self.documents[path], **dict(changes)}

    def claim_course_draft(
        self,
        *,
        org_id: str,
        material_id: str,
        draft_path: str,
        document: Mapping[str, Any],
    ) -> DraftGenerationClaim:
        if self.documents[self.material_path].get("status") != "EXTRACTED":
            return DraftGenerationClaim(document=None, started=False)
        existing = next(
            (
                value
                for value in self.documents.values()
                if value.get("orgId") == org_id
                and value.get("materialId") == material_id
                and value.get("status") in {"GENERATING", "GENERATED"}
            ),
            None,
        )
        if existing is not None:
            return DraftGenerationClaim(document=existing, started=False)
        self.claims += 1
        self.documents[draft_path] = dict(document)
        return DraftGenerationClaim(document=document, started=True)

    def run_transaction(self, callback: Any) -> Any:
        if self.retry_next_transaction:
            self.retry_next_transaction = False
            callback(RepositoryTransaction(self, deepcopy(self.documents)))
        transaction = RepositoryTransaction(self, deepcopy(self.documents))
        result = callback(transaction)
        self.documents = transaction.documents
        return result


class RepositoryTransaction:
    def __init__(
        self, repository: Repository, documents: dict[str, dict[str, Any]]
    ) -> None:
        self.repository = repository
        self.documents = documents

    @property
    def server_timestamp(self) -> object:
        return NOW

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        return self.documents.get(path)

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        if path in self.documents:
            raise RuntimeError("document already exists")
        if self.repository.fail_next_audit and "/auditLogs/" in path:
            self.repository.fail_next_audit = False
            raise RuntimeError("audit unavailable")
        self.documents[path] = dict(document)

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        self.documents[path] = {**self.documents[path], **dict(changes)}


class Storage:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.download_count = 0

    def download_extraction(self, *, object_path: str, destination: BinaryIO) -> None:
        assert object_path.endswith("/extraction.json")
        self.download_count += 1
        destination.write(json.dumps(self.payload, ensure_ascii=False).encode("utf-8"))


class FakeGemini:
    model_id = "fake-gemini-2.5-flash"

    def __init__(self, responses: list[str]) -> None:
        self.responses = responses
        self.prompts: list[str] = []

    def generate_course_draft(self, *, prompt: str) -> str:
        self.prompts.append(prompt)
        return self.responses.pop(0)


def generated_response(*, chapters: int = 1, reference: int = 1) -> str:
    return json.dumps(
        {
            "suggestedTitle": "AI 수업 제목",
            "summary": "교육 보조용 수업 흐름 초안입니다.",
            "chapters": [
                {
                    "title": f"챕터 {index}",
                    "items": [
                        {
                            "title": f"항목 {index}",
                            "description": "짧은 항목 설명입니다.",
                            "sourcePageOrSlideNumbers": [reference],
                        }
                    ],
                }
                for index in range(1, chapters + 1)
            ],
        },
        ensure_ascii=False,
    )


def extraction_payload(text: str = "첫 번째 비공개 추출 텍스트") -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "kind": "PDF",
        "pageCount": 2,
        "extractedCharacterCount": len(text),
        "pages": [
            {"pageNumber": 1, "titleCandidate": "첫 페이지", "text": text},
            {"pageNumber": 2, "titleCandidate": "둘째 페이지", "text": "둘째 내용"},
        ],
    }


def service(
    *,
    response: str | None = None,
    payload: dict[str, Any] | None = None,
    max_input: int = 24_000,
) -> tuple[CloudMaterialCourseDraftService, Repository, Storage, FakeGemini]:
    repository = Repository()
    storage = Storage(payload or extraction_payload())
    gemini = FakeGemini([response or generated_response()])
    return (
        CloudMaterialCourseDraftService(
            repository, storage, gemini, draft_settings(max_input=max_input)
        ),
        repository,
        storage,
        gemini,
    )


def test_extracted_material_creates_minimum_safe_draft_without_course_or_room() -> None:
    value, repository, storage, gemini = service()

    result = value.create(IDENTITY, repository.material_id)

    assert result["status"] == "GENERATED"
    assert result["suggestedTitle"] == "AI 수업 제목"
    assert "learningObjectives" not in result
    assert result["chapters"][0]["items"][0]["sourcePageOrSlideNumbers"] == [1]
    assert storage.download_count == 1
    assert len(gemini.prompts) == 1
    document = next(
        item
        for item in repository.documents.values()
        if item.get("status") == "GENERATED"
    )
    serialized_document = json.dumps(document, ensure_ascii=False, default=str)
    serialized_response = json.dumps(result, ensure_ascii=False)
    assert "private-lesson.pdf" not in serialized_response
    assert "첫 번째 비공개 추출 텍스트" not in serialized_document
    assert "sourceObjectGeneration" not in serialized_response
    assert "learningObjectives" not in gemini.prompts[0]
    assert not any(
        "/courses/" in path or "/rooms/" in path for path in repository.documents
    )


def test_duplicate_create_reuses_active_draft_without_second_model_call() -> None:
    value, repository, _storage, gemini = service()

    first = value.create(IDENTITY, repository.material_id)
    second = value.create(IDENTITY, repository.material_id)

    assert second["draftId"] == first["draftId"]
    assert repository.claims == 1
    assert len(gemini.prompts) == 1


def test_failed_generation_needs_explicit_retry() -> None:
    value, repository, _storage, gemini = service(response="not-json")

    failed = value.create(IDENTITY, repository.material_id)
    gemini.responses.append(generated_response())
    retried = value.create(IDENTITY, repository.material_id)

    assert failed["status"] == "FAILED"
    assert failed["failureCode"] == "MODEL_OUTPUT_INVALID"
    assert retried["status"] == "GENERATED"
    assert repository.claims == 2
    assert len(gemini.prompts) == 2
    assert all(
        "not-json" not in json.dumps(value, default=str)
        for value in repository.documents.values()
    )


@pytest.mark.parametrize(
    "response, expected_code",
    [
        (generated_response(chapters=9), "MODEL_OUTPUT_INVALID"),
        (generated_response(reference=99), "MODEL_REFERENCE_INVALID"),
    ],
)
def test_invalid_model_output_is_failed_and_never_exposed(
    response: str, expected_code: str
) -> None:
    value, repository, _storage, _gemini = service(response=response)

    result = value.create(IDENTITY, repository.material_id)

    assert result["status"] == "FAILED"
    assert result["failureCode"] == expected_code
    assert result["chapters"] == []


def test_normalized_input_is_bounded_and_keeps_storage_path_out_of_prompt() -> None:
    source = "앞부분 " + ("가" * 1_050) + " 절대-전송-말미"
    value, repository, _storage, gemini = service(
        payload=extraction_payload(source), max_input=1_000
    )

    value.create(IDENTITY, repository.material_id)

    prompt = gemini.prompts[0]
    assert "절대-전송-말미" not in prompt
    assert "material-uploads" not in prompt
    assert "staff-uid" not in prompt


def test_material_state_and_access_boundaries_are_enforced() -> None:
    value, repository, _storage, _gemini = service()
    repository.documents[repository.material_path]["status"] = "STORED"
    with pytest.raises(InvalidOperation):
        value.create(IDENTITY, repository.material_id)

    repository.documents[repository.material_path]["status"] = "EXTRACTED"
    with pytest.raises(AccessDenied):
        value.create(OTHER_IDENTITY, repository.material_id)


def test_vertex_drafts_are_fail_closed_until_server_mode_is_explicitly_enabled() -> (
    None
):
    value, repository, storage, gemini = service()
    disabled_settings = Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        google_cloud_project=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        storage_mode="cloud",
        storage_bucket=EXPECTED_CLOUD_STORAGE_BUCKET,
    )
    disabled = CloudMaterialCourseDraftService(
        repository, storage, gemini, disabled_settings
    )

    with pytest.raises(InvalidOperation):
        disabled.create(IDENTITY, repository.material_id)

    assert repository.claims == 0
    assert gemini.prompts == []


def apply_payload(*, revision: int, title: str = "편집한 수업 제목") -> dict[str, Any]:
    return {
        "title": title,
        "description": "강사가 편집한 수업 설명입니다.",
        "chapters": [
            {
                "title": "편집한 챕터",
                "items": [
                    {
                        "title": "편집한 항목",
                        "description": "항목 설명",
                        "sourcePageOrSlideNumbers": [1],
                    }
                ],
            }
        ],
        "expectedRevision": revision,
    }


def test_apply_creates_one_course_and_marks_the_generated_draft_atomically() -> None:
    value, repository, _storage, _gemini = service()
    draft = value.create(IDENTITY, repository.material_id)

    result = value.apply(
        IDENTITY,
        str(draft["draftId"]),
        apply_payload(revision=int(draft["revision"])),
    )

    course = next(
        document
        for path, document in repository.documents.items()
        if "/courses/" in path
    )
    applied = repository.documents[
        f"organizations/demo/materialCourseDrafts/{draft['draftId']}"
    ]
    audit = next(
        document
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
        and document.get("eventType") == "MATERIAL_DRAFT_APPLIED"
    )
    assert result["course"]["id"] == course["id"]
    assert applied["status"] == "APPLIED"
    assert applied["appliedCourseId"] == course["id"]
    assert course["sourceMaterialId"] == repository.material_id
    assert course["sourceDraftId"] == draft["draftId"]
    assert course["sourceFileType"] == "pdf"
    assert course["chapters"][0]["position"] == 0
    assert course["chapters"][0]["items"][0]["position"] == 0
    assert course["chapters"][0]["items"][0]["sourcePageOrSlideNumbers"] == [1]
    assert "learningObjectives" not in course
    assert audit["draftId"] == draft["draftId"]
    assert audit["courseId"] == course["id"]
    serialized = json.dumps(
        {"course": course, "audit": audit}, ensure_ascii=False, default=str
    )
    assert "private-lesson.pdf" not in serialized
    assert "첫 번째 비공개 추출 텍스트" not in serialized


def test_legacy_learning_objectives_are_not_exposed_or_rewritten() -> None:
    value, repository, _storage, _gemini = service()
    draft = value.create(IDENTITY, repository.material_id)
    path = f"organizations/demo/materialCourseDrafts/{draft['draftId']}"
    repository.documents[path]["learningObjectives"] = ["legacy objective"]

    loaded = value.get(IDENTITY, str(draft["draftId"]))

    assert "learningObjectives" not in loaded
    assert repository.documents[path]["learningObjectives"] == ["legacy objective"]


def test_apply_rejects_stale_or_repeat_requests_without_a_second_course() -> None:
    value, repository, _storage, _gemini = service()
    draft = value.create(IDENTITY, repository.material_id)
    payload = apply_payload(revision=int(draft["revision"]))
    value.apply(IDENTITY, str(draft["draftId"]), payload)

    with pytest.raises(ResourceConflict):
        value.apply(IDENTITY, str(draft["draftId"]), payload)

    assert len([path for path in repository.documents if "/courses/" in path]) == 1
    assert len(
        [
            path
            for path, document in repository.documents.items()
            if "/auditLogs/" in path
            and document.get("eventType") == "MATERIAL_DRAFT_APPLIED"
        ]
    ) == 1


def test_apply_transaction_retry_commits_one_course_and_one_audit_record() -> None:
    value, repository, _storage, _gemini = service()
    draft = value.create(IDENTITY, repository.material_id)
    repository.retry_next_transaction = True

    value.apply(
        IDENTITY,
        str(draft["draftId"]),
        apply_payload(revision=int(draft["revision"])),
    )

    assert len([path for path in repository.documents if "/courses/" in path]) == 1
    assert len(
        [
            path
            for path, document in repository.documents.items()
            if "/auditLogs/" in path
            and document.get("eventType") == "MATERIAL_DRAFT_APPLIED"
        ]
    ) == 1


def test_apply_rolls_back_course_and_draft_when_audit_write_fails() -> None:
    value, repository, _storage, _gemini = service()
    draft = value.create(IDENTITY, repository.material_id)
    before = deepcopy(repository.documents)
    repository.fail_next_audit = True

    with pytest.raises(RuntimeError, match="audit unavailable"):
        value.apply(
            IDENTITY,
            str(draft["draftId"]),
            apply_payload(revision=int(draft["revision"])),
        )

    assert repository.documents == before


def test_discard_is_soft_status_change_and_has_one_audit_record() -> None:
    value, repository, _storage, _gemini = service()
    draft = value.create(IDENTITY, repository.material_id)

    result = value.discard(
        IDENTITY, str(draft["draftId"]), int(draft["revision"])
    )

    assert result["status"] == "DISCARDED"
    assert not any("/courses/" in path for path in repository.documents)
    assert any(
        document.get("eventType") == "MATERIAL_DRAFT_DISCARDED"
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    )
    with pytest.raises(ResourceConflict):
        value.discard(IDENTITY, str(draft["draftId"]), int(draft["revision"]))
