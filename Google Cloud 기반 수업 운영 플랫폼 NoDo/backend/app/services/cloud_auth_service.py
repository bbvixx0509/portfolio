import hmac
import math
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from app.domain.errors import AccessDenied, AuthenticationRequired

GOOGLE_SIGN_IN_PROVIDER = "google.com"


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def matches_bootstrap_owner(
    email: str, bootstrap_org_owner_emails: frozenset[str]
) -> bool:
    normalized_email = email.strip().lower()
    matches = False
    for allowed_email in bootstrap_org_owner_emails:
        matches = hmac.compare_digest(normalized_email, allowed_email) or matches
    return matches


@dataclass(frozen=True)
class VerifiedCloudIdentity:
    uid: str
    email: str
    display_name: str | None
    photo_url: str | None
    provider: str = GOOGLE_SIGN_IN_PROVIDER
    email_verified: bool = True


def verify_cloud_google_identity(
    claims: Mapping[str, Any],
    *,
    project_id: str,
    clock: Callable[[], float] = time.time,
) -> VerifiedCloudIdentity:
    """Validate trusted Firebase claims without deriving an organization role."""

    expected_issuer = f"https://securetoken.google.com/{project_id}"
    expires_at = claims.get("exp")
    if (
        claims.get("aud") != project_id
        or claims.get("iss") != expected_issuer
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, (int, float))
        or not math.isfinite(expires_at)
        or expires_at <= clock()
    ):
        raise AuthenticationRequired("The Firebase ID token is invalid")

    uid = claims.get("uid") or claims.get("sub")
    if (
        not isinstance(uid, str)
        or not uid
        or len(uid) > 128
        or "/" in uid
        or any(ord(character) < 32 for character in uid)
    ):
        raise AuthenticationRequired("The Firebase ID token is invalid")

    firebase_claim = claims.get("firebase")
    provider = (
        firebase_claim.get("sign_in_provider")
        if isinstance(firebase_claim, Mapping)
        else None
    )
    if provider != GOOGLE_SIGN_IN_PROVIDER:
        raise AccessDenied("Google Authentication is required")
    if claims.get("email_verified") is not True:
        raise AccessDenied("A verified Google email is required")

    email = claims.get("email")
    if not isinstance(email, str) or not email.strip():
        raise AccessDenied("A verified Google email is required")

    return VerifiedCloudIdentity(
        uid=uid,
        email=email.strip().lower(),
        display_name=_optional_text(claims.get("name")),
        photo_url=_optional_text(claims.get("picture")),
    )
