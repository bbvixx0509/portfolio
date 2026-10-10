"""Emulator-only compatibility migration for the organization role model.

The legacy Boolean fields are read here solely to map old records once.  Runtime
authorization services never import or use this module.
"""

from app.core.config import EMULATOR_RUNTIME_MODE, Settings
from app.domain.errors import InvalidOperation, ResourceConflict
from app.services.cloud_organization_service import (
    ADMIN,
    INSTRUCTOR,
    ORGANIZATION_ROLES,
    SCHEMA_VERSION,
    CloudOrganizationRepository,
    CloudOrganizationTransaction,
)

MIGRATION_AUDIT_LOG_ID = "organization-role-model-migrated-v1"


class OrganizationRoleMigrationService:
    """Idempotent conversion used only against the Firebase Emulator."""

    def __init__(
        self, repository: CloudOrganizationRepository, settings: Settings
    ) -> None:
        self.repository = repository
        self.settings = settings

    def migrate_emulator(self) -> dict[str, int]:
        if self.settings.runtime_mode != EMULATOR_RUNTIME_MODE:
            raise InvalidOperation("Organization role migration is emulator-only")
        org_id = self.settings.bootstrap_org_id
        members = self.repository.list_staff_members(org_id=org_id)
        member_uids = [member.get("uid") for member in members]
        if not member_uids or not all(
            isinstance(uid, str) and uid for uid in member_uids
        ):
            raise ResourceConflict("Organization staff documents are inconsistent")
        changed = 0
        roles = {
            uid: ADMIN
            if member.get("isOrgOwner") is True or member.get("isOrgAdmin") is True
            else INSTRUCTOR
            for uid, member in zip(member_uids, members, strict=True)
        }
        admin_count = sum(role == ADMIN for role in roles.values())
        if admin_count < 1:
            raise ResourceConflict(
                "The organization migration requires one administrator"
            )

        def migrate(transaction: CloudOrganizationTransaction) -> None:
            nonlocal changed
            organization = transaction.read_document(f"organizations/{org_id}")
            if organization is None:
                raise ResourceConflict("Organization documents are inconsistent")
            timestamp = transaction.server_timestamp
            for uid, role in roles.items():
                user = transaction.read_document(f"users/{uid}")
                if user is None:
                    raise ResourceConflict(
                        "Organization staff documents are inconsistent"
                    )
                if user.get("organizationRole") not in ORGANIZATION_ROLES:
                    transaction.update_document(
                        f"users/{uid}",
                        {
                            "organizationRole": role,
                            "organizationRoleRevision": 1,
                            "updatedAt": timestamp,
                        },
                    )
                    changed += 1
            if organization.get("adminCount") != admin_count:
                transaction.update_document(
                    f"organizations/{org_id}",
                    {"adminCount": admin_count, "updatedAt": timestamp},
                )
            audit_path = f"organizations/{org_id}/auditLogs/{MIGRATION_AUDIT_LOG_ID}"
            if transaction.read_document(audit_path) is None:
                transaction.create_document(
                    audit_path,
                    {
                        "eventType": "ORGANIZATION_ROLE_MODEL_MIGRATED",
                        "orgId": org_id,
                        "actorUid": None,
                        "targetUid": None,
                        "before": {"authorizationModel": "LEGACY_COMPATIBILITY"},
                        "after": {"adminCount": admin_count},
                        "schemaVersion": SCHEMA_VERSION,
                        "createdAt": timestamp,
                    },
                )

        self.repository.run_transaction(migrate)
        return {"members": len(roles), "admins": admin_count, "changed": changed}
