import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useReducer,
} from "react";
import {
  createImportedDemoCourseSeed,
  demoCourseChapters,
  demoCourseFlowItems,
  demoCourseInfo,
  demoCourseQuestions,
} from "../../data/demoCourseMocks";
import type {
  DemoChapter,
  DemoCourseSource,
  DemoCourseState,
  DemoMaterial,
  DemoMaterialFormat,
  DemoQuestion,
} from "./demoCourseTypes";
import {
  getCurrentProgressItem,
  getIsItemCompletionToggleEnabled,
  getOrderedFlowItems,
} from "./demoCourseSelectors";

type InitializeSourceInput = {
  source: DemoCourseSource;
  courseId: string;
  title: string;
};

type DemoCourseAction =
  | ({ type: "INITIALIZE_SOURCE" } & InitializeSourceInput)
  | {
      type: "ADD_MATERIAL";
      name: string;
      format: DemoMaterialFormat;
    }
  | { type: "GENERATE_MOCK_FLOW" }
  | { type: "ADD_CHAPTER"; title: string }
  | { type: "ADD_ITEM"; chapterId: string; title: string }
  | { type: "UPDATE_ITEM"; itemId: string; title: string }
  | { type: "DELETE_ITEM"; itemId: string }
  | { type: "MOVE_ITEM"; itemId: string; direction: "UP" | "DOWN" }
  | { type: "TOGGLE_ITEM_COMPLETION"; itemId: string }
  | { type: "SELECT_ITEM"; itemId: string }
  | { type: "TOGGLE_PANEL_EXPANDED" }
  | { type: "START_COURSE" }
  | {
      type: "ADD_QUESTION";
      content: string;
      itemId: string | null;
      isGeneral: boolean;
    }
  | { type: "TOGGLE_QUESTION_ANSWERED"; questionId: string }
  | { type: "HIDE_QUESTION"; questionId: string }
  | { type: "RESTORE_QUESTION"; questionId: string };

type DemoCourseActions = {
  initializeSource: (input: InitializeSourceInput) => void;
  addMaterial: (name: string, format: DemoMaterialFormat) => void;
  generateMockFlow: () => void;
  addChapter: (title: string) => void;
  addItem: (chapterId: string, title: string) => void;
  updateItem: (itemId: string, title: string) => void;
  deleteItem: (itemId: string) => void;
  moveItem: (itemId: string, direction: "UP" | "DOWN") => void;
  toggleItemCompletion: (itemId: string) => void;
  selectItem: (itemId: string) => void;
  togglePanelExpanded: () => void;
  startCourse: () => void;
  addQuestion: (
    content: string,
    itemId: string | null,
    isGeneral: boolean,
  ) => void;
  toggleQuestionAnswered: (questionId: string) => void;
  hideQuestion: (questionId: string) => void;
  restoreQuestion: (questionId: string) => void;
};

type DemoCourseContextValue = {
  state: DemoCourseState;
  actions: DemoCourseActions;
};

const DemoCourseContext = createContext<DemoCourseContextValue | null>(null);

function cloneChapters(): DemoChapter[] {
  return demoCourseChapters.map((chapter) => ({
    ...chapter,
    itemIds: [...chapter.itemIds],
  }));
}

function cloneItems() {
  return demoCourseFlowItems.map((item) => ({ ...item }));
}

function cloneQuestions(): DemoQuestion[] {
  return demoCourseQuestions.map((question) => ({ ...question }));
}

function demoMaterial(): DemoMaterial {
  return {
    id: "material-practice-data",
    name: "practice_data.zip",
    format: "DATA",
  };
}

function normalizeSequentialCompletion(state: DemoCourseState) {
  let foundIncomplete = false;
  const completionById = new Map(
    getOrderedFlowItems(state).map((item) => {
      if (!item.isCompleted) {
        foundIncomplete = true;
      }
      return [item.id, item.isCompleted && !foundIncomplete] as const;
    }),
  );
  return state.items.map((item) => ({
    ...item,
    isCompleted: completionById.get(item.id) ?? item.isCompleted,
  }));
}

function createSourceState({
  source,
  courseId,
  title,
}: InitializeSourceInput): DemoCourseState {
  const importedSeed = source.startsWith("import:")
    ? createImportedDemoCourseSeed(courseId)
    : null;
  const isDemoRoom = source === "demo";
  const chapters = importedSeed
    ? importedSeed.chapters
    : isDemoRoom
      ? cloneChapters()
      : [{ id: "chapter-empty", title: "새 챕터", itemIds: [] }];
  const items = importedSeed
    ? importedSeed.items
    : isDemoRoom
      ? cloneItems()
      : [];

  return {
    source,
    course: {
      id: courseId,
      title,
      status: source === "demo" ? "LIVE" : "PREPARING",
      roomCode: demoCourseInfo.roomCode,
    },
    chapters,
    items,
    materials: importedSeed
      ? importedSeed.materials
      : isDemoRoom
        ? [demoMaterial()]
        : [],
    questions: isDemoRoom ? cloneQuestions() : [],
    selectedItemId: importedSeed
      ? importedSeed.selectedItemId
      : isDemoRoom
        ? "flow-code"
        : null,
    isPanelExpanded: false,
    nextSequence: 100,
  };
}

export function createInitialDemoCourseState() {
  return createSourceState({
    source: "demo",
    courseId: demoCourseInfo.id,
    title: demoCourseInfo.title,
  });
}

function demoCourseReducer(
  state: DemoCourseState,
  action: DemoCourseAction,
): DemoCourseState {
  switch (action.type) {
    case "INITIALIZE_SOURCE":
      if (state.source === action.source) {
        return state;
      }
      return createSourceState(action);

    case "ADD_MATERIAL": {
      const material: DemoMaterial = {
        id: `material-${state.nextSequence}`,
        name: action.name,
        format: action.format,
      };
      return {
        ...state,
        materials: [...state.materials, material],
        nextSequence: state.nextSequence + 1,
      };
    }

    case "GENERATE_MOCK_FLOW":
      return {
        ...state,
        chapters: cloneChapters(),
        items: cloneItems(),
        questions: cloneQuestions(),
        selectedItemId: "flow-code",
      };

    case "ADD_CHAPTER": {
      const chapter: DemoChapter = {
        id: `chapter-custom-${state.nextSequence}`,
        title: action.title,
        itemIds: [],
      };
      const nextState: DemoCourseState = {
        ...state,
        chapters: [...state.chapters, chapter],
        nextSequence: state.nextSequence + 1,
      };
      return nextState;
    }

    case "ADD_ITEM": {
      if (!state.chapters.some((chapter) => chapter.id === action.chapterId)) {
        return state;
      }
      const itemId = `flow-custom-${state.nextSequence}`;
      const nextState: DemoCourseState = {
        ...state,
        chapters: state.chapters.map((chapter) =>
          chapter.id === action.chapterId
            ? { ...chapter, itemIds: [...chapter.itemIds, itemId] }
            : chapter,
        ),
        items: [
          ...state.items,
          {
            id: itemId,
            chapterId: action.chapterId,
            title: action.title,
            description: "강사가 직접 추가한 수업 흐름 항목이에요",
            kind: "SLIDE",
            isCompleted: false,
            materialLabel: action.title,
          },
        ],
        selectedItemId: itemId,
        nextSequence: state.nextSequence + 1,
      };
      return {
        ...nextState,
        items: normalizeSequentialCompletion(nextState),
      };
    }

    case "UPDATE_ITEM":
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === action.itemId
            ? { ...item, title: action.title, materialLabel: action.title }
            : item,
        ),
      };

    case "DELETE_ITEM": {
      const orderedItems = getOrderedFlowItems(state);
      const deletedIndex = orderedItems.findIndex(
        (item) => item.id === action.itemId,
      );
      if (deletedIndex < 0) {
        return state;
      }
      const adjacentItem =
        orderedItems[deletedIndex + 1] ?? orderedItems[deletedIndex - 1] ?? null;
      const remainingItems = state.items.filter(
        (item) => item.id !== action.itemId,
      );
      const nextState: DemoCourseState = {
        ...state,
        chapters: state.chapters.map((chapter) => ({
          ...chapter,
          itemIds: chapter.itemIds.filter((itemId) => itemId !== action.itemId),
        })),
        items: remainingItems,
        questions: state.questions.filter(
          (question) => question.itemId !== action.itemId,
        ),
        selectedItemId:
          state.selectedItemId === action.itemId ? null : state.selectedItemId,
      };
      const normalizedState = {
        ...nextState,
        items: normalizeSequentialCompletion(nextState),
      };
      if (normalizedState.selectedItemId) {
        return normalizedState;
      }
      const fallbackItem =
        getCurrentProgressItem(normalizedState) ??
        (adjacentItem
          ? normalizedState.items.find((item) => item.id === adjacentItem.id)
          : null) ??
        getOrderedFlowItems(normalizedState).at(-1) ??
        null;
      return { ...normalizedState, selectedItemId: fallbackItem?.id ?? null };
    }

    case "MOVE_ITEM": {
      const nextState: DemoCourseState = {
        ...state,
        chapters: state.chapters.map((chapter) => {
          const index = chapter.itemIds.indexOf(action.itemId);
          if (index < 0) {
            return chapter;
          }
          const targetIndex = action.direction === "UP" ? index - 1 : index + 1;
          if (targetIndex < 0 || targetIndex >= chapter.itemIds.length) {
            return chapter;
          }
          const nextItemIds = [...chapter.itemIds];
          [nextItemIds[index], nextItemIds[targetIndex]] = [
            nextItemIds[targetIndex],
            nextItemIds[index],
          ];
          return { ...chapter, itemIds: nextItemIds };
        }),
      };
      return {
        ...nextState,
        items: normalizeSequentialCompletion(nextState),
      };
    }

    case "TOGGLE_ITEM_COMPLETION": {
      if (!getIsItemCompletionToggleEnabled(state, action.itemId)) {
        return state;
      }
      const orderedItems = getOrderedFlowItems(state);
      const targetIndex = orderedItems.findIndex(
        (item) => item.id === action.itemId,
      );
      const targetItem = orderedItems[targetIndex];
      if (!targetItem) {
        return state;
      }
      const shouldComplete = !targetItem.isCompleted;
      const completionById = new Map(
        orderedItems.map((item, index) => [
          item.id,
          shouldComplete ? index <= targetIndex : index < targetIndex,
        ]),
      );
      const nextItems = state.items.map((item) => ({
        ...item,
        isCompleted: completionById.get(item.id) ?? item.isCompleted,
      }));
      const nextState: DemoCourseState = { ...state, items: nextItems };
      const nextCurrentItem = getCurrentProgressItem(nextState);
      return {
        ...nextState,
        items: nextItems,
        selectedItemId: nextCurrentItem?.id ?? action.itemId,
      };
    }

    case "SELECT_ITEM":
      return { ...state, selectedItemId: action.itemId };

    case "TOGGLE_PANEL_EXPANDED":
      return { ...state, isPanelExpanded: !state.isPanelExpanded };

    case "START_COURSE": {
      const currentItem = getCurrentProgressItem(state);
      return {
        ...state,
        course: { ...state.course, status: "LIVE" },
        selectedItemId: currentItem?.id ?? state.selectedItemId,
      };
    }

    case "ADD_QUESTION": {
      const question: DemoQuestion = {
        id: `question-user-${state.nextSequence}`,
        nickname: "용감한 수달",
        avatar: "🦦",
        content: action.content,
        itemId: action.itemId,
        isGeneral: action.isGeneral,
        answered: false,
        hidden: false,
        needsReview: false,
        unread: true,
        origin: "USER",
      };
      return {
        ...state,
        questions: [...state.questions, question],
        nextSequence: state.nextSequence + 1,
      };
    }

    case "TOGGLE_QUESTION_ANSWERED":
      return {
        ...state,
        questions: state.questions.map((question) =>
          question.id === action.questionId
            ? {
                ...question,
                answered: !question.answered,
                unread: false,
                answer: question.answered
                  ? question.answer
                  : (question.answer ??
                    "확인했습니다. 수업이 끝난 뒤에도 다시 설명해 드릴게요."),
              }
            : question,
        ),
      };

    case "HIDE_QUESTION":
      return {
        ...state,
        questions: state.questions.map((question) =>
          question.id === action.questionId
            ? { ...question, hidden: true, unread: false }
            : question,
        ),
      };

    case "RESTORE_QUESTION":
      return {
        ...state,
        questions: state.questions.map((question) =>
          question.id === action.questionId
            ? { ...question, hidden: false }
            : question,
        ),
      };
  }
}

export function DemoCourseProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    demoCourseReducer,
    undefined,
    createInitialDemoCourseState,
  );

  const actions = useMemo<DemoCourseActions>(
    () => ({
        initializeSource: (input) =>
          dispatch({ type: "INITIALIZE_SOURCE", ...input }),
        addMaterial: (name, format) =>
          dispatch({ type: "ADD_MATERIAL", name, format }),
        generateMockFlow: () => dispatch({ type: "GENERATE_MOCK_FLOW" }),
        addChapter: (title) => dispatch({ type: "ADD_CHAPTER", title }),
        addItem: (chapterId, title) =>
          dispatch({ type: "ADD_ITEM", chapterId, title }),
        updateItem: (itemId, title) =>
          dispatch({ type: "UPDATE_ITEM", itemId, title }),
        deleteItem: (itemId) => dispatch({ type: "DELETE_ITEM", itemId }),
        moveItem: (itemId, direction) =>
          dispatch({ type: "MOVE_ITEM", itemId, direction }),
        toggleItemCompletion: (itemId) =>
          dispatch({ type: "TOGGLE_ITEM_COMPLETION", itemId }),
        selectItem: (itemId) => dispatch({ type: "SELECT_ITEM", itemId }),
        togglePanelExpanded: () => dispatch({ type: "TOGGLE_PANEL_EXPANDED" }),
        startCourse: () => dispatch({ type: "START_COURSE" }),
        addQuestion: (content, itemId, isGeneral) =>
          dispatch({ type: "ADD_QUESTION", content, itemId, isGeneral }),
        toggleQuestionAnswered: (questionId) =>
          dispatch({ type: "TOGGLE_QUESTION_ANSWERED", questionId }),
        hideQuestion: (questionId) =>
          dispatch({ type: "HIDE_QUESTION", questionId }),
        restoreQuestion: (questionId) =>
          dispatch({ type: "RESTORE_QUESTION", questionId }),
    }),
    [],
  );

  const value = useMemo<DemoCourseContextValue>(
    () => ({ state, actions }),
    [actions, state],
  );

  return (
    <DemoCourseContext.Provider value={value}>
      {children}
    </DemoCourseContext.Provider>
  );
}

export function useDemoCourse() {
  const context = useContext(DemoCourseContext);
  if (!context) {
    throw new Error("useDemoCourse는 DemoCourseProvider 안에서 사용해야 합니다.");
  }
  return context;
}

export function getDemoMaterialFormat(fileName: string): DemoMaterialFormat {
  const extension = fileName.split(".").pop()?.toLocaleLowerCase("en-US") ?? "";
  if (extension === "pptx") {
    return "PPTX";
  }
  if (extension === "pdf") {
    return "PDF";
  }
  if (
    ["js", "jsx", "ts", "tsx", "py", "java", "go", "html", "css"].includes(
      extension,
    )
  ) {
    return "CODE";
  }
  return "DATA";
}

export { demoCourseReducer };
