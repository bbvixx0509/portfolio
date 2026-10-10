import os
from typing import Any

import pytest
from firebase_admin import firestore

from app.adapters.firebase_cloud_firestore import FirestoreCloudQuestionRepository
from app.adapters.firebase_emulator import get_firestore_client
from app.core.config import EMULATOR_RUNTIME_MODE, Settings
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_question_service import CloudQuestionService
from app.services.student_auth_service import VerifiedStudentIdentity

pytestmark = pytest.mark.skipif(
    os.getenv("NODO_RUN_EMULATOR_TESTS") != "1",
    reason="Set NODO_RUN_EMULATOR_TESTS=1 with Auth/Firestore Emulators running",
)

ORG_ID = "demo"
ROOM_ID = "cloud-room-questions-02-9a"
ROOM_CODE = "QSTN9ABC"
LEAD_UID = "cloud-question-lead-02-9a"
STUDENT_UID = "cloud-question-student-02-9a"


def runtime_settings() -> Settings:
    return Settings(
        runtime_mode=EMULATOR_RUNTIME_MODE,
        app_env="test",
        firebase_project_id="demo-nodo",
        bootstrap_org_id=ORG_ID,
    )


def create_fixture() -> CloudQuestionService:
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
    room.set(
        {
            "id": ROOM_ID,
            "orgId": ORG_ID,
            "schemaVersion": 1,
            "title": "질문 Emulator 강의방",
            "status": "LIVE",
            "roomCode": ROOM_CODE,
            "leadInstructorUid": LEAD_UID,
            "instructorMemberUids": [LEAD_UID],
            "revision": 1,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
    )
    (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("roomCodes")
        .document(ROOM_CODE)
        .set({"roomId": ROOM_ID, "status": "LIVE"})
    )
    room.collection("participants").document(STUDENT_UID).set(
        {
            "nickname": "차분한 연필",
            "nicknameNormalized": "차분한연필",
            "participantStatus": "JOINED",
            "isAnonymous": True,
        }
    )
    for position, item_id in enumerate(("item-1", "item-2")):
        room.collection("flowItems").document(item_id).set(
            {
                "chapterId": "chapter-1",
                "chapterTitle": "질문 챕터",
                "chapterPosition": 0,
                "itemId": item_id,
                "itemTitle": f"항목 {position + 1}",
                "itemDescription": "Emulator 항목",
                "itemPosition": position,
                "isCompleted": False,
            }
        )
    settings = runtime_settings()
    return CloudQuestionService(
        FirestoreCloudQuestionRepository.from_emulator_settings(settings), settings
    )


def delete_collection(parent: Any, name: str) -> None:
    collection = parent.collection(name)
    for snapshot in collection.stream():
        for nested in snapshot.reference.collections():
            delete_collection(snapshot.reference, nested.id)
        snapshot.reference.delete()


def cleanup_fixture() -> None:
    database = get_firestore_client()
    room = (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("rooms")
        .document(ROOM_ID)
    )
    for collection_name in (
        "flowItems",
        "participants",
        "questions",
        "questionAuthors",
        "questionReads",
    ):
        delete_collection(room, collection_name)
    room.delete()
    (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("roomCodes")
        .document(ROOM_CODE)
        .delete()
    )
    database.collection("users").document(LEAD_UID).delete()
    audits = (
        database.collection("organizations").document(ORG_ID).collection("auditLogs")
    )
    for snapshot in audits.stream():
        if (snapshot.to_dict() or {}).get("roomId") == ROOM_ID:
            snapshot.reference.delete()


def test_cloud_question_transactions_use_only_local_firestore_emulator() -> None:
    service = create_fixture()
    lead = VerifiedCloudIdentity(LEAD_UID, "masked@example.test", "강사", None)
    student = VerifiedStudentIdentity(STUDENT_UID)
    database = get_firestore_client()

    try:
        general = service.create_student_question(
            student,
            ORG_ID,
            ROOM_CODE,
            {
                "content": "일반 질문입니다.",
                "itemId": None,
                "clientRequestId": "emulator-question-0001",
            },
        )
        item = service.create_student_question(
            student,
            ORG_ID,
            ROOM_CODE,
            {
                "content": "두 번째 항목을 다시 설명해 주세요.",
                "itemId": "item-2",
                "clientRequestId": "emulator-question-0002",
            },
        )
        answered = service.answer_question(
            lead, ROOM_ID, item["id"], "두 번째 항목부터 다시 살펴보겠습니다."
        )
        read = service.mark_read(lead, ROOM_ID, "ITEM:item-2", item["id"])
        service.set_hidden(lead, ROOM_ID, general["id"], hidden=True)

        assert answered["answer"]["roomRole"] == "LEAD"
        assert read["marked"] is True
        student_questions = service.student_questions(student, ORG_ID, ROOM_CODE)
        assert [question["id"] for question in student_questions["questions"]] == [
            item["id"]
        ]
        public_question = (
            database.collection("organizations")
            .document(ORG_ID)
            .collection("rooms")
            .document(ROOM_ID)
            .collection("questions")
            .document(item["id"])
            .get()
            .to_dict()
            or {}
        )
        assert public_question["itemNumberSnapshot"] == "1.2"
        assert "authorUid" not in public_question
        author = (
            database.collection("organizations")
            .document(ORG_ID)
            .collection("rooms")
            .document(ROOM_ID)
            .collection("questionAuthors")
            .document(item["id"])
            .get()
            .to_dict()
            or {}
        )
        assert author["authorUid"] == STUDENT_UID
        read_audits = [
            snapshot.to_dict() or {}
            for snapshot in database.collection("organizations")
            .document(ORG_ID)
            .collection("auditLogs")
            .stream()
            if (snapshot.to_dict() or {}).get("eventType") == "QUESTION_READ"
        ]
        assert len(read_audits) == 1
        assert set(read_audits[0]) == {
            "eventType",
            "orgId",
            "roomId",
            "contextId",
            "observedQuestionId",
            "actorUid",
            "createdAt",
            "schemaVersion",
        }
        assert "content" not in read_audits[0] and "email" not in read_audits[0]
        assert (
            database.collection("organizations")
            .document(ORG_ID)
            .collection("rooms")
            .document(ROOM_ID)
            .collection("flowItems")
            .document("item-1")
            .get()
            .to_dict()["isCompleted"]
            is False
        )
        assert (
            database.collection("organizations")
            .document(ORG_ID)
            .collection("rooms")
            .document(ROOM_ID)
            .collection("participants")
            .document(STUDENT_UID)
            .get()
            .to_dict()["nickname"]
            == "차분한 연필"
        )
    finally:
        cleanup_fixture()
