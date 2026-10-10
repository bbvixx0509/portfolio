import os
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from firebase_admin import auth, firestore
from httpx import ASGITransport, AsyncClient

from app.adapters.firebase_emulator import get_admin_app, get_firestore_client
from app.main import app
from app.scripts.seed_emulator import LOCAL_PASSWORD

pytestmark = pytest.mark.skipif(
    os.getenv("NODO_RUN_EMULATOR_TESTS") != "1",
    reason="Set NODO_RUN_EMULATOR_TESTS=1 with Auth/Firestore Emulators running",
)

ORG_ID = "demo"
ROOM_ID = "student-participant-02-7a"
ROOM_CODE = "ABCDEFGH"
EXPIRATION_ROOM_ID = "student-participant-02-11h"
EXPIRATION_ROOM_CODE = "HJKLMNPQ"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


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


def sign_in_staff() -> str:
    response = httpx.post(
        "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/"
        "accounts:signInWithPassword?key=local-demo-api-key",
        json={
            "email": "lead@nodo.test",
            "password": LOCAL_PASSWORD,
            "returnSecureToken": True,
        },
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["idToken"]


def create_public_room_fixture(
    *,
    room_id: str = ROOM_ID,
    room_code: str = ROOM_CODE,
    max_active_participants: int = 1,
) -> None:
    database = get_firestore_client()
    room = (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("rooms")
        .document(room_id)
    )
    room.set(
        {
            "id": room_id,
            "orgId": ORG_ID,
            "roomCode": room_code,
            "status": "READY",
            "title": "익명 수강생 Emulator 테스트",
            "maxActiveParticipants": max_active_participants,
            "createdAt": firestore.SERVER_TIMESTAMP,
        }
    )
    (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("roomCodes")
        .document(room_code)
        .set(
            {
                "roomId": room_id,
                "status": "READY",
                "createdAt": firestore.SERVER_TIMESTAMP,
            }
        )
    )


def cleanup_public_room_fixture(
    uids: list[str], *, room_id: str = ROOM_ID, room_code: str = ROOM_CODE
) -> None:
    database = get_firestore_client()
    room = (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("rooms")
        .document(room_id)
    )
    for participant in room.collection("participants").stream():
        participant.reference.delete()
    room.delete()
    (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("roomCodes")
        .document(room_code)
        .delete()
    )
    audit_logs = (
        database.collection("organizations").document(ORG_ID).collection("auditLogs")
    )
    for audit in audit_logs.stream():
        if (audit.to_dict() or {}).get("roomId") == room_id:
            audit.reference.delete()
    for uid in uids:
        auth.delete_user(uid, app=get_admin_app())


@pytest.mark.anyio
async def test_anonymous_participant_flow_uses_local_emulator() -> None:
    create_public_room_fixture()
    first_token, first_uid = sign_in_anonymously()
    second_token, second_uid = sign_in_anonymously()
    overflow_token, overflow_uid = sign_in_anonymously()
    staff_token = sign_in_staff()
    database = get_firestore_client()
    participant_ref = (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("rooms")
        .document(ROOM_ID)
        .collection("participants")
        .document(first_uid)
    )

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            public = await client.get(f"/api/public/rooms/{ORG_ID}/{ROOM_CODE}")
            joined = await client.post(
                f"/api/public/rooms/{ORG_ID}/{ROOM_CODE}/participants",
                headers={"Authorization": f"Bearer {first_token}"},
                json={"nickname": "  맑은 구름  "},
            )
            reentered = await client.post(
                f"/api/public/rooms/{ORG_ID}/{ROOM_CODE}/participants",
                headers={"Authorization": f"Bearer {first_token}"},
                json={"nickname": "푸른 바람"},
            )
            heartbeat = await client.post(
                f"/api/public/rooms/{ORG_ID}/{ROOM_CODE}/heartbeat",
                headers={"Authorization": f"Bearer {first_token}"},
            )
            left = await client.post(
                f"/api/public/rooms/{ORG_ID}/{ROOM_CODE}/leave",
                headers={"Authorization": f"Bearer {first_token}"},
            )
            reactivated = await client.post(
                f"/api/public/rooms/{ORG_ID}/{ROOM_CODE}/participants",
                headers={"Authorization": f"Bearer {first_token}"},
                json={"nickname": "푸른 바람"},
            )
            duplicate = await client.post(
                f"/api/public/rooms/{ORG_ID}/{ROOM_CODE}/participants",
                headers={"Authorization": f"Bearer {second_token}"},
                json={"nickname": "푸른 바람"},
            )
            overflow = await client.post(
                f"/api/public/rooms/{ORG_ID}/{ROOM_CODE}/participants",
                headers={"Authorization": f"Bearer {overflow_token}"},
                json={"nickname": "정원 초과"},
            )
            staff = await client.post(
                f"/api/public/rooms/{ORG_ID}/{ROOM_CODE}/participants",
                headers={"Authorization": f"Bearer {staff_token}"},
                json={"nickname": "강사 이름"},
            )

        assert public.json() == {
            "title": "익명 수강생 Emulator 테스트",
            "status": "READY",
            "joinAllowed": True,
        }
        assert joined.status_code == 200
        assert reentered.status_code == 200
        assert heartbeat.json() == {"presenceStatus": "ACTIVE"}
        assert left.json() == {"left": True}
        assert reactivated.status_code == 200
        assert duplicate.status_code == 409
        assert overflow.status_code == 409
        assert staff.status_code == 403
        assert not (
            database.collection("organizations")
            .document(ORG_ID)
            .collection("rooms")
            .document(ROOM_ID)
            .collection("participants")
            .document(overflow_uid)
            .get()
            .exists
        )
        participant = participant_ref.get().to_dict() or {}
        assert set(participant) == {
            "nickname",
            "nicknameNormalized",
            "joinedAt",
            "lastSeenAt",
            "leaseExpiresAt",
            "leftAt",
            "participantStatus",
            "presenceStatus",
            "isAnonymous",
        }
        assert participant["nickname"] == "푸른 바람"
        assert participant["presenceStatus"] == "ACTIVE"
        capacity = (
            database.collection("organizations")
            .document(ORG_ID)
            .collection("rooms")
            .document(ROOM_ID)
            .collection("presence")
            .document("capacity")
            .get()
            .to_dict()
            or {}
        )
        assert capacity["activeParticipantCount"] == 1
        assert capacity["capacityAlertStatus"] == "PENDING"
        assert first_uid not in joined.text
        assert first_token not in joined.text
        audits = [
            snapshot.to_dict() or {}
            for snapshot in database.collection("organizations")
            .document(ORG_ID)
            .collection("auditLogs")
            .stream()
            if (snapshot.to_dict() or {}).get("roomId") == ROOM_ID
        ]
        assert [audit.get("eventType") for audit in audits].count(
            "PARTICIPANT_JOINED"
        ) == 1
        assert [audit.get("eventType") for audit in audits].count(
            "PARTICIPANT_LEFT"
        ) == 1
        assert [audit.get("eventType") for audit in audits].count(
            "PARTICIPANT_REJOINED"
        ) == 1
        assert [audit.get("eventType") for audit in audits].count(
            "CAPACITY_ALERT_RAISED"
        ) == 1
        for audit in audits:
            assert first_uid not in str(audit)
            assert first_token not in str(audit)
    finally:
        cleanup_public_room_fixture([first_uid, second_uid, overflow_uid])


@pytest.mark.anyio
async def test_active_heartbeat_expires_another_participant_and_persists_capacity(
) -> None:
    create_public_room_fixture(
        room_id=EXPIRATION_ROOM_ID,
        room_code=EXPIRATION_ROOM_CODE,
        max_active_participants=2,
    )
    first_token, first_uid = sign_in_anonymously()
    second_token, second_uid = sign_in_anonymously()
    database = get_firestore_client()
    room = (
        database.collection("organizations")
        .document(ORG_ID)
        .collection("rooms")
        .document(EXPIRATION_ROOM_ID)
    )
    second_participant = room.collection("participants").document(second_uid)

    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            first_join = await client.post(
                f"/api/public/rooms/{ORG_ID}/{EXPIRATION_ROOM_CODE}/participants",
                headers={"Authorization": f"Bearer {first_token}"},
                json={"nickname": "맑은 구름"},
            )
            second_join = await client.post(
                f"/api/public/rooms/{ORG_ID}/{EXPIRATION_ROOM_CODE}/participants",
                headers={"Authorization": f"Bearer {second_token}"},
                json={"nickname": "푸른 바람"},
            )
            assert first_join.status_code == 200
            assert second_join.status_code == 200

            second_participant.update(
                {
                    "leaseExpiresAt": datetime.now(UTC) - timedelta(seconds=1),
                    "presenceStatus": "ACTIVE",
                }
            )
            first_heartbeat = await client.post(
                f"/api/public/rooms/{ORG_ID}/{EXPIRATION_ROOM_CODE}/heartbeat",
                headers={"Authorization": f"Bearer {first_token}"},
            )
            after_expiration_capacity = (
                room.collection("presence").document("capacity").get().to_dict()
                or {}
            )
            assert first_heartbeat.json() == {"presenceStatus": "ACTIVE"}
            assert after_expiration_capacity["activeParticipantCount"] == 1
            expired_participant = second_participant.get().to_dict() or {}
            assert expired_participant["presenceStatus"] == "EXPIRED"
            second_heartbeat = await client.post(
                f"/api/public/rooms/{ORG_ID}/{EXPIRATION_ROOM_CODE}/heartbeat",
                headers={"Authorization": f"Bearer {first_token}"},
            )
            first_leave = await client.post(
                f"/api/public/rooms/{ORG_ID}/{EXPIRATION_ROOM_CODE}/leave",
                headers={"Authorization": f"Bearer {first_token}"},
            )
            rejoined = await client.post(
                f"/api/public/rooms/{ORG_ID}/{EXPIRATION_ROOM_CODE}/participants",
                headers={"Authorization": f"Bearer {second_token}"},
                json={"nickname": "푸른 바람"},
            )

        assert second_heartbeat.json() == {"presenceStatus": "ACTIVE"}
        assert first_leave.json() == {"left": True}
        assert rejoined.status_code == 200
        capacity = (
            room.collection("presence").document("capacity").get().to_dict() or {}
        )
        assert capacity["activeParticipantCount"] == 1
        assert (second_participant.get().to_dict() or {})["presenceStatus"] == "ACTIVE"
        audits = [
            snapshot.to_dict() or {}
            for snapshot in database.collection("organizations")
            .document(ORG_ID)
            .collection("auditLogs")
            .stream()
            if (snapshot.to_dict() or {}).get("roomId") == EXPIRATION_ROOM_ID
        ]
        assert [audit.get("eventType") for audit in audits].count(
            "PARTICIPANT_EXPIRED"
        ) == 1
        assert [audit.get("eventType") for audit in audits].count(
            "PARTICIPANT_REJOINED"
        ) == 1
    finally:
        cleanup_public_room_fixture(
            [first_uid, second_uid],
            room_id=EXPIRATION_ROOM_ID,
            room_code=EXPIRATION_ROOM_CODE,
        )
