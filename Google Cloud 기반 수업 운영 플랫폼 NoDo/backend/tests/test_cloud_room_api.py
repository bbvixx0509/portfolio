from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import get_cloud_room_service, get_cloud_verified_identity
from app.domain.schemas import (
    CloudRoomAssistantPermissions,
    CloudRoomAssistantTarget,
    CloudRoomCreate,
    CloudRoomRevisionInput,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity

pytestmark = pytest.mark.anyio

type InstructorAction = tuple[
    str, str, str, int, dict[str, bool] | None
]


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingRoomService:
    def __init__(self) -> None:
        self.creates: list[dict[str, Any]] = []
        self.read_ids: list[str] = []
        self.share_ids: list[str] = []
        self.checklist_ids: list[str] = []
        self.starts: list[tuple[str, int]] = []
        self.reopens: list[tuple[str, int]] = []
        self.completions: list[tuple[str, str, int]] = []
        self.undos: list[tuple[str, str, int]] = []
        self.instructor_actions: list[InstructorAction] = []
        self.listed = False
        self.list_identities: list[VerifiedCloudIdentity] = []

    def create_room(self, _identity: object, payload: dict[str, Any]) -> dict[str, Any]:
        self.creates.append(payload)
        return {"id": "room-1", **payload, "roomCode": "ABCDEFGH"}

    def list_rooms(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        self.listed = True
        self.list_identities.append(identity)
        return {"rooms": []}

    def get_room(self, _identity: object, room_id: str) -> dict[str, Any]:
        self.read_ids.append(room_id)
        return {"id": room_id, "title": "강의방", "roomCode": "ABCDEFGH"}

    def get_share(self, _identity: object, room_id: str) -> dict[str, str]:
        self.share_ids.append(room_id)
        return {
            "roomId": room_id,
            "orgId": "demo",
            "roomCode": "ABCDEFGH",
            "joinPath": "/join/demo/ABCDEFGH",
        }

    def get_checklist(self, _identity: object, room_id: str) -> dict[str, Any]:
        self.checklist_ids.append(room_id)
        return {"id": room_id, "status": "READY", "revision": 1, "flowItems": []}

    def start_room(
        self, _identity: object, room_id: str, expected_revision: int
    ) -> dict[str, Any]:
        self.starts.append((room_id, expected_revision))
        return {"id": room_id, "status": "LIVE", "revision": expected_revision + 1}

    def reopen_room(
        self, _identity: object, room_id: str, expected_revision: int
    ) -> dict[str, Any]:
        self.reopens.append((room_id, expected_revision))
        return {"id": room_id, "status": "LIVE", "revision": expected_revision + 1}

    def complete_checklist_item(
        self, _identity: object, room_id: str, item_id: str, expected_revision: int
    ) -> dict[str, Any]:
        self.completions.append((room_id, item_id, expected_revision))
        return {"id": room_id, "status": "LIVE", "revision": expected_revision + 1}

    def undo_checklist_item(
        self, _identity: object, room_id: str, item_id: str, expected_revision: int
    ) -> dict[str, Any]:
        self.undos.append((room_id, item_id, expected_revision))
        return {"id": room_id, "status": "LIVE", "revision": expected_revision + 1}

    def instructor_management(self, _identity: object, room_id: str) -> dict[str, Any]:
        return {"roomId": room_id, "revision": 1, "instructors": [], "candidates": []}

    def _instructor_action(
        self,
        action: str,
        room_id: str,
        target_uid: str,
        expected_revision: int,
        permissions: dict[str, bool] | None = None,
    ) -> None:
        self.instructor_actions.append(
            (action, room_id, target_uid, expected_revision, permissions)
        )

    def add_assistant(
        self, _identity: object, room_id: str, target_uid: str, expected_revision: int
    ) -> dict[str, Any]:
        self._instructor_action("add", room_id, target_uid, expected_revision)
        return self.instructor_management(_identity, room_id)

    def update_assistant_permissions(
        self,
        _identity: object,
        room_id: str,
        target_uid: str,
        permissions: dict[str, bool],
        expected_revision: int,
    ) -> dict[str, Any]:
        self._instructor_action(
            "permissions", room_id, target_uid, expected_revision, permissions
        )
        return self.instructor_management(_identity, room_id)

    def grant_assistant_full_access(
        self, _identity: object, room_id: str, target_uid: str, expected_revision: int
    ) -> dict[str, Any]:
        self._instructor_action("grant", room_id, target_uid, expected_revision)
        return self.instructor_management(_identity, room_id)

    def revoke_assistant_full_access(
        self, _identity: object, room_id: str, target_uid: str, expected_revision: int
    ) -> dict[str, Any]:
        self._instructor_action("revoke", room_id, target_uid, expected_revision)
        return self.instructor_management(_identity, room_id)

    def remove_assistant(
        self, _identity: object, room_id: str, target_uid: str, expected_revision: int
    ) -> dict[str, Any]:
        self._instructor_action("remove", room_id, target_uid, expected_revision)
        return self.instructor_management(_identity, room_id)

    def transfer_lead(
        self, _identity: object, room_id: str, target_uid: str, expected_revision: int
    ) -> dict[str, Any]:
        self._instructor_action("transfer", room_id, target_uid, expected_revision)
        return {
            "id": room_id,
            "currentRole": "ASSISTANT",
            "revision": expected_revision + 1,
        }


@pytest.fixture
async def client() -> AsyncIterator[tuple[AsyncClient, CapturingRoomService]]:
    app = create_app()
    rooms = CapturingRoomService()
    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity(
            uid="masked-admin",
            email="masked@example.test",
            display_name="관리자",
            photo_url=None,
        )
    )
    app.dependency_overrides[get_cloud_room_service] = lambda: rooms
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, rooms
    app.dependency_overrides.clear()


async def test_cloud_room_create_defaults_the_active_participant_limit(
    client: tuple[AsyncClient, CapturingRoomService],
) -> None:
    http, rooms = client
    payload = {"sourceCourseId": "course-1", "title": "7월 수업"}

    response = await http.post("/api/cloud/rooms", json=payload)

    assert response.status_code == 201
    assert rooms.creates == [{**payload, "maxActiveParticipants": 50}]


@pytest.mark.parametrize("invalid_limit", [0, 301, "50", True])
async def test_cloud_room_create_requires_a_strict_1_to_300_integer_limit(
    client: tuple[AsyncClient, CapturingRoomService], invalid_limit: object
) -> None:
    http, rooms = client

    response = await http.post(
        "/api/cloud/rooms",
        json={
            "sourceCourseId": "course-1",
            "title": "7월 수업",
            "maxActiveParticipants": invalid_limit,
        },
    )

    assert response.status_code == 422
    assert rooms.creates == []


@pytest.mark.parametrize(
    "field",
    [
        "organizationId",
        "roomCode",
        "roomCreatorUid",
        "leadInstructorUid",
        "instructorMemberUids",
        "status",
        "revision",
        "sourceCourseRevision",
        "position",
        "createdAt",
        "updatedAt",
    ],
)
async def test_cloud_room_create_rejects_server_owned_fields(
    client: tuple[AsyncClient, CapturingRoomService], field: str
) -> None:
    http, rooms = client

    response = await http.post(
        "/api/cloud/rooms",
        json={"sourceCourseId": "course-1", "title": "7월 수업", field: "untrusted"},
    )

    assert response.status_code == 422
    assert rooms.creates == []


async def test_room_list_detail_and_share_routes(
    client: tuple[AsyncClient, CapturingRoomService],
) -> None:
    http, rooms = client

    listed = await http.get("/api/cloud/rooms")
    detail = await http.get("/api/cloud/rooms/room-1")
    share = await http.get("/api/cloud/rooms/room-1/share")

    assert listed.status_code == 200
    assert detail.status_code == 200
    assert share.status_code == 200
    assert rooms.listed is True
    assert rooms.read_ids == ["room-1"]
    assert rooms.share_ids == ["room-1"]
    assert share.json()["joinPath"] == "/join/demo/ABCDEFGH"


async def test_room_list_ignores_client_supplied_identity_and_role_values(
    client: tuple[AsyncClient, CapturingRoomService],
) -> None:
    http, rooms = client

    response = await http.get("/api/cloud/rooms?uid=other-user&organizationRole=ADMIN")

    assert response.status_code == 200
    assert [identity.uid for identity in rooms.list_identities] == ["masked-admin"]


def test_cloud_room_create_model_keeps_extra_forbid() -> None:
    assert CloudRoomCreate.model_config["extra"] == "forbid"
    assert CloudRoomRevisionInput.model_config["extra"] == "forbid"
    assert CloudRoomAssistantTarget.model_config["extra"] == "forbid"
    assert CloudRoomAssistantPermissions.model_config["extra"] == "forbid"


async def test_cloud_room_checklist_routes_only_accept_expected_revision(
    client: tuple[AsyncClient, CapturingRoomService],
) -> None:
    http, rooms = client

    checklist = await http.get("/api/cloud/rooms/room-1/checklist")
    started = await http.post(
        "/api/cloud/rooms/room-1/start", json={"expectedRevision": 1}
    )
    completed = await http.post(
        "/api/cloud/rooms/room-1/checklist/item-1/complete",
        json={"expectedRevision": 2},
    )
    undone = await http.post(
        "/api/cloud/rooms/room-1/checklist/item-1/undo",
        json={"expectedRevision": 3},
    )
    forged = await http.post(
        "/api/cloud/rooms/room-1/start",
        json={"expectedRevision": 1, "status": "LIVE"},
    )

    assert checklist.status_code == started.status_code == 200
    assert completed.status_code == undone.status_code == 200
    assert forged.status_code == 422
    assert rooms.checklist_ids == ["room-1"]
    assert rooms.starts == [("room-1", 1)]
    assert rooms.completions == [("room-1", "item-1", 2)]
    assert rooms.undos == [("room-1", "item-1", 3)]


async def test_cloud_room_reopen_route_only_accepts_expected_revision(
    client: tuple[AsyncClient, CapturingRoomService],
) -> None:
    http, rooms = client

    reopened = await http.post(
        "/api/cloud/rooms/room-1/reopen", json={"expectedRevision": 4}
    )
    forged = await http.post(
        "/api/cloud/rooms/room-1/reopen",
        json={"expectedRevision": 4, "status": "LIVE"},
    )

    assert reopened.status_code == 200
    assert forged.status_code == 422
    assert rooms.reopens == [("room-1", 4)]


async def test_cloud_room_instructor_routes_keep_roles_and_permissions_server_owned(
    client: tuple[AsyncClient, CapturingRoomService],
) -> None:
    http, rooms = client
    target = {"targetUserId": "masked-assistant", "expectedRevision": 3}

    listed = await http.get("/api/cloud/rooms/room-1/instructors")
    added = await http.post(
        "/api/cloud/rooms/room-1/instructors/assistants", json=target
    )
    changed = await http.put(
        "/api/cloud/rooms/room-1/instructors/assistants/permissions",
        json={
            **target,
            "permissions": {
                "questionOperations": True,
                "checklistProgress": False,
                "capacityOperations": True,
            },
        },
    )
    granted = await http.post(
        "/api/cloud/rooms/room-1/instructors/assistants/full-access/grant",
        json=target,
    )
    revoked = await http.post(
        "/api/cloud/rooms/room-1/instructors/assistants/full-access/revoke",
        json=target,
    )
    removed = await http.request(
        "DELETE", "/api/cloud/rooms/room-1/instructors/assistants", json=target
    )
    transferred = await http.post(
        "/api/cloud/rooms/room-1/instructors/lead-transfer", json=target
    )
    forged = await http.post(
        "/api/cloud/rooms/room-1/instructors/assistants",
        json={**target, "role": "LEAD"},
    )
    unknown_permission = await http.put(
        "/api/cloud/rooms/room-1/instructors/assistants/permissions",
        json={**target, "permissions": {"leadTransfer": True}},
    )

    responses = (listed, added, changed, granted, revoked, removed, transferred)
    assert all(response.status_code == 200 for response in responses)
    assert forged.status_code == unknown_permission.status_code == 422
    assert rooms.instructor_actions == [
        ("add", "room-1", "masked-assistant", 3, None),
        (
            "permissions",
            "room-1",
            "masked-assistant",
            3,
            {
                "questionOperations": True,
                "checklistProgress": False,
                "capacityOperations": True,
            },
        ),
        ("grant", "room-1", "masked-assistant", 3, None),
        ("revoke", "room-1", "masked-assistant", 3, None),
        ("remove", "room-1", "masked-assistant", 3, None),
        ("transfer", "room-1", "masked-assistant", 3, None),
    ]


async def test_cloud_room_routes_reject_unauthenticated_requests() -> None:
    app = create_app()
    app.dependency_overrides[get_cloud_room_service] = CapturingRoomService
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.get("/api/cloud/rooms")
    app.dependency_overrides.clear()

    assert response.status_code == 401
