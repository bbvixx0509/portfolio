from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_cloud_course_service,
    get_cloud_verified_identity,
)
from app.domain.errors import ResourceConflict
from app.domain.schemas import (
    CloudCourseChapterInput,
    CloudCourseCreate,
    CloudCourseItemInput,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class CapturingCourseService:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.list_statuses: list[str] = []
        self.read_ids: list[str] = []

    def list_courses(
        self, _identity: object, *, status: str = "ACTIVE"
    ) -> dict[str, Any]:
        self.list_statuses.append(status)
        return {"courses": []}

    def get_course(self, _identity: object, course_id: str) -> dict[str, Any]:
        self.read_ids.append(course_id)
        return {
            "id": course_id,
            "title": "보관 수업",
            "description": "읽기 전용",
            "status": "ARCHIVED",
            "chapters": [],
            "createdByDisplayNameSnapshot": None,
            "chapterCount": 0,
            "itemCount": 0,
            "updatedAt": None,
            "archivedAt": None,
            "isMine": False,
            "revision": 2,
        }

    def update_course(
        self, _identity: object, _course_id: str, _payload: dict[str, Any]
    ) -> dict[str, Any]:
        raise ResourceConflict("Archived courses are read-only")

    def create_course(
        self, _identity: object, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.calls.append(payload)
        return {
            "id": "course-1",
            **payload,
            "createdByDisplayNameSnapshot": None,
            "chapterCount": len(payload["chapters"]),
            "itemCount": sum(len(chapter["items"]) for chapter in payload["chapters"]),
            "updatedAt": None,
            "isMine": True,
            "revision": 1,
        }


@pytest.fixture
async def client() -> AsyncIterator[tuple[AsyncClient, CapturingCourseService]]:
    app = create_app()
    courses = CapturingCourseService()
    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity(
            uid="admin-uid",
            email="admin@nodo-company.test",
            display_name="관리자",
            photo_url=None,
        )
    )
    app.dependency_overrides[get_cloud_course_service] = lambda: courses
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, courses
    app.dependency_overrides.clear()


def course_input() -> dict[str, Any]:
    return {
        "title": "계약 검증 수업",
        "description": "입력 구조 검증",
        "chapters": [
            {
                "id": "chapter-1",
                "title": "첫 챕터",
                "items": [
                    {
                        "id": "item-1",
                        "title": "첫 항목",
                        "description": "하나",
                        "sourcePageOrSlideNumbers": [],
                    },
                    {
                        "id": "item-2",
                        "title": "둘째 항목",
                        "description": "둘",
                        "sourcePageOrSlideNumbers": [1, 2],
                    },
                ],
            }
        ],
    }


async def test_cloud_course_create_accepts_only_contract_fields(
    client: tuple[AsyncClient, CapturingCourseService],
) -> None:
    http, courses = client
    payload = course_input()

    response = await http.post("/api/cloud/courses", json=payload)

    assert response.status_code == 201
    assert courses.calls == [{**payload, "materialIds": []}]


@pytest.mark.parametrize(
    "payload",
    [
        {
            **course_input(),
            "chapters": [{**course_input()["chapters"][0], "position": 0}],
        },
        {
            **course_input(),
            "chapters": [
                {
                    **course_input()["chapters"][0],
                    "items": [
                        {
                            **course_input()["chapters"][0]["items"][0],
                            "position": 0,
                        }
                    ],
                }
            ],
        },
    ],
)
async def test_cloud_course_create_rejects_position_fields(
    client: tuple[AsyncClient, CapturingCourseService], payload: dict[str, Any]
) -> None:
    http, courses = client

    response = await http.post("/api/cloud/courses", json=payload)

    assert response.status_code == 422
    assert courses.calls == []


def test_cloud_course_input_models_keep_extra_forbid() -> None:
    assert CloudCourseCreate.model_config["extra"] == "forbid"
    assert CloudCourseChapterInput.model_config["extra"] == "forbid"
    assert CloudCourseItemInput.model_config["extra"] == "forbid"


async def test_cloud_course_status_query_is_explicit_and_validated(
    client: tuple[AsyncClient, CapturingCourseService],
) -> None:
    http, courses = client

    active = await http.get("/api/cloud/courses")
    archived = await http.get("/api/cloud/courses?status=ARCHIVED")
    invalid = await http.get("/api/cloud/courses?status=ALL")

    assert active.status_code == 200
    assert archived.status_code == 200
    assert invalid.status_code == 422
    assert courses.list_statuses == ["ACTIVE", "ARCHIVED"]


async def test_archived_course_detail_is_readable_but_update_is_conflict(
    client: tuple[AsyncClient, CapturingCourseService],
) -> None:
    http, courses = client

    detail = await http.get("/api/cloud/courses/archived-course")
    update = await http.put(
        "/api/cloud/courses/archived-course",
        json={**course_input(), "expectedRevision": 2},
    )

    assert detail.status_code == 200
    assert detail.json()["status"] == "ARCHIVED"
    assert courses.read_ids == ["archived-course"]
    assert update.status_code == 409


async def test_cloud_course_routes_reject_unauthenticated_requests() -> None:
    app = create_app()
    app.dependency_overrides[get_cloud_course_service] = CapturingCourseService
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.get("/api/cloud/courses?status=ARCHIVED")
    app.dependency_overrides.clear()

    assert response.status_code == 401
