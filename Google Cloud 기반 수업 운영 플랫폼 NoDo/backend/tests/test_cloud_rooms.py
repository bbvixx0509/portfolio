import copy
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta, timezone
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
from app.services.cloud_room_service import (
    ROOM_CODE_ALPHABET,
    CloudRoomService,
    CloudRoomTransaction,
    generate_room_code,
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
OTHER_ORG = VerifiedCloudIdentity(
    uid="other-org-uid",
    email="other@example.test",
    display_name="다른 조직 강사",
    photo_url=None,
)
FIXED_TIMESTAMP = datetime(2026, 7, 25, 12, 0, tzinfo=UTC)
Result = TypeVar("Result")


class InMemoryRoomTransaction:
    def __init__(self, documents: dict[str, dict[str, Any]]) -> None:
        self.documents = documents
        self.pending: dict[str, dict[str, Any]] = {}

    @property
    def server_timestamp(self) -> object:
        return FIXED_TIMESTAMP

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        value = self.pending.get(path, self.documents.get(path))
        return copy.deepcopy(value) if value is not None else None

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        if path in self.documents or path in self.pending:
            raise ResourceConflict("A document already exists")
        self.pending[path] = copy.deepcopy(dict(document))

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        document = self.read_document(path)
        if document is None:
            raise ResourceNotFound("A document to update was not found")
        self.pending[path] = {**document, **copy.deepcopy(dict(changes))}

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        prefix = f"organizations/{org_id}/rooms/{room_id}/flowItems/"
        paths = {
            path
            for path in self.documents | self.pending
            if path.startswith(prefix)
        }
        return [
            value
            for path in paths
            if (value := self.read_document(path)) is not None
        ]


class InMemoryRoomRepository:
    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {
            "users/admin-uid": staff_document(ADMIN, "ADMIN"),
            "users/instructor-uid": staff_document(INSTRUCTOR, "INSTRUCTOR"),
            "users/student-uid": {
                "uid": STUDENT.uid,
                "orgId": "demo",
                "accountType": "STUDENT",
            },
            "users/other-org-uid": {
                **staff_document(OTHER_ORG, "INSTRUCTOR"),
                "orgId": "other-org",
            },
            "organizations/demo/courses/source-course": source_course(),
        }

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        value = self.documents.get(path)
        return copy.deepcopy(value) if value is not None else None

    def list_rooms(self, *, org_id: str) -> list[Mapping[str, Any]]:
        prefix = f"organizations/{org_id}/rooms/"
        return [
            copy.deepcopy(document)
            for path, document in self.documents.items()
            if path.startswith(prefix) and path.count("/") == 3
        ]

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        prefix = f"organizations/{org_id}/rooms/{room_id}/flowItems/"
        return [
            copy.deepcopy(document)
            for path, document in self.documents.items()
            if path.startswith(prefix)
        ]

    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]:
        return [
            copy.deepcopy(document)
            for path, document in self.documents.items()
            if path.startswith("users/")
            and document.get("orgId") == org_id
            and document.get("accountType") == "STAFF"
        ]

    def _room_documents(
        self, *, org_id: str, room_id: str, collection: str
    ) -> list[Mapping[str, Any]]:
        prefix = f"organizations/{org_id}/rooms/{room_id}/{collection}/"
        return [
            copy.deepcopy(document)
            for path, document in self.documents.items()
            if path.startswith(prefix)
        ]

    def list_room_questions(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        return self._room_documents(
            org_id=org_id, room_id=room_id, collection="questions"
        )

    def list_room_participants(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        return self._room_documents(
            org_id=org_id, room_id=room_id, collection="participants"
        )

    def run_transaction(
        self, callback: Callable[[CloudRoomTransaction], Result]
    ) -> Result:
        transaction = InMemoryRoomTransaction(self.documents)
        result = callback(transaction)
        self.documents.update(transaction.pending)
        return result


class RetryingRoomRepository(InMemoryRoomRepository):
    """Discard one callback attempt to model a Firestore transaction retry."""

    def __init__(self) -> None:
        super().__init__()
        self.retry_next_transaction = False
        self.discarded_pending: list[dict[str, dict[str, Any]]] = []

    def run_transaction(
        self, callback: Callable[[CloudRoomTransaction], Result]
    ) -> Result:
        if self.retry_next_transaction:
            self.retry_next_transaction = False
            discarded = InMemoryRoomTransaction(self.documents)
            callback(discarded)
            self.discarded_pending.append(copy.deepcopy(discarded.pending))
        return super().run_transaction(callback)


def staff_document(identity: VerifiedCloudIdentity, role: str) -> dict[str, Any]:
    return {
        "uid": identity.uid,
        "displayName": identity.display_name,
        "orgId": "demo",
        "accountType": "STAFF",
        "organizationRole": role,
        "organizationRoleRevision": 1,
    }


def source_course(*, status: str = "ACTIVE", item_count: int = 2) -> dict[str, Any]:
    return {
        "id": "source-course",
        "orgId": "demo",
        "schemaVersion": 1,
        "status": status,
        "title": "재사용 수업 흐름",
        "revision": 7,
        "chapters": [
            {
                "id": "chapter-second",
                "title": "두 번째 챕터",
                "position": 99,
                "items": [
                    {
                        "id": f"item-{index}",
                        "title": f"항목 {index}",
                        "description": "스냅샷 설명",
                        "position": 99 - index,
                    }
                    for index in range(item_count)
                ],
            },
            {
                "id": "chapter-first",
                "title": "첫 번째 챕터",
                "position": 0,
                "items": [],
            },
        ],
    }


def create_service(
    *,
    room_code_factory: Callable[[], str] | None = None,
    repository: InMemoryRoomRepository | None = None,
    clock: Callable[[], datetime] | None = None,
) -> tuple[CloudRoomService, InMemoryRoomRepository]:
    repository = repository or InMemoryRoomRepository()
    options: dict[str, Any] = {"clock": clock or (lambda: FIXED_TIMESTAMP)}
    if room_code_factory is not None:
        options["room_code_factory"] = room_code_factory
    return CloudRoomService(repository, cloud_settings(), **options), repository


def create_payload() -> dict[str, Any]:
    return {"sourceCourseId": "source-course", "title": "7월 25일 React 강의"}


def test_admin_and_instructor_create_room_with_server_owned_snapshot() -> None:
    codes = iter(["ABCDEFGH", "BCDEFGHJ"])
    service, repository = create_service(room_code_factory=lambda: next(codes))

    created = service.create_room(ADMIN, create_payload())
    instructor_created = service.create_room(
        INSTRUCTOR, {"sourceCourseId": "source-course", "title": "강사용 방"}
    )

    stored = repository.documents[f"organizations/demo/rooms/{created['id']}"]
    assert stored["roomCreatorUid"] == ADMIN.uid
    assert stored["leadInstructorUid"] == ADMIN.uid
    assert stored["instructorMemberUids"] == [ADMIN.uid]
    assert stored["sourceCourseRevision"] == 7
    assert stored["sourceCourseTitle"] == "재사용 수업 흐름"
    assert stored["status"] == "READY"
    assert stored["revision"] == 1
    assert stored["maxActiveParticipants"] == 50
    assert created["maxActiveParticipants"] == 50
    assert instructor_created["leadInstructorDisplayNameSnapshot"] == "일반 강사"
    assert created["flowItems"] == [
        {
            "chapterId": "chapter-second",
            "chapterTitle": "두 번째 챕터",
            "chapterPosition": 0,
            "itemId": "item-0",
            "itemTitle": "항목 0",
            "itemDescription": "스냅샷 설명",
            "sourcePageOrSlideNumbers": [],
            "itemPosition": 0,
            "isCompleted": False,
        },
        {
            "chapterId": "chapter-second",
            "chapterTitle": "두 번째 챕터",
            "chapterPosition": 0,
            "itemId": "item-1",
            "itemTitle": "항목 1",
            "itemDescription": "스냅샷 설명",
            "sourcePageOrSlideNumbers": [],
            "itemPosition": 1,
            "isCompleted": False,
        },
    ]
    assert any(
        document.get("eventType") == "ROOM_CREATED"
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    )


def test_material_backed_course_creates_a_safe_immutable_room_snapshot() -> None:
    service, repository = create_service(room_code_factory=lambda: "ABCDEFGH")
    source = repository.documents["organizations/demo/courses/source-course"]
    source.update(
        {
            "sourceMaterialId": "material-1",
            "sourceDraftId": "draft-1",
            "sourceFileType": "pdf",
        }
    )
    source["chapters"][0]["items"][0]["sourcePageOrSlideNumbers"] = [3, 1, 3]
    repository.documents["organizations/demo/materialUploads/material-1"] = {
        "id": "material-1",
        "orgId": "demo",
        "normalizedExtension": "pdf",
        "status": "EXTRACTED",
        "extractionStatus": "EXTRACTED",
        "sourceObjectGeneration": "42",
        "extractionVersion": 2,
        "pageCount": 3,
        "originalFilename": "private-lesson.pdf",
        "storageObjectPath": "must-not-be-copied",
    }

    created = service.create_room(ADMIN, create_payload())
    stored = repository.documents[f"organizations/demo/rooms/{created['id']}"]

    assert stored["materialSnapshot"] == {
        "sourceMaterialId": "material-1",
        "sourceDraftId": "draft-1",
        "displayTitle": "private-lesson.pdf",
        "fileType": "pdf",
        "totalUnits": 3,
        "sourceMaterialRevision": "42:2",
        "currentUnitNumber": 1,
        "materialRevision": 1,
    }
    assert "storageObjectPath" not in stored["materialSnapshot"]
    assert created["flowItems"][0]["sourcePageOrSlideNumbers"] == [1, 3]
    source["sourceMaterialId"] = "other-material"
    assert stored["materialSnapshot"]["sourceMaterialId"] == "material-1"


def test_room_code_retries_collision_and_stores_org_index() -> None:
    codes = iter(["ABCDEFGH", "BCDEFGHJ"])
    service, repository = create_service(room_code_factory=lambda: next(codes))
    repository.documents["organizations/demo/roomCodes/ABCDEFGH"] = {
        "roomId": "existing-room",
        "status": "READY",
        "createdAt": FIXED_TIMESTAMP,
    }

    created = service.create_room(ADMIN, create_payload())

    assert created["roomCode"] == "BCDEFGHJ"
    assert (
        repository.documents["organizations/demo/roomCodes/BCDEFGHJ"]["roomId"]
        == created["id"]
    )
    assert service.get_share(ADMIN, created["id"]) == {
        "roomId": created["id"],
        "orgId": "demo",
        "roomCode": "BCDEFGHJ",
        "joinPath": "/join/demo/BCDEFGHJ",
    }


def test_generated_room_codes_use_only_the_safe_eight_character_contract() -> None:
    codes = [generate_room_code() for _ in range(20)]

    assert all(len(code) == 8 for code in codes)
    assert all(
        all(character in ROOM_CODE_ALPHABET for character in code) for code in codes
    )
    assert all(character not in "IO01" for code in codes for character in code)


def test_student_other_org_and_unassigned_instructor_are_rejected() -> None:
    service, _ = create_service()
    created = service.create_room(ADMIN, create_payload())

    with pytest.raises(AccessDenied):
        service.create_room(STUDENT, create_payload())
    with pytest.raises(AccessDenied):
        service.create_room(OTHER_ORG, create_payload())
    with pytest.raises(AccessDenied):
        service.get_room(INSTRUCTOR, created["id"])
    with pytest.raises(AccessDenied):
        service.list_rooms(STUDENT)
    with pytest.raises(AccessDenied):
        service.list_rooms(OTHER_ORG)


def test_removed_staff_cannot_access_rooms_even_with_a_stale_assignment() -> None:
    service, repository = create_service()
    created = service.create_room(INSTRUCTOR, create_payload())
    repository.documents[f"users/{INSTRUCTOR.uid}"]["membershipStatus"] = "REMOVED"

    with pytest.raises(AccessDenied):
        service.list_rooms(INSTRUCTOR)
    with pytest.raises(AccessDenied):
        service.get_room(INSTRUCTOR, created["id"])
    with pytest.raises(AccessDenied):
        service.get_checklist(INSTRUCTOR, created["id"])


def test_room_list_only_returns_created_or_assigned_rooms_without_duplicates() -> None:
    service, _ = create_service()
    admin_room = service.create_room(ADMIN, create_payload())
    instructor_room = service.create_room(
        INSTRUCTOR, {"sourceCourseId": "source-course", "title": "강사 방"}
    )
    management = service.add_assistant(
        ADMIN, admin_room["id"], INSTRUCTOR.uid, admin_room["revision"]
    )

    admin_rooms = service.list_rooms(ADMIN)["rooms"]
    instructor_rooms = service.list_rooms(INSTRUCTOR)["rooms"]

    assert [(room["id"], room["relationship"]) for room in admin_rooms] == [
        (admin_room["id"], "CREATED")
    ]
    assert {(room["id"], room["relationship"]) for room in instructor_rooms} == {
        (instructor_room["id"], "CREATED"),
        (admin_room["id"], "ASSIGNED"),
    }
    assert {room["sourceCourseId"] for room in instructor_rooms} == {
        "source-course"
    }
    assert admin_room["id"] not in {
        room["id"] for room in instructor_rooms if room["relationship"] == "CREATED"
    }
    assert {"roomCode", "leadInstructorDisplayNameSnapshot"}.isdisjoint(
        instructor_rooms[0]
    )
    with pytest.raises(AccessDenied):
        service.get_room(ADMIN, instructor_room["id"])
    assert (
        service.get_room(INSTRUCTOR, admin_room["id"])["id"] == admin_room["id"]
    )
    assert management["revision"] == 2


def test_assigned_lead_can_list_transferred_room_without_becoming_creator() -> None:
    service, _ = create_service()
    created = service.create_room(ADMIN, create_payload())
    management = service.add_assistant(
        ADMIN, created["id"], INSTRUCTOR.uid, created["revision"]
    )
    service.transfer_lead(ADMIN, created["id"], INSTRUCTOR.uid, management["revision"])

    listed = service.list_rooms(INSTRUCTOR)["rooms"]

    assert [(room["id"], room["relationship"]) for room in listed] == [
        (created["id"], "ASSIGNED")
    ]
    assert service.get_room(INSTRUCTOR, created["id"])["id"] == created["id"]


def test_lead_adds_same_org_assistant_with_question_only_default_permissions() -> None:
    service, repository = create_service()
    created = service.create_room(ADMIN, create_payload())

    management = service.add_assistant(
        ADMIN, created["id"], INSTRUCTOR.uid, created["revision"]
    )

    assistant = next(
        instructor
        for instructor in management["instructors"]
        if instructor["userId"] == INSTRUCTOR.uid
    )
    assert assistant["role"] == "ASSISTANT"
    assert assistant["permissions"] == {
        "questionOperations": True,
        "checklistProgress": False,
        "capacityOperations": False,
    }
    stored = repository.documents[f"organizations/demo/rooms/{created['id']}"]
    assert stored["instructorMemberUids"] == [ADMIN.uid, INSTRUCTOR.uid]
    assert stored["roomInstructors"][1]["uid"] == INSTRUCTOR.uid
    assert any(
        document.get("eventType") == "ROOM_ASSISTANT_ADDED"
        and document.get("permissionKeys") == ["questionOperations"]
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    )


def test_room_lead_only_manages_assistants_and_rejects_others() -> None:
    service, _ = create_service()
    created = service.create_room(ADMIN, create_payload())

    with pytest.raises(AccessDenied):
        service.add_assistant(ADMIN, created["id"], OTHER_ORG.uid, created["revision"])
    service.add_assistant(ADMIN, created["id"], INSTRUCTOR.uid, created["revision"])
    with pytest.raises(ResourceConflict):
        service.add_assistant(ADMIN, created["id"], INSTRUCTOR.uid, 2)

    instructor_room = service.create_room(
        INSTRUCTOR, {"sourceCourseId": "source-course", "title": "다른 강사 방"}
    )
    with pytest.raises(AccessDenied):
        service.instructor_management(ADMIN, instructor_room["id"])
    with pytest.raises(AccessDenied):
        service.add_assistant(ADMIN, instructor_room["id"], ADMIN.uid, 1)


def test_assistant_permission_updates_full_access_and_removal_are_lead_only() -> None:
    service, repository = create_service()
    created = service.create_room(ADMIN, create_payload())
    invited = service.add_assistant(ADMIN, created["id"], INSTRUCTOR.uid, 1)

    with pytest.raises(AccessDenied):
        service.update_assistant_permissions(
            INSTRUCTOR,
            created["id"],
            INSTRUCTOR.uid,
            {"questionOperations": True, "checklistProgress": True},
            invited["revision"],
        )

    granted = service.grant_assistant_full_access(
        ADMIN, created["id"], INSTRUCTOR.uid, invited["revision"]
    )
    assistant = next(
        instructor
        for instructor in granted["instructors"]
        if instructor["userId"] == INSTRUCTOR.uid
    )
    assert all(assistant["permissions"].values())
    revoked = service.revoke_assistant_full_access(
        ADMIN, created["id"], INSTRUCTOR.uid, granted["revision"]
    )
    assistant = next(
        instructor
        for instructor in revoked["instructors"]
        if instructor["userId"] == INSTRUCTOR.uid
    )
    assert assistant["permissions"] == {
        "questionOperations": True,
        "checklistProgress": False,
        "capacityOperations": False,
    }
    removed = service.remove_assistant(
        ADMIN, created["id"], INSTRUCTOR.uid, revoked["revision"]
    )
    assert [item["role"] for item in removed["instructors"]] == ["LEAD"]
    events = [
        document
        for path, document in repository.documents.items()
        if "/auditLogs/" in path and document.get("roomId") == created["id"]
    ]
    assert {
        "ROOM_ASSISTANT_FULL_ACCESS_GRANTED",
        "ROOM_ASSISTANT_FULL_ACCESS_REVOKED",
        "ROOM_ASSISTANT_REMOVED",
    } <= {event["eventType"] for event in events}
    assert all("email" not in event and "token" not in event for event in events)


def test_lead_transfer_preserves_creator_and_rechecks_the_new_lead() -> None:
    service, repository = create_service()
    created = service.create_room(ADMIN, create_payload())
    invited = service.add_assistant(ADMIN, created["id"], INSTRUCTOR.uid, 1)

    transferred = service.transfer_lead(
        ADMIN, created["id"], INSTRUCTOR.uid, invited["revision"]
    )

    stored = repository.documents[f"organizations/demo/rooms/{created['id']}"]
    assert stored["roomCreatorUid"] == ADMIN.uid
    assert stored["leadInstructorUid"] == INSTRUCTOR.uid
    assert [item["role"] for item in stored["roomInstructors"]].count("LEAD") == 1
    old_lead = next(
        item for item in stored["roomInstructors"] if item["uid"] == ADMIN.uid
    )
    assert old_lead["role"] == "ASSISTANT"
    assert all(old_lead["permissions"].values())
    assert transferred["currentRole"] == "ASSISTANT"
    with pytest.raises(AccessDenied):
        service.instructor_management(ADMIN, created["id"])
    assert service.instructor_management(INSTRUCTOR, created["id"])["revision"] == 3
    with pytest.raises(ResourceConflict):
        service.transfer_lead(INSTRUCTOR, created["id"], ADMIN.uid, 2)
    assert any(
        document.get("eventType") == "ROOM_LEAD_TRANSFERRED"
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    )


def test_archived_or_other_org_source_course_cannot_create_room() -> None:
    service, repository = create_service()
    repository.documents["organizations/demo/courses/source-course"]["status"] = (
        "ARCHIVED"
    )

    with pytest.raises(ResourceConflict):
        service.create_room(ADMIN, create_payload())

    repository.documents["organizations/demo/courses/source-course"] = {
        **source_course(),
        "orgId": "other-org",
    }
    with pytest.raises(ResourceNotFound):
        service.create_room(ADMIN, create_payload())


def test_other_organization_room_cannot_be_read() -> None:
    service, repository = create_service()
    created = service.create_room(ADMIN, create_payload())
    stored = repository.documents[f"organizations/demo/rooms/{created['id']}"]
    repository.documents["organizations/demo/rooms/other-org-room"] = {
        **copy.deepcopy(stored),
        "id": "other-org-room",
        "orgId": "other-org",
    }

    with pytest.raises(ResourceNotFound):
        service.get_room(ADMIN, "other-org-room")


def test_source_flow_limit_and_invalid_external_source_fields_are_rejected() -> None:
    service, repository = create_service()
    repository.documents["organizations/demo/courses/source-course"] = source_course(
        item_count=201
    )
    with pytest.raises(InvalidOperation):
        service.create_room(ADMIN, create_payload())

    repository.documents["organizations/demo/courses/source-course"] = source_course()
    created = service.create_room(
        ADMIN,
        {
            **create_payload(),
            "organizationId": "other-org",
            "roomCode": "ZZZZZZZZ",
            "leadInstructorUid": "untrusted",
            "status": "CLOSED",
        },
    )
    assert created["roomCode"] != "ZZZZZZZZ"
    assert created["sourceCourseId"] == "source-course"


def test_lead_instructor_starts_ready_room_and_server_calculates_current_item() -> None:
    service, repository = create_service()
    created = service.create_room(ADMIN, create_payload())

    ready = service.get_checklist(ADMIN, created["id"])
    started = service.start_room(ADMIN, created["id"], ready["revision"])

    stored = repository.documents[f"organizations/demo/rooms/{created['id']}"]
    assert stored["status"] == "LIVE"
    assert stored["revision"] == 2
    assert stored["startedAt"] == FIXED_TIMESTAMP
    assert stored["totalParticipantCount"] == 0
    assert started["currentItemId"] == "item-0"
    assert started["isComplete"] is False
    assert any(
        document.get("eventType") == "ROOM_STARTED"
        and document.get("revision") == 2
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    )


def test_checklist_requires_sequential_complete_and_rewinds_later_items() -> None:
    service, repository = create_service()
    created = service.create_room(ADMIN, create_payload())
    live = service.start_room(ADMIN, created["id"], 1)

    with pytest.raises(ResourceConflict):
        service.complete_checklist_item(
            ADMIN, created["id"], "item-1", live["revision"]
        )

    after_first = service.complete_checklist_item(
        ADMIN, created["id"], "item-0", live["revision"]
    )
    assert after_first["currentItemId"] == "item-1"
    assert after_first["revision"] == 3

    all_complete = service.complete_checklist_item(
        ADMIN, created["id"], "item-1", after_first["revision"]
    )
    assert all_complete["currentItemId"] is None
    assert all_complete["isComplete"] is True

    rewound = service.undo_checklist_item(
        ADMIN, created["id"], "item-0", all_complete["revision"]
    )
    assert rewound["currentItemId"] == "item-0"
    assert rewound["isComplete"] is False
    assert rewound["revision"] == all_complete["revision"] + 1
    assert [item["isCompleted"] for item in rewound["flowItems"]] == [False, False]
    audit_events = [
        document
        for path, document in repository.documents.items()
        if "/auditLogs/" in path and document.get("roomId") == created["id"]
    ]
    assert sum(
        event.get("eventType") == "CHECKLIST_REWOUND" for event in audit_events
    ) == 1
    assert sum(
        event.get("eventType") == "CHECKLIST_ITEM_COMPLETED" for event in audit_events
    ) == 2


def test_checklist_completion_is_idempotent_for_the_same_request() -> None:
    service, repository = create_service()
    created = service.create_room(ADMIN, create_payload())
    live = service.start_room(ADMIN, created["id"], 1)

    completed = service.complete_checklist_item(
        ADMIN, created["id"], "item-0", live["revision"]
    )
    retried = service.complete_checklist_item(
        ADMIN, created["id"], "item-0", live["revision"]
    )

    assert retried == completed
    assert retried["revision"] == live["revision"] + 1
    assert [item["isCompleted"] for item in retried["flowItems"]] == [True, False]
    audits = [
        document
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
        and document.get("eventType") == "CHECKLIST_ITEM_COMPLETED"
        and document.get("roomId") == created["id"]
    ]
    assert len(audits) == 1
    assert audits[0]["operationId"].startswith("checklist-operation-")


def test_checklist_transaction_retry_keeps_one_stable_audit_operation() -> None:
    repository = RetryingRoomRepository()
    service, repository = create_service(repository=repository)
    created = service.create_room(ADMIN, create_payload())
    live = service.start_room(ADMIN, created["id"], 1)
    repository.retry_next_transaction = True

    completed = service.complete_checklist_item(
        ADMIN, created["id"], "item-0", live["revision"]
    )

    assert completed["revision"] == live["revision"] + 1
    discarded_audit_paths = [
        path
        for path in repository.discarded_pending[-1]
        if "/auditLogs/" in path
    ]
    committed_audit_paths = [
        path
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
        and document.get("eventType") == "CHECKLIST_ITEM_COMPLETED"
    ]
    assert discarded_audit_paths == committed_audit_paths
    assert len(committed_audit_paths) == 1


def test_stale_opposite_checklist_action_cannot_toggle_the_completed_item() -> None:
    service, repository = create_service()
    created = service.create_room(ADMIN, create_payload())
    live = service.start_room(ADMIN, created["id"], 1)
    completed = service.complete_checklist_item(
        ADMIN, created["id"], "item-0", live["revision"]
    )

    with pytest.raises(ResourceConflict):
        service.undo_checklist_item(ADMIN, created["id"], "item-0", live["revision"])

    assert repository.documents[
        f"organizations/demo/rooms/{created['id']}"
    ]["revision"] == completed["revision"]
    assert [item["isCompleted"] for item in completed["flowItems"]] == [True, False]
    assert sum(
        document.get("eventType") == "CHECKLIST_REWOUND"
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    ) == 0


def test_checklist_rejects_stale_revision_and_non_live_mutations() -> None:
    service, repository = create_service()
    created = service.create_room(ADMIN, create_payload())

    with pytest.raises(ResourceConflict):
        service.complete_checklist_item(ADMIN, created["id"], "item-0", 1)

    live = service.start_room(ADMIN, created["id"], 1)
    with pytest.raises(ResourceConflict):
        service.complete_checklist_item(ADMIN, created["id"], "item-0", 1)
    with pytest.raises(ResourceConflict):
        service.start_room(ADMIN, created["id"], live["revision"])


def test_only_lead_ends_once_and_receives_a_safe_summary() -> None:
    service, repository = create_service()
    created = service.create_room(INSTRUCTOR, create_payload())
    live = service.start_room(INSTRUCTOR, created["id"], 1)
    room_path = f"organizations/demo/rooms/{created['id']}"
    repository.documents[f"{room_path}/questions/question-1"] = {"answer": "공식 답변"}
    repository.documents[f"{room_path}/questions/question-2"] = {}
    repository.documents[f"{room_path}/participants/student-1"] = {
        "participantStatus": "JOINED",
        "presenceStatus": "ACTIVE",
    }
    repository.documents[f"{room_path}/participants/student-2"] = {
        "participantStatus": "JOINED",
        "presenceStatus": "LEFT",
    }
    repository.documents[room_path]["totalParticipantCount"] = 7

    with pytest.raises(AccessDenied):
        service.end_room(ADMIN, created["id"], live["revision"])

    ended = service.end_room(INSTRUCTOR, created["id"], live["revision"])
    repeated = service.end_room(INSTRUCTOR, created["id"], ended["revision"])
    summary = service.end_summary(INSTRUCTOR, created["id"])

    assert ended["status"] == "ENDED"
    assert repeated["revision"] == ended["revision"]
    assert repository.documents[room_path]["endedByUid"] == INSTRUCTOR.uid
    assert summary == {
        "roomId": created["id"], "title": created["title"], "status": "ENDED",
        "startedAt": FIXED_TIMESTAMP, "endedAt": FIXED_TIMESTAMP,
        "checklistCompletedCount": 0, "checklistTotalCount": 2, "completionRate": 0,
        "totalQuestionCount": 2, "answeredQuestionCount": 1,
        "participantCount": 7, "activeParticipantCount": 1,
        "downloadEnabled": True,
        "downloadAvailableUntil": (FIXED_TIMESTAMP + timedelta(days=7)).isoformat(),
    }
    assert sum(
        document.get("eventType") == "ROOM_ENDED"
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    ) == 1
    with pytest.raises(AccessDenied):
        service.end_summary(ADMIN, created["id"])

    repository.documents[f"organizations/demo/rooms/{created['id']}"][
        "status"
    ] = "ENDED"
    with pytest.raises(ResourceConflict):
        service.complete_checklist_item(
            INSTRUCTOR, created["id"], "item-0", live["revision"]
        )
    with pytest.raises(ResourceConflict):
        service.start_room(INSTRUCTOR, created["id"], live["revision"])


def test_lead_can_reopen_a_recently_ended_room_without_resetting_room_data() -> None:
    service, repository = create_service()
    created = service.create_room(INSTRUCTOR, create_payload())
    live = service.start_room(INSTRUCTOR, created["id"], created["revision"])
    room_path = f"organizations/demo/rooms/{created['id']}"
    repository.documents[f"{room_path}/questions/question-1"] = {"answer": "보존"}
    participant_path = f"{room_path}/participants/student-1"
    question_path = f"{room_path}/questions/question-1"
    repository.documents[participant_path] = {"presenceStatus": "LEFT"}
    before_items = copy.deepcopy(
        repository.documents[f"{room_path}/flowItems/item-0"]
    )
    before_question = copy.deepcopy(repository.documents[question_path])
    before_participant = copy.deepcopy(repository.documents[participant_path])
    ended = service.end_room(INSTRUCTOR, created["id"], live["revision"])

    reopened = service.reopen_room(INSTRUCTOR, created["id"], ended["revision"])

    stored = repository.documents[room_path]
    assert reopened["status"] == "LIVE"
    assert reopened["revision"] == ended["revision"] + 1
    assert stored["endedAt"] == FIXED_TIMESTAMP
    assert stored["lastEndedAt"] == FIXED_TIMESTAMP
    assert stored["reopenedByUid"] == INSTRUCTOR.uid
    assert repository.documents[f"{room_path}/flowItems/item-0"] == before_items
    assert repository.documents[question_path] == before_question
    assert repository.documents[participant_path] == before_participant
    assert sum(
        document.get("eventType") == "ROOM_REOPENED"
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    ) == 1


def test_only_lead_can_reopen_a_recently_ended_room() -> None:
    service, _ = create_service()
    created = service.create_room(INSTRUCTOR, create_payload())
    managed = service.add_assistant(
        INSTRUCTOR, created["id"], ADMIN.uid, created["revision"]
    )
    live = service.start_room(INSTRUCTOR, created["id"], managed["revision"])
    ended = service.end_room(INSTRUCTOR, created["id"], live["revision"])

    for identity in (ADMIN, STUDENT, OTHER_ORG):
        with pytest.raises(AccessDenied):
            service.reopen_room(identity, created["id"], ended["revision"])


def test_reopen_rejects_stale_expired_and_missing_room_states_without_writes() -> None:
    current_time = FIXED_TIMESTAMP
    service, repository = create_service(clock=lambda: current_time)
    created = service.create_room(INSTRUCTOR, create_payload())
    live = service.start_room(INSTRUCTOR, created["id"], created["revision"])
    ended = service.end_room(INSTRUCTOR, created["id"], live["revision"])
    room_path = f"organizations/demo/rooms/{created['id']}"
    before = copy.deepcopy(repository.documents[room_path])

    with pytest.raises(ResourceConflict):
        service.reopen_room(INSTRUCTOR, created["id"], ended["revision"] - 1)
    assert repository.documents[room_path] == before

    current_time = FIXED_TIMESTAMP + timedelta(minutes=11)
    with pytest.raises(ResourceConflict):
        service.reopen_room(INSTRUCTOR, created["id"], ended["revision"])
    assert repository.documents[room_path] == before

    download_policy = repository.documents[room_path]["materialDownloadPolicy"]
    download_policy["downloadAvailableUntil"] = (
        FIXED_TIMESTAMP - timedelta(minutes=1)
    ).isoformat()
    current_time = FIXED_TIMESTAMP
    with pytest.raises(ResourceConflict):
        service.reopen_room(INSTRUCTOR, created["id"], ended["revision"])
    assert repository.documents[room_path]["status"] == "ENDED"
    assert sum(
        document.get("eventType") == "ROOM_REOPENED"
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    ) == 0

    with pytest.raises(ResourceNotFound):
        service.reopen_room(INSTRUCTOR, "missing-room", 1)


def test_reopen_operation_is_idempotent_across_transaction_retries() -> None:
    repository = RetryingRoomRepository()
    service, repository = create_service(repository=repository)
    created = service.create_room(INSTRUCTOR, create_payload())
    live = service.start_room(INSTRUCTOR, created["id"], created["revision"])
    ended = service.end_room(INSTRUCTOR, created["id"], live["revision"])
    repository.retry_next_transaction = True

    reopened = service.reopen_room(INSTRUCTOR, created["id"], ended["revision"])
    repeated = service.reopen_room(INSTRUCTOR, created["id"], ended["revision"])

    assert reopened["status"] == repeated["status"] == "LIVE"
    assert reopened["revision"] == repeated["revision"] == ended["revision"] + 1
    assert sum(
        document.get("eventType") == "ROOM_REOPENED"
        for path, document in repository.documents.items()
        if "/auditLogs/" in path
    ) == 1


def test_end_room_normalizes_a_custom_kst_student_access_deadline() -> None:
    service, repository = create_service()
    created = service.create_room(INSTRUCTOR, create_payload())
    live = service.start_room(INSTRUCTOR, created["id"], 1)
    custom_until = datetime(
        2026,
        7,
        26,
        1,
        tzinfo=timezone(timedelta(hours=9)),
    )

    service.end_room(
        INSTRUCTOR,
        created["id"],
        live["revision"],
        student_access_window="CUSTOM",
        student_access_until=custom_until,
    )

    policy = repository.documents[
        f"organizations/demo/rooms/{created['id']}"
    ]["materialDownloadPolicy"]
    assert policy["downloadAvailableUntil"] == "2026-07-25T16:00:00+00:00"


def test_end_room_rejects_a_custom_student_access_deadline_before_ending() -> None:
    service, repository = create_service()
    created = service.create_room(INSTRUCTOR, create_payload())
    live = service.start_room(INSTRUCTOR, created["id"], 1)

    with pytest.raises(InvalidOperation):
        service.end_room(
            INSTRUCTOR,
            created["id"],
            live["revision"],
            student_access_window="CUSTOM",
            student_access_until=datetime(
                2026,
                7,
                25,
                20,
                59,
                tzinfo=timezone(timedelta(hours=9)),
            ),
        )

    assert repository.documents[
        f"organizations/demo/rooms/{created['id']}"
    ]["status"] == "LIVE"


def test_live_lead_cannot_remove_themself_before_ending_or_transferring() -> None:
    service, _ = create_service()
    created = service.create_room(INSTRUCTOR, create_payload())
    live = service.start_room(INSTRUCTOR, created["id"], 1)

    with pytest.raises(ResourceConflict):
        service.remove_assistant(
            INSTRUCTOR,
            created["id"],
            INSTRUCTOR.uid,
            live["revision"],
        )


def test_unassigned_admin_cannot_read_or_change_another_instructors_checklist() -> None:
    service, _ = create_service()
    created = service.create_room(
        INSTRUCTOR, {"sourceCourseId": "source-course", "title": "강사 방"}
    )

    with pytest.raises(AccessDenied):
        service.get_checklist(ADMIN, created["id"])
    with pytest.raises(AccessDenied):
        service.start_room(ADMIN, created["id"], 1)
    with pytest.raises(AccessDenied):
        service.get_checklist(STUDENT, created["id"])
    with pytest.raises(AccessDenied):
        service.get_checklist(OTHER_ORG, created["id"])


def test_checklist_mutation_does_not_change_another_room_flow_items() -> None:
    service, repository = create_service()
    first = service.create_room(ADMIN, create_payload())
    second = service.create_room(
        INSTRUCTOR, {"sourceCourseId": "source-course", "title": "별도 강의방"}
    )
    live = service.start_room(ADMIN, first["id"], 1)
    service.complete_checklist_item(ADMIN, first["id"], "item-0", live["revision"])

    other_items = service.get_checklist(INSTRUCTOR, second["id"])["flowItems"]
    assert [item["isCompleted"] for item in other_items] == [False, False]
    assert repository.documents[
        f"organizations/demo/rooms/{second['id']}"
    ]["revision"] == 1
