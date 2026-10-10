from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_cloud_invitation_service,
    get_cloud_verified_identity,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingInvitationService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def _result(self, status: str = "PENDING") -> dict[str, Any]:
        return {
            "id": "a" * 64,
            "email": "member@nodo-company.test",
            "status": status,
            "expiresAt": "2026-08-07T00:00:00Z",
            "createdAt": "2026-07-31T00:00:00Z",
            "updatedAt": "2026-07-31T00:00:00Z",
            "acceptedAt": None,
            "declinedAt": None,
            "revokedAt": None,
        }

    def list_invitations(self, _identity: object) -> dict[str, Any]:
        self.calls.append(("list", None))
        return {"invitations": [self._result()]}

    def create_invitation(
        self, _identity: object, email: str
    ) -> dict[str, Any]:
        self.calls.append(("create", email))
        return self._result()

    def resend_invitation(
        self, _identity: object, invitation_id: str
    ) -> dict[str, Any]:
        self.calls.append(("resend", invitation_id))
        return self._result()

    def revoke_invitation(
        self, _identity: object, invitation_id: str
    ) -> dict[str, Any]:
        self.calls.append(("revoke", invitation_id))
        return self._result("REVOKED")

    def accept_invitation(
        self, _identity: object, token: str
    ) -> dict[str, Any]:
        self.calls.append(("accept", token))
        return self._result("ACCEPTED")

    def decline_invitation(
        self, _identity: object, token: str
    ) -> dict[str, Any]:
        self.calls.append(("decline", token))
        return self._result("DECLINED")


@pytest.fixture
async def client() -> AsyncIterator[
    tuple[AsyncClient, CapturingInvitationService]
]:
    app = create_app()
    service = CapturingInvitationService()
    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity(
            uid="admin",
            email="admin@nodo-company.test",
            display_name="Administrator",
            photo_url=None,
        )
    )
    app.dependency_overrides[get_cloud_invitation_service] = lambda: service
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, service
    app.dependency_overrides.clear()


async def test_admin_invitation_management_routes(
    client: tuple[AsyncClient, CapturingInvitationService],
) -> None:
    http, service = client
    invitation_id = "a" * 64

    listed = await http.get("/api/cloud/organization/invitations")
    created = await http.post(
        "/api/cloud/organization/invitations",
        json={"email": "member@nodo-company.test"},
    )
    resent = await http.post(
        f"/api/cloud/organization/invitations/{invitation_id}/resend"
    )
    revoked = await http.delete(
        f"/api/cloud/organization/invitations/{invitation_id}"
    )

    assert listed.status_code == 200
    assert created.status_code == 201
    assert resent.status_code == 200
    assert revoked.status_code == 200
    assert service.calls == [
        ("list", None),
        ("create", "member@nodo-company.test"),
        ("resend", invitation_id),
        ("revoke", invitation_id),
    ]


async def test_token_actions_use_json_body_not_sensitive_url_path(
    client: tuple[AsyncClient, CapturingInvitationService],
) -> None:
    http, service = client
    token = "t" * 43

    accepted = await http.post(
        "/api/cloud/organization/invitations/accept",
        json={"token": token},
    )
    declined = await http.post(
        "/api/cloud/organization/invitations/decline",
        json={"token": token},
    )

    assert accepted.status_code == 200
    assert declined.status_code == 200
    assert service.calls == [("accept", token), ("decline", token)]


async def test_token_action_service_receives_token_without_putting_it_in_path(
    client: tuple[AsyncClient, CapturingInvitationService],
) -> None:
    http, service = client
    token = "s" * 43

    response = await http.post(
        "/api/cloud/organization/invitations/accept",
        json={"token": token},
    )

    assert response.status_code == 200
    assert service.calls == [("accept", token)]


async def test_legacy_management_routes_use_the_same_email_invitation_service(
    client: tuple[AsyncClient, CapturingInvitationService],
) -> None:
    http, service = client
    invitation_id = "b" * 64

    listed = await http.get("/api/organization/staff-invitations")
    created = await http.post(
        "/api/organization/staff-invitations",
        json={"email": "member@nodo-company.test"},
    )
    revoked = await http.delete(
        f"/api/organization/staff-invitations/{invitation_id}"
    )

    assert listed.status_code == 200
    assert created.status_code == 200
    assert revoked.status_code == 200
    assert service.calls == [
        ("list", None),
        ("create", "member@nodo-company.test"),
        ("revoke", invitation_id),
    ]
