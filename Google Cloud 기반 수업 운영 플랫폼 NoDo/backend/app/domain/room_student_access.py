"""Shared end-of-room access policy for anonymous student read endpoints."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

DEFAULT_ENDED_STUDENT_ACCESS = timedelta(days=7)
STUDENT_ACCESS_WINDOWS = frozenset(
    {"IMMEDIATE", "ONE_DAY", "SEVEN_DAYS", "THIRTY_DAYS", "CUSTOM"}
)


def ended_student_access_deadline(room: Mapping[str, object]) -> datetime | None:
    """Return the one stored student cutoff, with a safe legacy fallback."""

    policy = room.get("materialDownloadPolicy")
    if isinstance(policy, Mapping):
        deadline = utc_datetime(policy.get("downloadAvailableUntil"))
        if deadline is not None:
            return deadline
    ended_at = utc_datetime(room.get("endedAt"))
    return ended_at + DEFAULT_ENDED_STUDENT_ACCESS if ended_at else None


def ended_student_access_open(room: Mapping[str, object], now: datetime) -> bool:
    """Only existing students may read an ENDED room before this deadline."""

    deadline = ended_student_access_deadline(room)
    normalized_now = utc_datetime(now)
    return deadline is not None and normalized_now is not None and normalized_now <= deadline


def resolve_student_access_deadline(
    *,
    window: object,
    custom_until: object,
    ended_at: datetime,
) -> datetime:
    """Validate a requested window and normalize the final cutoff to UTC."""

    normalized_end = utc_datetime(ended_at)
    if normalized_end is None:
        raise ValueError("ended_at must be timezone-aware")
    selected = "SEVEN_DAYS" if window is None else window
    if not isinstance(selected, str) or selected not in STUDENT_ACCESS_WINDOWS:
        raise ValueError("unknown student access window")
    if selected == "IMMEDIATE":
        if custom_until is not None:
            raise ValueError("immediate access cannot include a custom deadline")
        return normalized_end
    if selected == "ONE_DAY":
        if custom_until is not None:
            raise ValueError("fixed access cannot include a custom deadline")
        return normalized_end + timedelta(days=1)
    if selected == "SEVEN_DAYS":
        if custom_until is not None:
            raise ValueError("fixed access cannot include a custom deadline")
        return normalized_end + DEFAULT_ENDED_STUDENT_ACCESS
    if selected == "THIRTY_DAYS":
        if custom_until is not None:
            raise ValueError("fixed access cannot include a custom deadline")
        return normalized_end + timedelta(days=30)
    if (
        not isinstance(custom_until, datetime)
        or custom_until.tzinfo is None
        or custom_until.utcoffset() != timedelta(hours=9)
    ):
        raise ValueError("custom access must use KST")
    deadline = utc_datetime(custom_until)
    if deadline is None:
        raise ValueError("custom access requires a timezone-aware deadline")
    if deadline < normalized_end:
        raise ValueError("custom access cannot end before the room")
    return deadline


def utc_datetime(value: object) -> datetime | None:
    """Accept Firestore/Pydantic datetimes or ISO timestamps with an offset."""

    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime) or value.tzinfo is None:
        return None
    return value.astimezone(UTC)
