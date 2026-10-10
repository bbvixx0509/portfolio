"""Private room-material delivery and lead-controlled unit synchronization.

This service deliberately keeps Storage object names and complete extraction
payloads on the server.  Browser clients receive only a small room snapshot and
the currently selected PDF bytes or PPTX slide text through authenticated API
routes.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from io import BytesIO
from typing import Any, Protocol, TypeVar

from app.core.config import Settings
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    ResourceConflict,
    ResourceNotFound,
)
from app.domain.room_student_access import (
    ended_student_access_deadline,
    ended_student_access_open,
    utc_datetime,
)
from app.domain.staff_membership import has_active_membership
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import SCHEMA_VERSION
from app.services.cloud_room_service import ENDED, LIVE, CloudRoomTransaction
from app.services.student_auth_service import VerifiedStudentIdentity

TransactionResult = TypeVar("TransactionResult")
MAX_MATERIAL_UNITS = 300
MAX_PPTX_UNIT_CHARACTERS = 24_000
MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024


class CloudRoomMaterialRepository(Protocol):
    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def run_transaction(
        self, callback: Callable[[CloudRoomTransaction], TransactionResult]
    ) -> TransactionResult: ...


class PrivateRoomMaterialStorage(Protocol):
    def download_source(self, *, object_path: str, destination: BytesIO) -> object: ...

    def download_extraction(
        self, *, object_path: str, destination: BytesIO
    ) -> None: ...


@dataclass(frozen=True)
class RoomMaterialContent:
    kind: str
    data: bytes | dict[str, Any]


@dataclass(frozen=True)
class RoomMaterialDownload:
    content: bytes
    file_type: str
    filename: str


class CloudRoomMaterialService:
    def __init__(
        self,
        repository: CloudRoomMaterialRepository,
        storage: PrivateRoomMaterialStorage | None,
        settings: Settings,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.repository = repository
        self.storage = storage
        self.settings = settings
        self.clock = clock or (lambda: datetime.now(UTC))

    def staff_material(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, Any]:
        room = self._staff_room(identity, room_id)
        snapshot = self._snapshot(room.get("materialSnapshot"))
        return {
            "material": self._public_snapshot(
                snapshot,
                can_control=(
                    room.get("leadInstructorUid") == identity.uid
                    and room.get("status") != ENDED
                ),
            )
        }

    def student_material(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> dict[str, Any]:
        room = self._student_room(identity, org_id, room_code, allow_historical=True)
        snapshot = self._snapshot(room.get("materialSnapshot"))
        return {"material": self._public_snapshot(snapshot, can_control=False)}

    def staff_content(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> RoomMaterialContent:
        room = self._staff_room(identity, room_id)
        return self._content(room)

    def student_content(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> RoomMaterialContent:
        room = self._student_room(identity, org_id, room_code, allow_historical=True)
        return self._content(room)

    def staff_access(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, Any]:
        room = self._staff_room(identity, room_id)
        return {
            "material": self._access(
                room,
                can_manage=(
                    room.get("leadInstructorUid") == identity.uid
                    and room.get("status") != ENDED
                ),
                can_download=True,
                can_view_policy=room.get("leadInstructorUid") == identity.uid,
                policy_locked=(
                    room.get("leadInstructorUid") == identity.uid
                    and room.get("status") == ENDED
                ),
            )
        }

    def student_access(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> dict[str, Any]:
        room = self._student_room(identity, org_id, room_code, allow_historical=True)
        return {
            "material": self._access(
                room,
                can_manage=False,
                can_download=self._student_download_allowed(room),
                can_view_policy=False,
                policy_locked=False,
            )
        }

    def update_download_policy(
        self, identity: VerifiedCloudIdentity, room_id: str, payload: Mapping[str, Any]
    ) -> dict[str, Any]:
        enabled = payload.get("downloadEnabled")
        expected = payload.get("expectedDownloadPolicyRevision")
        until_raw = payload.get("downloadAvailableUntil")
        if (
            not isinstance(enabled, bool)
            or isinstance(expected, bool)
            or not isinstance(expected, int)
            or expected < 1
        ):
            raise InvalidOperation("The material download policy is invalid")
        until = self._parse_until(until_raw) if enabled else None
        if enabled and until is None:
            raise InvalidOperation("A download expiry is required")

        def update(transaction: CloudRoomTransaction) -> dict[str, Any]:
            room = self._transaction_staff_room(transaction, identity, room_id)
            if room.get("leadInstructorUid") != identity.uid:
                raise AccessDenied(
                    "Only the lead instructor can change the download policy"
                )
            if room.get("status") == ENDED:
                raise ResourceConflict(
                    "The material download policy cannot be changed after the room ends"
                )
            if room.get("status") != LIVE:
                raise ResourceConflict(
                    "The material download policy can only be changed "
                    "while the room is live"
                )
            if self._snapshot(room.get("materialSnapshot")) is None:
                raise ResourceNotFound("This room has no linked material")
            current = self._policy(room)
            if current["downloadPolicyRevision"] != expected:
                raise ResourceConflict(
                    "The material download policy has changed. Refresh and try again"
                )
            next_until = until.isoformat() if until else None
            if (
                current["downloadEnabled"] == enabled
                and current["downloadAvailableUntil"] == next_until
            ):
                return {
                    "material": self._access(
                        room,
                        can_manage=True,
                        can_download=True,
                        can_view_policy=True,
                        policy_locked=False,
                    )
                }
            timestamp = transaction.server_timestamp
            next_policy = {
                "downloadEnabled": enabled,
                "downloadAvailableFrom": datetime.now(UTC).isoformat()
                if enabled
                else None,
                "downloadAvailableUntil": next_until,
                "downloadPolicyRevision": expected + 1,
                "updatedAt": timestamp,
            }
            revision = int(room.get("revision", 1)) + 1
            transaction.update_document(
                self._room_path(room_id),
                {
                    "materialDownloadPolicy": next_policy,
                    "revision": revision,
                    "updatedAt": timestamp,
                },
            )
            transaction.create_document(
                f"organizations/{self.settings.bootstrap_org_id}/auditLogs/room_material_download_policy_updated-{room_id}-{revision}",
                {
                    "eventType": "ROOM_MATERIAL_DOWNLOAD_POLICY_UPDATED",
                    "orgId": self.settings.bootstrap_org_id,
                    "roomId": room_id,
                    "actorUid": identity.uid,
                    "downloadEnabled": enabled,
                    "downloadPolicyRevision": expected + 1,
                    "createdAt": timestamp,
                },
            )
            return {
                "material": self._access(
                    {**room, "materialDownloadPolicy": next_policy},
                    can_manage=True,
                    can_download=True,
                    can_view_policy=True,
                    policy_locked=False,
                )
            }

        return self.repository.run_transaction(update)

    def staff_download(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> RoomMaterialDownload:
        return self._download(self._staff_room(identity, room_id))

    def student_download(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> RoomMaterialDownload:
        room = self._student_room(identity, org_id, room_code, allow_historical=True)
        if not self._student_download_allowed(room):
            raise AccessDenied("현재 자료를 다운로드할 수 없습니다.")
        return self._download(room)

    def update_position(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        unit_number: int,
        expected_material_revision: int,
    ) -> dict[str, Any]:
        self._id(room_id, "room")

        def update(transaction: CloudRoomTransaction) -> dict[str, Any]:
            room = self._transaction_staff_room(transaction, identity, room_id)
            if room.get("leadInstructorUid") != identity.uid:
                raise AccessDenied(
                    "Only the lead instructor can change material position"
                )
            if room.get("status") == "ENDED":
                raise ResourceConflict(
                    "Material position cannot be changed after the room ends"
                )
            snapshot = self._snapshot(room.get("materialSnapshot"))
            if snapshot is None:
                raise ResourceNotFound("This room has no linked material")
            if snapshot["materialRevision"] != expected_material_revision:
                raise ResourceConflict(
                    "The material position has changed. Refresh and try again"
                )
            if not 1 <= unit_number <= snapshot["totalUnits"]:
                raise InvalidOperation("The requested material unit is out of range")
            if unit_number == snapshot["currentUnitNumber"]:
                return {"material": self._public_snapshot(snapshot, can_control=True)}
            next_snapshot = {
                **snapshot,
                "currentUnitNumber": unit_number,
                "materialRevision": snapshot["materialRevision"] + 1,
            }
            transaction.update_document(
                self._room_path(room_id),
                {
                    "materialSnapshot": next_snapshot,
                    "updatedAt": transaction.server_timestamp,
                },
            )
            return {"material": self._public_snapshot(next_snapshot, can_control=True)}

        return self.repository.run_transaction(update)

    # --- private content -------------------------------------------------

    def _content(self, room: Mapping[str, Any]) -> RoomMaterialContent:
        snapshot = self._snapshot(room.get("materialSnapshot"))
        if snapshot is None:
            raise ResourceNotFound("This room has no linked material")
        if self.storage is None:
            raise InvalidOperation("The private material display is unavailable")
        material = self.repository.read_document(
            self._material_path(snapshot["sourceMaterialId"])
        )
        self._assert_snapshot_source(material, snapshot)
        if snapshot["fileType"] == "pdf":
            source = BytesIO()
            self.storage.download_source(
                object_path=self._source_path(snapshot["sourceMaterialId"], "pdf"),
                destination=source,
            )
            return RoomMaterialContent(kind="pdf", data=source.getvalue())
        extraction = BytesIO()
        self.storage.download_extraction(
            object_path=self._extraction_path(snapshot["sourceMaterialId"]),
            destination=extraction,
        )
        return RoomMaterialContent(
            kind="pptx",
            data=self._slide_content(extraction.getvalue(), snapshot),
        )

    def _download(self, room: Mapping[str, Any]) -> RoomMaterialDownload:
        snapshot = self._snapshot(room.get("materialSnapshot"))
        if snapshot is None or self.storage is None:
            raise ResourceNotFound("This room has no linked material")
        material = self.repository.read_document(
            self._material_path(snapshot["sourceMaterialId"])
        )
        self._assert_snapshot_source(material, snapshot)
        source = BytesIO()
        self.storage.download_source(
            object_path=self._source_path(
                snapshot["sourceMaterialId"], snapshot["fileType"]
            ),
            destination=source,
        )
        content = source.getvalue()
        if not content or len(content) > MAX_DOWNLOAD_BYTES:
            raise InvalidOperation("The room material download is unavailable")
        return RoomMaterialDownload(
            content=content,
            file_type=snapshot["fileType"],
            filename=self._safe_filename(
                snapshot["displayTitle"], snapshot["fileType"]
            ),
        )

    def _slide_content(
        self, payload: bytes, snapshot: Mapping[str, Any]
    ) -> dict[str, Any]:
        try:
            extraction = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise InvalidOperation("The room material extraction is invalid") from error
        if not isinstance(extraction, Mapping) or extraction.get("kind") != "PPTX":
            raise InvalidOperation("The room material extraction is invalid")
        slides = extraction.get("slides")
        if not isinstance(slides, list):
            raise InvalidOperation("The room material extraction is invalid")
        current = snapshot["currentUnitNumber"]
        slide = next(
            (
                candidate
                for candidate in slides
                if isinstance(candidate, Mapping)
                and candidate.get("slideNumber") == current
            ),
            None,
        )
        if not isinstance(slide, Mapping):
            raise InvalidOperation("The room material extraction is invalid")
        title = slide.get("titleCandidate")
        text = slide.get("text")
        if not isinstance(text, str):
            raise InvalidOperation("The room material extraction is invalid")
        return {
            "unitNumber": current,
            "title": title.strip()[:500]
            if isinstance(title, str) and title.strip()
            else None,
            "text": text.strip()[:MAX_PPTX_UNIT_CHARACTERS],
        }

    # --- authorization and room snapshots --------------------------------

    def _staff_room(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> Mapping[str, Any]:
        self._id(room_id, "room")
        user = self.repository.read_document(f"users/{identity.uid}")
        room = self.repository.read_document(self._room_path(room_id))
        return self._require_staff_room(user, room, identity, room_id)

    def _transaction_staff_room(
        self,
        transaction: CloudRoomTransaction,
        identity: VerifiedCloudIdentity,
        room_id: str,
    ) -> Mapping[str, Any]:
        user = transaction.read_document(f"users/{identity.uid}")
        room = transaction.read_document(self._room_path(room_id))
        return self._require_staff_room(user, room, identity, room_id)

    def _require_staff_room(
        self,
        user: Mapping[str, Any] | None,
        room: Mapping[str, Any] | None,
        identity: VerifiedCloudIdentity,
        room_id: str,
    ) -> Mapping[str, Any]:
        if not self._is_staff(user, identity.uid):
            raise AccessDenied("Only organization staff can access room material")
        if not self._is_room(room, room_id):
            raise ResourceNotFound("The room was not found")
        assert room is not None and user is not None
        if user.get("organizationRole") != "ADMIN" and identity.uid not in room.get(
            "instructorMemberUids", []
        ):
            raise AccessDenied("Only room instructors can access room material")
        return room

    def _student_room(
        self,
        identity: VerifiedStudentIdentity,
        org_id: str,
        room_code: str,
        *,
        allow_historical: bool = False,
    ) -> Mapping[str, Any]:
        if org_id != self.settings.bootstrap_org_id:
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        code = self._room_code(room_code)
        index = self.repository.read_document(self._room_code_path(code))
        room_id = index.get("roomId") if isinstance(index, Mapping) else None
        room = (
            self.repository.read_document(self._room_path(room_id))
            if isinstance(room_id, str)
            else None
        )
        if not (
            self._is_live_room(room, room_id, code)
            or (
                allow_historical
                and isinstance(room_id, str)
                and self._is_room(room, room_id)
                and room is not None
                and room.get("status") == ENDED
                and room.get("roomCode") == code
                and ended_student_access_open(room, self._now())
            )
        ):
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        participant = self.repository.read_document(
            self._participant_path(room_id, identity.uid)
        )
        if not self._is_active_participant(participant) and not (
            allow_historical
            and room is not None
            and room.get("status") == ENDED
            and ended_student_access_open(room, self._now())
            and self._is_historical_participant(participant)
        ):
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        assert room is not None
        return room

    def _access(
        self,
        room: Mapping[str, Any],
        *,
        can_manage: bool,
        can_download: bool,
        can_view_policy: bool,
        policy_locked: bool,
    ) -> dict[str, Any] | None:
        snapshot = self._snapshot(room.get("materialSnapshot"))
        if snapshot is None:
            return None
        policy = self._policy(room)
        return {
            "displayTitle": snapshot["displayTitle"],
            "fileType": snapshot["fileType"],
            "totalUnits": snapshot["totalUnits"],
            "currentUnitNumber": snapshot["currentUnitNumber"],
            "materialRevision": snapshot["materialRevision"],
            # Keep the access response compatible with the material metadata
            # contract.  The client must not infer this from its own role.
            "canControl": can_manage,
            "canManageDownloadPolicy": can_manage,
            "canViewDownloadPolicy": can_view_policy,
            "downloadPolicyLocked": policy_locked,
            "downloadAllowed": can_download,
            **policy,
        }

    def _policy(self, room: Mapping[str, Any]) -> dict[str, Any]:
        value = room.get("materialDownloadPolicy")
        if not isinstance(value, Mapping):
            policy = {
                "downloadEnabled": False,
                "downloadAvailableFrom": None,
                "downloadAvailableUntil": None,
                "downloadPolicyRevision": 1,
            }
        else:
            policy = {
                "downloadEnabled": value.get("downloadEnabled") is True,
                "downloadAvailableFrom": value.get("downloadAvailableFrom")
                if isinstance(value.get("downloadAvailableFrom"), str)
                else None,
                "downloadAvailableUntil": value.get("downloadAvailableUntil")
                if isinstance(value.get("downloadAvailableUntil"), str)
                else None,
                "downloadPolicyRevision": value.get("downloadPolicyRevision")
                if isinstance(value.get("downloadPolicyRevision"), int)
                and value.get("downloadPolicyRevision") >= 1
                else 1,
            }
        if room.get("status") != ENDED or policy["downloadAvailableUntil"]:
            return policy
        deadline = ended_student_access_deadline(room)
        if deadline is None:
            return policy
        ended_at = utc_datetime(room.get("endedAt"))
        return {
            **policy,
            "downloadEnabled": True,
            "downloadAvailableFrom": ended_at.isoformat() if ended_at else None,
            "downloadAvailableUntil": deadline.isoformat(),
        }

    def _student_download_allowed(self, room: Mapping[str, Any]) -> bool:
        if room.get("status") == ENDED:
            return ended_student_access_open(room, self._now())
        policy = self._policy(room)
        if (
            not policy["downloadEnabled"]
            or not policy["downloadAvailableFrom"]
            or not policy["downloadAvailableUntil"]
        ):
            return False
        try:
            now = self._now()
            return (
                datetime.fromisoformat(policy["downloadAvailableFrom"]).astimezone(UTC)
                <= now
                <= datetime.fromisoformat(policy["downloadAvailableUntil"]).astimezone(
                    UTC
                )
            )
        except ValueError:
            return False

    def _now(self) -> datetime:
        value = self.clock()
        return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)

    @staticmethod
    def _parse_until(value: object) -> datetime | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise InvalidOperation("The download expiry is invalid")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
                UTC
            )
        except ValueError as error:
            raise InvalidOperation("The download expiry is invalid") from error
        now = datetime.now(UTC)
        if not now < parsed <= now + timedelta(days=365):
            raise InvalidOperation("The download expiry is outside the allowed range")
        return parsed

    @staticmethod
    def _safe_filename(title: str, file_type: str) -> str:
        stem = (
            re.sub(r"[^A-Za-z0-9._ -]+", "_", title).strip(" ._")[:80]
            or "nodo-material"
        )
        suffix = f".{file_type}"
        return stem if stem.lower().endswith(suffix) else f"{stem}{suffix}"

    def _snapshot(self, value: object) -> dict[str, Any] | None:
        if value is None:
            return None
        if not isinstance(value, Mapping):
            raise InvalidOperation("The room material snapshot is invalid")
        material_id = self._id(value.get("sourceMaterialId"), "material")
        draft_id = self._id(value.get("sourceDraftId"), "draft")
        title = value.get("displayTitle")
        file_type = value.get("fileType")
        total_units = value.get("totalUnits")
        current = value.get("currentUnitNumber")
        revision = value.get("materialRevision")
        source_revision = value.get("sourceMaterialRevision")
        if (
            not isinstance(title, str)
            or not title.strip()
            or len(title.strip()) > 255
            or file_type not in {"pdf", "pptx"}
            or isinstance(total_units, bool)
            or not isinstance(total_units, int)
            or not 1 <= total_units <= MAX_MATERIAL_UNITS
            or isinstance(current, bool)
            or not isinstance(current, int)
            or not 1 <= current <= total_units
            or isinstance(revision, bool)
            or not isinstance(revision, int)
            or revision < 1
            or not isinstance(source_revision, str)
            or not source_revision
        ):
            raise InvalidOperation("The room material snapshot is invalid")
        return {
            "sourceMaterialId": material_id,
            "sourceDraftId": draft_id,
            "displayTitle": title.strip(),
            "fileType": file_type,
            "totalUnits": total_units,
            "sourceMaterialRevision": source_revision,
            "currentUnitNumber": current,
            "materialRevision": revision,
        }

    @staticmethod
    def _public_snapshot(
        snapshot: Mapping[str, Any] | None, *, can_control: bool
    ) -> dict[str, Any] | None:
        if snapshot is None:
            return None
        return {
            "displayTitle": snapshot["displayTitle"],
            "fileType": snapshot["fileType"],
            "totalUnits": snapshot["totalUnits"],
            "currentUnitNumber": snapshot["currentUnitNumber"],
            "materialRevision": snapshot["materialRevision"],
            "canControl": can_control,
        }

    def _assert_snapshot_source(
        self, material: Mapping[str, Any] | None, snapshot: Mapping[str, Any]
    ) -> None:
        if not isinstance(material, Mapping) or not (
            material.get("id") == snapshot["sourceMaterialId"]
            and material.get("orgId") == self.settings.bootstrap_org_id
            and material.get("status") == "EXTRACTED"
            and material.get("extractionStatus") == "EXTRACTED"
            and material.get("normalizedExtension") == snapshot["fileType"]
            and (
                f"{material.get('sourceObjectGeneration')}:"
                f"{material.get('extractionVersion')}"
            )
            == snapshot["sourceMaterialRevision"]
        ):
            raise InvalidOperation("The room material source is unavailable")

    def _is_staff(self, user: Mapping[str, Any] | None, uid: str) -> bool:
        return bool(
            user
            and user.get("uid") == uid
            and user.get("orgId") == self.settings.bootstrap_org_id
            and user.get("accountType") == "STAFF"
            and has_active_membership(user)
            and user.get("organizationRole") in {"ADMIN", "INSTRUCTOR"}
        )

    def _is_room(self, room: Mapping[str, Any] | None, room_id: str) -> bool:
        return bool(
            room
            and room.get("id") == room_id
            and room.get("orgId") == self.settings.bootstrap_org_id
            and room.get("schemaVersion") == SCHEMA_VERSION
            and room.get("status") in {"READY", LIVE, "ENDED"}
            and isinstance(room.get("roomCode"), str)
            and isinstance(room.get("leadInstructorUid"), str)
            and isinstance(room.get("instructorMemberUids"), list)
        )

    def _is_live_room(
        self, room: Mapping[str, Any] | None, room_id: object, room_code: str
    ) -> bool:
        return bool(
            isinstance(room_id, str)
            and self._is_room(room, room_id)
            and room is not None
            and room.get("status") == LIVE
            and room.get("roomCode") == room_code
        )

    @staticmethod
    def _is_active_participant(participant: Mapping[str, Any] | None) -> bool:
        return bool(
            participant
            and participant.get("participantStatus") == "JOINED"
            and participant.get("presenceStatus") == "ACTIVE"
            and participant.get("isAnonymous") is True
        )

    @staticmethod
    def _is_historical_participant(participant: Mapping[str, Any] | None) -> bool:
        return bool(
            participant
            and participant.get("isAnonymous") is True
            and participant.get("participantStatus") == "JOINED"
            and participant.get("presenceStatus") in {"ACTIVE", "LEFT", "EXPIRED"}
        )

    def _id(self, value: object, label: str) -> str:
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value.strip()) > 100
            or any(part in value for part in ("/", "\\", "\x00"))
        ):
            raise InvalidOperation(f"The {label} identifier is invalid")
        return value.strip()

    @staticmethod
    def _room_code(value: object) -> str:
        if not isinstance(value, str) or len(value.strip()) != 8:
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        return value.strip().upper()

    def _room_path(self, room_id: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/rooms/{room_id}"

    def _room_code_path(self, room_code: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/roomCodes/{room_code}"

    def _participant_path(self, room_id: str, uid: str) -> str:
        return f"{self._room_path(room_id)}/participants/{uid}"

    def _material_path(self, material_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/materialUploads/"
            f"{material_id}"
        )

    def _source_path(self, material_id: str, file_type: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/material-uploads/"
            f"{material_id}/source.{file_type}"
        )

    def _extraction_path(self, material_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/material-uploads/"
            f"{material_id}/extraction.json"
        )
