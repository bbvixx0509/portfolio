class DomainError(Exception):
    status_code = 400
    code = "domain_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class AuthenticationRequired(DomainError):
    status_code = 401
    code = "authentication_required"


class AccessDenied(DomainError):
    status_code = 403
    code = "access_denied"


class ResourceNotFound(DomainError):
    status_code = 404
    code = "not_found"


class ResourceConflict(DomainError):
    status_code = 409
    code = "conflict"


class LastOrganizationAdministrator(ResourceConflict):
    code = "last_organization_administrator"


class StaffMemberHasActiveRoomRole(ResourceConflict):
    code = "staff_member_has_active_room_role"

    def __init__(
        self,
        message: str,
        *,
        blocking_rooms: list[dict[str, str]] | None = None,
    ) -> None:
        super().__init__(message)
        rooms = (blocking_rooms or [])[:3]
        remaining = max(0, len(blocking_rooms or []) - len(rooms))
        self.public_details = {
            "blockingRooms": rooms,
            "remainingBlockingRoomCount": remaining,
        }


class OrganizationBootstrapRequired(ResourceConflict):
    code = "ORGANIZATION_BOOTSTRAP_REQUIRED"


class OrganizationInvitationAcceptanceRequired(ResourceConflict):
    code = "ORGANIZATION_INVITATION_ACCEPTANCE_REQUIRED"

    def __init__(
        self,
        message: str,
        *,
        organization_name: str,
        expires_at: str,
    ) -> None:
        super().__init__(message)
        self.public_details = {
            "organizationName": organization_name,
            "expiresAt": expires_at,
        }


class InvitationEmailMismatch(AccessDenied):
    code = "invitation_email_mismatch"


class InvitationExpired(ResourceConflict):
    code = "invitation_expired"


class InvitationRevoked(ResourceConflict):
    code = "invitation_revoked"


class InvitationAlreadyProcessed(ResourceConflict):
    code = "invitation_already_processed"


class InvalidInvitationToken(ResourceNotFound):
    code = "invalid_invitation_token"


class InvitationEmailUnavailable(DomainError):
    status_code = 503
    code = "invitation_email_unavailable"
    headers = {"Retry-After": "1"}


class InvalidOperation(DomainError):
    status_code = 422
    code = "invalid_operation"


class SelfMembershipRemoval(InvalidOperation):
    code = "self_membership_removal"


class ServiceTemporarilyUnavailable(DomainError):
    status_code = 503
    code = "temporarily_unavailable"
    headers = {"Retry-After": "1"}


class StorageQuotaExceeded(ResourceConflict):
    """A safe, quota-specific conflict which never exposes other users' usage."""

    code = "storage_quota_exceeded"

    def __init__(self, message: str, *, quota_scope: str) -> None:
        super().__init__(message)
        self.public_details = {"quotaScope": quota_scope}


class QuestionRejected(DomainError):
    status_code = 422
    code = "question_rejected"


class QuestionRateLimited(DomainError):
    status_code = 429
    code = "question_rate_limited"
    headers = {"Retry-After": "10"}
