from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_cloud_organization_role_service,
    get_cloud_verified_identity,
)
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    LastOrganizationAdministrator,
    ResourceConflict,
    StaffMemberHasActiveRoomRole,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingRoleService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def list_members(self, _identity: object) -> dict[str, Any]:
        self.calls.append(("list", None))
        return {"members": [], "count": 0}

    def update_role(
        self, _identity: object, uid: str, role: str, revision: int
    ) -> dict[str, Any]:
        self.calls.append(("update", (uid, role, revision)))
        return {
            "uid": uid,
            "email": "employee@nodo-company.test",
            "displayName": None,
            "photoURL": None,
            "organizationRole": role,
            "organizationRoleRevision": revision + 1,
            "createdAt": None,
        }

    def remove_member(self, _identity: object, uid: str) -> dict[str, bool]:
        self.calls.append(("remove", uid))
        return {"removed": True}


@pytest.fixture
async def client() -> AsyncIterator[tuple[AsyncClient, CapturingRoleService]]:
    app = create_app()
    roles = CapturingRoleService()
    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity(
            uid="admin-uid",
            email="admin@nodo-company.test",
            display_name="관리자",
            photo_url=None,
        )
    )
    app.dependency_overrides[get_cloud_organization_role_service] = lambda: roles
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, roles
    app.dependency_overrides.clear()


async def test_admin_member_routes_use_cloud_contract(
    client: tuple[AsyncClient, CapturingRoleService],
) -> None:
    http, roles = client
    listed = await http.get("/api/cloud/organization/members")
    updated = await http.patch(
        "/api/cloud/organization/members/member-uid/organization-role",
        json={"organizationRole": "ADMIN", "expectedRevision": 1},
    )
    removed = await http.delete("/api/cloud/organization/members/member-uid")
    assert listed.status_code == 200
    assert updated.status_code == 200
    assert removed.status_code == 200
    assert removed.json() == {"removed": True}
    assert updated.json()["organizationRoleRevision"] == 2
    assert roles.calls == [
        ("list", None),
        ("update", ("member-uid", "ADMIN", 1)),
        ("remove", "member-uid"),
    ]


async def test_invalid_role_is_rejected_by_schema(
    client: tuple[AsyncClient, CapturingRoleService],
) -> None:
    http, _roles = client
    response = await http.patch(
        "/api/cloud/organization/members/member-uid/organization-role",
        json={"organizationRole": "INVALID", "expectedRevision": 1},
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "error, expected",
    [
        (AccessDenied("no"), 403),
        (InvalidOperation("no"), 422),
        (ResourceConflict("no"), 409),
    ],
)
async def test_role_errors_are_not_hidden(error: Exception, expected: int) -> None:
    app = create_app()

    class Rejected:
        def list_members(self, _identity: object) -> dict[str, Any]:
            raise error

    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity(
            uid="admin", email="admin@nodo-company.test", display_name="관리자", photo_url=None
        )
    )
    app.dependency_overrides[get_cloud_organization_role_service] = lambda: Rejected()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.get("/api/cloud/organization/members")
    app.dependency_overrides.clear()
    assert response.status_code == expected


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (
            LastOrganizationAdministrator("마지막 관리자는 제거할 수 없습니다."),
            "last_organization_administrator",
        ),
        (
            StaffMemberHasActiveRoomRole("강의방 강사 권한이 남아 있습니다."),
            "staff_member_has_active_room_role",
        ),
    ],
)
async def test_member_removal_conflicts_return_safe_specific_codes(
    error: Exception, code: str
) -> None:
    app = create_app()

    class Rejected:
        def remove_member(
            self, _identity: object, _target_uid: str
        ) -> dict[str, bool]:
            raise error

    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity(
            uid="admin", email="admin@nodo-company.test", display_name="관리자", photo_url=None
        )
    )
    app.dependency_overrides[get_cloud_organization_role_service] = lambda: Rejected()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.delete("/api/cloud/organization/members/member")
    app.dependency_overrides.clear()

    assert response.status_code == 409
    assert response.json()["code"] == code
    assert "uid" not in response.json()["detail"].lower()


async def test_member_removal_requires_authentication() -> None:
    app = create_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.delete("/api/cloud/organization/members/member")

    assert response.status_code == 401
