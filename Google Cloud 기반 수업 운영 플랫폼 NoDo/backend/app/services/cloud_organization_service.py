from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, TypeVar

from app.core.config import Settings
from app.domain.errors import (
    AccessDenied,
    InvitationExpired,
    OrganizationBootstrapRequired,
    OrganizationInvitationAcceptanceRequired,
    ResourceConflict,
)
from app.domain.staff_invitations import (
    aware_datetime,
    is_active_pending_invitation,
    is_well_formed_invitation,
    normalize_staff_email,
    staff_invitation_id,
)
from app.domain.staff_membership import REMOVED_MEMBERSHIP, membership_status
from app.services.cloud_auth_service import (
    VerifiedCloudIdentity,
    matches_bootstrap_owner,
)

BOOTSTRAP_AUDIT_LOG_ID = "bootstrap-owner-created"
SCHEMA_VERSION = 1
ADMIN = "ADMIN"
INSTRUCTOR = "INSTRUCTOR"
ORGANIZATION_ROLES = frozenset({ADMIN, INSTRUCTOR})


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class OwnerDocuments:
    """Legacy repository bundle; its name does not define authorization."""

    organization: Mapping[str, Any] | None
    user: Mapping[str, Any] | None
    audit_log: Mapping[str, Any] | None


class CloudOrganizationTransaction(Protocol):
    @property
    def server_timestamp(self) -> object: ...

    def read_owner_documents(
        self, *, org_id: str, uid: str, audit_log_id: str
    ) -> OwnerDocuments: ...

    def create_document(self, path: str, document: Mapping[str, Any]) -> None: ...

    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def find_users_by_email(
        self, *, org_id: str, email: str
    ) -> list[Mapping[str, Any]]: ...

    def find_staff_invitations_by_token_hash(
        self, *, org_id: str, token_hash: str
    ) -> list[Mapping[str, Any]]: ...

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None: ...

    def list_active_rooms(self, *, org_id: str) -> list[Mapping[str, Any]]: ...


TransactionResult = TypeVar("TransactionResult")


class CloudOrganizationRepository(Protocol):
    def read_owner_documents(
        self, *, org_id: str, uid: str, audit_log_id: str
    ) -> OwnerDocuments: ...

    def run_transaction(
        self,
        callback: Callable[[CloudOrganizationTransaction], TransactionResult],
    ) -> TransactionResult: ...

    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]: ...

    def find_users_by_email(
        self, *, org_id: str, email: str
    ) -> list[Mapping[str, Any]]: ...

    def list_staff_invitations(self, *, org_id: str) -> list[Mapping[str, Any]]: ...


def _all_documents_missing(documents: OwnerDocuments) -> bool:
    return (
        documents.organization is None
        and documents.user is None
        and documents.audit_log is None
    )


def _has_valid_timestamps(document: Mapping[str, Any], *names: str) -> bool:
    return all(name in document and document[name] is not None for name in names)


class CloudOrganizationService:
    """Cloud-auth profile and bootstrap service using organizationRole only."""

    def __init__(
        self,
        repository: CloudOrganizationRepository,
        runtime_settings: Settings,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self.repository = repository
        self.settings = runtime_settings
        self.clock = clock

    def authenticated_user(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        documents = self.repository.read_owner_documents(
            org_id=self.settings.bootstrap_org_id,
            uid=identity.uid,
            audit_log_id=BOOTSTRAP_AUDIT_LOG_ID,
        )
        organization = documents.organization
        user = documents.user
        if user is not None:
            if not self._is_valid_organization(organization):
                raise ResourceConflict("Organization documents are inconsistent")
            if membership_status(user) == REMOVED_MEMBERSHIP:
                normalized_email = self._normalize_login_email(identity.email)
                if not (
                    user.get("uid") == identity.uid
                    and user.get("orgId") == self.settings.bootstrap_org_id
                    and user.get("accountType") == "STAFF"
                    and user.get("email") == normalized_email
                ):
                    raise AccessDenied(
                        "승인된 회사 Google 계정으로 로그인해 주세요."
                    )
                self._require_pending_login_approval(normalized_email)
            if self._is_valid_staff(user, identity.uid):
                return self._authenticated_response(
                    identity, organization_role=user["organizationRole"]
                )
            # Deliberately do not infer a new authority from legacy Boolean fields.
            raise ResourceConflict(
                "Organization role migration is required before this account "
                "can continue"
            )

        if organization is not None:
            if not self._is_valid_organization(organization):
                raise ResourceConflict("Organization documents are inconsistent")
            normalized_email = self._normalize_login_email(identity.email)
            self._require_pending_login_approval(normalized_email)

        if not _all_documents_missing(documents):
            raise ResourceConflict("Organization documents are inconsistent")
        if self._bootstrap_is_allowed(identity):
            raise OrganizationBootstrapRequired("Organization setup is required")
        raise AccessDenied("승인된 회사 Google 계정으로 로그인해 주세요.")

    def _normalize_login_email(self, email: object) -> str:
        try:
            return normalize_staff_email(
                email,
                allowed_domains=self.settings.staff_email_domains,
            )
        except ValueError:
            raise AccessDenied(
                "승인된 회사 Google 계정으로 로그인해 주세요."
            ) from None

    def _require_pending_login_approval(self, normalized_email: str) -> None:
        invitation_id = staff_invitation_id(
            self.settings.bootstrap_org_id, normalized_email
        )
        invitation = self.repository.read_document(
            f"organizations/{self.settings.bootstrap_org_id}/staffInvitations/{invitation_id}"
        )
        if invitation is None or not is_well_formed_invitation(
            invitation,
            invitation_id=invitation_id,
            org_id=self.settings.bootstrap_org_id,
            email=normalized_email,
        ):
            raise AccessDenied("승인된 회사 Google 계정으로 로그인해 주세요.")
        if is_active_pending_invitation(invitation, now=self.clock()):
            expires_at = aware_datetime(invitation.get("expiresAt"))
            if expires_at is None:
                raise ResourceConflict(
                    "Organization invitation documents are inconsistent"
                )
            raise OrganizationInvitationAcceptanceRequired(
                "Organization login approval acceptance is required",
                organization_name=self.settings.bootstrap_org_name,
                expires_at=expires_at.isoformat(),
            )
        expires_at = aware_datetime(invitation.get("expiresAt"))
        if invitation.get("status") == "PENDING" and (
            expires_at is None or expires_at <= self.clock().astimezone(UTC)
        ):
            raise InvitationExpired(
                "조직 로그인 승인이 만료되었습니다. 관리자에게 새 승인을 요청해 주세요."
            )
        raise AccessDenied("승인된 회사 Google 계정으로 로그인해 주세요.")

    def bootstrap_organization(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        if not self._bootstrap_is_allowed(identity):
            raise AccessDenied("Organization setup is not allowed")

        def create_or_reuse(transaction: CloudOrganizationTransaction) -> None:
            documents = transaction.read_owner_documents(
                org_id=self.settings.bootstrap_org_id,
                uid=identity.uid,
                audit_log_id=BOOTSTRAP_AUDIT_LOG_ID,
            )
            if _all_documents_missing(documents):
                self._create_bootstrap_documents(transaction, identity)
                return
            if (
                self._is_valid_organization(documents.organization)
                and documents.user is not None
                and self._is_valid_staff(documents.user, identity.uid)
                and documents.user["organizationRole"] == ADMIN
            ):
                return
            raise ResourceConflict("Organization documents are inconsistent")

        self.repository.run_transaction(create_or_reuse)
        return self._authenticated_response(identity, organization_role=ADMIN)

    def _bootstrap_is_allowed(self, identity: VerifiedCloudIdentity) -> bool:
        return self.settings.bootstrap_enabled and matches_bootstrap_owner(
            identity.email,
            self.settings.bootstrap_org_owner_emails,
        )

    def _create_bootstrap_documents(
        self,
        transaction: CloudOrganizationTransaction,
        identity: VerifiedCloudIdentity,
    ) -> None:
        org_id = self.settings.bootstrap_org_id
        timestamp = transaction.server_timestamp
        transaction.create_document(
            f"organizations/{org_id}",
            {
                "id": org_id,
                "orgId": org_id,
                "name": self.settings.bootstrap_org_name,
                "bootstrapState": "COMPLETED",
                "adminCount": 1,
                "schemaVersion": SCHEMA_VERSION,
                "createdAt": timestamp,
                "updatedAt": timestamp,
            },
        )
        transaction.create_document(
            f"users/{identity.uid}",
            {
                "uid": identity.uid,
                "orgId": org_id,
                "accountType": "STAFF",
                "organizationRole": ADMIN,
                "organizationRoleRevision": 1,
                "isAnonymous": False,
                "email": identity.email,
                "displayName": identity.display_name,
                "photoURL": identity.photo_url,
                "schemaVersion": SCHEMA_VERSION,
                "createdAt": timestamp,
                "updatedAt": timestamp,
            },
        )
        transaction.create_document(
            f"organizations/{org_id}/auditLogs/{BOOTSTRAP_AUDIT_LOG_ID}",
            {
                "eventType": "BOOTSTRAP_ORGANIZATION_CREATED",
                "orgId": org_id,
                "actorUid": identity.uid,
                "targetUid": identity.uid,
                "before": None,
                "after": {"accountType": "STAFF", "organizationRole": ADMIN},
                "schemaVersion": SCHEMA_VERSION,
                "createdAt": timestamp,
            },
        )

    def _authenticated_response(
        self,
        identity: VerifiedCloudIdentity,
        *,
        organization_role: str,
    ) -> dict[str, Any]:
        return {
            "uid": identity.uid,
            "orgId": self.settings.bootstrap_org_id,
            "displayName": identity.display_name,
            "email": identity.email,
            "photoURL": identity.photo_url,
            "accountType": "STAFF",
            "organizationRole": organization_role,
            "isAdmin": organization_role == ADMIN,
            "isAnonymous": False,
            "provider": identity.provider,
            "emailVerified": identity.email_verified,
            "authorized": True,
        }

    def _is_valid_organization(self, organization: Mapping[str, Any] | None) -> bool:
        return bool(
            organization
            and organization.get("id") == self.settings.bootstrap_org_id
            and organization.get("orgId") == self.settings.bootstrap_org_id
            and organization.get("name") == self.settings.bootstrap_org_name
            and organization.get("bootstrapState") == "COMPLETED"
            and isinstance(organization.get("adminCount"), int)
            and organization["adminCount"] >= 1
            and organization.get("schemaVersion") == SCHEMA_VERSION
            and _has_valid_timestamps(organization, "createdAt", "updatedAt")
        )

    def _is_valid_staff(self, user: Mapping[str, Any], uid: str) -> bool:
        email = user.get("email")
        return bool(
            user.get("uid") == uid
            and user.get("orgId") == self.settings.bootstrap_org_id
            and user.get("accountType") == "STAFF"
            and user.get("membershipStatus", "ACTIVE") == "ACTIVE"
            and user.get("organizationRole") in ORGANIZATION_ROLES
            and isinstance(user.get("organizationRoleRevision"), int)
            and user["organizationRoleRevision"] >= 1
            and user.get("isAnonymous") is False
            and isinstance(email, str)
            and bool(email)
            and email == email.strip().lower()
            and "displayName" in user
            and "photoURL" in user
            and user.get("schemaVersion") == SCHEMA_VERSION
            and _has_valid_timestamps(user, "createdAt", "updatedAt")
        )
