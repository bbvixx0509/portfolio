import os
from collections.abc import Mapping
from typing import Any

import firebase_admin
from firebase_admin import auth, credentials
from google.auth.credentials import AnonymousCredentials

from app.core.config import EXPECTED_CLOUD_FIREBASE_PROJECT_ID

CLOUD_AUTH_FIREBASE_APP_NAME = "nodo-cloud-auth"


def firebase_id_token_failure_code(error: BaseException) -> str:
    """Return a safe local diagnostic code without exposing token contents."""

    error_name = type(error).__name__
    message = str(error).lower()
    if error_name == "ExpiredIdTokenError" or "token expired" in message:
        return "TOKEN_EXPIRED"
    if error_name == "CertificateFetchError":
        return "CERTIFICATE_FETCH_FAILED"
    if 'incorrect "aud"' in message:
        return "AUDIENCE_MISMATCH"
    if 'incorrect "iss"' in message:
        return "ISSUER_MISMATCH"
    if 'no "kid"' in message or "incorrect algorithm" in message:
        return "TOKEN_HEADER_INVALID"
    if "certificate for key id" in message:
        return "SIGNING_KEY_NOT_FOUND"
    if "signature" in message:
        return "SIGNATURE_INVALID"
    if error_name == "InvalidIdTokenError":
        return "ID_TOKEN_INVALID"
    if isinstance(error, ValueError):
        return "TOKEN_MALFORMED"
    return "FIREBASE_VERIFICATION_FAILED"


class AuthVerificationCredential(credentials.Base):
    """Public-key verification credential with no service-account access."""

    def get_credential(self) -> AnonymousCredentials:
        return AnonymousCredentials()


def get_cloud_auth_app(project_id: str) -> firebase_admin.App:
    if project_id != EXPECTED_CLOUD_FIREBASE_PROJECT_ID:
        raise RuntimeError("The Cloud Authentication project is not allowed")
    if os.getenv("FIREBASE_AUTH_EMULATOR_HOST"):
        raise RuntimeError("The Auth Emulator is forbidden in cloud-auth mode")
    try:
        return firebase_admin.get_app(CLOUD_AUTH_FIREBASE_APP_NAME)
    except ValueError:
        return firebase_admin.initialize_app(
            AuthVerificationCredential(),
            {"projectId": project_id},
            name=CLOUD_AUTH_FIREBASE_APP_NAME,
        )


def verify_cloud_id_token(token: str, *, project_id: str) -> Mapping[str, Any]:
    """Verify a real Firebase ID token using Google's public signing keys."""

    return auth.verify_id_token(
        token,
        app=get_cloud_auth_app(project_id),
        check_revoked=False,
        clock_skew_seconds=0,
    )
