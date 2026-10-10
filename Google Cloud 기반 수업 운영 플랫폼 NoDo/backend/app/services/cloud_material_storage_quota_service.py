# ruff: noqa: E501
"""Server-side material storage quota accounting.

The counters are intentionally private implementation documents.  Clients only
receive their own aggregate snapshot and administrators receive display-name
based instructor aggregates.  A reservation is committed before Storage IO so
that simultaneous uploads cannot both consume the same remaining capacity.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any, Protocol
from uuid import uuid4

from app.core.config import Settings
from app.domain.errors import AccessDenied, InvalidOperation, StorageQuotaExceeded
from app.domain.staff_membership import has_active_membership
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import ADMIN, ORGANIZATION_ROLES

GIB = 1024**3
MIB = 1024**2
DEFAULT_INSTRUCTOR_LIMIT_BYTES = 5 * GIB
SCOPE_LIMIT_BYTES = 300 * MIB
ORGANIZATION_LIMIT_BYTES = 100 * GIB
RESERVATION_TTL = timedelta(minutes=15)

PERSONAL_QUOTA_MESSAGE = (
    "개인 자료 용량 한도를 초과했습니다. 관리자에게 한도 상향을 요청해 주세요."
)
SCOPE_QUOTA_MESSAGE = "이 수업의 자료 용량 한도(300MB)를 초과합니다."
ORGANIZATION_QUOTA_MESSAGE = (
    "조직 전체 자료 용량 한도에 도달했습니다. 관리자에게 문의해 주세요."
)


class QuotaTransaction(Protocol):
    @property
    def server_timestamp(self) -> object: ...
    def read_document(self, path: str) -> Mapping[str, Any] | None: ...
    def create_document(self, path: str, document: Mapping[str, Any]) -> None: ...
    def update_document(self, path: str, changes: Mapping[str, Any]) -> None: ...
    def list_expired_reservations(
        self, *, collection_path: str, before: datetime
    ) -> list[tuple[str, Mapping[str, Any]]]: ...


class QuotaRepository(Protocol):
    def read_document(self, path: str) -> Mapping[str, Any] | None: ...
    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]: ...
    def list_material_uploads(self, *, org_id: str) -> list[Mapping[str, Any]]: ...
    def run_transaction(self, callback: Any) -> Any: ...


@dataclass(frozen=True)
class StorageQuotaBaseline:
    """A validated, metadata-only accounting snapshot for existing uploads."""

    material_count: int
    confirmed_count: int
    pending_count: int
    instructor_used_bytes: Mapping[str, int]
    organization_used_bytes: int
    pending_reasons: Mapping[str, int]

    @property
    def is_safe_to_apply(self) -> bool:
        return self.pending_count == 0


def _now() -> datetime:
    return datetime.now(UTC)


class CloudMaterialStorageQuotaService:
    def __init__(
        self, repository: QuotaRepository, settings: Settings, *, clock=_now
    ) -> None:
        self.repository = repository
        self.settings = settings
        self.clock = clock

    def reserve_upload(
        self, identity: VerifiedCloudIdentity, *, scope_id: str, bytes_count: int
    ) -> str:
        self._require_staff(identity)
        if not isinstance(bytes_count, int) or bytes_count <= 0:
            raise InvalidOperation("자료 크기를 확인할 수 없습니다.")
        reservation_id = uuid4().hex
        org_path, instructor_path, scope_path, reservation_path = self._paths(
            identity.uid, scope_id, reservation_id
        )

        def reserve(tx: QuotaTransaction) -> None:
            self._require_staff(identity, transaction=tx)
            # Firestore transactions require every read (including a query) to
            # happen before their first write.  Gather the current request's
            # counters and any expired reservations up front, then apply all
            # counter and reservation changes together below.
            expired = tx.list_expired_reservations(
                collection_path=self._reservation_collection_path(), before=self.clock()
            )
            paths_with_limits: dict[str, int] = {
                org_path: ORGANIZATION_LIMIT_BYTES,
                instructor_path: DEFAULT_INSTRUCTOR_LIMIT_BYTES,
                scope_path: SCOPE_LIMIT_BYTES,
            }
            expired_records: list[
                tuple[str, Mapping[str, Any], tuple[str, str, str]]
            ] = []
            for expired_path, existing in expired:
                owner_uid = existing.get("ownerStaffUid")
                expired_scope_id = existing.get("scopeId")
                expired_reservation_id = existing.get("reservationId")
                if not all(
                    isinstance(value, str) and value
                    for value in (
                        owner_uid,
                        expired_scope_id,
                        expired_reservation_id,
                    )
                ):
                    continue
                expired_paths = self._paths(
                    owner_uid, expired_scope_id, expired_reservation_id
                )[:3]
                expired_records.append((expired_path, existing, expired_paths))
                paths_with_limits.setdefault(expired_paths[0], ORGANIZATION_LIMIT_BYTES)
                paths_with_limits.setdefault(
                    expired_paths[1], DEFAULT_INSTRUCTOR_LIMIT_BYTES
                )
                paths_with_limits.setdefault(expired_paths[2], SCOPE_LIMIT_BYTES)

            existing_counters = {
                path: tx.read_document(path) for path in paths_with_limits
            }
            counters = {
                path: self._counter(existing_counters[path], limit)
                for path, limit in paths_with_limits.items()
            }
            org = counters[org_path]
            instructor = counters[instructor_path]
            scope = counters[scope_path]
            self._reject_if_pending_baseline(org, instructor, scope)
            changed_paths: set[str] = set()
            for _, existing, expired_paths in expired_records:
                reserved = existing.get("bytes", 0)
                if not isinstance(reserved, int) or reserved <= 0:
                    continue
                for path in expired_paths:
                    counters[path]["reservedBytes"] = max(
                        0, counters[path]["reservedBytes"] - reserved
                    )
                    changed_paths.add(path)
            if (
                instructor["usedBytes"] + instructor["reservedBytes"] + bytes_count
                > instructor["limitBytes"]
            ):
                raise StorageQuotaExceeded(
                    PERSONAL_QUOTA_MESSAGE, quota_scope="PERSONAL"
                )
            if (
                scope["usedBytes"] + scope["reservedBytes"] + bytes_count
                > scope["limitBytes"]
            ):
                raise StorageQuotaExceeded(SCOPE_QUOTA_MESSAGE, quota_scope="SCOPE")
            if (
                org["usedBytes"] + org["reservedBytes"] + bytes_count
                > org["limitBytes"]
            ):
                raise StorageQuotaExceeded(
                    ORGANIZATION_QUOTA_MESSAGE, quota_scope="ORGANIZATION"
                )
            timestamp = tx.server_timestamp
            for counter in (org, instructor, scope):
                counter["reservedBytes"] += bytes_count
            changed_paths.update((org_path, instructor_path, scope_path))
            for path in changed_paths:
                self._write_counter(
                    tx,
                    path,
                    counters[path],
                    existing_counters[path],
                    timestamp,
                )
            for expired_path, existing, _ in expired_records:
                if isinstance(existing.get("bytes"), int) and existing["bytes"] > 0:
                    tx.update_document(
                        expired_path, {"status": "EXPIRED", "updatedAt": timestamp}
                    )
            tx.create_document(
                reservation_path,
                {
                    "reservationId": reservation_id,
                    "ownerStaffUid": identity.uid,
                    "scopeId": scope_id,
                    "bytes": bytes_count,
                    "expiresAt": self.clock() + RESERVATION_TTL,
                    "status": "RESERVED",
                    "createdAt": timestamp,
                    "updatedAt": timestamp,
                },
            )

        self.repository.run_transaction(reserve)
        return reservation_id

    def confirm_upload(
        self,
        identity: VerifiedCloudIdentity,
        *,
        scope_id: str,
        reservation_id: str,
        actual_bytes: int,
    ) -> None:
        self._settle(
            identity,
            scope_id=scope_id,
            reservation_id=reservation_id,
            actual_bytes=actual_bytes,
            success=True,
        )

    def release_upload(
        self, identity: VerifiedCloudIdentity, *, scope_id: str, reservation_id: str
    ) -> None:
        self._settle(
            identity,
            scope_id=scope_id,
            reservation_id=reservation_id,
            actual_bytes=0,
            success=False,
        )

    def own_usage(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        self._require_staff(identity)
        existing = self.repository.read_document(self._instructor_path(identity.uid))
        data = self._counter(existing, DEFAULT_INSTRUCTOR_LIMIT_BYTES)
        # A missing personal counter does not prove that this staff member has
        # used zero bytes.  Keep the response shape stable for clients, but
        # mark it pending so the UI never presents an invented 0MB usage.
        if existing is None:
            data["baselineState"] = "PENDING_BASELINE"
        return {
            "usedBytes": data["usedBytes"],
            "reservedBytes": data["reservedBytes"],
            "limitBytes": data["limitBytes"],
            "remainingBytes": max(
                0, data["limitBytes"] - data["usedBytes"] - data["reservedBytes"]
            ),
            "baselineState": data["baselineState"],
        }

    def list_instructor_usage(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        self._require_admin(identity)
        items = []
        for user in self.repository.list_staff_members(
            org_id=self.settings.bootstrap_org_id
        ):
            if user.get("organizationRole") not in ORGANIZATION_ROLES or not isinstance(
                user.get("uid"), str
            ):
                continue
            counter = self._counter(
                self.repository.read_document(self._instructor_path(user["uid"])),
                DEFAULT_INSTRUCTOR_LIMIT_BYTES,
            )
            items.append(
                {
                    "memberKey": self._member_key(user["uid"]),
                    "displayName": user.get("displayName") or "이름 미등록",
                    "usedBytes": counter["usedBytes"],
                    "reservedBytes": counter["reservedBytes"],
                    "limitBytes": counter["limitBytes"],
                    "remainingBytes": max(
                        0,
                        counter["limitBytes"]
                        - counter["usedBytes"]
                        - counter["reservedBytes"],
                    ),
                }
            )
        return {"instructors": sorted(items, key=lambda item: item["displayName"])}

    def set_instructor_limit(
        self, identity: VerifiedCloudIdentity, *, target_key: str, limit_bytes: int
    ) -> dict[str, Any]:
        self._require_admin(identity)
        if not isinstance(limit_bytes, int) or not GIB <= limit_bytes <= 100 * GIB:
            raise InvalidOperation("개인 한도는 1GB~100GB로 설정해 주세요.")
        target_uid = self._uid_for_member_key(target_key)
        if target_uid is None:
            raise AccessDenied("강사 한도 변경 권한이 없습니다.")
        path = self._instructor_path(target_uid)
        event_path = f"organizations/{self.settings.bootstrap_org_id}/auditLogs/instructor-storage-quota-{uuid4().hex}"
        result: dict[str, Any] = {}

        def update(tx: QuotaTransaction) -> None:
            self._require_admin(identity, transaction=tx)
            target = tx.read_document(f"users/{target_uid}")
            if not self._is_staff(target, target_uid):
                raise AccessDenied("강사 한도 변경 권한이 없습니다.")
            counter = self._counter(
                tx.read_document(path), DEFAULT_INSTRUCTOR_LIMIT_BYTES
            )
            if limit_bytes < counter["usedBytes"] + counter["reservedBytes"]:
                raise InvalidOperation(
                    "현재 사용량과 예약 용량보다 낮게 설정할 수 없습니다."
                )
            result.update(
                {
                    "usedBytes": counter["usedBytes"],
                    "reservedBytes": counter["reservedBytes"],
                    "limitBytes": limit_bytes,
                    "remainingBytes": limit_bytes
                    - counter["usedBytes"]
                    - counter["reservedBytes"],
                }
            )
            if limit_bytes == counter["limitBytes"]:
                return
            timestamp = tx.server_timestamp
            changes = {
                "usedBytes": counter["usedBytes"],
                "reservedBytes": counter["reservedBytes"],
                "limitBytes": limit_bytes,
                "baselineState": counter["baselineState"],
                "updatedAt": timestamp,
            }
            if tx.read_document(path) is None:
                tx.create_document(path, changes | {"createdAt": timestamp})
            else:
                tx.update_document(path, changes)
            tx.create_document(
                event_path,
                {
                    "eventType": "INSTRUCTOR_STORAGE_QUOTA_SET",
                    "orgId": self.settings.bootstrap_org_id,
                    "targetStaffRef": target_uid,
                    "actorAdminRef": identity.uid,
                    "before": {"limitBytes": counter["limitBytes"]},
                    "after": {"limitBytes": limit_bytes},
                    "createdAt": timestamp,
                },
            )

        self.repository.run_transaction(update)
        return result

    def calculate_baseline(
        self,
        *,
        object_size: Callable[[str], int | None],
    ) -> StorageQuotaBaseline:
        """Calculate absolute usage without downloading any material content.

        An upload is eligible only when its private source-object path and
        Storage metadata agree.  Any ambiguity deliberately leaves the whole
        run in ``PENDING_BASELINE`` rather than silently treating bytes as zero.
        """

        totals: defaultdict[str, int] = defaultdict(int)
        pending_reasons: defaultdict[str, int] = defaultdict(int)
        uploads = self.repository.list_material_uploads(
            org_id=self.settings.bootstrap_org_id
        )
        for material in uploads:
            owner_uid = material.get("ownerStaffUid")
            metadata_bytes = material.get("sizeBytes")
            object_path = material.get("storageObjectPath")
            if not isinstance(owner_uid, str) or not owner_uid:
                pending_reasons["OWNER_MISSING"] += 1
                continue
            if not isinstance(metadata_bytes, int) or metadata_bytes < 0:
                pending_reasons["METADATA_SIZE_INVALID"] += 1
                continue
            if not self._is_expected_material_object_path(object_path):
                pending_reasons["OBJECT_PATH_INVALID"] += 1
                continue
            try:
                storage_bytes = object_size(object_path)
            except Exception:
                pending_reasons["OBJECT_METADATA_UNAVAILABLE"] += 1
                continue
            if not isinstance(storage_bytes, int) or storage_bytes < 0:
                pending_reasons["OBJECT_MISSING"] += 1
                continue
            if storage_bytes != metadata_bytes:
                pending_reasons["OBJECT_SIZE_MISMATCH"] += 1
                continue
            totals[owner_uid] += storage_bytes

        confirmed_count = len(uploads) - sum(pending_reasons.values())
        return StorageQuotaBaseline(
            material_count=len(uploads),
            confirmed_count=confirmed_count,
            pending_count=sum(pending_reasons.values()),
            instructor_used_bytes=dict(totals),
            organization_used_bytes=sum(totals.values()),
            pending_reasons=dict(pending_reasons),
        )

    def apply_baseline(self, baseline: StorageQuotaBaseline) -> None:
        """Write absolute counters only for a fully validated snapshot.

        Existing limits and in-flight reservations are retained.  This writes
        no material metadata, Storage object, reservation, or audit document.
        """

        if not baseline.is_safe_to_apply:
            raise InvalidOperation("기존 자료 용량 기준값을 확인한 뒤 적용할 수 있습니다.")
        org_path = self._organization_path()
        instructor_paths = {
            uid: self._instructor_path(uid)
            for uid in baseline.instructor_used_bytes
        }

        def apply(tx: QuotaTransaction) -> None:
            paths = (org_path, *instructor_paths.values())
            existing = {path: tx.read_document(path) for path in paths}
            timestamp = tx.server_timestamp
            organization = self._counter(existing[org_path], ORGANIZATION_LIMIT_BYTES)
            organization["usedBytes"] = baseline.organization_used_bytes
            organization["baselineState"] = "BASELINED"
            self._write_counter(tx, org_path, organization, existing[org_path], timestamp)
            for uid, path in instructor_paths.items():
                instructor = self._counter(
                    existing[path], DEFAULT_INSTRUCTOR_LIMIT_BYTES
                )
                instructor["usedBytes"] = baseline.instructor_used_bytes[uid]
                instructor["baselineState"] = "BASELINED"
                self._write_counter(tx, path, instructor, existing[path], timestamp)

        self.repository.run_transaction(apply)

    def _settle(
        self,
        identity: VerifiedCloudIdentity,
        *,
        scope_id: str,
        reservation_id: str,
        actual_bytes: int,
        success: bool,
    ) -> None:
        org_path, instructor_path, scope_path, reservation_path = self._paths(
            identity.uid, scope_id, reservation_id
        )

        def settle(tx: QuotaTransaction) -> None:
            reservation = tx.read_document(reservation_path)
            if reservation is None or reservation.get("status") != "RESERVED":
                return
            reserved = reservation.get("bytes")
            if not isinstance(reserved, int) or reserved <= 0:
                raise InvalidOperation("자료 예약을 확인할 수 없습니다.")
            if success and actual_bytes != reserved:
                raise InvalidOperation("저장된 자료 크기를 확인할 수 없습니다.")
            paths_with_limits = (
                (org_path, ORGANIZATION_LIMIT_BYTES),
                (instructor_path, DEFAULT_INSTRUCTOR_LIMIT_BYTES),
                (scope_path, SCOPE_LIMIT_BYTES),
            )
            existing_counters = {
                path: tx.read_document(path) for path, _ in paths_with_limits
            }
            timestamp = tx.server_timestamp
            for path, default in paths_with_limits:
                counter = self._counter(existing_counters[path], default)
                counter["reservedBytes"] = max(0, counter["reservedBytes"] - reserved)
                counter["usedBytes"] += reserved if success else 0
                self._write_counter(
                    tx, path, counter, existing_counters[path], timestamp
                )
            tx.update_document(
                reservation_path,
                {
                    "status": "CONFIRMED" if success else "RELEASED",
                    "updatedAt": timestamp,
                },
            )

        self.repository.run_transaction(settle)

    def _write_counter(
        self,
        tx: QuotaTransaction,
        path: str,
        counter: Mapping[str, Any],
        existing: Mapping[str, Any] | None,
        timestamp: object,
    ) -> None:
        changes = {
            "usedBytes": counter["usedBytes"],
            "reservedBytes": counter["reservedBytes"],
            "limitBytes": counter["limitBytes"],
            "baselineState": counter["baselineState"],
            "updatedAt": timestamp,
        }
        if existing is None:
            tx.create_document(path, changes | {"createdAt": timestamp})
        else:
            tx.update_document(path, changes)

    def _require_staff(
        self,
        identity: VerifiedCloudIdentity,
        *,
        transaction: QuotaTransaction | None = None,
    ) -> None:
        user = (
            transaction.read_document if transaction else self.repository.read_document
        )(f"users/{identity.uid}")
        if not self._is_staff(user, identity.uid):
            raise AccessDenied("자료 저장 권한이 없습니다.")

    def _require_admin(
        self,
        identity: VerifiedCloudIdentity,
        *,
        transaction: QuotaTransaction | None = None,
    ) -> None:
        self._require_staff(identity, transaction=transaction)
        user = (
            transaction.read_document if transaction else self.repository.read_document
        )(f"users/{identity.uid}")
        if user is None or user.get("organizationRole") != ADMIN:
            raise AccessDenied("자료 용량 관리 권한이 없습니다.")

    def _is_staff(self, user: Mapping[str, Any] | None, uid: str) -> bool:
        return bool(
            user
            and user.get("uid", uid) == uid
            and user.get("orgId") == self.settings.bootstrap_org_id
            and user.get("accountType") == "STAFF"
            and has_active_membership(user)
            and user.get("organizationRole") in ORGANIZATION_ROLES
        )

    def _counter(
        self, data: Mapping[str, Any] | None, default_limit: int
    ) -> dict[str, Any]:
        if data is None:
            return {
                "usedBytes": 0,
                "reservedBytes": 0,
                "limitBytes": default_limit,
                "baselineState": "READY",
            }
        return {
            "usedBytes": int(data.get("usedBytes", 0)),
            "reservedBytes": int(data.get("reservedBytes", 0)),
            "limitBytes": int(data.get("limitBytes", default_limit)),
            "baselineState": data.get("baselineState", "PENDING_BASELINE"),
        }

    def _reject_if_pending_baseline(self, *counters: Mapping[str, Any]) -> None:
        if any(counter["baselineState"] == "PENDING_BASELINE" for counter in counters):
            raise InvalidOperation(
                "기존 자료 용량 기준값을 확인한 뒤 업로드할 수 있습니다."
            )

    def _organization_path(self) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/storageQuotaOrganization/quota"

    def _instructor_path(self, uid: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/storageQuotaInstructors/{uid}"

    def _paths(
        self, uid: str, scope_id: str, reservation_id: str
    ) -> tuple[str, str, str, str]:
        base = f"organizations/{self.settings.bootstrap_org_id}"
        return (
            f"{base}/storageQuotaOrganization/quota",
            f"{base}/storageQuotaInstructors/{uid}",
            f"{base}/storageQuotaScopes/{scope_id}",
            f"{base}/storageQuotaReservations/{reservation_id}",
        )

    def _reservation_collection_path(self) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/storageQuotaReservations"

    def _is_expected_material_object_path(self, value: object) -> bool:
        if not isinstance(value, str):
            return False
        prefix = (
            f"organizations/{self.settings.bootstrap_org_id}/material-uploads/"
        )
        return value.startswith(prefix) and value.endswith(("/source.pdf", "/source.pptx"))

    def _member_key(self, uid: str) -> str:
        return sha256(f"{self.settings.bootstrap_org_id}:{uid}".encode()).hexdigest()

    def _uid_for_member_key(self, member_key: str) -> str | None:
        for user in self.repository.list_staff_members(
            org_id=self.settings.bootstrap_org_id
        ):
            uid = user.get("uid")
            if isinstance(uid, str) and self._member_key(uid) == member_key:
                return uid
        return None
