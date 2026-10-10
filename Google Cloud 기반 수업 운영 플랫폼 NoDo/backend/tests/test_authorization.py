import pytest

from app.core.config import Settings
from app.domain.authorization import (
    ALL_PERMISSIONS,
    AccountType,
    OrganizationRole,
    Permission,
    Principal,
    default_assistant_permissions,
    empty_permissions,
    has_room_permission,
    is_room_lead,
    normalize_permissions,
)

ROOM = {
    "id": "demo-room",
    "orgId": "org-nodo",
    "leadInstructorId": "lead-instructor",
}


def principal(
    uid: str,
    account_type: AccountType = AccountType.STAFF,
    org_id: str = "org-nodo",
    *,
    organization_role: OrganizationRole = OrganizationRole.INSTRUCTOR,
) -> Principal:
    return Principal(
        uid=uid,
        account_type=account_type,
        org_id=org_id,
        organization_role=organization_role
        if account_type is AccountType.STAFF
        else None,
    )


def test_all_twelve_delegated_permissions_have_false_defaults() -> None:
    permissions = empty_permissions()

    assert len(ALL_PERMISSIONS) == 12
    assert permissions == {permission.value: False for permission in Permission}


def test_lead_has_every_room_permission_without_staff_document() -> None:
    lead = principal("lead-instructor")

    assert all(has_room_permission(lead, ROOM, None, item) for item in Permission)


def test_admin_who_created_room_is_still_room_lead() -> None:
    admin = principal("lead-instructor", organization_role=OrganizationRole.ADMIN)

    assert is_room_lead(admin, ROOM)


def test_student_with_matching_uid_is_not_room_lead() -> None:
    student = principal("lead-instructor", AccountType.STUDENT)

    assert not is_room_lead(student, ROOM)


def test_assistant_only_has_explicitly_granted_permission() -> None:
    assistant = principal("assistant-limited")
    staff = {
        "roomId": "demo-room",
        "orgId": "org-nodo",
        "userId": "assistant-limited",
        "permissions": {Permission.CAN_CONTROL_PROGRESS.value: True},
    }

    assert has_room_permission(assistant, ROOM, staff, Permission.CAN_CONTROL_PROGRESS)
    assert not has_room_permission(
        assistant, ROOM, staff, Permission.CAN_EDIT_COURSE_FLOW
    )


def test_cross_organization_staff_document_does_not_grant_access() -> None:
    outsider = principal("outsider-instructor", org_id="org-other")
    staff = {
        "roomId": "demo-room",
        "orgId": "org-nodo",
        "userId": "outsider-instructor",
        "permissions": {Permission.CAN_CONTROL_PROGRESS.value: True},
    }

    assert not has_room_permission(
        outsider, ROOM, staff, Permission.CAN_CONTROL_PROGRESS
    )


def test_assistant_invitation_defaults_only_answer_permission() -> None:
    permissions = default_assistant_permissions()

    assert permissions[Permission.CAN_ANSWER_QUESTIONS.value] is True
    assert all(
        not enabled
        for key, enabled in permissions.items()
        if key != Permission.CAN_ANSWER_QUESTIONS.value
    )


def test_non_delegable_field_is_rejected() -> None:
    with pytest.raises(ValueError, match="transferCourseOwnership"):
        normalize_permissions({"transferCourseOwnership": True})


def test_cloud_project_id_is_rejected_before_firebase_initialization() -> None:
    unsafe = Settings(firebase_project_id="real-production-project")

    with pytest.raises(RuntimeError, match="demo-nodo"):
        unsafe.ensure_emulator_only()


def test_non_loopback_firebase_host_is_rejected() -> None:
    unsafe = Settings(firebase_auth_emulator_host="10.0.0.4:9099")

    with pytest.raises(RuntimeError, match="loopback"):
        unsafe.ensure_emulator_only()
