from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api import dependencies
from app.api.dependencies import get_runtime_settings
from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    Settings,
)
from app.domain.errors import AccessDenied, AuthenticationRequired
from app.main import create_app
from app.services.student_auth_service import authorize_anonymous_student

FIXED_NOW = 2_000_000_000.0
SYNTHETIC_TOKEN = "synthetic-student-token"
SYNTHETIC_UID = "synthetic-student-uid"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def cloud_settings() -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        bootstrap_org_owner_emails=frozenset({"owner@example.test"}),
        cors_origins=("http://localhost:5175",),
    )


def anonymous_claims(**overrides: Any) -> dict[str, Any]:
    claims: dict[str, Any] = {
        "aud": EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        "iss": (
            "https://securetoken.google.com/"
            f"{EXPECTED_CLOUD_FIREBASE_PROJECT_ID}"
        ),
        "exp": FIXED_NOW + 3600,
        "uid": SYNTHETIC_UID,
        "sub": SYNTHETIC_UID,
        "firebase": {"sign_in_provider": "anonymous"},
    }
    claims.update(overrides)
    return claims


@pytest.fixture
async def cloud_client(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[AsyncClient]:
    for variable in (
        "FIREBASE_AUTH_EMULATOR_HOST",
        "FIRESTORE_EMULATOR_HOST",
        "FIREBASE_STORAGE_EMULATOR_HOST",
    ):
        monkeypatch.delenv(variable, raising=False)
    application = create_app()
    application.dependency_overrides[get_runtime_settings] = cloud_settings
    transport = ASGITransport(app=application)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        yield client
    application.dependency_overrides.clear()


def authorize(claims: dict[str, Any]) -> None:
    authorize_anonymous_student(
        claims,
        project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        clock=lambda: FIXED_NOW,
    )


def install_claims(
    monkeypatch: pytest.MonkeyPatch,
    claims: dict[str, Any],
) -> None:
    def verified_token(_token: str, *, project_id: str) -> dict[str, Any]:
        assert project_id == EXPECTED_CLOUD_FIREBASE_PROJECT_ID
        return claims

    monkeypatch.setattr(dependencies, "verify_cloud_id_token", verified_token)


@pytest.mark.parametrize(
    "overrides",
    [
        {"aud": "other-project"},
        {"iss": "https://securetoken.google.com/other-project"},
        {"exp": FIXED_NOW},
        {"exp": True},
        {"uid": "", "sub": ""},
        {"uid": "different-uid"},
        {"uid": None},
        {"sub": None},
    ],
)
def test_student_identity_rejects_invalid_trusted_claims(
    overrides: dict[str, Any],
) -> None:
    with pytest.raises(AuthenticationRequired, match="invalid"):
        authorize(anonymous_claims(**overrides))


@pytest.mark.parametrize("provider", ["google.com", "password", "custom", None])
def test_student_identity_rejects_non_anonymous_provider(
    provider: str | None,
) -> None:
    with pytest.raises(AccessDenied, match="Anonymous student"):
        authorize(
            anonymous_claims(firebase={"sign_in_provider": provider})
        )


@pytest.mark.anyio
async def test_student_session_requires_bearer_token(
    cloud_client: AsyncClient,
) -> None:
    response = await cloud_client.post(
        "/api/auth/student-session",
        json={"nickname": "차분한 별빛", "roomCode": "TEST123"},
    )

    assert response.status_code == 401
    assert response.json()["code"] == "authentication_required"


@pytest.mark.anyio
async def test_student_session_rejects_invalid_verified_token(
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def invalid_token(_token: str, *, project_id: str) -> None:
        assert project_id == EXPECTED_CLOUD_FIREBASE_PROJECT_ID
        raise ValueError("synthetic invalid token")

    monkeypatch.setattr(dependencies, "verify_cloud_id_token", invalid_token)
    response = await cloud_client.post(
        "/api/auth/student-session",
        headers={"Authorization": f"Bearer {SYNTHETIC_TOKEN}"},
        json={"nickname": "차분한 별빛", "roomCode": "TEST123"},
    )

    assert response.status_code == 401
    assert response.json()["code"] == "authentication_required"
    assert SYNTHETIC_TOKEN not in response.text


@pytest.mark.anyio
async def test_student_session_returns_only_server_derived_auth_scope(
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_claims(monkeypatch, anonymous_claims())
    response = await cloud_client.post(
        "/api/auth/student-session",
        headers={"Authorization": f"Bearer {SYNTHETIC_TOKEN}"},
        json={
            "nickname": "  차분한 별빛  ",
            "roomCode": "  TEST123  ",
            "role": "ADMIN",
            "accountType": "STAFF",
            "isAdmin": True,
            "organizationId": "other-organization",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "accountType": "STUDENT",
        "isAnonymous": True,
        "identityVerified": True,
        "provider": "anonymous",
        "scope": "AUTH_ONLY",
        "roomAuthorized": False,
        "nickname": "차분한 별빛",
        "roomCode": "TEST123",
    }
    assert "authorized" not in response.json()
    assert SYNTHETIC_UID not in response.text
    assert SYNTHETIC_TOKEN not in response.text


@pytest.mark.parametrize("provider", ["google.com", "password", "custom"])
@pytest.mark.anyio
async def test_student_session_api_rejects_other_providers(
    provider: str,
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_claims(
        monkeypatch,
        anonymous_claims(firebase={"sign_in_provider": provider}),
    )
    response = await cloud_client.post(
        "/api/auth/student-session",
        headers={"Authorization": f"Bearer {SYNTHETIC_TOKEN}"},
        json={"nickname": "차분한 별빛", "roomCode": "TEST123"},
    )

    assert response.status_code == 403
    assert response.json()["code"] == "access_denied"


@pytest.mark.anyio
async def test_auth_me_continues_to_reject_anonymous_token(
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_claims(monkeypatch, anonymous_claims())
    response = await cloud_client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {SYNTHETIC_TOKEN}"},
    )

    assert response.status_code == 403
    assert response.json()["code"] == "access_denied"


@pytest.mark.parametrize(
    "nickname",
    [
        "",
        "   ",
        "별",
        "가" * 17,
        "별빛\n구름",
        "별빛\r구름",
        "별빛\t구름",
        "별빛\u200b구름",
        "관리자",
        "공식-강사",
        "NoDo 운영자",
        "욕설없는별빛",
        123,
    ],
)
@pytest.mark.anyio
async def test_student_session_rejects_invalid_nickname(
    nickname: object,
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_claims(monkeypatch, anonymous_claims())
    response = await cloud_client.post(
        "/api/auth/student-session",
        headers={"Authorization": f"Bearer {SYNTHETIC_TOKEN}"},
        json={"nickname": nickname, "roomCode": "TEST123"},
    )

    assert response.status_code == 422


@pytest.mark.parametrize("nickname", ["관리자연습", "시스템공학", "<b>별빛</b>"])
@pytest.mark.anyio
async def test_student_session_preserves_safe_plain_text_nickname(
    nickname: str,
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_claims(monkeypatch, anonymous_claims())
    response = await cloud_client.post(
        "/api/auth/student-session",
        headers={"Authorization": f"Bearer {SYNTHETIC_TOKEN}"},
        json={"nickname": nickname, "roomCode": "TEST123"},
    )

    assert response.status_code == 200
    assert response.json()["nickname"] == nickname
    assert response.headers["content-type"].startswith("application/json")


@pytest.mark.parametrize(
    "room_code",
    ["ABC", "A" * 13, "test123", "AB-12", "AB%2F12", "테스트12", 123],
)
@pytest.mark.anyio
async def test_student_session_rejects_invalid_room_code(
    room_code: object,
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install_claims(monkeypatch, anonymous_claims())
    response = await cloud_client.post(
        "/api/auth/student-session",
        headers={"Authorization": f"Bearer {SYNTHETIC_TOKEN}"},
        json={"nickname": "차분한 별빛", "roomCode": room_code},
    )

    assert response.status_code == 422


@pytest.mark.anyio
async def test_student_session_does_not_log_token_or_uid(
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    install_claims(monkeypatch, anonymous_claims())
    response = await cloud_client.post(
        "/api/auth/student-session",
        headers={"Authorization": f"Bearer {SYNTHETIC_TOKEN}"},
        json={"nickname": "맑은 구름", "roomCode": "TEST123"},
    )

    assert response.status_code == 200
    assert SYNTHETIC_TOKEN not in caplog.text
    assert SYNTHETIC_UID not in caplog.text
