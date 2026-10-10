"""Run only in the Firebase Emulator; production is intentionally blocked."""

from app.adapters.firebase_cloud_firestore import FirestoreCloudOrganizationRepository
from app.core.config import settings
from app.services.organization_role_migration import OrganizationRoleMigrationService


def main() -> None:
    settings.ensure_emulator_only()
    repository = FirestoreCloudOrganizationRepository.from_settings(settings)
    result = OrganizationRoleMigrationService(repository, settings).migrate_emulator()
    print(
        f"Migrated {result['members']} staff records; "
        f"administrators: {result['admins']}"
    )


if __name__ == "__main__":
    main()
