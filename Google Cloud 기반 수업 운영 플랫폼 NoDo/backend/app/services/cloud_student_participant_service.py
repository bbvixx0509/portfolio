from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol, TypeVar
from uuid import uuid4

from app.core.config import Settings
from app.domain.cloud_room_roles import CAPACITY_OPERATIONS, has_room_operation
from app.domain.errors import AccessDenied, InvalidOperation, ResourceConflict
from app.domain.staff_membership import has_active_membership
from app.domain.student_participant import (
    normalize_participant_nickname,
    normalize_participant_nickname_key,
    normalize_public_room_code,
)
from app.domain.room_student_access import ended_student_access_open
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import ORGANIZATION_ROLES
from app.services.student_auth_service import VerifiedStudentIdentity

READY = "READY"
LIVE = "LIVE"
ENDED = "ENDED"
JOINED = "JOINED"
PRESENCE_ACTIVE = "ACTIVE"
PRESENCE_LEFT = "LEFT"
PRESENCE_EXPIRED = "EXPIRED"
PRESENCE_READ_ONLY = "READ_ONLY"
CAPACITY_ALERT_PENDING = "PENDING"
CAPACITY_ALERT_RESOLVED = "RESOLVED"
DEFAULT_MAX_ACTIVE_PARTICIPANTS = 50
MAX_ACTIVE_PARTICIPANTS = 300
PRESENCE_LEASE_SECONDS = 90
CAPACITY_ALERT_COOLDOWN_SECONDS = 60
PUBLIC_ROOM_UNAVAILABLE = "현재 이 강의방에 참여할 수 없습니다."
CAPACITY_FULL_MESSAGE = "현재 참여 인원이 가득 찼습니다."
TransactionResult = TypeVar("TransactionResult")


class CloudStudentParticipantTransaction(Protocol):
    @property
    def server_timestamp(self) -> object: ...

    @property
    def server_now(self) -> datetime: ...

    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def create_document(self, path: str, document: Mapping[str, Any]) -> None: ...

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None: ...

    def find_participants_by_nickname(
        self, *, room_path: str, nickname_normalized: str
    ) -> list[Mapping[str, Any]]: ...

    def list_room_participants(self, *, room_path: str) -> list[Mapping[str, Any]]: ...


class CloudStudentParticipantRepository(Protocol):
    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def run_transaction(
        self,
        callback: Callable[[CloudStudentParticipantTransaction], TransactionResult],
    ) -> TransactionResult: ...


class CloudStudentParticipantService:
    """Server-only anonymous presence and capacity management for public rooms.

    The capacity document is intentionally private. Student endpoints only return a
    session or an availability error, never counts or participant identities.
    """

    def __init__(
        self, repository: CloudStudentParticipantRepository, settings: Settings
    ) -> None:
        self.repository = repository
        self.settings = settings

    def public_room(self, org_id: str, room_code: str) -> dict[str, Any]:
        room = self._room_for_public_access(org_id, room_code)
        return {"title": room["title"], "status": room["status"], "joinAllowed": True}

    def join(
        self,
        identity: VerifiedStudentIdentity,
        org_id: str,
        room_code: str,
        nickname: str,
    ) -> dict[str, Any]:
        normalized_nickname = normalize_participant_nickname(nickname)
        nickname_key = normalize_participant_nickname_key(normalized_nickname)
        normalized_room_code = self._validated_route(org_id, room_code)
        operation_id = uuid4().hex

        def register(
            transaction: CloudStudentParticipantTransaction,
        ) -> tuple[dict[str, Any] | None, bool]:
            room = self._transaction_room(transaction, normalized_room_code)
            room_id = str(room["id"])
            room_path = self._room_path(room_id)
            participant_path = self._participant_path(room_id, identity.uid)
            participant = transaction.read_document(participant_path)
            duplicates = transaction.find_participants_by_nickname(
                room_path=room_path, nickname_normalized=nickname_key
            )
            if any(
                candidate.get("nicknameNormalized") == nickname_key
                and candidate.get("_documentId") != identity.uid
                for candidate in duplicates
            ):
                raise ResourceConflict("이미 사용 중인 별명입니다.")

            is_read_only = room.get("status") == ENDED
            now = transaction.server_now
            capacity, capacity_exists, _ = self._capacity_after_expiring(
                transaction, room_id, now, operation_id
            )
            is_active = self._is_currently_active(participant, now)
            if not is_active and not is_read_only and self._is_full(capacity, room):
                alert_created = self._mark_capacity_alert(capacity, room, now)
                self._write_capacity(transaction, room_id, capacity, capacity_exists)
                if alert_created:
                    self._write_audit(
                        transaction,
                        room_id,
                        "CAPACITY_ALERT_RAISED",
                        operation_id,
                        now,
                        {
                            "activeParticipantCount": int(
                                capacity["activeParticipantCount"]
                            ),
                            "maxActiveParticipants": self._room_maximum(room),
                            "alertStatus": CAPACITY_ALERT_PENDING,
                        },
                    )
                return None, True

            if participant is None:
                stored_total = room.get("totalParticipantCount")
                total_before_join = (
                    stored_total
                    if isinstance(stored_total, int)
                    and not isinstance(stored_total, bool)
                    and stored_total >= 0
                    else len(transaction.list_room_participants(room_path=room_path))
                )
                transaction.create_document(
                    participant_path,
                    self._new_participant(normalized_nickname, nickname_key, now, is_read_only),
                )
                if not is_read_only:
                    transaction.update_document(
                        room_path, {"totalParticipantCount": total_before_join + 1}
                    )
                self._write_audit(
                    transaction,
                    room_id,
                    "PARTICIPANT_JOINED",
                    operation_id,
                    now,
                    {"fromPresenceStatus": None, "toPresenceStatus": PRESENCE_READ_ONLY if is_read_only else PRESENCE_ACTIVE},
                )
            else:
                if not self._is_valid_participant(participant):
                    raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE)
                previous_presence_status = participant.get("presenceStatus")
                if (
                    previous_presence_status == PRESENCE_ACTIVE
                    and not is_active
                ):
                    # Reconciliation above persisted ACTIVE -> EXPIRED.  Keep the
                    # rejoin audit truthful even though this transaction still has
                    # the original participant snapshot in hand.
                    previous_presence_status = PRESENCE_EXPIRED
                changes = self._presence_changes(
                    normalized_nickname, nickname_key, participant, now, is_read_only
                )
                transaction.update_document(participant_path, changes)
                if not is_active:
                    self._write_audit(
                        transaction,
                        room_id,
                        "PARTICIPANT_REJOINED",
                        operation_id,
                        now,
                        {
                            "fromPresenceStatus": previous_presence_status,
                            "toPresenceStatus": PRESENCE_READ_ONLY if is_read_only else PRESENCE_ACTIVE,
                        },
                    )

            if not is_active and not is_read_only:
                self._increment_active(capacity)
            self._write_capacity(transaction, room_id, capacity, capacity_exists)
            return self._session(room, normalized_nickname), False

        result, is_full = self.repository.run_transaction(register)
        if is_full:
            raise ResourceConflict(CAPACITY_FULL_MESSAGE)
        assert result is not None
        return result

    def session(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> dict[str, Any]:
        room = self._room_for_public_access(org_id, room_code)
        participant = self.repository.read_document(
            self._participant_path(str(room["id"]), identity.uid)
        )
        if not self._can_open_existing_session(participant, room):
            raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE)
        assert participant is not None
        return self._session(room, str(participant["nickname"]))

    def heartbeat(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> dict[str, str]:
        normalized_room_code = self._validated_route(org_id, room_code)
        operation_id = uuid4().hex

        def refresh(
            transaction: CloudStudentParticipantTransaction,
        ) -> tuple[dict[str, str] | None, bool]:
            room = self._transaction_room(transaction, normalized_room_code)
            room_id = str(room["id"])
            participant_path = self._participant_path(room_id, identity.uid)
            participant = transaction.read_document(participant_path)
            if not self._is_valid_participant(participant):
                raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE)
            is_read_only = room.get("status") == ENDED
            now = transaction.server_now
            (
                capacity,
                capacity_exists,
                expired_participants,
            ) = self._capacity_after_expiring(transaction, room_id, now, operation_id)
            capacity_write_required = expired_participants
            if not is_read_only and not self._is_currently_active(participant, now):
                if self._is_full(capacity, room):
                    alert_created = self._mark_capacity_alert(capacity, room, now)
                    self._write_capacity(
                        transaction, room_id, capacity, capacity_exists
                    )
                    if alert_created:
                        self._write_audit(
                            transaction,
                            room_id,
                            "CAPACITY_ALERT_RAISED",
                            operation_id,
                            now,
                            {
                                "activeParticipantCount": int(
                                    capacity["activeParticipantCount"]
                                ),
                                "maxActiveParticipants": self._room_maximum(room),
                                "alertStatus": CAPACITY_ALERT_PENDING,
                            },
                        )
                    return None, True
                self._increment_active(capacity)
                capacity_write_required = True
            transaction.update_document(
                participant_path,
                self._presence_changes(
                    str(participant["nickname"]),
                    str(participant["nicknameNormalized"]),
                    participant,
                    now,
                    is_read_only,
                ),
            )
            if capacity_write_required:
                self._write_capacity(transaction, room_id, capacity, capacity_exists)
            return {"presenceStatus": PRESENCE_READ_ONLY if is_read_only else PRESENCE_ACTIVE}, False

        result, is_full = self.repository.run_transaction(refresh)
        if is_full:
            raise ResourceConflict(CAPACITY_FULL_MESSAGE)
        assert result is not None
        return result

    def leave(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> dict[str, bool]:
        normalized_room_code = self._validated_route(org_id, room_code)
        operation_id = uuid4().hex

        def deactivate(
            transaction: CloudStudentParticipantTransaction,
        ) -> dict[str, bool]:
            room = self._transaction_room(transaction, normalized_room_code)
            room_id = str(room["id"])
            participant_path = self._participant_path(room_id, identity.uid)
            participant = transaction.read_document(participant_path)
            if not self._is_valid_participant(participant):
                raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE)
            now = transaction.server_now
            capacity, capacity_exists, _ = self._capacity_after_expiring(
                transaction, room_id, now, operation_id
            )
            if not self._is_currently_active(participant, now):
                self._write_capacity(transaction, room_id, capacity, capacity_exists)
                return {"left": False}
            transaction.update_document(
                participant_path,
                {"presenceStatus": PRESENCE_LEFT, "leftAt": now},
            )
            self._decrement_active(capacity)
            self._write_capacity(transaction, room_id, capacity, capacity_exists)
            self._write_audit(
                transaction,
                room_id,
                "PARTICIPANT_LEFT",
                operation_id,
                now,
                {
                    "fromPresenceStatus": PRESENCE_ACTIVE,
                    "toPresenceStatus": PRESENCE_LEFT,
                },
            )
            return {"left": True}

        return self.repository.run_transaction(deactivate)

    def staff_capacity(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, Any]:
        user = self._require_staff(identity)

        def read_capacity(
            transaction: CloudStudentParticipantTransaction,
        ) -> dict[str, Any]:
            room = self._transaction_room_by_id(transaction, room_id)
            self._require_room_reader(room, identity.uid, user)
            capacity = self._capacity_snapshot(
                transaction, room_id, transaction.server_now
            )
            return self._staff_capacity_response(room, capacity, identity.uid)

        return self.repository.run_transaction(read_capacity)

    def keep_capacity(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, Any]:
        return self._decide_capacity(identity, room_id, requested_maximum=None)

    def increase_capacity(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        max_active_participants: int,
    ) -> dict[str, Any]:
        return self._decide_capacity(
            identity,
            room_id,
            requested_maximum=self._maximum(max_active_participants),
        )

    def _decide_capacity(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        *,
        requested_maximum: int | None,
    ) -> dict[str, Any]:
        user = self._require_staff(identity)
        operation_id = uuid4().hex

        def decide(transaction: CloudStudentParticipantTransaction) -> dict[str, Any]:
            room = self._transaction_room_by_id(transaction, room_id)
            self._require_capacity_manager(room, identity.uid, user)
            now = transaction.server_now
            capacity, capacity_exists, _ = self._capacity_after_expiring(
                transaction, room_id, now, operation_id
            )
            current_maximum = self._room_maximum(room)
            if requested_maximum is not None:
                if current_maximum >= MAX_ACTIVE_PARTICIPANTS:
                    raise ResourceConflict("정원을 더 늘릴 수 없습니다.")
                if requested_maximum <= current_maximum:
                    raise ResourceConflict("정원은 현재 값보다 크게 설정해야 합니다.")
                transaction.update_document(
                    self._room_path(room_id),
                    {"maxActiveParticipants": requested_maximum, "updatedAt": now},
                )
                room = {**room, "maxActiveParticipants": requested_maximum}
                self._write_audit(
                    transaction,
                    room_id,
                    "CAPACITY_INCREASED",
                    operation_id,
                    now,
                    {
                        "actorUid": identity.uid,
                        "previousMaxActiveParticipants": current_maximum,
                        "nextMaxActiveParticipants": requested_maximum,
                    },
                )
            elif capacity.get("capacityAlertStatus") == CAPACITY_ALERT_PENDING:
                self._write_audit(
                    transaction,
                    room_id,
                    "CAPACITY_KEPT",
                    operation_id,
                    now,
                    {
                        "actorUid": identity.uid,
                        "maxActiveParticipants": current_maximum,
                        "alertStatus": CAPACITY_ALERT_RESOLVED,
                        "cooldownSeconds": CAPACITY_ALERT_COOLDOWN_SECONDS,
                    },
                )
            self._resolve_capacity_alert(capacity, now)
            self._write_capacity(transaction, room_id, capacity, capacity_exists)
            return self._staff_capacity_response(room, capacity, identity.uid)

        return self.repository.run_transaction(decide)

    def _room_for_public_access(self, org_id: str, room_code: str) -> Mapping[str, Any]:
        normalized_room_code = self._validated_route(org_id, room_code)
        code_index = self.repository.read_document(
            self._room_code_path(normalized_room_code)
        )
        room_id = code_index.get("roomId") if isinstance(code_index, Mapping) else None
        if not isinstance(room_id, str):
            raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE)
        room = self.repository.read_document(self._room_path(room_id))
        return self._require_public_room(room, room_id, normalized_room_code)

    def _transaction_room(
        self, transaction: CloudStudentParticipantTransaction, room_code: str
    ) -> Mapping[str, Any]:
        code_index = transaction.read_document(self._room_code_path(room_code))
        room_id = code_index.get("roomId") if isinstance(code_index, Mapping) else None
        if not isinstance(room_id, str):
            raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE)
        room = transaction.read_document(self._room_path(room_id))
        return self._require_public_room(room, room_id, room_code, transaction.server_now)

    def _transaction_room_by_id(
        self, transaction: CloudStudentParticipantTransaction, room_id: str
    ) -> Mapping[str, Any]:
        room = transaction.read_document(self._room_path(room_id))
        if not self._is_staff_room(room, room_id):
            raise AccessDenied("The room was not found")
        assert room is not None
        return room

    def _validated_route(self, org_id: str, room_code: str) -> str:
        if org_id != self.settings.bootstrap_org_id:
            raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE)
        try:
            return normalize_public_room_code(room_code)
        except ValueError as error:
            raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE) from error

    def _require_public_room(
        self,
        room: Mapping[str, Any] | None,
        room_id: str,
        room_code: str,
        now: datetime | None = None,
    ) -> Mapping[str, Any]:
        if not (
            room
            and room.get("id") == room_id
            and room.get("orgId") == self.settings.bootstrap_org_id
            and room.get("roomCode") == room_code
            and isinstance(room.get("title"), str)
            and room["title"].strip()
        ):
            raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE)
        status = room.get("status")
        if status not in {READY, LIVE, ENDED}:
            raise AccessDenied(PUBLIC_ROOM_UNAVAILABLE)

        if status == ENDED:
            check_time = now if now is not None else datetime.now(UTC)
            if not ended_student_access_open(room, check_time):
                raise AccessDenied("자료 열람 기간이 종료되었습니다.")

        return room

    def _is_staff_room(self, room: Mapping[str, Any] | None, room_id: str) -> bool:
        return bool(
            room
            and room.get("id") == room_id
            and room.get("orgId") == self.settings.bootstrap_org_id
            and room.get("status") in {READY, LIVE, ENDED}
            and isinstance(room.get("instructorMemberUids"), list)
        )

    def _require_staff(self, identity: VerifiedCloudIdentity) -> Mapping[str, Any]:
        user = self.repository.read_document(f"users/{identity.uid}")
        if not self._is_staff(user, identity.uid):
            raise AccessDenied("Only organization staff can manage room capacity")
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

    def _require_room_reader(
        self, room: Mapping[str, Any], uid: str, user: Mapping[str, Any]
    ) -> None:
        if user.get("organizationRole") != "ADMIN" and uid not in room.get(
            "instructorMemberUids", []
        ):
            raise AccessDenied("Only room instructors can access this room")

    def _require_capacity_manager(
        self, room: Mapping[str, Any], uid: str, user: Mapping[str, Any]
    ) -> None:
        self._require_room_reader(room, uid, user)
        if room.get("status") == ENDED:
            raise ResourceConflict("Capacity cannot be changed after the room ends")
        if not has_room_operation(room, uid, CAPACITY_OPERATIONS):
            raise AccessDenied("This instructor cannot manage room capacity")

    def _capacity_after_expiring(
        self,
        transaction: CloudStudentParticipantTransaction,
        room_id: str,
        now: datetime,
        operation_id: str,
    ) -> tuple[dict[str, Any], bool, bool]:
        path = self._capacity_path(room_id)
        raw = transaction.read_document(path)
        capacity_exists = raw is not None
        capacity = self._capacity_document(raw)
        expired = 0
        for participant in transaction.list_room_participants(
            room_path=self._room_path(room_id)
        ):
            if self._is_currently_active(participant, now):
                continue
            if participant.get("presenceStatus") == PRESENCE_ACTIVE:
                participant_id = participant.get("_documentId")
                if isinstance(participant_id, str) and participant_id:
                    transaction.update_document(
                        self._participant_path(room_id, participant_id),
                        {"presenceStatus": PRESENCE_EXPIRED},
                    )
                    self._write_audit(
                        transaction,
                        room_id,
                        "PARTICIPANT_EXPIRED",
                        f"{operation_id}-{expired}",
                        now,
                        {
                            "fromPresenceStatus": PRESENCE_ACTIVE,
                            "toPresenceStatus": PRESENCE_EXPIRED,
                        },
                    )
                    expired += 1
        for _ in range(expired):
            self._decrement_active(capacity)
        # A heartbeat normally only extends its own lease.  When it discovers
        # another participant's expired lease, the counter has changed as part
        # of this same transaction and must be persisted with that transition.
        return capacity, capacity_exists, expired > 0

    def _capacity_snapshot(
        self,
        transaction: CloudStudentParticipantTransaction,
        room_id: str,
        now: datetime,
    ) -> dict[str, Any]:
        """Return a current staff-facing count without mutating presence records.

        A capacity panel is a read-only view.  It must not create the private
        capacity document or mark expired participants while staff merely opens
        an existing room.  Join, heartbeat, leave, and explicit capacity
        decisions remain the only commands that reconcile stored presence.
        """
        capacity = self._capacity_document(
            transaction.read_document(self._capacity_path(room_id))
        )
        capacity["activeParticipantCount"] = sum(
            1
            for participant in transaction.list_room_participants(
                room_path=self._room_path(room_id)
            )
            if self._is_currently_active(participant, now)
        )
        return capacity

    def _capacity_document(self, raw: Mapping[str, Any] | None) -> dict[str, Any]:
        count = raw.get("activeParticipantCount") if raw else 0
        revision = raw.get("presenceRevision") if raw else 0
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            count = 0
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            revision = 0
        status = raw.get("capacityAlertStatus") if raw else CAPACITY_ALERT_RESOLVED
        if status not in {CAPACITY_ALERT_PENDING, CAPACITY_ALERT_RESOLVED}:
            status = CAPACITY_ALERT_RESOLVED
        return {
            "activeParticipantCount": count,
            "presenceRevision": revision,
            "capacityAlertStatus": status,
            "capacityAlertCooldownUntil": raw.get("capacityAlertCooldownUntil")
            if raw
            else None,
            "capacityAlertCreatedAt": raw.get("capacityAlertCreatedAt")
            if raw
            else None,
        }

    def _write_capacity(
        self,
        transaction: CloudStudentParticipantTransaction,
        room_id: str,
        capacity: Mapping[str, Any],
        capacity_exists: bool,
    ) -> None:
        path = self._capacity_path(room_id)
        if capacity_exists:
            transaction.update_document(path, capacity)
        else:
            transaction.create_document(path, capacity)

    def _new_participant(
        self, nickname: str, nickname_key: str, now: datetime, is_read_only: bool = False
    ) -> dict[str, Any]:
        return {
            "nickname": nickname,
            "nicknameNormalized": nickname_key,
            "joinedAt": now,
            "lastSeenAt": now,
            "leaseExpiresAt": self._lease_until(now),
            "leftAt": None,
            "participantStatus": JOINED,
            "presenceStatus": PRESENCE_READ_ONLY if is_read_only else PRESENCE_ACTIVE,
            "isAnonymous": True,
        }

    def _presence_changes(
        self,
        nickname: str,
        nickname_key: str,
        participant: Mapping[str, Any],
        now: datetime,
        is_read_only: bool = False,
    ) -> dict[str, Any]:
        changes: dict[str, Any] = {
            "lastSeenAt": now,
            "leaseExpiresAt": self._lease_until(now),
            "presenceStatus": PRESENCE_READ_ONLY if is_read_only else PRESENCE_ACTIVE,
            "leftAt": None,
        }
        if participant.get("nickname") != nickname:
            changes["nickname"] = nickname
            changes["nicknameNormalized"] = nickname_key
        return changes

    def _is_valid_participant(self, participant: Mapping[str, Any] | None) -> bool:
        return bool(
            participant
            and participant.get("participantStatus") == JOINED
            and participant.get("isAnonymous") is True
            and isinstance(participant.get("nickname"), str)
            and isinstance(participant.get("nicknameNormalized"), str)
        )

    def _can_open_existing_session(self, participant: Mapping[str, Any] | None, room: Mapping[str, Any]) -> bool:
        if not self._is_valid_participant(participant):
            return False
        assert participant is not None
        status = participant.get("presenceStatus")
        if status is None:
            # Old participant documents become active only after their first heartbeat.
            return True
        if room.get("status") == ENDED:
            return status == PRESENCE_READ_ONLY or status == PRESENCE_ACTIVE
        return status == PRESENCE_ACTIVE and self._is_currently_active(
            participant, datetime.now(UTC)
        )

    def _is_currently_active(
        self, participant: Mapping[str, Any] | None, now: datetime
    ) -> bool:
        if not participant or participant.get("presenceStatus") != PRESENCE_ACTIVE:
            return False
        lease = participant.get("leaseExpiresAt")
        return isinstance(lease, datetime) and self._as_utc(lease) > now

    def _as_utc(self, value: datetime) -> datetime:
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)

    def _lease_until(self, now: datetime) -> datetime:
        return now + timedelta(seconds=PRESENCE_LEASE_SECONDS)

    def _is_full(self, capacity: Mapping[str, Any], room: Mapping[str, Any]) -> bool:
        return int(capacity["activeParticipantCount"]) >= self._room_maximum(room)

    def _increment_active(self, capacity: dict[str, Any]) -> None:
        capacity["activeParticipantCount"] = int(capacity["activeParticipantCount"]) + 1
        capacity["presenceRevision"] = int(capacity["presenceRevision"]) + 1

    def _decrement_active(self, capacity: dict[str, Any]) -> None:
        previous = int(capacity["activeParticipantCount"])
        if previous > 0:
            capacity["activeParticipantCount"] = previous - 1
            capacity["presenceRevision"] = int(capacity["presenceRevision"]) + 1

    def _mark_capacity_alert(
        self, capacity: dict[str, Any], room: Mapping[str, Any], now: datetime
    ) -> bool:
        cooldown = capacity.get("capacityAlertCooldownUntil")
        in_cooldown = isinstance(cooldown, datetime) and self._as_utc(cooldown) > now
        if capacity.get("capacityAlertStatus") == CAPACITY_ALERT_PENDING or in_cooldown:
            return False
        capacity["capacityAlertStatus"] = CAPACITY_ALERT_PENDING
        capacity["capacityAlertCreatedAt"] = now
        return True

    def _resolve_capacity_alert(self, capacity: dict[str, Any], now: datetime) -> None:
        capacity["capacityAlertStatus"] = CAPACITY_ALERT_RESOLVED
        capacity["capacityAlertCooldownUntil"] = now + timedelta(
            seconds=CAPACITY_ALERT_COOLDOWN_SECONDS
        )

    def _room_maximum(self, room: Mapping[str, Any]) -> int:
        return self._maximum(
            room.get("maxActiveParticipants", DEFAULT_MAX_ACTIVE_PARTICIPANTS)
        )

    def _maximum(self, value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise InvalidOperation("The active participant limit is invalid")
        if not 1 <= value <= MAX_ACTIVE_PARTICIPANTS:
            raise InvalidOperation("The active participant limit is invalid")
        return value

    def _staff_capacity_response(
        self, room: Mapping[str, Any], capacity: Mapping[str, Any], uid: str
    ) -> dict[str, Any]:
        can_manage = has_room_operation(room, uid, CAPACITY_OPERATIONS)
        return {
            "activeParticipantCount": int(capacity["activeParticipantCount"]),
            "maxActiveParticipants": self._room_maximum(room),
            "canManageCapacity": can_manage,
            "capacityAlert": (
                {
                    "status": CAPACITY_ALERT_PENDING,
                    "activeParticipantCount": int(capacity["activeParticipantCount"]),
                    "maxActiveParticipants": self._room_maximum(room),
                }
                if can_manage
                and capacity.get("capacityAlertStatus") == CAPACITY_ALERT_PENDING
                else None
            ),
        }

    def _session(self, room: Mapping[str, Any], nickname: str) -> dict[str, Any]:
        status = room["status"]
        return {
            "nickname": nickname,
            "roomTitle": room["title"],
            "roomStatus": status,
            "participantStatus": JOINED,
            "accessMode": "READ_ONLY" if status == ENDED else "ACTIVE",
        }

    def _room_path(self, room_id: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/rooms/{room_id}"

    def _room_code_path(self, room_code: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/roomCodes/{room_code}"

    def _participant_path(self, room_id: str, uid: str) -> str:
        return f"{self._room_path(room_id)}/participants/{uid}"

    def _capacity_path(self, room_id: str) -> str:
        return f"{self._room_path(room_id)}/presence/capacity"

    def _write_audit(
        self,
        transaction: CloudStudentParticipantTransaction,
        room_id: str,
        event_type: str,
        operation_id: str,
        now: datetime,
        details: Mapping[str, Any],
    ) -> None:
        transaction.create_document(
            self._audit_path(room_id, event_type, operation_id),
            {
                "eventType": event_type,
                "orgId": self.settings.bootstrap_org_id,
                "roomId": room_id,
                "createdAt": now,
                **dict(details),
            },
        )

    def _audit_path(self, room_id: str, event_type: str, operation_id: str) -> str:
        return (
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/"
            f"{event_type.lower()}-{room_id}-{operation_id}"
        )
