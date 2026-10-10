import hashlib
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

RAW_INVITATION_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
TOKEN_HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$")


class StaffInvitationStatus(StrEnum):
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    DECLINED = "DECLINED"
    EXPIRED = "EXPIRED"
    REVOKED = "REVOKED"


def normalize_staff_email(value: object, *, allowed_domains: frozenset[str]) -> str:
    if not isinstance(value, str):
        raise ValueError("A company Google email is required")
    normalized = value.strip().lower()
    if (
        not normalized
        or len(normalized) > 254
        or normalized.count("@") != 1
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("Enter a valid company Google email")
    local_part, domain = normalized.split("@", maxsplit=1)
    if not local_part or domain not in allowed_domains:
        raise ValueError("Only an approved company Google email can be invited")
    return normalized


def staff_invitation_id(org_id: str, normalized_email: str) -> str:
    value = f"{org_id}\0{normalized_email}".encode()
    return hashlib.sha256(value).hexdigest()


def staff_invitation_event_id(action: str, invitation_id: str, revision: int) -> str:
    return f"staff-invitation-{action}-{invitation_id}-r{revision}"


def invitation_token_hash(raw_token: str) -> str:
    scoped_token = f"nodo-organization-invitation\0{raw_token}".encode()
    return hashlib.sha256(scoped_token).hexdigest()


def valid_raw_invitation_token(value: object) -> bool:
    return isinstance(value, str) and bool(
        RAW_INVITATION_TOKEN_PATTERN.fullmatch(value)
    )


def aware_datetime(value: object) -> datetime | None:
    if not isinstance(value, datetime) or value.tzinfo is None:
        return None
    return value.astimezone(UTC)


def invitation_email(invitation: Mapping[str, Any]) -> object:
    return invitation.get("invitedEmail", invitation.get("emailNormalized"))


def is_well_formed_invitation(
    invitation: Mapping[str, Any],
    *,
    invitation_id: str,
    org_id: str,
    email: str,
) -> bool:
    revision = invitation.get("revision")
    status = invitation.get("status")
    schema_version = invitation.get("schemaVersion")
    created_by_uid = invitation.get(
        "createdByUid", invitation.get("invitedByUid")
    )
    common_fields_are_valid = (
        invitation.get("id") == invitation_id
        and invitation.get("orgId") == org_id
        and invitation_email(invitation) == email
        and status in {item.value for item in StaffInvitationStatus}
        and isinstance(revision, int)
        and not isinstance(revision, bool)
        and revision >= 1
        and isinstance(created_by_uid, str)
        and bool(created_by_uid)
        and schema_version in {1, 2}
        and aware_datetime(invitation.get("createdAt")) is not None
        and aware_datetime(invitation.get("updatedAt")) is not None
        and aware_datetime(invitation.get("expiresAt")) is not None
        and "acceptedAt" in invitation
        and "revokedAt" in invitation
    )
    if not common_fields_are_valid:
        return False

    if schema_version == 2:
        if (
            invitation.get("invitedOrganizationRole") != "INSTRUCTOR"
            or not isinstance(invitation.get("tokenHash"), str)
            or not TOKEN_HASH_PATTERN.fullmatch(invitation["tokenHash"])
            or "declinedAt" not in invitation
        ):
            return False

    accepted_at = invitation.get("acceptedAt")
    declined_at = invitation.get("declinedAt")
    revoked_at = invitation.get("revokedAt")
    terminal_values = (accepted_at, declined_at, revoked_at)
    if status in {
        StaffInvitationStatus.PENDING.value,
        StaffInvitationStatus.EXPIRED.value,
    }:
        return all(value is None for value in terminal_values)
    if status == StaffInvitationStatus.ACCEPTED.value:
        return (
            aware_datetime(accepted_at) is not None
            and declined_at is None
            and revoked_at is None
        )
    if status == StaffInvitationStatus.DECLINED.value:
        return (
            accepted_at is None
            and aware_datetime(declined_at) is not None
            and revoked_at is None
        )
    return (
        accepted_at is None
        and declined_at is None
        and aware_datetime(revoked_at) is not None
    )


def is_active_pending_invitation(
    invitation: Mapping[str, Any], *, now: datetime
) -> bool:
    expires_at = aware_datetime(invitation.get("expiresAt"))
    return (
        invitation.get("status") == StaffInvitationStatus.PENDING.value
        and expires_at is not None
        and expires_at > now.astimezone(UTC)
    )


def effective_invitation_status(
    invitation: Mapping[str, Any], *, now: datetime
) -> str:
    if (
        invitation.get("status") == StaffInvitationStatus.PENDING.value
        and not is_active_pending_invitation(invitation, now=now)
    ):
        return StaffInvitationStatus.EXPIRED.value
    status = invitation.get("status")
    return status if isinstance(status, str) else ""
