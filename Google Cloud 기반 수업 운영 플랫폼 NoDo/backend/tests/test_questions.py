from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

import pytest

from app.adapters.firebase_emulator import deterministic_question_id
from app.domain.authorization import (
    AccountType,
    Permission,
    Principal,
    RoomStatus,
    empty_permissions,
)
from app.domain.errors import AccessDenied, QuestionRejected
from app.domain.questions import (
    QUESTION_MAX_LENGTH,
    fingerprints_are_similar,
    moderate_question,
    public_question,
    question_creation_response,
    sanitize_answer,
)
from app.services.nodo_service import NoDoService


class QuestionRepository:
    def __init__(self) -> None:
        self.course = {
            "id": "demo-course",
            "orgId": "org-nodo",
            "activeRoomId": "demo-room",
            "leadInstructorId": "lead-instructor",
        }
        self.room = {
            "id": "demo-room",
            "courseId": "demo-course",
            "orgId": "org-nodo",
            "leadInstructorId": "lead-instructor",
            "status": RoomStatus.ACTIVE.value,
            "itemOrder": ["flow-1"],
        }
        self.participant = {
            "roomId": "demo-room",
            "orgId": "org-nodo",
            "nickname": "익명 학습자",
            "participantId": "public-participant",
            "isQuestionRestricted": False,
        }
        self.staff: dict[str, dict[str, Any]] = {
            "assistant-answer": self._staff(
                "assistant-answer", Permission.CAN_ANSWER_QUESTIONS
            ),
            "assistant-moderate": self._staff(
                "assistant-moderate",
                Permission.CAN_MODERATE_QUESTIONS
            ),
            "assistant-participants": self._staff(
                "assistant-participants",
                Permission.CAN_MANAGE_PARTICIPANTS
            ),
            "assistant-end": self._staff(
                "assistant-end", Permission.CAN_END_ROOM
            ),
            "assistant-report": self._staff(
                "assistant-report", Permission.CAN_VIEW_REPORTS
            ),
            "assistant-none": self._staff("assistant-none"),
        }
        self.last_call: tuple[str, dict[str, Any]] | None = None

    @staticmethod
    def _staff(uid: str, *permissions: Permission) -> dict[str, Any]:
        value = empty_permissions()
        for permission in permissions:
            value[permission.value] = True
        return {
            "userId": uid,
            "roomId": "demo-room",
            "orgId": "org-nodo",
            "permissions": value,
        }

    def get_course(self, course_id: str) -> dict[str, Any] | None:
        return deepcopy(self.course) if course_id == "demo-course" else None

    def get_room(self, room_id: str) -> dict[str, Any] | None:
        return deepcopy(self.room) if room_id == "demo-room" else None

    def get_participant(
        self, room_id: str, uid: str
    ) -> dict[str, Any] | None:
        if room_id == "demo-room" and uid == "student":
            return deepcopy(self.participant)
        return None

    def get_staff(self, room_id: str, uid: str) -> dict[str, Any] | None:
        return deepcopy(self.staff.get(uid)) if room_id == "demo-room" else None

    def create_question(self, **kwargs: Any) -> dict[str, Any]:
        self.last_call = ("create_question", kwargs)
        moderation = kwargs["moderation"]
        return {
            "id": "question-1",
            "content": moderation.content,
            "itemId": kwargs["item_id"],
            "visibility": moderation.visibility,
            "moderationStatus": moderation.moderation_status,
        }

    def answer_question(self, **kwargs: Any) -> dict[str, Any]:
        self.last_call = ("answer_question", kwargs)
        return {"id": kwargs["question_id"], "isAnswered": True}

    def cancel_question_answer(self, **kwargs: Any) -> dict[str, Any]:
        self.last_call = ("cancel_question_answer", kwargs)
        return {"id": kwargs["question_id"], "isAnswered": False}

    def moderate_question(self, **kwargs: Any) -> dict[str, Any]:
        self.last_call = ("moderate_question", kwargs)
        return {"id": kwargs["question_id"], "action": kwargs["action"]}

    def mark_questions_read(self, **kwargs: Any) -> dict[str, Any]:
        self.last_call = ("mark_questions_read", kwargs)
        return {
            "contextId": kwargs["context_id"],
            "lastReadAt": kwargs["observed_at"],
            "lastReadQuestionId": kwargs["observed_question_id"],
        }

    def list_participants(self, room_id: str) -> list[dict[str, Any]]:
        return [{"participantId": "public-participant", "nickname": "익명 학습자"}]

    def update_participant_restriction(self, **kwargs: Any) -> dict[str, Any]:
        self.last_call = ("update_participant_restriction", kwargs)
        return {
            "participantId": kwargs["participant_id"],
            "isQuestionRestricted": kwargs["is_question_restricted"],
        }

    def end_room(self, **kwargs: Any) -> dict[str, Any]:
        self.last_call = ("end_room", kwargs)
        return {"room": {**self.room, "status": "ENDED"}, "summary": {}}

    def get_end_room_preview(self, room_id: str) -> dict[str, Any]:
        return {
            "roomId": room_id,
            "status": self.room["status"],
            "totalQuestionCount": 4,
            "unansweredQuestionCount": 2,
            "checklistTotalCount": 3,
            "incompleteChecklistCount": 1,
        }

    def get_room_summary(self, room_id: str) -> dict[str, Any] | None:
        return {"roomId": room_id, "exportStatus": "NOT_CONFIGURED"}


def actor(
    uid: str,
    account_type: AccountType = AccountType.STAFF,
    *,
    anonymous: bool = False,
    org_id: str = "org-nodo",
) -> Principal:
    return Principal(
        uid=uid,
        account_type=account_type,
        org_id=org_id,
        display_name="테스트 사용자",
        is_anonymous=anonymous,
    )


def test_plain_text_cleanup_preserves_html_as_text_and_removes_controls() -> None:
    result = moderate_question("  <script>alert(1)</script>\u0000 질문  ")

    assert result.content == "<script>alert(1)</script> 질문"
    assert result.visibility == "PUBLIC"


@pytest.mark.parametrize("content", ["", " \n\t "])
def test_blank_question_is_rejected(content: str) -> None:
    with pytest.raises(QuestionRejected, match="입력"):
        moderate_question(content)


def test_question_over_maximum_length_is_rejected() -> None:
    with pytest.raises(QuestionRejected, match=str(QUESTION_MAX_LENGTH)):
        moderate_question("가" * (QUESTION_MAX_LENGTH + 1))


def test_blocked_term_is_rejected_without_echoing_the_body() -> None:
    content = "욕설 질문 원문"

    with pytest.raises(QuestionRejected) as captured:
        moderate_question(content)

    assert content not in captured.value.message


def test_ambiguous_attack_is_saved_for_staff_review() -> None:
    decision = moderate_question("이 설명은 정말 바보 같다고 느껴져요")

    assert decision.moderation_status == "NEEDS_REVIEW"
    assert decision.visibility == "STAFF_ONLY"


def test_similarity_fingerprint_recognizes_small_repeat_change() -> None:
    first = moderate_question("이 예제를 다시 설명해 주세요")
    second = moderate_question("이 예제를 다시 설명해 주세요!")

    assert fingerprints_are_similar(list(first.fingerprint), second.fingerprint)


def test_answer_cleanup_has_its_own_safe_limit() -> None:
    assert sanitize_answer("  답변\u0000입니다  ") == "답변입니다"


def test_public_question_removes_every_internal_identity_field() -> None:
    now = datetime.now(UTC)
    result = public_question(
        {
            "id": "question-1",
            "content": "질문",
            "participantUid": "secret-student",
            "authorUid": "secret-author",
            "answererUid": "secret-answerer",
            "clientRequestId": "secret-request",
            "answer": {
                "content": "공개 답변",
                "staffDisplayName": "강사",
                "roomRole": "LEAD",
                "answeredAt": now,
                "answererUid": "secret-nested-answerer",
            },
            "createdAt": now,
        }
    )

    assert result == {
        "id": "question-1",
        "content": "질문",
        "answer": {
            "content": "공개 답변",
            "staffDisplayName": "강사",
            "roomRole": "LEAD",
            "answeredAt": now,
        },
        "createdAt": now,
    }


@pytest.mark.parametrize(
    ("visibility", "moderation_status"),
    [("PUBLIC", "APPROVED"), ("STAFF_ONLY", "NEEDS_REVIEW")],
)
def test_all_question_creation_results_use_same_safe_receipt(
    visibility: str, moderation_status: str
) -> None:
    result = question_creation_response(
        {
            "id": "question-id",
            "roomId": "demo-room",
            "content": "분류를 추론하면 안 되는 본문",
            "nicknameSnapshot": "익명",
            "visibility": visibility,
            "moderationStatus": moderation_status,
            "itemTitleSnapshot": "내부 문맥",
        }
    )

    assert result == {
        "id": "question-id",
        "roomId": "demo-room",
        "accepted": True,
    }


def test_deterministic_id_is_stable_and_scoped_to_participant() -> None:
    first = deterministic_question_id(
        room_id="room", participant_uid="student-a", client_request_id="request-1"
    )
    retry = deterministic_question_id(
        room_id="room", participant_uid="student-a", client_request_id="request-1"
    )
    other_student = deterministic_question_id(
        room_id="room", participant_uid="student-b", client_request_id="request-1"
    )

    assert first == retry
    assert first != other_student
    assert "student" not in first


def test_student_can_create_item_and_general_questions() -> None:
    repository = QuestionRepository()
    service = NoDoService(repository)
    student = actor("student", AccountType.STUDENT, anonymous=True)

    item_question = service.create_question(
        student,
        "demo-room",
        content="항목 질문",
        item_id="flow-1",
        client_request_id="request-item",
    )
    general_question = service.create_question(
        student,
        "demo-room",
        content="일반 질문",
        item_id=None,
        client_request_id="request-general",
    )

    assert item_question["itemId"] == "flow-1"
    assert general_question["itemId"] is None


def test_non_participant_cannot_create_question() -> None:
    service = NoDoService(QuestionRepository())

    with pytest.raises(AccessDenied, match="참여"):
        service.create_question(
            actor("other-student", AccountType.STUDENT, anonymous=True),
            "demo-room",
            content="질문",
            item_id=None,
            client_request_id="request-other",
        )


def test_cross_organization_student_cannot_create_question() -> None:
    service = NoDoService(QuestionRepository())

    with pytest.raises(AccessDenied, match="참여"):
        service.create_question(
            actor(
                "student",
                AccountType.STUDENT,
                anonymous=True,
                org_id="org-other",
            ),
            "demo-room",
            content="다른 조직 질문",
            item_id=None,
            client_request_id="request-cross-org",
        )


def test_answer_permission_allows_assistant_and_denies_unprivileged_staff() -> None:
    service = NoDoService(QuestionRepository())

    result = service.answer_question(
        actor("assistant-answer"),
        "demo-room",
        "question-1",
        "강사 답변",
    )

    assert result["isAnswered"] is True
    with pytest.raises(AccessDenied):
        service.answer_question(
            actor("assistant-none"),
            "demo-room",
            "question-1",
            "권한 없는 답변",
        )


def test_moderation_permission_is_independent_from_answer_permission() -> None:
    service = NoDoService(QuestionRepository())

    approved = service.moderate_question(
        actor("assistant-moderate"),
        "demo-room",
        "question-1",
        "APPROVE",
    )

    assert approved["action"] == "APPROVE"
    with pytest.raises(AccessDenied):
        service.moderate_question(
            actor("assistant-answer"),
            "demo-room",
            "question-1",
            "HIDE",
        )


def test_every_invited_assistant_can_mark_public_context_read() -> None:
    service = NoDoService(QuestionRepository())
    observed_at = datetime(2026, 7, 15, 3, 0, tzinfo=UTC)

    result = service.mark_questions_read(
        actor("assistant-none"),
        "demo-room",
        "flow-1",
        observed_at,
        "question-1",
    )

    assert result["contextId"] == "flow-1"
    assert result["lastReadAt"] == observed_at
    assert result["lastReadQuestionId"] == "question-1"


def test_participant_management_never_returns_internal_uid() -> None:
    service = NoDoService(QuestionRepository())
    result = service.participants(
        actor("assistant-participants"),
        "demo-room",
    )

    assert result["participants"] == [
        {"participantId": "public-participant", "nickname": "익명 학습자"}
    ]
    assert "uid" not in str(result).casefold()


def test_end_and_report_permissions_are_independent() -> None:
    service = NoDoService(QuestionRepository())

    ended = service.end_room(
        actor("assistant-end"), "demo-room"
    )
    report = service.room_report(
        actor("assistant-report"), "demo-room"
    )

    assert ended["room"]["status"] == "ENDED"
    assert report["exportStatus"] == "NOT_CONFIGURED"
    with pytest.raises(AccessDenied):
        service.room_report(
            actor("student", AccountType.STUDENT, anonymous=True), "demo-room"
        )


def test_can_end_assistant_gets_preview_without_report_permission() -> None:
    service = NoDoService(QuestionRepository())

    preview = service.end_room_preview(
        actor("assistant-end"), "demo-room"
    )

    assert preview == {
        "roomId": "demo-room",
        "status": "ACTIVE",
        "totalQuestionCount": 4,
        "unansweredQuestionCount": 2,
        "checklistTotalCount": 3,
        "incompleteChecklistCount": 1,
    }
    with pytest.raises(AccessDenied):
        service.end_room_preview(
            actor("assistant-report"),
            "demo-room",
        )


def test_question_mutations_are_blocked_while_room_is_ending() -> None:
    repository = QuestionRepository()
    repository.room["status"] = RoomStatus.ENDING.value
    service = NoDoService(repository)

    with pytest.raises(AccessDenied, match="read-only"):
        service.answer_question(
            actor("lead-instructor"),
            "demo-room",
            "question-1",
            "종료 중 답변",
        )
