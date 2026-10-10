from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class AccountType(StrEnum):
    STAFF = "STAFF"
    STUDENT = "STUDENT"


class OrganizationRole(StrEnum):
    ADMIN = "ADMIN"
    INSTRUCTOR = "INSTRUCTOR"


class RoomRole(StrEnum):
    LEAD = "LEAD"
    ASSISTANT = "ASSISTANT"


class RoomStatus(StrEnum):
    PREPARING = "PREPARING"
    ACTIVE = "ACTIVE"
    ENDING = "ENDING"
    ENDED = "ENDED"


class Permission(StrEnum):
    CAN_EDIT_COURSE = "canEditCourse"
    CAN_EDIT_COURSE_FLOW = "canEditCourseFlow"
    CAN_MANAGE_MATERIALS = "canManageMaterials"
    CAN_SHARE_ROOM = "canShareRoom"
    CAN_CONTROL_PROGRESS = "canControlProgress"
    CAN_ANSWER_QUESTIONS = "canAnswerQuestions"
    CAN_MODERATE_QUESTIONS = "canModerateQuestions"
    CAN_ANNOTATE = "canAnnotate"
    CAN_MANAGE_PARTICIPANTS = "canManageParticipants"
    CAN_END_ROOM = "canEndRoom"
    CAN_VIEW_REPORTS = "canViewReports"
    CAN_EXPORT_RESULTS = "canExportResults"


ALL_PERMISSIONS: tuple[Permission, ...] = tuple(Permission)
PERMISSION_KEYS = frozenset(permission.value for permission in ALL_PERMISSIONS)
CONNECTED_PERMISSIONS = frozenset(
    {
        Permission.CAN_EDIT_COURSE,
        Permission.CAN_EDIT_COURSE_FLOW,
        Permission.CAN_MANAGE_MATERIALS,
        Permission.CAN_SHARE_ROOM,
        Permission.CAN_CONTROL_PROGRESS,
        Permission.CAN_ANSWER_QUESTIONS,
        Permission.CAN_MODERATE_QUESTIONS,
        Permission.CAN_MANAGE_PARTICIPANTS,
        Permission.CAN_END_ROOM,
        Permission.CAN_VIEW_REPORTS,
    }
)


def empty_permissions() -> dict[str, bool]:
    return {permission.value: False for permission in ALL_PERMISSIONS}


def default_assistant_permissions() -> dict[str, bool]:
    permissions = empty_permissions()
    permissions[Permission.CAN_ANSWER_QUESTIONS.value] = True
    return permissions


def normalize_permissions(value: dict[str, Any] | None) -> dict[str, bool]:
    permissions = empty_permissions()
    if value:
        unknown = set(value) - PERMISSION_KEYS
        if unknown:
            names = ", ".join(sorted(unknown))
            raise ValueError(f"Unknown assistant permission fields: {names}")
        permissions.update({key: bool(enabled) for key, enabled in value.items()})
    return permissions


@dataclass(frozen=True)
class Principal:
    uid: str
    account_type: AccountType
    org_id: str | None
    organization_role: OrganizationRole | None = None
    email: str | None = None
    display_name: str | None = None
    is_anonymous: bool = False


def is_room_lead(principal: Principal, room: dict[str, Any]) -> bool:
    return (
        principal.account_type is AccountType.STAFF
        and principal.org_id is not None
        and principal.org_id == room.get("orgId")
        and principal.uid == room.get("leadInstructorId")
    )


def has_room_permission(
    principal: Principal,
    room: dict[str, Any],
    staff: dict[str, Any] | None,
    permission: Permission,
) -> bool:
    if principal.account_type is not AccountType.STAFF or principal.org_id != room.get(
        "orgId"
    ):
        return False
    if is_room_lead(principal, room):
        return True
    if staff is None:
        return False
    if (
        staff.get("roomId") not in {None, room.get("id")}
        or staff.get("orgId") != room.get("orgId")
        or staff.get("userId") not in {None, principal.uid}
    ):
        return False
    return staff.get("permissions", {}).get(permission.value) is True


def account_profile(
    profile: dict[str, Any],
) -> tuple[AccountType, OrganizationRole | None]:
    """Read only the current account and organization-role contract."""

    account_type = AccountType(profile["accountType"])
    if account_type is AccountType.STUDENT:
        return account_type, None
    return account_type, OrganizationRole(profile["organizationRole"])
