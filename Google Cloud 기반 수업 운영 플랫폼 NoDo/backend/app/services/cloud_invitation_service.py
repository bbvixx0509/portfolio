import hmac
import secrets
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.parse import quote

from app.core.config import Settings
from app.domain.errors import (
    AccessDenied,
    InvalidInvitationToken,
    InvalidOperation,
    InvitationAlreadyProcessed,
    InvitationEmailMismatch,
    InvitationExpired,
    InvitationRevoked,
    ResourceConflict,
    ResourceNotFound,
)
from app.domain.staff_invitations import (
    StaffInvitationStatus,
    effective_invitation_status,
    invitation_email,
    invitation_token_hash,
    is_active_pending_invitation,
    is_well_formed_invitation,
    normalize_staff_email,
    staff_invitation_event_id,
    staff_invitation_id,
    valid_raw_invitation_token,
)
from app.domain.staff_membership import has_active_membership
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import (
    ADMIN,
    BOOTSTRAP_AUDIT_LOG_ID,
    INSTRUCTOR,
    SCHEMA_VERSION,
    CloudOrganizationRepository,
    CloudOrganizationTransaction,
    OwnerDocuments,
)

INVITATION_SCHEMA_VERSION = 2
INVITATION_TTL = timedelta(days=7)


def _utc_now() -> datetime:
    return datetime.now(UTC)


class InvitationEmailSender(Protocol):
    def ensure_configured(self) -> None: ...

    def send_invitation(
        self,
        *,
        recipient: str,
        accept_url: str,
        decline_url: str,
        idempotency_key: str,
    ) -> None: ...


class CloudInvitationService:
    def __init__(
        self,
        repository: CloudOrganizationRepository,
        email_sender: InvitationEmailSender,
        runtime_settings: Settings,
        *,
        clock: Callable[[], datetime] = _utc_now,
        token_factory: Callable[[], str] = lambda: secrets.token_urlsafe(32),
    ) -> None:
        self.repository = repository
        self.email_sender = email_sender
        self.settings = runtime_settings
        self.clock = clock
        self.token_factory = token_factory

    def list_invitations(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        self._require_admin(self._read_management(identity), identity)
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
        self._require_admin(self._read_management(identity), identity)
        normalized_email = self._normalize_email(email)
        if normalized_email == identity.email.strip().lower():
            raise InvalidOperation("자기 자신에게는 조직 로그인을 승인할 수 없습니다.")

        raw_token = self._new_token()
        now = self.clock().astimezone(UTC)
        invitation_id = staff_invitation_id(
            self.settings.bootstrap_org_id, normalized_email
        )
        path = self._invitation_path(invitation_id)

        def create(transaction: CloudOrganizationTransaction) -> tuple[bool, int]:
            self._require_admin_transaction(transaction, identity)
            if any(
                has_active_membership(user)
                for user in transaction.find_users_by_email(
                    org_id=self.settings.bootstrap_org_id,
                    email=normalized_email,
                )
            ):
                raise ResourceConflict("이미 가입한 구성원입니다.")

            existing = transaction.read_document(path)
            if existing is not None:
                self._require_valid_invitation(existing)
                if (
                    existing.get("schemaVersion") == INVITATION_SCHEMA_VERSION
                    and is_active_pending_invitation(existing, now=now)
                ):
                    self._require_audit(
                        transaction,
                        event_type=self._issue_event_type(existing),
                        action=self._issue_action(existing),
                        invitation_id=invitation_id,
                        revision=int(existing["revision"]),
                    )
                    raise InvitationAlreadyProcessed(
                        "이미 대기 중인 승인입니다. "
                        "대기 목록에서 승인 갱신을 사용해 주세요."
                    )

            revision = 1 if existing is None else int(existing["revision"]) + 1
            event_type = (
                "ORGANIZATION_INVITATION_CREATED"
                if existing is None
                else "ORGANIZATION_INVITATION_RESENT"
            )
            action = "created" if existing is None else "resent"
            timestamp = transaction.server_timestamp
            document = self._pending_document(
                invitation_id=invitation_id,
                email=normalized_email,
                actor_uid=identity.uid,
                raw_token=raw_token,
                revision=revision,
                now=now,
                timestamp=timestamp,
                created_at=(
                    timestamp if existing is None else existing.get("createdAt")
                ),
            )
            if existing is None:
                transaction.create_document(path, document)
            else:
                transaction.update_document(path, document)
            self._create_audit(
                transaction,
                event_type=event_type,
                action=action,
                invitation_id=invitation_id,
                actor_uid=identity.uid,
                target_uid=None,
                revision=revision,
                before=self._before(existing),
                after={"status": StaffInvitationStatus.PENDING.value},
                timestamp=timestamp,
            )
            return True, revision

        self.repository.run_transaction(create)
        return self._read_public(path)

    def resend_invitation(
        self, identity: VerifiedCloudIdentity, invitation_id: str
    ) -> dict[str, Any]:
        self._require_admin(self._read_management(identity), identity)
        path = self._validated_invitation_path(invitation_id)
        raw_token = self._new_token()
        now = self.clock().astimezone(UTC)

        def resend(transaction: CloudOrganizationTransaction) -> tuple[str, int]:
            self._require_admin_transaction(transaction, identity)
            invitation = transaction.read_document(path)
            if invitation is None:
                raise ResourceNotFound("초대를 찾을 수 없습니다.")
            self._require_valid_invitation(invitation)
            status = effective_invitation_status(invitation, now=now)
            if status not in {
                StaffInvitationStatus.PENDING.value,
                StaffInvitationStatus.EXPIRED.value,
            }:
                raise InvitationAlreadyProcessed(
                    "처리가 끝난 초대는 다시 보낼 수 없습니다."
                )
            email = invitation_email(invitation)
            if not isinstance(email, str):
                raise ResourceConflict("초대 문서가 올바르지 않습니다.")
            if any(
                has_active_membership(user)
                for user in transaction.find_users_by_email(
                    org_id=self.settings.bootstrap_org_id,
                    email=email,
                )
            ):
                raise ResourceConflict("이미 가입한 구성원입니다.")

            revision = int(invitation["revision"]) + 1
            timestamp = transaction.server_timestamp
            transaction.update_document(
                path,
                self._pending_document(
                    invitation_id=invitation_id,
                    email=email,
                    actor_uid=identity.uid,
                    raw_token=raw_token,
                    revision=revision,
                    now=now,
                    timestamp=timestamp,
                    created_at=invitation.get("createdAt"),
                ),
            )
            self._create_audit(
                transaction,
                event_type="ORGANIZATION_INVITATION_RESENT",
                action="resent",
                invitation_id=invitation_id,
                actor_uid=identity.uid,
                target_uid=None,
                revision=revision,
                before=self._before(invitation),
                after={"status": StaffInvitationStatus.PENDING.value},
                timestamp=timestamp,
            )
            return email, revision

        self.repository.run_transaction(resend)
        return self._read_public(path)

    def revoke_invitation(
        self, identity: VerifiedCloudIdentity, invitation_id: str
    ) -> dict[str, Any]:
        self._require_admin(self._read_management(identity), identity)
        path = self._validated_invitation_path(invitation_id)

        def revoke(transaction: CloudOrganizationTransaction) -> None:
            self._require_admin_transaction(transaction, identity)
            invitation = transaction.read_document(path)
            if invitation is None:
                raise ResourceNotFound("초대를 찾을 수 없습니다.")
            self._require_valid_invitation(invitation)
            revision = int(invitation["revision"])
            if invitation.get("status") == StaffInvitationStatus.REVOKED.value:
                self._require_audit(
                    transaction,
                    event_type="ORGANIZATION_INVITATION_REVOKED",
                    action="revoked",
                    invitation_id=invitation_id,
                    revision=revision,
                )
                return
            if invitation.get("status") != StaffInvitationStatus.PENDING.value:
                raise InvitationAlreadyProcessed("처리가 끝난 초대입니다.")

            timestamp = transaction.server_timestamp
            transaction.update_document(
                path,
                {
                    "status": StaffInvitationStatus.REVOKED.value,
                    "updatedAt": timestamp,
                    "revokedAt": timestamp,
                    "revokedByUid": identity.uid,
                },
            )
            self._create_audit(
                transaction,
                event_type="ORGANIZATION_INVITATION_REVOKED",
                action="revoked",
                invitation_id=invitation_id,
                actor_uid=identity.uid,
                target_uid=None,
                revision=revision,
                before=self._before(invitation),
                after={"status": StaffInvitationStatus.REVOKED.value},
                timestamp=timestamp,
            )

        self.repository.run_transaction(revoke)
        return self._read_public(path)

    def accept_invitation(
        self, identity: VerifiedCloudIdentity, raw_token: object
    ) -> dict[str, Any]:
        return self._complete_invitation(identity, raw_token, accept=True)

    def decline_invitation(
        self, identity: VerifiedCloudIdentity, raw_token: object
    ) -> dict[str, Any]:
        return self._complete_invitation(identity, raw_token, accept=False)

    def _complete_invitation(
        self,
        identity: VerifiedCloudIdentity,
        raw_token: object,
        *,
        accept: bool,
    ) -> dict[str, Any]:
        if not valid_raw_invitation_token(raw_token):
            raise InvalidInvitationToken("유효하지 않은 초대 링크입니다.")
        assert isinstance(raw_token, str)
        normalized_email = self._normalize_auth_email(identity.email)
        token_hash = invitation_token_hash(raw_token)
        now = self.clock().astimezone(UTC)
        action = "accepted" if accept else "declined"
        event_type = (
            "ORGANIZATION_INVITATION_ACCEPTED"
            if accept
            else "ORGANIZATION_INVITATION_DECLINED"
        )

        def complete(transaction: CloudOrganizationTransaction) -> str:
            matches = transaction.find_staff_invitations_by_token_hash(
                org_id=self.settings.bootstrap_org_id,
                token_hash=token_hash,
            )
            if len(matches) != 1:
                raise InvalidInvitationToken("유효하지 않은 초대 링크입니다.")
            invitation = matches[0]
            invitation_id = invitation.get("id")
            if not isinstance(invitation_id, str):
                raise InvalidInvitationToken("유효하지 않은 초대 링크입니다.")
            self._require_valid_invitation(invitation)
            stored_hash = invitation.get("tokenHash")
            if not isinstance(stored_hash, str) or not hmac.compare_digest(
                stored_hash, token_hash
            ):
                raise InvalidInvitationToken("유효하지 않은 초대 링크입니다.")
            email = invitation_email(invitation)
            if email != normalized_email:
                raise InvitationEmailMismatch(
                    "초대받은 이메일과 로그인한 이메일이 일치하지 않습니다."
                )
            status = effective_invitation_status(invitation, now=now)
            if status == StaffInvitationStatus.EXPIRED.value:
                raise InvitationExpired(
                    "초대가 만료되었습니다. 관리자에게 재초대를 요청해 주세요."
                )
            if status == StaffInvitationStatus.REVOKED.value:
                raise InvitationRevoked("취소된 초대입니다.")
            desired_status = (
                StaffInvitationStatus.ACCEPTED.value
                if accept
                else StaffInvitationStatus.DECLINED.value
            )
            revision = int(invitation["revision"])
            if status == desired_status:
                self._require_audit(
                    transaction,
                    event_type=event_type,
                    action=action,
                    invitation_id=invitation_id,
                    revision=revision,
                )
                return invitation_id
            if status != StaffInvitationStatus.PENDING.value:
                raise InvitationAlreadyProcessed("이미 처리된 초대입니다.")

            organization = transaction.read_document(
                f"organizations/{self.settings.bootstrap_org_id}"
            )
            if not self._valid_organization(organization):
                raise ResourceConflict("조직 문서가 올바르지 않습니다.")

            timestamp = transaction.server_timestamp
            if accept:
                self._activate_membership(
                    transaction,
                    identity=identity,
                    invitation_id=invitation_id,
                    email=normalized_email,
                    timestamp=timestamp,
                )
                invitation_changes = {
                    "status": desired_status,
                    "updatedAt": timestamp,
                    "acceptedAt": timestamp,
                    "acceptedByUid": identity.uid,
                }
            else:
                invitation_changes = {
                    "status": desired_status,
                    "updatedAt": timestamp,
                    "declinedAt": timestamp,
                    "declinedByUid": identity.uid,
                }
            transaction.update_document(
                self._invitation_path(invitation_id), invitation_changes
            )
            self._create_audit(
                transaction,
                event_type=event_type,
                action=action,
                invitation_id=invitation_id,
                actor_uid=identity.uid,
                target_uid=identity.uid if accept else None,
                revision=revision,
                before=self._before(invitation),
                after={"status": desired_status},
                timestamp=timestamp,
            )
            return invitation_id

        invitation_id = self.repository.run_transaction(complete)
        return self._read_public(self._invitation_path(invitation_id))

    def _activate_membership(
        self,
        transaction: CloudOrganizationTransaction,
        *,
        identity: VerifiedCloudIdentity,
        invitation_id: str,
        email: str,
        timestamp: object,
    ) -> None:
        user_path = f"users/{identity.uid}"
        existing = transaction.read_document(user_path)
        active_email_users = [
            user
            for user in transaction.find_users_by_email(
                org_id=self.settings.bootstrap_org_id, email=email
            )
            if has_active_membership(user)
        ]
        if active_email_users:
            raise ResourceConflict("이미 가입한 구성원입니다.")
        if existing is None:
            transaction.create_document(
                user_path,
                {
                    "uid": identity.uid,
                    "orgId": self.settings.bootstrap_org_id,
                    "accountType": "STAFF",
                    "membershipStatus": "ACTIVE",
                    "organizationRole": INSTRUCTOR,
                    "organizationRoleRevision": 1,
                    "isAnonymous": False,
                    "email": email,
                    "displayName": identity.display_name,
                    "photoURL": identity.photo_url,
                    "joinedByInvitationId": invitation_id,
                    "schemaVersion": SCHEMA_VERSION,
                    "createdAt": timestamp,
                    "updatedAt": timestamp,
                },
            )
            return
        if (
            existing.get("uid") != identity.uid
            or existing.get("orgId") != self.settings.bootstrap_org_id
            or existing.get("accountType") != "STAFF"
            or existing.get("email") != email
            or existing.get("membershipStatus") != "REMOVED"
            or has_active_membership(existing)
        ):
            raise ResourceConflict("기존 구성원 문서를 복구할 수 없습니다.")
        previous_revision = existing.get("organizationRoleRevision")
        revision = (
            previous_revision + 1
            if isinstance(previous_revision, int)
            and not isinstance(previous_revision, bool)
            and previous_revision >= 1
            else 1
        )
        transaction.update_document(
            user_path,
            {
                "orgId": self.settings.bootstrap_org_id,
                "accountType": "STAFF",
                "membershipStatus": "ACTIVE",
                "organizationRole": INSTRUCTOR,
                "organizationRoleRevision": revision,
                "isAnonymous": False,
                "displayName": identity.display_name,
                "photoURL": identity.photo_url,
                "joinedByInvitationId": invitation_id,
                "schemaVersion": SCHEMA_VERSION,
                "updatedAt": timestamp,
            },
        )

    def _pending_document(
        self,
        *,
        invitation_id: str,
        email: str,
        actor_uid: str,
        raw_token: str,
        revision: int,
        now: datetime,
        timestamp: object,
        created_at: object,
    ) -> dict[str, Any]:
        return {
            "id": invitation_id,
            "orgId": self.settings.bootstrap_org_id,
            "invitedEmail": email,
            "invitedOrganizationRole": INSTRUCTOR,
            "status": StaffInvitationStatus.PENDING.value,
            "tokenHash": invitation_token_hash(raw_token),
            "revision": revision,
            "createdByUid": actor_uid,
            "createdAt": created_at,
            "updatedAt": timestamp,
            "expiresAt": now + INVITATION_TTL,
            "acceptedAt": None,
            "acceptedByUid": None,
            "declinedAt": None,
            "declinedByUid": None,
            "revokedAt": None,
            "revokedByUid": None,
            "schemaVersion": INVITATION_SCHEMA_VERSION,
        }

    def _create_audit(
        self,
        transaction: CloudOrganizationTransaction,
        *,
        event_type: str,
        action: str,
        invitation_id: str,
        actor_uid: str,
        target_uid: str | None,
        revision: int,
        before: Mapping[str, Any] | None,
        after: Mapping[str, Any],
        timestamp: object,
    ) -> None:
        path = self._audit_path(
            staff_invitation_event_id(action, invitation_id, revision)
        )
        transaction.create_document(
            path,
            {
                "eventType": event_type,
                "orgId": self.settings.bootstrap_org_id,
                "actorUid": actor_uid,
                "targetUid": target_uid,
                "invitationId": invitation_id,
                "revision": revision,
                "before": dict(before) if before is not None else None,
                "after": dict(after),
                "createdAt": timestamp,
                "schemaVersion": SCHEMA_VERSION,
            },
        )

    def _require_audit(
        self,
        transaction: CloudOrganizationTransaction,
        *,
        event_type: str,
        action: str,
        invitation_id: str,
        revision: int,
    ) -> None:
        audit = transaction.read_document(
            self._audit_path(
                staff_invitation_event_id(action, invitation_id, revision)
            )
        )
        if not self._valid_audit(
            audit,
            event_type=event_type,
            invitation_id=invitation_id,
            revision=revision,
        ):
            raise ResourceConflict("초대 감사 기록이 올바르지 않습니다.")

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
            and audit.get("createdAt") is not None
            and "email" not in audit
            and "token" not in audit
            and "tokenHash" not in audit
        )

    def _send(
        self,
        *,
        email: str,
        raw_token: str,
        invitation_id: str,
        revision: int,
    ) -> None:
        encoded = quote(raw_token, safe="")
        base_url = self.settings.public_app_url
        self.email_sender.send_invitation(
            recipient=email,
            accept_url=f"{base_url}/organization/invitations/{encoded}/accept",
            decline_url=f"{base_url}/organization/invitations/{encoded}/decline",
            idempotency_key=(
                f"organization-invitation-email-{invitation_id}-r{revision}"
            ),
        )

    def _new_token(self) -> str:
        token = self.token_factory()
        if not valid_raw_invitation_token(token):
            raise RuntimeError(
                "The invitation token generator returned an unsafe token"
            )
        return token

    def _read_management(self, identity: VerifiedCloudIdentity) -> OwnerDocuments:
        return self.repository.read_owner_documents(
            org_id=self.settings.bootstrap_org_id,
            uid=identity.uid,
            audit_log_id=BOOTSTRAP_AUDIT_LOG_ID,
        )

    def _require_admin_transaction(
        self,
        transaction: CloudOrganizationTransaction,
        identity: VerifiedCloudIdentity,
    ) -> None:
        self._require_admin(
            transaction.read_owner_documents(
                org_id=self.settings.bootstrap_org_id,
                uid=identity.uid,
                audit_log_id=BOOTSTRAP_AUDIT_LOG_ID,
            ),
            identity,
        )

    def _require_admin(
        self, documents: OwnerDocuments, identity: VerifiedCloudIdentity
    ) -> None:
        user = documents.user
        organization = documents.organization
        if not (
            self._valid_organization(organization)
            and user is not None
            and user.get("uid") == identity.uid
            and user.get("orgId") == self.settings.bootstrap_org_id
            and user.get("accountType") == "STAFF"
            and has_active_membership(user)
            and user.get("organizationRole") == ADMIN
            and user.get("isAnonymous") is False
            and user.get("email") == identity.email.strip().lower()
        ):
            raise AccessDenied("조직 관리자만 초대를 관리할 수 있습니다.")

    def _valid_organization(self, organization: Mapping[str, Any] | None) -> bool:
        return bool(
            organization is not None
            and organization.get("id") == self.settings.bootstrap_org_id
            and organization.get("orgId") == self.settings.bootstrap_org_id
            and organization.get("name") == self.settings.bootstrap_org_name
            and organization.get("bootstrapState") == "COMPLETED"
            and isinstance(organization.get("adminCount"), int)
            and organization["adminCount"] >= 1
            and organization.get("schemaVersion") == SCHEMA_VERSION
        )

    def _normalize_email(self, email: object) -> str:
        try:
            return normalize_staff_email(
                email, allowed_domains=self.settings.staff_email_domains
            )
        except ValueError:
            raise InvalidOperation(
                "@nodo-company.test 회사 이메일을 입력해 주세요."
            ) from None

    def _normalize_auth_email(self, email: object) -> str:
        try:
            return normalize_staff_email(
                email, allowed_domains=self.settings.staff_email_domains
            )
        except ValueError:
            raise InvitationEmailMismatch(
                "초대받은 이메일과 로그인한 이메일이 일치하지 않습니다."
            ) from None

    def _require_valid_invitation(self, invitation: Mapping[str, Any]) -> None:
        invitation_id = invitation.get("id")
        email = invitation_email(invitation)
        if (
            not isinstance(invitation_id, str)
            or not isinstance(email, str)
            or not is_well_formed_invitation(
                invitation,
                invitation_id=invitation_id,
                org_id=self.settings.bootstrap_org_id,
                email=email,
            )
        ):
            raise ResourceConflict("초대 문서가 올바르지 않습니다.")

    def _public_invitation(self, invitation: Mapping[str, Any]) -> dict[str, Any]:
        self._require_valid_invitation(invitation)
        email = invitation_email(invitation)
        assert isinstance(email, str)
        return {
            "id": invitation["id"],
            "email": email,
            "status": effective_invitation_status(
                invitation, now=self.clock().astimezone(UTC)
            ),
            "expiresAt": invitation["expiresAt"],
            "createdAt": invitation["createdAt"],
            "updatedAt": invitation["updatedAt"],
            "acceptedAt": invitation.get("acceptedAt"),
            "declinedAt": invitation.get("declinedAt"),
            "revokedAt": invitation.get("revokedAt"),
        }

    def _read_public(self, path: str) -> dict[str, Any]:
        invitation = self.repository.read_document(path)
        if invitation is None:
            raise ResourceConflict("초대 처리 결과를 확인할 수 없습니다.")
        return self._public_invitation(invitation)

    def _validated_invitation_path(self, invitation_id: str) -> str:
        if len(invitation_id) != 64 or any(
            character not in "0123456789abcdef" for character in invitation_id
        ):
            raise ResourceNotFound("초대를 찾을 수 없습니다.")
        return self._invitation_path(invitation_id)

    def _invitation_path(self, invitation_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}"
            f"/staffInvitations/{invitation_id}"
        )

    def _audit_path(self, event_id: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/auditLogs/{event_id}"

    @staticmethod
    def _before(invitation: Mapping[str, Any] | None) -> dict[str, Any] | None:
        if invitation is None:
            return None
        return {
            "status": invitation.get("status"),
            "revision": invitation.get("revision"),
        }

    @staticmethod
    def _issue_action(invitation: Mapping[str, Any]) -> str:
        return "created" if invitation.get("revision") == 1 else "resent"

    @staticmethod
    def _issue_event_type(invitation: Mapping[str, Any]) -> str:
        return (
            "ORGANIZATION_INVITATION_CREATED"
            if invitation.get("revision") == 1
            else "ORGANIZATION_INVITATION_RESENT"
        )
