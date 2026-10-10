import pytest
from test_cloud_questions import STUDENT, service

from app.domain.errors import ServiceTemporarilyUnavailable
from app.services.cloud_student_assistant_service import CloudStudentAssistantService


class CapturingAssistantAdapter:
    def __init__(
        self, response: str = "핵심 개념을 쉬운 예시와 함께 설명합니다."
    ) -> None:
        self.response = response
        self.prompts: list[str] = []

    def generate_student_assistant_reply(self, *, prompt: str) -> str:
        self.prompts.append(prompt)
        return self.response


def test_student_assistant_scopes_the_prompt_to_the_joined_room_and_item() -> None:
    questions, _ = service()
    adapter = CapturingAssistantAdapter()
    assistant = CloudStudentAssistantService(questions, adapter)

    result = assistant.answer(
        STUDENT,
        "demo",
        "ABCDEFGH",
        content="이 부분을 쉽게 설명해 주세요.",
        item_id="item-2",
    )

    assert result == {
        "reply": "핵심 개념을 쉬운 예시와 함께 설명합니다.",
        "context": {"itemId": "item-2", "itemTitle": "둘째 항목"},
        "notice": (
            "AI 도우미 답변은 학습 보조용이며, 공식 안내는 강사 답변을 "
            "확인해 주세요."
        ),
    }
    assert len(adapter.prompts) == 1
    assert "테스트 강의방" in adapter.prompts[0]
    assert "둘째 항목" in adapter.prompts[0]
    assert "이 부분을 쉽게 설명해 주세요." in adapter.prompts[0]
    assert STUDENT.uid not in adapter.prompts[0]


def test_student_assistant_is_closed_when_vertex_is_not_configured() -> None:
    questions, _ = service()
    assistant = CloudStudentAssistantService(questions, None)

    with pytest.raises(ServiceTemporarilyUnavailable):
        assistant.answer(
            STUDENT,
            "demo",
            "ABCDEFGH",
            content="도와주세요",
            item_id=None,
        )
