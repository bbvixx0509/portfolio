import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from app.core.config import Settings
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    ResourceConflict,
    ResourceNotFound,
)
from app.domain.staff_invitations import (
    StaffInvitationStatus,
    invitation_email,
    is_active_pending_invitation,
    is_well_formed_invitation,
    normalize_staff_email,
    staff_invitation_event_id,
    staff_invitation_id,
)
from app.domain.staff_membership import (
    REMOVED_MEMBERSHIP,
    has_active_membership,
)
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import (
    ADMIN,
    BOOTSTRAP_AUDIT_LOG_ID,
    INSTRUCTOR,
    ORGANIZATION_ROLES,
    SCHEMA_VERSION,
    CloudOrganizationRepository,
    CloudOrganizationTransaction,
    OwnerDocuments,
)

INVITATION_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")


def _utc_now() -> datetime:
    return datetime.now(UTC)


class CloudStaffService:
    def __init__(
        self,
        repository: CloudOrganizationRepository,
        runtime_settings: Settings,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self.repository = repository
        self.settings = runtime_settings
        self.clock = clock

    def list_members(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        self._require_organization_admin(self._read_management(identity), identity)
        members = [
            self._public_member(document)
            for document in self.repository.list_staff_members(
                org_id=self.settings.bootstrap_org_id
            )
            if has_active_membership(document)
        ]
        members.sort(key=lambda member: (member["email"], member["displayName"] or ""))
        return {
            "organization": {
                "id": self.settings.bootstrap_org_id,
                "name": self.settings.bootstrap_org_name,
            },
            "members": members,
            "count": len(members),
        }

    def list_invitations(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        self._require_organization_admin(self._read_management(identity), identity)
        invitations = [
            self._public_invitation(document)
            for document in self.repository.list_staff_invitations(
                org_id=self.settings.bootstrap_org_id
            )
        ]
        invitations.sort(
            key=lambda invitation: str(invitation["updatedAt"]), reverse=True
        )
        return {"invitations": invitations}

    def create_invitation(
        self, identity: VerifiedCloudIdentity, email: object
    ) -> dict[str, Any]:
        # Fail closed before validating or looking up the requested address. The
        # The same administrator state is checked again in the transaction so a
        # preflight read can never authorize a write.
        self._require_organization_admin(self._read_management(identity), identity)
        normalized_email = self._normalize_email(email)
        if normalized_email == identity.email:
            raise InvalidOperation("You cannot invite your own account")

        org_id = self.settings.bootstrap_org_id
        invitation_id = staff_invitation_id(org_id, normalized_email)
        invitation_path = self._invitation_path(invitation_id)
        now = self.clock().astimezone(UTC)
        expires_at = now + timedelta(hours=self.settings.staff_invitation_ttl_hours)

        def create_or_reissue(
            transaction: CloudOrganizationTransaction,
        ) -> None:
            owner_documents = transaction.read_owner_documents(
                org_id=org_id,
                uid=identity.uid,
                audit_log_id=BOOTSTRAP_AUDIT_LOG_ID,
            )
            self._require_organization_admin(owner_documents, identity)
            invitation = transaction.read_document(invitation_path)
            existing_users = transaction.find_users_by_email(
                org_id=org_id, email=normalized_email
            )
            if existing_users:
                raise ResourceConflict("This employee is already a member")

            if invitation is None:
                revision = 1
                event_type = "STAFF_INVITATION_CREATED"
                event_action = "created"
                before = None
            else:
                self._require_valid_invitation(
                    invitation,
                    invitation_id=invitation_id,
                    email=normalized_email,
                )
                revision = int(invitation["revision"])
                if invitation.get("status") == StaffInvitationStatus.ACCEPTED:
                    raise ResourceConflict("This employee is already a member")
                if is_active_pending_invitation(invitation, now=now):
                    self._require_existing_issue_audit(
                        transaction, invitation, invitation_id
                    )
                    return
                before = {
                    "status": invitation.get("status"),
                    "revision": revision,
                }
                revision += 1
                event_type = "STAFF_INVITATION_REISSUED"
                event_action = "reissued"

            event_id = staff_invitation_event_id(event_action, invitation_id, revision)
            audit_path = self._audit_path(event_id)
            if transaction.read_document(audit_path) is not None:
                raise ResourceConflict("Invitation audit documents are inconsistent")

            timestamp = transaction.server_timestamp
            if invitation is None:
                transaction.create_document(
                    invitation_path,
                    {
                        "id": invitation_id,
                        "orgId": org_id,
                        "emailNormalized": normalized_email,
                        "status": StaffInvitationStatus.PENDING.value,
                        "revision": revision,
                        "invitedByUid": identity.uid,
                        "createdAt": timestamp,
                        "updatedAt": timestamp,
                        "expiresAt": expires_at,
                        "acceptedAt": None,
                        "acceptedByUid": None,
                        "revokedAt": None,
                        "revokedByUid": None,
                        "schemaVersion": SCHEMA_VERSION,
                    },
                )
            else:
                transaction.update_document(
                    invitation_path,
                    {
                        "status": StaffInvitationStatus.PENDING.value,
                        "revision": revision,
                        "invitedByUid": identity.uid,
                        "updatedAt": timestamp,
                        "expiresAt": expires_at,
                        "acceptedAt": None,
                        "acceptedByUid": None,
                        "revokedAt": None,
                        "revokedByUid": None,
                    },
                )
            transaction.create_document(
                audit_path,
                self._audit_document(
                    event_type=event_type,
                    actor_uid=identity.uid,
                    target_uid=None,
                    invitation_id=invitation_id,
                    revision=revision,
                    before=before,
                    after={
                        "status": StaffInvitationStatus.PENDING.value,
                        "revision": revision,
                    },
                    timestamp=timestamp,
                ),
            )

        self.repository.run_transaction(create_or_reissue)
        return self._read_public_invitation(invitation_path)

    def revoke_invitation(
        self, identity: VerifiedCloudIdentity, invitation_id: str
    ) -> dict[str, Any]:
        self._require_organization_admin(self._read_management(identity), identity)
        if not INVITATION_ID_PATTERN.fullmatch(invitation_id):
            raise ResourceNotFound("Staff invitation not found")
        invitation_path = self._invitation_path(invitation_id)

        def revoke(transaction: CloudOrganizationTransaction) -> None:
            owner_documents = transaction.read_owner_documents(
                org_id=self.settings.bootstrap_org_id,
                uid=identity.uid,
                audit_log_id=BOOTSTRAP_AUDIT_LOG_ID,
            )
            self._require_organization_admin(owner_documents, identity)
            invitation = transaction.read_document(invitation_path)
            if invitation is None:
                raise ResourceNotFound("Staff invitation not found")
            email = invitation.get("emailNormalized")
            if not isinstance(email, str):
                raise ResourceConflict("Invitation documents are inconsistent")
            self._require_valid_invitation(
                invitation, invitation_id=invitation_id, email=email
            )
            if invitation.get("status") != StaffInvitationStatus.PENDING.value:
                raise ResourceConflict("Only a pending invitation can be revoked")

            revision = int(invitation["revision"])
            event_id = staff_invitation_event_id("revoked", invitation_id, revision)
            audit_path = self._audit_path(event_id)
            if transaction.read_document(audit_path) is not None:
                raise ResourceConflict("Invitation audit documents are inconsistent")
            timestamp = transaction.server_timestamp
            transaction.update_document(
                invitation_path,
                {
                    "status": StaffInvitationStatus.REVOKED.value,
                    "revokedAt": timestamp,
                    "revokedByUid": identity.uid,
                    "updatedAt": timestamp,
                },
            )
            transaction.create_document(
                audit_path,
                self._audit_document(
                    event_type="STAFF_INVITATION_REVOKED",
                    actor_uid=identity.uid,
                    target_uid=None,
                    invitation_id=invitation_id,
                    revision=revision,
                    before={
                        "status": StaffInvitationStatus.PENDING.value,
                        "revision": revision,
                    },
                    after={
                        "status": StaffInvitationStatus.REVOKED.value,
                        "revision": revision,
                    },
                    timestamp=timestamp,
                ),
            )

        self.repository.run_transaction(revoke)
        return self._read_public_invitation(invitation_path)

    def accept_invitation(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        normalized_email = self._normalize_email_for_auth(identity.email)
        org_id = self.settings.bootstrap_org_id
        invitation_id = staff_invitation_id(org_id, normalized_email)
        invitation_path = self._invitation_path(invitation_id)
        user_path = f"users/{identity.uid}"
        now = self.clock().astimezone(UTC)

        def accept(transaction: CloudOrganizationTransaction) -> None:
            organization = transaction.read_document(f"organizations/{org_id}")
            invitation = transaction.read_document(invitation_path)
            existing_user = transaction.read_document(user_path)
            if invitation is None:
                raise AccessDenied("No active organization invitation was found")
            email = invitation_email(invitation)
            if not isinstance(email, str):
                raise AccessDenied("No active organization invitation was found")
            self._require_valid_invitation(
                invitation, invitation_id=invitation_id, email=email
            )
            revision = int(invitation["revision"])
            event_id = staff_invitation_event_id("accepted", invitation_id, revision)
            audit_path = self._audit_path(event_id)
            existing_audit = transaction.read_document(audit_path)
            active_email_users = [
                user
                for user in transaction.find_users_by_email(
                    org_id=org_id, email=normalized_email
                )
                if has_active_membership(user)
            ]

            if not self._valid_organization(organization):
                raise ResourceConflict("Organization documents are inconsistent")
            if active_email_users:
                raise ResourceConflict("This account is already a member")
            if email != normalized_email or not is_active_pending_invitation(
                invitation, now=now
            ):
                raise AccessDenied("No active organization invitation was found")
            if existing_audit is not None:
                raise ResourceConflict("Invitation audit documents are inconsistent")

            timestamp = transaction.server_timestamp
            if existing_user is None:
                transaction.create_document(
                    user_path,
                    {
                        "uid": identity.uid,
                        "orgId": org_id,
                        "accountType": "STAFF",
                        "membershipStatus": "ACTIVE",
                        "organizationRole": INSTRUCTOR,
                        "organizationRoleRevision": 1,
                        "isAnonymous": False,
                        "email": normalized_email,
                        "displayName": identity.display_name,
                        "photoURL": identity.photo_url,
                        "joinedByInvitationId": invitation_id,
                        "schemaVersion": SCHEMA_VERSION,
                        "createdAt": timestamp,
                        "updatedAt": timestamp,
                    },
                )
            elif (
                existing_user.get("uid") == identity.uid
                and existing_user.get("orgId") == org_id
                and existing_user.get("accountType") == "STAFF"
                and existing_user.get("email") == normalized_email
                and existing_user.get("membershipStatus") == REMOVED_MEMBERSHIP
                and not has_active_membership(existing_user)
            ):
                previous_revision = existing_user.get("organizationRoleRevision")
                next_revision = (
                    previous_revision + 1
                    if isinstance(previous_revision, int)
                    and not isinstance(previous_revision, bool)
                    and previous_revision >= 1
                    else 1
                )
                transaction.update_document(
                    user_path,
                    {
                        "membershipStatus": "ACTIVE",
                        "accountType": "STAFF",
                        "organizationRole": INSTRUCTOR,
                        "organizationRoleRevision": next_revision,
                        "isAnonymous": False,
                        "displayName": identity.display_name,
                        "photoURL": identity.photo_url,
                        "joinedByInvitationId": invitation_id,
                        "schemaVersion": SCHEMA_VERSION,
                        "updatedAt": timestamp,
                    },
                )
            else:
                raise ResourceConflict("This account cannot be restored")
            transaction.update_document(
                invitation_path,
                {
                    "status": StaffInvitationStatus.ACCEPTED.value,
                    "acceptedAt": timestamp,
                    "acceptedByUid": identity.uid,
                    "updatedAt": timestamp,
                },
            )
            transaction.create_document(
                audit_path,
                self._audit_document(
                    event_type="STAFF_INVITATION_ACCEPTED",
                    actor_uid=identity.uid,
                    target_uid=identity.uid,
                    invitation_id=invitation_id,
                    revision=revision,
                    before={
                        "status": StaffInvitationStatus.PENDING.value,
                        "revision": revision,
                    },
                    after={
                        "status": StaffInvitationStatus.ACCEPTED.value,
                        "revision": revision,
                        "accountType": "STAFF",
                        "organizationRole": INSTRUCTOR,
                    },
                    timestamp=timestamp,
                ),
            )

        self.repository.run_transaction(accept)
        return self._staff_response(identity)

    def _read_management(self, identity: VerifiedCloudIdentity) -> OwnerDocuments:
        return self.repository.read_owner_documents(
            org_id=self.settings.bootstrap_org_id,
            uid=identity.uid,
            audit_log_id=BOOTSTRAP_AUDIT_LOG_ID,
        )

    def _require_organization_admin(
        self, documents: OwnerDocuments, identity: VerifiedCloudIdentity
    ) -> None:
        organization = documents.organization
        user = documents.user
        try:
            normalized_email = self._normalize_email_for_auth(identity.email)
        except AccessDenied:
            raise AccessDenied(
                "Only organization administrators can manage invitations"
            ) from None
        if not (
            self._valid_organization(organization)
            and user is not None
            and user.get("uid") == identity.uid
            and user.get("orgId") == self.settings.bootstrap_org_id
            and user.get("accountType") == "STAFF"
            and has_active_membership(user)
            and user.get("organizationRole") == ADMIN
            and isinstance(user.get("organizationRoleRevision"), int)
            and user["organizationRoleRevision"] >= 1
            and user.get("isAnonymous") is False
            and user.get("email") == normalized_email
            and user.get("schemaVersion") == SCHEMA_VERSION
            and user.get("createdAt") is not None
            and user.get("updatedAt") is not None
        ):
            raise AccessDenied(
                "Only organization administrators can manage invitations"
            )

    def _normalize_email(self, email: object) -> str:
        try:
            return normalize_staff_email(
                email, allowed_domains=self.settings.staff_email_domains
            )
        except ValueError as error:
            raise InvalidOperation(str(error)) from None

    def _normalize_email_for_auth(self, email: object) -> str:
        try:
            return normalize_staff_email(
                email, allowed_domains=self.settings.staff_email_domains
            )
        except ValueError:
            raise AccessDenied("No active organization invitation was found") from None

    def _require_valid_invitation(
        self,
        invitation: Mapping[str, Any],
        *,
        invitation_id: str,
        email: str,
    ) -> None:
        if not is_well_formed_invitation(
            invitation,
            invitation_id=invitation_id,
            org_id=self.settings.bootstrap_org_id,
            email=email,
        ):
            raise ResourceConflict("Invitation documents are inconsistent")

    def _require_existing_issue_audit(
        self,
        transaction: CloudOrganizationTransaction,
        invitation: Mapping[str, Any],
        invitation_id: str,
    ) -> None:
        revision = int(invitation["revision"])
        action = "created" if revision == 1 else "reissued"
        event_type = (
            "STAFF_INVITATION_CREATED" if revision == 1 else "STAFF_INVITATION_REISSUED"
        )
        audit = transaction.read_document(
            self._audit_path(staff_invitation_event_id(action, invitation_id, revision))
        )
        if not self._valid_audit(
            audit,
            event_type=event_type,
            invitation_id=invitation_id,
            revision=revision,
        ):
            raise ResourceConflict("Invitation audit documents are inconsistent")

    def _valid_audit(
        self,
        audit: Mapping[str, Any] | None,
        *,
        event_type: str,
        invitation_id: str,
        revision: int,
    ) -> bool:
        return bool(
            audit is not None
            and audit.get("eventType") == event_type
            and audit.get("orgId") == self.settings.bootstrap_org_id
            and audit.get("invitationId") == invitation_id
            and audit.get("revision") == revision
            and audit.get("schemaVersion") == SCHEMA_VERSION
            and audit.get("createdAt") is not None
            and "email" not in audit
            and "token" not in audit
        )

    def _valid_organization(self, organization: Mapping[str, Any] | None) -> bool:
        return bool(
            organization is not None
            and organization.get("id") == self.settings.bootstrap_org_id
            and organization.get("orgId") == self.settings.bootstrap_org_id
            and organization.get("name") == self.settings.bootstrap_org_name
            and isinstance(organization.get("adminCount"), int)
            and organization["adminCount"] >= 1
            and organization.get("bootstrapState") == "COMPLETED"
            and organization.get("schemaVersion") == SCHEMA_VERSION
            and organization.get("createdAt") is not None
            and organization.get("updatedAt") is not None
        )

    def _public_member(self, user: Mapping[str, Any]) -> dict[str, Any]:
        email = user.get("email")
        organization_role = user.get("organizationRole")
        if (
            user.get("orgId") != self.settings.bootstrap_org_id
            or user.get("accountType") != "STAFF"
            or not has_active_membership(user)
            or user.get("isAnonymous") is not False
            or organization_role not in ORGANIZATION_ROLES
            or not isinstance(email, str)
            or email != email.strip().lower()
            or user.get("createdAt") is None
        ):
            raise ResourceConflict("Staff member documents are inconsistent")
        return {
            "email": email,
            "displayName": user.get("displayName"),
            "photoURL": user.get("photoURL"),
            "organizationRole": organization_role,
            "createdAt": user.get("createdAt"),
        }

    def _public_invitation(self, invitation: Mapping[str, Any]) -> dict[str, Any]:
        invitation_id = invitation.get("id")
        email = invitation.get("emailNormalized")
        if not isinstance(invitation_id, str) or not isinstance(email, str):
            raise ResourceConflict("Invitation documents are inconsistent")
        self._require_valid_invitation(
            invitation, invitation_id=invitation_id, email=email
        )
        return {
            "id": invitation_id,
            "emailNormalized": email,
            "status": invitation.get("status"),
            "revision": invitation.get("revision"),
            "createdAt": invitation.get("createdAt"),
            "updatedAt": invitation.get("updatedAt"),
            "expiresAt": invitation.get("expiresAt"),
            "acceptedAt": invitation.get("acceptedAt"),
            "revokedAt": invitation.get("revokedAt"),
        }

    def _read_public_invitation(self, path: str) -> dict[str, Any]:
        invitation = self.repository.read_document(path)
        if invitation is None:
            raise ResourceConflict("Invitation transaction did not commit")
        return self._public_invitation(invitation)

    def _audit_document(
        self,
        *,
        event_type: str,
        actor_uid: str,
        target_uid: str | None,
        invitation_id: str,
        revision: int,
        before: Mapping[str, Any] | None,
        after: Mapping[str, Any],
        timestamp: object,
    ) -> dict[str, Any]:
        return {
            "eventType": event_type,
            "orgId": self.settings.bootstrap_org_id,
            "actorUid": actor_uid,
            "targetUid": target_uid,
            "invitationId": invitation_id,
            "revision": revision,
            "before": before,
            "after": dict(after),
            "createdAt": timestamp,
            "schemaVersion": SCHEMA_VERSION,
        }

    def _staff_response(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        return {
            "uid": identity.uid,
            "orgId": self.settings.bootstrap_org_id,
            "accountType": "STAFF",
            "organizationRole": INSTRUCTOR,
            "isAdmin": False,
            "isAnonymous": False,
            "provider": identity.provider,
            "emailVerified": identity.email_verified,
            "authorized": True,
            "email": identity.email,
            "displayName": identity.display_name,
            "photoURL": identity.photo_url,
        }

    def _invitation_path(self, invitation_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}"
            f"/staffInvitations/{invitation_id}"
        )

    def _audit_path(self, event_id: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/auditLogs/{event_id}"
