from collections.abc import AsyncIterator
from typing import Any

import pytest
from firebase_admin import _auth_utils, _token_gen
from google.auth.credentials import AnonymousCredentials
from httpx import ASGITransport, AsyncClient

from app.adapters.firebase_cloud_auth import (
    AuthVerificationCredential,
    firebase_id_token_failure_code,
)
from app.api import dependencies
from app.api.dependencies import (
    get_cloud_organization_repository,
    get_cloud_organization_service,
    get_runtime_settings,
)
from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EMULATOR_RUNTIME_MODE,
    EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    Settings,
)
from app.domain.errors import AccessDenied, AuthenticationRequired
from app.main import create_app
from app.services.cloud_auth_service import verify_cloud_google_identity
from app.services.cloud_organization_service import (
    BOOTSTRAP_AUDIT_LOG_ID,
    OwnerDocuments,
)

pytestmark = pytest.mark.anyio

SYNTHETIC_OWNER_EMAIL = "owner@example.test"
SYNTHETIC_UID = "synthetic-owner-uid"
FIXED_NOW = 2_000_000_000.0


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def cloud_settings() -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        app_env="local",
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        bootstrap_enabled=True,
        bootstrap_org_owner_emails=frozenset({SYNTHETIC_OWNER_EMAIL}),
        cors_origins=("http://localhost:5175",),
    )


def test_production_cloud_auth_accepts_only_both_nodo_hosting_origins() -> None:
    valid = Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        app_env="production",
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        bootstrap_enabled=False,
        cors_origins=(
            "https://example-gcp-project-nodo.web.app",
            "https://example-gcp-project-nodo.firebaseapp.com",
            "http://localhost:5175",
        ),
        storage_mode="cloud",
        storage_bucket="example-gcp-project-nodo-materials",
        google_cloud_project=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
    )

    valid.ensure_cloud_auth_only()


def valid_claims(**overrides: Any) -> dict[str, Any]:
    claims: dict[str, Any] = {
        "aud": EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        "iss": (
            "https://securetoken.google.com/"
            f"{EXPECTED_CLOUD_FIREBASE_PROJECT_ID}"
        ),
        "exp": FIXED_NOW + 3600,
        "uid": SYNTHETIC_UID,
        "sub": SYNTHETIC_UID,
        "email": f"  {SYNTHETIC_OWNER_EMAIL.upper()}  ",
        "email_verified": True,
        "name": "Synthetic Owner",
        "picture": "https://example.test/avatar.png",
        "firebase": {"sign_in_provider": "google.com"},
    }
    claims.update(overrides)
    return claims


def complete_owner_documents(uid: str = SYNTHETIC_UID) -> OwnerDocuments:
    timestamp = object()
    return OwnerDocuments(
        organization={
            "id": "demo",
            "orgId": "demo",
            "name": "DEMO",
            "adminCount": 1,
            "bootstrapState": "COMPLETED",
            "schemaVersion": 1,
            "createdAt": timestamp,
            "updatedAt": timestamp,
        },
        user={
            "uid": uid,
            "orgId": "demo",
            "accountType": "STAFF",
            "organizationRole": "ADMIN",
            "organizationRoleRevision": 1,
            "isAnonymous": False,
            "email": SYNTHETIC_OWNER_EMAIL,
            "displayName": "Synthetic Owner",
            "photoURL": None,
            "schemaVersion": 1,
            "createdAt": timestamp,
            "updatedAt": timestamp,
        },
        audit_log={
            "eventType": "BOOTSTRAP_OWNER_CREATED",
            "orgId": "demo",
            "actorUid": uid,
            "targetUid": uid,
            "before": None,
            "after": {
                "accountType": "STAFF",
                "organizationRole": "ADMIN",
            },
            "schemaVersion": 1,
            "createdAt": timestamp,
        },
    )


class StaticOwnerRepository:
    def read_owner_documents(
        self, *, org_id: str, uid: str, audit_log_id: str
    ) -> OwnerDocuments:
        assert org_id == "demo"
        assert uid == SYNTHETIC_UID
        assert audit_log_id == BOOTSTRAP_AUDIT_LOG_ID
        return complete_owner_documents()

    def run_transaction(self, _callback: Any) -> None:
        raise AssertionError("GET /api/auth/me must not run a transaction")


class EmptyOwnerRepository:
    def read_owner_documents(self, **_kwargs: Any) -> OwnerDocuments:
        return OwnerDocuments(None, None, None)

    def run_transaction(self, _callback: Any) -> None:
        raise AssertionError("GET /api/auth/me must not run a transaction")


def authorize(claims: dict[str, Any]):
    return verify_cloud_google_identity(
        claims,
        project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        clock=lambda: FIXED_NOW,
    )


def test_verified_google_identity_does_not_derive_an_organization_role() -> None:
    result = authorize(valid_claims())

    assert result.uid == SYNTHETIC_UID
    assert result.email == SYNTHETIC_OWNER_EMAIL
    assert result.display_name == "Synthetic Owner"
    assert result.photo_url == "https://example.test/avatar.png"
    assert not hasattr(result, "account_type")


def test_cloud_token_verification_has_no_service_account_credential() -> None:
    credential = AuthVerificationCredential().get_credential()

    assert isinstance(credential, AnonymousCredentials)


@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (
            _auth_utils.InvalidIdTokenError(
                "Could not verify token signature.",
            ),
            "SIGNATURE_INVALID",
        ),
        (
            _auth_utils.InvalidIdTokenError(
                'Firebase ID token has incorrect "aud" claim.',
            ),
            "AUDIENCE_MISMATCH",
        ),
        (
            _token_gen.ExpiredIdTokenError(
                "Token expired.",
                ValueError("synthetic expiration"),
            ),
            "TOKEN_EXPIRED",
        ),
        (
            _token_gen.CertificateFetchError(
                "Certificate request failed.",
                OSError("synthetic transport"),
            ),
            "CERTIFICATE_FETCH_FAILED",
        ),
        (ValueError("synthetic malformed token"), "TOKEN_MALFORMED"),
    ],
)
def test_cloud_token_failure_codes_do_not_contain_sensitive_values(
    error: BaseException,
    expected_code: str,
) -> None:
    code = firebase_id_token_failure_code(error)

    assert code == expected_code
    assert code.isascii()


def test_cloud_mode_blocks_repository_before_firestore_initialization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dependencies, "settings", cloud_settings())

    with pytest.raises(AccessDenied, match="Data APIs"):
        dependencies.get_repository()


@pytest.mark.parametrize(
    ("auth_host", "firestore_host"),
    [
        ("127.0.0.1:19099", "127.0.0.1:8081"),
        ("127.0.0.1:9099", "127.0.0.1:18081"),
    ],
)
def test_emulator_settings_require_fixed_endpoints(
    auth_host: str, firestore_host: str
) -> None:
    invalid = Settings(
        runtime_mode=EMULATOR_RUNTIME_MODE,
        app_env="local",
        firebase_project_id="demo-nodo",
        firebase_auth_emulator_host=auth_host,
        firestore_emulator_host=firestore_host,
    )

    with pytest.raises(RuntimeError, match="fixed loopback endpoint"):
        invalid.ensure_emulator_only()


@pytest.mark.parametrize(
    ("claim_overrides", "message"),
    [
        ({"aud": "unexpected-project"}, "invalid"),
        ({"iss": "https://securetoken.google.com/unexpected"}, "invalid"),
        ({"exp": FIXED_NOW}, "invalid"),
        ({"exp": True}, "invalid"),
        ({"uid": "", "sub": ""}, "invalid"),
        ({"uid": "invalid/path"}, "invalid"),
        ({"uid": "x" * 129}, "invalid"),
    ],
)
def test_invalid_identity_claims_are_unauthenticated(
    claim_overrides: dict[str, Any], message: str
) -> None:
    with pytest.raises(AuthenticationRequired, match=message):
        authorize(valid_claims(**claim_overrides))


def test_non_google_provider_is_forbidden() -> None:
    with pytest.raises(AccessDenied, match="Google Authentication"):
        authorize(
            valid_claims(firebase={"sign_in_provider": "password"})
        )


def test_unverified_email_is_forbidden() -> None:
    with pytest.raises(AccessDenied, match="verified Google email"):
        authorize(valid_claims(email_verified=False))


def test_verified_google_email_is_normalized_without_granting_a_role() -> None:
    identity = authorize(valid_claims(email="  OTHER@EXAMPLE.TEST  "))

    assert identity.email == "other@example.test"


def test_cloud_auth_settings_reject_wrong_project() -> None:
    invalid = Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id="unexpected-project",
        bootstrap_org_owner_emails=frozenset({SYNTHETIC_OWNER_EMAIL}),
    )

    with pytest.raises(RuntimeError, match="project"):
        invalid.ensure_cloud_auth_only()


def test_cloud_auth_settings_require_bootstrap_owner() -> None:
    invalid = Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        bootstrap_enabled=True,
        bootstrap_org_owner_emails=frozenset(),
    )

    with pytest.raises(RuntimeError, match="Bootstrap"):
        invalid.ensure_cloud_auth_only()


def test_cloud_auth_settings_allow_disabled_bootstrap_without_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for variable in (
        "FIREBASE_AUTH_EMULATOR_HOST",
        "FIRESTORE_EMULATOR_HOST",
        "FIREBASE_STORAGE_EMULATOR_HOST",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        monkeypatch.delenv(variable, raising=False)
    valid = Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        bootstrap_enabled=False,
        bootstrap_org_owner_emails=frozenset(),
    )

    valid.ensure_cloud_auth_only()


def test_cloud_auth_settings_reject_wildcard_owner() -> None:
    invalid = Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id=EXPECTED_CLOUD_FIREBASE_PROJECT_ID,
        bootstrap_org_owner_emails=frozenset({"*@example.test"}),
    )

    with pytest.raises(RuntimeError, match="invalid"):
        invalid.ensure_cloud_auth_only()


def test_cloud_auth_settings_reject_auth_emulator_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099")

    with pytest.raises(RuntimeError, match="Emulator"):
        cloud_settings().ensure_cloud_auth_only()


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
    application.dependency_overrides[
        get_cloud_organization_repository
    ] = StaticOwnerRepository
    transport = ASGITransport(app=application)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        yield client
    application.dependency_overrides.clear()


async def test_auth_me_requires_bearer_token(
    cloud_client: AsyncClient,
) -> None:
    response = await cloud_client.get("/api/auth/me")

    assert response.status_code == 401
    assert response.json()["code"] == "authentication_required"


async def test_auth_me_rejects_invalid_verified_token(
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    log_arguments: list[tuple[object, ...]] = []

    def invalid_token(_token: str, *, project_id: str) -> None:
        assert project_id == EXPECTED_CLOUD_FIREBASE_PROJECT_ID
        raise _auth_utils.InvalidIdTokenError(
            "Could not verify token signature. sensitive-marker",
        )

    def capture_warning(_message: str, *arguments: object) -> None:
        log_arguments.append(arguments)

    monkeypatch.setattr(dependencies, "verify_cloud_id_token", invalid_token)
    monkeypatch.setattr(dependencies.LOGGER, "warning", capture_warning)

    response = await cloud_client.get(
        "/api/auth/me",
        headers={"Authorization": "Bearer synthetic-token"},
    )

    assert response.status_code == 401
    assert response.json()["code"] == "authentication_required"
    assert log_arguments == [("SIGNATURE_INVALID",)]
    assert "synthetic-token" not in repr(log_arguments)
    assert "sensitive-marker" not in repr(log_arguments)


async def test_auth_me_ignores_browser_role_parameters(
    cloud_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def verified_token(_token: str, *, project_id: str) -> dict[str, Any]:
        assert project_id == EXPECTED_CLOUD_FIREBASE_PROJECT_ID
        return valid_claims()

    monkeypatch.setattr(dependencies, "verify_cloud_id_token", verified_token)

    response = await cloud_client.get(
        "/api/auth/me?accountType=STUDENT&organizationRole=INSTRUCTOR",
        headers={"Authorization": "Bearer synthetic-token"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["accountType"] == "STAFF"
    assert body["organizationRole"] == "ADMIN"
    assert body["isAdmin"] is True
    assert body["orgId"] == "demo"
    assert body["authorized"] is True


async def test_auth_me_returns_exact_bootstrap_required_error_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for variable in (
        "FIREBASE_AUTH_EMULATOR_HOST",
        "FIRESTORE_EMULATOR_HOST",
        "FIREBASE_STORAGE_EMULATOR_HOST",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        monkeypatch.delenv(variable, raising=False)

    def verified_token(_token: str, *, project_id: str) -> dict[str, Any]:
        assert project_id == EXPECTED_CLOUD_FIREBASE_PROJECT_ID
        return valid_claims()

    monkeypatch.setattr(dependencies, "verify_cloud_id_token", verified_token)
    application = create_app()
    application.dependency_overrides[get_runtime_settings] = cloud_settings
    application.dependency_overrides[
        get_cloud_organization_repository
    ] = EmptyOwnerRepository
    transport = ASGITransport(app=application)
    async with AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        response = await client.get(
            "/api/auth/me",
            headers={"Authorization": "Bearer synthetic-token"},
        )
    application.dependency_overrides.clear()

    assert response.status_code == 409
    assert response.json() == {
        "code": "ORGANIZATION_BOOTSTRAP_REQUIRED",
        "detail": "Organization setup is required",
    }


async def test_bootstrap_api_accepts_no_authoritative_browser_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for variable in (
        "FIREBASE_AUTH_EMULATOR_HOST",
        "FIRESTORE_EMULATOR_HOST",
        "FIREBASE_STORAGE_EMULATOR_HOST",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ):
        monkeypatch.delenv(variable, raising=False)
    captured: dict[str, Any] = {}

    class CapturingOrganizationService:
        def bootstrap_organization(self, identity: Any) -> dict[str, Any]:
            captured["identity"] = identity
            return {"orgId": "demo", "organizationRole": "ADMIN"}

    def verified_token(_token: str, *, project_id: str) -> dict[str, Any]:
        assert project_id == EXPECTED_CLOUD_FIREBASE_PROJECT_ID
        return valid_claims()

    monkeypatch.setattr(dependencies, "verify_cloud_id_token", verified_token)
    application = create_app()
    application.dependency_overrides[get_runtime_settings] = cloud_settings
    application.dependency_overrides[
        get_cloud_organization_service
    ] = CapturingOrganizationService
    transport = ASGITransport(app=application)
    async with AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/api/auth/bootstrap-organization",
            headers={"Authorization": "Bearer synthetic-token"},
            json={
                "orgId": "attacker-org",
                "name": "Attacker",
                "accountType": "STUDENT",
            },
        )
    application.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {
        "orgId": "demo",
        "organizationRole": "ADMIN",
    }
    assert captured["identity"].uid == SYNTHETIC_UID
    assert captured["identity"].email == SYNTHETIC_OWNER_EMAIL
