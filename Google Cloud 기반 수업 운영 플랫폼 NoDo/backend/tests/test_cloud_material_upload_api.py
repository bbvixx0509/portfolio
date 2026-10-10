from collections.abc import AsyncIterator
from io import BytesIO
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

import app.main as main_module
from app.api.dependencies import (
    get_cloud_material_upload_service,
    get_cloud_verified_identity,
)
from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    EXPECTED_CLOUD_STORAGE_BUCKET,
    Settings,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingMaterialUploadService:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def upload(
        self,
        _identity: object,
        *,
        original_filename: object,
        content_type_hint: str | None,
        size_bytes: int,
        source: BytesIO,
    ) -> dict[str, Any]:
        self.calls.append(
            {
                "originalFilename": original_filename,
                "contentTypeHint": content_type_hint,
                "sizeBytes": size_bytes,
                "source": source.read(),
            }
        )
        return {
            "uploadId": "upload-1",
            "status": "STORED",
            "normalizedExtension": "pdf",
            "sizeBytes": size_bytes,
            "createdAt": None,
        }


@pytest.fixture
async def client() -> AsyncIterator[tuple[AsyncClient, CapturingMaterialUploadService]]:
    app = create_app()
    service = CapturingMaterialUploadService()
    def verified_identity() -> VerifiedCloudIdentity:
        return VerifiedCloudIdentity(
            uid="staff-uid",
            email="staff@example.test",
            display_name="강사",
            photo_url=None,
        )

    app.dependency_overrides[get_cloud_verified_identity] = verified_identity
    app.dependency_overrides[get_cloud_material_upload_service] = lambda: service
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, service
    app.dependency_overrides.clear()


async def test_material_upload_streams_raw_file_with_safe_filename_header(
    client: tuple[AsyncClient, CapturingMaterialUploadService],
) -> None:
    http, service = client
    content = b"%PDF-1.7\n"

    response = await http.post(
        "/api/cloud/material-uploads",
        content=content,
        headers={
            "Content-Type": "application/pdf",
            "X-NoDo-Upload-Filename": "%EC%88%98%EC%97%85%20%EC%9E%90%EB%A3%8C.pdf",
        },
    )

    assert response.status_code == 201
    assert response.json()["status"] == "STORED"
    assert service.calls == [
        {
            "originalFilename": "수업 자료.pdf",
            "contentTypeHint": "application/pdf",
            "sizeBytes": len(content),
            "source": content,
        }
    ]


async def test_material_upload_preflight_allows_the_hosting_upload_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(
            runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
            app_env="production",
            firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
            storage_mode="cloud",
            storage_bucket=EXPECTED_CLOUD_STORAGE_BUCKET,
            google_cloud_project=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
            cors_origins=(
                "https://example-gcp-project-nodo.web.app",
                "https://example-gcp-project-nodo.firebaseapp.com",
                "http://localhost:5175",
            ),
        ),
    )
    app = create_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.options(
            "/api/cloud/material-uploads",
            headers={
                "Origin": "https://example-gcp-project-nodo.firebaseapp.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": (
                    "authorization,content-type,x-nodo-upload-filename"
                ),
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == (
        "https://example-gcp-project-nodo.firebaseapp.com"
    )
    assert "authorization" in response.headers["access-control-allow-headers"]
    assert "x-nodo-upload-filename" in response.headers[
        "access-control-allow-headers"
    ]
