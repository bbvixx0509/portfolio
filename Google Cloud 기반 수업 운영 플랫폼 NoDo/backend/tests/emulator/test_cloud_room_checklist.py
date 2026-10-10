import os

import pytest
from firebase_admin import firestore

from app.adapters.firebase_cloud_firestore import FirestoreCloudRoomRepository
from app.adapters.firebase_emulator import get_firestore_client
from app.core.config import EMULATOR_RUNTIME_MODE, Settings
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_room_service import CloudRoomService

pytestmark = pytest.mark.skipif(
    os.getenv("NODO_RUN_EMULATOR_TESTS") != "1",
    reason="Set NODO_RUN_EMULATOR_TESTS=1 with Auth/Firestore Emulators running",
)

ORG_ID = "demo"
ROOM_ID = "cloud-room-checklist-02-8a"
LEAD_UID = "cloud-room-checklist-lead-02-8a"
ASSISTANT_UID = "cloud-room-checklist-assistant-02-12a"


def emulator_settings() -> Settings:
    return Settings(
        runtime_mode=EMULATOR_RUNTIME_MODE,
        app_env="test",
        firebase_project_id="demo-nodo",
        bootstrap_org_id=ORG_ID,
    )


def create_fixture() -> CloudRoomService:
    database = get_firestore_client()
    room = (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("rooms")
        .document(ROOM_ID)
    )
    database.collection("users").document(LEAD_UID).set(
        {
            "uid": LEAD_UID,
            "orgId": ORG_ID,
            "accountType": "STAFF",
            "organizationRole": "INSTRUCTOR",
            "organizationRoleRevision": 1,
        }
    )
    database.collection("users").document(ASSISTANT_UID).set(
        {
            "uid": ASSISTANT_UID,
            "orgId": ORG_ID,
            "accountType": "STAFF",
            "organizationRole": "INSTRUCTOR",
            "organizationRoleRevision": 1,
        }
    )
    room.set(
        {
            "id": ROOM_ID,
            "orgId": ORG_ID,
            "schemaVersion": 1,
            "title": "체크리스트 Emulator 강의방",
            "status": "READY",
            "roomCode": "CDEFGHJK",
            "sourceCourseId": "course-02-8a",
            "sourceCourseRevision": 1,
            "sourceCourseTitle": "체크리스트 원본 수업",
            "roomCreatorUid": LEAD_UID,
            "leadInstructorUid": LEAD_UID,
            "instructorMemberUids": [LEAD_UID],
            "roomInstructors": [
                {
                    "uid": LEAD_UID,
                    "role": "LEAD",
                    "permissions": {
                        "questionOperations": True,
                        "checklistProgress": True,
                        "capacityOperations": True,
                    },
                    "displayNameSnapshot": "강사",
                }
            ],
            "revision": 1,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
    )
    for position, item_id in enumerate(("item-1", "item-2")):
        room.collection("flowItems").document(item_id).set(
            {
                "chapterId": "chapter-1",
                "chapterTitle": "진행 챕터",
                "chapterPosition": 0,
                "itemId": item_id,
                "itemTitle": f"항목 {position + 1}",
                "itemDescription": "로컬 Emulator 검증",
                "itemPosition": position,
                "isCompleted": False,
            }
        )
    runtime_settings = emulator_settings()
    return CloudRoomService(
        FirestoreCloudRoomRepository.from_emulator_settings(runtime_settings),
        runtime_settings,
    )


def cleanup_fixture() -> None:
    database = get_firestore_client()
    room = (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("rooms")
        .document(ROOM_ID)
    )
    for item in room.collection("flowItems").stream():
        item.reference.delete()
    room.delete()
    database.collection("users").document(LEAD_UID).delete()
    database.collection("users").document(ASSISTANT_UID).delete()
    audits = (
        database.collection("organizations").document(ORG_ID).collection("auditLogs")
    )
    for audit in audits.stream():
        if (audit.to_dict() or {}).get("roomId") == ROOM_ID:
            audit.reference.delete()


def test_cloud_room_checklist_transaction_uses_local_firestore_emulator() -> None:
    service = create_fixture()
    identity = VerifiedCloudIdentity(
        uid=LEAD_UID,
        email="masked@example.test",
        display_name="강사",
        photo_url=None,
    )

    try:
        live = service.start_room(identity, ROOM_ID, 1)
        after_first = service.complete_checklist_item(identity, ROOM_ID, "item-1", 2)
        rewound = service.undo_checklist_item(identity, ROOM_ID, "item-1", 3)

        assert live["status"] == "LIVE"
        assert live["currentItemId"] == "item-1"
        assert after_first["currentItemId"] == "item-2"
        assert rewound["revision"] == 4
        assert [item["isCompleted"] for item in rewound["flowItems"]] == [False, False]
        events = {
            snapshot.to_dict()["eventType"]
            for snapshot in get_firestore_client()
            .collection("organizations")
            .document(ORG_ID)
            .collection("auditLogs")
            .stream()
            if (snapshot.to_dict() or {}).get("roomId") == ROOM_ID
        }
        assert {
            "ROOM_STARTED",
            "CHECKLIST_ITEM_COMPLETED",
            "CHECKLIST_REWOUND",
        } <= events
    finally:
        cleanup_fixture()


def test_cloud_room_instructor_changes_use_the_same_firestore_transaction() -> None:
    service = create_fixture()
    lead = VerifiedCloudIdentity(
        uid=LEAD_UID,
        email="masked@example.test",
        display_name="강사",
        photo_url=None,
    )

    try:
        invited = service.add_assistant(lead, ROOM_ID, ASSISTANT_UID, 1)
        granted = service.grant_assistant_full_access(
            lead, ROOM_ID, ASSISTANT_UID, invited["revision"]
        )
        transferred = service.transfer_lead(
            lead, ROOM_ID, ASSISTANT_UID, granted["revision"]
        )

        stored = (
            get_firestore_client()
            .collection("organizations")
            .document(ORG_ID)
            .collection("rooms")
            .document(ROOM_ID)
            .get()
            .to_dict()
            or {}
        )
        assignments = stored.get("roomInstructors", [])
        assert stored.get("roomCreatorUid") == LEAD_UID
        assert stored.get("leadInstructorUid") == ASSISTANT_UID
        assert sum(item.get("role") == "LEAD" for item in assignments) == 1
        assert transferred["currentRole"] == "ASSISTANT"
        events = [
            snapshot.to_dict() or {}
            for snapshot in get_firestore_client()
            .collection("organizations")
            .document(ORG_ID)
            .collection("auditLogs")
            .stream()
            if (snapshot.to_dict() or {}).get("roomId") == ROOM_ID
        ]
        assert {
            "ROOM_ASSISTANT_ADDED",
            "ROOM_ASSISTANT_FULL_ACCESS_GRANTED",
            "ROOM_LEAD_TRANSFERRED",
        } <= {event.get("eventType") for event in events}
        assert all("email" not in event and "token" not in event for event in events)
    finally:
        cleanup_fixture()
