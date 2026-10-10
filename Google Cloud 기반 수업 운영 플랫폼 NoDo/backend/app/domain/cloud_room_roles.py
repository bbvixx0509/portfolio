"""Room-local instructor assignments and explicitly delegable permissions.

The assignment list on the room document is the sole authority for room roles.
Legacy ``leadInstructorUid`` and ``instructorMemberUids`` fields are derived
compatibility projections and must be updated in the same transaction.
"""

from collections.abc import Mapping
from typing import Any

ROOM_ROLE_LEAD = "LEAD"
ROOM_ROLE_ASSISTANT = "ASSISTANT"

QUESTION_OPERATIONS = "questionOperations"
CHECKLIST_PROGRESS = "checklistProgress"
CAPACITY_OPERATIONS = "capacityOperations"
DELEGABLE_ROOM_PERMISSION_KEYS = (
    QUESTION_OPERATIONS,
    CHECKLIST_PROGRESS,
    CAPACITY_OPERATIONS,
)


def no_room_permissions() -> dict[str, bool]:
    return {key: False for key in DELEGABLE_ROOM_PERMISSION_KEYS}


def default_assistant_room_permissions() -> dict[str, bool]:
    permissions = no_room_permissions()
    permissions[QUESTION_OPERATIONS] = True
    return permissions


def full_room_permissions() -> dict[str, bool]:
    return {key: True for key in DELEGABLE_ROOM_PERMISSION_KEYS}


def normalize_room_permissions(value: Mapping[str, Any] | None) -> dict[str, bool]:
    permissions = no_room_permissions()
    if value is None:
        return permissions
    unknown = set(value) - set(DELEGABLE_ROOM_PERMISSION_KEYS)
    if unknown:
        names = ", ".join(sorted(unknown))
        raise ValueError(f"Unknown room assistant permissions: {names}")
    for key in DELEGABLE_ROOM_PERMISSION_KEYS:
        if key in value:
            permissions[key] = value[key] is True
    return permissions


def room_instructors(room: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Read room assignments, safely supporting rooms created before 02-12A."""

    raw = room.get("roomInstructors")
    if raw is None:
        lead_uid = room.get("leadInstructorUid")
        if not isinstance(lead_uid, str) or not lead_uid:
            return []
        return [
            {
                "uid": lead_uid,
                "role": ROOM_ROLE_LEAD,
                "permissions": full_room_permissions(),
                "displayNameSnapshot": room.get("leadInstructorDisplayNameSnapshot"),
            }
        ]
    if not isinstance(raw, list):
        return []
    normalized: list[dict[str, Any]] = []
    seen_uids: set[str] = set()
    lead_count = 0
    for value in raw:
        if not isinstance(value, Mapping):
            return []
        uid = value.get("uid")
        role = value.get("role")
        if not isinstance(uid, str) or not uid or uid in seen_uids:
            return []
        if role not in {ROOM_ROLE_LEAD, ROOM_ROLE_ASSISTANT}:
            return []
        try:
            permissions = normalize_room_permissions(value.get("permissions"))
        except ValueError:
            return []
        if role == ROOM_ROLE_LEAD:
            lead_count += 1
            permissions = full_room_permissions()
        display_name = value.get("displayNameSnapshot")
        normalized.append(
            {
                "uid": uid,
                "role": role,
                "permissions": permissions,
                "displayNameSnapshot": display_name
                if isinstance(display_name, str) and display_name.strip()
                else None,
            }
        )
        seen_uids.add(uid)
    return normalized if lead_count == 1 else []


def assignment_for(room: Mapping[str, Any], uid: str) -> dict[str, Any] | None:
    return next((item for item in room_instructors(room) if item["uid"] == uid), None)


def has_room_operation(
    room: Mapping[str, Any], uid: str, permission: str
) -> bool:
    assignment = assignment_for(room, uid)
    if assignment is None:
        return False
    return assignment["role"] == ROOM_ROLE_LEAD or assignment["permissions"].get(
        permission
    ) is True


def room_instructor_uids(assignments: list[Mapping[str, Any]]) -> list[str]:
    return [str(item["uid"]) for item in assignments]
