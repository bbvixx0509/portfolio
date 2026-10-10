from copy import deepcopy
from typing import Any

import pytest

from app.domain.authorization import (
    AccountType,
    Permission,
    Principal,
    empty_permissions,
)
from app.domain.errors import AccessDenied, ResourceConflict, ResourceNotFound
from app.services.nodo_service import NoDoService


class FakeRepository:
    def __init__(self) -> None:
        self.users = {
            "lead-instructor": {
                "uid": "lead-instructor",
                "orgId": "org-nodo",
                "accountType": AccountType.STAFF.value,
                "organizationRole": "INSTRUCTOR",
            },
            "assistant-none": {
                "uid": "assistant-none",
                "orgId": "org-nodo",
                "accountType": AccountType.STAFF.value,
                "organizationRole": "INSTRUCTOR",
            },
            "assistant-limited": {
                "uid": "assistant-limited",
                "orgId": "org-nodo",
                "accountType": AccountType.STAFF.value,
                "organizationRole": "INSTRUCTOR",
            },
        }
        self.course = {
            "id": "demo-course",
            "orgId": "org-nodo",
            "leadInstructorId": "lead-instructor",
            "activeRoomId": "demo-room",
        }
        self.room = {
            "id": "demo-room",
            "orgId": "org-nodo",
            "courseId": "demo-course",
            "leadInstructorId": "lead-instructor",
            "status": "ACTIVE",
            "joinCode": "NODO01",
        }
        self.staff = {
            "assistant-limited": {
                "userId": "assistant-limited",
                "roomId": "demo-room",
                "orgId": "org-nodo",
                "permissions": {
                    **empty_permissions(),
                    Permission.CAN_CONTROL_PROGRESS.value: True,
                },
            }
        }
        self.last_completion: dict[str, Any] | None = None
        self.last_course_create: dict[str, Any] | None = None
        self.permission_logs = 0

    def list_courses(self, org_id: str) -> list[dict[str, Any]]:
        return [deepcopy(self.course)] if org_id == "org-nodo" else []

    def get_course(self, course_id: str) -> dict[str, Any] | None:
        return deepcopy(self.course) if course_id == "demo-course" else None

    def get_room(self, room_id: str) -> dict[str, Any] | None:
        return deepcopy(self.room) if room_id == "demo-room" else None

    def get_staff(self, room_id: str, uid: str) -> dict[str, Any] | None:
        return deepcopy(self.staff.get(uid))

    def get_participant(self, room_id: str, uid: str) -> None:
        return None

    def get_user(self, uid: str) -> dict[str, Any] | None:
        return deepcopy(self.users.get(uid))

    def get_course_flow(self, course_id: str) -> dict[str, list[Any]]:
        return {"chapters": [], "items": []}

    def get_room_join_code(self, room_id: str) -> str:
        return "NODO01"

    def create_course(self, **kwargs: Any) -> dict[str, Any]:
        self.last_course_create = kwargs
        return {"id": "created-course", **kwargs}

    def update_completion(self, **kwargs: Any) -> dict[str, Any]:
        self.last_completion = kwargs
        return {"currentItemId": "flow-2"}

    def upsert_staff(self, **kwargs: Any) -> dict[str, Any]:
        target_uid = kwargs["target_uid"]
        if kwargs["change_type"] == "ADDED" and target_uid in self.staff:
            raise ResourceConflict("The assistant is already assigned to this room")
        value = {
            "userId": target_uid,
            "roomId": "demo-room",
            "orgId": "org-nodo",
            "permissions": kwargs["permissions"],
        }
        self.staff[target_uid] = value
        self.permission_logs += 1
        return deepcopy(value)


def actor(
    uid: str,
    account_type: AccountType = AccountType.STAFF,
    org: str = "org-nodo",
) -> Principal:
    return Principal(uid=uid, account_type=account_type, org_id=org)


def test_lead_can_control_progress_without_staff_document() -> None:
    repository = FakeRepository()
    service = NoDoService(repository)

    result = service.update_completion(
        actor("lead-instructor"),
        "demo-room",
        "flow-1",
        True,
    )

    assert result["currentItemId"] == "flow-2"
    assert repository.last_completion is not None


def test_any_staff_creates_course_as_its_room_lead() -> None:
    repository = FakeRepository()
    service = NoDoService(repository)

    created = service.create_course(
        actor("assistant-none"), title="새 강의", description=""
    )

    assert created["lead_instructor_id"] == "assistant-none"
    assert repository.last_course_create is not None
    assert repository.last_course_create["created_by"] == "assistant-none"


def test_student_cannot_create_course() -> None:
    service = NoDoService(FakeRepository())

    with pytest.raises(AccessDenied):
        service.create_course(
            actor("student", AccountType.STUDENT), title="금지", description=""
        )


def test_assistant_with_control_permission_can_update_progress() -> None:
    repository = FakeRepository()
    service = NoDoService(repository)

    service.update_completion(
        actor("assistant-limited"),
        "demo-room",
        "flow-1",
        True,
    )

    assert repository.last_completion is not None


def test_assistant_without_permission_gets_403_domain_error() -> None:
    service = NoDoService(FakeRepository())

    with pytest.raises(AccessDenied) as error:
        service.update_completion(
            actor("assistant-none"),
            "demo-room",
            "flow-1",
            True,
        )

    assert error.value.status_code == 403


def test_student_cannot_change_checklist() -> None:
    service = NoDoService(FakeRepository())

    with pytest.raises(AccessDenied):
        service.update_completion(
            actor("student", AccountType.STUDENT), "demo-room", "flow-1", True
        )


def test_assistant_cannot_change_own_permissions() -> None:
    service = NoDoService(FakeRepository())

    with pytest.raises(AccessDenied):
        service.update_staff_permissions(
            actor("assistant-limited"),
            "demo-room",
            "assistant-limited",
            {Permission.CAN_EDIT_COURSE_FLOW.value: True},
        )


def test_assistant_cannot_change_another_assistant_permissions() -> None:
    service = NoDoService(FakeRepository())

    with pytest.raises(AccessDenied):
        service.update_staff_permissions(
            actor("assistant-limited"),
            "demo-room",
            "assistant-none",
            {Permission.CAN_EDIT_COURSE_FLOW.value: True},
        )


def test_lead_cannot_grant_permissions_before_invitation() -> None:
    service = NoDoService(FakeRepository())

    with pytest.raises(ResourceNotFound):
        service.update_staff_permissions(
            actor("lead-instructor"),
            "demo-room",
            "assistant-none",
            {Permission.CAN_CONTROL_PROGRESS.value: True},
        )


def test_lead_permission_update_creates_permission_log() -> None:
    repository = FakeRepository()
    service = NoDoService(repository)

    updated = service.update_staff_permissions(
        actor("lead-instructor"),
        "demo-room",
        "assistant-limited",
        {Permission.CAN_EDIT_COURSE_FLOW.value: True},
    )

    assert updated["permissions"][Permission.CAN_EDIT_COURSE_FLOW.value]
    assert repository.permission_logs == 1


def test_other_organization_is_denied_before_permission_check() -> None:
    service = NoDoService(FakeRepository())

    with pytest.raises(AccessDenied, match="Cross-organization"):
        service.update_completion(
            actor(
                "outsider-instructor",
                AccountType.STAFF,
                "org-other",
            ),
            "demo-room",
            "flow-1",
            True,
        )


def test_assistant_course_list_only_contains_invited_rooms() -> None:
    service = NoDoService(FakeRepository())

    limited = service.list_courses(
        actor("assistant-limited")
    )
    not_invited = service.list_courses(
        actor("assistant-none")
    )

    assert [course["id"] for course in limited] == ["demo-course"]
    assert limited[0]["roomRole"] == "ASSISTANT"
    assert not_invited == []


def test_course_creator_is_listed_with_lead_room_role() -> None:
    courses = NoDoService(FakeRepository()).list_courses(actor("lead-instructor"))

    assert courses[0]["roomRole"] == "LEAD"


def test_room_read_never_exposes_legacy_join_code() -> None:
    repository = FakeRepository()
    repository.room["joinCode"] = "SHOULD_NOT_LEAK"
    service = NoDoService(repository)

    result = service.get_room(
        actor("lead-instructor"), "demo-room"
    )

    assert "joinCode" not in result


def test_share_requires_can_share_room_but_lead_can_read_code() -> None:
    service = NoDoService(FakeRepository())

    with pytest.raises(AccessDenied):
        service.get_room_share(
            actor("assistant-limited"),
            "demo-room",
        )

    result = service.get_room_share(
        actor("lead-instructor"), "demo-room"
    )
    assert result == {
        "roomId": "demo-room",
        "joinCode": "NODO01",
        "joinPath": "/join/NODO01",
    }


def test_assistant_with_share_permission_can_read_code() -> None:
    repository = FakeRepository()
    repository.staff["assistant-limited"]["permissions"][
        Permission.CAN_SHARE_ROOM.value
    ] = True
    service = NoDoService(repository)

    result = service.get_room_share(
        actor("assistant-limited"),
        "demo-room",
    )

    assert result["joinCode"] == "NODO01"


def test_invalid_room_course_link_is_rejected_before_read() -> None:
    repository = FakeRepository()
    repository.room["courseId"] = "wrong-course"
    service = NoDoService(repository)

    with pytest.raises(ResourceConflict, match="room course"):
        service.get_room(
            actor("lead-instructor"), "demo-room"
        )


def test_adding_existing_staff_returns_conflict() -> None:
    service = NoDoService(FakeRepository())

    with pytest.raises(ResourceConflict):
        service.add_staff(
            actor("lead-instructor"),
            "demo-room",
            "assistant-limited",
        )


def test_new_staff_invitation_uses_server_default_permissions() -> None:
    service = NoDoService(FakeRepository())

    invited = service.add_staff(
        actor("lead-instructor"), "demo-room", "assistant-none"
    )

    assert invited["permissions"][Permission.CAN_ANSWER_QUESTIONS.value] is True
    assert all(
        not enabled
        for key, enabled in invited["permissions"].items()
        if key != Permission.CAN_ANSWER_QUESTIONS.value
    )
