import math
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from app.domain.errors import AccessDenied, AuthenticationRequired

ANONYMOUS_SIGN_IN_PROVIDER = "anonymous"


@dataclass(frozen=True)
class VerifiedStudentIdentity:
    # This value stays inside the service layer.  Public API responses must
    # never serialize an anonymous Firebase uid.
    uid: str
    provider: Literal["anonymous"] = ANONYMOUS_SIGN_IN_PROVIDER


def authorize_anonymous_student(
    claims: Mapping[str, Any],
    *,
    project_id: str,
    clock: Callable[[], float] = time.time,
) -> VerifiedStudentIdentity:
    """Validate trusted Firebase claims without exposing the temporary UID."""

    expected_issuer = f"https://securetoken.google.com/{project_id}"
    expires_at = claims.get("exp")
    subject = claims.get("sub")
    uid = claims.get("uid")
    if (
        claims.get("aud") != project_id
        or claims.get("iss") != expected_issuer
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, (int, float))
        or not math.isfinite(expires_at)
        or expires_at <= clock()
        or not isinstance(subject, str)
        or not subject
        or len(subject) > 128
        or not isinstance(uid, str)
        or uid != subject
    ):
        raise AuthenticationRequired("The Firebase ID token is invalid")

    firebase_claim = claims.get("firebase")
    provider = (
        firebase_claim.get("sign_in_provider")
        if isinstance(firebase_claim, Mapping)
        else None
    )
    if provider != ANONYMOUS_SIGN_IN_PROVIDER:
        raise AccessDenied("Anonymous student Authentication is required")

    return VerifiedStudentIdentity(uid=uid)
