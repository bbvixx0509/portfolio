"""One-off, fail-closed baseline for existing private NoDo materials.

Run this only from the dedicated baseline worktree:

    python -m app.material_storage_quota_baseline --dry-run
    python -m app.material_storage_quota_baseline --apply

The default performs no writes.  ``--apply`` scans twice and writes quota
counter documents only if both metadata-only snapshots agree and contain no
unresolved upload.  It never downloads material content or changes uploads,
reservations, limits, courses, rooms, or Storage objects.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence

from google.api_core.exceptions import NotFound
from google.cloud import storage

from app.adapters.firebase_cloud_firestore import FirestoreCloudMaterialUploadRepository
from app.core.config import Settings
from app.services.cloud_material_storage_quota_service import (
    CloudMaterialStorageQuotaService,
    StorageQuotaBaseline,
)


def _object_size_reader(settings: Settings):
    settings.ensure_private_storage_uploads_enabled()
    client = storage.Client(project=settings.google_cloud_project)
    bucket = client.bucket(settings.storage_bucket)

    def object_size(object_path: str) -> int | None:
        try:
            blob = bucket.blob(object_path)
            blob.reload()
        except NotFound:
            return None
        return int(blob.size) if blob.size is not None else None

    return object_size


def _summary(value: StorageQuotaBaseline) -> dict[str, object]:
    """Expose aggregate counts only; no IDs, filenames, paths, or content."""

    return {
        "materialCount": value.material_count,
        "confirmedCount": value.confirmed_count,
        "pendingCount": value.pending_count,
        "instructorCount": len(value.instructor_used_bytes),
        "organizationUsedBytes": value.organization_used_bytes,
        "pendingReasons": dict(value.pending_reasons),
        "safeToApply": value.is_safe_to_apply,
    }


def run(*, apply: bool) -> dict[str, object]:
    settings = Settings()
    settings.ensure_private_storage_uploads_enabled()
    repository = FirestoreCloudMaterialUploadRepository.from_settings(settings)
    quota = CloudMaterialStorageQuotaService(repository, settings)
    object_size = _object_size_reader(settings)
    first = quota.calculate_baseline(object_size=object_size)
    result: dict[str, object] = {"dryRun": _summary(first), "applied": False}
    if not apply:
        return result
    if not first.is_safe_to_apply:
        raise RuntimeError("baseline contains unresolved material metadata")
    second = quota.calculate_baseline(object_size=object_size)
    if second != first:
        raise RuntimeError("baseline input changed before apply")
    quota.apply_baseline(second)
    third = quota.calculate_baseline(object_size=object_size)
    if third != second:
        raise RuntimeError("baseline input changed after apply")
    result["applied"] = True
    result["postApplyDryRun"] = _summary(third)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    arguments = parser.parse_args(argv)
    print(json.dumps(run(apply=arguments.apply), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
