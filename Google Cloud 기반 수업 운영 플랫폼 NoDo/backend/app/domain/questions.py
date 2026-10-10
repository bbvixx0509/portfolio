import hashlib
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from app.domain.errors import QuestionRejected

QUESTION_MAX_LENGTH = 500
ANSWER_MAX_LENGTH = 2000
QUESTION_RATE_WINDOW_SECONDS = 10
QUESTION_RATE_MAX_COUNT = 3
QUESTION_REPEAT_WINDOW_SECONDS = 30
QUESTION_SIMILARITY_THRESHOLD = 0.8

# 01-3 uses a deliberately small, documented local rule set. It is not an AI
# classifier and must not be presented as one.
BLOCKED_TERMS = frozenset({"씨발", "병신", "개새끼", "욕설"})
REVIEW_TERMS = frozenset({"바보", "멍청", "꺼져", "죽어", "짜증"})


@dataclass(frozen=True)
class ModerationDecision:
    content: str
    normalized: str
    normalized_digest: str
    fingerprint: tuple[str, ...]
    moderation_status: str
    visibility: str


def _strip_control_characters(value: str) -> str:
    return "".join(
        character
        for character in value
        if character in {"\n", "\t"}
        or not unicodedata.category(character).startswith("C")
    )


def sanitize_plain_text(value: str, *, maximum_length: int) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    cleaned = _strip_control_characters(normalized).strip()
    if not cleaned:
        raise QuestionRejected("질문 내용을 입력해 주세요.")
    if len(cleaned) > maximum_length:
        raise QuestionRejected(f"내용은 {maximum_length}자 이하여야 합니다.")
    return cleaned


def normalize_for_comparison(value: str) -> str:
    return re.sub(r"[^0-9a-zA-Z가-힣]+", "", value.casefold())


def _fingerprint(value: str) -> tuple[str, ...]:
    if len(value) < 3:
        grams = {value}
    else:
        grams = {value[index : index + 3] for index in range(len(value) - 2)}
    return tuple(
        sorted(hashlib.sha256(gram.encode("utf-8")).hexdigest()[:16] for gram in grams)
    )


def moderate_question(value: str) -> ModerationDecision:
    content = sanitize_plain_text(value, maximum_length=QUESTION_MAX_LENGTH)
    normalized = normalize_for_comparison(content)
    if not normalized:
        raise QuestionRejected("질문 내용을 입력해 주세요.")
    if any(term in normalized for term in BLOCKED_TERMS):
        raise QuestionRejected("안전한 표현으로 질문을 다시 작성해 주세요.")
    needs_review = any(term in normalized for term in REVIEW_TERMS)
    return ModerationDecision(
        content=content,
        normalized=normalized,
        normalized_digest=hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        fingerprint=_fingerprint(normalized),
        moderation_status="NEEDS_REVIEW" if needs_review else "APPROVED",
        visibility="STAFF_ONLY" if needs_review else "PUBLIC",
    )


def sanitize_answer(value: str) -> str:
    return sanitize_plain_text(value, maximum_length=ANSWER_MAX_LENGTH)


def fingerprints_are_similar(left: list[str], right: tuple[str, ...]) -> bool:
    left_set = set(left)
    right_set = set(right)
    if not left_set or not right_set:
        return left_set == right_set
    score = len(left_set & right_set) / len(left_set | right_set)
    return score >= QUESTION_SIMILARITY_THRESHOLD


def public_question(document: dict[str, Any]) -> dict[str, Any]:
    """Defensively remove every server-only field before an API response."""
    allowed = {
        "id",
        "roomId",
        "courseId",
        "orgId",
        "content",
        "nicknameSnapshot",
        "isGeneral",
        "itemId",
        "itemNumberSnapshot",
        "itemTitleSnapshot",
        "chapterTitleSnapshot",
        "materialLabelSnapshot",
        "visibility",
        "moderationStatus",
        "isAnswered",
        "answer",
        "isHidden",
        "createdAt",
        "updatedAt",
        "schemaVersion",
    }
    result = {key: value for key, value in document.items() if key in allowed}
    answer = result.get("answer")
    if isinstance(answer, dict):
        answer_fields = {
            "content",
            "staffDisplayName",
            "roomRole",
            # Read-only compatibility for 01-3 Emulator documents.
            "staffRole",
            "instructorRole",
            "answeredAt",
        }
        result["answer"] = {
            key: value for key, value in answer.items() if key in answer_fields
        }
    return result


def question_creation_response(document: dict[str, Any]) -> dict[str, Any]:
    """Return one generic receipt without revealing moderation classification."""
    return {
        "id": document["id"],
        "roomId": document["roomId"],
        "accepted": True,
    }
