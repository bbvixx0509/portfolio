import copy
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, TypeVar

import pytest
from test_cloud_organization import cloud_settings

from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    ResourceConflict,
    ResourceNotFound,
)
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_course_service import (
    CloudCourseService,
    CloudCourseTransaction,
)

ADMIN = VerifiedCloudIdentity(
    uid="admin-uid",
    email="admin@example.test",
    display_name="관리자",
    photo_url=None,
)
INSTRUCTOR = VerifiedCloudIdentity(
    uid="instructor-uid",
    email="instructor@example.test",
    display_name="일반 강사",
    photo_url=None,
)
STUDENT = VerifiedCloudIdentity(
    uid="student-uid",
    email="student@example.test",
    display_name="학생",
    photo_url=None,
)
FIXED_TIMESTAMP = datetime(2026, 7, 22, 12, 0, tzinfo=UTC)
Result = TypeVar("Result")


class InMemoryCourseTransaction:
    def __init__(self, documents: dict[str, dict[str, Any]]) -> None:
        self.documents = documents
        self.pending: dict[str, dict[str, Any]] = {}

    @property
    def server_timestamp(self) -> object:
        return FIXED_TIMESTAMP

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        if path in self.pending:
            return copy.deepcopy(self.pending[path])
        value = self.documents.get(path)
        return copy.deepcopy(value) if value is not None else None

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        if path in self.documents or path in self.pending:
            raise ResourceConflict("A document already exists")
        self.pending[path] = copy.deepcopy(dict(document))

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        current = self.read_document(path)
        if current is None:
            raise ResourceNotFound("The course was not found")
        self.pending[path] = {**current, **copy.deepcopy(dict(changes))}


class InMemoryCourseRepository:
    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {
            "users/admin-uid": staff_document(ADMIN, "ADMIN"),
            "users/instructor-uid": staff_document(INSTRUCTOR, "INSTRUCTOR"),
        }

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        value = self.documents.get(path)
        return copy.deepcopy(value) if value is not None else None

    def list_courses(self, *, org_id: str) -> list[Mapping[str, Any]]:
        return [
            copy.deepcopy(document)
            for path, document in self.documents.items()
            if path.startswith(f"organizations/{org_id}/courses/")
        ]

    def run_transaction(
        self, callback: Callable[[CloudCourseTransaction], Result]
    ) -> Result:
        transaction = InMemoryCourseTransaction(self.documents)
        result = callback(transaction)
        self.documents.update(transaction.pending)
        return result


class InMemoryCourseMaterialStorage:
    def download_source(self, *, object_path: str, destination: Any) -> None:
        destination.write(b"%PDF-1.7\n")


def staff_document(identity: VerifiedCloudIdentity, role: str) -> dict[str, Any]:
    return {
        "uid": identity.uid,
        "orgId": "demo",
        "accountType": "STAFF",
        "organizationRole": role,
        "organizationRoleRevision": 1,
    }


def payload(*, title: str = "React 입문") -> dict[str, Any]:
    return {
        "title": title,
        "description": "컴포넌트 기반 수업",
        "chapters": [
            {
                "id": "chapter-client-id",
                "title": "첫 챕터",
                "items": [
                    {
                        "id": "item-client-id",
                        "title": "첫 항목",
                        "description": "소개",
                    }
                ],
            }
        ],
    }


def create_service() -> tuple[CloudCourseService, InMemoryCourseRepository]:
    repository = InMemoryCourseRepository()
    return CloudCourseService(repository, cloud_settings()), repository


def stored_material(material_id: str, owner_uid: str) -> dict[str, Any]:
    return {
        "id": material_id,
        "orgId": "demo",
        "ownerStaffUid": owner_uid,
        "originalFilename": "자료.pdf",
        "normalizedExtension": "pdf",
        "sizeBytes": 1024,
        "status": "STORED",
    }


def test_staff_can_create_normalized_course_and_safe_audit_log() -> None:
    service, repository = create_service()

    created = service.create_course(ADMIN, payload())

    stored = repository.documents[f"organizations/demo/courses/{created['id']}"]
    assert created["isMine"] is True
    assert created["chapters"][0]["position"] == 0
    assert created["chapters"][0]["items"][0]["position"] == 0
    assert stored["revision"] == 1
    assert stored["createdByUid"] == ADMIN.uid
    audit = next(
        document
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    )
    assert audit["eventType"] == "COURSE_CREATED"
    assert "email" not in audit
    assert "token" not in audit


def test_server_normalizes_positions_from_array_order() -> None:
    service, _ = create_service()
    ordered_payload = {
        "title": "순서 검증 수업",
        "description": "클라이언트 position을 신뢰하지 않는다",
        "chapters": [
            {
                "id": "chapter-second",
                "title": "두 번째 챕터",
                "position": 99,
                "items": [
                    {
                        "id": "item-second",
                        "title": "두 번째 항목",
                        "description": "둘",
                        "position": 42,
                    },
                    {
                        "id": "item-first",
                        "title": "첫 번째 항목",
                        "description": "하나",
                        "position": 13,
                    },
                ],
            },
            {
                "id": "chapter-first",
                "title": "첫 번째 챕터",
                "position": 7,
                "items": [],
            },
        ],
    }

    created = service.create_course(ADMIN, ordered_payload)

    assert [chapter["id"] for chapter in created["chapters"]] == [
        "chapter-second",
        "chapter-first",
    ]
    assert [chapter["position"] for chapter in created["chapters"]] == [0, 1]
    assert [item["id"] for item in created["chapters"][0]["items"]] == [
        "item-second",
        "item-first",
    ]
    assert [item["position"] for item in created["chapters"][0]["items"]] == [0, 1]


def test_material_reference_numbers_survive_course_edits() -> None:
    service, _ = create_service()
    material_payload = payload()
    material_payload["chapters"][0]["items"][0]["sourcePageOrSlideNumbers"] = [3, 1, 3]

    created = service.create_course(ADMIN, material_payload)
    assert created["chapters"][0]["items"][0]["sourcePageOrSlideNumbers"] == [1, 3]

    updated = service.update_course(
        ADMIN,
        created["id"],
        {
            "title": created["title"],
            "description": created["description"],
            "chapters": created["chapters"],
            "expectedRevision": created["revision"],
        },
    )
    assert updated["chapters"][0]["items"][0]["sourcePageOrSlideNumbers"] == [1, 3]


def test_course_materials_attach_detach_and_legacy_source_are_owner_scoped() -> None:
    service, repository = create_service()
    material_one_path = "organizations/demo/materialUploads/material-1"
    material_other_path = "organizations/demo/materialUploads/material-other"
    repository.documents[material_one_path] = stored_material("material-1", ADMIN.uid)
    repository.documents[material_other_path] = stored_material(
        "material-other", INSTRUCTOR.uid
    )

    created = service.create_course(ADMIN, {**payload(), "materialIds": ["material-1"]})
    assert service.list_materials(ADMIN, created["id"]) == {
        "materials": [
            {
                "id": "material-1",
                "filename": "자료.pdf",
                "normalizedExtension": "pdf",
                "sizeBytes": 1024,
            }
        ],
        "unavailableMaterialCount": 0,
    }
    with pytest.raises(ResourceNotFound):
        service.attach_material(ADMIN, created["id"], "material-other")
    with pytest.raises(AccessDenied):
        service.detach_material(INSTRUCTOR, created["id"], "material-1")

    assert service.detach_material(ADMIN, created["id"], "material-1") == {
        "materials": [],
        "unavailableMaterialCount": 0,
    }
    stored = repository.documents[f"organizations/demo/courses/{created['id']}"]
    assert stored["materialIds"] == []
    assert "sourceMaterialId" not in stored

    legacy_id = "legacy-course"
    repository.documents[f"organizations/demo/courses/{legacy_id}"] = {
        **stored,
        "id": legacy_id,
        "revision": 1,
        "sourceMaterialId": "material-1",
    }
    repository.documents[f"organizations/demo/courses/{legacy_id}"].pop("materialIds")
    repository.documents[material_one_path].update(
        {"status": "EXTRACTED", "extractionStatus": "EXTRACTED"}
    )
    assert (
        service.list_materials(ADMIN, legacy_id)["materials"][0]["id"]
        == "material-1"
    )
    service_with_preview = CloudCourseService(
        repository,
        cloud_settings(),
        storage=InMemoryCourseMaterialStorage(),
    )
    assert service_with_preview.material_content(ADMIN, legacy_id, "material-1")[
        "content"
    ].startswith(b"%PDF")

    repository.documents.pop(material_one_path)
    assert service.list_materials(ADMIN, legacy_id) == {
        "materials": [],
        "unavailableMaterialCount": 1,
    }


def test_creator_only_update_and_archive_with_revision_protection() -> None:
    service, repository = create_service()
    created = service.create_course(ADMIN, payload())

    with pytest.raises(AccessDenied):
        service.update_course(
            INSTRUCTOR,
            created["id"],
            {**payload(), "expectedRevision": 1},
        )
    with pytest.raises(ResourceConflict):
        service.update_course(
            ADMIN,
            created["id"],
            {**payload(), "expectedRevision": 99},
        )

    updated = service.update_course(
        ADMIN,
        created["id"],
        {**payload(title="수정된 수업"), "expectedRevision": 1},
    )
    assert updated["revision"] == 2
    service.archive_course(ADMIN, created["id"], 2)
    assert service.list_courses(ADMIN) == {"courses": []}
    archived_view = service.get_course(INSTRUCTOR, created["id"])
    assert archived_view["status"] == "ARCHIVED"
    assert archived_view["isMine"] is False
    with pytest.raises(ResourceConflict):
        service.update_course(
            ADMIN,
            created["id"],
            {**payload(), "expectedRevision": 2},
        )
    with pytest.raises(ResourceConflict):
        service.archive_course(ADMIN, created["id"], 2)
    archived = repository.documents[f"organizations/demo/courses/{created['id']}"]
    assert archived["status"] == "ARCHIVED"


def test_staff_lists_active_and_archived_courses_by_explicit_status() -> None:
    service, _ = create_service()
    active = service.create_course(ADMIN, payload(title="활성 수업"))
    archived = service.create_course(ADMIN, payload(title="보관 수업"))
    instructor_course = service.create_course(
        INSTRUCTOR, payload(title="다른 강사의 활성 수업")
    )
    service.archive_course(ADMIN, archived["id"], 1)

    assert [course["id"] for course in service.list_courses(ADMIN)["courses"]] == [
        active["id"]
    ]
    assert [
        course["id"] for course in service.list_courses(INSTRUCTOR)["courses"]
    ] == [instructor_course["id"]]
    archived_courses = service.list_courses(ADMIN, status="ARCHIVED")["courses"]
    assert [course["id"] for course in archived_courses] == [archived["id"]]
    assert archived_courses[0]["status"] == "ARCHIVED"
    with pytest.raises(InvalidOperation):
        service.list_courses(ADMIN, status="ALL")


def test_other_organization_and_student_cannot_read_courses() -> None:
    service, repository = create_service()
    created = service.create_course(ADMIN, payload())
    stored = repository.documents[f"organizations/demo/courses/{created['id']}"]
    repository.documents["organizations/demo/courses/other-org-course"] = {
        **copy.deepcopy(stored),
        "id": "other-org-course",
        "orgId": "other-org",
    }
    repository.documents[f"users/{STUDENT.uid}"] = {
        "uid": STUDENT.uid,
        "orgId": "demo",
        "accountType": "STUDENT",
    }

    with pytest.raises(ResourceNotFound):
        service.get_course(ADMIN, "other-org-course")
    with pytest.raises(AccessDenied):
        service.list_courses(STUDENT)
    with pytest.raises(AccessDenied):
        service.get_course(STUDENT, created["id"])


def test_any_staff_can_read_and_duplicate_but_copy_is_immediately_theirs() -> None:
    service, _ = create_service()
    created = service.create_course(ADMIN, payload())

    other_view = service.get_course(INSTRUCTOR, created["id"])
    copied = service.duplicate_course(INSTRUCTOR, created["id"])

    assert other_view["isMine"] is False
    assert copied["isMine"] is True
    assert copied["title"] == "React 입문 복사본"
    assert copied["chapters"][0]["id"] != created["chapters"][0]["id"]
    assert (
        copied["chapters"][0]["items"][0]["id"]
        != created["chapters"][0]["items"][0]["id"]
    )


def test_legacy_or_non_staff_document_cannot_gain_course_access() -> None:
    service, repository = create_service()
    repository.documents["users/admin-uid"] = {
        "uid": ADMIN.uid,
        "orgId": "demo",
        "accountType": "STAFF",
        "isOrgAdmin": True,
    }

    with pytest.raises(AccessDenied):
        service.list_courses(ADMIN)


def test_invalid_course_payload_is_422_domain_error() -> None:
    service, _ = create_service()

    with pytest.raises(InvalidOperation):
        service.create_course(ADMIN, {"title": "", "description": "", "chapters": []})
