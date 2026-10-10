from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_cloud_room_material_service,
    get_cloud_verified_identity,
    get_student_authenticated_identity,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_room_material_service import RoomMaterialContent
from app.services.student_auth_service import VerifiedStudentIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingRoomMaterialService:
    def __init__(self) -> None:
        self.position_payloads: list[tuple[str, int, int]] = []
        self.access_room_ids: list[str] = []

    def staff_material(self, _identity: object, _room_id: str) -> dict[str, Any]:
        return {"material": None}

    def student_material(
        self, _identity: object, _org_id: str, _room_code: str
    ) -> dict[str, Any]:
        return {"material": None}

    def staff_access(self, _identity: object, room_id: str) -> dict[str, Any]:
        self.access_room_ids.append(room_id)
        return {
            "material": {
                "displayTitle": "자료",
                "fileType": "pdf",
                "totalUnits": 1,
                "currentUnitNumber": 1,
                "materialRevision": 1,
                "canControl": True,
                "canManageDownloadPolicy": True,
                "canViewDownloadPolicy": True,
                "downloadPolicyLocked": False,
                "downloadAllowed": True,
                "downloadEnabled": False,
                "downloadAvailableFrom": None,
                "downloadAvailableUntil": None,
                "downloadPolicyRevision": 1,
            }
        }

    def staff_content(self, _identity: object, _room_id: str) -> RoomMaterialContent:
        return RoomMaterialContent(kind="pdf", data=b"%PDF-private")

    def student_content(
        self, _identity: object, _org_id: str, _room_code: str
    ) -> RoomMaterialContent:
        return RoomMaterialContent(
            kind="pptx",
            data={"unitNumber": 1, "title": "첫 슬라이드", "text": "텍스트"},
        )

    def update_position(
        self, _identity: object, room_id: str, unit_number: int, revision: int
    ) -> dict[str, Any]:
        self.position_payloads.append((room_id, unit_number, revision))
        return {
            "material": {
                "currentUnitNumber": unit_number,
                "materialRevision": revision + 1,
            }
        }


@pytest.fixture
async def client() -> AsyncIterator[tuple[AsyncClient, CapturingRoomMaterialService]]:
    app = create_app()
    service = CapturingRoomMaterialService()
    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity(
            uid="masked-staff",
            email="masked@example.test",
            display_name="강사",
            photo_url=None,
        )
    )
    app.dependency_overrides[get_student_authenticated_identity] = lambda: (
        VerifiedStudentIdentity(uid="masked-student")
    )
    app.dependency_overrides[get_cloud_room_material_service] = lambda: service
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, service
    app.dependency_overrides.clear()


async def test_material_position_contract_is_strict_and_minimal(
    client: tuple[AsyncClient, CapturingRoomMaterialService],
) -> None:
    http, service = client
    response = await http.patch(
        "/api/cloud/rooms/room-1/material-position",
        json={"unitNumber": 2, "expectedMaterialRevision": 4},
    )
    assert response.status_code == 200
    assert service.position_payloads == [("room-1", 2, 4)]
    rejected = await http.patch(
        "/api/cloud/rooms/room-1/material-position",
        json={
            "unitNumber": 2,
            "expectedMaterialRevision": 4,
            "leadInstructorUid": "forbidden",
        },
    )
    assert rejected.status_code == 422
    assert service.position_payloads == [("room-1", 2, 4)]


async def test_material_content_uses_private_responses_with_no_store(
    client: tuple[AsyncClient, CapturingRoomMaterialService],
) -> None:
    http, _ = client
    staff = await http.get("/api/cloud/rooms/room-1/material/content")
    student = await http.get("/api/public/rooms/demo/ABCDEFGH/material/content")
    assert staff.status_code == 200
    assert staff.headers["cache-control"] == "no-store"
    assert staff.content == b"%PDF-private"
    assert student.status_code == 200
    assert student.headers["cache-control"] == "no-store"
    assert student.json() == {"unitNumber": 1, "title": "첫 슬라이드", "text": "텍스트"}


async def test_material_access_uses_the_staff_route_and_returns_policy_contract(
    client: tuple[AsyncClient, CapturingRoomMaterialService],
) -> None:
    http, service = client

    response = await http.get("/api/cloud/rooms/room-1/material-access")

    assert response.status_code == 200
    assert service.access_room_ids == ["room-1"]
    assert response.json()["material"] == {
        "displayTitle": "자료",
        "fileType": "pdf",
        "totalUnits": 1,
        "currentUnitNumber": 1,
        "materialRevision": 1,
        "canControl": True,
        "canManageDownloadPolicy": True,
        "canViewDownloadPolicy": True,
        "downloadPolicyLocked": False,
        "downloadAllowed": True,
        "downloadEnabled": False,
        "downloadAvailableFrom": None,
        "downloadAvailableUntil": None,
        "downloadPolicyRevision": 1,
    }
