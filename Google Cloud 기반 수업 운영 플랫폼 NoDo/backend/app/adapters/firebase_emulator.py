import hashlib
import os
import random
import secrets
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

import firebase_admin
from firebase_admin import auth, credentials, firestore
from google.api_core.exceptions import Aborted, AlreadyExists, FailedPrecondition
from google.auth.credentials import AnonymousCredentials
from google.cloud.firestore_v1 import FieldFilter, LastUpdateOption
from grpc import StatusCode

from app.core.config import settings
from app.domain.authorization import (
    AccountType,
    Permission,
    Principal,
    RoomRole,
    RoomStatus,
    account_profile,
    default_assistant_permissions,
    empty_permissions,
    is_room_lead,
    normalize_permissions,
)
from app.domain.checklist import (
    calculate_completion_transition,
    calculate_item_numbers,
    normalize_flow_progress,
)
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    QuestionRateLimited,
    ResourceConflict,
    ResourceNotFound,
    ServiceTemporarilyUnavailable,
)
from app.domain.questions import (
    QUESTION_RATE_MAX_COUNT,
    QUESTION_RATE_WINDOW_SECONDS,
    QUESTION_REPEAT_WINDOW_SECONDS,
    ModerationDecision,
    fingerprints_are_similar,
    public_question,
    question_creation_response,
)

FIREBASE_APP_NAME = "nodo-local-emulator"
SCHEMA_VERSION = 1
ROOM_CREATION_MAX_EXTERNAL_RETRIES = 3
ROOM_CREATION_INITIAL_BACKOFF_SECONDS = 0.05
ROOM_CREATION_JITTER_RATIO = 0.5


def random_room_creation_jitter(maximum_seconds: float) -> float:
    return random.uniform(0.0, maximum_seconds)


def is_aborted_transaction_error(error: BaseException) -> bool:
    """Return True only when an exception chain contains an ABORTED failure."""

    pending: list[BaseException] = [error]
    visited: set[int] = set()
    while pending:
        current = pending.pop()
        identity = id(current)
        if identity in visited:
            continue
        visited.add(identity)

        if isinstance(current, Aborted):
            return True

        code_member = getattr(current, "code", None)
        try:
            status_code = code_member() if callable(code_member) else code_member
        except Exception:  # A broken third-party error object is not retryable.
            status_code = None
        if status_code is StatusCode.ABORTED:
            return True

        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)
    return False


def run_room_creation_with_retry[RoomCreationResult](
    *,
    attempt: Callable[[], RoomCreationResult],
    reconcile: Callable[[], RoomCreationResult | None],
    sleep: Callable[[float], None],
    jitter: Callable[[float], float] | None = None,
    max_external_retries: int = ROOM_CREATION_MAX_EXTERNAL_RETRIES,
    initial_backoff_seconds: float = ROOM_CREATION_INITIAL_BACKOFF_SECONDS,
) -> RoomCreationResult:
    """Run isolated transaction attempts and resolve ambiguous ABORTED commits."""

    for retry_index in range(max_external_retries + 1):
        transaction_error: Exception | None = None
        try:
            return attempt()
        except Exception as error:
            if not is_aborted_transaction_error(error):
                raise
            transaction_error = error

        # Reconcile outside the exception handler. Domain errors raised by this
        # read must not inherit the preceding ABORTED as an implicit context.
        try:
            recovered = reconcile()
        except Exception as reconciliation_error:
            if not is_aborted_transaction_error(reconciliation_error):
                raise
            recovered = None
        if recovered is not None:
            return recovered
        if retry_index == max_external_retries:
            raise ServiceTemporarilyUnavailable(
                "요청이 일시적으로 몰렸습니다. 잠시 후 다시 시도해 주세요."
            ) from transaction_error
        base_delay = initial_backoff_seconds * (2**retry_index)
        maximum_jitter = base_delay * ROOM_CREATION_JITTER_RATIO
        jitter_delay = jitter(maximum_jitter) if jitter else 0.0
        bounded_jitter = min(max(jitter_delay, 0.0), maximum_jitter)
        sleep(base_delay + bounded_jitter)

    raise AssertionError("The bounded room-creation retry loop did not terminate")


def deterministic_question_id(
    *, room_id: str, participant_uid: str, client_request_id: str
) -> str:
    value = f"{room_id}\0{participant_uid}\0{client_request_id}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:40]


def _safe_participant(
    document: dict[str, Any], *, participant_id: str
) -> dict[str, Any]:
    return {
        "participantId": participant_id,
        "nickname": document.get("nickname", "익명 수강생"),
        "status": document.get("status", "ACTIVE"),
        "isQuestionRestricted": bool(document.get("isQuestionRestricted", False)),
        "joinedAt": document.get("joinedAt"),
        "updatedAt": document.get("updatedAt"),
    }


def _legacy_participant_id(room_id: str, uid: str) -> str:
    value = hashlib.sha256(f"{room_id}\0{uid}".encode()).hexdigest()[:24]
    return f"legacy-{value}"


def _profile_account_type(document: dict[str, Any] | None) -> AccountType | None:
    if document is None:
        return None
    try:
        return account_profile(document)[0]
    except ValueError:
        return None


class EmulatorCredential(credentials.Base):
    """Credential that can never obtain a real Google access token."""

    def get_credential(self) -> AnonymousCredentials:
        return AnonymousCredentials()


def get_admin_app() -> firebase_admin.App:
    settings.ensure_emulator_only()
    os.environ["FIREBASE_AUTH_EMULATOR_HOST"] = settings.firebase_auth_emulator_host
    os.environ["FIRESTORE_EMULATOR_HOST"] = settings.firestore_emulator_host
    try:
        return firebase_admin.get_app(FIREBASE_APP_NAME)
    except ValueError:
        return firebase_admin.initialize_app(
            EmulatorCredential(),
            {
                "projectId": settings.firebase_project_id,
                "storageBucket": "demo-nodo.appspot.com",
            },
            name=FIREBASE_APP_NAME,
        )


def get_firestore_client() -> Any:
    return firestore.client(app=get_admin_app())


def verify_emulator_id_token(token: str) -> Mapping[str, Any]:
    settings.ensure_emulator_only()
    return auth.verify_id_token(token, app=get_admin_app())


def _document(snapshot: Any) -> dict[str, Any] | None:
    if not snapshot.exists:
        return None
    value = snapshot.to_dict() or {}
    value.setdefault("id", snapshot.id)
    return value


def assert_room_course_integrity(room: dict[str, Any], course: dict[str, Any]) -> None:
    if (
        room.get("courseId") != course.get("id")
        or room.get("orgId") != course.get("orgId")
        or course.get("activeRoomId") != room.get("id")
    ):
        raise ResourceConflict("Room and course links are inconsistent")


def _require_active_room(room: dict[str, Any]) -> None:
    if room.get("status") != RoomStatus.ACTIVE.value:
        raise AccessDenied("This operation requires an active room")


def _require_room_lead(principal: Principal, room: dict[str, Any]) -> None:
    if principal.org_id != room.get("orgId") or not is_room_lead(principal, room):
        raise AccessDenied("Only the assigned lead instructor can perform this action")


def _valid_room_staff(
    principal: Principal,
    room: dict[str, Any],
    staff: dict[str, Any] | None,
) -> bool:
    return bool(
        principal.account_type is AccountType.STAFF
        and principal.org_id == room.get("orgId")
        and staff is not None
        and staff.get("orgId") == room.get("orgId")
        and staff.get("userId") == principal.uid
        and staff.get("roomId") in {None, room.get("id")}
    )


class FirestoreRepository:
    def __init__(
        self,
        client: Any | None = None,
        *,
        room_creation_sleep: Callable[[float], None] = time.sleep,
        room_creation_jitter: Callable[[float], float] = random_room_creation_jitter,
        server_clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.client = client or get_firestore_client()
        self.room_creation_sleep = room_creation_sleep
        self.room_creation_jitter = room_creation_jitter
        self.server_clock = server_clock or (lambda: datetime.now(UTC))

    def get_user(self, uid: str) -> dict[str, Any] | None:
        return _document(self.client.collection("users").document(uid).get())

    def get_course(self, course_id: str) -> dict[str, Any] | None:
        return _document(self.client.collection("courses").document(course_id).get())

    def list_courses(self, org_id: str) -> list[dict[str, Any]]:
        query = self.client.collection("courses").where(
            filter=FieldFilter("orgId", "==", org_id)
        )
        return [document for item in query.stream() if (document := _document(item))]

    def list_users(self, org_id: str) -> list[dict[str, Any]]:
        query = self.client.collection("users").where(
            filter=FieldFilter("orgId", "==", org_id)
        )
        return [document for item in query.stream() if (document := _document(item))]

    def create_course(
        self,
        *,
        org_id: str,
        title: str,
        description: str,
        lead_instructor_id: str,
        created_by: str,
    ) -> dict[str, Any]:
        reference = self.client.collection("courses").document()
        now = firestore.SERVER_TIMESTAMP
        value = {
            "id": reference.id,
            "orgId": org_id,
            "title": title,
            "description": description,
            "leadInstructorId": lead_instructor_id,
            "activeRoomId": None,
            "status": "DRAFT",
            "createdBy": created_by,
            "createdAt": now,
            "updatedAt": now,
            "schemaVersion": SCHEMA_VERSION,
        }
        reference.create(value)
        return _document(reference.get()) or value

    def update_course(
        self,
        course_id: str,
        *,
        title: str,
        description: str,
        principal: Principal,
    ) -> dict[str, Any]:
        course_ref = self.client.collection("courses").document(course_id)
        transaction = self.client.transaction()

        @firestore.transactional
        def apply_update(transaction: Any) -> None:
            course = _document(course_ref.get(transaction=transaction))
            if course is None:
                raise ResourceNotFound("Course not found")
            if principal.org_id != course.get("orgId"):
                raise AccessDenied("Cross-organization access is not allowed")
            room_id = course.get("activeRoomId")
            if room_id:
                room_ref = self.client.collection("rooms").document(room_id)
                room = _document(room_ref.get(transaction=transaction))
                if room is None:
                    raise ResourceConflict("The active room does not exist")
                assert_room_course_integrity(room, course)
                if room.get("status") == RoomStatus.ENDED.value:
                    raise AccessDenied("An ended room cannot be changed")
                if not is_room_lead(principal, room):
                    if principal.account_type is not AccountType.STAFF:
                        raise AccessDenied("The canEditCourse permission is required")
                    staff = _document(
                        room_ref.collection("staff")
                        .document(principal.uid)
                        .get(transaction=transaction)
                    )
                    if not _valid_room_staff(principal, room, staff) or not staff.get(
                        "permissions", {}
                    ).get(Permission.CAN_EDIT_COURSE.value, False):
                        raise AccessDenied("The canEditCourse permission is required")
            elif not (
                principal.account_type is AccountType.STAFF
                and course.get("leadInstructorId") == principal.uid
            ):
                raise AccessDenied("Only the assigned lead can change this course")
            transaction.update(
                course_ref,
                {
                    "title": title,
                    "description": description,
                    "updatedBy": principal.uid,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                },
            )

        apply_update(transaction)
        return _document(course_ref.get()) or {}

    def replace_course_flow(
        self,
        course_id: str,
        *,
        chapters: list[dict[str, Any]],
        items: list[dict[str, Any]],
        principal: Principal,
    ) -> dict[str, Any]:
        course_ref = self.client.collection("courses").document(course_id)
        chapter_collection = course_ref.collection("chapters")
        item_collection = course_ref.collection("items")
        chapter_query = chapter_collection.order_by("order")
        item_query = item_collection.order_by("order")
        ordered_items = sorted(items, key=lambda item: item["order"])
        transaction = self.client.transaction()

        @firestore.transactional
        def apply_flow(transaction: Any) -> list[dict[str, Any]]:
            course = _document(course_ref.get(transaction=transaction))
            if course is None:
                raise ResourceNotFound("Course not found")
            if principal.org_id != course.get("orgId"):
                raise AccessDenied("Cross-organization access is not allowed")
            room_ref = None
            room = None
            room_id = course.get("activeRoomId")
            if room_id:
                room_ref = self.client.collection("rooms").document(room_id)
                room = _document(room_ref.get(transaction=transaction))
                if room is None:
                    raise ResourceConflict("The active room does not exist")
                assert_room_course_integrity(room, course)
                if room.get("status") == RoomStatus.ENDED.value:
                    raise AccessDenied("An ended room cannot be changed")
                if not is_room_lead(principal, room):
                    if principal.account_type is not AccountType.STAFF:
                        raise AccessDenied(
                            "The canEditCourseFlow permission is required"
                        )
                    staff = _document(
                        room_ref.collection("staff")
                        .document(principal.uid)
                        .get(transaction=transaction)
                    )
                    if not _valid_room_staff(principal, room, staff) or not staff.get(
                        "permissions", {}
                    ).get(Permission.CAN_EDIT_COURSE_FLOW.value, False):
                        raise AccessDenied(
                            "The canEditCourseFlow permission is required"
                        )
            elif not (
                principal.account_type is AccountType.STAFF
                and course.get("leadInstructorId") == principal.uid
            ):
                raise AccessDenied("Only the assigned lead can change this flow")

            chapter_snapshots = list(transaction.get(chapter_query))
            item_snapshots = list(transaction.get(item_query))
            existing_chapters = {
                snapshot.id: _document(snapshot) or {} for snapshot in chapter_snapshots
            }
            existing_items = {
                snapshot.id: _document(snapshot) or {} for snapshot in item_snapshots
            }
            for existing in existing_items.values():
                if existing.get("courseId") != course_id or existing.get(
                    "orgId"
                ) != course.get("orgId"):
                    raise ResourceConflict("A flow item has an invalid course link")

            item_order = [item["id"] for item in ordered_items]
            progress = normalize_flow_progress(
                item_order,
                {
                    item_id: bool(existing.get("isCompleted"))
                    for item_id, existing in existing_items.items()
                },
                preserve_existing=room is not None,
            )
            normalized_items = [
                {**item, "isCompleted": progress.completion_by_id[item["id"]]}
                for item in ordered_items
            ]
            current_item_id = progress.current_item_id

            now = firestore.SERVER_TIMESTAMP
            submitted_chapter_ids = {chapter["id"] for chapter in chapters}
            submitted_item_ids = set(item_order)
            for snapshot in chapter_snapshots:
                if snapshot.id not in submitted_chapter_ids:
                    transaction.delete(snapshot.reference)
            for snapshot in item_snapshots:
                if snapshot.id not in submitted_item_ids:
                    transaction.delete(snapshot.reference)
            for chapter in chapters:
                existing = existing_chapters.get(chapter["id"], {})
                transaction.set(
                    chapter_collection.document(chapter["id"]),
                    {
                        **chapter,
                        "courseId": course_id,
                        "orgId": course["orgId"],
                        "createdAt": existing.get("createdAt", now),
                        "updatedAt": now,
                        "schemaVersion": SCHEMA_VERSION,
                    },
                )
            for item in normalized_items:
                existing = existing_items.get(item["id"], {})
                transaction.set(
                    item_collection.document(item["id"]),
                    {
                        **item,
                        "courseId": course_id,
                        "orgId": course["orgId"],
                        "createdAt": existing.get("createdAt", now),
                        "updatedAt": now,
                        "schemaVersion": SCHEMA_VERSION,
                    },
                )
            transaction.update(
                course_ref,
                {
                    "updatedBy": principal.uid,
                    "updatedAt": now,
                },
            )
            if room_ref is not None:
                transaction.update(
                    room_ref,
                    {
                        "itemOrder": item_order,
                        "currentItemId": current_item_id,
                        "updatedBy": principal.uid,
                        "updatedAt": now,
                    },
                )
            return normalized_items

        normalized_items = apply_flow(transaction)
        return {
            "courseId": course_id,
            "chapters": chapters,
            "items": normalized_items,
        }

    def update_material(
        self,
        course_id: str,
        material: dict[str, Any],
        principal: Principal,
    ) -> dict[str, Any]:
        course_ref = self.client.collection("courses").document(course_id)
        material_ref = course_ref.collection("materials").document("current")
        transaction = self.client.transaction()

        @firestore.transactional
        def apply_material(transaction: Any) -> None:
            course = _document(course_ref.get(transaction=transaction))
            if course is None:
                raise ResourceNotFound("Course not found")
            if principal.org_id != course.get("orgId"):
                raise AccessDenied("Cross-organization access is not allowed")
            room_id = course.get("activeRoomId")
            if room_id:
                room_ref = self.client.collection("rooms").document(room_id)
                room = _document(room_ref.get(transaction=transaction))
                if room is None:
                    raise ResourceConflict("The active room does not exist")
                assert_room_course_integrity(room, course)
                if room.get("status") == RoomStatus.ENDED.value:
                    raise AccessDenied("An ended room cannot be changed")
                if not is_room_lead(principal, room):
                    if principal.account_type is not AccountType.STAFF:
                        raise AccessDenied(
                            "The canManageMaterials permission is required"
                        )
                    staff = _document(
                        room_ref.collection("staff")
                        .document(principal.uid)
                        .get(transaction=transaction)
                    )
                    if not _valid_room_staff(principal, room, staff) or not staff.get(
                        "permissions", {}
                    ).get(Permission.CAN_MANAGE_MATERIALS.value, False):
                        raise AccessDenied(
                            "The canManageMaterials permission is required"
                        )
            elif not (
                principal.account_type is AccountType.STAFF
                and course.get("leadInstructorId") == principal.uid
            ):
                raise AccessDenied("Only the assigned lead can manage materials")
            existing = _document(material_ref.get(transaction=transaction))
            now = firestore.SERVER_TIMESTAMP
            transaction.set(
                material_ref,
                {
                    "id": "current",
                    "courseId": course_id,
                    "orgId": course["orgId"],
                    **material,
                    "createdAt": existing.get("createdAt", now) if existing else now,
                    "updatedBy": principal.uid,
                    "updatedAt": now,
                    "schemaVersion": SCHEMA_VERSION,
                },
            )
            transaction.update(
                course_ref,
                {"updatedBy": principal.uid, "updatedAt": now},
            )

        apply_material(transaction)
        return _document(material_ref.get()) or {}

    def create_room(
        self,
        course_id: str,
        *,
        join_code: str | None,
        principal: Principal,
    ) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document()
        normalized_code = (join_code or secrets.token_hex(3)).upper()
        course_ref = self.client.collection("courses").document(course_id)
        code_ref = self.client.collection("roomJoinCodes").document(normalized_code)
        item_query = course_ref.collection("items").order_by("order")

        def reserve_room_once() -> dict[str, Any]:
            # Read outside the write transaction, then protect the course update
            # with its exact update time. This avoids two pessimistic transactions
            # both holding read locks and timing out while upgrading to writes.
            course_snapshot = course_ref.get()
            code_snapshot = code_ref.get()
            course = _document(course_snapshot)
            code = _document(code_snapshot)
            item_snapshots = list(item_query.stream())
            if course is None:
                raise ResourceNotFound("Course not found")
            if not (
                principal.account_type is AccountType.STAFF
                and principal.uid == course.get("leadInstructorId")
                and principal.org_id == course.get("orgId")
            ):
                raise AccessDenied("Only the assigned lead can create a room")
            if course.get("activeRoomId"):
                raise ResourceConflict("This course already has an active room")
            if code is not None:
                raise ResourceConflict("The room join code is already in use")

            item_order = [snapshot.id for snapshot in item_snapshots]
            # Let the outer policy reconcile after every ABORTED and create a
            # fresh transaction instead of retrying this transaction in lockstep.
            transaction = self.client.transaction(max_attempts=1)

            @firestore.transactional
            def reserve_room(transaction: Any) -> None:
                now = firestore.SERVER_TIMESTAMP
                transaction.create(
                    room_ref,
                    {
                        "id": room_ref.id,
                        "orgId": course["orgId"],
                        "courseId": course_id,
                        "leadInstructorId": course["leadInstructorId"],
                        "status": RoomStatus.ACTIVE.value,
                        "itemOrder": item_order,
                        "currentItemId": item_order[0] if item_order else None,
                        "createdBy": principal.uid,
                        "createdAt": now,
                        "updatedAt": now,
                        "schemaVersion": SCHEMA_VERSION,
                    },
                )
                transaction.create(
                    code_ref,
                    {
                        "id": normalized_code,
                        "roomId": room_ref.id,
                        "orgId": course["orgId"],
                        "createdAt": now,
                        "updatedAt": now,
                        "schemaVersion": SCHEMA_VERSION,
                    },
                )
                transaction.update(
                    course_ref,
                    {
                        "activeRoomId": room_ref.id,
                        "status": RoomStatus.ACTIVE.value,
                        "updatedBy": principal.uid,
                        "updatedAt": now,
                    },
                    option=LastUpdateOption(course_snapshot.update_time),
                )

            try:
                reserve_room(transaction)
            except (AlreadyExists, FailedPrecondition):
                # Optimistic write preconditions are expected to reject the
                # losing concurrent request. Re-read authoritative documents so
                # a committed current request can recover as 201 and another
                # request's reservation becomes 409 without leaving orphans.
                recovered = self._reconcile_room_creation(
                    course_id=course_id,
                    room_ref=room_ref,
                    course_ref=course_ref,
                    code_ref=code_ref,
                )
                if recovered is not None:
                    return recovered
                raise ResourceConflict(
                    "The course changed while the room was being created"
                ) from None
            created_room = _document(room_ref.get())
            if created_room is None:
                raise ResourceConflict(
                    "The room transaction completed without a room document"
                )
            return created_room

        return run_room_creation_with_retry(
            attempt=reserve_room_once,
            reconcile=lambda: self._reconcile_room_creation(
                course_id=course_id,
                room_ref=room_ref,
                course_ref=course_ref,
                code_ref=code_ref,
            ),
            sleep=self.room_creation_sleep,
            jitter=self.room_creation_jitter,
        )

    def _reconcile_room_creation(
        self,
        *,
        course_id: str,
        room_ref: Any,
        course_ref: Any,
        code_ref: Any,
    ) -> dict[str, Any] | None:
        course, code, requested_room = self._read_room_creation_documents(
            course_ref=course_ref,
            code_ref=code_ref,
            room_ref=room_ref,
        )
        if course is None:
            raise ResourceNotFound("Course not found")

        active_room_id = course.get("activeRoomId")
        code_room_id = code.get("roomId") if code else None
        requested_room_id = room_ref.id
        all_point_to_request = (
            active_room_id == requested_room_id
            and code_room_id == requested_room_id
            and requested_room is not None
        )
        any_point_to_request = (
            active_room_id == requested_room_id
            or code_room_id == requested_room_id
            or requested_room is not None
        )

        if all_point_to_request:
            if (
                requested_room.get("id") != requested_room_id
                or requested_room.get("courseId") != course_id
                or requested_room.get("orgId") != course.get("orgId")
                or requested_room.get("leadInstructorId")
                != course.get("leadInstructorId")
                or code.get("id") != code_ref.id
                or code.get("orgId") != course.get("orgId")
            ):
                raise ResourceConflict("Room creation documents are inconsistent")
            return requested_room

        if any_point_to_request:
            raise ResourceConflict("Room creation documents are inconsistent")

        if active_room_id:
            active_room = _document(
                self.client.collection("rooms").document(active_room_id).get()
            )
            if (
                active_room is None
                or active_room.get("id") != active_room_id
                or active_room.get("courseId") != course_id
                or active_room.get("orgId") != course.get("orgId")
            ):
                raise ResourceConflict(
                    "The active room and course links are inconsistent"
                )
            raise ResourceConflict("This course already has an active room")

        if code_room_id:
            mapped_room = _document(
                self.client.collection("rooms").document(code_room_id).get()
            )
            if (
                mapped_room is None
                or mapped_room.get("id") != code_room_id
                or mapped_room.get("orgId") != code.get("orgId")
            ):
                raise ResourceConflict("The room join-code mapping is inconsistent")
            raise ResourceConflict("The room join code is already in use")

        return None

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
        # A strongly consistent batch-get observes the atomic commit without
        # opening another transaction that can contend with the next attempt.
        snapshots = self.client.get_all([course_ref, code_ref, room_ref])
        documents = {
            snapshot.reference.path: _document(snapshot) for snapshot in snapshots
        }
        return (
            documents.get(course_ref.path),
            documents.get(code_ref.path),
            documents.get(room_ref.path),
        )

    def get_room(self, room_id: str) -> dict[str, Any] | None:
        room = _document(self.client.collection("rooms").document(room_id).get())
        if room is not None:
            room.pop("joinCode", None)
        return room

    def get_room_by_code(self, code: str) -> dict[str, Any] | None:
        mapping = _document(
            self.client.collection("roomJoinCodes").document(code.upper()).get()
        )
        if mapping is None:
            return None
        room = self.get_room(mapping["roomId"])
        if room is None or room.get("orgId") != mapping.get("orgId"):
            raise ResourceConflict("The room join-code mapping is inconsistent")
        return room

    def get_room_join_code(self, room_id: str) -> str:
        query = (
            self.client.collection("roomJoinCodes")
            .where(filter=FieldFilter("roomId", "==", room_id))
            .limit(2)
        )
        mappings = list(query.stream())
        if not mappings:
            raise ResourceNotFound("The room has no join code")
        if len(mappings) != 1:
            raise ResourceConflict("The room has multiple join codes")
        return mappings[0].id

    def update_room_lead(
        self,
        *,
        room_id: str,
        lead_instructor_id: str,
        principal: Principal,
    ) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room_id)
        log_ref = room_ref.collection("permissionLogs").document()
        target_ref = self.client.collection("users").document(lead_instructor_id)
        transaction = self.client.transaction()

        @firestore.transactional
        def apply_lead(transaction: Any) -> None:
            room = _document(room_ref.get(transaction=transaction))
            target = _document(target_ref.get(transaction=transaction))
            if room is None:
                raise ResourceNotFound("Room not found")
            course_ref = self.client.collection("courses").document(room["courseId"])
            course = _document(course_ref.get(transaction=transaction))
            if course is None:
                raise ResourceConflict("The room course does not exist")
            assert_room_course_integrity(room, course)
            if (
                principal.account_type is not AccountType.STAFF
                or principal.organization_role.value != "ADMIN"
                or principal.org_id != room.get("orgId")
            ):
                raise AccessDenied("Only an organization admin can assign a room lead")
            if (
                target is None
                or target.get("orgId") != room.get("orgId")
                or _profile_account_type(target) is not AccountType.STAFF
            ):
                raise AccessDenied(
                    "The selected lead must be staff in this organization"
                )
            now = firestore.SERVER_TIMESTAMP
            transaction.update(
                room_ref,
                {
                    "leadInstructorId": lead_instructor_id,
                    "updatedBy": principal.uid,
                    "updatedAt": now,
                },
            )
            transaction.update(
                course_ref,
                {
                    "leadInstructorId": lead_instructor_id,
                    "updatedBy": principal.uid,
                    "updatedAt": now,
                },
            )
            transaction.create(
                log_ref,
                {
                    "id": log_ref.id,
                    "orgId": room["orgId"],
                    "roomId": room_id,
                    "targetUserId": lead_instructor_id,
                    "changedBy": principal.uid,
                    "beforeLeadInstructorId": room["leadInstructorId"],
                    "afterLeadInstructorId": lead_instructor_id,
                    "changeType": "LEAD_CHANGED",
                    "createdAt": now,
                    "schemaVersion": SCHEMA_VERSION,
                },
            )

        apply_lead(transaction)
        return _document(room_ref.get()) or {}

    def get_staff(self, room_id: str, uid: str) -> dict[str, Any] | None:
        return _document(
            self.client.collection("rooms")
            .document(room_id)
            .collection("staff")
            .document(uid)
            .get()
        )

    def list_staff(self, room_id: str) -> list[dict[str, Any]]:
        collection = (
            self.client.collection("rooms").document(room_id).collection("staff")
        )
        return [
            document for item in collection.stream() if (document := _document(item))
        ]

    def get_participant(self, room_id: str, uid: str) -> dict[str, Any] | None:
        return _document(
            self.client.collection("rooms")
            .document(room_id)
            .collection("participants")
            .document(uid)
            .get()
        )

    def upsert_staff(
        self,
        *,
        room_id: str,
        target_uid: str,
        permissions: dict[str, bool],
        principal: Principal,
        change_type: str,
    ) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room_id)
        target_ref = self.client.collection("users").document(target_uid)
        staff_ref = room_ref.collection("staff").document(target_uid)
        normalized = (
            default_assistant_permissions()
            if change_type == "ADDED"
            else normalize_permissions(permissions)
        )
        log_ref = room_ref.collection("permissionLogs").document()
        transaction = self.client.transaction()

        @firestore.transactional
        def apply_staff(transaction: Any) -> None:
            room = _document(room_ref.get(transaction=transaction))
            target = _document(target_ref.get(transaction=transaction))
            before = _document(staff_ref.get(transaction=transaction))
            if room is None:
                raise ResourceNotFound("Room not found")
            course_ref = self.client.collection("courses").document(room["courseId"])
            course = _document(course_ref.get(transaction=transaction))
            if course is None:
                raise ResourceConflict("The room course does not exist")
            assert_room_course_integrity(room, course)
            _require_room_lead(principal, room)
            _require_active_room(room)
            if (
                target is None
                or target.get("orgId") != room.get("orgId")
                or _profile_account_type(target) is not AccountType.STAFF
            ):
                raise AccessDenied(
                    "The selected assistant must belong to this organization"
                )
            if change_type == "ADDED" and before is not None:
                raise ResourceConflict("The assistant is already assigned to this room")
            if change_type != "ADDED" and before is None:
                raise ResourceNotFound("The assistant is not assigned to this room")
            now = firestore.SERVER_TIMESTAMP
            transaction.set(
                staff_ref,
                {
                    "userId": target_uid,
                    "roomId": room_id,
                    "orgId": room["orgId"],
                    "permissions": normalized,
                    "grantedBy": (
                        before.get("grantedBy", principal.uid)
                        if before
                        else principal.uid
                    ),
                    "grantedAt": (before.get("grantedAt", now) if before else now),
                    "updatedBy": principal.uid,
                    "updatedAt": now,
                    "schemaVersion": SCHEMA_VERSION,
                },
            )
            transaction.create(
                log_ref,
                {
                    "id": log_ref.id,
                    "orgId": room["orgId"],
                    "roomId": room_id,
                    "targetUserId": target_uid,
                    "changedBy": principal.uid,
                    "beforePermissions": (
                        before.get("permissions", empty_permissions())
                        if before
                        else empty_permissions()
                    ),
                    "afterPermissions": normalized,
                    "changeType": change_type,
                    "createdAt": now,
                    "schemaVersion": SCHEMA_VERSION,
                },
            )

        apply_staff(transaction)
        return _document(staff_ref.get()) or {}

    def remove_staff(self, *, room_id: str, uid: str, principal: Principal) -> None:
        room_ref = self.client.collection("rooms").document(room_id)
        staff_ref = room_ref.collection("staff").document(uid)
        log_ref = room_ref.collection("permissionLogs").document()
        transaction = self.client.transaction()

        @firestore.transactional
        def apply_remove(transaction: Any) -> None:
            room = _document(room_ref.get(transaction=transaction))
            before = _document(staff_ref.get(transaction=transaction))
            if room is None:
                raise ResourceNotFound("Room not found")
            course_ref = self.client.collection("courses").document(room["courseId"])
            course = _document(course_ref.get(transaction=transaction))
            if course is None:
                raise ResourceConflict("The room course does not exist")
            assert_room_course_integrity(room, course)
            _require_room_lead(principal, room)
            _require_active_room(room)
            if before is None:
                raise ResourceNotFound("The assistant is not assigned to this room")
            now = firestore.SERVER_TIMESTAMP
            transaction.delete(staff_ref)
            transaction.create(
                log_ref,
                {
                    "id": log_ref.id,
                    "orgId": room["orgId"],
                    "roomId": room_id,
                    "targetUserId": uid,
                    "changedBy": principal.uid,
                    "beforePermissions": before.get("permissions", empty_permissions()),
                    "afterPermissions": empty_permissions(),
                    "changeType": "REMOVED",
                    "createdAt": now,
                    "schemaVersion": SCHEMA_VERSION,
                },
            )

        apply_remove(transaction)

    def join_room(
        self, *, principal: Principal, room_code: str, nickname: str
    ) -> dict[str, Any]:
        normalized_code = room_code.upper()
        code_ref = self.client.collection("roomJoinCodes").document(normalized_code)
        user_ref = self.client.collection("users").document(principal.uid)
        transaction = self.client.transaction()
        result: dict[str, Any] = {}

        @firestore.transactional
        def apply_join(transaction: Any) -> None:
            mapping = _document(code_ref.get(transaction=transaction))
            if mapping is None:
                raise ResourceNotFound("No active room matches this join code")
            room_ref = self.client.collection("rooms").document(mapping["roomId"])
            room = _document(room_ref.get(transaction=transaction))
            if room is None:
                raise ResourceConflict("The join code points to a missing room")
            course_ref = self.client.collection("courses").document(room["courseId"])
            course = _document(course_ref.get(transaction=transaction))
            existing_user = _document(user_ref.get(transaction=transaction))
            participant_ref = room_ref.collection("participants").document(
                principal.uid
            )
            existing_participant = _document(
                participant_ref.get(transaction=transaction)
            )
            if course is None:
                raise ResourceConflict("The room course does not exist")
            if mapping.get("orgId") != room.get("orgId"):
                raise ResourceConflict("The join-code organization is inconsistent")
            assert_room_course_integrity(room, course)
            _require_active_room(room)
            if (
                principal.account_type is not AccountType.STUDENT
                or not principal.is_anonymous
            ):
                raise AccessDenied("Room join is limited to anonymous students")
            if principal.org_id not in {None, room.get("orgId")}:
                raise AccessDenied("Cross-organization room join is not allowed")
            if existing_user and (
                _profile_account_type(existing_user) is not AccountType.STUDENT
                or existing_user.get("orgId") != room.get("orgId")
            ):
                raise AccessDenied("The existing profile belongs to another context")
            if existing_participant and (
                existing_participant.get("orgId") != room.get("orgId")
                or existing_participant.get("roomId") != room.get("id")
            ):
                raise ResourceConflict("The participant link is inconsistent")
            now = firestore.SERVER_TIMESTAMP
            participant_id = (existing_participant or {}).get(
                "participantId"
            ) or secrets.token_urlsafe(12)
            participant = {
                # Internal authorization link. API serializers never expose it.
                "userId": principal.uid,
                "participantId": participant_id,
                "orgId": room["orgId"],
                "roomId": room["id"],
                "accountType": AccountType.STUDENT.value,
                "nickname": nickname,
                "status": "ACTIVE",
                "isQuestionRestricted": bool(
                    (existing_participant or {}).get("isQuestionRestricted", False)
                ),
                "joinedAt": (
                    existing_participant.get("joinedAt", now)
                    if existing_participant
                    else now
                ),
                "updatedAt": now,
                "schemaVersion": SCHEMA_VERSION,
            }
            user = {
                "uid": principal.uid,
                "orgId": room["orgId"],
                "accountType": AccountType.STUDENT.value,
                "displayName": nickname,
                "email": None,
                "isAnonymous": True,
                "createdAt": (
                    existing_user.get("createdAt", now) if existing_user else now
                ),
                "updatedAt": now,
                "schemaVersion": SCHEMA_VERSION,
            }
            transaction.set(participant_ref, participant)
            transaction.set(user_ref, user)
            result.update({"roomId": room["id"], "participantRef": participant_ref})

        apply_join(transaction)
        room = self.get_room(result["roomId"])
        participant = _document(result["participantRef"].get())
        participant_id = (participant or {}).get(
            "participantId"
        ) or _legacy_participant_id(result["roomId"], principal.uid)
        return {
            "room": room,
            "participant": _safe_participant(
                participant or {}, participant_id=participant_id
            ),
        }

    def update_nickname(
        self, *, principal: Principal, room_id: str, nickname: str
    ) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room_id)
        participant_ref = room_ref.collection("participants").document(principal.uid)
        user_ref = self.client.collection("users").document(principal.uid)
        transaction = self.client.transaction()

        @firestore.transactional
        def apply_nickname(transaction: Any) -> None:
            room = _document(room_ref.get(transaction=transaction))
            participant = _document(participant_ref.get(transaction=transaction))
            user = _document(user_ref.get(transaction=transaction))
            if room is None:
                raise ResourceNotFound("Room not found")
            course_ref = self.client.collection("courses").document(room["courseId"])
            course = _document(course_ref.get(transaction=transaction))
            if course is None:
                raise ResourceConflict("The room course does not exist")
            assert_room_course_integrity(room, course)
            _require_active_room(room)
            if (
                principal.account_type is not AccountType.STUDENT
                or principal.org_id != room.get("orgId")
                or participant is None
                or participant.get("orgId") != room.get("orgId")
                or participant.get("roomId") != room_id
                or user is None
                or _profile_account_type(user) is not AccountType.STUDENT
                or user.get("orgId") != room.get("orgId")
            ):
                raise AccessDenied(
                    "Only an active participant can change this nickname"
                )
            now = firestore.SERVER_TIMESTAMP
            transaction.update(
                participant_ref, {"nickname": nickname, "updatedAt": now}
            )
            transaction.update(user_ref, {"displayName": nickname, "updatedAt": now})

        apply_nickname(transaction)
        participant = _document(participant_ref.get()) or {}
        participant_id = participant.get("participantId") or _legacy_participant_id(
            room_id, principal.uid
        )
        return _safe_participant(participant, participant_id=participant_id)

    def get_course_flow(self, course_id: str) -> dict[str, list[dict[str, Any]]]:
        reference = self.client.collection("courses").document(course_id)
        chapters = [
            document
            for item in reference.collection("chapters").order_by("order").stream()
            if (document := _document(item))
        ]
        items = [
            document
            for item in reference.collection("items").order_by("order").stream()
            if (document := _document(item))
        ]
        return {"chapters": chapters, "items": items}

    def update_completion(
        self,
        *,
        room_id: str,
        item_id: str,
        is_completed: bool,
        principal: Principal,
    ) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room_id)
        transaction = self.client.transaction()

        @firestore.transactional
        def apply_completion(transaction: Any) -> dict[str, Any]:
            room_snapshot = room_ref.get(transaction=transaction)
            room = _document(room_snapshot)
            if room is None:
                raise ResourceNotFound("Room not found")
            course_ref = self.client.collection("courses").document(room["courseId"])
            course = _document(course_ref.get(transaction=transaction))
            if course is None:
                raise ResourceConflict("The room course does not exist")
            assert_room_course_integrity(room, course)
            if room.get("status") != RoomStatus.ACTIVE.value:
                raise InvalidOperation("Checklist changes require an active room")
            if principal.org_id != room.get("orgId"):
                raise AccessDenied("Checklist access belongs to another organization")
            if not is_room_lead(principal, room):
                if principal.account_type is not AccountType.STAFF:
                    raise AccessDenied("Checklist progress permission is required")
                staff_ref = room_ref.collection("staff").document(principal.uid)
                staff = _document(staff_ref.get(transaction=transaction))
                if not _valid_room_staff(principal, room, staff) or not staff.get(
                    "permissions", {}
                ).get(Permission.CAN_CONTROL_PROGRESS.value, False):
                    raise AccessDenied("Checklist progress permission is required")
            item_order = list(room.get("itemOrder", []))
            if len(item_order) != len(set(item_order)):
                raise ResourceConflict("The room checklist order contains duplicates")
            if item_id not in item_order:
                raise ResourceNotFound("Checklist item not found")
            item_refs = [
                course_ref.collection("items").document(item) for item in item_order
            ]
            item_snapshots = [
                reference.get(transaction=transaction) for reference in item_refs
            ]
            item_values = [_document(snapshot) for snapshot in item_snapshots]
            if any(value is None for value in item_values):
                raise ResourceNotFound("Checklist flow is incomplete")
            if any(
                value.get("courseId") != course["id"]
                or value.get("orgId") != course["orgId"]
                for value in item_values
                if value is not None
            ):
                raise ResourceConflict("A checklist item has an invalid course link")
            completion_by_id = {
                ordered_id: bool((item_values[position] or {}).get("isCompleted"))
                for position, ordered_id in enumerate(item_order)
            }
            transition = calculate_completion_transition(
                item_order=item_order,
                completion_by_id=completion_by_id,
                current_item_id=room.get("currentItemId"),
                target_item_id=item_id,
                is_completed=is_completed,
            )
            now = firestore.SERVER_TIMESTAMP
            if is_completed:
                index = item_order.index(item_id)
                transaction.update(
                    item_refs[index],
                    {
                        "isCompleted": True,
                        "updatedBy": principal.uid,
                        "updatedAt": now,
                    },
                )
            else:
                for changed_id in transition.changed_item_ids:
                    transaction.update(
                        item_refs[item_order.index(changed_id)],
                        {
                            "isCompleted": False,
                            "updatedBy": principal.uid,
                            "updatedAt": now,
                        },
                    )
            transaction.update(
                room_ref,
                {
                    "currentItemId": transition.current_item_id,
                    "updatedBy": principal.uid,
                    "updatedAt": now,
                },
            )
            return {
                "roomId": room_id,
                "itemId": item_id,
                "isCompleted": is_completed,
                "currentItemId": transition.current_item_id,
                "changedItemIds": list(transition.changed_item_ids),
            }

        return apply_completion(transaction)

    def _transaction_room_access(
        self,
        transaction: Any,
        *,
        room_ref: Any,
        principal: Principal,
        permission: Permission | None,
        require_active: bool,
        allow_org_admin: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
        room = _document(room_ref.get(transaction=transaction))
        if room is None:
            raise ResourceNotFound("Room not found")
        course_ref = self.client.collection("courses").document(room["courseId"])
        course = _document(course_ref.get(transaction=transaction))
        staff_ref = room_ref.collection("staff").document(principal.uid)
        staff = _document(staff_ref.get(transaction=transaction))
        if course is None:
            raise ResourceConflict("The room course does not exist")
        assert_room_course_integrity(room, course)
        if principal.org_id != room.get("orgId"):
            raise AccessDenied("Cross-organization access is not allowed")
        valid_staff = staff if _valid_room_staff(principal, room, staff) else None
        if require_active and room.get("status") != RoomStatus.ACTIVE.value:
            raise AccessDenied("An ending or ended room is read-only")
        if (
            allow_org_admin
            and principal.account_type is AccountType.STAFF
            and principal.organization_role.value == "ADMIN"
        ):
            return room, course, valid_staff
        if permission is None:
            if is_room_lead(principal, room):
                return room, course, valid_staff
            if valid_staff:
                return room, course, valid_staff
            raise AccessDenied("Only assigned room staff can perform this action")
        if not (
            is_room_lead(principal, room)
            or (
                valid_staff is not None
                and valid_staff.get("permissions", {}).get(permission.value) is True
            )
        ):
            raise AccessDenied(f"The {permission.value} room permission is required")
        return room, course, valid_staff

    def create_question(
        self,
        *,
        room_id: str,
        principal: Principal,
        item_id: str | None,
        client_request_id: str,
        moderation: ModerationDecision,
    ) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room_id)
        question_id = deterministic_question_id(
            room_id=room_id,
            participant_uid=principal.uid,
            client_request_id=client_request_id,
        )
        question_ref = room_ref.collection("questions").document(question_id)
        author_ref = room_ref.collection("questionAuthors").document(question_id)
        rate_ref = room_ref.collection("questionRateLimits").document(principal.uid)

        def attempt() -> dict[str, Any]:
            # Read outside the transaction, then commit only conditional writes.
            # This avoids the symmetric read-lock -> write-lock upgrade that caused
            # the 01-2A room-creation lock timeout under concurrent requests.
            room_snapshot = room_ref.get()
            room = _document(room_snapshot)
            if room is None:
                raise ResourceNotFound("Room not found")
            course_ref = self.client.collection("courses").document(room["courseId"])
            course = _document(course_ref.get())
            participant_ref = room_ref.collection("participants").document(
                principal.uid
            )
            participant_snapshot = participant_ref.get()
            participant = _document(participant_snapshot)
            creation_snapshots = {
                snapshot.reference.path: snapshot
                for snapshot in self.client.get_all(
                    [question_ref, author_ref, rate_ref]
                )
            }
            question_snapshot = creation_snapshots[question_ref.path]
            author_snapshot = creation_snapshots[author_ref.path]
            rate_snapshot = creation_snapshots[rate_ref.path]
            existing_question = _document(question_snapshot)
            existing_author = _document(author_snapshot)
            rate_limit = _document(rate_snapshot)
            material_ref = course_ref.collection("materials").document("current")
            material = _document(material_ref.get())
            chapters = [
                document
                for snapshot in course_ref.collection("chapters").stream()
                if (document := _document(snapshot)) is not None
            ]
            items = [
                document
                for snapshot in course_ref.collection("items").stream()
                if (document := _document(snapshot)) is not None
            ]
            item_numbers = calculate_item_numbers(chapters, items)
            item: dict[str, Any] | None = None
            chapter: dict[str, Any] | None = None
            if item_id is not None:
                item_ref = course_ref.collection("items").document(item_id)
                item = _document(item_ref.get())
                if item is not None:
                    chapter_ref = course_ref.collection("chapters").document(
                        item.get("chapterId", "")
                    )
                    chapter = _document(chapter_ref.get())
            transaction = self.client.transaction(max_attempts=1)

            @firestore.transactional
            def apply_question(transaction: Any) -> dict[str, Any]:
                if course is None:
                    raise ResourceConflict("The room course does not exist")
                assert_room_course_integrity(room, course)
                if principal.org_id != room.get("orgId"):
                    raise AccessDenied("Cross-organization access is not allowed")
                if existing_question is not None or existing_author is not None:
                    if (
                        existing_question is not None
                        and existing_author is not None
                        and existing_author.get("participantUid") == principal.uid
                        and existing_author.get("clientRequestId") == client_request_id
                        and existing_author.get("contentDigest")
                        == moderation.normalized_digest
                    ):
                        return question_creation_response(existing_question)
                    raise ResourceConflict(
                        "The idempotent question documents are inconsistent"
                    )
                if room.get("status") != RoomStatus.ACTIVE.value:
                    raise AccessDenied(
                        "종료된 강의에서는 새 질문을 작성할 수 없습니다."
                    )
                if (
                    principal.account_type is not AccountType.STUDENT
                    or not principal.is_anonymous
                    or participant is None
                    or participant.get("roomId") != room_id
                    or participant.get("orgId") != room.get("orgId")
                ):
                    raise AccessDenied(
                        "강의에 참여한 수강생만 질문을 작성할 수 있습니다."
                    )
                if participant.get("isQuestionRestricted") is True:
                    raise AccessDenied(
                        "현재 이 강의에서는 새 질문을 작성할 수 없습니다."
                    )
                if item_id is not None and (
                    item_id not in room.get("itemOrder", [])
                    or item_id not in item_numbers
                    or item is None
                    or chapter is None
                    or item.get("courseId") != course.get("id")
                    or item.get("orgId") != room.get("orgId")
                    or chapter.get("courseId") != course.get("id")
                    or chapter.get("orgId") != room.get("orgId")
                ):
                    raise ResourceNotFound(
                        "질문에 연결할 수업 항목을 찾을 수 없습니다."
                    )

                now = self.server_clock()
                repeat_cutoff = now - timedelta(seconds=QUESTION_REPEAT_WINDOW_SECONDS)
                rate_cutoff = now - timedelta(seconds=QUESTION_RATE_WINDOW_SECONDS)
                recent_entries = [
                    entry
                    for entry in (rate_limit or {}).get("recent", [])
                    if isinstance(entry.get("createdAt"), datetime)
                    and entry["createdAt"] >= repeat_cutoff
                ]
                if (
                    sum(entry["createdAt"] >= rate_cutoff for entry in recent_entries)
                    >= QUESTION_RATE_MAX_COUNT
                ):
                    raise QuestionRateLimited(
                        "질문을 너무 빠르게 보내고 있습니다. "
                        "잠시 후 다시 시도해 주세요."
                    )
                if any(
                    entry.get("normalizedDigest") == moderation.normalized_digest
                    or fingerprints_are_similar(
                        list(entry.get("fingerprint", [])), moderation.fingerprint
                    )
                    for entry in recent_entries
                ):
                    raise QuestionRateLimited(
                        "비슷한 질문이 최근에 전송되었습니다. "
                        "잠시 후 다시 시도해 주세요."
                    )

                question = {
                    "id": question_id,
                    "roomId": room_id,
                    "courseId": course["id"],
                    "orgId": room["orgId"],
                    "content": moderation.content,
                    "nicknameSnapshot": participant.get("nickname", "익명 수강생"),
                    "isGeneral": item_id is None,
                    **(
                        {
                            "itemId": item_id,
                            "itemNumberSnapshot": item_numbers[item_id],
                            "itemTitleSnapshot": item.get("title"),
                            "chapterTitleSnapshot": chapter.get("title"),
                            "materialLabelSnapshot": item.get("materialLabel")
                            or (material or {}).get("fileName"),
                        }
                        if item_id is not None and item and chapter
                        else {}
                    ),
                    "visibility": moderation.visibility,
                    "moderationStatus": moderation.moderation_status,
                    "isAnswered": False,
                    "answer": None,
                    "isHidden": False,
                    "createdAt": now,
                    "updatedAt": now,
                    "schemaVersion": SCHEMA_VERSION,
                }
                author = {
                    "id": question_id,
                    "roomId": room_id,
                    "orgId": room["orgId"],
                    "participantUid": principal.uid,
                    "clientRequestId": client_request_id,
                    "contentDigest": moderation.normalized_digest,
                    "createdAt": now,
                    "schemaVersion": SCHEMA_VERSION,
                }
                recent_entries.append(
                    {
                        "questionId": question_id,
                        "createdAt": now,
                        "normalizedDigest": moderation.normalized_digest,
                        "fingerprint": list(moderation.fingerprint),
                    }
                )
                transaction.create(question_ref, question)
                transaction.create(author_ref, author)
                rate_value = {
                    "roomId": room_id,
                    "orgId": room["orgId"],
                    "participantUid": principal.uid,
                    "recent": recent_entries,
                    "updatedAt": now,
                    "schemaVersion": SCHEMA_VERSION,
                }
                if rate_snapshot.exists:
                    transaction.update(
                        rate_ref,
                        rate_value,
                        option=LastUpdateOption(rate_snapshot.update_time),
                    )
                else:
                    transaction.create(rate_ref, rate_value)
                transaction.update(
                    room_ref,
                    {"lastQuestionAt": now},
                    option=LastUpdateOption(room_snapshot.update_time),
                )
                transaction.update(
                    participant_ref,
                    {"lastQuestionAt": now},
                    option=LastUpdateOption(participant_snapshot.update_time),
                )
                return question_creation_response(question)

            try:
                return apply_question(transaction)
            except (AlreadyExists, FailedPrecondition) as error:
                recovered = reconcile()
                if recovered is not None:
                    return recovered
                raise Aborted(
                    "Optimistic question creation precondition changed"
                ) from error

        def reconcile() -> dict[str, Any] | None:
            documents = {
                snapshot.reference.path: _document(snapshot)
                for snapshot in self.client.get_all(
                    [question_ref, author_ref, rate_ref]
                )
            }
            question = documents.get(question_ref.path)
            author = documents.get(author_ref.path)
            rate_limit = documents.get(rate_ref.path)
            rate_has_question = any(
                entry.get("questionId") == question_id
                and entry.get("normalizedDigest") == moderation.normalized_digest
                for entry in (rate_limit or {}).get("recent", [])
            )
            if question is None and author is None and not rate_has_question:
                return None
            if (
                question is not None
                and author is not None
                and author.get("participantUid") == principal.uid
                and author.get("clientRequestId") == client_request_id
                and author.get("contentDigest") == moderation.normalized_digest
            ):
                return question_creation_response(question)
            raise ResourceConflict("The idempotent question documents are inconsistent")

        return run_room_creation_with_retry(
            attempt=attempt,
            reconcile=reconcile,
            sleep=self.room_creation_sleep,
            jitter=self.room_creation_jitter,
        )

    def answer_question(
        self,
        *,
        room_id: str,
        question_id: str,
        answer: str,
        principal: Principal,
    ) -> dict[str, Any]:
        return self._update_question_with_audit(
            room_id=room_id,
            question_id=question_id,
            principal=principal,
            permission=Permission.CAN_ANSWER_QUESTIONS,
            action="ANSWER_UPSERTED",
            transform=lambda question, now, room, _staff: {
                "isAnswered": True,
                "answer": {
                    "content": answer,
                    "staffDisplayName": principal.display_name or "강사",
                    "roomRole": (
                        RoomRole.LEAD.value
                        if is_room_lead(principal, room)
                        else RoomRole.ASSISTANT.value
                    ),
                    "answeredAt": now,
                },
            },
        )

    def cancel_question_answer(
        self, *, room_id: str, question_id: str, principal: Principal
    ) -> dict[str, Any]:
        return self._update_question_with_audit(
            room_id=room_id,
            question_id=question_id,
            principal=principal,
            permission=Permission.CAN_ANSWER_QUESTIONS,
            action="ANSWER_CANCELLED",
            transform=lambda _question, _now, _room, _staff: {
                "isAnswered": False,
                "answer": None,
            },
        )

    def moderate_question(
        self,
        *,
        room_id: str,
        question_id: str,
        action: str,
        principal: Principal,
    ) -> dict[str, Any]:
        transforms: dict[
            str,
            Callable[
                [dict[str, Any], datetime, dict[str, Any], dict[str, Any] | None],
                dict[str, Any],
            ],
        ] = {
            "HIDE": lambda _question, _now, _room, _staff: {"isHidden": True},
            "RESTORE": lambda _question, _now, _room, _staff: {"isHidden": False},
            "APPROVE": lambda _question, _now, _room, _staff: {
                "moderationStatus": "APPROVED",
                "visibility": "PUBLIC",
            },
        }
        if action not in transforms:
            raise InvalidOperation("Unknown question moderation action")
        return self._update_question_with_audit(
            room_id=room_id,
            question_id=question_id,
            principal=principal,
            permission=Permission.CAN_MODERATE_QUESTIONS,
            action=f"QUESTION_{action}D" if action != "HIDE" else "QUESTION_HIDDEN",
            transform=transforms[action],
        )

    def _update_question_with_audit(
        self,
        *,
        room_id: str,
        question_id: str,
        principal: Principal,
        permission: Permission,
        action: str,
        transform: Callable[
            [dict[str, Any], datetime, dict[str, Any], dict[str, Any] | None],
            dict[str, Any],
        ],
    ) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room_id)
        question_ref = room_ref.collection("questions").document(question_id)

        def attempt() -> dict[str, Any]:
            log_ref = room_ref.collection("moderationLogs").document()
            transaction = self.client.transaction(max_attempts=1)

            @firestore.transactional
            def apply_update(transaction: Any) -> dict[str, Any]:
                room, _, staff = self._transaction_room_access(
                    transaction,
                    room_ref=room_ref,
                    principal=principal,
                    permission=permission,
                    require_active=True,
                )
                question = _document(question_ref.get(transaction=transaction))
                if question is None:
                    raise ResourceNotFound("Question not found")
                if (
                    question.get("roomId") != room_id
                    or question.get("courseId") != room.get("courseId")
                    or question.get("orgId") != room.get("orgId")
                ):
                    raise ResourceConflict("The question room link is inconsistent")
                now = self.server_clock()
                changes = {
                    **transform(question, now, room, staff),
                    "updatedAt": now,
                }
                before = {
                    "isAnswered": bool(question.get("isAnswered")),
                    "isHidden": bool(question.get("isHidden")),
                    "moderationStatus": question.get("moderationStatus"),
                    "visibility": question.get("visibility"),
                }
                after_document = {**question, **changes}
                after = {
                    "isAnswered": bool(after_document.get("isAnswered")),
                    "isHidden": bool(after_document.get("isHidden")),
                    "moderationStatus": after_document.get("moderationStatus"),
                    "visibility": after_document.get("visibility"),
                }
                transaction.update(question_ref, changes)
                audit_action = action
                if action == "ANSWER_UPSERTED":
                    audit_action = (
                        "ANSWER_UPDATED" if before["isAnswered"] else "ANSWER_CREATED"
                    )
                transaction.create(
                    log_ref,
                    {
                        "id": log_ref.id,
                        "roomId": room_id,
                        "orgId": room["orgId"],
                        "action": audit_action,
                        "targetId": question_id,
                        "actorUid": principal.uid,
                        "before": before,
                        "after": after,
                        "createdAt": now,
                        "schemaVersion": SCHEMA_VERSION,
                    },
                )
                return public_question(after_document)

            return apply_update(transaction)

        return run_room_creation_with_retry(
            attempt=attempt,
            reconcile=lambda: None,
            sleep=self.room_creation_sleep,
            jitter=self.room_creation_jitter,
        )

    def mark_questions_read(
        self,
        *,
        room_id: str,
        context_id: str,
        observed_at: datetime,
        observed_question_id: str,
        principal: Principal,
    ) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room_id)
        read_ref = room_ref.collection("questionReads").document(principal.uid)
        context_ref = read_ref.collection("contexts").document(context_id)
        question_ref = room_ref.collection("questions").document(observed_question_id)

        def attempt() -> dict[str, Any]:
            transaction = self.client.transaction(max_attempts=1)

            @firestore.transactional
            def apply_read(transaction: Any) -> dict[str, Any]:
                room, _, staff = self._transaction_room_access(
                    transaction,
                    room_ref=room_ref,
                    principal=principal,
                    permission=None,
                    require_active=False,
                )
                question = _document(question_ref.get(transaction=transaction))
                existing_context = _document(context_ref.get(transaction=transaction))
                if question is None:
                    raise ResourceNotFound("Observed question not found")
                if (
                    question.get("roomId") != room_id
                    or question.get("courseId") != room.get("courseId")
                    or question.get("orgId") != room.get("orgId")
                ):
                    raise ResourceConflict("The question room link is inconsistent")
                question_context = (
                    "GENERAL"
                    if question.get("isGeneral") or not question.get("itemId")
                    else question["itemId"]
                )
                if context_id != "ALL" and context_id != question_context:
                    raise InvalidOperation(
                        "The observed question does not belong to this context"
                    )
                can_moderate = is_room_lead(principal, room) or bool(
                    (staff or {})
                    .get("permissions", {})
                    .get(Permission.CAN_MODERATE_QUESTIONS.value, False)
                )
                if (
                    question.get("visibility") != "PUBLIC"
                    or question.get("isHidden") is True
                ) and not can_moderate:
                    raise AccessDenied(
                        "The observed question is not visible to this instructor"
                    )
                created_at = question.get("createdAt")
                if not isinstance(created_at, datetime):
                    raise ResourceConflict("The question creation time is invalid")
                observed_key = (
                    int(observed_at.timestamp() * 1000),
                    observed_question_id,
                )
                question_key = (
                    int(created_at.timestamp() * 1000),
                    observed_question_id,
                )
                if observed_key != question_key:
                    raise InvalidOperation(
                        "The observed question watermark does not match the question"
                    )
                existing_at = (existing_context or {}).get("lastReadAt")
                existing_id = str(
                    (existing_context or {}).get("lastReadQuestionId") or ""
                )
                existing_key = (
                    (
                        int(existing_at.timestamp() * 1000),
                        existing_id,
                    )
                    if isinstance(existing_at, datetime)
                    else (-1, "")
                )
                if existing_key > question_key:
                    watermark_at = existing_at
                    watermark_id = existing_id
                else:
                    watermark_at = created_at
                    watermark_id = observed_question_id
                value = {
                    "contextId": context_id,
                    "roomId": room_id,
                    "orgId": room["orgId"],
                    "lastReadAt": watermark_at,
                    "lastReadQuestionId": watermark_id,
                    "schemaVersion": SCHEMA_VERSION,
                }
                transaction.set(
                    read_ref,
                    {
                        "roomId": room_id,
                        "orgId": room["orgId"],
                        "schemaVersion": SCHEMA_VERSION,
                    },
                    merge=True,
                )
                transaction.set(context_ref, value)
                return {
                    "contextId": context_id,
                    "lastReadAt": watermark_at,
                    "lastReadQuestionId": watermark_id,
                }

            return apply_read(transaction)

        return run_room_creation_with_retry(
            attempt=attempt,
            reconcile=lambda: None,
            sleep=self.room_creation_sleep,
            jitter=self.room_creation_jitter,
        )

    def list_participants(self, room_id: str) -> list[dict[str, Any]]:
        participants = []
        for snapshot in (
            self.client.collection("rooms")
            .document(room_id)
            .collection("participants")
            .stream()
        ):
            document = _document(snapshot)
            if document is None:
                continue
            participant_id = document.get("participantId") or _legacy_participant_id(
                room_id, snapshot.id
            )
            participants.append(
                _safe_participant(document, participant_id=participant_id)
            )
        participants.sort(
            key=lambda item: (str(item.get("joinedAt")), item["nickname"])
        )
        return participants

    def update_participant_restriction(
        self,
        *,
        room_id: str,
        participant_id: str,
        is_question_restricted: bool,
        principal: Principal,
    ) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room_id)
        participant_snapshots = list(
            room_ref.collection("participants")
            .where(filter=FieldFilter("participantId", "==", participant_id))
            .limit(2)
            .stream()
        )
        if not participant_snapshots and participant_id.startswith("legacy-"):
            participant_snapshots = [
                snapshot
                for snapshot in room_ref.collection("participants").stream()
                if _legacy_participant_id(room_id, snapshot.id) == participant_id
            ]
        if not participant_snapshots:
            raise ResourceNotFound("Participant not found")
        if len(participant_snapshots) != 1:
            raise ResourceConflict("The participant management id is not unique")
        participant_ref = participant_snapshots[0].reference

        def attempt() -> dict[str, Any]:
            log_ref = room_ref.collection("moderationLogs").document()
            transaction = self.client.transaction(max_attempts=1)

            @firestore.transactional
            def apply_restriction(transaction: Any) -> dict[str, Any]:
                room, _, _ = self._transaction_room_access(
                    transaction,
                    room_ref=room_ref,
                    principal=principal,
                    permission=Permission.CAN_MANAGE_PARTICIPANTS,
                    require_active=True,
                )
                participant = _document(participant_ref.get(transaction=transaction))
                if participant is None:
                    raise ResourceNotFound("Participant not found")
                if participant.get("roomId") != room_id or participant.get(
                    "orgId"
                ) != room.get("orgId"):
                    raise ResourceConflict("The participant link is inconsistent")
                now = self.server_clock()
                before = bool(participant.get("isQuestionRestricted", False))
                changes = {
                    "isQuestionRestricted": is_question_restricted,
                    "updatedAt": now,
                }
                transaction.update(participant_ref, changes)
                transaction.create(
                    log_ref,
                    {
                        "id": log_ref.id,
                        "roomId": room_id,
                        "orgId": room["orgId"],
                        "action": (
                            "PARTICIPANT_QUESTION_RESTRICTED"
                            if is_question_restricted
                            else "PARTICIPANT_QUESTION_RESTORED"
                        ),
                        "targetId": participant_id,
                        "actorUid": principal.uid,
                        "before": {"isQuestionRestricted": before},
                        "after": {"isQuestionRestricted": is_question_restricted},
                        "createdAt": now,
                        "schemaVersion": SCHEMA_VERSION,
                    },
                )
                return _safe_participant(
                    {**participant, **changes}, participant_id=participant_id
                )

            return apply_restriction(transaction)

        return run_room_creation_with_retry(
            attempt=attempt,
            reconcile=lambda: None,
            sleep=self.room_creation_sleep,
            jitter=self.room_creation_jitter,
        )

    def get_room_summary(self, room_id: str) -> dict[str, Any] | None:
        return _document(
            self.client.collection("rooms")
            .document(room_id)
            .collection("summary")
            .document("current")
            .get()
        )

    def _collect_room_statistics(self, room: dict[str, Any]) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room["id"])
        course_ref = self.client.collection("courses").document(room["courseId"])
        course = _document(course_ref.get()) or {}
        questions = [
            document
            for snapshot in room_ref.collection("questions").stream()
            if (document := _document(snapshot)) is not None
        ]
        participant_count = sum(1 for _ in room_ref.collection("participants").stream())
        items_by_id = {
            snapshot.id: document
            for snapshot in course_ref.collection("items").stream()
            if (document := _document(snapshot)) is not None
        }
        chapters = [
            document
            for snapshot in course_ref.collection("chapters").stream()
            if (document := _document(snapshot)) is not None
        ]
        item_numbers = calculate_item_numbers(chapters, list(items_by_id.values()))
        item_question_counts = [
            {
                "itemId": item_id,
                "itemNumber": item_numbers.get(item_id),
                "itemTitle": items_by_id.get(item_id, {}).get("title"),
                "questionCount": sum(
                    question.get("itemId") == item_id for question in questions
                ),
            }
            for item_id in room.get("itemOrder", [])
        ]
        checklist_total = len(room.get("itemOrder", []))
        checklist_completed = sum(
            bool(items_by_id.get(item_id, {}).get("isCompleted"))
            for item_id in room.get("itemOrder", [])
        )
        answered_count = sum(bool(item.get("isAnswered")) for item in questions)
        return {
            "roomId": room["id"],
            "courseId": room["courseId"],
            "orgId": room["orgId"],
            "roomTitle": course.get("title", "NoDo 강의"),
            "participantCount": participant_count,
            "totalQuestionCount": len(questions),
            "generalQuestionCount": sum(
                bool(item.get("isGeneral")) or not item.get("itemId")
                for item in questions
            ),
            "publicQuestionCount": sum(
                item.get("visibility") == "PUBLIC" and not item.get("isHidden")
                for item in questions
            ),
            "reviewQuestionCount": sum(
                item.get("moderationStatus") == "NEEDS_REVIEW" for item in questions
            ),
            "hiddenQuestionCount": sum(
                bool(item.get("isHidden")) for item in questions
            ),
            "answeredQuestionCount": answered_count,
            "unansweredQuestionCount": len(questions) - answered_count,
            "itemQuestionCounts": item_question_counts,
            "checklistTotalCount": checklist_total,
            "checklistCompletedCount": checklist_completed,
            "incompleteChecklistCount": checklist_total - checklist_completed,
        }

    def get_end_room_preview(self, room_id: str) -> dict[str, Any]:
        room = self.get_room(room_id)
        if room is None:
            raise ResourceNotFound("Room not found")
        statistics = self._collect_room_statistics(room)
        return {
            "roomId": room_id,
            "status": room.get("status"),
            "totalQuestionCount": statistics["totalQuestionCount"],
            "unansweredQuestionCount": statistics["unansweredQuestionCount"],
            "checklistTotalCount": statistics["checklistTotalCount"],
            "incompleteChecklistCount": statistics["incompleteChecklistCount"],
        }

    def _build_room_summary(
        self,
        *,
        room: dict[str, Any],
        ended_at: datetime,
        ended_by_display_name: str,
    ) -> dict[str, Any]:
        return {
            "id": "current",
            **self._collect_room_statistics(room),
            "endedAt": ended_at,
            "endedByDisplayName": ended_by_display_name,
            "exportStatus": "NOT_CONFIGURED",
            "createdAt": ended_at,
            "updatedAt": ended_at,
            "schemaVersion": SCHEMA_VERSION,
        }

    def end_room(self, *, room_id: str, principal: Principal) -> dict[str, Any]:
        room_ref = self.client.collection("rooms").document(room_id)
        summary_ref = room_ref.collection("summary").document("current")
        termination_ref = room_ref.collection("serverState").document("termination")

        def begin_attempt() -> dict[str, Any]:
            transaction = self.client.transaction(max_attempts=1)

            @firestore.transactional
            def begin_ending(transaction: Any) -> dict[str, Any]:
                room, _, _ = self._transaction_room_access(
                    transaction,
                    room_ref=room_ref,
                    principal=principal,
                    permission=Permission.CAN_END_ROOM,
                    require_active=False,
                )
                termination = _document(termination_ref.get(transaction=transaction))
                status = room.get("status")
                if status in {RoomStatus.ENDING.value, RoomStatus.ENDED.value}:
                    if (
                        termination is None
                        or not termination.get("actorUid")
                        or not termination.get("actorDisplayName")
                    ):
                        raise ResourceConflict(
                            "The room termination actor state is missing"
                        )
                    return {"room": room, "termination": termination}
                if status != RoomStatus.ACTIVE.value:
                    raise InvalidOperation("Only an active room can be ended")
                now = self.server_clock()
                actor_display_name = principal.display_name or "강사"
                changes = {
                    "status": RoomStatus.ENDING.value,
                    "endingAt": now,
                    "endingByDisplayName": actor_display_name,
                    "updatedAt": now,
                }
                termination = {
                    "id": "termination",
                    "roomId": room_id,
                    "orgId": room["orgId"],
                    "status": RoomStatus.ENDING.value,
                    "actorUid": principal.uid,
                    "actorDisplayName": actor_display_name,
                    "requestedAt": now,
                    "schemaVersion": SCHEMA_VERSION,
                }
                transaction.update(room_ref, changes)
                transaction.set(termination_ref, termination)
                return {
                    "room": {**room, **changes},
                    "termination": termination,
                }

            return begin_ending(transaction)

        def begin_reconcile() -> dict[str, Any] | None:
            documents = {
                snapshot.reference.path: _document(snapshot)
                for snapshot in self.client.get_all([room_ref, termination_ref])
            }
            room = documents.get(room_ref.path)
            termination = documents.get(termination_ref.path)
            if room and room.get("status") in {
                RoomStatus.ENDING.value,
                RoomStatus.ENDED.value,
            }:
                if termination is None:
                    raise ResourceConflict(
                        "The room termination actor state is missing"
                    )
                return {"room": room, "termination": termination}
            return None

        begin_state = run_room_creation_with_retry(
            attempt=begin_attempt,
            reconcile=begin_reconcile,
            sleep=self.room_creation_sleep,
            jitter=self.room_creation_jitter,
        )
        room = begin_state["room"]
        termination = begin_state["termination"]
        if room.get("status") == RoomStatus.ENDED.value:
            summary = self.get_room_summary(room_id)
            if summary is None:
                raise ResourceConflict("The ended room summary is missing")
            return {"room": room, "summary": summary}

        ended_at = termination.get("requestedAt")
        if not isinstance(ended_at, datetime):
            raise ResourceConflict("The room termination time is missing")
        ended_by_display_name = str(termination["actorDisplayName"])
        summary = self._build_room_summary(
            room=room,
            ended_at=ended_at,
            ended_by_display_name=ended_by_display_name,
        )

        def finish_attempt() -> dict[str, Any]:
            transaction = self.client.transaction(max_attempts=1)
            log_ref = room_ref.collection("moderationLogs").document("room-ended")

            @firestore.transactional
            def finish_ending(transaction: Any) -> dict[str, Any]:
                current_room, course, _ = self._transaction_room_access(
                    transaction,
                    room_ref=room_ref,
                    principal=principal,
                    permission=Permission.CAN_END_ROOM,
                    require_active=False,
                )
                current_termination = _document(
                    termination_ref.get(transaction=transaction)
                )
                existing_summary = _document(summary_ref.get(transaction=transaction))
                if current_room.get("status") == RoomStatus.ENDED.value:
                    if existing_summary is None:
                        raise ResourceConflict("The ended room summary is missing")
                    return {"room": current_room, "summary": existing_summary}
                if current_room.get("status") != RoomStatus.ENDING.value:
                    raise InvalidOperation("The room is not being ended")
                if (
                    current_termination is None
                    or current_termination.get("actorUid")
                    != termination.get("actorUid")
                    or current_termination.get("actorDisplayName")
                    != ended_by_display_name
                ):
                    raise ResourceConflict(
                        "The room termination actor state is inconsistent"
                    )
                now = self.server_clock()
                room_changes = {
                    "status": RoomStatus.ENDED.value,
                    "endedAt": ended_at,
                    "endedByDisplayName": ended_by_display_name,
                    "updatedAt": now,
                }
                transaction.set(summary_ref, summary)
                transaction.update(room_ref, room_changes)
                transaction.update(
                    termination_ref,
                    {
                        "status": RoomStatus.ENDED.value,
                        "endedAt": ended_at,
                        "updatedAt": now,
                    },
                )
                transaction.update(
                    self.client.collection("courses").document(course["id"]),
                    {"status": RoomStatus.ENDED.value, "updatedAt": now},
                )
                transaction.set(
                    log_ref,
                    {
                        "id": "room-ended",
                        "roomId": room_id,
                        "orgId": current_room["orgId"],
                        "action": "ROOM_ENDED",
                        "targetId": room_id,
                        "actorUid": current_termination["actorUid"],
                        "before": {"status": RoomStatus.ENDING.value},
                        "after": {"status": RoomStatus.ENDED.value},
                        "createdAt": now,
                        "schemaVersion": SCHEMA_VERSION,
                    },
                )
                return {
                    "room": {**current_room, **room_changes},
                    "summary": summary,
                }

            return finish_ending(transaction)

        def finish_reconcile() -> dict[str, Any] | None:
            current_room = _document(room_ref.get())
            current_summary = self.get_room_summary(room_id)
            if (
                current_room
                and current_room.get("status") == RoomStatus.ENDED.value
                and current_summary
            ):
                return {"room": current_room, "summary": current_summary}
            return None

        return run_room_creation_with_retry(
            attempt=finish_attempt,
            reconcile=finish_reconcile,
            sleep=self.room_creation_sleep,
            jitter=self.room_creation_jitter,
        )
