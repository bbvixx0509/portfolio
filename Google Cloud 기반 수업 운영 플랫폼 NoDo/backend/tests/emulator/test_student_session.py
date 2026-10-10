import os

import httpx
import pytest
from firebase_admin import auth
from httpx import ASGITransport, AsyncClient

from app.adapters.firebase_emulator import get_admin_app, get_firestore_client
from app.main import app
from app.scripts.seed_emulator import DEMO_ROOM_ID, LOCAL_PASSWORD

pytestmark = pytest.mark.skipif(
    os.getenv("NODO_RUN_EMULATOR_TESTS") != "1",
    reason="Set NODO_RUN_EMULATOR_TESTS=1 with Auth/Firestore Emulators running",
)


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


@pytest.mark.anyio
async def test_anonymous_student_session_is_auth_only_and_writes_no_data() -> None:
    token, uid = sign_in_anonymously()
    database = get_firestore_client()
    user_ref = database.collection("users").document(uid)
    participant_ref = (
        database.collection("rooms")
        .document(DEMO_ROOM_ID)
        .collection("participants")
        .document(uid)
    )

    try:
        assert not user_ref.get().exists
        assert not participant_ref.get().exists
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            response = await client.post(
                "/api/auth/student-session",
                headers={"Authorization": f"Bearer {token}"},
                json={"nickname": "  맑은 구름  ", "roomCode": "TEST123"},
            )

        assert response.status_code == 200
        assert response.json() == {
            "accountType": "STUDENT",
            "isAnonymous": True,
            "identityVerified": True,
            "provider": "anonymous",
            "scope": "AUTH_ONLY",
            "roomAuthorized": False,
            "nickname": "맑은 구름",
            "roomCode": "TEST123",
        }
        assert not user_ref.get().exists
        assert not participant_ref.get().exists
        assert uid not in response.text
        assert token not in response.text
    finally:
        auth.delete_user(uid, app=get_admin_app())


@pytest.mark.anyio
async def test_staff_emulator_token_is_rejected_by_student_session() -> None:
    token = sign_in_staff()

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/api/auth/student-session",
            headers={"Authorization": f"Bearer {token}"},
            json={"nickname": "맑은 구름", "roomCode": "TEST123"},
        )

    assert response.status_code == 403
    assert response.json()["code"] == "access_denied"
