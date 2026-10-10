from types import SimpleNamespace
from typing import Any

import pytest
from google.api_core.exceptions import Aborted
from grpc import StatusCode

from app.adapters.firebase_emulator import (
    FirestoreRepository,
    is_aborted_transaction_error,
    run_room_creation_with_retry,
)
from app.domain.errors import (
    ResourceConflict,
    ServiceTemporarilyUnavailable,
)


class GrpcAbortedError(Exception):
    def code(self) -> StatusCode:
        return StatusCode.ABORTED


class StateSnapshot:
    def __init__(self, document_id: str, value: dict[str, Any] | None) -> None:
        self.id = document_id
        self.exists = value is not None
        self.value = value

    def to_dict(self) -> dict[str, Any] | None:
        return self.value


class StateDocumentReference:
    def __init__(self, document_id: str, value: dict[str, Any] | None) -> None:
        self.id = document_id
        self.value = value

    def get(self) -> StateSnapshot:
        return StateSnapshot(self.id, self.value)


class StateCollection:
    def __init__(self, values: dict[str, dict[str, Any]]) -> None:
        self.values = values

    def document(self, document_id: str) -> StateDocumentReference:
        return StateDocumentReference(document_id, self.values.get(document_id))


class StateClient:
    def __init__(self, rooms: dict[str, dict[str, Any]] | None = None) -> None:
        self.rooms = rooms or {}

    def collection(self, name: str) -> StateCollection:
        assert name == "rooms"
        return StateCollection(self.rooms)


class ReconciliationRepository(FirestoreRepository):
    def __init__(
        self,
        *,
        course: dict[str, Any],
        code: dict[str, Any] | None,
        requested_room: dict[str, Any] | None,
        rooms: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(StateClient(rooms))
        self.creation_documents = (course, code, requested_room)

    def _read_room_creation_documents(
        self,
        *,
        course_ref: Any,
        code_ref: Any,
        room_ref: Any,
    ) -> tuple[
        dict[str, Any] | None,
        dict[str, Any] | None,
        dict[str, Any] | None,
    ]:
        return self.creation_documents


def reconcile(repository: FirestoreRepository) -> dict[str, Any] | None:
    return repository._reconcile_room_creation(
        course_id="course-current",
        room_ref=SimpleNamespace(id="room-current"),
        course_ref=SimpleNamespace(id="course-current"),
        code_ref=SimpleNamespace(id="CODE01"),
    )


def aborted_error() -> Aborted:
    return Aborted("Transaction lock timeout")


def test_direct_aborted_error_is_retryable() -> None:
    assert is_aborted_transaction_error(aborted_error())


def test_aborted_error_in_exception_chain_is_retryable() -> None:
    wrapped = ValueError("Transaction failed after five attempts")
    wrapped.__cause__ = aborted_error()

    assert is_aborted_transaction_error(wrapped)


def test_grpc_aborted_status_is_retryable() -> None:
    assert is_aborted_transaction_error(GrpcAbortedError())


def test_plain_value_error_is_not_misclassified_as_lock_error() -> None:
    assert not is_aborted_transaction_error(
        ValueError("Transaction lock timeout")
    )


def test_first_aborted_attempt_retries_and_then_succeeds() -> None:
    attempts = 0
    sleeps: list[float] = []

    def attempt() -> dict[str, str]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise aborted_error()
        return {"id": "room-current"}

    result = run_room_creation_with_retry(
        attempt=attempt,
        reconcile=lambda: None,
        sleep=sleeps.append,
    )

    assert result == {"id": "room-current"}
    assert attempts == 2
    assert sleeps == [0.05]


def test_retry_adds_injectable_bounded_jitter_to_exponential_backoff() -> None:
    attempts = 0
    jitter_limits: list[float] = []
    sleeps: list[float] = []

    def attempt() -> dict[str, str]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise aborted_error()
        return {"id": "room-current"}

    def maximum_jitter(limit: float) -> float:
        jitter_limits.append(limit)
        return limit

    result = run_room_creation_with_retry(
        attempt=attempt,
        reconcile=lambda: None,
        sleep=sleeps.append,
        jitter=maximum_jitter,
    )

    assert result == {"id": "room-current"}
    assert jitter_limits == [pytest.approx(0.025)]
    assert sleeps == [pytest.approx(0.075)]


def test_retry_clamps_injected_jitter_to_small_nonnegative_range() -> None:
    attempts = 0
    sleeps: list[float] = []

    def attempt() -> dict[str, str]:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise aborted_error()
        return {"id": "room-current"}

    jitter_values = iter((-1.0, 10.0))
    run_room_creation_with_retry(
        attempt=attempt,
        reconcile=lambda: None,
        sleep=sleeps.append,
        jitter=lambda _limit: next(jitter_values),
    )

    assert sleeps == [pytest.approx(0.05), pytest.approx(0.15)]


def test_other_request_winning_is_returned_as_conflict_without_retry() -> None:
    attempts = 0
    sleeps: list[float] = []

    def attempt() -> dict[str, str]:
        nonlocal attempts
        attempts += 1
        raise aborted_error()

    def reconcile() -> dict[str, str] | None:
        raise ResourceConflict("This course already has an active room")

    with pytest.raises(ResourceConflict, match="already has an active room"):
        run_room_creation_with_retry(
            attempt=attempt,
            reconcile=reconcile,
            sleep=sleeps.append,
        )

    assert attempts == 1
    assert sleeps == []


def test_current_request_commit_is_recovered_after_aborted_response() -> None:
    attempts = 0
    recovered_room = {"id": "room-current"}

    def attempt() -> dict[str, str]:
        nonlocal attempts
        attempts += 1
        raise aborted_error()

    result = run_room_creation_with_retry(
        attempt=attempt,
        reconcile=lambda: recovered_room,
        sleep=lambda _seconds: None,
    )

    assert result is recovered_room
    assert attempts == 1


def test_retry_exhaustion_returns_temporary_unavailability() -> None:
    attempts = 0
    reconciliations = 0
    sleeps: list[float] = []

    def attempt() -> dict[str, str]:
        nonlocal attempts
        attempts += 1
        raise aborted_error()

    def reconcile() -> dict[str, str] | None:
        nonlocal reconciliations
        reconciliations += 1
        return None

    with pytest.raises(ServiceTemporarilyUnavailable) as captured:
        run_room_creation_with_retry(
            attempt=attempt,
            reconcile=reconcile,
            sleep=sleeps.append,
        )

    assert captured.value.code == "temporarily_unavailable"
    assert captured.value.status_code == 503
    assert captured.value.headers == {"Retry-After": "1"}
    assert attempts == 4
    assert reconciliations == 4
    assert sleeps == [0.05, 0.1, 0.2]


def test_non_aborted_programming_error_is_not_retried() -> None:
    reconciliations = 0
    sleeps: list[float] = []

    def reconcile() -> dict[str, str] | None:
        nonlocal reconciliations
        reconciliations += 1
        return None

    def fail() -> dict[str, str]:
        raise ValueError("invalid application data")

    with pytest.raises(ValueError, match="invalid application data"):
        run_room_creation_with_retry(
            attempt=fail,
            reconcile=reconcile,
            sleep=sleeps.append,
        )

    assert reconciliations == 0
    assert sleeps == []


def test_reconciliation_aborted_error_uses_same_bounded_retry_policy() -> None:
    attempts = 0
    sleeps: list[float] = []

    def attempt() -> dict[str, str]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise aborted_error()
        return {"id": "room-current"}

    def reconcile() -> dict[str, str] | None:
        raise GrpcAbortedError()

    result = run_room_creation_with_retry(
        attempt=attempt,
        reconcile=reconcile,
        sleep=sleeps.append,
    )

    assert result == {"id": "room-current"}
    assert sleeps == [0.05]


def test_reconciliation_recovers_only_fully_linked_current_request() -> None:
    room = {
        "id": "room-current",
        "courseId": "course-current",
        "orgId": "org-nodo",
        "leadInstructorId": "lead-instructor",
    }
    repository = ReconciliationRepository(
        course={
            "id": "course-current",
            "orgId": "org-nodo",
            "activeRoomId": "room-current",
            "leadInstructorId": "lead-instructor",
        },
        code={"id": "CODE01", "orgId": "org-nodo", "roomId": "room-current"},
        requested_room=room,
    )

    assert reconcile(repository) is room


def test_reconciliation_returns_conflict_when_other_request_won_course() -> None:
    repository = ReconciliationRepository(
        course={
            "id": "course-current",
            "orgId": "org-nodo",
            "activeRoomId": "room-other",
        },
        code=None,
        requested_room=None,
        rooms={
            "room-other": {
                "id": "room-other",
                "courseId": "course-current",
                "orgId": "org-nodo",
            }
        },
    )

    with pytest.raises(ResourceConflict, match="already has an active room"):
        reconcile(repository)


def test_reconciliation_returns_conflict_when_code_is_claimed_elsewhere() -> None:
    repository = ReconciliationRepository(
        course={
            "id": "course-current",
            "orgId": "org-nodo",
            "activeRoomId": None,
        },
        code={"id": "CODE01", "orgId": "org-nodo", "roomId": "room-other"},
        requested_room=None,
        rooms={
            "room-other": {
                "id": "room-other",
                "courseId": "course-other",
                "orgId": "org-nodo",
            }
        },
    )

    with pytest.raises(ResourceConflict, match="join code is already in use"):
        reconcile(repository)


def test_reconciliation_allows_retry_when_no_creation_document_exists() -> None:
    repository = ReconciliationRepository(
        course={
            "id": "course-current",
            "orgId": "org-nodo",
            "activeRoomId": None,
        },
        code=None,
        requested_room=None,
    )

    assert reconcile(repository) is None


def test_reconciliation_rejects_partial_current_request_as_integrity_error() -> None:
    repository = ReconciliationRepository(
        course={
            "id": "course-current",
            "orgId": "org-nodo",
            "activeRoomId": "room-current",
        },
        code=None,
        requested_room={
            "id": "room-current",
            "courseId": "course-current",
            "orgId": "org-nodo",
        },
    )

    with pytest.raises(ResourceConflict, match="documents are inconsistent"):
        reconcile(repository)
