import asyncio
import os
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from firebase_admin import auth
from httpx import ASGITransport, AsyncClient

from app.adapters.firebase_emulator import get_admin_app, get_firestore_client
from app.main import app
from app.scripts.seed_emulator import (
    DEMO_ROOM_ID,
    LOCAL_PASSWORD,
    seed_emulator,
)

pytestmark = pytest.mark.skipif(
    os.getenv("NODO_RUN_EMULATOR_TESTS") != "1",
    reason="Set NODO_RUN_EMULATOR_TESTS=1 with Auth/Firestore Emulators running",
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def sign_in(email: str) -> str:
    response = httpx.post(
        "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/"
        "accounts:signInWithPassword?key=local-demo-api-key",
        json={
            "email": email,
            "password": LOCAL_PASSWORD,
            "returnSecureToken": True,
        },
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["idToken"]


def sign_in_anonymously() -> tuple[str, str]:
    response = httpx.post(
        "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/"
        "accounts:signUp?key=local-demo-api-key",
        json={"returnSecureToken": True},
        timeout=10,
    )
    response.raise_for_status()
    body = response.json()
    return body["idToken"], body["localId"]


def cleanup_student(database: Any, uid: str) -> None:
    room_ref = database.collection("rooms").document(DEMO_ROOM_ID)
    room_ref.collection("participants").document(uid).delete()
    room_ref.collection("questionRateLimits").document(uid).delete()
    database.collection("users").document(uid).delete()
    try:
        auth.delete_user(uid, app=get_admin_app())
    except auth.UserNotFoundError:
        pass


@pytest.mark.anyio
async def test_question_answer_moderation_read_and_participant_restriction() -> None:
    seed_emulator()
    student_token, student_uid = sign_in_anonymously()
    lead_token = sign_in("lead@nodo.test")
    assistant_token = sign_in("assistant.limited@nodo.test")
    database = get_firestore_client()
    student_headers = {"Authorization": f"Bearer {student_token}"}
    lead_headers = {"Authorization": f"Bearer {lead_token}"}
    assistant_headers = {"Authorization": f"Bearer {assistant_token}"}
    room_ref = database.collection("rooms").document(DEMO_ROOM_ID)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            joined = await client.post(
                "/api/rooms/join",
                headers=student_headers,
                json={"roomCode": "NODO01", "nickname": "통합 수강생"},
            )
            assert joined.status_code == 200
            participant_id = joined.json()["participant"]["participantId"]
            assert student_uid not in str(joined.json()["participant"])

            created = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions",
                headers=student_headers,
                json={
                    "content": "핵심 기능을 다시 설명해 주세요",
                    "itemId": "flow-2",
                    "clientRequestId": "lifecycle-item-question-01",
                },
            )
            assert created.status_code == 201
            receipt = created.json()
            question_id = receipt["id"]
            assert receipt == {
                "id": question_id,
                "roomId": DEMO_ROOM_ID,
                "accepted": True,
            }
            question = (
                room_ref.collection("questions")
                .document(question_id)
                .get()
                .to_dict()
                or {}
            )
            assert question["itemTitleSnapshot"] == "핵심 기능 살펴보기"
            assert question["itemNumberSnapshot"] == "1.2"
            assert question["chapterTitleSnapshot"] == "1차시: NoDo 시작"
            assert "participantUid" not in question
            course_items = (
                database.collection("courses")
                .document("demo-course")
                .collection("items")
            )
            course_items.document("flow-1").update({"order": 1})
            course_items.document("flow-2").update({"order": 0})
            preserved = (
                room_ref.collection("questions")
                .document(question_id)
                .get()
                .to_dict()
                or {}
            )
            assert preserved["itemNumberSnapshot"] == "1.2"

            answered = await client.put(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/{question_id}/answer",
                headers=assistant_headers,
                json={"answer": "보조 강사의 공개 답변입니다."},
            )
            assert answered.status_code == 200
            assert answered.json()["answer"]["roomRole"] == "ASSISTANT"
            assert "staffRole" not in answered.json()["answer"]
            denied_hide = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/{question_id}/hide",
                headers=assistant_headers,
            )
            assert denied_hide.status_code == 403

            hidden = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/{question_id}/hide",
                headers=lead_headers,
            )
            restored = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/{question_id}/restore",
                headers=lead_headers,
            )
            assert hidden.json()["isHidden"] is True
            assert restored.json()["isHidden"] is False

            marked_read = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/read",
                headers=assistant_headers,
                json={
                    "contextId": "flow-2",
                    "observedAt": question["createdAt"].isoformat(),
                    "observedQuestionId": question_id,
                },
            )
            assert marked_read.status_code == 200
            returned_read_at = datetime.fromisoformat(
                marked_read.json()["lastReadAt"]
            )
            assert int(returned_read_at.timestamp() * 1000) == int(
                question["createdAt"].timestamp() * 1000
            )
            assert marked_read.json()["lastReadQuestionId"] == question_id

            participants = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}/participants",
                headers=lead_headers,
            )
            assert participants.status_code == 200
            returned = participants.json()["participants"]
            assert returned[0]["participantId"] == participant_id
            assert student_uid not in str(returned)

            restricted = await client.patch(
                f"/api/rooms/{DEMO_ROOM_ID}/participants/{participant_id}",
                headers=lead_headers,
                json={"isQuestionRestricted": True},
            )
            assert restricted.status_code == 200
            blocked = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions",
                headers=student_headers,
                json={
                    "content": "제한 중인 새 질문",
                    "itemId": None,
                    "clientRequestId": "lifecycle-blocked-question-01",
                },
            )
            assert blocked.status_code == 403

            await client.patch(
                f"/api/rooms/{DEMO_ROOM_ID}/participants/{participant_id}",
                headers=lead_headers,
                json={"isQuestionRestricted": False},
            )
            review = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions",
                headers=student_headers,
                json={
                    "content": "이 설명은 바보 같아서 이해가 어려워요",
                    "itemId": None,
                    "clientRequestId": "lifecycle-review-question-01",
                },
            )
            assert review.status_code == 201
            assert review.json() == {
                "id": review.json()["id"],
                "roomId": DEMO_ROOM_ID,
                "accepted": True,
            }
            assert "content" not in review.json()
            assert "moderationStatus" not in review.json()
            approved = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/"
                f"{review.json()['id']}/approve",
                headers=lead_headers,
            )
            assert approved.json()["visibility"] == "PUBLIC"

        read_parent = (
            room_ref.collection("questionReads")
            .document("assistant-limited")
            .get()
        )
        assert read_parent.exists
        public_document = (
            room_ref.collection("questions").document(question_id).get().to_dict()
            or {}
        )
        assert "participantUid" not in public_document
        assert "answererUid" not in str(public_document)
        audit_documents = [
            snapshot.to_dict() or {}
            for snapshot in room_ref.collection("moderationLogs").stream()
        ]
        assert any(log.get("action") == "ANSWER_CREATED" for log in audit_documents)
        assert "핵심 기능을 다시 설명해 주세요" not in str(audit_documents)
        assert "보조 강사의 공개 답변입니다." not in str(audit_documents)
    finally:
        cleanup_student(database, student_uid)
        seed_emulator()


@pytest.mark.anyio
async def test_end_is_idempotent_and_makes_room_read_only_with_report() -> None:
    seed_emulator()
    student_token, student_uid = sign_in_anonymously()
    lead_token = sign_in("lead@nodo.test")
    admin_token = sign_in("admin@nodo.test")
    assistant_token = sign_in("assistant.limited@nodo.test")
    database = get_firestore_client()
    student_headers = {"Authorization": f"Bearer {student_token}"}
    lead_headers = {"Authorization": f"Bearer {lead_token}"}
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    assistant_headers = {"Authorization": f"Bearer {assistant_token}"}

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            joined = await client.post(
                "/api/rooms/join",
                headers=student_headers,
                json={"roomCode": "NODO01", "nickname": "종료 수강생"},
            )
            participant_id = joined.json()["participant"]["participantId"]
            request_body = {
                "content": "종료 전에 남긴 일반 질문",
                "itemId": None,
                "clientRequestId": "lifecycle-before-end-01",
            }
            created = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions",
                headers=student_headers,
                json=request_body,
            )
            assert created.status_code == 201
            general_question = (
                database.collection("rooms")
                .document(DEMO_ROOM_ID)
                .collection("questions")
                .document(created.json()["id"])
                .get()
                .to_dict()
                or {}
            )
            assert general_question["isGeneral"] is True
            assert "itemId" not in general_question
            assert "itemNumberSnapshot" not in general_question

            staff_ref = (
                database.collection("rooms")
                .document(DEMO_ROOM_ID)
                .collection("staff")
                .document("assistant-limited")
            )
            staff = staff_ref.get().to_dict() or {}
            permissions = dict(staff.get("permissions", {}))
            permissions["canEndRoom"] = True
            staff_ref.update({"permissions": permissions})
            preview = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}/end-preview",
                headers=assistant_headers,
            )
            assert preview.status_code == 200
            assert preview.json() == {
                "roomId": DEMO_ROOM_ID,
                "status": "ACTIVE",
                "totalQuestionCount": 1,
                "unansweredQuestionCount": 1,
                "checklistTotalCount": 3,
                "incompleteChecklistCount": 3,
            }

            ended = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/end", headers=lead_headers
            )
            repeated = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/end", headers=lead_headers
            )
            assert ended.status_code == repeated.status_code == 200
            assert ended.json()["room"]["status"] == "ENDED"
            assert repeated.json()["summary"]["totalQuestionCount"] == 1

            recovered_retry = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions",
                headers=student_headers,
                json=request_body,
            )
            denied_new = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions",
                headers=student_headers,
                json={
                    "content": "종료 후 새 질문",
                    "itemId": None,
                    "clientRequestId": "lifecycle-after-end-01",
                },
            )
            denied_answer = await client.put(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/"
                f"{created.json()['id']}/answer",
                headers=lead_headers,
                json={"answer": "종료 후 답변"},
            )
            denied_completion = await client.patch(
                f"/api/rooms/{DEMO_ROOM_ID}/items/flow-1/completion",
                headers=lead_headers,
                json={"isCompleted": True},
            )
            denied_restriction = await client.patch(
                f"/api/rooms/{DEMO_ROOM_ID}/participants/{participant_id}",
                headers=lead_headers,
                json={"isQuestionRestricted": True},
            )
            assert recovered_retry.status_code == 201
            assert denied_new.status_code == 403
            assert denied_answer.status_code == 403
            assert denied_completion.status_code == 403
            assert denied_restriction.status_code == 403

            student_room = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}", headers=student_headers
            )
            student_report = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}/report", headers=student_headers
            )
            assistant_report = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}/report", headers=assistant_headers
            )
            lead_report = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}/report", headers=lead_headers
            )
            admin_report = await client.get(
                f"/api/rooms/{DEMO_ROOM_ID}/report", headers=admin_headers
            )
            assert student_room.status_code == 200
            assert student_report.status_code == 403
            assert assistant_report.status_code == 403
            assert lead_report.status_code == admin_report.status_code == 200
            report = lead_report.json()
            assert report["roomTitle"] == "NoDo 데모 강의"
            assert report["participantCount"] == 1
            assert report["totalQuestionCount"] == 1
            assert report["generalQuestionCount"] == 1
            assert [
                item["itemNumber"] for item in report["itemQuestionCounts"]
            ] == ["1.1", "1.2", "1.3"]
            assert report["unansweredQuestionCount"] == 1
            assert report["checklistTotalCount"] == 3
            assert report["checklistCompletedCount"] == 0
            assert report["exportStatus"] == "NOT_CONFIGURED"
    finally:
        cleanup_student(database, student_uid)
        seed_emulator()


@pytest.mark.anyio
async def test_read_watermark_uses_observed_question_and_monotonic_id_tie() -> None:
    seed_emulator()
    student_token, student_uid = sign_in_anonymously()
    lead_token = sign_in("lead@nodo.test")
    assistant_token = sign_in("assistant.limited@nodo.test")
    database = get_firestore_client()
    student_headers = {"Authorization": f"Bearer {student_token}"}
    lead_headers = {"Authorization": f"Bearer {lead_token}"}
    assistant_headers = {"Authorization": f"Bearer {assistant_token}"}
    room_ref = database.collection("rooms").document(DEMO_ROOM_ID)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            joined = await client.post(
                "/api/rooms/join",
                headers=student_headers,
                json={"roomCode": "NODO01", "nickname": "읽음 수강생"},
            )
            assert joined.status_code == 200
            receipts = []
            for index, content in enumerate(
                ("첫 번째 공개 질문입니다", "두 번째 공개 질문입니다")
            ):
                response = await client.post(
                    f"/api/rooms/{DEMO_ROOM_ID}/questions",
                    headers=student_headers,
                    json={
                        "content": content,
                        "itemId": None,
                        "clientRequestId": f"watermark-public-{index:02d}",
                    },
                )
                assert response.status_code == 201
                assert response.json() == {
                    "id": response.json()["id"],
                    "roomId": DEMO_ROOM_ID,
                    "accepted": True,
                }
                receipts.append(response.json())

            common_created_at = datetime.now(UTC).replace(microsecond=123000)
            for receipt in receipts:
                room_ref.collection("questions").document(receipt["id"]).update(
                    {"createdAt": common_created_at}
                )
            lower_id, higher_id = sorted(receipt["id"] for receipt in receipts)
            first_read = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/read",
                headers=assistant_headers,
                json={
                    "contextId": "ALL",
                    "observedAt": common_created_at.isoformat(),
                    "observedQuestionId": higher_id,
                },
            )
            stale_read = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/read",
                headers=assistant_headers,
                json={
                    "contextId": "ALL",
                    "observedAt": common_created_at.isoformat(),
                    "observedQuestionId": lower_id,
                },
            )
            assert first_read.status_code == stale_read.status_code == 200
            assert stale_read.json()["lastReadQuestionId"] == higher_id

            forged_future = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/read",
                headers=assistant_headers,
                json={
                    "contextId": "ALL",
                    "observedAt": (
                        common_created_at + timedelta(seconds=1)
                    ).isoformat(),
                    "observedQuestionId": higher_id,
                },
            )
            assert forged_future.status_code == 422

            review_receipt = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions",
                headers=student_headers,
                json={
                    "content": "이 설명은 바보 같아서 검토가 필요해요",
                    "itemId": None,
                    "clientRequestId": "watermark-review-01",
                },
            )
            assert review_receipt.status_code == 201
            assert review_receipt.json() == {
                "id": review_receipt.json()["id"],
                "roomId": DEMO_ROOM_ID,
                "accepted": True,
            }
            review_question = (
                room_ref.collection("questions")
                .document(review_receipt.json()["id"])
                .get()
                .to_dict()
                or {}
            )
            assistant_review_read = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/read",
                headers=assistant_headers,
                json={
                    "contextId": "ALL",
                    "observedAt": review_question["createdAt"].isoformat(),
                    "observedQuestionId": review_receipt.json()["id"],
                },
            )
            lead_review_read = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/questions/read",
                headers=lead_headers,
                json={
                    "contextId": "ALL",
                    "observedAt": review_question["createdAt"].isoformat(),
                    "observedQuestionId": review_receipt.json()["id"],
                },
            )
            assert assistant_review_read.status_code == 403
            assert lead_review_read.status_code == 200

        stored_read = (
            room_ref.collection("questionReads")
            .document("assistant-limited")
            .collection("contexts")
            .document("ALL")
            .get()
            .to_dict()
            or {}
        )
        assert stored_read["lastReadAt"] == common_created_at
        assert stored_read["lastReadQuestionId"] == higher_id
    finally:
        cleanup_student(database, student_uid)
        seed_emulator()


@pytest.mark.anyio
async def test_different_finisher_keeps_original_ending_actor() -> None:
    seed_emulator()
    assistant_token = sign_in("assistant.limited@nodo.test")
    database = get_firestore_client()
    room_ref = database.collection("rooms").document(DEMO_ROOM_ID)
    requested_at = datetime.now(UTC)

    try:
        staff_ref = room_ref.collection("staff").document("assistant-limited")
        staff = staff_ref.get().to_dict() or {}
        permissions = dict(staff.get("permissions", {}))
        permissions["canEndRoom"] = True
        staff_ref.update({"permissions": permissions})
        room_ref.update(
            {
                "status": "ENDING",
                "endingAt": requested_at,
                "endingByDisplayName": "김민준",
            }
        )
        termination_ref = room_ref.collection("serverState").document(
            "termination"
        )
        termination_ref.set(
            {
                "id": "termination",
                "roomId": DEMO_ROOM_ID,
                "orgId": "org-nodo",
                "status": "ENDING",
                "actorUid": "lead-instructor",
                "actorDisplayName": "김민준",
                "requestedAt": requested_at,
                "schemaVersion": 1,
            }
        )

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            response = await client.post(
                f"/api/rooms/{DEMO_ROOM_ID}/end",
                headers={"Authorization": f"Bearer {assistant_token}"},
            )

        assert response.status_code == 200
        assert response.json()["summary"]["endedByDisplayName"] == (
            "김민준"
        )
        ended_room = room_ref.get().to_dict() or {}
        termination = termination_ref.get().to_dict() or {}
        audit = (
            room_ref.collection("moderationLogs")
            .document("room-ended")
            .get()
            .to_dict()
            or {}
        )
        assert ended_room["endedByDisplayName"] == "김민준"
        assert termination["actorUid"] == "lead-instructor"
        assert termination["actorDisplayName"] == "김민준"
        assert termination["status"] == "ENDED"
        assert audit["actorUid"] == "lead-instructor"
    finally:
        seed_emulator()


@pytest.mark.emulator_concurrency
@pytest.mark.parametrize("iteration", range(5), ids=lambda value: f"retry-{value + 1}")
@pytest.mark.anyio
async def test_optimistic_idempotent_question_race_repeats_without_500(
    iteration: int,
) -> None:
    seed_emulator()
    student_token, student_uid = sign_in_anonymously()
    database = get_firestore_client()
    headers = {"Authorization": f"Bearer {student_token}"}
    room_ref = database.collection("rooms").document(DEMO_ROOM_ID)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            joined = await client.post(
                "/api/rooms/join",
                headers=headers,
                json={"roomCode": "NODO01", "nickname": "낙관 동시성 수강생"},
            )
            assert joined.status_code == 200
            body = {
                "content": f"낙관 동시성 반복 질문 {iteration + 1}",
                "itemId": "flow-1",
                "clientRequestId": f"optimistic-race-{iteration:02d}",
            }

            async def submit() -> httpx.Response:
                return await client.post(
                    f"/api/rooms/{DEMO_ROOM_ID}/questions",
                    headers=headers,
                    json=body,
                )

            responses = await asyncio.gather(submit(), submit())

        assert [response.status_code for response in responses] == [201, 201]
        assert responses[0].json() == responses[1].json()
        assert responses[0].json() == {
            "id": responses[0].json()["id"],
            "roomId": DEMO_ROOM_ID,
            "accepted": True,
        }
        question_ids = {
            snapshot.id
            for snapshot in room_ref.collection("questions").stream()
        }
        author_ids = {
            snapshot.id
            for snapshot in room_ref.collection("questionAuthors").stream()
        }
        assert question_ids == author_ids == {responses[0].json()["id"]}
    finally:
        cleanup_student(database, student_uid)
        seed_emulator()
