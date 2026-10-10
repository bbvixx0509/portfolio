import re
import unicodedata

NICKNAME_MIN_LENGTH = 2
NICKNAME_MAX_LENGTH = 16
ROOM_CODE_PATTERN = re.compile(r"^[A-Z0-9]{4,12}$")

# 02-7 intentionally uses a small local rule set. It is not an AI classifier.
BLOCKED_NICKNAME_TERMS = frozenset({"씨발", "병신", "개새끼", "욕설"})
RESERVED_NICKNAME_KEYS = frozenset(
    {
        "관리자",
        "운영자",
        "시스템",
        "공식강사",
        "nodo관리자",
        "nodo운영자",
        "nodo시스템",
        "nodo공식강사",
    }
)


def _policy_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[^0-9a-z가-힣]+", "", normalized)


def normalize_student_nickname(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("참여 이름은 문자열이어야 합니다.")

    nickname = unicodedata.normalize("NFC", value).strip()
    if "\r" in nickname or "\n" in nickname:
        raise ValueError("참여 이름에는 줄바꿈을 사용할 수 없습니다.")
    if any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"} for character in nickname
    ):
        raise ValueError("참여 이름에는 제어 문자를 사용할 수 없습니다.")
    if len(nickname) < NICKNAME_MIN_LENGTH:
        raise ValueError("참여 이름은 2자 이상이어야 합니다.")
    if len(nickname) > NICKNAME_MAX_LENGTH:
        raise ValueError("참여 이름은 16자 이하여야 합니다.")

    policy_key = _policy_key(nickname)
    if any(term in policy_key for term in BLOCKED_NICKNAME_TERMS):
        raise ValueError("사용할 수 없는 참여 이름입니다.")
    if policy_key in RESERVED_NICKNAME_KEYS:
        raise ValueError("강사나 운영자를 나타내는 참여 이름은 사용할 수 없습니다.")

    # The nickname remains plain text. API and React callers must never treat it
    # as HTML.
    return nickname


def normalize_room_code(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("참여 코드는 문자열이어야 합니다.")

    room_code = value.strip()
    if not ROOM_CODE_PATTERN.fullmatch(room_code):
        raise ValueError("참여 코드는 영문 대문자와 숫자 4~12자로 입력해 주세요.")
    return room_code
