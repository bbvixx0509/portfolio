import type {
  CourseFlowItem,
  DemoChapter,
  DemoCourseInfo,
  DemoMaterial,
  DemoQuestion,
} from "../features/demo-course/demoCourseTypes";
import { importCourseMocks } from "./importPageMocks";

export const demoCourseInfo: Readonly<DemoCourseInfo> = {
  id: "demo-course",
  title: "벡터DB & RAG 실무 강의",
  status: "PREPARING",
  roomCode: "482913",
};

export const demoCourseChapters: readonly Readonly<DemoChapter>[] = [
  {
    id: "chapter-vector",
    title: "벡터 DB 개념",
    itemIds: ["flow-vector", "flow-embedding", "flow-pinecone"],
  },
  {
    id: "chapter-rag",
    title: "RAG 파이프라인",
    itemIds: ["flow-rag", "flow-prompt", "flow-code"],
  },
];

export const demoCourseFlowItems: readonly Readonly<CourseFlowItem>[] = [
  {
    id: "flow-vector",
    chapterId: "chapter-vector",
    title: "벡터DB란 무엇인가",
    description: "벡터DB 개념과 기존 DB와의 차이를 설명해요",
    kind: "SLIDE",
    isCompleted: true,
    materialLabel: "01 · 벡터DB 개념",
  },
  {
    id: "flow-embedding",
    chapterId: "chapter-vector",
    title: "임베딩과 유사도 검색",
    description: "임베딩 벡터로 유사도를 계산하는 원리를 다뤄요",
    kind: "SLIDE",
    isCompleted: true,
    materialLabel: "02 · 임베딩",
  },
  {
    id: "flow-pinecone",
    chapterId: "chapter-vector",
    title: "실습: Pinecone 연동",
    description: "Pinecone에 벡터를 저장하고 검색하는 실습이에요",
    kind: "DATA",
    isCompleted: true,
    materialLabel: "03 · Pinecone",
  },
  {
    id: "flow-rag",
    chapterId: "chapter-rag",
    title: "RAG 개념과 구조",
    description: "검색 결과를 프롬프트에 넣는 RAG 구조를 설명해요",
    kind: "SLIDE",
    isCompleted: true,
    materialLabel: "04 · RAG 구조",
  },
  {
    id: "flow-prompt",
    chapterId: "chapter-rag",
    title: "프롬프트 설계 실습",
    description: "few-shot 예시 개수에 따른 응답 품질을 비교해요",
    kind: "SLIDE",
    isCompleted: true,
    materialLabel: "05 · 프롬프트",
  },
  {
    id: "flow-code",
    chapterId: "chapter-rag",
    title: "실습 코드: prompt_lab.py",
    description: "few-shot 프롬프트 예시 3개를 정의하는 코드예요",
    kind: "CODE",
    isCompleted: false,
    materialLabel: "CODE · prompt_lab.py",
  },
];

export const demoCourseQuestions: readonly Readonly<DemoQuestion>[] = [
  {
    id: "question-embedding-1",
    nickname: "차분한 부엉이",
    avatar: "🦉",
    content: "코사인 유사도 말고 다른 방식도 사용하나요?",
    itemId: "flow-embedding",
    isGeneral: false,
    answered: true,
    hidden: false,
    needsReview: false,
    unread: false,
    answer: "거리 기준에 따라 내적이나 유클리드 거리도 사용할 수 있어요.",
    origin: "MOCK",
  },
  {
    id: "question-embedding-2",
    nickname: "빠른 토끼",
    avatar: "🐰",
    content: "임베딩 차원은 높을수록 좋은가요?",
    itemId: "flow-embedding",
    isGeneral: false,
    answered: true,
    hidden: false,
    needsReview: false,
    unread: false,
    answer: "정확도와 비용을 함께 비교해서 선택해야 해요.",
    origin: "MOCK",
  },
  {
    id: "question-embedding-3",
    nickname: "궁금한 라쿤",
    avatar: "🦝",
    content: "문장이 길면 임베딩 결과가 달라지나요?",
    itemId: "flow-embedding",
    isGeneral: false,
    answered: false,
    hidden: false,
    needsReview: false,
    unread: true,
    origin: "MOCK",
  },
  {
    id: "question-prompt-1",
    nickname: "조용한 판다",
    avatar: "🐼",
    content: "프롬프트에 예시를 몇 개까지 넣어야 하나요?",
    itemId: "flow-prompt",
    isGeneral: false,
    answered: true,
    hidden: false,
    needsReview: false,
    unread: false,
    answer: "3~5개 정도가 적당해요! 너무 많으면 오히려 헷갈릴 수 있어요 🙂",
    origin: "MOCK",
  },
  {
    id: "question-prompt-2",
    nickname: "배고픈 여우",
    avatar: "🦊",
    content: "few-shot이랑 zero-shot 차이가 헷갈려요",
    itemId: "flow-prompt",
    isGeneral: false,
    answered: false,
    hidden: false,
    needsReview: false,
    unread: true,
    origin: "MOCK",
  },
  {
    id: "question-prompt-3",
    nickname: "배고픈 펭귄",
    avatar: "🐧",
    content: "예시 순서도 응답에 영향을 주나요?",
    itemId: "flow-prompt",
    isGeneral: false,
    answered: false,
    hidden: false,
    needsReview: false,
    unread: false,
    origin: "MOCK",
  },
  {
    id: "question-prompt-4",
    nickname: "느긋한 고양이",
    avatar: "🐱",
    content: "system prompt와 user prompt를 어떻게 나누나요?",
    itemId: "flow-prompt",
    isGeneral: false,
    answered: true,
    hidden: false,
    needsReview: false,
    unread: false,
    answer: "역할과 고정 규칙은 system prompt에 두면 관리하기 쉬워요.",
    origin: "MOCK",
  },
  {
    id: "question-prompt-5",
    nickname: "졸린 수달",
    avatar: "🦦",
    content: "이거 좀 별로인듯ㅋㅋ 시간 낭비...",
    itemId: "flow-prompt",
    isGeneral: false,
    answered: false,
    hidden: false,
    needsReview: true,
    unread: true,
    origin: "MOCK",
  },
  {
    id: "question-code-1",
    nickname: "든든한 코알라",
    avatar: "🐨",
    content: "examples 리스트 형식이 꼭 딕셔너리여야 하나요?",
    itemId: "flow-code",
    isGeneral: false,
    answered: false,
    hidden: false,
    needsReview: false,
    unread: true,
    origin: "MOCK",
  },
  {
    id: "question-code-2",
    nickname: "성실한 비버",
    avatar: "🦫",
    content: "함수 반환값을 문자열로 두는 이유가 궁금해요.",
    itemId: "flow-code",
    isGeneral: false,
    answered: true,
    hidden: false,
    needsReview: false,
    unread: false,
    answer: "완성된 프롬프트를 그대로 모델 입력에 사용하기 위해서예요.",
    origin: "MOCK",
  },
  {
    id: "question-general-1",
    nickname: "활기찬 돌고래",
    avatar: "🐬",
    content: "오늘 실습 파일은 수업 뒤에도 받을 수 있나요?",
    itemId: null,
    isGeneral: true,
    answered: false,
    hidden: false,
    needsReview: false,
    unread: false,
    origin: "MOCK",
  },
];

type ImportedChapterBlueprint = Readonly<{
  title: string;
  items: readonly string[];
}>;

type ImportedCourseBlueprint = Readonly<{
  materialName: string;
  chapters: readonly ImportedChapterBlueprint[];
}>;

const importedCourseBlueprints: Readonly<
  Record<string, ImportedCourseBlueprint>
> = {
  "vector-rag-practice": {
    materialName: "vector_rag_workbook.pdf",
    chapters: [
      {
        title: "벡터 DB 개념",
        items: [
          "벡터DB란 무엇인가",
          "관계형 DB와의 차이",
          "임베딩 벡터 이해하기",
          "유사도 검색 방식 비교",
        ],
      },
      {
        title: "RAG 파이프라인",
        items: [
          "RAG 개념과 구조",
          "문서 청킹 전략",
          "메타데이터 필터링",
          "검색 결과 평가",
        ],
      },
      {
        title: "실전 연결",
        items: [
          "실습: Pinecone 연동",
          "프롬프트 설계 실습",
          "실습 코드: prompt_lab.py",
          "검색 품질 결과 리뷰",
        ],
      },
    ],
  },
  "frontend-basics": {
    materialName: "frontend_basics.pptx",
    chapters: [
      {
        title: "웹 화면의 기초",
        items: [
          "HTML 문서 구조",
          "의미 있는 태그 사용",
          "CSS 박스 모델",
          "Flex와 Grid 배치",
        ],
      },
      {
        title: "상호작용 만들기",
        items: [
          "반응형 화면 설계",
          "JavaScript와 DOM 이벤트",
          "React 컴포넌트 기초",
          "미니 화면 프로젝트",
        ],
      },
    ],
  },
  "backend-api-basics": {
    materialName: "backend_api_guide.pdf",
    chapters: [
      {
        title: "API 설계 원칙",
        items: [
          "HTTP 요청과 응답",
          "REST 리소스 설계",
          "메서드와 상태 코드",
          "요청·응답 스키마",
          "API 버전 관리",
        ],
      },
      {
        title: "FastAPI 구현",
        items: [
          "FastAPI 개발 환경",
          "라우터 구성",
          "Pydantic 데이터 검증",
          "의존성 주입",
          "예외 처리",
        ],
      },
      {
        title: "운영 준비",
        items: [
          "인증과 권한",
          "CORS 설정",
          "로그와 모니터링",
          "API 자동 테스트",
          "문서화와 배포 점검",
        ],
      },
    ],
  },
  "python-data-camp": {
    materialName: "python_data_camp.zip",
    chapters: [
      {
        title: "Python 데이터 기초",
        items: [
          "분석 환경 준비",
          "변수와 자료형",
          "리스트와 딕셔너리",
          "조건문과 반복문",
          "함수로 코드 나누기",
        ],
      },
      {
        title: "데이터 정리",
        items: [
          "Pandas DataFrame",
          "CSV 불러오기",
          "결측값 확인",
          "데이터 형식 변환",
          "그룹별 집계",
        ],
      },
      {
        title: "분석과 시각화",
        items: [
          "기초 통계 읽기",
          "Matplotlib 그래프",
          "분포 비교",
          "상관관계 살펴보기",
          "분석 결과 설명하기",
        ],
      },
      {
        title: "캠프 프로젝트",
        items: [
          "질문과 가설 세우기",
          "데이터 전처리",
          "핵심 지표 계산",
          "결과 시각화",
          "프로젝트 발표",
        ],
      },
    ],
  },
  "ux-research-workshop": {
    materialName: "ux_research_notes.pdf",
    chapters: [
      {
        title: "리서치 설계",
        items: [
          "리서치 목표 정하기",
          "참여자 기준 세우기",
          "인터뷰 질문 만들기",
        ],
      },
      {
        title: "인사이트 정리",
        items: [
          "인터뷰 진행과 기록",
          "패턴과 문제점 묶기",
          "인사이트 공유 워크숍",
        ],
      },
    ],
  },
};

export type ImportedDemoCourseSeed = {
  chapters: DemoChapter[];
  items: CourseFlowItem[];
  materials: DemoMaterial[];
  selectedItemId: string | null;
};

export function createImportedDemoCourseSeed(
  courseId: string,
): ImportedDemoCourseSeed | null {
  const course = importCourseMocks.find((candidate) => candidate.id === courseId);
  const blueprint = importedCourseBlueprints[courseId];
  if (!course || !blueprint) {
    return null;
  }

  const flatTitles = blueprint.chapters.flatMap((chapter) => chapter.items);
  const completedCount = Math.floor(
    (flatTitles.length * course.progressPercent) / 100,
  );
  const items: CourseFlowItem[] = [];
  let itemIndex = 0;

  const chapters = blueprint.chapters.map((chapter, chapterIndex) => {
    const chapterId = `import-${courseId}-chapter-${chapterIndex + 1}`;
    const itemIds = chapter.items.map((title) => {
      const currentIndex = itemIndex;
      const itemId = `import-${courseId}-item-${currentIndex + 1}`;
      items.push({
        id: itemId,
        chapterId,
        title,
        description: `${course.title}에서 이어서 편집할 mock 수업 흐름 항목이에요`,
        kind: currentIndex % 5 === 4 ? "CODE" : "SLIDE",
        isCompleted: currentIndex < completedCount,
        materialLabel: `${String(currentIndex + 1).padStart(2, "0")} · ${title}`,
      });
      itemIndex += 1;
      return itemId;
    });
    return { id: chapterId, title: chapter.title, itemIds };
  });

  const firstIncompleteItemId =
    items.find((item) => !item.isCompleted)?.id ?? null;
  return {
    chapters,
    items,
    materials: [
      {
        id: `import-${courseId}-material`,
        name: blueprint.materialName,
        format: blueprint.materialName.endsWith(".pptx")
          ? "PPTX"
          : blueprint.materialName.endsWith(".pdf")
            ? "PDF"
            : "DATA",
      },
    ],
    selectedItemId: firstIncompleteItemId ?? items.at(-1)?.id ?? null,
  };
}
