from collections.abc import Callable, Mapping
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.core.config import CLOUD_AUTH_RUNTIME_MODE, Settings
from app.domain.errors import AccessDenied, ResourceConflict
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_student_participant_service import (
    CAPACITY_FULL_MESSAGE,
    PRESENCE_ACTIVE,
    PRESENCE_EXPIRED,
    PRESENCE_LEFT,
    PRESENCE_READ_ONLY,
    PUBLIC_ROOM_UNAVAILABLE,
    CloudStudentParticipantService,
)
from app.services.student_auth_service import VerifiedStudentIdentity

START = datetime(2030, 1, 1, 12, 0, tzinfo=UTC)
ROOM_PATH = "organizations/demo/rooms/room-1"
CAPACITY_PATH = f"{ROOM_PATH}/presence/capacity"


def cloud_settings() -> Settings:
    return Settings(
        runtime_mode=CLOUD_AUTH_RUNTIME_MODE,
        firebase_project_id="example-gcp-project",
        bootstrap_org_owner_emails=frozenset({"owner@example.test"}),
        cors_origins=("http://localhost:5175",),
    )


class MemoryTransaction:
    def __init__(
        self, documents: dict[str, dict[str, Any]], server_now: datetime
    ) -> None:
        self.documents = documents
        self.pending: dict[str, dict[str, Any]] = {}
        self._server_now = server_now

    @property
    def server_timestamp(self) -> object:
        return self._server_now

    @property
    def server_now(self) -> datetime:
        return self._server_now

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        value = self.pending.get(path, self.documents.get(path))
        return deepcopy(value) if value is not None else None

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        assert path not in self.documents and path not in self.pending
        self.pending[path] = deepcopy(dict(document))

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        document = self.read_document(path)
        assert document is not None
        self.pending[path] = {**document, **deepcopy(dict(changes))}

    def find_participants_by_nickname(
        self, *, room_path: str, nickname_normalized: str
    ) -> list[Mapping[str, Any]]:
        return [
            {**document, "_documentId": path.rsplit("/", 1)[-1]}
            for path in self.documents | self.pending
            if path.startswith(f"{room_path}/participants/")
            and (document := self.read_document(path)) is not None
            and document.get("nicknameNormalized") == nickname_normalized
        ]

    def list_room_participants(self, *, room_path: str) -> list[Mapping[str, Any]]:
        return [
            {**document, "_documentId": path.rsplit("/", 1)[-1]}
            for path in self.documents | self.pending
            if path.startswith(f"{room_path}/participants/")
            and (document := self.read_document(path)) is not None
        ]


class MemoryRepository:
    def __init__(self, documents: dict[str, dict[str, Any]]) -> None:
        self.documents = documents
        self.now = START

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        value = self.documents.get(path)
        return deepcopy(value) if value is not None else None

    def run_transaction(self, callback: Callable[[MemoryTransaction], Any]) -> Any:
        transaction = MemoryTransaction(self.documents, self.now)
        result = callback(transaction)
        self.documents.update(transaction.pending)
        return result

    def advance(self, seconds: int) -> None:
        self.now += timedelta(seconds=seconds)


class RetryOnceMemoryRepository(MemoryRepository):
    """Run the same transaction callback twice, committing only its final attempt."""

    def run_transaction(self, callback: Callable[[MemoryTransaction], Any]) -> Any:
        callback(MemoryTransaction(self.documents, self.now))
        transaction = MemoryTransaction(self.documents, self.now)
        result = callback(transaction)
        self.documents.update(transaction.pending)
        return result


class AuditWriteFailureMemoryTransaction(MemoryTransaction):
    """Abort a transaction at one selected audit write, before pending writes commit."""

    def __init__(
        self,
        documents: dict[str, dict[str, Any]],
        server_now: datetime,
        failing_event_type: str,
    ) -> None:
        super().__init__(documents, server_now)
        self.failing_audit_prefix = (
            "organizations/demo/auditLogs/"
            f"{failing_event_type.lower()}-"
        )

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        if path.startswith(self.failing_audit_prefix):
            raise RuntimeError("simulated audit write failure")
        super().create_document(path, document)


class AuditWriteFailureMemoryRepository(MemoryRepository):
    """Model Firestore transaction abort semantics for a selected audit failure."""

    def __init__(
        self,
        documents: dict[str, dict[str, Any]],
        *,
        now: datetime,
        failing_event_type: str,
    ) -> None:
        super().__init__(documents)
        self.now = now
        self.failing_event_type = failing_event_type

    def run_transaction(
        self, callback: Callable[[AuditWriteFailureMemoryTransaction], Any]
    ) -> Any:
        transaction = AuditWriteFailureMemoryTransaction(
            self.documents, self.now, self.failing_event_type
        )
        result = callback(transaction)
        self.documents.update(transaction.pending)
        return result


def audit_events(repository: MemoryRepository) -> list[dict[str, Any]]:
    return [
        document
        for path, document in repository.documents.items()
        if path.startswith("organizations/demo/auditLogs/")
    ]


def event_count(repository: MemoryRepository, event_type: str) -> int:
    return sum(
        1 for event in audit_events(repository) if event.get("eventType") == event_type
    )


def assert_audit_events_are_minimal(repository: MemoryRepository) -> None:
    forbidden = {"email", "anonymousUid", "uid", "token", "questionBody"}
    for event in audit_events(repository):
        assert not (set(event) & forbidden)
        assert "anonymous-" not in str(event)


def failing_audit_repository(
    repository: MemoryRepository, event_type: str
) -> AuditWriteFailureMemoryRepository:
    return AuditWriteFailureMemoryRepository(
        deepcopy(repository.documents),
        now=repository.now,
        failing_event_type=event_type,
    )


@pytest.fixture
def repository() -> MemoryRepository:
    return MemoryRepository(
        {
            "organizations/demo/roomCodes/ABCDEFGH": {
                "roomId": "room-1",
                "status": "READY",
            },
            ROOM_PATH: {
                "id": "room-1",
                "orgId": "demo",
                "roomCode": "ABCDEFGH",
                "status": "READY",
                "title": "익명 수강생 입장 테스트",
                "maxActiveParticipants": 2,
                "roomCreatorUid": "must-not-leak",
                "sourceCourseId": "must-not-leak",
                "leadInstructorUid": "lead-uid",
                "instructorMemberUids": ["lead-uid", "assistant-uid"],
                "roomInstructors": [
                    {
                        "uid": "lead-uid",
                        "role": "LEAD",
                        "permissions": {
                            "questionOperations": True,
                            "checklistProgress": True,
                            "capacityOperations": True,
                        },
                    },
                    {
                        "uid": "assistant-uid",
                        "role": "ASSISTANT",
                        "permissions": {
                            "questionOperations": True,
                            "checklistProgress": False,
                            "capacityOperations": True,
                        },
                    },
                ],
            },
            "users/lead-uid": _staff("lead-uid", "INSTRUCTOR"),
            "users/assistant-uid": _staff("assistant-uid", "INSTRUCTOR"),
            "users/admin-uid": _staff("admin-uid", "ADMIN"),
        }
    )


def _staff(uid: str, role: str) -> dict[str, Any]:
    return {
        "uid": uid,
        "orgId": "demo",
        "accountType": "STAFF",
        "organizationRole": role,
        "organizationRoleRevision": 1,
    }


@pytest.fixture
def service(repository: MemoryRepository) -> CloudStudentParticipantService:
    return CloudStudentParticipantService(repository, cloud_settings())


def anonymous(uid: str) -> VerifiedStudentIdentity:
    return VerifiedStudentIdentity(uid=uid)


def staff(uid: str) -> VerifiedCloudIdentity:
    return VerifiedCloudIdentity(
        uid=uid, email=f"{uid}@example.test", display_name="강사", photo_url=None
    )


def test_public_room_returns_only_the_minimum_safe_metadata(
    service: CloudStudentParticipantService,
) -> None:
    assert service.public_room("demo", "abcdefgh") == {
        "title": "익명 수강생 입장 테스트",
        "status": "READY",
        "joinAllowed": True,
    }


def test_first_join_tracks_active_presence_without_exposing_identity(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    response = service.join(
        anonymous("anonymous-1"), "demo", "ABCDEFGH", "  맑은 구름  "
    )

    participant = repository.documents[f"{ROOM_PATH}/participants/anonymous-1"]
    assert participant == {
        "nickname": "맑은 구름",
        "nicknameNormalized": "맑은 구름",
        "joinedAt": START,
        "lastSeenAt": START,
        "leaseExpiresAt": START + timedelta(seconds=90),
        "leftAt": None,
        "participantStatus": "JOINED",
        "presenceStatus": PRESENCE_ACTIVE,
        "isAnonymous": True,
    }
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 1
    assert response == {
        "nickname": "맑은 구름",
        "roomTitle": "익명 수강생 입장 테스트",
        "roomStatus": "READY",
        "participantStatus": "JOINED",
        "accessMode": "ACTIVE",
    }
    assert "email" not in participant and "uid" not in participant
    assert event_count(repository, "PARTICIPANT_JOINED") == 1
    assert_audit_events_are_minimal(repository)


def test_join_enforces_capacity_and_audits_one_new_pending_alert(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    service.join(anonymous("anonymous-2"), "demo", "ABCDEFGH", "푸른 바람")

    with pytest.raises(ResourceConflict, match=CAPACITY_FULL_MESSAGE):
        service.join(anonymous("anonymous-3"), "demo", "ABCDEFGH", "하얀 별")

    assert f"{ROOM_PATH}/participants/anonymous-3" not in repository.documents
    capacity = repository.documents[CAPACITY_PATH]
    assert capacity["activeParticipantCount"] == 2
    assert capacity["capacityAlertStatus"] == "PENDING"
    assert "uid" not in capacity and "email" not in capacity
    assert event_count(repository, "CAPACITY_ALERT_RAISED") == 1
    alert = next(
        event
        for event in audit_events(repository)
        if event["eventType"] == "CAPACITY_ALERT_RAISED"
    )
    assert alert["alertStatus"] == "PENDING"
    assert_audit_events_are_minimal(repository)


def test_capacity_alert_rolls_back_when_its_audit_write_fails(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    service.join(anonymous("anonymous-2"), "demo", "ABCDEFGH", "푸른 바람")
    failing_repository = failing_audit_repository(
        repository, "CAPACITY_ALERT_RAISED"
    )
    failing_service = CloudStudentParticipantService(
        failing_repository, cloud_settings()
    )
    before = deepcopy(failing_repository.documents)

    with pytest.raises(RuntimeError, match="simulated audit write failure"):
        failing_service.join(
            anonymous("anonymous-3"), "demo", "ABCDEFGH", "하얀 별"
        )

    assert failing_repository.documents == before


def test_repeated_capacity_overflow_keeps_one_pending_alert(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    service.join(anonymous("anonymous-2"), "demo", "ABCDEFGH", "푸른 바람")

    with pytest.raises(ResourceConflict, match=CAPACITY_FULL_MESSAGE):
        service.join(anonymous("anonymous-3"), "demo", "ABCDEFGH", "하얀 별")
    first_alert = deepcopy(repository.documents[CAPACITY_PATH])

    with pytest.raises(ResourceConflict, match=CAPACITY_FULL_MESSAGE):
        service.join(anonymous("anonymous-4"), "demo", "ABCDEFGH", "고운 달")

    assert repository.documents[CAPACITY_PATH] == first_alert
    assert event_count(repository, "CAPACITY_ALERT_RAISED") == 1


def test_keep_capacity_uses_cooldown_before_a_new_pending_alert(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    service.join(anonymous("anonymous-2"), "demo", "ABCDEFGH", "푸른 바람")
    with pytest.raises(ResourceConflict, match=CAPACITY_FULL_MESSAGE):
        service.join(anonymous("anonymous-3"), "demo", "ABCDEFGH", "하얀 별")

    service.keep_capacity(staff("lead-uid"), "room-1")
    resolved = deepcopy(repository.documents[CAPACITY_PATH])
    assert resolved["capacityAlertStatus"] == "RESOLVED"
    assert event_count(repository, "CAPACITY_KEPT") == 1

    service.keep_capacity(staff("lead-uid"), "room-1")
    assert event_count(repository, "CAPACITY_KEPT") == 1

    with pytest.raises(ResourceConflict, match=CAPACITY_FULL_MESSAGE):
        service.join(anonymous("anonymous-4"), "demo", "ABCDEFGH", "고운 달")
    assert repository.documents[CAPACITY_PATH] == resolved
    assert event_count(repository, "CAPACITY_ALERT_RAISED") == 1

    repository.advance(61)
    with pytest.raises(ResourceConflict, match=CAPACITY_FULL_MESSAGE):
        service.join(anonymous("anonymous-5"), "demo", "ABCDEFGH", "푸른 달")
    assert repository.documents[CAPACITY_PATH]["capacityAlertStatus"] == "PENDING"
    assert event_count(repository, "CAPACITY_ALERT_RAISED") == 2


def test_capacity_keep_rolls_back_when_its_audit_write_fails(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    service.join(anonymous("anonymous-2"), "demo", "ABCDEFGH", "푸른 바람")
    with pytest.raises(ResourceConflict, match=CAPACITY_FULL_MESSAGE):
        service.join(anonymous("anonymous-3"), "demo", "ABCDEFGH", "하얀 별")
    failing_repository = failing_audit_repository(repository, "CAPACITY_KEPT")
    failing_service = CloudStudentParticipantService(
        failing_repository, cloud_settings()
    )
    before = deepcopy(failing_repository.documents)

    with pytest.raises(RuntimeError, match="simulated audit write failure"):
        failing_service.keep_capacity(staff("lead-uid"), "room-1")

    assert failing_repository.documents == before


def test_leave_is_idempotent_and_reentry_reuses_the_same_participant(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    identity = anonymous("anonymous-1")
    service.join(identity, "demo", "ABCDEFGH", "맑은 구름")
    service.join(identity, "demo", "ABCDEFGH", "맑은 구름")
    assert repository.documents[ROOM_PATH]["totalParticipantCount"] == 1
    service.heartbeat(identity, "demo", "ABCDEFGH")
    assert repository.documents[ROOM_PATH]["totalParticipantCount"] == 1
    assert event_count(repository, "PARTICIPANT_JOINED") == 1
    assert event_count(repository, "PARTICIPANT_REJOINED") == 0

    assert service.leave(identity, "demo", "ABCDEFGH") == {"left": True}
    assert service.leave(identity, "demo", "ABCDEFGH") == {"left": False}
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 0
    assert (
        repository.documents[f"{ROOM_PATH}/participants/anonymous-1"]["presenceStatus"]
        == PRESENCE_LEFT
    )

    service.join(identity, "demo", "ABCDEFGH", "푸른 바람")
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 1
    assert (
        repository.documents[f"{ROOM_PATH}/participants/anonymous-1"]["nickname"]
        == "푸른 바람"
    )
    assert len([path for path in repository.documents if "/participants/" in path]) == 1
    assert repository.documents[ROOM_PATH]["totalParticipantCount"] == 1
    assert event_count(repository, "PARTICIPANT_JOINED") == 1
    assert event_count(repository, "PARTICIPANT_LEFT") == 1
    assert event_count(repository, "PARTICIPANT_REJOINED") == 1
    assert_audit_events_are_minimal(repository)


def test_leave_and_reentry_roll_back_when_their_audit_write_fails(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    identity = anonymous("anonymous-1")
    service.join(identity, "demo", "ABCDEFGH", "맑은 구름")
    leave_failure_repository = failing_audit_repository(repository, "PARTICIPANT_LEFT")
    leave_failure_service = CloudStudentParticipantService(
        leave_failure_repository, cloud_settings()
    )
    before_leave = deepcopy(leave_failure_repository.documents)

    with pytest.raises(RuntimeError, match="simulated audit write failure"):
        leave_failure_service.leave(identity, "demo", "ABCDEFGH")

    assert leave_failure_repository.documents == before_leave

    assert service.leave(identity, "demo", "ABCDEFGH") == {"left": True}
    rejoin_failure_repository = failing_audit_repository(
        repository, "PARTICIPANT_REJOINED"
    )
    rejoin_failure_service = CloudStudentParticipantService(
        rejoin_failure_repository, cloud_settings()
    )
    before_rejoin = deepcopy(rejoin_failure_repository.documents)

    with pytest.raises(RuntimeError, match="simulated audit write failure"):
        rejoin_failure_service.join(identity, "demo", "ABCDEFGH", "맑은 구름")

    assert rejoin_failure_repository.documents == before_rejoin


def test_expired_active_participant_is_retained_but_removed_from_capacity(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    repository.advance(91)

    service.join(anonymous("anonymous-2"), "demo", "ABCDEFGH", "푸른 바람")

    assert (
        repository.documents[f"{ROOM_PATH}/participants/anonymous-1"]["presenceStatus"]
        == PRESENCE_EXPIRED
    )
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 1
    assert event_count(repository, "PARTICIPANT_EXPIRED") == 1

    service.leave(anonymous("anonymous-1"), "demo", "ABCDEFGH")
    assert event_count(repository, "PARTICIPANT_EXPIRED") == 1

    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    assert event_count(repository, "PARTICIPANT_REJOINED") == 1
    rejoin = next(
        event
        for event in audit_events(repository)
        if event["eventType"] == "PARTICIPANT_REJOINED"
    )
    assert rejoin["fromPresenceStatus"] == PRESENCE_EXPIRED
    assert rejoin["toPresenceStatus"] == PRESENCE_ACTIVE


def test_expiration_rolls_back_when_its_audit_write_fails(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    repository.advance(91)
    failing_repository = failing_audit_repository(
        repository, "PARTICIPANT_EXPIRED"
    )
    failing_service = CloudStudentParticipantService(
        failing_repository, cloud_settings()
    )
    before = deepcopy(failing_repository.documents)

    with pytest.raises(RuntimeError, match="simulated audit write failure"):
        failing_service.join(
            anonymous("anonymous-2"), "demo", "ABCDEFGH", "푸른 바람"
        )

    assert failing_repository.documents == before


def test_heartbeat_refreshes_only_the_participant_when_already_active(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    identity = anonymous("anonymous-1")
    service.join(identity, "demo", "ABCDEFGH", "맑은 구름")
    before = deepcopy(repository.documents)
    repository.advance(30)

    assert service.heartbeat(identity, "demo", "ABCDEFGH") == {
        "presenceStatus": PRESENCE_ACTIVE
    }

    assert repository.documents[CAPACITY_PATH] == before[CAPACITY_PATH]
    assert repository.documents[f"{ROOM_PATH}/participants/anonymous-1"][
        "lastSeenAt"
    ] == (START + timedelta(seconds=30))
    assert len([path for path in repository.documents if "auditLogs" in path]) == 1
    assert event_count(repository, "PARTICIPANT_REJOINED") == 0


def test_active_heartbeat_persists_capacity_after_expiring_another_participant(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    first = anonymous("anonymous-1")
    second = anonymous("anonymous-2")
    service.join(first, "demo", "ABCDEFGH", "맑은 구름")
    service.join(second, "demo", "ABCDEFGH", "푸른 바람")
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 2

    # Keep A's lease fresh while B's original lease expires.
    repository.advance(60)
    service.heartbeat(first, "demo", "ABCDEFGH")
    repository.advance(31)
    service.heartbeat(first, "demo", "ABCDEFGH")

    assert (
        repository.documents[f"{ROOM_PATH}/participants/anonymous-1"][
            "presenceStatus"
        ]
        == PRESENCE_ACTIVE
    )
    assert (
        repository.documents[f"{ROOM_PATH}/participants/anonymous-2"][
            "presenceStatus"
        ]
        == PRESENCE_EXPIRED
    )
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 1
    assert event_count(repository, "PARTICIPANT_EXPIRED") == 1

    # A repeated heartbeat must not decrement twice or duplicate the audit.
    service.heartbeat(first, "demo", "ABCDEFGH")
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 1
    assert event_count(repository, "PARTICIPANT_EXPIRED") == 1

    assert service.leave(first, "demo", "ABCDEFGH") == {"left": True}
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 0
    service.join(second, "demo", "ABCDEFGH", "푸른 바람")
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 1
    assert event_count(repository, "PARTICIPANT_REJOINED") == 1


def test_expiring_other_participant_in_active_heartbeat_is_retry_safe(
    repository: MemoryRepository,
) -> None:
    first = anonymous("anonymous-1")
    second = anonymous("anonymous-2")
    setup_service = CloudStudentParticipantService(repository, cloud_settings())
    setup_service.join(first, "demo", "ABCDEFGH", "맑은 구름")
    setup_service.join(second, "demo", "ABCDEFGH", "푸른 바람")
    repository.advance(60)
    setup_service.heartbeat(first, "demo", "ABCDEFGH")
    repository.advance(31)

    retry_repository = RetryOnceMemoryRepository(deepcopy(repository.documents))
    retry_repository.now = repository.now
    retry_service = CloudStudentParticipantService(retry_repository, cloud_settings())
    retry_service.heartbeat(first, "demo", "ABCDEFGH")

    assert retry_repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 1
    assert event_count(retry_repository, "PARTICIPANT_EXPIRED") == 1


def test_active_heartbeat_expiration_rolls_back_when_its_audit_write_fails(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    first = anonymous("anonymous-1")
    service.join(first, "demo", "ABCDEFGH", "맑은 구름")
    service.join(anonymous("anonymous-2"), "demo", "ABCDEFGH", "푸른 바람")
    repository.advance(60)
    service.heartbeat(first, "demo", "ABCDEFGH")
    repository.advance(31)

    failing_repository = failing_audit_repository(
        repository, "PARTICIPANT_EXPIRED"
    )
    failing_service = CloudStudentParticipantService(
        failing_repository, cloud_settings()
    )
    before = deepcopy(failing_repository.documents)

    with pytest.raises(RuntimeError, match="simulated audit write failure"):
        failing_service.heartbeat(first, "demo", "ABCDEFGH")

    assert failing_repository.documents == before


def test_capacity_increase_records_previous_and_next_values_once(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    changed = service.increase_capacity(staff("lead-uid"), "room-1", 3)

    assert changed["maxActiveParticipants"] == 3
    assert event_count(repository, "CAPACITY_INCREASED") == 1
    event = next(
        event
        for event in audit_events(repository)
        if event["eventType"] == "CAPACITY_INCREASED"
    )
    assert event["previousMaxActiveParticipants"] == 2
    assert event["nextMaxActiveParticipants"] == 3
    assert event["actorUid"] == "lead-uid"

    with pytest.raises(ResourceConflict, match="현재 값보다 크게"):
        service.increase_capacity(staff("lead-uid"), "room-1", 3)
    assert event_count(repository, "CAPACITY_INCREASED") == 1
    assert_audit_events_are_minimal(repository)


def test_capacity_increase_rolls_back_when_its_audit_write_fails(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    failing_repository = failing_audit_repository(
        repository, "CAPACITY_INCREASED"
    )
    failing_service = CloudStudentParticipantService(
        failing_repository, cloud_settings()
    )
    before = deepcopy(failing_repository.documents)

    with pytest.raises(RuntimeError, match="simulated audit write failure"):
        failing_service.increase_capacity(staff("lead-uid"), "room-1", 3)

    assert failing_repository.documents == before


def test_transaction_retry_writes_each_audit_event_once(
    repository: MemoryRepository,
) -> None:
    retry_repository = RetryOnceMemoryRepository(deepcopy(repository.documents))
    retry_service = CloudStudentParticipantService(retry_repository, cloud_settings())
    identity = anonymous("anonymous-1")

    retry_service.join(identity, "demo", "ABCDEFGH", "맑은 구름")
    retry_service.join(anonymous("anonymous-2"), "demo", "ABCDEFGH", "푸른 바람")
    with pytest.raises(ResourceConflict, match=CAPACITY_FULL_MESSAGE):
        retry_service.join(anonymous("anonymous-3"), "demo", "ABCDEFGH", "하얀 별")
    retry_service.keep_capacity(staff("lead-uid"), "room-1")
    retry_service.increase_capacity(staff("lead-uid"), "room-1", 3)
    retry_service.leave(identity, "demo", "ABCDEFGH")

    assert event_count(retry_repository, "PARTICIPANT_JOINED") == 2
    assert event_count(retry_repository, "PARTICIPANT_LEFT") == 1
    assert event_count(retry_repository, "CAPACITY_ALERT_RAISED") == 1
    assert event_count(retry_repository, "CAPACITY_KEPT") == 1
    assert event_count(retry_repository, "CAPACITY_INCREASED") == 1
    assert len(audit_events(retry_repository)) == 6


def test_legacy_participant_becomes_active_only_after_heartbeat(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    repository.documents[f"{ROOM_PATH}/participants/anonymous-1"] = {
        "nickname": "맑은 구름",
        "nicknameNormalized": "맑은 구름",
        "participantStatus": "JOINED",
        "isAnonymous": True,
    }
    identity = anonymous("anonymous-1")

    assert service.session(identity, "demo", "ABCDEFGH")["nickname"] == "맑은 구름"
    service.heartbeat(identity, "demo", "ABCDEFGH")

    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 1
    assert (
        repository.documents[f"{ROOM_PATH}/participants/anonymous-1"]["presenceStatus"]
        == PRESENCE_ACTIVE
    )


def test_staff_can_view_count_but_only_assigned_instructors_manage_capacity(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    before_capacity_read = deepcopy(repository.documents)

    admin_view = service.staff_capacity(staff("admin-uid"), "room-1")
    assert admin_view == {
        "activeParticipantCount": 1,
        "maxActiveParticipants": 2,
        "canManageCapacity": False,
        "capacityAlert": None,
    }
    assert repository.documents == before_capacity_read
    with pytest.raises(AccessDenied, match="cannot manage room capacity"):
        service.increase_capacity(staff("admin-uid"), "room-1", 3)

    changed = service.increase_capacity(staff("assistant-uid"), "room-1", 3)
    assert changed["maxActiveParticipants"] == 3
    assert repository.documents[ROOM_PATH]["maxActiveParticipants"] == 3


def test_staff_capacity_view_excludes_expired_presence_without_writing(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
    repository.advance(91)
    before_capacity_read = deepcopy(repository.documents)

    response = service.staff_capacity(staff("lead-uid"), "room-1")

    assert response["activeParticipantCount"] == 0
    assert repository.documents == before_capacity_read


def test_ended_room_rejects_capacity_changes(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    repository.documents[ROOM_PATH]["status"] = "ENDED"

    with pytest.raises(ResourceConflict, match="after the room ends"):
        service.increase_capacity(staff("lead-uid"), "room-1", 3)


def test_staff_capacity_get_does_not_create_a_missing_capacity_document(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    before_capacity_read = deepcopy(repository.documents)

    response = service.staff_capacity(staff("lead-uid"), "room-1")

    assert response == {
        "activeParticipantCount": 0,
        "maxActiveParticipants": 2,
        "canManageCapacity": True,
        "capacityAlert": None,
    }
    assert CAPACITY_PATH not in repository.documents
    assert repository.documents == before_capacity_read


def test_duplicate_nickname_is_rejected_within_one_room(
    service: CloudStudentParticipantService,
) -> None:
    service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")

    with pytest.raises(ResourceConflict, match="이미 사용 중인 별명"):
        service.join(anonymous("anonymous-2"), "demo", "ABCDEFGH", "맑은   구름")


@pytest.mark.parametrize(
    ("org_id", "room_code"),
    [("other", "ABCDEFGH"), ("demo", "INVALID0")],
)
def test_invalid_public_route_uses_one_generic_unavailable_message(
    service: CloudStudentParticipantService, org_id: str, room_code: str
) -> None:
    with pytest.raises(AccessDenied, match=PUBLIC_ROOM_UNAVAILABLE):
        service.public_room(org_id, room_code)


@pytest.mark.parametrize(
    "nickname", ["별", "가" * 17, "<b>별빛</b>", "별빛/구름", "별빛\n구름"]
)
def test_participant_nickname_contract_rejects_non_plain_text(
    service: CloudStudentParticipantService, nickname: str
) -> None:
    with pytest.raises(ValueError):
        service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", nickname)


def test_ended_room_allows_join_in_read_only_mode_and_does_not_increment_active_count(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    repository.documents[ROOM_PATH]["status"] = "ENDED"
    repository.documents[ROOM_PATH]["endedAt"] = START
    repository.documents[ROOM_PATH]["downloadAvailableUntil"] = (START + timedelta(days=7)).isoformat()

    response = service.join(
        anonymous("anonymous-1"), "demo", "ABCDEFGH", "  맑은 구름  "
    )

    assert response == {
        "nickname": "맑은 구름",
        "roomTitle": "익명 수강생 입장 테스트",
        "roomStatus": "ENDED",
        "participantStatus": "JOINED",
        "accessMode": "READ_ONLY",
    }
    participant = repository.documents[f"{ROOM_PATH}/participants/anonymous-1"]
    assert participant["presenceStatus"] == PRESENCE_READ_ONLY
    assert repository.documents[CAPACITY_PATH]["activeParticipantCount"] == 0


def test_ended_room_rejects_join_if_material_access_period_is_expired(
    service: CloudStudentParticipantService, repository: MemoryRepository
) -> None:
    repository.documents[ROOM_PATH]["status"] = "ENDED"
    repository.documents[ROOM_PATH]["endedAt"] = START - timedelta(days=10)
    repository.documents[ROOM_PATH]["downloadAvailableUntil"] = (START - timedelta(days=1)).isoformat()

    with pytest.raises(AccessDenied, match="자료 열람 기간이 종료되었습니다"):
        service.join(anonymous("anonymous-1"), "demo", "ABCDEFGH", "맑은 구름")
