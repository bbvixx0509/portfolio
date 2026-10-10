import type { DemoQuestion } from "./demoCourseTypes";

export type QuestionValidationResult =
  | { valid: true; content: string }
  | {
      valid: false;
      reason: "EMPTY" | "INAPPROPRIATE" | "SPAM";
      message: string;
    };

const blockedWords = ["바보", "욕설"];

function normalizeQuestion(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");
}

export function validateDemoQuestion(
  value: string,
  questions: readonly DemoQuestion[],
): QuestionValidationResult {
  const content = value.trim();

  if (!content) {
    return {
      valid: false,
      reason: "EMPTY",
      message: "질문 내용을 입력해 주세요.",
    };
  }

  const normalized = normalizeQuestion(content);
  if (blockedWords.some((word) => normalized.includes(word))) {
    return {
      valid: false,
      reason: "INAPPROPRIATE",
      message: "개발용 차단: mock 욕설 규칙에 해당하는 표현이 있어요.",
    };
  }

  const lastUserQuestion = [...questions]
    .reverse()
    .find((question) => question.origin === "USER");
  const duplicatesLastQuestion =
    lastUserQuestion !== undefined &&
    normalizeQuestion(lastUserQuestion.content) === normalized;
  const hasRepeatedCharacters = /(.)\1{4,}/u.test(normalized);

  if (duplicatesLastQuestion || hasRepeatedCharacters) {
    return {
      valid: false,
      reason: "SPAM",
      message: "개발용 차단: 동일 질문 또는 반복 문자가 감지됐어요.",
    };
  }

  return { valid: true, content };
}
