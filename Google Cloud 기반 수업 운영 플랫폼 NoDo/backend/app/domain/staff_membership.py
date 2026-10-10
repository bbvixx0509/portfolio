from collections.abc import Mapping
from typing import Any

ACTIVE_MEMBERSHIP = "ACTIVE"
REMOVED_MEMBERSHIP = "REMOVED"


def membership_status(document: Mapping[str, Any]) -> str:
    """Treat legacy staff documents without a status as active."""

    value = document.get("membershipStatus", ACTIVE_MEMBERSHIP)
    return value if isinstance(value, str) else ""


def has_active_membership(document: Mapping[str, Any] | None) -> bool:
    return bool(
        document is not None
        and membership_status(document) == ACTIVE_MEMBERSHIP
    )
