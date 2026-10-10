from dataclasses import dataclass
from typing import Any

from firebase_admin import auth, firestore

from app.adapters.firebase_emulator import (
    SCHEMA_VERSION,
    get_admin_app,
    get_firestore_client,
)
from app.core.config import settings
from app.domain.authorization import (
    AccountType,
    OrganizationRole,
    Permission,
    empty_permissions,
)

LOCAL_PASSWORD = "NoDo01!LocalOnly"
DEMO_ORG_ID = "org-nodo"
OTHER_ORG_ID = "org-other"
DEMO_COURSE_ID = "demo-course"
DEMO_ROOM_ID = "demo-room"
DEMO_JOIN_CODE = "NODO01"


@dataclass(frozen=True)
class SeedAccount:
    uid: str
    email: str
    display_name: str
    account_type: AccountType
    org_id: str
    organization_role: OrganizationRole = OrganizationRole.INSTRUCTOR


SEED_ACCOUNTS = (
    SeedAccount(
        "org-admin",
        "admin@nodo.test",
        "NoDo 관리자 직원",
        AccountType.STAFF,
        DEMO_ORG_ID,
        OrganizationRole.ADMIN,
    ),
    SeedAccount(
        "lead-instructor",
        "lead@nodo.test",
        "김민준",
        AccountType.STAFF,
        DEMO_ORG_ID,
    ),
    SeedAccount(
        "assistant-none",
        "assistant.none@nodo.test",
        "박지민",
        AccountType.STAFF,
        DEMO_ORG_ID,
    ),
    SeedAccount(
        "assistant-limited",
        "assistant.limited@nodo.test",
        "이서준",
        AccountType.STAFF,
        DEMO_ORG_ID,
    ),
    SeedAccount(
        "outsider-instructor",
        "outsider@nodo.test",
        "최유진",
        AccountType.STAFF,
        OTHER_ORG_ID,
    ),
)


def _upsert_auth_user(account: SeedAccount) -> None:
    application = get_admin_app()
    try:
        auth.get_user(account.uid, app=application)
    except auth.UserNotFoundError:
        auth.create_user(
            uid=account.uid,
            email=account.email,
            password=LOCAL_PASSWORD,
            display_name=account.display_name,
            app=application,
        )
    else:
        auth.update_user(
            account.uid,
            email=account.email,
            password=LOCAL_PASSWORD,
            display_name=account.display_name,
            app=application,
        )


def _set_seed_document(reference: Any, value: dict[str, Any]) -> None:
    snapshot = reference.get()
    now = firestore.SERVER_TIMESTAMP
    if snapshot.exists:
        reference.set({**value, "updatedAt": now}, merge=True)
    else:
        reference.set(
            {
                **value,
                "createdAt": now,
                "updatedAt": now,
                "schemaVersion": SCHEMA_VERSION,
            }
        )


def _delete_collection(collection: Any) -> None:
    """Delete local-only demo documents, including nested read-context documents."""
    for snapshot in collection.stream():
        for nested_collection in snapshot.reference.collections():
            _delete_collection(nested_collection)
        snapshot.reference.delete()


def seed_emulator() -> dict[str, int]:
    settings.ensure_emulator_only()
    database = get_firestore_client()
    for account in SEED_ACCOUNTS:
        _upsert_auth_user(account)
        _set_seed_document(
            database.collection("users").document(account.uid),
            {
                "uid": account.uid,
                "email": account.email,
                "displayName": account.display_name,
                "accountType": account.account_type.value,
                "organizationRole": account.organization_role.value,
                "organizationRoleRevision": 1,
                "orgId": account.org_id,
                "isAnonymous": False,
            },
        )
        user_ref = database.collection("users").document(account.uid)
        if "role" in (user_ref.get().to_dict() or {}):
            user_ref.update({"role": firestore.DELETE_FIELD})
    _set_seed_document(
        database.collection("organizations").document(DEMO_ORG_ID),
        {
            "id": DEMO_ORG_ID,
            "orgId": DEMO_ORG_ID,
            "name": "NoDo 데모 조직",
            "adminCount": 1,
        },
    )
    _set_seed_document(
        database.collection("organizations").document(OTHER_ORG_ID),
        {
            "id": OTHER_ORG_ID,
            "orgId": OTHER_ORG_ID,
            "name": "NoDo 다른 조직",
        },
    )
    _set_seed_document(
        database.collection("courses").document(DEMO_COURSE_ID),
        {
            "id": DEMO_COURSE_ID,
            "orgId": DEMO_ORG_ID,
            "title": "NoDo 데모 강의",
            "description": "01-3A 방별 역할·질문 검증용 강의",
            "leadInstructorId": "lead-instructor",
            "activeRoomId": DEMO_ROOM_ID,
            "status": "ACTIVE",
            "createdBy": "lead-instructor",
        },
    )
    chapter_ref = (
        database.collection("courses")
        .document(DEMO_COURSE_ID)
        .collection("chapters")
        .document("chapter-1")
    )
    _set_seed_document(
        chapter_ref,
        {
            "id": "chapter-1",
            "courseId": DEMO_COURSE_ID,
            "orgId": DEMO_ORG_ID,
            "title": "1차시: NoDo 시작",
            "order": 0,
        },
    )
    item_specs = (
        ("flow-1", "NoDo 개요", 0),
        ("flow-2", "핵심 기능 살펴보기", 1),
        ("flow-3", "실습과 정리", 2),
    )
    course_ref = database.collection("courses").document(DEMO_COURSE_ID)
    for chapter in course_ref.collection("chapters").stream():
        if chapter.id != "chapter-1":
            chapter.reference.delete()
    expected_item_ids = {item[0] for item in item_specs}
    for item in course_ref.collection("items").stream():
        if item.id not in expected_item_ids:
            item.reference.delete()
    for item_id, title, order in item_specs:
        _set_seed_document(
            database.collection("courses")
            .document(DEMO_COURSE_ID)
            .collection("items")
            .document(item_id),
            {
                "id": item_id,
                "courseId": DEMO_COURSE_ID,
                "orgId": DEMO_ORG_ID,
                "chapterId": "chapter-1",
                "title": title,
                "order": order,
                "isCompleted": False,
            },
        )
    room_ref = database.collection("rooms").document(DEMO_ROOM_ID)
    for collection_name in (
        "questions",
        "questionAuthors",
        "questionReads",
        "moderationLogs",
        "questionRateLimits",
        "summary",
        "serverState",
    ):
        _delete_collection(room_ref.collection(collection_name))
    _set_seed_document(
        room_ref,
        {
            "id": DEMO_ROOM_ID,
            "orgId": DEMO_ORG_ID,
            "courseId": DEMO_COURSE_ID,
            "leadInstructorId": "lead-instructor",
            "status": "ACTIVE",
            "itemOrder": [item[0] for item in item_specs],
            "currentItemId": "flow-1",
            "createdBy": "lead-instructor",
        },
    )
    seeded_room = room_ref.get().to_dict() or {}
    stale_room_fields = {
        field: firestore.DELETE_FIELD
        for field in (
            "joinCode",
            "endingAt",
            "endingByDisplayName",
            "endedAt",
            "endedByDisplayName",
        )
        if field in seeded_room
    }
    if stale_room_fields:
        room_ref.update(stale_room_fields)
    _set_seed_document(
        database.collection("roomJoinCodes").document(DEMO_JOIN_CODE),
        {
            "id": DEMO_JOIN_CODE,
            "roomId": DEMO_ROOM_ID,
            "orgId": DEMO_ORG_ID,
        },
    )
    # Keep one assistant available for the invitation scenario after every seed.
    database.collection("rooms").document(DEMO_ROOM_ID).collection("staff").document(
        "assistant-none"
    ).delete()
    _set_seed_document(
        database.collection("rooms")
        .document(DEMO_ROOM_ID)
        .collection("staff")
        .document("assistant-limited"),
        {
            "userId": "assistant-limited",
            "roomId": DEMO_ROOM_ID,
            "orgId": DEMO_ORG_ID,
            "permissions": {
                **empty_permissions(),
                Permission.CAN_CONTROL_PROGRESS.value: True,
                Permission.CAN_ANSWER_QUESTIONS.value: True,
            },
            "grantedBy": "lead-instructor",
            "updatedBy": "lead-instructor",
            "grantedAt": firestore.SERVER_TIMESTAMP,
        },
    )
    seeded_staff_ref = (
        database.collection("rooms")
        .document(DEMO_ROOM_ID)
        .collection("staff")
        .document("assistant-limited")
    )
    if "role" in (seeded_staff_ref.get().to_dict() or {}):
        seeded_staff_ref.update({"role": firestore.DELETE_FIELD})
    _set_seed_document(
        database.collection("rooms")
        .document(DEMO_ROOM_ID)
        .collection("permissionLogs")
        .document("seed-assistant-limited"),
        {
            "id": "seed-assistant-limited",
            "orgId": DEMO_ORG_ID,
            "roomId": DEMO_ROOM_ID,
            "targetUserId": "assistant-limited",
            "changedBy": "lead-instructor",
            "beforePermissions": empty_permissions(),
            "afterPermissions": {
                **empty_permissions(),
                Permission.CAN_CONTROL_PROGRESS.value: True,
                Permission.CAN_ANSWER_QUESTIONS.value: True,
            },
            "changeType": "SEED_CREATED",
        },
    )
    return {
        "organizations": 2,
        "users": len(SEED_ACCOUNTS),
        "courses": 1,
        "rooms": 1,
        "roomJoinCodes": 1,
        "chapters": 1,
        "items": len(item_specs),
        "staff": 1,
    }


def main() -> None:
    result = seed_emulator()
    details = ", ".join(f"{key}={value}" for key, value in result.items())
    print(f"NoDo local Emulator seed complete: {details}")


if __name__ == "__main__":
    main()
