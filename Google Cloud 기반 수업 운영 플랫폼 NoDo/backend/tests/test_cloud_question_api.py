from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.dependencies import (
    get_cloud_question_service,
    get_cloud_student_assistant_service,
    get_cloud_verified_identity,
    get_student_authenticated_identity,
)
from app.domain.schemas import (
    CloudQuestionAnswer,
    CloudQuestionCreate,
    CloudQuestionRead,
    StudentAssistantPrompt,
)
from app.main import create_app
from app.services.cloud_auth_service import VerifiedCloudIdentity
from app.services.student_auth_service import VerifiedStudentIdentity

pytestmark = pytest.mark.anyio


class CapturingQuestionService:
    def __init__(self) -> None:
        self.student_created: list[tuple[str, str, dict[str, Any]]] = []
        self.student_checklist_calls: list[tuple[str, str]] = []
        self.staff_calls: list[tuple[str, str]] = []
        self.exported_room_ids: list[str] = []

    def student_questions(
        self, _identity: object, org_id: str, room_code: str
    ) -> dict[str, Any]:
        return {
            "roomTitle": "강의방",
            "nickname": "별명",
            "flowItems": [],
            "questions": [],
        }

    def student_checklist(
        self, _identity: object, org_id: str, room_code: str
    ) -> dict[str, Any]:
        self.student_checklist_calls.append((org_id, room_code))
        return {
            "roomTitle": "강의방",
            "roomStatus": "LIVE",
            "flowItems": [],
            "currentItemId": None,
            "isComplete": False,
            "summary": {"allCount": 0, "itemCounts": []},
        }

    def create_student_question(
        self, _identity: object, org_id: str, room_code: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        self.student_created.append((org_id, room_code, payload))
        return {"id": "masked-question", "roomId": "masked-room", "accepted": True}

    def staff_questions(self, _identity: object, room_id: str) -> dict[str, Any]:
        self.staff_calls.append(("list", room_id))
        return {
            "roomTitle": "강의방",
            "roomStatus": "LIVE",
            "currentRole": "LEAD_INSTRUCTOR",
            "flowItems": [],
            "questions": [],
            "summary": {
                "allCount": 0,
                "newCount": 0,
                "generalCount": 0,
                "generalNewCount": 0,
                "itemCounts": [],
            },
        }

    def staff_question_summary(self, _identity: object, room_id: str) -> dict[str, Any]:
        self.staff_calls.append(("summary", room_id))
        return {
            "allCount": 0,
            "newCount": 0,
            "generalCount": 0,
            "generalNewCount": 0,
            "itemCounts": [],
        }

    def export_ended_room_questions_csv(
        self, _identity: object, room_id: str
    ) -> bytes:
        self.exported_room_ids.append(room_id)
        return b"\xef\xbb\xbf\xec\xa7\x88\xeb\xac\xb8 \xec\x88\x9c\xeb\xb2\x88\r\n1\r\n"

    def answer_question(
        self, _identity: object, room_id: str, question_id: str, content: str
    ) -> dict[str, Any]:
        self.staff_calls.append(("answer", f"{room_id}:{question_id}:{content}"))
        return {"id": question_id, "content": "질문", "answer": {"content": content}}

    def cancel_answer(
        self, _identity: object, room_id: str, question_id: str
    ) -> dict[str, Any]:
        self.staff_calls.append(("cancel", f"{room_id}:{question_id}"))
        return {"id": question_id, "answer": None}

    def set_hidden(
        self, _identity: object, room_id: str, question_id: str, *, hidden: bool
    ) -> dict[str, Any]:
        self.staff_calls.append(
            ("hidden" if hidden else "restore", f"{room_id}:{question_id}")
        )
        return {"id": question_id, "isHidden": hidden}

    def mark_read(
        self,
        _identity: object,
        room_id: str,
        context_id: str,
        observed_question_id: str,
    ) -> dict[str, Any]:
        self.staff_calls.append(
            ("read", f"{room_id}:{context_id}:{observed_question_id}")
        )
        return {"contextId": context_id, "marked": True}


class CapturingStudentAssistantService:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def answer(
        self,
        _identity: object,
        org_id: str,
        room_code: str,
        *,
        content: str,
        item_id: str | None,
    ) -> dict[str, Any]:
        self.calls.append(
            {
                "orgId": org_id,
                "roomCode": room_code,
                "content": content,
                "itemId": item_id,
            }
        )
        return {
            "reply": "학습 보조 답변",
            "context": {"itemId": item_id, "itemTitle": "항목"},
            "notice": "AI 답변은 학습 보조용입니다.",
        }


@pytest.fixture
async def client() -> AsyncIterator[tuple[AsyncClient, CapturingQuestionService]]:
    app = create_app()
    service = CapturingQuestionService()
    app.dependency_overrides[get_cloud_question_service] = lambda: service
    app.dependency_overrides[get_cloud_verified_identity] = lambda: (
        VerifiedCloudIdentity("masked-staff", "masked@example.test", "강사", None)
    )
    app.dependency_overrides[get_student_authenticated_identity] = lambda: (
        VerifiedStudentIdentity("masked-student")
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as value:
        yield value, service
    app.dependency_overrides.clear()


async def test_cloud_question_routes_keep_staff_and_student_contracts_separate(
    client: tuple[AsyncClient, CapturingQuestionService],
) -> None:
    http, service = client
    created = await http.post(
        "/api/public/rooms/demo/ABCDEFGH/questions",
        json={
            "content": "일반 질문",
            "itemId": None,
            "clientRequestId": "request-0001",
        },
    )
    listed = await http.get("/api/cloud/rooms/room-1/questions")
    summary = await http.get("/api/cloud/rooms/room-1/questions/summary")
    answered = await http.post(
        "/api/cloud/rooms/room-1/questions/question-1/answer",
        json={"content": "공식 답변"},
    )
    read = await http.post(
        "/api/cloud/rooms/room-1/questions/read",
        json={"contextId": "ITEM:item-1", "observedQuestionId": "question-1"},
    )

    assert created.status_code == 201
    assert (
        listed.status_code
        == summary.status_code
        == answered.status_code
        == read.status_code
        == 200
    )
    assert service.student_created == [
        (
            "demo",
            "ABCDEFGH",
            {"content": "일반 질문", "itemId": None, "clientRequestId": "request-0001"},
        )
    ]
    assert "masked-student" not in str(created.json())
    assert "example.test" not in str(created.json())
    assert "token" not in str(created.json()).lower()
    assert ("answer", "room-1:question-1:공식 답변") in service.staff_calls
    assert ("read", "room-1:ITEM:item-1:question-1") in service.staff_calls


async def test_student_checklist_route_uses_anonymous_contract_only(
    client: tuple[AsyncClient, CapturingQuestionService],
) -> None:
    http, service = client
    response = await http.get("/api/public/rooms/demo/ABCDEFGH/checklist")

    assert response.status_code == 200
    assert service.student_checklist_calls == [("demo", "ABCDEFGH")]
    assert response.json() == {
        "roomTitle": "강의방",
        "roomStatus": "LIVE",
        "flowItems": [],
        "currentItemId": None,
        "isComplete": False,
        "summary": {"allCount": 0, "itemCounts": []},
    }


async def test_ended_room_question_export_is_a_private_csv_attachment(
    client: tuple[AsyncClient, CapturingQuestionService],
) -> None:
    http, service = client

    response = await http.get("/api/cloud/rooms/room-1/questions/export")

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"] == (
        'attachment; filename="ended-room-questions.csv"'
    )
    assert response.headers["cache-control"] == "no-store"
    assert response.content.startswith(b"\xef\xbb\xbf")
    assert service.exported_room_ids == ["room-1"]


@pytest.mark.parametrize(
    "model",
    [
        CloudQuestionCreate,
        CloudQuestionAnswer,
        CloudQuestionRead,
        StudentAssistantPrompt,
    ],
)
def test_cloud_question_input_models_keep_extra_forbid(model: type[object]) -> None:
    assert model.model_config["extra"] == "forbid"


async def test_cloud_question_routes_reject_server_owned_input(
    client: tuple[AsyncClient, CapturingQuestionService],
) -> None:
    http, service = client
    response = await http.post(
        "/api/public/rooms/demo/ABCDEFGH/questions",
        json={
            "content": "질문",
            "itemId": None,
            "clientRequestId": "request-0002",
            "nicknameSnapshot": "위조",
            "visibility": "PUBLIC",
        },
    )
    assert response.status_code == 422
    assert service.student_created == []


async def test_student_ai_assistant_route_accepts_only_prompt_and_roadmap_context(
) -> None:
    app = create_app()
    assistant = CapturingStudentAssistantService()
    app.dependency_overrides[get_cloud_student_assistant_service] = lambda: assistant
    app.dependency_overrides[get_student_authenticated_identity] = lambda: (
        VerifiedStudentIdentity("masked-student")
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.post(
            "/api/public/rooms/demo/ABCDEFGH/ai-assistant",
            json={"content": "쉽게 설명해 주세요", "itemId": "item-1"},
        )
        rejected = await http.post(
            "/api/public/rooms/demo/ABCDEFGH/ai-assistant",
            json={
                "content": "쉽게 설명해 주세요",
                "itemId": "item-1",
                "roomId": "forged-room",
            },
        )
    app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["reply"] == "학습 보조 답변"
    assert rejected.status_code == 422
    assert assistant.calls == [
        {
            "orgId": "demo",
            "roomCode": "ABCDEFGH",
            "content": "쉽게 설명해 주세요",
            "itemId": "item-1",
        }
    ]


async def test_cloud_question_read_route_requires_observed_question_id(
    # The client timestamp is deliberately rejected; the server reads Firestore time.
    client: tuple[AsyncClient, CapturingQuestionService],
) -> None:
    http, service = client
    missing = await http.post(
        "/api/cloud/rooms/room-1/questions/read", json={"contextId": "ALL"}
    )
    client_time = await http.post(
        "/api/cloud/rooms/room-1/questions/read",
        json={
            "contextId": "ALL",
            "observedQuestionId": "question-1",
            "observedAt": "2026-07-25T09:00:00Z",
        },
    )

    assert missing.status_code == client_time.status_code == 422
    assert not [call for call in service.staff_calls if call[0] == "read"]


async def test_cloud_question_routes_require_firebase_authentication() -> None:
    app = create_app()
    app.dependency_overrides[get_cloud_question_service] = CapturingQuestionService
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        student = await http.get("/api/public/rooms/demo/ABCDEFGH/questions")
        checklist = await http.get("/api/public/rooms/demo/ABCDEFGH/checklist")
        staff = await http.get("/api/cloud/rooms/room-1/questions")
        export = await http.get("/api/cloud/rooms/room-1/questions/export")
    app.dependency_overrides.clear()

    assert (
        student.status_code
        == checklist.status_code
        == staff.status_code
        == export.status_code
        == 401
    )
