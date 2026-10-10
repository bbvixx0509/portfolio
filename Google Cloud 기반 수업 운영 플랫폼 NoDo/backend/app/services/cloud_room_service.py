from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from secrets import choice
from typing import Any, Protocol, TypeVar
from uuid import uuid4

from app.core.config import Settings
from app.domain.cloud_room_roles import (
    CHECKLIST_PROGRESS,
    QUESTION_OPERATIONS,
    ROOM_ROLE_ASSISTANT,
    ROOM_ROLE_LEAD,
    assignment_for,
    default_assistant_room_permissions,
    full_room_permissions,
    has_room_operation,
    no_room_permissions,
    normalize_room_permissions,
    room_instructor_uids,
    room_instructors,
)
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    ResourceConflict,
    ResourceNotFound,
)
from app.domain.room_student_access import (
    ended_student_access_deadline,
    resolve_student_access_deadline,
    utc_datetime,
)
from app.domain.staff_membership import has_active_membership
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import ORGANIZATION_ROLES, SCHEMA_VERSION

ACTIVE = "ACTIVE"
ARCHIVED = "ARCHIVED"
READY = "READY"
LIVE = "LIVE"
ENDED = "ENDED"
MAX_FLOW_ITEMS = 200
MAX_MATERIAL_UNITS = 300
MAX_ROOM_CODE_ATTEMPTS = 16
DEFAULT_MAX_ACTIVE_PARTICIPANTS = 50
MAX_ACTIVE_PARTICIPANTS = 300
ROOM_REOPEN_WINDOW = timedelta(minutes=10)
ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TransactionResult = TypeVar("TransactionResult")


class CloudRoomTransaction(Protocol):
    @property
    def server_timestamp(self) -> object: ...

    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def create_document(self, path: str, document: Mapping[str, Any]) -> None: ...

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None: ...

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]: ...


class CloudRoomRepository(Protocol):
    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def list_rooms(self, *, org_id: str) -> list[Mapping[str, Any]]: ...

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]: ...

    def list_staff_members(self, *, org_id: str) -> list[Mapping[str, Any]]: ...

    def list_room_questions(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]: ...

    def list_room_participants(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]: ...

    def run_transaction(
        self, callback: Callable[[CloudRoomTransaction], TransactionResult]
    ) -> TransactionResult: ...


def generate_room_code() -> str:
    """Create an eight-character code without ambiguous characters."""

    return "".join(choice(ROOM_CODE_ALPHABET) for _ in range(8))


class CloudRoomService:
    def __init__(
        self,
        repository: CloudRoomRepository,
        settings: Settings,
        *,
        room_code_factory: Callable[[], str] = generate_room_code,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.repository = repository
        self.settings = settings
        self.room_code_factory = room_code_factory
        self.clock = clock or (lambda: datetime.now(UTC))

    def create_room(
        self, identity: VerifiedCloudIdentity, payload: Mapping[str, Any]
    ) -> dict[str, Any]:
        self._require_staff(identity)
        source_course_id = self._id(payload.get("sourceCourseId"), "course")
        title = self._text(payload.get("title"), 100)
        max_active_participants = self._max_active_participants(
            payload.get("maxActiveParticipants", DEFAULT_MAX_ACTIVE_PARTICIPANTS)
        )
        room_id = uuid4().hex

        def create(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            source = transaction.read_document(self._course_path(source_course_id))
            self._require_active_source_course(source, source_course_id)
            flow_items = self._snapshot_flow_items(source)
            material_snapshot = self._snapshot_material(transaction, source)
            room_code = self._available_room_code(transaction)
            timestamp = transaction.server_timestamp
            room_document: dict[str, Any] = {
                    "id": room_id,
                    "orgId": self.settings.bootstrap_org_id,
                    "schemaVersion": SCHEMA_VERSION,
                    "title": title,
                    "maxActiveParticipants": max_active_participants,
                    "status": READY,
                    "roomCode": room_code,
                    "sourceCourseId": source_course_id,
                    "sourceCourseRevision": source["revision"],
                    "sourceCourseTitle": source["title"],
                    "roomCreatorUid": identity.uid,
                    "leadInstructorUid": identity.uid,
                    "leadInstructorDisplayNameSnapshot": identity.display_name,
                    "instructorMemberUids": [identity.uid],
                    "roomInstructors": [
                        {
                            "uid": identity.uid,
                            "role": ROOM_ROLE_LEAD,
                            "permissions": full_room_permissions(),
                            "displayNameSnapshot": identity.display_name,
                        }
                    ],
                    "totalParticipantCount": 0,
                    "createdAt": timestamp,
                    "updatedAt": timestamp,
                "revision": 1,
            }
            if material_snapshot is not None:
                room_document["materialSnapshot"] = material_snapshot
            transaction.create_document(self._room_path(room_id), room_document)
            transaction.create_document(
                self._room_code_path(room_code),
                {"roomId": room_id, "status": READY, "createdAt": timestamp},
            )
            for item in flow_items:
                transaction.create_document(
                    self._flow_item_path(room_id, item["itemId"]),
                    {**item, "isCompleted": False},
                )
            self._audit(
                transaction,
                room_id=room_id,
                source_course_id=source_course_id,
                identity=identity,
                timestamp=timestamp,
            )
            # Retain the role read in the transaction so it cannot be optimized away.
            assert user.get("organizationRole") in ORGANIZATION_ROLES

        self.repository.run_transaction(create)
        return self.get_room(identity, room_id)

    def list_rooms(self, identity: VerifiedCloudIdentity) -> dict[str, Any]:
        self._require_staff(identity)
        rooms: list[dict[str, Any]] = []
        for room in self.repository.list_rooms(org_id=self.settings.bootstrap_org_id):
            if not self._is_readable_room(room, str(room.get("id", ""))):
                continue
            relationship = self._list_relationship(room, identity.uid)
            if relationship is None:
                continue
            rooms.append(self._list_summary(room, relationship, identity.uid))
        return {"rooms": rooms}

    def get_room(self, identity: VerifiedCloudIdentity, room_id: str) -> dict[str, Any]:
        user = self._require_staff(identity)
        room = self._readable_room(room_id)
        self._require_room_access(room, identity.uid, user)
        flow_items = self.repository.list_room_flow_items(
            org_id=self.settings.bootstrap_org_id, room_id=room_id
        )
        return self._checklist_response(room, flow_items, identity)

    def get_checklist(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, Any]:
        """Return a revisioned checklist without exposing Firestore to React."""

        return self.get_room(identity, room_id)

    def instructor_management(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, Any]:
        """Return the lead-only management view without emails or audit data."""

        user = self._require_staff(identity)
        room = self._readable_room(room_id)
        self._require_lead_instructor(room, identity.uid, user)
        assignments = self._room_instructors_or_conflict(room)
        assigned = {assignment["uid"] for assignment in assignments}
        candidates = [
            {
                "userId": candidate["uid"],
                "displayName": self._display_name(candidate),
                "organizationRole": candidate["organizationRole"],
            }
            for candidate in self.repository.list_staff_members(
                org_id=self.settings.bootstrap_org_id
            )
            if self._is_staff_document(candidate)
            and candidate["uid"] not in assigned
        ]
        return self._management_response(room, assignments, candidates)

    def add_assistant(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        target_uid: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        target_uid = self._id(target_uid, "assistant")
        self._require_staff(identity)

        def add(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_lead_instructor(room, identity.uid, user)
            self._require_expected_revision(room, expected_revision)
            target = transaction.read_document(f"users/{target_uid}")
            if not self._is_staff_document(target):
                raise AccessDenied(
                    "The selected assistant must be staff in this organization"
                )
            assignments = self._room_instructors_or_conflict(room)
            if any(assignment["uid"] == target_uid for assignment in assignments):
                raise ResourceConflict("The assistant is already assigned to this room")
            assignments.append(
                {
                    "uid": target_uid,
                    "role": ROOM_ROLE_ASSISTANT,
                    "permissions": default_assistant_room_permissions(),
                    "displayNameSnapshot": self._display_name(target),
                }
            )
            revision = self._store_instructors(transaction, room_id, room, assignments)
            self._audit_instructor_change(
                transaction,
                event_type="ROOM_ASSISTANT_ADDED",
                room_id=room_id,
                actor_uid=identity.uid,
                target_uid=target_uid,
                revision=revision,
                timestamp=transaction.server_timestamp,
                before_role=None,
                after_role=ROOM_ROLE_ASSISTANT,
                permission_keys=(QUESTION_OPERATIONS,),
            )

        self.repository.run_transaction(add)
        return self.instructor_management(identity, room_id)

    def update_assistant_permissions(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        target_uid: str,
        permissions: Mapping[str, Any],
        expected_revision: int,
    ) -> dict[str, Any]:
        target_uid = self._id(target_uid, "assistant")
        try:
            normalized_permissions = normalize_room_permissions(permissions)
        except ValueError as error:
            raise InvalidOperation(str(error)) from error
        self._require_staff(identity)

        def update(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_lead_instructor(room, identity.uid, user)
            self._require_expected_revision(room, expected_revision)
            assignments = self._room_instructors_or_conflict(room)
            target = self._assistant_assignment(assignments, target_uid)
            if target["permissions"] == normalized_permissions:
                raise ResourceConflict("The assistant permissions have not changed")
            target["permissions"] = normalized_permissions
            revision = self._store_instructors(transaction, room_id, room, assignments)
            self._audit_instructor_change(
                transaction,
                event_type="ROOM_ASSISTANT_PERMISSIONS_UPDATED",
                room_id=room_id,
                actor_uid=identity.uid,
                target_uid=target_uid,
                revision=revision,
                timestamp=transaction.server_timestamp,
                before_role=ROOM_ROLE_ASSISTANT,
                after_role=ROOM_ROLE_ASSISTANT,
                permission_keys=tuple(
                    key
                    for key, enabled in normalized_permissions.items()
                    if enabled
                ),
            )

        self.repository.run_transaction(update)
        return self.instructor_management(identity, room_id)

    def grant_assistant_full_access(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        target_uid: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        return self._set_assistant_full_access(
            identity, room_id, target_uid, expected_revision, granted=True
        )

    def revoke_assistant_full_access(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        target_uid: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        return self._set_assistant_full_access(
            identity, room_id, target_uid, expected_revision, granted=False
        )

    def _set_assistant_full_access(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        target_uid: str,
        expected_revision: int,
        *,
        granted: bool,
    ) -> dict[str, Any]:
        target_uid = self._id(target_uid, "assistant")
        self._require_staff(identity)
        next_permissions = (
            full_room_permissions()
            if granted
            else default_assistant_room_permissions()
        )

        def change(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_lead_instructor(room, identity.uid, user)
            self._require_expected_revision(room, expected_revision)
            assignments = self._room_instructors_or_conflict(room)
            target = self._assistant_assignment(assignments, target_uid)
            if target["permissions"] == next_permissions:
                raise ResourceConflict("The assistant permissions have not changed")
            target["permissions"] = next_permissions
            revision = self._store_instructors(transaction, room_id, room, assignments)
            self._audit_instructor_change(
                transaction,
                event_type=(
                    "ROOM_ASSISTANT_FULL_ACCESS_GRANTED"
                    if granted
                    else "ROOM_ASSISTANT_FULL_ACCESS_REVOKED"
                ),
                room_id=room_id,
                actor_uid=identity.uid,
                target_uid=target_uid,
                revision=revision,
                timestamp=transaction.server_timestamp,
                before_role=ROOM_ROLE_ASSISTANT,
                after_role=ROOM_ROLE_ASSISTANT,
                permission_keys=tuple(
                    key for key, enabled in next_permissions.items() if enabled
                ),
            )

        self.repository.run_transaction(change)
        return self.instructor_management(identity, room_id)

    def remove_assistant(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        target_uid: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        target_uid = self._id(target_uid, "assistant")
        self._require_staff(identity)

        def remove(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_lead_instructor(room, identity.uid, user)
            self._require_expected_revision(room, expected_revision)
            assignments = self._room_instructors_or_conflict(room)
            if (
                room.get("status") == LIVE
                and target_uid == room.get("leadInstructorUid")
            ):
                raise ResourceConflict(
                    "The lead instructor cannot leave while the room is live"
                )
            target = self._assistant_assignment(assignments, target_uid)
            assignments.remove(target)
            revision = self._store_instructors(transaction, room_id, room, assignments)
            self._audit_instructor_change(
                transaction,
                event_type="ROOM_ASSISTANT_REMOVED",
                room_id=room_id,
                actor_uid=identity.uid,
                target_uid=target_uid,
                revision=revision,
                timestamp=transaction.server_timestamp,
                before_role=ROOM_ROLE_ASSISTANT,
                after_role=None,
                permission_keys=tuple(
                    key for key, enabled in target["permissions"].items() if enabled
                ),
            )

        self.repository.run_transaction(remove)
        return self.instructor_management(identity, room_id)

    def transfer_lead(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        target_uid: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        target_uid = self._id(target_uid, "assistant")
        self._require_staff(identity)

        def transfer(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_lead_instructor(room, identity.uid, user)
            self._require_expected_revision(room, expected_revision)
            assignments = self._room_instructors_or_conflict(room)
            old_lead = self._lead_assignment(assignments)
            target = self._assistant_assignment(assignments, target_uid)
            old_lead["role"] = ROOM_ROLE_ASSISTANT
            old_lead["permissions"] = full_room_permissions()
            target["role"] = ROOM_ROLE_LEAD
            target["permissions"] = full_room_permissions()
            assignments[:] = [
                target,
                *[item for item in assignments if item is not target],
            ]
            revision = self._store_instructors(transaction, room_id, room, assignments)
            self._audit_instructor_change(
                transaction,
                event_type="ROOM_LEAD_TRANSFERRED",
                room_id=room_id,
                actor_uid=identity.uid,
                target_uid=target_uid,
                revision=revision,
                timestamp=transaction.server_timestamp,
                before_role=ROOM_ROLE_ASSISTANT,
                after_role=ROOM_ROLE_LEAD,
                permission_keys=tuple(full_room_permissions()),
            )

        self.repository.run_transaction(transfer)
        return self.get_room(identity, room_id)

    def start_room(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        self._require_staff(identity)

        def start(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_checklist_manager(room, identity.uid, user)
            self._require_expected_revision(room, expected_revision)
            if room.get("status") != READY:
                raise ResourceConflict("Only READY rooms can be started")
            timestamp = transaction.server_timestamp
            revision = int(room["revision"]) + 1
            transaction.update_document(
                self._room_path(room_id),
                {
                    "status": LIVE,
                    "startedAt": timestamp,
                    "revision": revision,
                    "updatedAt": timestamp,
                },
            )
            self._audit_progress(
                transaction,
                event_type="ROOM_STARTED",
                room_id=room_id,
                identity=identity,
                revision=revision,
                timestamp=timestamp,
            )

        self.repository.run_transaction(start)
        return self.get_checklist(identity, room_id)

    def end_room(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        expected_revision: int,
        *,
        student_access_window: str | None = None,
        student_access_until: datetime | None = None,
    ) -> dict[str, Any]:
        """End a live room once; the status and audit entry share one transaction."""

        self._require_staff(identity)
        ended_at = self._now()
        try:
            student_access_deadline = resolve_student_access_deadline(
                window=student_access_window,
                custom_until=student_access_until,
                ended_at=ended_at,
            )
        except ValueError as error:
            raise InvalidOperation("The student access deadline is invalid") from error

        def end(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_lead_instructor(room, identity.uid, user)
            if room.get("status") == ENDED:
                return
            self._require_expected_revision(room, expected_revision)
            self._require_live_room(room)
            timestamp = transaction.server_timestamp
            revision = int(room["revision"]) + 1
            current_policy = room.get("materialDownloadPolicy")
            current_policy_revision = (
                current_policy.get("downloadPolicyRevision")
                if isinstance(current_policy, Mapping)
                else None
            )
            policy_revision = (
                current_policy_revision + 1
                if isinstance(current_policy_revision, int)
                and not isinstance(current_policy_revision, bool)
                and current_policy_revision >= 1
                else 1
            )
            transaction.update_document(
                self._room_path(room_id),
                {
                    "status": ENDED,
                    "endedAt": timestamp,
                    "endedByUid": identity.uid,
                    "materialDownloadPolicy": {
                        "downloadEnabled": True,
                        "downloadAvailableFrom": ended_at.isoformat(),
                        "downloadAvailableUntil": student_access_deadline.isoformat(),
                        "downloadPolicyRevision": policy_revision,
                        "updatedAt": timestamp,
                    },
                    "revision": revision,
                    "updatedAt": timestamp,
                },
            )
            self._audit_progress(
                transaction,
                event_type="ROOM_ENDED",
                room_id=room_id,
                identity=identity,
                revision=revision,
                timestamp=timestamp,
            )

        self.repository.run_transaction(end)
        return self.get_checklist(identity, room_id)

    def reopen_room(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        """Undo a recent end without touching the room's learning data.

        The deterministic operation id makes a browser retry and a Firestore
        transaction retry converge on the same audit document.
        """

        self._require_staff(identity)
        operation_id = self._room_operation_id(
            event_type="ROOM_REOPENED",
            room_id=room_id,
            actor_uid=identity.uid,
            expected_revision=expected_revision,
        )

        def reopen(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_lead_instructor(room, identity.uid, user)
            if self._room_operation_exists(transaction, operation_id):
                return
            self._require_expected_revision(room, expected_revision)
            if room.get("status") != ENDED:
                raise ResourceConflict("Only ENDED rooms can be reopened")
            ended_at = utc_datetime(room.get("endedAt"))
            if ended_at is None:
                raise ResourceConflict("The room end time is unavailable")
            now = self._now()
            if now > ended_at + ROOM_REOPEN_WINDOW:
                raise ResourceConflict("The room can no longer be reopened")
            download_deadline = ended_student_access_deadline(room)
            if download_deadline is None or now > download_deadline:
                raise ResourceConflict("The material download period has ended")

            timestamp = transaction.server_timestamp
            revision = int(room["revision"]) + 1
            transaction.update_document(
                self._room_path(room_id),
                {
                    "status": LIVE,
                    # Keep the terminal event for audit/history compatibility;
                    # a later end will write its new terminal timestamp normally.
                    "lastEndedAt": room.get("endedAt"),
                    "lastEndedByUid": room.get("endedByUid"),
                    "reopenedAt": timestamp,
                    "reopenedByUid": identity.uid,
                    "revision": revision,
                    "updatedAt": timestamp,
                },
            )
            self._audit_progress(
                transaction,
                event_type="ROOM_REOPENED",
                room_id=room_id,
                identity=identity,
                revision=revision,
                timestamp=timestamp,
                operation_id=operation_id,
            )

        self.repository.run_transaction(reopen)
        return self.get_checklist(identity, room_id)

    def end_summary(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, Any]:
        user = self._require_staff(identity)
        room = self._readable_room(room_id)
        self._require_lead_instructor(room, identity.uid, user)
        if room.get("status") != ENDED:
            raise ResourceConflict("The room has not ended")
        flow_items = self.repository.list_room_flow_items(
            org_id=self.settings.bootstrap_org_id, room_id=room_id
        )
        questions = self.repository.list_room_questions(
            org_id=self.settings.bootstrap_org_id, room_id=room_id
        )
        participants = self.repository.list_room_participants(
            org_id=self.settings.bootstrap_org_id, room_id=room_id
        )
        completed = sum(item.get("isCompleted") is True for item in flow_items)
        answered = sum(bool(question.get("answer")) for question in questions)
        active_count = sum(
            participant.get("participantStatus") == "JOINED"
            and participant.get("presenceStatus") == "ACTIVE"
            for participant in participants
        )
        stored_total = room.get("totalParticipantCount")
        total_participants = (
            stored_total
            if isinstance(stored_total, int)
            and not isinstance(stored_total, bool)
            and stored_total >= 0
            # Legacy rooms use a read-only fallback rather than being migrated
            # during a summary request.
            else len(participants)
        )
        return {
            "roomId": room_id,
            "title": room.get("title"),
            "status": ENDED,
            "startedAt": room.get("startedAt"),
            "endedAt": room.get("endedAt"),
            "checklistCompletedCount": completed,
            "checklistTotalCount": len(flow_items),
            "completionRate": (
                round((completed / len(flow_items)) * 100) if flow_items else 0
            ),
            "totalQuestionCount": len(questions),
            "answeredQuestionCount": answered,
            "participantCount": total_participants,
            "activeParticipantCount": active_count,
            "downloadEnabled": bool(
                isinstance(room.get("materialDownloadPolicy"), Mapping)
                and room["materialDownloadPolicy"].get("downloadEnabled") is True
            ),
            "downloadAvailableUntil": (
                room["materialDownloadPolicy"].get("downloadAvailableUntil")
                if isinstance(room.get("materialDownloadPolicy"), Mapping)
                and isinstance(
                    room["materialDownloadPolicy"].get("downloadAvailableUntil"), str
                )
                else None
            ),
        }

    def complete_checklist_item(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        item_id: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        normalized_item_id = self._id(item_id, "item")
        self._require_staff(identity)
        operation_id = self._checklist_operation_id(
            event_type="CHECKLIST_ITEM_COMPLETED",
            room_id=room_id,
            item_id=normalized_item_id,
            actor_uid=identity.uid,
            expected_revision=expected_revision,
        )

        def complete(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_checklist_manager(room, identity.uid, user)
            if self._checklist_operation_exists(transaction, operation_id):
                return
            self._require_expected_revision(room, expected_revision)
            self._require_live_room(room)
            flow_items = self._transaction_flow_items(transaction, room_id)
            current = self._current_item(flow_items)
            if current is None:
                raise ResourceConflict("All checklist items are already complete")
            if current["itemId"] != normalized_item_id:
                raise ResourceConflict(
                    "Only the current checklist item can be completed"
                )
            timestamp = transaction.server_timestamp
            revision = int(room["revision"]) + 1
            transaction.update_document(
                self._flow_item_path(room_id, normalized_item_id),
                {"isCompleted": True},
            )
            transaction.update_document(
                self._room_path(room_id),
                {"revision": revision, "updatedAt": timestamp},
            )
            self._audit_progress(
                transaction,
                event_type="CHECKLIST_ITEM_COMPLETED",
                room_id=room_id,
                item_id=normalized_item_id,
                identity=identity,
                revision=revision,
                timestamp=timestamp,
                operation_id=operation_id,
            )

        self.repository.run_transaction(complete)
        return self.get_checklist(identity, room_id)

    def undo_checklist_item(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        item_id: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        normalized_item_id = self._id(item_id, "item")
        self._require_staff(identity)
        operation_id = self._checklist_operation_id(
            event_type="CHECKLIST_REWOUND",
            room_id=room_id,
            item_id=normalized_item_id,
            actor_uid=identity.uid,
            expected_revision=expected_revision,
        )

        def undo(transaction: CloudRoomTransaction) -> None:
            user = self._require_transaction_staff(transaction, identity)
            room = self._transaction_readable_room(transaction, room_id)
            self._require_checklist_manager(room, identity.uid, user)
            if self._checklist_operation_exists(transaction, operation_id):
                return
            self._require_expected_revision(room, expected_revision)
            self._require_live_room(room)
            flow_items = self._transaction_flow_items(transaction, room_id)
            target_index = next(
                (
                    index
                    for index, item in enumerate(flow_items)
                    if item["itemId"] == normalized_item_id
                ),
                None,
            )
            if target_index is None or not flow_items[target_index]["isCompleted"]:
                raise ResourceConflict("Only completed checklist items can be undone")
            timestamp = transaction.server_timestamp
            revision = int(room["revision"]) + 1
            for item in flow_items[target_index:]:
                if item["isCompleted"]:
                    transaction.update_document(
                        self._flow_item_path(room_id, str(item["itemId"])),
                        {"isCompleted": False},
                    )
            transaction.update_document(
                self._room_path(room_id),
                {"revision": revision, "updatedAt": timestamp},
            )
            self._audit_progress(
                transaction,
                event_type="CHECKLIST_REWOUND",
                room_id=room_id,
                item_id=normalized_item_id,
                identity=identity,
                revision=revision,
                timestamp=timestamp,
                operation_id=operation_id,
            )

        self.repository.run_transaction(undo)
        return self.get_checklist(identity, room_id)

    def get_share(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, str]:
        user = self._require_staff(identity)
        room = self._readable_room(room_id)
        self._require_room_access(room, identity.uid, user)
        room_code = room.get("roomCode")
        if not isinstance(room_code, str) or not self._is_room_code(room_code):
            raise ResourceNotFound("The room was not found")
        return {
            "roomId": room_id,
            "orgId": self.settings.bootstrap_org_id,
            "roomCode": room_code,
            "joinPath": f"/join/{self.settings.bootstrap_org_id}/{room_code}",
        }

    def _require_staff(self, identity: VerifiedCloudIdentity) -> Mapping[str, Any]:
        user = self.repository.read_document(f"users/{identity.uid}")
        if not self._is_staff(user, identity.uid):
            raise AccessDenied("Only organization staff can use rooms")
        assert user is not None
        return user

    def _require_transaction_staff(
        self, transaction: CloudRoomTransaction, identity: VerifiedCloudIdentity
    ) -> Mapping[str, Any]:
        user = transaction.read_document(f"users/{identity.uid}")
        if not self._is_staff(user, identity.uid):
            raise AccessDenied("Only organization staff can use rooms")
        assert user is not None
        return user

    def _is_staff(self, user: Mapping[str, Any] | None, uid: str) -> bool:
        return bool(
            user
            and user.get("uid") == uid
            and user.get("orgId") == self.settings.bootstrap_org_id
            and user.get("accountType") == "STAFF"
            and has_active_membership(user)
            and user.get("organizationRole") in ORGANIZATION_ROLES
            and isinstance(user.get("organizationRoleRevision"), int)
            and user["organizationRoleRevision"] >= 1
        )

    def _is_staff_document(self, user: Mapping[str, Any] | None) -> bool:
        return bool(
            user
            and isinstance(user.get("uid"), str)
            and self._is_staff(user, str(user["uid"]))
        )

    def _display_name(self, user: Mapping[str, Any]) -> str:
        value = user.get("displayName")
        return (
            value.strip()
            if isinstance(value, str) and value.strip()
            else "이름 미등록"
        )

    def _room_instructors_or_conflict(
        self, room: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        assignments = room_instructors(room)
        lead = next(
            (
                assignment
                for assignment in assignments
                if assignment["role"] == ROOM_ROLE_LEAD
            ),
            None,
        )
        if (
            not assignments
            or lead is None
            or lead["uid"] != room.get("leadInstructorUid")
            or room_instructor_uids(assignments)
            != list(room.get("instructorMemberUids", []))
        ):
            raise ResourceConflict("The room instructor assignments are invalid")
        return assignments

    def _lead_assignment(self, assignments: list[dict[str, Any]]) -> dict[str, Any]:
        lead = next(
            (
                assignment
                for assignment in assignments
                if assignment["role"] == ROOM_ROLE_LEAD
            ),
            None,
        )
        if lead is None:
            raise ResourceConflict("The room must have one lead instructor")
        return lead

    def _assistant_assignment(
        self, assignments: list[dict[str, Any]], target_uid: str
    ) -> dict[str, Any]:
        assignment = next(
            (
                assignment
                for assignment in assignments
                if assignment["uid"] == target_uid
            ),
            None,
        )
        if assignment is None or assignment["role"] != ROOM_ROLE_ASSISTANT:
            raise ResourceNotFound("The assistant is not assigned to this room")
        return assignment

    def _store_instructors(
        self,
        transaction: CloudRoomTransaction,
        room_id: str,
        room: Mapping[str, Any],
        assignments: list[dict[str, Any]],
    ) -> int:
        lead = self._lead_assignment(assignments)
        if sum(item["role"] == ROOM_ROLE_LEAD for item in assignments) != 1:
            raise ResourceConflict("The room must have exactly one lead instructor")
        revision = int(room["revision"]) + 1
        transaction.update_document(
            self._room_path(room_id),
            {
                "roomInstructors": assignments,
                "leadInstructorUid": lead["uid"],
                "leadInstructorDisplayNameSnapshot": lead["displayNameSnapshot"],
                "instructorMemberUids": room_instructor_uids(assignments),
                "revision": revision,
                "updatedAt": transaction.server_timestamp,
            },
        )
        return revision

    def _management_response(
        self,
        room: Mapping[str, Any],
        assignments: list[dict[str, Any]],
        candidates: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return {
            "roomId": room["id"],
            "revision": room["revision"],
            "instructors": [
                {
                    "userId": assignment["uid"],
                    "displayName": assignment["displayNameSnapshot"] or "이름 미등록",
                    "role": assignment["role"],
                    "permissions": assignment["permissions"],
                }
                for assignment in assignments
            ],
            "candidates": candidates,
        }

    def _audit_instructor_change(
        self,
        transaction: CloudRoomTransaction,
        *,
        event_type: str,
        room_id: str,
        actor_uid: str,
        target_uid: str,
        revision: int,
        timestamp: object,
        before_role: str | None,
        after_role: str | None,
        permission_keys: tuple[str, ...],
    ) -> None:
        document: dict[str, Any] = {
            "eventType": event_type,
            "orgId": self.settings.bootstrap_org_id,
            "roomId": room_id,
            "actorUid": actor_uid,
            "targetStaffUid": target_uid,
            "revision": revision,
            "schemaVersion": SCHEMA_VERSION,
            "createdAt": timestamp,
        }
        if before_role is not None:
            document["beforeRoomRole"] = before_role
        if after_role is not None:
            document["afterRoomRole"] = after_role
        if permission_keys:
            document["permissionKeys"] = list(permission_keys)
        transaction.create_document(
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/"
            f"{event_type.lower()}-{room_id}-{target_uid}-{revision}",
            document,
        )

    def _require_active_source_course(
        self, source: Mapping[str, Any] | None, source_course_id: str
    ) -> None:
        if not self._is_readable_source_course(source, source_course_id):
            raise ResourceNotFound("The source course was not found")
        assert source is not None
        if source.get("status") == ARCHIVED:
            raise ResourceConflict("Archived courses cannot create rooms")
        if source.get("status") != ACTIVE:
            raise ResourceNotFound("The source course was not found")

    def _is_readable_source_course(
        self, source: Mapping[str, Any] | None, source_course_id: str
    ) -> bool:
        return bool(
            source
            and source.get("id") == source_course_id
            and source.get("orgId") == self.settings.bootstrap_org_id
            and source.get("schemaVersion") == SCHEMA_VERSION
            and source.get("status") in {ACTIVE, ARCHIVED}
            and isinstance(source.get("revision"), int)
            and source["revision"] >= 1
            and isinstance(source.get("title"), str)
        )

    def _snapshot_flow_items(self, source: Mapping[str, Any]) -> list[dict[str, Any]]:
        chapters = source.get("chapters")
        if not isinstance(chapters, list):
            raise InvalidOperation("The source course flow is invalid")
        flow_items: list[dict[str, Any]] = []
        item_ids: set[str] = set()
        for chapter_position, chapter in enumerate(chapters):
            if not isinstance(chapter, Mapping):
                raise InvalidOperation("The source course flow is invalid")
            chapter_id = self._id(chapter.get("id"), "chapter")
            chapter_title = self._text(chapter.get("title"), 100)
            items = chapter.get("items")
            if not isinstance(items, list):
                raise InvalidOperation("The source course flow is invalid")
            for item_position, item in enumerate(items):
                if not isinstance(item, Mapping):
                    raise InvalidOperation("The source course flow is invalid")
                item_id = self._id(item.get("id"), "item")
                if item_id in item_ids:
                    raise InvalidOperation(
                        "The source course has duplicate item identifiers"
                    )
                item_ids.add(item_id)
                flow_items.append(
                    {
                        "chapterId": chapter_id,
                        "chapterTitle": chapter_title,
                        "chapterPosition": chapter_position,
                        "itemId": item_id,
                        "itemTitle": self._text(item.get("title"), 150),
                        "itemDescription": self._optional_text(
                            item.get("description", ""), 1000
                        ),
                        "sourcePageOrSlideNumbers": self._source_unit_numbers(
                            item.get("sourcePageOrSlideNumbers", [])
                        ),
                        "itemPosition": item_position,
                    }
                )
        if len(flow_items) > MAX_FLOW_ITEMS:
            raise InvalidOperation("The source course has too many flow items")
        return flow_items

    def _snapshot_material(
        self, transaction: CloudRoomTransaction, source: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        """Freeze safe display metadata; never copy a Storage path into a room."""

        material_id = source.get("sourceMaterialId")
        draft_id = source.get("sourceDraftId")
        file_type = source.get("sourceFileType")
        if material_id is None and draft_id is None and file_type is None:
            return None
        material_id = self._id(material_id, "material")
        draft_id = self._id(draft_id, "draft")
        if file_type not in {"pdf", "pptx"}:
            raise InvalidOperation("The source course material is invalid")
        material = transaction.read_document(self._material_path(material_id))
        if not isinstance(material, Mapping) or not self._is_extractable_material(
            material, material_id, file_type
        ):
            raise InvalidOperation("The source course material is unavailable")
        total_units = material.get("pageCount" if file_type == "pdf" else "slideCount")
        if (
            isinstance(total_units, bool)
            or not isinstance(total_units, int)
            or not 1 <= total_units <= MAX_MATERIAL_UNITS
        ):
            raise InvalidOperation("The source course material is invalid")
        title = material.get("originalFilename")
        if not isinstance(title, str) or not title.strip() or len(title.strip()) > 255:
            title = "수업 자료"
        generation = material.get("sourceObjectGeneration")
        extraction_version = material.get("extractionVersion")
        if not generation or isinstance(extraction_version, bool) or not isinstance(
            extraction_version, int
        ):
            raise InvalidOperation("The source course material is invalid")
        return {
            "sourceMaterialId": material_id,
            "sourceDraftId": draft_id,
            "displayTitle": title.strip(),
            "fileType": file_type,
            "totalUnits": total_units,
            "sourceMaterialRevision": f"{generation}:{extraction_version}",
            "currentUnitNumber": 1,
            "materialRevision": 1,
        }

    def _is_extractable_material(
        self, material: Mapping[str, Any], material_id: str, file_type: str
    ) -> bool:
        return bool(
            material.get("id") == material_id
            and material.get("orgId") == self.settings.bootstrap_org_id
            and material.get("normalizedExtension") == file_type
            and material.get("status") == "EXTRACTED"
            and material.get("extractionStatus") == "EXTRACTED"
            and material.get("sourceObjectGeneration")
        )

    @staticmethod
    def _source_unit_numbers(value: object) -> list[int]:
        if value is None:
            return []
        if not isinstance(value, list) or len(value) > 20:
            raise InvalidOperation("The source course material references are invalid")
        numbers = sorted(set(value))
        if any(
            isinstance(number, bool) or not isinstance(number, int) or number < 1
            for number in numbers
        ):
            raise InvalidOperation("The source course material references are invalid")
        return numbers

    def _available_room_code(self, transaction: CloudRoomTransaction) -> str:
        for _ in range(MAX_ROOM_CODE_ATTEMPTS):
            room_code = self.room_code_factory()
            if (
                self._is_room_code(room_code)
                and transaction.read_document(self._room_code_path(room_code)) is None
            ):
                return room_code
        raise ResourceConflict("A unique room code could not be created")

    def _is_readable_room(self, room: Mapping[str, Any] | None, room_id: str) -> bool:
        return bool(
            room
            and room.get("id") == room_id
            and room.get("orgId") == self.settings.bootstrap_org_id
            and room.get("schemaVersion") == SCHEMA_VERSION
            and room.get("status") in {READY, LIVE, ENDED}
            and isinstance(room.get("roomCode"), str)
            and self._is_room_code(room["roomCode"])
            and isinstance(room.get("instructorMemberUids"), list)
            and isinstance(room.get("leadInstructorUid"), str)
            and isinstance(room.get("revision"), int)
            and room["revision"] >= 1
        )

    def _readable_room(self, room_id: str) -> Mapping[str, Any]:
        room = self.repository.read_document(self._room_path(room_id))
        if not self._is_readable_room(room, room_id):
            raise ResourceNotFound("The room was not found")
        assert room is not None
        return room

    def _transaction_readable_room(
        self, transaction: CloudRoomTransaction, room_id: str
    ) -> Mapping[str, Any]:
        room = transaction.read_document(self._room_path(room_id))
        if not self._is_readable_room(room, room_id):
            raise ResourceNotFound("The room was not found")
        assert room is not None
        return room

    def _can_read_room(
        self, room: Mapping[str, Any], uid: str, _user: Mapping[str, Any]
    ) -> bool:
        return assignment_for(room, uid) is not None

    def _list_relationship(
        self, room: Mapping[str, Any], uid: str
    ) -> str | None:
        if room.get("roomCreatorUid") == uid:
            return "CREATED"
        if assignment_for(room, uid) is not None:
            return "ASSIGNED"
        return None

    def _require_room_access(
        self, room: Mapping[str, Any], uid: str, user: Mapping[str, Any]
    ) -> None:
        if not self._can_read_room(room, uid, user):
            raise AccessDenied("Only room instructors can access this room")

    def _require_lead_instructor(
        self, room: Mapping[str, Any], uid: str, user: Mapping[str, Any]
    ) -> None:
        assignment = assignment_for(room, uid)
        if assignment is None or assignment["role"] != ROOM_ROLE_LEAD:
            raise AccessDenied("Only the lead instructor can manage room instructors")
        self._require_room_access(room, uid, user)

    def _require_checklist_manager(
        self, room: Mapping[str, Any], uid: str, user: Mapping[str, Any]
    ) -> None:
        self._require_room_access(room, uid, user)
        if not has_room_operation(room, uid, CHECKLIST_PROGRESS):
            raise AccessDenied("This instructor cannot change checklist progress")

    def _require_expected_revision(
        self, room: Mapping[str, Any], expected_revision: int
    ) -> None:
        if room.get("revision") != expected_revision:
            raise ResourceConflict("The room has changed. Refresh and try again")

    def _now(self) -> datetime:
        value = self.clock()
        return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)

    def _require_live_room(self, room: Mapping[str, Any]) -> None:
        if room.get("status") != LIVE:
            raise ResourceConflict("Checklist changes are allowed only while LIVE")

    def _transaction_flow_items(
        self, transaction: CloudRoomTransaction, room_id: str
    ) -> list[dict[str, Any]]:
        return self._public_flow_items(
            transaction.list_room_flow_items(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
        )

    def _current_item(
        self, flow_items: list[Mapping[str, Any]]
    ) -> Mapping[str, Any] | None:
        return next(
            (item for item in flow_items if item.get("isCompleted") is not True),
            None,
        )

    def _summary(self, room: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "id": room.get("id"),
            "title": room.get("title"),
            "maxActiveParticipants": self._max_active_participants(
                room.get("maxActiveParticipants", DEFAULT_MAX_ACTIVE_PARTICIPANTS)
            ),
            "status": room.get("status"),
            "roomCode": room.get("roomCode"),
            "sourceCourseId": room.get("sourceCourseId"),
            "sourceCourseRevision": room.get("sourceCourseRevision"),
            "sourceCourseTitle": room.get("sourceCourseTitle"),
            "leadInstructorDisplayNameSnapshot": room.get(
                "leadInstructorDisplayNameSnapshot"
            ),
            "createdAt": room.get("createdAt"),
            "updatedAt": room.get("updatedAt"),
            "revision": room.get("revision"),
        }

    def _list_summary(
        self, room: Mapping[str, Any], relationship: str, uid: str
    ) -> dict[str, Any]:
        """Return the room-list contract without room secrets or staff identity data."""

        assignment = assignment_for(room, uid)
        role = (
            "LEAD_INSTRUCTOR"
            if assignment is not None and assignment["role"] == ROOM_ROLE_LEAD
            else "ASSISTANT"
            if assignment is not None
            else None
        )
        download_deadline = ended_student_access_deadline(room)

        return {
            "id": room.get("id"),
            "title": room.get("title"),
            "status": room.get("status"),
            "sourceCourseId": room.get("sourceCourseId"),
            "sourceCourseTitle": room.get("sourceCourseTitle"),
            "createdAt": room.get("createdAt"),
            "updatedAt": room.get("updatedAt"),
            "startedAt": room.get("startedAt"),
            "endedAt": room.get("endedAt"),
            "downloadAvailableUntil": (
                download_deadline.isoformat() if download_deadline is not None else None
            ),
            "revision": room.get("revision"),
            "relationship": relationship,
            "currentRole": role,
            "canReopen": self._can_reopen_room(room, uid),
        }

    def _checklist_response(
        self,
        room: Mapping[str, Any],
        flow_items: list[Mapping[str, Any]],
        identity: VerifiedCloudIdentity,
    ) -> dict[str, Any]:
        items = self._public_flow_items(flow_items)
        current = self._current_item(items)
        assignment = assignment_for(room, identity.uid)
        role = (
            "LEAD_INSTRUCTOR"
            if assignment is not None and assignment["role"] == ROOM_ROLE_LEAD
            else "ASSISTANT"
            if assignment is not None
            else "ADMIN"
        )
        permissions = (
            full_room_permissions()
            if assignment is not None and assignment["role"] == ROOM_ROLE_LEAD
            else assignment["permissions"]
            if assignment is not None
            else no_room_permissions()
        )
        return {
            **self._summary(room),
            "currentRole": role,
            "roomPermissions": permissions,
            "canReopen": self._can_reopen_room(room, identity.uid),
            "flowItems": items,
            "currentItemId": current["itemId"] if current is not None else None,
            "isComplete": current is None,
        }

    def _public_flow_items(
        self, flow_items: list[Mapping[str, Any]]
    ) -> list[dict[str, Any]]:
        public_items: list[dict[str, Any]] = []
        item_ids: set[str] = set()
        for item in flow_items:
            chapter_position = item.get("chapterPosition")
            item_position = item.get("itemPosition")
            is_completed = item.get("isCompleted")
            if (
                isinstance(chapter_position, bool)
                or not isinstance(chapter_position, int)
                or chapter_position < 0
                or isinstance(item_position, bool)
                or not isinstance(item_position, int)
                or item_position < 0
                or not isinstance(is_completed, bool)
            ):
                raise InvalidOperation("The room checklist is invalid")
            item_id = self._id(item.get("itemId"), "item")
            if item_id in item_ids:
                raise InvalidOperation(
                    "The room checklist has duplicate item identifiers"
                )
            item_ids.add(item_id)
            public_items.append(
                {
                    "chapterId": self._id(item.get("chapterId"), "chapter"),
                    "chapterTitle": self._text(item.get("chapterTitle"), 100),
                    "chapterPosition": chapter_position,
                    "itemId": item_id,
                    "itemTitle": self._text(item.get("itemTitle"), 150),
                    "itemDescription": self._optional_text(
                        item.get("itemDescription", ""), 1000
                    ),
                    "sourcePageOrSlideNumbers": self._source_unit_numbers(
                        item.get("sourcePageOrSlideNumbers", [])
                    ),
                    "itemPosition": item_position,
                    "isCompleted": is_completed,
                }
            )
        return sorted(
            public_items,
            key=lambda item: (item["chapterPosition"], item["itemPosition"]),
        )

    def _audit_progress(
        self,
        transaction: CloudRoomTransaction,
        *,
        event_type: str,
        room_id: str,
        identity: VerifiedCloudIdentity,
        revision: int,
        timestamp: object,
        item_id: str | None = None,
        operation_id: str | None = None,
    ) -> None:
        suffix = item_id if item_id is not None else "room"
        document: dict[str, Any] = {
            "eventType": event_type,
            "orgId": self.settings.bootstrap_org_id,
            "actorUid": identity.uid,
            "roomId": room_id,
            "revision": revision,
            "schemaVersion": SCHEMA_VERSION,
            "createdAt": timestamp,
        }
        if item_id is not None:
            document["itemId"] = item_id
        if operation_id is not None:
            document["operationId"] = operation_id
        audit_log_id = operation_id or (
            f"{event_type.lower()}-{room_id}-{suffix}-{revision}"
        )
        transaction.create_document(
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/"
            f"{audit_log_id}",
            document,
        )

    def _checklist_operation_id(
        self,
        *,
        event_type: str,
        room_id: str,
        item_id: str,
        actor_uid: str,
        expected_revision: int,
    ) -> str:
        """Make a checklist mutation idempotent across client and transaction retries.

        The value is fixed before the transaction callback can be re-run.
        """

        value = ":".join(
            (
                self.settings.bootstrap_org_id,
                event_type,
                room_id,
                item_id,
                actor_uid,
                str(expected_revision),
            )
        )
        return f"checklist-operation-{sha256(value.encode()).hexdigest()}"

    def _room_operation_id(
        self,
        *,
        event_type: str,
        room_id: str,
        actor_uid: str,
        expected_revision: int,
    ) -> str:
        value = ":".join(
            (
                self.settings.bootstrap_org_id,
                event_type,
                room_id,
                actor_uid,
                str(expected_revision),
            )
        )
        return f"room-operation-{sha256(value.encode()).hexdigest()}"

    def _checklist_operation_exists(
        self, transaction: CloudRoomTransaction, operation_id: str
    ) -> bool:
        """Read the audit document before writes so a committed retry is a no-op."""

        return (
            transaction.read_document(
                f"organizations/{self.settings.bootstrap_org_id}/auditLogs/{operation_id}"
            )
            is not None
        )

    def _room_operation_exists(
        self, transaction: CloudRoomTransaction, operation_id: str
    ) -> bool:
        return self._checklist_operation_exists(transaction, operation_id)

    def _can_reopen_room(self, room: Mapping[str, Any], uid: str) -> bool:
        assignment = assignment_for(room, uid)
        if (
            room.get("status") != ENDED
            or assignment is None
            or assignment["role"] != ROOM_ROLE_LEAD
        ):
            return False
        ended_at = utc_datetime(room.get("endedAt"))
        if ended_at is None:
            return False
        now = self._now()
        download_deadline = ended_student_access_deadline(room)
        return (
            now <= ended_at + ROOM_REOPEN_WINDOW
            and download_deadline is not None
            and now <= download_deadline
        )

    def _audit(
        self,
        transaction: CloudRoomTransaction,
        *,
        room_id: str,
        source_course_id: str,
        identity: VerifiedCloudIdentity,
        timestamp: object,
    ) -> None:
        transaction.create_document(
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/"
            f"room-created-{room_id}-1",
            {
                "eventType": "ROOM_CREATED",
                "orgId": self.settings.bootstrap_org_id,
                "actorUid": identity.uid,
                "roomId": room_id,
                "sourceCourseId": source_course_id,
                "revision": 1,
                "schemaVersion": SCHEMA_VERSION,
                "createdAt": timestamp,
            },
        )

    def _course_path(self, course_id: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/courses/{course_id}"

    def _material_path(self, material_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/materialUploads/"
            f"{material_id}"
        )

    def _room_path(self, room_id: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/rooms/{room_id}"

    def _flow_item_path(self, room_id: str, item_id: str) -> str:
        return f"{self._room_path(room_id)}/flowItems/{item_id}"

    def _room_code_path(self, room_code: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/roomCodes/{room_code}"

    def _id(self, value: object, label: str) -> str:
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value.strip()) > 100
            or "/" in value
        ):
            raise InvalidOperation(f"The {label} identifier is invalid")
        return value.strip()

    def _text(self, value: object, limit: int) -> str:
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value.strip()) > limit
        ):
            raise InvalidOperation("The text is invalid")
        return value.strip()

    def _optional_text(self, value: object, limit: int) -> str:
        if not isinstance(value, str) or len(value.strip()) > limit:
            raise InvalidOperation("The text is invalid")
        return value.strip()

    def _is_room_code(self, value: str) -> bool:
        return len(value) == 8 and all(
            character in ROOM_CODE_ALPHABET for character in value
        )

    def _max_active_participants(self, value: object) -> int:
        """Treat older room documents without a value as the safe default."""

        if isinstance(value, bool) or not isinstance(value, int):
            raise InvalidOperation("The active participant limit is invalid")
        if not 1 <= value <= MAX_ACTIVE_PARTICIPANTS:
            raise InvalidOperation("The active participant limit is invalid")
        return value
