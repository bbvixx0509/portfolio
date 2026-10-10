from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_cloud_course_service,
    get_cloud_room_service,
    get_cloud_verified_identity,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingCourseService:
    def list_courses(
        self, _identity: object, *, status: str = "ACTIVE"
    ) -> dict[str, Any]:
        return {"courses": [{"id": "course-1", "title": "C1"}]}


class CapturingRoomService:
    def __init__(self) -> None:
        self.rooms: list[dict[str, Any]] = []

    def list_rooms(self, _identity: object) -> dict[str, Any]:
        return {"rooms": self.rooms}


@pytest.fixture
async def client() -> AsyncIterator[
    tuple[AsyncClient, CapturingCourseService, CapturingRoomService]
]:
    app = create_app()
    courses = CapturingCourseService()
    rooms = CapturingRoomService()
    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity(
            uid="admin-uid",
            email="admin@nodo-company.test",
            display_name="관리자",
            photo_url=None,
        )
    )
    app.dependency_overrides[get_cloud_course_service] = lambda: courses
    app.dependency_overrides[get_cloud_room_service] = lambda: rooms
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, courses, rooms
    app.dependency_overrides.clear()


async def test_latest_accessible_room_prioritizes_live_over_more_recent_ended(
    client: tuple[AsyncClient, CapturingCourseService, CapturingRoomService],
) -> None:
    http, _, rooms = client
    rooms.rooms = [
        {
            "id": "room-ended",
            "status": "ENDED",
            "sourceCourseId": "course-1",
            "updatedAt": "2026-07-26T00:00:00Z",
            "roomCode": "ABC",
            "participants": [],
        },
        {
            "id": "room-live",
            "status": "LIVE",
            "sourceCourseId": "course-1",
            "updatedAt": "2026-07-25T00:00:00Z",
        },
    ]

    response = await http.get("/api/cloud/courses")
    assert response.status_code == 200
    course = response.json()["courses"][0]
    latest = course["latestAccessibleRoom"]
    assert latest["roomId"] == "room-live"
    assert latest["status"] == "LIVE"
    assert "roomCode" not in latest
    assert "participants" not in latest


async def test_latest_accessible_room_prioritizes_ready_over_ended(
    client: tuple[AsyncClient, CapturingCourseService, CapturingRoomService],
) -> None:
    http, _, rooms = client
    rooms.rooms = [
        {
            "id": "room-ended",
            "status": "ENDED",
            "sourceCourseId": "course-1",
            "updatedAt": "2026-07-26T00:00:00Z",
        },
        {
            "id": "room-ready",
            "status": "READY",
            "sourceCourseId": "course-1",
            "updatedAt": "2026-07-25T00:00:00Z",
        },
    ]

    response = await http.get("/api/cloud/courses")
    assert response.status_code == 200
    course = response.json()["courses"][0]
    assert course["latestAccessibleRoom"]["roomId"] == "room-ready"
    assert course["latestAccessibleRoom"]["status"] == "READY"


async def test_latest_accessible_room_prioritizes_future_download_over_past_download(
    client: tuple[AsyncClient, CapturingCourseService, CapturingRoomService],
) -> None:
    http, _, rooms = client
    rooms.rooms = [
        {
            "id": "room-past",
            "status": "ENDED",
            "sourceCourseId": "course-1",
            "downloadAvailableUntil": "2000-01-01T00:00:00Z",
            "updatedAt": "2026-07-27T00:00:00Z",
        },
        {
            "id": "room-future",
            "status": "ENDED",
            "sourceCourseId": "course-1",
            "downloadAvailableUntil": "2999-01-01T00:00:00Z",
            "updatedAt": "2026-07-26T00:00:00Z",
        },
        {
            "id": "room-no-date",
            "status": "ENDED",
            "sourceCourseId": "course-1",
            "updatedAt": "2026-07-28T00:00:00Z",
        },
    ]

    response = await http.get("/api/cloud/courses")
    assert response.status_code == 200
    course = response.json()["courses"][0]
    assert course["latestAccessibleRoom"]["roomId"] == "room-future"


async def test_latest_accessible_room_excludes_sensitive_info(
    client: tuple[AsyncClient, CapturingCourseService, CapturingRoomService],
) -> None:
    http, _, rooms = client
    rooms.rooms = [
        {
            "id": "room-secret",
            "status": "LIVE",
            "sourceCourseId": "course-1",
            "roomCode": "SECRET123",
            "uid": "creator-uid",
            "email": "user@nodo-company.test",
            "students": ["a", "b"],
            "participants": ["x", "y"],
            "token": "sensitive-token",
            "storagePath": "/some/path",
            "questions": ["Q1"],
            "downloadAvailableUntil": "2026-07-26T00:00:00Z",
            "endedAt": "2026-07-25T00:00:00Z",
        },
    ]

    response = await http.get("/api/cloud/courses")
    assert response.status_code == 200
    course = response.json()["courses"][0]
    latest = course["latestAccessibleRoom"]

    assert latest == {
        "roomId": "room-secret",
        "status": "LIVE",
        "downloadAvailableUntil": "2026-07-26T00:00:00Z",
        "endedAt": "2026-07-25T00:00:00Z",
    }
