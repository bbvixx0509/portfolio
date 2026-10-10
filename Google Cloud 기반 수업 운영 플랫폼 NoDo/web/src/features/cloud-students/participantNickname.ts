const adjectives = ["맑은", "차분한", "푸른", "따뜻한", "밝은", "고요한"] as const;
const nouns = ["구름", "별빛", "연필", "햇살", "노트", "바람"] as const;
const nicknamePattern = /^[0-9A-Za-z가-힣 ]+$/u;
const controlCharacterPattern = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function createRandomParticipantNickname(random = Math.random) {
  const adjective = adjectives[Math.min(adjectives.length - 1, Math.max(0, Math.floor(random() * adjectives.length)))];
  const noun = nouns[Math.min(nouns.length - 1, Math.max(0, Math.floor(random() * nouns.length)))];
  return `${adjective} ${noun}`;
}

export function participantNicknameLength(value: string) {
  return Array.from(value.trim()).length;
}

export function validateParticipantNickname(value: unknown) {
  if (typeof value !== "string") {
    return { valid: false as const, message: "별명을 입력해 주세요." };
  }
  const nickname = value.normalize("NFC").trim();
  if (!nickname) {
    return { valid: false as const, message: "별명을 입력해 주세요." };
  }
  if (controlCharacterPattern.test(nickname)) {
    return { valid: false as const, message: "별명에 제어 문자를 사용할 수 없습니다." };
  }
  const length = Array.from(nickname).length;
  if (length < 2) {
    return { valid: false as const, message: "별명은 2자 이상 입력해 주세요." };
  }
  if (length > 16) {
    return { valid: false as const, message: "별명은 16자 이하로 입력해 주세요." };
  }
  if (!nicknamePattern.test(nickname)) {
    return { valid: false as const, message: "별명은 한글, 영문, 숫자, 공백만 사용할 수 있습니다." };
  }
  return { valid: true as const, nickname };
}
