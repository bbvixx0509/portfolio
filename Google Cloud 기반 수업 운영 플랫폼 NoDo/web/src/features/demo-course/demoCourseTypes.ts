export type DemoCourseSource =
  | "demo"
  | "material"
  | "manual"
  | `import:${string}`;

export type DemoCourseStatus = "PREPARING" | "LIVE";

export type CourseFlowItemKind = "SLIDE" | "CODE" | "DATA";

export type DemoMaterialFormat = "PPTX" | "PDF" | "CODE" | "DATA";

export type DemoCourseInfo = {
  id: string;
  title: string;
  status: DemoCourseStatus;
  roomCode: string;
};

export type DemoChapter = {
  id: string;
  title: string;
  itemIds: string[];
};

export type CourseFlowItem = {
  id: string;
  chapterId: string;
  title: string;
  description: string;
  kind: CourseFlowItemKind;
  isCompleted: boolean;
  materialLabel: string;
};

export type DemoMaterial = {
  id: string;
  name: string;
  format: DemoMaterialFormat;
};

export type DemoQuestion = {
  id: string;
  nickname: string;
  avatar: string;
  content: string;
  itemId: string | null;
  isGeneral: boolean;
  answered: boolean;
  hidden: boolean;
  needsReview: boolean;
  unread: boolean;
  answer?: string;
  origin: "MOCK" | "USER";
};

export type DemoCourseState = {
  source: DemoCourseSource;
  course: DemoCourseInfo;
  chapters: DemoChapter[];
  items: CourseFlowItem[];
  materials: DemoMaterial[];
  questions: DemoQuestion[];
  selectedItemId: string | null;
  isPanelExpanded: boolean;
  nextSequence: number;
};
