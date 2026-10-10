from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_cloud_material_storage_quota_service,
    get_cloud_verified_identity,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingQuotaService:
    def __init__(self) -> None:
        self.identities: list[VerifiedCloudIdentity] = []
        self.own_usage_identities: list[VerifiedCloudIdentity] = []

    def own_usage(self, identity: VerifiedCloudIdentity) -> dict[str, object]:
        self.own_usage_identities.append(identity)
        return {
            "usedBytes": 16 * 1024**2,
            "reservedBytes": 0,
            "limitBytes": 5 * 1024**3,
            "remainingBytes": 5 * 1024**3 - 16 * 1024**2,
            "baselineState": "READY",
        }

    def list_instructor_usage(
        self, identity: VerifiedCloudIdentity
    ) -> dict[str, object]:
        self.identities.append(identity)
        return {
            "instructors": [
                {
                    "memberKey": "opaque-member-key",
                    "displayName": "강사",
                    "usedBytes": 1024,
                    "reservedBytes": 0,
                    "limitBytes": 10 * 1024**3,
                    "remainingBytes": 10 * 1024**3 - 1024,
                }
            ]
        }


@pytest.fixture
async def client() -> AsyncIterator[tuple[AsyncClient, CapturingQuotaService]]:
    app = create_app()
    quota = CapturingQuotaService()
    identity = VerifiedCloudIdentity(
        uid="admin-uid",
        email="admin@example.test",
        display_name="관리자",
        photo_url=None,
    )
    app.dependency_overrides[get_cloud_verified_identity] = lambda: identity
    app.dependency_overrides[get_cloud_material_storage_quota_service] = lambda: quota
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, quota
    app.dependency_overrides.clear()


async def test_admin_storage_usage_endpoint_returns_safe_usage_list(
    client: tuple[AsyncClient, CapturingQuotaService],
) -> None:
    http, quota = client

    response = await http.get("/api/cloud/organization/storage/instructors")

    assert response.status_code == 200
    assert response.json() == {
        "instructors": [
            {
                "memberKey": "opaque-member-key",
                "displayName": "강사",
                "usedBytes": 1024,
                "reservedBytes": 0,
                "limitBytes": 10 * 1024**3,
                "remainingBytes": 10 * 1024**3 - 1024,
            }
        ]
    }
    assert [identity.uid for identity in quota.identities] == ["admin-uid"]


async def test_own_storage_usage_endpoint_returns_only_the_callers_snapshot(
    client: tuple[AsyncClient, CapturingQuotaService],
) -> None:
    http, quota = client

    response = await http.get("/api/cloud/material-storage/usage")

    assert response.status_code == 200
    assert response.json() == {
        "usedBytes": 16 * 1024**2,
        "reservedBytes": 0,
        "limitBytes": 5 * 1024**3,
        "remainingBytes": 5 * 1024**3 - 16 * 1024**2,
        "baselineState": "READY",
    }
    assert [identity.uid for identity in quota.own_usage_identities] == ["admin-uid"]
    assert "email" not in response.text
    assert "uid" not in response.text


async def test_storage_usage_endpoint_requires_authentication() -> None:
    app = create_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.get("/api/cloud/organization/storage/instructors")

    assert response.status_code == 401


async def test_own_storage_usage_endpoint_requires_authentication() -> None:
    app = create_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.get("/api/cloud/material-storage/usage")

    assert response.status_code == 401
