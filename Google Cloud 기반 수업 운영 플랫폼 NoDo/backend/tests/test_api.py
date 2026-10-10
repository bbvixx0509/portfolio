from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient

import app.main as main_module
from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    EXPECTED_CLOUD_STORAGE_BUCKET,
    Settings,
)
from app.domain.errors import QuestionRateLimited, ServiceTemporarilyUnavailable
from app.main import app, create_app

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as test_client:
        yield test_client


async def test_public_health_check(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "nodo", "version": "02"}


async def test_readiness_check(client: AsyncClient) -> None:
    response = await client.get("/readyz")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


async def test_version(client: AsyncClient) -> None:
    response = await client.get("/api/version")

    assert response.status_code == 200
    assert response.json()["name"] == "NoDo"
    assert response.json()["version"] == "02"


async def test_allowed_local_origin_has_cors_header(
    client: AsyncClient,
) -> None:
    response = await client.get(
        "/health",
        headers={"Origin": "http://127.0.0.1:5174"},
    )

    assert response.headers["access-control-allow-origin"] == (
        "http://127.0.0.1:5174"
    )


async def test_disallowed_origin_has_no_cors_header(
    client: AsyncClient,
) -> None:
    response = await client.get(
        "/health",
        headers={"Origin": "https://example.com"},
    )

    assert "access-control-allow-origin" not in response.headers


async def test_auth_me_preflight_and_unauthenticated_response_keep_allowed_cors_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    origins = (
        "https://example-gcp-project-nodo.firebaseapp.com",
        "https://example-gcp-project-nodo.web.app",
        "http://localhost:5175",
    )
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(
            runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
            app_env="production",
            firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
            cors_origins=origins,
            storage_mode="cloud",
            storage_bucket=EXPECTED_CLOUD_STORAGE_BUCKET,
            google_cloud_project=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        ),
    )
    transport = ASGITransport(app=main_module.create_app())
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as cloud_client:
        for origin in origins:
            preflight = await cloud_client.options(
                "/api/auth/me",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "authorization",
                },
            )
            unauthenticated = await cloud_client.get(
                "/api/auth/me", headers={"Origin": origin}
            )

            assert preflight.status_code == 200
            assert preflight.headers["access-control-allow-origin"] == origin
            assert unauthenticated.status_code == 401
            assert unauthenticated.headers["access-control-allow-origin"] == origin


async def test_protected_api_requires_firebase_bearer_token(
    client: AsyncClient,
) -> None:
    response = await client.get("/api/me")

    assert response.status_code == 401
    assert response.json()["code"] == "authentication_required"


async def test_temporary_unavailability_has_safe_body_and_retry_header() -> None:
    temporary_app = create_app()

    @temporary_app.get("/_test/temporary-unavailability")
    def temporary_unavailability() -> None:
        raise ServiceTemporarilyUnavailable(
            "요청이 일시적으로 몰렸습니다. 잠시 후 다시 시도해 주세요."
        )

    transport = ASGITransport(app=temporary_app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as test_client:
        response = await test_client.get("/_test/temporary-unavailability")

    assert response.status_code == 503
    assert response.headers["retry-after"] == "1"
    assert response.json() == {
        "code": "temporarily_unavailable",
        "detail": "요청이 일시적으로 몰렸습니다. 잠시 후 다시 시도해 주세요.",
    }


async def test_question_rate_limit_has_safe_body_and_retry_header() -> None:
    temporary_app = create_app()

    @temporary_app.get("/_test/question-rate-limit")
    def question_rate_limit() -> None:
        raise QuestionRateLimited(
            "질문을 너무 빠르게 보내고 있습니다. 잠시 후 다시 시도해 주세요."
        )

    transport = ASGITransport(app=temporary_app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as test_client:
        response = await test_client.get("/_test/question-rate-limit")

    assert response.status_code == 429
    assert response.headers["retry-after"] == "10"
    assert response.json()["code"] == "question_rate_limited"


def test_question_participant_end_and_report_routes_are_registered() -> None:
    paths = create_app().openapi()["paths"]

    assert set(paths["/api/rooms/{room_id}/questions"]) == {"post"}
    assert set(paths["/api/rooms/{room_id}/questions/{question_id}/answer"]) == {
        "put",
        "delete",
    }
    for action in ("hide", "restore", "approve"):
        assert set(
            paths[f"/api/rooms/{{room_id}}/questions/{{question_id}}/{action}"]
        ) == {"post"}
    assert set(paths["/api/rooms/{room_id}/questions/read"]) == {"post"}
    assert set(paths["/api/rooms/{room_id}/participants"]) == {"get"}
    assert set(paths["/api/rooms/{room_id}/participants/{participant_id}"]) == {
        "patch"
    }
    assert set(paths["/api/rooms/{room_id}/end"]) == {"post"}
    assert set(paths["/api/rooms/{room_id}/end-preview"]) == {"get"}
    assert set(paths["/api/rooms/{room_id}/report"]) == {"get"}
