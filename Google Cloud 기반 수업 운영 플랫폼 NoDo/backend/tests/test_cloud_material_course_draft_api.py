from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_cloud_material_course_draft_service,
    get_cloud_verified_identity,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingDraftService:
    def __init__(self) -> None:
        self.created: list[str] = []
        self.loaded: list[str] = []
        self.applied: list[tuple[str, dict[str, Any]]] = []
        self.discarded: list[tuple[str, int]] = []

    def create(self, _identity: object, material_id: str) -> dict[str, Any]:
        self.created.append(material_id)
        return {
            "draftId": "draft-1",
            "status": "GENERATED",
            "suggestedTitle": "제안 제목",
            "summary": "요약",
            "chapters": [],
            "modelId": "fake-gemini-2.5-flash",
            "promptVersion": "material-course-draft-v1",
            "failureCode": None,
            "revision": 2,
        }

    def get(self, _identity: object, draft_id: str) -> dict[str, Any]:
        self.loaded.append(draft_id)
        return {
            "draftId": draft_id,
            "status": "GENERATED",
            "suggestedTitle": "제안 제목",
            "summary": "요약",
            "chapters": [],
            "modelId": "fake-gemini-2.5-flash",
            "promptVersion": "material-course-draft-v1",
            "failureCode": None,
            "revision": 2,
        }

    def apply(
        self, _identity: object, draft_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        self.applied.append((draft_id, body))
        return {
            "draft": {**self.get(_identity, draft_id), "status": "APPLIED"},
            "course": {
                "id": "course-1",
                "title": body["title"],
                "status": "ACTIVE",
                "revision": 1,
            },
        }

    def discard(
        self, _identity: object, draft_id: str, revision: int
    ) -> dict[str, Any]:
        self.discarded.append((draft_id, revision))
        return {
            **self.get(_identity, draft_id),
            "status": "DISCARDED",
            "revision": revision + 1,
        }


@pytest.fixture
async def client() -> AsyncIterator[tuple[AsyncClient, CapturingDraftService]]:
    app = create_app()
    service = CapturingDraftService()
    app.dependency_overrides[get_cloud_material_course_draft_service] = lambda: service
    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity(
            uid="masked-staff",
            email="masked@example.test",
            display_name="강사",
            photo_url=None,
        )
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, service
    app.dependency_overrides.clear()


async def test_material_course_draft_routes_return_only_safe_draft_contract(
    client: tuple[AsyncClient, CapturingDraftService],
) -> None:
    http, service = client

    created = await http.post("/api/cloud/materials/material-1/course-drafts")
    loaded = await http.get("/api/cloud/material-course-drafts/draft-1")

    assert created.status_code == 201
    assert loaded.status_code == 200
    assert service.created == ["material-1"]
    assert service.loaded == ["draft-1"]
    assert "storageObjectPath" not in created.text
    assert "sourceMaterialRevision" not in created.text
    assert "extraction.json" not in created.text


async def test_material_course_draft_apply_and_discard_require_strict_input(
    client: tuple[AsyncClient, CapturingDraftService],
) -> None:
    http, service = client
    body = {
        "title": "편집 제목",
        "description": "설명",
        "chapters": [
            {
                "title": "챕터",
                "items": [
                    {
                        "title": "항목",
                        "description": "설명",
                        "sourcePageOrSlideNumbers": [1],
                    }
                ],
            }
        ],
        "expectedRevision": 2,
    }

    applied = await http.post(
        "/api/cloud/material-course-drafts/draft-1/apply", json=body
    )
    discarded = await http.post(
        "/api/cloud/material-course-drafts/draft-1/discard",
        json={"expectedRevision": 2},
    )
    malformed = await http.post(
        "/api/cloud/material-course-drafts/draft-1/apply",
        json={**body, "learningObjectives": ["목표"]},
    )

    assert applied.status_code == 200
    assert discarded.status_code == 200
    assert malformed.status_code == 422
    assert service.applied[0][1]["chapters"][0].get("position") is None
    assert service.discarded == [("draft-1", 2)]


async def test_material_course_draft_routes_require_firebase_authentication() -> None:
    app = create_app()
    app.dependency_overrides[get_cloud_material_course_draft_service] = (
        CapturingDraftService
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.post("/api/cloud/materials/material-1/course-drafts")
    app.dependency_overrides.clear()

    assert response.status_code == 401
