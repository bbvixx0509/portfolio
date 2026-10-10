from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_student_authenticated_identity,
    get_student_participant_service,
)
from app.main import create_app
from app.services.student_auth_service import VerifiedStudentIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingStudentParticipantService:
    def __init__(self) -> None:
        self.join_calls: list[tuple[str, str, str, str]] = []
        self.heartbeat_calls: list[tuple[str, str, str]] = []
        self.leave_calls: list[tuple[str, str, str]] = []

    def public_room(self, org_id: str, room_code: str) -> dict[str, Any]:
        assert (org_id, room_code) == ("demo", "ABCDEFGH")
        return {"title": "공개 강의방", "status": "READY", "joinAllowed": True}

    def join(
        self,
        identity: VerifiedStudentIdentity,
        org_id: str,
        room_code: str,
        nickname: str,
    ) -> dict[str, Any]:
        self.join_calls.append((identity.uid, org_id, room_code, nickname))
        return {
            "nickname": nickname,
            "roomTitle": "공개 강의방",
            "roomStatus": "READY",
            "participantStatus": "JOINED",
        }

    def session(
        self, _identity: VerifiedStudentIdentity, _org_id: str, _room_code: str
    ) -> dict[str, Any]:
        return {
            "nickname": "맑은 구름",
            "roomTitle": "공개 강의방",
            "roomStatus": "READY",
            "participantStatus": "JOINED",
        }

    def heartbeat(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> dict[str, str]:
        self.heartbeat_calls.append((identity.uid, org_id, room_code))
        return {"presenceStatus": "ACTIVE"}

    def leave(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> dict[str, bool]:
        self.leave_calls.append((identity.uid, org_id, room_code))
        return {"left": True}


@pytest.fixture
async def client() -> AsyncIterator[
    tuple[AsyncClient, CapturingStudentParticipantService]
]:
    app = create_app()
    service = CapturingStudentParticipantService()
    app.dependency_overrides[get_student_authenticated_identity] = lambda: (
        VerifiedStudentIdentity(uid="masked-anonymous")
    )
    app.dependency_overrides[get_student_participant_service] = lambda: service
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, service
    app.dependency_overrides.clear()


async def test_public_room_uses_no_token_and_returns_minimum_contract(
    client: tuple[AsyncClient, CapturingStudentParticipantService],
) -> None:
    http, _service = client
    response = await http.get("/api/public/rooms/demo/ABCDEFGH")

    assert response.status_code == 200
    assert response.json() == {
        "title": "공개 강의방",
        "status": "READY",
        "joinAllowed": True,
    }


async def test_participant_join_accepts_only_nickname_and_does_not_echo_uid(
    client: tuple[AsyncClient, CapturingStudentParticipantService],
) -> None:
    http, service = client
    response = await http.post(
        "/api/public/rooms/demo/ABCDEFGH/participants",
        json={"nickname": "  맑은 구름  "},
    )

    assert response.status_code == 200
    assert service.join_calls == [("masked-anonymous", "demo", "ABCDEFGH", "맑은 구름")]
    assert response.json()["nickname"] == "맑은 구름"
    assert "masked-anonymous" not in response.text


@pytest.mark.parametrize("field", ["orgId", "roomId", "uid", "role", "isAnonymous"])
async def test_participant_join_rejects_server_owned_body_fields(
    client: tuple[AsyncClient, CapturingStudentParticipantService], field: str
) -> None:
    http, service = client
    response = await http.post(
        "/api/public/rooms/demo/ABCDEFGH/participants",
        json={"nickname": "맑은 구름", field: "untrusted"},
    )

    assert response.status_code == 422
    assert service.join_calls == []


async def test_participant_session_requires_anonymous_auth_when_not_overridden(
) -> None:
    app = create_app()
    app.dependency_overrides[get_student_participant_service] = (
        CapturingStudentParticipantService
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.get("/api/public/rooms/demo/ABCDEFGH/session")
    app.dependency_overrides.clear()

    assert response.status_code == 401


async def test_presence_routes_accept_no_client_time_or_identity_fields(
    client: tuple[AsyncClient, CapturingStudentParticipantService],
) -> None:
    http, service = client

    heartbeat = await http.post("/api/public/rooms/demo/ABCDEFGH/heartbeat")
    leave = await http.post("/api/public/rooms/demo/ABCDEFGH/leave")

    assert heartbeat.json() == {"presenceStatus": "ACTIVE"}
    assert leave.json() == {"left": True}
    assert service.heartbeat_calls == [("masked-anonymous", "demo", "ABCDEFGH")]
    assert service.leave_calls == [("masked-anonymous", "demo", "ABCDEFGH")]
