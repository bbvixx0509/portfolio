from collections.abc import Mapping
from typing import Any
from uuid import uuid4

from app.core.config import Settings
from app.domain.cloud_room_roles import (
    ROOM_ROLE_LEAD,
    full_room_permissions,
    room_instructor_uids,
    room_instructors,
)
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    LastOrganizationAdministrator,
    ResourceConflict,
    ResourceNotFound,
    SelfMembershipRemoval,
)
from app.domain.staff_membership import (
    ACTIVE_MEMBERSHIP,
    REMOVED_MEMBERSHIP,
    membership_status,
)
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import (
    ADMIN,
    ORGANIZATION_ROLES,
    SCHEMA_VERSION,
    CloudOrganizationRepository,
    CloudOrganizationTransaction,
)


class CloudOrganizationRoleService:
    """Member-management APIs that never authorize through legacy booleans."""

    def __init__(
        self, repository: CloudOrganizationRepository, settings: Settings
    ) -> None:
        self.repository = repository
        self.settings = settings

    def list_members(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        self._require_admin(identity)
        members = [
            self._public_member(member)
            for member in self.repository.list_staff_members(
                org_id=self.settings.bootstrap_org_id
            )
            if self._is_member(member)
        ]
        members.sort(key=lambda member: (member["email"] or "", member["uid"]))
        return {"members": members, "count": len(members)}

    def update_role(
        self,
        identity: VerifiedCloudIdentity,
        target_uid: str,
        role: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        if role not in ORGANIZATION_ROLES:
            raise InvalidOperation("The organization role is invalid")
        if target_uid == identity.uid:
            raise InvalidOperation("You cannot change your own organization role")
        self._require_admin(identity)
        event_id = f"organization-role-{uuid4().hex}"

        def change(transaction: CloudOrganizationTransaction) -> None:
            actor = transaction.read_document(f"users/{identity.uid}")
            organization = transaction.read_document(
                f"organizations/{self.settings.bootstrap_org_id}"
            )
            target = transaction.read_document(f"users/{target_uid}")
            self._require_transaction_admin(organization, actor, identity)
            if target is None or not self._is_member(target, target_uid):
                raise ResourceNotFound("The organization member was not found")
            previous_role = target["organizationRole"]
            revision = target["organizationRoleRevision"]
            if revision != expected_revision:
                raise ResourceConflict(
                    "The organization role was changed by another request"
                )
            if previous_role == role:
                return
            admin_count = organization["adminCount"]
            if previous_role == ADMIN and role != ADMIN and admin_count <= 1:
                raise ResourceConflict(
                    "At least one organization administrator is required"
                )
            next_admin_count = admin_count + (1 if role == ADMIN else -1)
            timestamp = transaction.server_timestamp
            transaction.update_document(
                f"users/{target_uid}",
                {
                    "organizationRole": role,
                    "organizationRoleRevision": revision + 1,
                    "updatedAt": timestamp,
                },
            )
            transaction.update_document(
                f"organizations/{self.settings.bootstrap_org_id}",
                {"adminCount": next_admin_count, "updatedAt": timestamp},
            )
            transaction.create_document(
                f"organizations/{self.settings.bootstrap_org_id}/auditLogs/{event_id}",
                {
                    "eventType": (
                        "ORGANIZATION_ADMIN_GRANTED"
                        if role == ADMIN
                        else "ORGANIZATION_ADMIN_REVOKED"
                    ),
                    "orgId": self.settings.bootstrap_org_id,
                    "actorUid": identity.uid,
                    "targetUid": target_uid,
                    "before": {"organizationRole": previous_role},
                    "after": {"organizationRole": role},
                    "schemaVersion": SCHEMA_VERSION,
                    "createdAt": timestamp,
                },
            )

        self.repository.run_transaction(change)
        updated = self.repository.read_document(f"users/{target_uid}")
        if updated is None or not self._is_member(updated, target_uid):
            raise ResourceConflict("The organization role transaction did not commit")
        return self._public_member(updated)

    def remove_member(
        self, identity: VerifiedCloudIdentity, target_uid: str
    ) -> dict[str, Any]:
        if target_uid == identity.uid:
            raise SelfMembershipRemoval("자기 자신은 조직에서 제거할 수 없습니다.")
        self._require_admin(identity)

        def change(transaction: CloudOrganizationTransaction) -> None:
            actor = transaction.read_document(f"users/{identity.uid}")
            organization = transaction.read_document(
                f"organizations/{self.settings.bootstrap_org_id}"
            )
            target = transaction.read_document(f"users/{target_uid}")
            self._require_transaction_admin(organization, actor, identity)
            if target is None or not self._is_staff_record(target, target_uid):
                raise ResourceNotFound("The organization member was not found")
            # The role revision identifies this membership generation. A member
            # who is later invited back receives a new revision, so a second
            # legitimate removal does not collide with the first audit record.
            removal_revision = int(target["organizationRoleRevision"])
            audit_path = self._member_removal_audit_path(
                target_uid=target_uid,
                removal_revision=removal_revision,
            )
            existing_audit = transaction.read_document(audit_path)
            if membership_status(target) == REMOVED_MEMBERSHIP:
                if not self._is_removal_audit(existing_audit, target_uid):
                    raise ResourceConflict(
                        "Organization member removal records are inconsistent"
                    )
                return
            if membership_status(target) != ACTIVE_MEMBERSHIP:
                raise ResourceNotFound("The organization member was not found")
            if target["organizationRole"] == ADMIN and organization["adminCount"] <= 1:
                raise LastOrganizationAdministrator(
                    "조직의 마지막 관리자입니다. 다른 관리자를 먼저 지정한 뒤 "
                    "제거해 주세요."
                )
            if existing_audit is not None:
                raise ResourceConflict(
                    "Organization member removal records are inconsistent"
                )
            room_updates = self._active_room_assignment_updates(
                transaction.list_active_rooms(
                    org_id=self.settings.bootstrap_org_id
                ),
                actor=actor,
                target_uid=target_uid,
            )
            timestamp = transaction.server_timestamp
            for room, assignments, target_was_lead in room_updates:
                room_id = str(room["id"])
                revision = int(room["revision"]) + 1
                lead = next(
                    assignment
                    for assignment in assignments
                    if assignment["role"] == ROOM_ROLE_LEAD
                )
                transaction.update_document(
                    f"organizations/{self.settings.bootstrap_org_id}/rooms/{room_id}",
                    {
                        "roomInstructors": assignments,
                        "leadInstructorUid": lead["uid"],
                        "leadInstructorDisplayNameSnapshot": lead[
                            "displayNameSnapshot"
                        ],
                        "instructorMemberUids": room_instructor_uids(assignments),
                        "revision": revision,
                        "updatedAt": timestamp,
                    },
                )
                if not target_was_lead:
                    continue
                transaction.create_document(
                    self._room_lead_reassignment_audit_path(
                        room_id=room_id,
                        target_uid=target_uid,
                        removal_revision=removal_revision,
                    ),
                    {
                        "eventType": "ROOM_LEAD_REASSIGNED_ON_MEMBER_REMOVAL",
                        "orgId": self.settings.bootstrap_org_id,
                        "roomId": room_id,
                        "actorUid": identity.uid,
                        "targetStaffUid": target_uid,
                        "beforeRoomRole": ROOM_ROLE_LEAD,
                        "afterRoomRole": None,
                        "revision": revision,
                        "schemaVersion": SCHEMA_VERSION,
                        "createdAt": timestamp,
                    },
                )
            transaction.update_document(
                f"users/{target_uid}",
                {"membershipStatus": REMOVED_MEMBERSHIP, "updatedAt": timestamp},
            )
            if target["organizationRole"] == ADMIN:
                transaction.update_document(
                    f"organizations/{self.settings.bootstrap_org_id}",
                    {
                        "adminCount": organization["adminCount"] - 1,
                        "updatedAt": timestamp,
                    },
                )
            transaction.create_document(
                audit_path,
                {
                    "eventType": "ORGANIZATION_MEMBER_REMOVED",
                    "orgId": self.settings.bootstrap_org_id,
                    "actorUid": identity.uid,
                    "targetUid": target_uid,
                    "roleBefore": target["organizationRole"],
                    "reason": "ORGANIZATION_ACCESS_REVOKED",
                    "createdAt": timestamp,
                },
            )

        self.repository.run_transaction(change)
        return {"removed": True}

    def _active_room_assignment_updates(
        self,
        rooms: list[Mapping[str, Any]],
        *,
        actor: Mapping[str, Any],
        target_uid: str,
    ) -> list[tuple[Mapping[str, Any], list[dict[str, Any]], bool]]:
        actor_uid = actor.get("uid")
        if not isinstance(actor_uid, str) or not actor_uid:
            raise ResourceConflict("Organization member documents are inconsistent")
        actor_display_name = actor.get("displayName")
        display_name_snapshot = (
            actor_display_name.strip()
            if isinstance(actor_display_name, str) and actor_display_name.strip()
            else "이름 미등록"
        )
        updates: list[
            tuple[Mapping[str, Any], list[dict[str, Any]], bool]
        ] = []
        for room in rooms:
            raw_assignments = room.get("roomInstructors")
            if raw_assignments is None:
                target_is_related = room.get("leadInstructorUid") == target_uid
            elif isinstance(raw_assignments, list):
                target_is_related = any(
                    isinstance(value, Mapping) and value.get("uid") == target_uid
                    for value in raw_assignments
                )
            else:
                target_is_related = False
            if not target_is_related:
                continue

            room_id = room.get("id")
            revision = room.get("revision")
            if (
                not isinstance(room_id, str)
                or not room_id
                or room.get("orgId") != self.settings.bootstrap_org_id
                or room.get("status") not in {"READY", "LIVE"}
                or not isinstance(revision, int)
                or isinstance(revision, bool)
                or revision < 1
            ):
                raise ResourceConflict("Active room documents are inconsistent")
            assignments = room_instructors(room)
            if not assignments:
                raise ResourceConflict("Active room instructor assignments are invalid")
            target = next(
                (
                    assignment
                    for assignment in assignments
                    if assignment["uid"] == target_uid
                ),
                None,
            )
            if target is None:
                continue
            target_was_lead = target["role"] == ROOM_ROLE_LEAD
            next_assignments = [
                assignment
                for assignment in assignments
                if assignment["uid"] != target_uid
            ]
            if target_was_lead:
                actor_assignment = next(
                    (
                        assignment
                        for assignment in next_assignments
                        if assignment["uid"] == actor_uid
                    ),
                    None,
                )
                if actor_assignment is None:
                    actor_assignment = {
                        "uid": actor_uid,
                        "role": ROOM_ROLE_LEAD,
                        "permissions": full_room_permissions(),
                        "displayNameSnapshot": display_name_snapshot,
                    }
                else:
                    actor_assignment = {
                        **actor_assignment,
                        "role": ROOM_ROLE_LEAD,
                        "permissions": full_room_permissions(),
                        "displayNameSnapshot": display_name_snapshot,
                    }
                next_assignments = [
                    actor_assignment,
                    *[
                        assignment
                        for assignment in next_assignments
                        if assignment["uid"] != actor_uid
                    ],
                ]
            updates.append((room, next_assignments, target_was_lead))
        return updates

    def _room_lead_reassignment_audit_path(
        self, *, room_id: str, target_uid: str, removal_revision: int
    ) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/"
            "room-lead-reassigned-on-member-removal-"
            f"{room_id}-{target_uid}-r{removal_revision}"
        )

    def _member_removal_audit_path(
        self, *, target_uid: str, removal_revision: int
    ) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/"
            f"organization-member-removed-{target_uid}-r{removal_revision}"
        )

    def _require_admin(self, identity: VerifiedCloudIdentity) -> None:
        organization = self.repository.read_document(
            f"organizations/{self.settings.bootstrap_org_id}"
        )
        user = self.repository.read_document(f"users/{identity.uid}")
        self._require_transaction_admin(organization, user, identity)

    def _require_transaction_admin(
        self,
        organization: Mapping[str, Any] | None,
        user: Mapping[str, Any] | None,
        identity: VerifiedCloudIdentity,
    ) -> None:
        if not self._is_valid_organization(organization) or user is None:
            raise AccessDenied("Only organization administrators can manage members")
        if not self._is_member(user, identity.uid) or user["organizationRole"] != ADMIN:
            raise AccessDenied("Only organization administrators can manage members")

    def _is_valid_organization(self, organization: Mapping[str, Any] | None) -> bool:
        return bool(
            organization
            and organization.get("id") == self.settings.bootstrap_org_id
            and organization.get("orgId") == self.settings.bootstrap_org_id
            and isinstance(organization.get("adminCount"), int)
            and organization["adminCount"] >= 1
            and organization.get("schemaVersion") == SCHEMA_VERSION
        )

    def _is_member(
        self, user: Mapping[str, Any], expected_uid: str | None = None
    ) -> bool:
        return bool(
            self._is_staff_record(user, expected_uid)
            and membership_status(user) == ACTIVE_MEMBERSHIP
        )

    def _is_staff_record(
        self, user: Mapping[str, Any], expected_uid: str | None = None
    ) -> bool:
        uid = user.get("uid")
        return bool(
            isinstance(uid, str)
            and (expected_uid is None or uid == expected_uid)
            and user.get("orgId") == self.settings.bootstrap_org_id
            and user.get("accountType") == "STAFF"
            and membership_status(user) in {ACTIVE_MEMBERSHIP, REMOVED_MEMBERSHIP}
            and user.get("organizationRole") in ORGANIZATION_ROLES
            and isinstance(user.get("organizationRoleRevision"), int)
            and user["organizationRoleRevision"] >= 1
            and user.get("createdAt") is not None
            and user.get("updatedAt") is not None
        )

    def _is_removal_audit(
        self, audit: Mapping[str, Any] | None, target_uid: str
    ) -> bool:
        return bool(
            audit is not None
            and set(audit)
            == {
                "eventType",
                "orgId",
                "actorUid",
                "targetUid",
                "roleBefore",
                "reason",
                "createdAt",
            }
            and audit.get("eventType") == "ORGANIZATION_MEMBER_REMOVED"
            and audit.get("orgId") == self.settings.bootstrap_org_id
            and isinstance(audit.get("actorUid"), str)
            and audit.get("targetUid") == target_uid
            and audit.get("roleBefore") in ORGANIZATION_ROLES
            and audit.get("reason") == "ORGANIZATION_ACCESS_REVOKED"
            and audit.get("createdAt") is not None
        )

    def _public_member(self, user: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "uid": user["uid"],
            "email": user.get("email"),
            "displayName": user.get("displayName"),
            "photoURL": user.get("photoURL"),
            "organizationRole": user["organizationRole"],
            "organizationRoleRevision": user["organizationRoleRevision"],
            "createdAt": user.get("createdAt"),
        }
