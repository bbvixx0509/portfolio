import copy
import csv
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from io import StringIO
from typing import Any, TypeVar

import pytest
from test_cloud_organization import cloud_settings

from app.domain.errors import (
    AccessDenied,
    InvalidOperation,
    QuestionRejected,
    ResourceConflict,
    ResourceNotFound,
)
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.cloud_question_service import (
    CloudQuestionService,
    CloudQuestionTransaction,
)
from app.services.student_auth_service import VerifiedStudentIdentity

LEAD = VerifiedCloudIdentity("lead-uid", "lead@example.test", "주 강사", None)
ASSISTANT = VerifiedCloudIdentity(
    "assistant-uid", "assistant@example.test", "보조 강사", None
)
ADMIN = VerifiedCloudIdentity("admin-uid", "admin@example.test", "관리자", None)
OTHER = VerifiedCloudIdentity("other-uid", "other@example.test", "다른 강사", None)
STUDENT = VerifiedStudentIdentity("anonymous-student")
OTHER_STUDENT = VerifiedStudentIdentity("other-anonymous")
NOW = datetime(2026, 7, 25, 9, 0, tzinfo=UTC)
Result = TypeVar("Result")


class InMemoryQuestionTransaction:
    def __init__(self, documents: dict[str, dict[str, Any]]) -> None:
        self.documents = documents
        self.pending: dict[str, dict[str, Any]] = {}

    @property
    def server_timestamp(self) -> object:
        return NOW

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        value = self.pending.get(path, self.documents.get(path))
        return copy.deepcopy(value) if value is not None else None

    def create_document(self, path: str, document: Mapping[str, Any]) -> None:
        if path in self.documents or path in self.pending:
            raise ResourceConflict("already exists")
        self.pending[path] = copy.deepcopy(dict(document))

    def update_document(self, path: str, changes: Mapping[str, Any]) -> None:
        current = self.read_document(path)
        if current is None:
            raise ResourceConflict("missing")
        self.pending[path] = {**current, **copy.deepcopy(dict(changes))}

    def _documents(self, prefix: str) -> list[Mapping[str, Any]]:
        paths = set(self.documents) | set(self.pending)
        return [
            value
            for path in paths
            if path.startswith(prefix)
            if (value := self.read_document(path))
        ]

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        return self._documents(f"organizations/{org_id}/rooms/{room_id}/flowItems/")

    def list_room_questions(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        return self._documents(f"organizations/{org_id}/rooms/{room_id}/questions/")

    def list_question_authors(
        self, *, org_id: str, room_id: str, author_uid: str
    ) -> list[Mapping[str, Any]]:
        return [
            document
            for document in self._documents(
                f"organizations/{org_id}/rooms/{room_id}/questionAuthors/"
            )
            if document.get("authorUid") == author_uid
        ]


class InMemoryQuestionRepository:
    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {
            "users/lead-uid": staff(LEAD, "INSTRUCTOR"),
            "users/assistant-uid": staff(ASSISTANT, "INSTRUCTOR"),
            "users/admin-uid": staff(ADMIN, "ADMIN"),
            "users/other-uid": {**staff(OTHER, "INSTRUCTOR"), "orgId": "other"},
            "organizations/demo/roomCodes/ABCDEFGH": {
                "roomId": "room-1",
                "status": "LIVE",
            },
            "organizations/demo/rooms/room-1": {
                "id": "room-1",
                "orgId": "demo",
                "schemaVersion": 1,
                "title": "테스트 강의방",
                "status": "LIVE",
                "roomCode": "ABCDEFGH",
                "revision": 2,
                "leadInstructorUid": LEAD.uid,
                "instructorMemberUids": [LEAD.uid, ASSISTANT.uid],
                "roomInstructors": [
                    {
                        "uid": LEAD.uid,
                        "role": "LEAD",
                        "permissions": {
                            "questionOperations": True,
                            "checklistProgress": True,
                            "capacityOperations": True,
                        },
                    },
                    {
                        "uid": ASSISTANT.uid,
                        "role": "ASSISTANT",
                        "permissions": {
                            "questionOperations": True,
                            "checklistProgress": False,
                            "capacityOperations": False,
                        },
                    },
                ],
            },
            (
                "organizations/demo/rooms/room-1/participants/anonymous-student"
            ): participant("차분한 연필"),
            "organizations/demo/rooms/room-1/flowItems/item-1": flow(
                "item-1", 0, "첫 항목"
            ),
            "organizations/demo/rooms/room-1/flowItems/item-2": flow(
                "item-2", 1, "둘째 항목"
            ),
        }

    def read_document(self, path: str) -> Mapping[str, Any] | None:
        value = self.documents.get(path)
        return copy.deepcopy(value) if value is not None else None

    def list_room_flow_items(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        prefix = f"organizations/{org_id}/rooms/{room_id}/flowItems/"
        return [
            copy.deepcopy(value)
            for path, value in self.documents.items()
            if path.startswith(prefix)
        ]

    def list_room_questions(
        self, *, org_id: str, room_id: str
    ) -> list[Mapping[str, Any]]:
        prefix = f"organizations/{org_id}/rooms/{room_id}/questions/"
        return [
            copy.deepcopy(value)
            for path, value in self.documents.items()
            if path.startswith(prefix)
        ]

    def run_transaction(
        self, callback: Callable[[CloudQuestionTransaction], Result]
    ) -> Result:
        transaction = InMemoryQuestionTransaction(self.documents)
        result = callback(transaction)
        self.documents.update(transaction.pending)
        return result


def staff(identity: VerifiedCloudIdentity, role: str) -> dict[str, Any]:
    return {
        "uid": identity.uid,
        "orgId": "demo",
        "accountType": "STAFF",
        "organizationRole": role,
        "organizationRoleRevision": 1,
    }


def participant(nickname: str) -> dict[str, Any]:
    return {
        "nickname": nickname,
        "nicknameNormalized": nickname,
        "participantStatus": "JOINED",
        "isAnonymous": True,
    }


def flow(item_id: str, position: int, title: str) -> dict[str, Any]:
    return {
        "chapterId": "chapter-1",
        "chapterTitle": "첫 챕터",
        "chapterPosition": 0,
        "itemId": item_id,
        "itemTitle": title,
        "itemDescription": "설명",
        "itemPosition": position,
        "isCompleted": False,
    }


def service(
    repository: InMemoryQuestionRepository | None = None, *, now: datetime = NOW
) -> tuple[CloudQuestionService, InMemoryQuestionRepository]:
    repo = repository or InMemoryQuestionRepository()
    return CloudQuestionService(repo, cloud_settings(), clock=lambda: now), repo


def create(
    service: CloudQuestionService,
    *,
    content: str = "첫 번째 일반 질문입니다",
    item_id: str | None = None,
    request_id: str = "question-request-0001",
) -> dict[str, Any]:
    return service.create_student_question(
        STUDENT,
        "demo",
        "ABCDEFGH",
        {"content": content, "itemId": item_id, "clientRequestId": request_id},
    )


def question_document(
    repo: InMemoryQuestionRepository, question_id: str
) -> dict[str, Any]:
    return repo.documents[f"organizations/demo/rooms/room-1/questions/{question_id}"]


def test_student_creates_general_and_item_questions_with_public_private_split() -> None:
    questions, repo = service()
    general = create(questions)
    item = create(
        questions,
        content="둘째 항목이 궁금합니다",
        item_id="item-2",
        request_id="question-request-0002",
    )

    general_document = question_document(repo, general["id"])
    item_document = question_document(repo, item["id"])
    assert general_document["isGeneral"] is True
    assert general_document["itemId"] is None
    assert item_document["isGeneral"] is False
    assert item_document["itemNumberSnapshot"] == "1.2"
    assert item_document["itemTitleSnapshot"] == "둘째 항목"
    assert "authorUid" not in general_document
    assert "anonymous" not in str(general_document)
    author = repo.documents[
        f"organizations/demo/rooms/room-1/questionAuthors/{general['id']}"
    ]
    assert author["authorUid"] == STUDENT.uid
    questions.answer_question(
        LEAD, "room-1", item["id"], "둘째 항목부터 다시 확인해 주세요."
    )
    student_feed = questions.student_questions(STUDENT, "demo", "ABCDEFGH")
    assert len(student_feed["questions"]) == 2
    assert "visibility" not in student_feed["questions"][0]
    assert STUDENT.uid not in str(student_feed)
    assert "staffDisplayName" not in str(student_feed)
    item_from_feed = next(
        question
        for question in student_feed["questions"]
        if question["id"] == item["id"]
    )
    assert item_from_feed["answer"]["content"] == "둘째 항목부터 다시 확인해 주세요."
    assert "staffDisplayName" not in item_from_feed["answer"]


def test_question_permission_allows_assistant_operations_but_not_room_admin() -> None:
    questions, _ = service()
    question = create(questions)

    answered = questions.answer_question(
        ASSISTANT, "room-1", question["id"], "보조 강사 답변"
    )
    assert answered["isAnswered"] is True
    hidden = questions.set_hidden(ASSISTANT, "room-1", question["id"], hidden=True)
    assert hidden["isHidden"] is True
    restored = questions.set_hidden(ASSISTANT, "room-1", question["id"], hidden=False)
    assert restored["isHidden"] is False
    assert questions.mark_read(ASSISTANT, "room-1", "GENERAL", question["id"])["marked"]
    with pytest.raises(AccessDenied, match="cannot operate questions"):
        questions.answer_question(ADMIN, "room-1", question["id"], "권한 없음")


def test_ended_room_rejects_question_management() -> None:
    questions, repo = service()
    question = create(questions)
    repo.documents["organizations/demo/rooms/room-1"]["status"] = "ENDED"

    with pytest.raises(ResourceConflict, match="after the room ends"):
        questions.answer_question(LEAD, "room-1", question["id"], "종료 뒤 답변")
    with pytest.raises(ResourceConflict, match="after the room ends"):
        questions.set_hidden(LEAD, "room-1", question["id"], hidden=True)


def test_ended_lead_exports_sorted_kst_csv_without_private_identifiers() -> None:
    questions, repo = service()
    general = create(
        questions,
        content="나중에 작성된 일반 질문",
        request_id="export-general-question",
    )
    item = create(
        questions,
        content="먼저 작성된 항목 질문",
        item_id="item-2",
        request_id="export-item-question",
    )
    item_document = question_document(repo, item["id"])
    item_document.update(
        {
            "createdAt": NOW,
            "updatedAt": NOW,
            "nicknameSnapshot": "사용하면 안 되는 별명",
            "isHidden": True,
            "isAnswered": True,
            "answer": {
                "content": "강사 공식 답변",
                "answeredAt": NOW + timedelta(minutes=5),
                "staffDisplayName": LEAD.display_name,
            },
        }
    )
    general_document = question_document(repo, general["id"])
    general_document["createdAt"] = NOW + timedelta(minutes=1)
    general_document["updatedAt"] = NOW + timedelta(minutes=1)
    room = repo.documents["organizations/demo/rooms/room-1"]
    room.update(
        {
            "status": "ENDED",
            "endedAt": NOW - timedelta(days=1),
            "materialDownloadPolicy": {
                "downloadAvailableUntil": (NOW + timedelta(days=1)).isoformat(),
            },
        }
    )
    original_documents = copy.deepcopy(repo.documents)

    payload = questions.export_ended_room_questions_csv(LEAD, "room-1")

    assert payload.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(StringIO(payload.decode("utf-8-sig"))))
    assert rows[0] == [
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
    assert rows[1] == [
        "1",
        "2026-07-25 18:00:00 KST",
        "항목 질문",
        "1",
        "2",
        "둘째 항목",
        "차분한 연필",
        "먼저 작성된 항목 질문",
        "강사 공식 답변",
        "2026-07-25 18:05:00 KST",
        "숨김",
    ]
    assert rows[2][0:3] == ["2", "2026-07-25 18:01:00 KST", "일반 질문"]
    assert rows[2][3:6] == ["", "", ""]
    rendered = payload.decode("utf-8-sig")
    for forbidden in (
        LEAD.uid,
        LEAD.email,
        STUDENT.uid,
        "ABCDEFGH",
        general["id"],
        item["id"],
        "organizations/",
        "token",
        "사용하면 안 되는 별명",
    ):
        assert forbidden not in rendered
    assert repo.documents == original_documents


def test_question_csv_export_requires_open_ended_lead_access() -> None:
    questions, repo = service()
    room = repo.documents["organizations/demo/rooms/room-1"]
    room.update({"status": "ENDED", "endedAt": NOW - timedelta(days=6)})

    assert questions.export_ended_room_questions_csv(LEAD, "room-1").startswith(
        b"\xef\xbb\xbf"
    )
    for identity in (ASSISTANT, ADMIN, OTHER, STUDENT):
        with pytest.raises(AccessDenied):
            questions.export_ended_room_questions_csv(identity, "room-1")  # type: ignore[arg-type]

    room["endedAt"] = NOW - timedelta(days=8)
    with pytest.raises(AccessDenied, match="deadline"):
        questions.export_ended_room_questions_csv(LEAD, "room-1")

    room.update({"status": "LIVE", "endedAt": None})
    with pytest.raises(ResourceConflict, match="only after the room ends"):
        questions.export_ended_room_questions_csv(LEAD, "room-1")


def test_question_idempotency_spam_and_moderation_policies() -> None:
    questions, repo = service()
    first = create(questions)
    repeated = create(questions)
    assert first == repeated
    assert len(repo.list_room_questions(org_id="demo", room_id="room-1")) == 1
    creation_audits = [
        document
        for path, document in repo.documents.items()
        if "/auditLogs/" in path and document.get("eventType") == "QUESTION_CREATED"
    ]
    assert len(creation_audits) == 1
    assert creation_audits[0]["questionId"] == first["id"]
    with pytest.raises(QuestionRejected):
        create(questions, content="씨발", request_id="question-request-0002")
    review = create(
        questions,
        content="이 설명은 바보 같아서 어려워요",
        request_id="question-request-0003",
    )
    assert question_document(repo, review["id"])["visibility"] == "STAFF_ONLY"
    assert (
        len(questions.student_questions(STUDENT, "demo", "ABCDEFGH")["questions"]) == 1
    )
    with pytest.raises(ResourceConflict):
        create(
            questions,
            content="첫 번째 일반 질문입니다!!!",
            request_id="question-request-0004",
        )


def test_question_requires_joined_anonymous_student_live_room_and_existing_item() -> (
    None
):
    questions, repo = service()
    with pytest.raises(AccessDenied):
        questions.create_student_question(
            OTHER_STUDENT,
            "demo",
            "ABCDEFGH",
            {
                "content": "질문",
                "itemId": None,
                "clientRequestId": "question-request-0101",
            },
        )
    with pytest.raises(AccessDenied):
        questions.create_student_question(
            STUDENT,
            "other-org",
            "ABCDEFGH",
            {
                "content": "다른 조직 질문",
                "itemId": None,
                "clientRequestId": "question-request-0104",
            },
        )
    repo.documents["organizations/demo/rooms/room-1"]["status"] = "READY"
    with pytest.raises(AccessDenied):
        create(questions, request_id="question-request-0102")
    repo.documents["organizations/demo/rooms/room-1"]["status"] = "LIVE"
    with pytest.raises(InvalidOperation):
        create(questions, item_id="missing-item", request_id="question-request-0103")
    assert (
        repo.documents["organizations/demo/rooms/room-1/flowItems/item-1"][
            "isCompleted"
        ]
        is False
    )
    assert (
        repo.documents[
            "organizations/demo/rooms/room-1/participants/anonymous-student"
        ]["nickname"]
        == "차분한 연필"
    )


def test_student_checklist_is_read_only_and_exposes_only_public_counts() -> None:
    questions, repo = service()
    public_general = create(questions, request_id="checklist-public-general")
    public_item = create(
        questions,
        content="체크리스트 항목 질문입니다",
        item_id="item-1",
        request_id="checklist-public-item",
    )
    hidden = create(
        questions,
        content="학생 목록에서 숨길 질문입니다",
        request_id="checklist-hidden",
    )
    questions.set_hidden(LEAD, "room-1", hidden["id"], hidden=True)
    staff_only_id = "staff-only-checklist-question"
    repo.documents[
        f"organizations/demo/rooms/room-1/questions/{staff_only_id}"
    ] = {
        **question_document(repo, public_general["id"]),
        "id": staff_only_id,
        "content": "검토 전 질문입니다",
        "visibility": "STAFF_ONLY",
        "isHidden": False,
    }
    original_documents = copy.deepcopy(repo.documents)

    checklist = questions.student_checklist(STUDENT, "demo", "ABCDEFGH")

    assert checklist == {
        "roomTitle": "테스트 강의방",
        "roomStatus": "LIVE",
        "flowItems": [
            {
                "chapterId": "chapter-1",
                "chapterTitle": "첫 챕터",
                "chapterPosition": 0,
                "itemId": "item-1",
                    "itemTitle": "첫 항목",
                    "itemDescription": "설명",
                    "sourcePageOrSlideNumbers": [],
                    "itemPosition": 0,
                "itemNumber": "1.1",
                "isCompleted": False,
            },
            {
                "chapterId": "chapter-1",
                "chapterTitle": "첫 챕터",
                "chapterPosition": 0,
                "itemId": "item-2",
                    "itemTitle": "둘째 항목",
                    "itemDescription": "설명",
                    "sourcePageOrSlideNumbers": [],
                    "itemPosition": 1,
                "itemNumber": "1.2",
                "isCompleted": False,
            },
        ],
        "currentItemId": "item-1",
        "isComplete": False,
        "summary": {
            "allCount": 2,
            "itemCounts": [
                {"itemId": "item-1", "totalCount": 1},
                {"itemId": "item-2", "totalCount": 0},
            ],
        },
    }
    assert repo.documents == original_documents
    assert "anonymous-student" not in str(checklist)
    assert "lead-uid" not in str(checklist)
    assert staff_only_id not in str(checklist)
    assert public_general["id"] not in str(checklist)
    assert public_item["id"] not in str(checklist)

    repo.documents["organizations/demo/rooms/room-1/flowItems/item-1"][
        "isCompleted"
    ] = True
    repo.documents["organizations/demo/rooms/room-1"]["status"] = "READY"
    ready = questions.student_checklist(STUDENT, "demo", "ABCDEFGH")
    assert ready["currentItemId"] == "item-2"
    assert ready["flowItems"][0]["isCompleted"] is True

    with pytest.raises(AccessDenied):
        questions.student_checklist(OTHER_STUDENT, "demo", "ABCDEFGH")
    with pytest.raises(AccessDenied):
        questions.student_checklist(STUDENT, "other-org", "ABCDEFGH")


def test_lead_answer_cancel_hide_restore_and_admin_read_only() -> None:
    questions, repo = service()
    receipt = create(questions)
    answered = questions.answer_question(
        LEAD, "room-1", receipt["id"], "첫 항목부터 다시 확인해 주세요."
    )
    assert answered["answer"]["roomRole"] == "LEAD"
    with pytest.raises(AccessDenied):
        questions.answer_question(ADMIN, "room-1", receipt["id"], "관리자 답변")
    with pytest.raises(AccessDenied):
        questions.set_hidden(ADMIN, "room-1", receipt["id"], hidden=True)
    hidden = questions.set_hidden(LEAD, "room-1", receipt["id"], hidden=True)
    assert hidden["isHidden"] is True
    assert questions.student_questions(STUDENT, "demo", "ABCDEFGH")["questions"] == []
    restored = questions.set_hidden(LEAD, "room-1", receipt["id"], hidden=False)
    assert restored["isHidden"] is False
    cancelled = questions.cancel_answer(LEAD, "room-1", receipt["id"])
    assert cancelled["answer"] is None and cancelled["isAnswered"] is False
    staff_feed = questions.staff_questions(ADMIN, "room-1")
    assert staff_feed["currentRole"] == "ADMIN"
    assert staff_feed["questions"][0]["nicknameSnapshot"] == "차분한 연필"


def test_read_context_and_item_summary_do_not_expose_author_identity() -> None:
    questions, repo = service()
    first = create(questions, item_id="item-1")
    later_service, _ = service(repo, now=NOW + timedelta(seconds=40))
    create(
        later_service, content="일반 질문 하나 더", request_id="question-request-0202"
    )
    before = later_service.staff_question_summary(LEAD, "room-1")
    assert before["allCount"] == before["newCount"] == 2
    assert (
        next(item for item in before["itemCounts"] if item["itemId"] == "item-1")[
            "totalCount"
        ]
        == 1
    )
    marked = later_service.mark_read(LEAD, "room-1", "ITEM:item-1", first["id"])
    assert marked["contextId"] == "ITEM:item-1"
    after = later_service.staff_question_summary(LEAD, "room-1")
    assert (
        next(item for item in after["itemCounts"] if item["itemId"] == "item-1")[
            "newCount"
        ]
        == 0
    )
    assert first["id"] not in str(after)


def test_all_read_covers_context_badges_and_read_audits_only_advance() -> None:
    questions, repo = service()
    first_item = create(questions, item_id="item-1")
    general = create(
        questions,
        content="일반 질문입니다",
        request_id="question-request-0302",
    )
    second_item = create(
        questions,
        content="둘째 항목 질문입니다",
        item_id="item-2",
        request_id="question-request-0303",
    )
    for receipt, timestamp in (
        (first_item, NOW),
        (general, NOW + timedelta(seconds=10)),
        (second_item, NOW + timedelta(seconds=20)),
    ):
        document = question_document(repo, receipt["id"])
        document["createdAt"] = timestamp
        document["updatedAt"] = timestamp
    original_questions = copy.deepcopy(
        {
            question_id: question_document(repo, question_id)
            for question_id in (first_item["id"], general["id"], second_item["id"])
        }
    )
    original_participant = copy.deepcopy(
        repo.documents[
            "organizations/demo/rooms/room-1/participants/anonymous-student"
        ]
    )

    before = questions.staff_question_summary(LEAD, "room-1")
    assert before["newCount"] == 3
    assert before["generalNewCount"] == 1
    assert {
        count["itemId"]: count["newCount"] for count in before["itemCounts"]
    } == {"item-1": 1, "item-2": 1}

    first_read = questions.mark_read(LEAD, "room-1", "ALL", second_item["id"])
    assert first_read == {
        "contextId": "ALL",
        "marked": True,
        "lastReadQuestionId": second_item["id"],
    }
    after_all = questions.staff_question_summary(LEAD, "room-1")
    assert after_all["newCount"] == after_all["generalNewCount"] == 0
    assert all(count["newCount"] == 0 for count in after_all["itemCounts"])

    repeated = questions.mark_read(LEAD, "room-1", "ALL", second_item["id"])
    past = questions.mark_read(LEAD, "room-1", "ALL", general["id"])
    assert repeated["marked"] is False
    assert past["marked"] is False
    read_audits = [
        document
        for path, document in repo.documents.items()
        if "/auditLogs/" in path and document.get("eventType") == "QUESTION_READ"
    ]
    assert len(read_audits) == 1
    audit = read_audits[0]
    assert audit == {
        "eventType": "QUESTION_READ",
        "orgId": "demo",
        "roomId": "room-1",
        "contextId": "ALL",
        "observedQuestionId": second_item["id"],
        "actorUid": LEAD.uid,
        "createdAt": NOW,
        "schemaVersion": 1,
    }
    assert "content" not in audit and "email" not in audit and "token" not in audit
    assert STUDENT.uid not in str(audit)
    assert {
        question_id: question_document(repo, question_id)
        for question_id in original_questions
    } == original_questions
    assert (
        repo.documents[
            "organizations/demo/rooms/room-1/participants/anonymous-student"
        ]
        == original_participant
    )

    later_service, _ = service(repo, now=NOW + timedelta(seconds=31))
    new_general = create(
        later_service,
        content="새 일반 질문입니다",
        request_id="question-request-0304",
    )
    question_document(repo, new_general["id"])["createdAt"] = NOW + timedelta(
        seconds=31
    )
    with_new_general = later_service.staff_question_summary(LEAD, "room-1")
    assert with_new_general["newCount"] == with_new_general["generalNewCount"] == 1
    assert later_service.mark_read(
        LEAD, "room-1", "GENERAL", new_general["id"]
    )["marked"] is True
    after_general = later_service.staff_question_summary(LEAD, "room-1")
    assert after_general["newCount"] == 1
    assert after_general["generalNewCount"] == 0

    new_item = create(
        later_service,
        content="새 항목 질문입니다",
        item_id="item-2",
        request_id="question-request-0305",
    )
    question_document(repo, new_item["id"])["createdAt"] = NOW + timedelta(
        seconds=40
    )
    with_new_item = later_service.staff_question_summary(LEAD, "room-1")
    assert with_new_item["newCount"] == 2
    assert {
        count["itemId"]: count["newCount"]
        for count in with_new_item["itemCounts"]
    } == {"item-1": 0, "item-2": 1}
    assert later_service.mark_read(
        LEAD, "room-1", "ITEM:item-2", new_item["id"]
    )["marked"] is True
    assert {
        count["itemId"]: count["newCount"]
        for count in later_service.staff_question_summary(LEAD, "room-1")["itemCounts"]
    } == {"item-1": 0, "item-2": 0}

    with pytest.raises(ResourceNotFound):
        later_service.mark_read(LEAD, "room-1", "GENERAL", first_item["id"])
    with pytest.raises(ResourceNotFound):
        later_service.mark_read(LEAD, "room-1", "ITEM:item-1", general["id"])
    with pytest.raises(AccessDenied):
        later_service.mark_read(OTHER, "room-1", "ALL", new_general["id"])
