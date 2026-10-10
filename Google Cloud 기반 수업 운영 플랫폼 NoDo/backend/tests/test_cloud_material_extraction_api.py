from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_cloud_material_extraction_service,
    get_cloud_verified_identity,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingExtractionService:
    def __init__(self) -> None:
        self.started: list[str] = []
        self.requested_status: list[str] = []
        self.latest_calls = 0

    def start(self, _identity: object, upload_id: str) -> dict[str, Any]:
        self.started.append(upload_id)
        return safe_summary(upload_id)

    def get_status(self, _identity: object, upload_id: str) -> dict[str, Any]:
        self.requested_status.append(upload_id)
        return safe_summary(upload_id)

    def latest(self, _identity: object) -> dict[str, Any]:
        self.latest_calls += 1
        return safe_summary("latest-upload")


def safe_summary(upload_id: str) -> dict[str, Any]:
    return {
        "uploadId": upload_id,
        "status": "EXTRACTED",
        "normalizedExtension": "pdf",
        "pageCount": 2,
        "slideCount": None,
        "extractedCharacterCount": 10,
        "failureCode": None,
    }


@pytest.fixture
async def client() -> AsyncIterator[tuple[AsyncClient, CapturingExtractionService]]:
    app = create_app()
    service = CapturingExtractionService()

    def verified_identity() -> VerifiedCloudIdentity:
        return VerifiedCloudIdentity(
            uid="staff-uid",
            email="staff@example.test",
            display_name="강사",
            photo_url=None,
        )

    app.dependency_overrides[get_cloud_verified_identity] = verified_identity
    app.dependency_overrides[get_cloud_material_extraction_service] = lambda: service
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, service
    app.dependency_overrides.clear()


async def test_extraction_routes_return_only_safe_summary(
    client: tuple[AsyncClient, CapturingExtractionService],
) -> None:
    http, service = client

    started = await http.post("/api/cloud/material-uploads/upload-1/extract")
    status = await http.get("/api/cloud/material-uploads/upload-1/extraction")
    latest = await http.get("/api/cloud/material-uploads/latest")

    assert started.status_code == status.status_code == latest.status_code == 200
    assert service.started == ["upload-1"]
    assert service.requested_status == ["upload-1"]
    assert service.latest_calls == 1
    assert set(started.json()) == {
        "uploadId",
        "status",
        "normalizedExtension",
        "pageCount",
        "slideCount",
        "extractedCharacterCount",
        "failureCode",
    }
    assert "storageObjectPath" not in started.json()
    assert "text" not in started.json()
