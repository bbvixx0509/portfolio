import re
import unicodedata

NICKNAME_MIN_LENGTH = 2
NICKNAME_MAX_LENGTH = 16
PUBLIC_ROOM_CODE_PATTERN = re.compile(r"^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$")
NICKNAME_PATTERN = re.compile(r"^[0-9A-Za-z가-힣 ]+$")


def normalize_participant_nickname(value: object) -> str:
    """Validate the deliberately small 02-7A nickname contract.

    This is intentionally separate from the legacy auth-only student-session
    nickname policy.  Profanity filtering belongs to a later chat stage; the
    participant contract only permits ordinary Korean/English/digit/space text.
    """

    if not isinstance(value, str):
        raise ValueError("별명은 문자열이어야 합니다.")

    nickname = unicodedata.normalize("NFC", value).strip()
    if not nickname:
        raise ValueError("별명을 입력해 주세요.")
    if any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"}
        for character in nickname
    ):
        raise ValueError("별명에 제어 문자를 사용할 수 없습니다.")
    if len(nickname) < NICKNAME_MIN_LENGTH:
        raise ValueError("별명은 2자 이상 입력해 주세요.")
    if len(nickname) > NICKNAME_MAX_LENGTH:
        raise ValueError("별명은 16자 이하로 입력해 주세요.")
    if not NICKNAME_PATTERN.fullmatch(nickname):
        raise ValueError("별명은 한글, 영문, 숫자, 공백만 사용할 수 있습니다.")
    return nickname


def normalize_participant_nickname_key(value: str) -> str:
    """Create a stable, display-safe duplicate key without changing the label."""

    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def normalize_public_room_code(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("invalid room code")
    room_code = value.strip().upper()
    if not PUBLIC_ROOM_CODE_PATTERN.fullmatch(room_code):
        raise ValueError("invalid room code")
    return room_code
