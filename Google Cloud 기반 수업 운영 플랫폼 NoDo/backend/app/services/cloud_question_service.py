"""Cloud-auth question commands and read models.

The legacy Emulator question service intentionally remains independent.  This
module owns the cloud-auth collection layout and never returns anonymous or
staff identifiers to React.
"""

from __future__ import annotations

import csv
import hashlib
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta, timezone
from io import StringIO
from typing import Any, Protocol, TypeVar
from uuid import uuid4

from app.core.config import Settings
from app.domain.cloud_room_roles import (
    QUESTION_OPERATIONS,
    ROOM_ROLE_LEAD,
    assignment_for,
    full_room_permissions,
    has_room_operation,
    no_room_permissions,
    normalize_room_permissions,
)
from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    QuestionRateLimited,
    ResourceConflict,
    ResourceNotFound,
)
from app.domain.questions import (
    QUESTION_RATE_MAX_COUNT,
    QUESTION_RATE_WINDOW_SECONDS,
    QUESTION_REPEAT_WINDOW_SECONDS,
    fingerprints_are_similar,
    moderate_question,
    public_question,
    question_creation_response,
    sanitize_answer,
)
from app.domain.room_student_access import ended_student_access_open
from app.domain.staff_membership import has_active_membership
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_organization_service import ORGANIZATION_ROLES, SCHEMA_VERSION
from app.services.student_auth_service import VerifiedStudentIdentity

LIVE = "LIVE"
JOINED = "JOINED"
PUBLIC = "PUBLIC"
STAFF_ONLY = "STAFF_ONLY"
ALL_CONTEXT = "ALL"
GENERAL_CONTEXT = "GENERAL"
TransactionResult = TypeVar("TransactionResult")


class CloudQuestionTransaction(Protocol):
    @property
    def server_timestamp(self) -> object: ...

    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def create_document(self, path: str, document: Mapping[str, Any]) -> None: ...

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None: ...

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]: ...

    def list_room_questions(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]: ...

    def list_question_authors(
        self, *, org_id: str, room_id: str, author_uid: str
    ) -> list[Mapping[str, Any]]: ...


class CloudQuestionRepository(Protocol):
    def read_document(self, path: str) -> Mapping[str, Any] | None: ...

    def list_room_questions(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]: ...

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]: ...

    def run_transaction(
        self, callback: Callable[[CloudQuestionTransaction], TransactionResult]
    ) -> TransactionResult: ...


class CloudQuestionService:
    """Question handling with public/private document separation."""

    def __init__(
        self,
        repository: CloudQuestionRepository,
        settings: Settings,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.repository = repository
        self.settings = settings
        self.clock = clock or (lambda: datetime.now(UTC))

    # --- Student API -------------------------------------------------

    def student_questions(
        self,
        identity: VerifiedStudentIdentity,
        org_id: str,
        room_code: str,
    ) -> dict[str, Any]:
        room = self._student_room(identity, org_id, room_code)
        room_id = self._room_id(room)
        questions = [
            self._student_question(question)
            for question in self.repository.list_room_questions(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
            if self._is_public_question(question, room_id)
        ]
        flow_items = self._public_flow_items(
            self.repository.list_room_flow_items(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
        )
        participant = self.repository.read_document(
            self._participant_path(room_id, identity.uid)
        )
        if not self._is_participant(participant):
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        assert participant is not None
        return {
            "roomTitle": room["title"],
            "nickname": participant["nickname"],
            "flowItems": flow_items,
            "questions": self._sort_questions(questions),
        }

    def student_checklist(
        self,
        identity: VerifiedStudentIdentity,
        org_id: str,
        room_code: str,
    ) -> dict[str, Any]:
        """Return the learner's read-only lesson outline and public counts.

        This deliberately shares the anonymous-participant boundary used by the
        question feed, but does not read or update staff read positions.  A
        checklist refresh must therefore be side-effect free for learners.
        """

        room = self._student_checklist_room(identity, org_id, room_code)
        room_id = self._room_id(room)
        flow_items = self._student_checklist_flow_items(
            self.repository.list_room_flow_items(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
        )
        public_questions = [
            question
            for question in self.repository.list_room_questions(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
            if self._is_public_question(question, room_id)
        ]
        item_counts = {item["itemId"]: 0 for item in flow_items}
        for question in public_questions:
            item_id = question.get("itemId")
            if isinstance(item_id, str) and item_id in item_counts:
                item_counts[item_id] += 1
        current = next(
            (item["itemId"] for item in flow_items if not item["isCompleted"]),
            None,
        )
        return {
            "roomTitle": room["title"],
            "roomStatus": room["status"],
            "flowItems": flow_items,
            "currentItemId": current,
            "isComplete": bool(flow_items) and current is None,
            "summary": {
                "allCount": len(public_questions),
                "itemCounts": [
                    {
                        "itemId": item["itemId"],
                        "totalCount": item_counts[item["itemId"]],
                    }
                    for item in flow_items
                ],
            },
        }

    def student_assistant_context(
        self,
        identity: VerifiedStudentIdentity,
        org_id: str,
        room_code: str,
        requested_item_id: str | None,
    ) -> dict[str, Any]:
        """Return the smallest learner-visible lesson context for the AI helper.

        This is deliberately read-only and is built from the same participant
        and room boundary as the checklist.  It never exposes user IDs, staff
        assignments, audit records, material paths, or other learners' data.
        """

        room = self._student_checklist_room(identity, org_id, room_code)
        if room.get("status") not in {"READY", "LIVE"}:
            raise InvalidOperation("종료된 강의에서는 AI 도우미를 이용할 수 없습니다.")

        room_id = self._room_id(room)
        flow_items = self._student_checklist_flow_items(
            self.repository.list_room_flow_items(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
        )
        normalized_item_id = (
            self._id(requested_item_id, "item")
            if requested_item_id is not None
            else None
        )
        selected_item = next(
            (
                item
                for item in flow_items
                if item["itemId"] == normalized_item_id
            ),
            None,
        )
        if normalized_item_id is not None and selected_item is None:
            raise InvalidOperation("현재 강의의 항목을 선택해 주세요.")
        current_item = next(
            (item for item in flow_items if not item["isCompleted"]),
            None,
        )
        return {
            "roomTitle": room["title"],
            "roomStatus": room["status"],
            "currentItem": current_item,
            "selectedItem": selected_item or current_item,
            "flowItems": flow_items,
        }

    def create_student_question(
        self,
        identity: VerifiedStudentIdentity,
        org_id: str,
        room_code: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        content = payload.get("content")
        client_request_id = self._client_request_id(payload.get("clientRequestId"))
        requested_item_id = payload.get("itemId")
        if requested_item_id is not None:
            requested_item_id = self._id(requested_item_id, "item")
        decision = moderate_question(str(content) if content is not None else "")

        def create(transaction: CloudQuestionTransaction) -> dict[str, Any]:
            room = self._transaction_student_room(
                transaction, identity, org_id, room_code
            )
            room_id = self._room_id(room)
            participant = transaction.read_document(
                self._participant_path(room_id, identity.uid)
            )
            if not self._is_participant(participant):
                raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
            assert participant is not None
            question_id = self._question_id(identity.uid, client_request_id)
            existing_author = transaction.read_document(
                self._question_author_path(room_id, question_id)
            )
            if existing_author is not None:
                if (
                    existing_author.get("authorUid") != identity.uid
                    or existing_author.get("clientRequestId") != client_request_id
                ):
                    raise ResourceConflict("질문 요청을 다시 시도해 주세요.")
                existing_question = transaction.read_document(
                    self._question_path(room_id, question_id)
                )
                if not self._is_question(existing_question, room_id, question_id):
                    raise ResourceConflict("질문 요청을 다시 시도해 주세요.")
                assert existing_question is not None
                return question_creation_response(dict(existing_question))

            flow_items = self._public_flow_items(
                transaction.list_room_flow_items(
                    org_id=self.settings.bootstrap_org_id, room_id=room_id
                )
            )
            item = self._question_item(flow_items, requested_item_id)
            now = self._now()
            self._require_not_spam(
                transaction.list_question_authors(
                    org_id=self.settings.bootstrap_org_id,
                    room_id=room_id,
                    author_uid=identity.uid,
                ),
                decision.normalized_digest,
                decision.fingerprint,
                now,
            )
            timestamp = transaction.server_timestamp
            question = {
                "id": question_id,
                "roomId": room_id,
                "orgId": self.settings.bootstrap_org_id,
                "content": decision.content,
                "nicknameSnapshot": participant["nickname"],
                "isGeneral": item is None,
                "itemId": item["itemId"] if item is not None else None,
                "itemNumberSnapshot": item["itemNumber"] if item is not None else None,
                "itemTitleSnapshot": item["itemTitle"] if item is not None else None,
                "chapterTitleSnapshot": item["chapterTitle"]
                if item is not None
                else None,
                "visibility": decision.visibility,
                "moderationStatus": decision.moderation_status,
                "isAnswered": False,
                "answer": None,
                "isHidden": False,
                "createdAt": timestamp,
                "updatedAt": timestamp,
                "schemaVersion": SCHEMA_VERSION,
            }
            transaction.create_document(
                self._question_path(room_id, question_id), question
            )
            transaction.create_document(
                self._question_author_path(room_id, question_id),
                {
                    "questionId": question_id,
                    "authorUid": identity.uid,
                    "clientRequestId": client_request_id,
                    "normalizedDigest": decision.normalized_digest,
                    "fingerprint": list(decision.fingerprint),
                    "submittedAt": now,
                    "createdAt": timestamp,
                    "schemaVersion": SCHEMA_VERSION,
                },
            )
            self._audit(
                transaction,
                event_type="QUESTION_CREATED",
                room_id=room_id,
                question_id=question_id,
                actor_uid=identity.uid,
                timestamp=timestamp,
            )
            return question_creation_response(question)

        return self.repository.run_transaction(create)

    # --- Staff API ---------------------------------------------------

    def staff_questions(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, Any]:
        user = self._require_staff(identity)
        room = self._staff_room(room_id, identity, user)
        questions = [
            public_question(dict(question))
            for question in self.repository.list_room_questions(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
            if self._is_question(question, room_id)
        ]
        flow_items = self._public_flow_items(
            self.repository.list_room_flow_items(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
        )
        return {
            "roomTitle": room["title"],
            "roomStatus": room["status"],
            "currentRole": self._staff_role(room, identity.uid),
            "roomPermissions": self._room_permissions(room, identity.uid),
            "flowItems": flow_items,
            "questions": self._sort_questions(questions),
            "summary": self._summary(room_id, identity.uid, questions, flow_items),
        }

    def staff_question_summary(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> dict[str, Any]:
        user = self._require_staff(identity)
        self._staff_room(room_id, identity, user)
        questions = [
            public_question(dict(question))
            for question in self.repository.list_room_questions(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
            if self._is_question(question, room_id)
        ]
        flow_items = self._public_flow_items(
            self.repository.list_room_flow_items(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
        )
        return self._summary(room_id, identity.uid, questions, flow_items)

    def export_ended_room_questions_csv(
        self, identity: VerifiedCloudIdentity, room_id: str
    ) -> bytes:
        """Build a lead-only, in-memory CSV for an ENDED room's chat history."""

        user = self._require_staff(identity)
        room = self._staff_room(room_id, identity, user)
        if room.get("status") != "ENDED":
            raise ResourceConflict(
                "Question export is available only after the room ends"
            )
        if room.get("leadInstructorUid") != identity.uid:
            raise AccessDenied("Only the lead instructor can export questions")
        if not ended_student_access_open(room, self._now()):
            raise AccessDenied("The question export deadline has passed")

        flow_items = self._public_flow_items(
            self.repository.list_room_flow_items(
                org_id=self.settings.bootstrap_org_id, room_id=room_id
            )
        )
        item_contexts = {
            item["itemId"]: item
            for item in flow_items
        }
        questions = self._sort_questions(
            [
                dict(question)
                for question in self.repository.list_room_questions(
                    org_id=self.settings.bootstrap_org_id, room_id=room_id
                )
                if self._is_question(question, room_id)
            ]
        )

        output = StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(
            [
                "질문 순번",
                "질문 시각 (KST)",
                "질문 종류",
                "챕터 번호",
                "항목 번호",
                "항목 제목",
                "학생 별명",
                "질문 내용",
                "강사 공식 답변",
                "답변 시각 (KST)",
                "공개·숨김 상태",
            ]
        )
        for sequence, question in enumerate(questions, start=1):
            chapter_number, item_number, item_title = self._export_item_context(
                question, item_contexts
            )
            answer = question.get("answer")
            answer_content = ""
            answered_at = None
            if isinstance(answer, Mapping):
                answer_content = answer.get("content", "")
                answered_at = answer.get("answeredAt")
            writer.writerow(
                [
                    sequence,
                    self._export_kst_timestamp(question.get("createdAt")),
                    "일반 질문" if question["isGeneral"] else "항목 질문",
                    chapter_number,
                    item_number,
                    item_title,
                    self._export_nickname(room_id, question["id"]),
                    question["content"],
                    answer_content,
                    self._export_kst_timestamp(answered_at),
                    self._export_visibility(question),
                ]
            )
        return ("\ufeff" + output.getvalue()).encode("utf-8")

    def answer_question(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        question_id: str,
        content: str,
    ) -> dict[str, Any]:
        normalized_question_id = self._id(question_id, "question")
        answer = sanitize_answer(content)

        def answer_transaction(transaction: CloudQuestionTransaction) -> None:
            user = self._transaction_staff(transaction, identity)
            room = self._transaction_staff_room(transaction, room_id, identity, user)
            self._require_question_manager(room, identity.uid)
            question = self._transaction_question(
                transaction, room_id, normalized_question_id
            )
            timestamp = transaction.server_timestamp
            transaction.update_document(
                self._question_path(room_id, normalized_question_id),
                {
                    "answer": {
                        "content": answer,
                        "staffDisplayName": identity.display_name,
                        "roomRole": self._answer_room_role(room, identity.uid),
                        "answeredAt": timestamp,
                    },
                    "isAnswered": True,
                    "updatedAt": timestamp,
                },
            )
            self._audit(
                transaction,
                event_type="QUESTION_ANSWERED",
                room_id=room_id,
                question_id=normalized_question_id,
                actor_uid=identity.uid,
                timestamp=timestamp,
            )
            assert question["id"] == normalized_question_id

        self.repository.run_transaction(answer_transaction)
        return self._staff_question_response(identity, room_id, normalized_question_id)

    def cancel_answer(
        self, identity: VerifiedCloudIdentity, room_id: str, question_id: str
    ) -> dict[str, Any]:
        normalized_question_id = self._id(question_id, "question")

        def cancel_transaction(transaction: CloudQuestionTransaction) -> None:
            user = self._transaction_staff(transaction, identity)
            room = self._transaction_staff_room(transaction, room_id, identity, user)
            self._require_question_manager(room, identity.uid)
            self._transaction_question(transaction, room_id, normalized_question_id)
            timestamp = transaction.server_timestamp
            transaction.update_document(
                self._question_path(room_id, normalized_question_id),
                {"answer": None, "isAnswered": False, "updatedAt": timestamp},
            )
            self._audit(
                transaction,
                event_type="QUESTION_ANSWER_CANCELLED",
                room_id=room_id,
                question_id=normalized_question_id,
                actor_uid=identity.uid,
                timestamp=timestamp,
            )

        self.repository.run_transaction(cancel_transaction)
        return self._staff_question_response(identity, room_id, normalized_question_id)

    def set_hidden(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        question_id: str,
        *,
        hidden: bool,
    ) -> dict[str, Any]:
        normalized_question_id = self._id(question_id, "question")

        def hide_transaction(transaction: CloudQuestionTransaction) -> None:
            user = self._transaction_staff(transaction, identity)
            room = self._transaction_staff_room(transaction, room_id, identity, user)
            self._require_question_manager(room, identity.uid)
            self._transaction_question(transaction, room_id, normalized_question_id)
            timestamp = transaction.server_timestamp
            transaction.update_document(
                self._question_path(room_id, normalized_question_id),
                {"isHidden": hidden, "updatedAt": timestamp},
            )
            self._audit(
                transaction,
                event_type="QUESTION_HIDDEN" if hidden else "QUESTION_RESTORED",
                room_id=room_id,
                question_id=normalized_question_id,
                actor_uid=identity.uid,
                timestamp=timestamp,
            )

        self.repository.run_transaction(hide_transaction)
        return self._staff_question_response(identity, room_id, normalized_question_id)

    def mark_read(
        self,
        identity: VerifiedCloudIdentity,
        room_id: str,
        context_id: str,
        observed_question_id: str,
    ) -> dict[str, Any]:
        normalized_context = self._context(context_id)
        normalized_question_id = self._id(observed_question_id, "question")

        def mark_transaction(transaction: CloudQuestionTransaction) -> dict[str, Any]:
            user = self._transaction_staff(transaction, identity)
            room = self._transaction_staff_room(transaction, room_id, identity, user)
            self._require_question_manager(room, identity.uid)
            questions = [
                public_question(dict(question))
                for question in self._transaction_questions(transaction, room_id)
            ]
            relevant = self._questions_for_context(questions, normalized_context)
            observed = next(
                (
                    question
                    for question in relevant
                    if question["id"] == normalized_question_id
                ),
                None,
            )
            if observed is None:
                raise ResourceNotFound("The observed question was not found")
            timestamp = transaction.server_timestamp
            path = self._read_path(room_id, identity.uid, normalized_context)
            existing = transaction.read_document(path)
            all_read = (
                existing
                if normalized_context == ALL_CONTEXT
                else transaction.read_document(
                    self._read_path(room_id, identity.uid, ALL_CONTEXT)
                )
            )
            if not self._is_unread_from_all_positions(
                observed, existing, all_read
            ):
                return {
                    "contextId": normalized_context,
                    "marked": False,
                    "lastReadQuestionId": observed["id"],
                }
            read_document = {
                "lastReadQuestionId": observed["id"],
                "lastReadAt": observed.get("createdAt"),
                "updatedAt": timestamp,
            }
            if existing:
                transaction.update_document(path, read_document)
            else:
                transaction.create_document(
                    path,
                    {
                        "contextId": normalized_context,
                        **read_document,
                        "schemaVersion": SCHEMA_VERSION,
                    },
                )
            self._audit_read(
                transaction,
                room_id=room_id,
                context_id=normalized_context,
                observed_question_id=observed["id"],
                actor_uid=identity.uid,
                timestamp=timestamp,
            )
            return {
                "contextId": normalized_context,
                "marked": True,
                "lastReadQuestionId": observed["id"],
            }

        return self.repository.run_transaction(mark_transaction)

    # --- access and document helpers --------------------------------

    def _student_room(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
    ) -> Mapping[str, Any]:
        room = self._room_by_code(org_id, room_code)
        room_id = self._room_id(room)
        participant = self.repository.read_document(
            self._participant_path(room_id, identity.uid)
        )
        if not self._is_participant(participant):
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        return room

    def _student_checklist_room(
        self, identity: VerifiedStudentIdentity, org_id: str, room_code: str
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
        if not self._is_student_readable_room(
            room, room_id, code, allow_ready=True
        ):
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        participant = self.repository.read_document(
            self._participant_path(room_id, identity.uid)
        )
        if not self._is_participant(participant):
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        return room

    def _transaction_student_room(
        self,
        transaction: CloudQuestionTransaction,
        identity: VerifiedStudentIdentity,
        org_id: str,
        room_code: str,
    ) -> Mapping[str, Any]:
        if org_id != self.settings.bootstrap_org_id:
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        code = self._room_code(room_code)
        index = transaction.read_document(self._room_code_path(code))
        room_id = index.get("roomId") if isinstance(index, Mapping) else None
        room = (
            transaction.read_document(self._room_path(room_id))
            if isinstance(room_id, str)
            else None
        )
        if not self._is_live_room(room, room_id, code):
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        return room  # type: ignore[return-value]

    def _is_student_readable_room(
        self,
        room: Mapping[str, Any] | None,
        room_id: object,
        room_code: str,
        *,
        allow_ready: bool = False,
    ) -> bool:
        return self._is_live_room(room, room_id, room_code) or bool(
            allow_ready
            and isinstance(room_id, str)
            and self._is_room(room, room_id)
            and room is not None
            and room.get("status") == "READY"
            and room.get("roomCode") == room_code
        ) or bool(
            isinstance(room_id, str)
            and self._is_room(room, room_id)
            and room is not None
            and room.get("status") == "ENDED"
            and room.get("roomCode") == room_code
            and ended_student_access_open(room, self._now())
        )

    def _room_by_code(self, org_id: str, room_code: str) -> Mapping[str, Any]:
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
        if not self._is_student_readable_room(room, room_id, code):
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        return room  # type: ignore[return-value]

    def _require_staff(self, identity: VerifiedCloudIdentity) -> Mapping[str, Any]:
        user = self.repository.read_document(f"users/{identity.uid}")
        if not self._is_staff(user, identity.uid):
            raise AccessDenied("Only organization staff can access questions")
        return user  # type: ignore[return-value]

    def _transaction_staff(
        self, transaction: CloudQuestionTransaction, identity: VerifiedCloudIdentity
    ) -> Mapping[str, Any]:
        user = transaction.read_document(f"users/{identity.uid}")
        if not self._is_staff(user, identity.uid):
            raise AccessDenied("Only organization staff can access questions")
        return user  # type: ignore[return-value]

    def _staff_room(
        self,
        room_id: str,
        identity: VerifiedCloudIdentity,
        user: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        room = self.repository.read_document(self._room_path(room_id))
        return self._require_staff_room(room, room_id, identity, user)

    def _transaction_staff_room(
        self,
        transaction: CloudQuestionTransaction,
        room_id: str,
        identity: VerifiedCloudIdentity,
        user: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        room = transaction.read_document(self._room_path(room_id))
        return self._require_staff_room(room, room_id, identity, user)

    def _require_staff_room(
        self,
        room: Mapping[str, Any] | None,
        room_id: str,
        identity: VerifiedCloudIdentity,
        user: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        if not self._is_room(room, room_id):
            raise ResourceNotFound("The room was not found")
        assert room is not None
        if user.get("organizationRole") != "ADMIN" and identity.uid not in room.get(
            "instructorMemberUids", []
        ):
            raise AccessDenied("Only room instructors can access questions")
        return room

    def _transaction_question(
        self, transaction: CloudQuestionTransaction, room_id: str, question_id: str
    ) -> Mapping[str, Any]:
        question = transaction.read_document(self._question_path(room_id, question_id))
        if not self._is_question(question, room_id, question_id):
            raise ResourceNotFound("The question was not found")
        return question  # type: ignore[return-value]

    def _transaction_questions(
        self, transaction: CloudQuestionTransaction, room_id: str
    ) -> list[Mapping[str, Any]]:
        return [
            public_question(dict(question))
            for question in transaction.list_room_questions(
                org_id=self.settings.bootstrap_org_id,
                room_id=room_id,
            )
            if self._is_question(question, room_id)
        ]

    def _staff_question_response(
        self, identity: VerifiedCloudIdentity, room_id: str, question_id: str
    ) -> dict[str, Any]:
        user = self._require_staff(identity)
        self._staff_room(room_id, identity, user)
        question = self.repository.read_document(
            self._question_path(room_id, question_id)
        )
        if not self._is_question(question, room_id, question_id):
            raise ResourceNotFound("The question was not found")
        return public_question(dict(question))

    # --- policy ------------------------------------------------------

    def _require_not_spam(
        self,
        authors: list[Mapping[str, Any]],
        digest: str,
        fingerprint: tuple[str, ...],
        now: datetime,
    ) -> None:
        recent = [
            author
            for author in authors
            if (submitted := self._submitted_at(author)) is not None
            and (now - submitted).total_seconds() <= QUESTION_RATE_WINDOW_SECONDS
        ]
        if len(recent) >= QUESTION_RATE_MAX_COUNT:
            raise QuestionRateLimited("질문을 잠시 후 다시 보내 주세요.")
        for author in authors:
            submitted = self._submitted_at(author)
            if (
                submitted is None
                or (now - submitted).total_seconds() > QUESTION_REPEAT_WINDOW_SECONDS
            ):
                continue
            candidate_digest = author.get("normalizedDigest")
            candidate_fingerprint = author.get("fingerprint")
            if candidate_digest == digest or (
                isinstance(candidate_fingerprint, list)
                and all(isinstance(value, str) for value in candidate_fingerprint)
                and fingerprints_are_similar(candidate_fingerprint, fingerprint)
            ):
                raise ResourceConflict(
                    "같거나 매우 비슷한 질문은 잠시 후 다시 보내 주세요."
                )

    def _question_item(
        self, flow_items: list[dict[str, Any]], item_id: str | None
    ) -> dict[str, Any] | None:
        if item_id is None:
            return None
        item = next((item for item in flow_items if item["itemId"] == item_id), None)
        if item is None:
            raise InvalidOperation("The selected checklist item was not found")
        return item

    def _require_question_manager(self, room: Mapping[str, Any], uid: str) -> None:
        if room.get("status") == "ENDED":
            raise ResourceConflict("Questions cannot be changed after the room ends")
        if not has_room_operation(room, uid, QUESTION_OPERATIONS):
            raise AccessDenied("This instructor cannot operate questions")

    def _answer_room_role(self, room: Mapping[str, Any], uid: str) -> str:
        assignment = assignment_for(room, uid)
        if assignment and assignment["role"] == ROOM_ROLE_LEAD:
            return "LEAD"
        return "ASSISTANT"

    def _room_permissions(self, room: Mapping[str, Any], uid: str) -> dict[str, bool]:
        assignment = assignment_for(room, uid)
        if assignment is None:
            return no_room_permissions()
        if assignment["role"] == ROOM_ROLE_LEAD:
            return full_room_permissions()
        return normalize_room_permissions(assignment.get("permissions"))

    # --- read models -------------------------------------------------

    def _summary(
        self,
        room_id: str,
        uid: str,
        questions: list[dict[str, Any]],
        flow_items: list[dict[str, Any]],
    ) -> dict[str, Any]:
        item_counts: dict[str, dict[str, Any]] = {}
        for item in flow_items:
            item_counts[item["itemId"]] = {
                "itemId": item["itemId"],
                "itemNumber": item["itemNumber"],
                "totalCount": 0,
                "newCount": 0,
            }
        all_questions = self._sort_questions(questions)
        general_questions = [
            question for question in all_questions if question["isGeneral"]
        ]
        for question in all_questions:
            item_id = question.get("itemId")
            if isinstance(item_id, str) and item_id in item_counts:
                item_counts[item_id]["totalCount"] += 1
        all_read = self.repository.read_document(
            self._read_path(room_id, uid, ALL_CONTEXT)
        )
        general_read = self.repository.read_document(
            self._read_path(room_id, uid, GENERAL_CONTEXT)
        )
        new_all = self._unread_count(all_questions, all_read)
        new_general = self._unread_count(
            general_questions, general_read, all_read
        )
        for item_id, count in item_counts.items():
            item_questions = [
                question
                for question in all_questions
                if question.get("itemId") == item_id
            ]
            item_read = self.repository.read_document(
                self._read_path(room_id, uid, self._item_context(item_id))
            )
            count["newCount"] = self._unread_count(
                item_questions, item_read, all_read
            )
        return {
            "allCount": len(all_questions),
            "newCount": new_all,
            "generalCount": len(general_questions),
            "generalNewCount": new_general,
            "itemCounts": list(item_counts.values()),
        }

    def _student_question(self, question: Mapping[str, Any]) -> dict[str, Any]:
        document = public_question(dict(question))
        for key in ("visibility", "moderationStatus", "isHidden", "orgId", "roomId"):
            document.pop(key, None)
        answer = document.get("answer")
        if isinstance(answer, Mapping):
            document["answer"] = {
                key: value
                for key, value in answer.items()
                if key != "staffDisplayName"
            }
        return document

    def _export_item_context(
        self,
        question: Mapping[str, Any],
        item_contexts: Mapping[str, Mapping[str, Any]],
    ) -> tuple[str, str, str]:
        if question.get("isGeneral") is True:
            return "", "", ""
        item_id = question.get("itemId")
        item = item_contexts.get(item_id) if isinstance(item_id, str) else None
        number = (
            item.get("itemNumber")
            if isinstance(item, Mapping) and isinstance(item.get("itemNumber"), str)
            else question.get("itemNumberSnapshot")
        )
        chapter_number, separator, item_number = (
            number.partition(".") if isinstance(number, str) else ("", "", "")
        )
        if not separator:
            chapter_number, item_number = "", ""
        title = question.get("itemTitleSnapshot")
        if not isinstance(title, str) and isinstance(item, Mapping):
            title = item.get("itemTitle")
        return chapter_number, item_number, title if isinstance(title, str) else ""

    def _export_nickname(self, room_id: str, question_id: str) -> str:
        author = self.repository.read_document(
            self._question_author_path(room_id, question_id)
        )
        author_uid = author.get("authorUid") if isinstance(author, Mapping) else None
        participant = (
            self.repository.read_document(self._participant_path(room_id, author_uid))
            if isinstance(author_uid, str)
            else None
        )
        if self._is_participant(participant):
            assert participant is not None
            return participant["nickname"]
        return ""

    @staticmethod
    def _export_kst_timestamp(value: object) -> str:
        if not isinstance(value, datetime):
            return ""
        normalized = (
            value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
        )
        kst = timezone(timedelta(hours=9), name="KST")
        return normalized.astimezone(kst).strftime("%Y-%m-%d %H:%M:%S KST")

    @staticmethod
    def _export_visibility(question: Mapping[str, Any]) -> str:
        if question.get("isHidden") is True:
            return "숨김"
        return "공개" if question.get("visibility") == PUBLIC else "비공개"

    def _is_public_question(self, question: Mapping[str, Any], room_id: str) -> bool:
        return (
            self._is_question(question, room_id)
            and question.get("visibility") == PUBLIC
            and not question.get("isHidden")
        )

    def _public_flow_items(
        self, flow_items: list[Mapping[str, Any]]
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        ids: set[str] = set()
        for item in flow_items:
            item_id = self._id(item.get("itemId"), "item")
            if item_id in ids:
                raise InvalidOperation("The room checklist is invalid")
            ids.add(item_id)
            chapter_position = self._position(item.get("chapterPosition"))
            item_position = self._position(item.get("itemPosition"))
            result.append(
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
                    "itemNumber": f"{chapter_position + 1}.{item_position + 1}",
                }
            )
        return sorted(
            result, key=lambda item: (item["chapterPosition"], item["itemPosition"])
        )

    def _student_checklist_flow_items(
        self, flow_items: list[Mapping[str, Any]]
    ) -> list[dict[str, Any]]:
        public_items = self._public_flow_items(flow_items)
        completed_by_id: dict[str, bool] = {}
        for item in flow_items:
            item_id = self._id(item.get("itemId"), "item")
            completed = item.get("isCompleted")
            if not isinstance(completed, bool):
                raise InvalidOperation("The room checklist is invalid")
            completed_by_id[item_id] = completed
        return [
            {**item, "isCompleted": completed_by_id[item["itemId"]]}
            for item in public_items
        ]

    def _questions_for_context(
        self, questions: list[dict[str, Any]], context_id: str
    ) -> list[dict[str, Any]]:
        if context_id == ALL_CONTEXT:
            return questions
        if context_id == GENERAL_CONTEXT:
            return [question for question in questions if question.get("isGeneral")]
        item_id = context_id.removeprefix("ITEM:")
        return [question for question in questions if question.get("itemId") == item_id]

    def _unread_count(
        self,
        questions: list[dict[str, Any]],
        *read_positions: Mapping[str, Any] | None,
    ) -> int:
        return sum(
            1
            for question in questions
            if self._is_unread_from_all_positions(question, *read_positions)
        )

    def _is_unread_from_all_positions(
        self,
        question: Mapping[str, Any],
        *read_positions: Mapping[str, Any] | None,
    ) -> bool:
        return all(
            self._is_newer_question(question, read) for read in read_positions
        )

    def _is_newer_question(
        self, question: Mapping[str, Any], read: Mapping[str, Any] | None
    ) -> bool:
        if read is None or not isinstance(read.get("lastReadQuestionId"), str):
            return True
        return self._question_key(question) > (
            self._timestamp_key(read.get("lastReadAt")),
            str(read["lastReadQuestionId"]),
        )

    def _sort_questions(self, questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(questions, key=self._question_key)

    def _question_key(self, question: Mapping[str, Any]) -> tuple[float, str]:
        return (
            self._timestamp_key(question.get("createdAt")),
            str(question.get("id", "")),
        )

    def _timestamp_key(self, value: object) -> float:
        if isinstance(value, datetime):
            return value.timestamp()
        return 0.0

    # --- validation and paths --------------------------------------

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

    def _is_room(self, room: Mapping[str, Any] | None, room_id: str) -> bool:
        return bool(
            room
            and room.get("id") == room_id
            and room.get("orgId") == self.settings.bootstrap_org_id
            and room.get("schemaVersion") == SCHEMA_VERSION
            and room.get("status") in {"READY", LIVE, "ENDED"}
            and isinstance(room.get("roomCode"), str)
            and isinstance(room.get("title"), str)
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

    def _is_participant(self, participant: Mapping[str, Any] | None) -> bool:
        return bool(
            participant
            and participant.get("participantStatus") == JOINED
            and participant.get("isAnonymous") is True
            and isinstance(participant.get("nickname"), str)
        )

    def _is_question(
        self,
        question: Mapping[str, Any] | None,
        room_id: str,
        question_id: str | None = None,
    ) -> bool:
        return bool(
            question
            and question.get("roomId") == room_id
            and question.get("orgId") == self.settings.bootstrap_org_id
            and question.get("schemaVersion") == SCHEMA_VERSION
            and isinstance(question.get("id"), str)
            and (question_id is None or question.get("id") == question_id)
            and isinstance(question.get("content"), str)
            and isinstance(question.get("nicknameSnapshot"), str)
            and isinstance(question.get("isGeneral"), bool)
            and question.get("visibility") in {PUBLIC, STAFF_ONLY}
            and isinstance(question.get("isAnswered"), bool)
            and isinstance(question.get("isHidden"), bool)
        )

    def _staff_role(self, room: Mapping[str, Any], uid: str) -> str:
        assignment = assignment_for(room, uid)
        if assignment is None:
            return "ADMIN"
        return (
            "LEAD_INSTRUCTOR"
            if assignment["role"] == ROOM_ROLE_LEAD
            else "ASSISTANT"
        )

    def _room_id(self, room: Mapping[str, Any]) -> str:
        return self._id(room.get("id"), "room")

    def _room_code(self, value: object) -> str:
        if not isinstance(value, str) or len(value.strip()) != 8:
            raise AccessDenied("현재 이 강의방에 참여할 수 없습니다.")
        return value.strip().upper()

    def _id(self, value: object, label: str) -> str:
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value.strip()) > 100
            or "/" in value
        ):
            raise InvalidOperation(f"The {label} identifier is invalid")
        return value.strip()

    def _client_request_id(self, value: object) -> str:
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 128:
            raise InvalidOperation("The client request identifier is invalid")
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

    def _position(self, value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise InvalidOperation("The room checklist is invalid")
        return value

    @staticmethod
    def _source_unit_numbers(value: object) -> list[int]:
        if value is None:
            return []
        if not isinstance(value, list) or len(value) > 20:
            raise InvalidOperation("The room checklist is invalid")
        numbers = sorted(set(value))
        if any(
            isinstance(number, bool) or not isinstance(number, int) or number < 1
            for number in numbers
        ):
            raise InvalidOperation("The room checklist is invalid")
        return numbers

    def _context(self, value: str) -> str:
        if value in {ALL_CONTEXT, GENERAL_CONTEXT}:
            return value
        if value.startswith("ITEM:"):
            return self._item_context(self._id(value[5:], "item"))
        raise InvalidOperation("The question context is invalid")

    def _item_context(self, item_id: str) -> str:
        return f"ITEM:{item_id}"

    def _question_id(self, uid: str, client_request_id: str) -> str:
        return hashlib.sha256(f"{uid}\x00{client_request_id}".encode()).hexdigest()[:32]

    def _submitted_at(self, author: Mapping[str, Any]) -> datetime | None:
        value = author.get("submittedAt")
        if not isinstance(value, datetime):
            return None
        return value if value.tzinfo else value.replace(tzinfo=UTC)

    def _now(self) -> datetime:
        value = self.clock()
        return value if value.tzinfo else value.replace(tzinfo=UTC)

    def _room_path(self, room_id: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/rooms/{room_id}"

    def _room_code_path(self, room_code: str) -> str:
        return f"organizations/{self.settings.bootstrap_org_id}/roomCodes/{room_code}"

    def _participant_path(self, room_id: str, uid: str) -> str:
        return f"{self._room_path(room_id)}/participants/{uid}"

    def _question_path(self, room_id: str, question_id: str) -> str:
        return f"{self._room_path(room_id)}/questions/{question_id}"

    def _question_author_path(self, room_id: str, question_id: str) -> str:
        return f"{self._room_path(room_id)}/questionAuthors/{question_id}"

    def _read_path(self, room_id: str, uid: str, context_id: str) -> str:
        context_hash = hashlib.sha256(context_id.encode()).hexdigest()[:24]
        return f"{self._room_path(room_id)}/questionReads/{uid}/contexts/{context_hash}"

    def _audit(
        self,
        transaction: CloudQuestionTransaction,
        *,
        event_type: str,
        room_id: str,
        question_id: str,
        actor_uid: str,
        timestamp: object,
    ) -> None:
        audit_id = f"question-{uuid4().hex}"
        transaction.create_document(
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/{audit_id}",
            {
                "eventType": event_type,
                "orgId": self.settings.bootstrap_org_id,
                "roomId": room_id,
                "questionId": question_id,
                "actorUid": actor_uid,
                "createdAt": timestamp,
                "schemaVersion": SCHEMA_VERSION,
            },
        )

    def _audit_read(
        self,
        transaction: CloudQuestionTransaction,
        *,
        room_id: str,
        context_id: str,
        observed_question_id: str,
        actor_uid: str,
        timestamp: object,
    ) -> None:
        audit_id = f"question-{uuid4().hex}"
        transaction.create_document(
            f"organizations/{self.settings.bootstrap_org_id}/auditLogs/{audit_id}",
            {
                "eventType": "QUESTION_READ",
                "orgId": self.settings.bootstrap_org_id,
                "roomId": room_id,
                "contextId": context_id,
                "observedQuestionId": observed_question_id,
                "actorUid": actor_uid,
                "createdAt": timestamp,
                "schemaVersion": SCHEMA_VERSION,
            },
        )
