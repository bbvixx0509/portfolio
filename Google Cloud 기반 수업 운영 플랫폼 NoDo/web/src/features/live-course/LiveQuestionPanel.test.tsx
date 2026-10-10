import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfile } from "../auth/authTypes";
import type { LiveCourseItem, LiveQuestion } from "./liveCourseTypes";

const { requestApiMock } = vi.hoisted(() => ({ requestApiMock: vi.fn() }));
vi.mock("../../lib/api/apiClient", () => ({ requestApi: requestApiMock }));

import {
  countQuestionsForContext,
  countUnreadQuestionsForContext,
  LiveQuestionPanel,
} from "./LiveQuestionPanel";

const studentProfile: AuthProfile = {
  uid: "student-private-id",
  orgId: "org-nodo",
  accountType: "STUDENT",
  displayName: "궁금한 수달",
  nickname: "궁금한 수달",
  email: null,
};

const user = { uid: studentProfile.uid } as unknown as User;
const items: LiveCourseItem[] = [
  {
    id: "item-past",
    chapterId: "chapter-one",
    title: "과거 항목",
    description: "",
    materialLabel: "슬라이드 1",
    kind: "SLIDE",
    order: 0,
    isCompleted: true,
  },
  {
    id: "item-future",
    chapterId: "chapter-one",
    title: "미래 항목",
    description: "",
    materialLabel: "슬라이드 2",
    kind: "SLIDE",
    order: 1,
    isCompleted: false,
  },
];
const itemNumberById = new Map([
  ["item-past", "1.1"],
  ["item-future", "1.2"],
]);

function question(overrides: Partial<LiveQuestion> = {}): LiveQuestion {
  return {
    id: "question-one",
    roomId: "room-one",
    courseId: "course-one",
    orgId: "org-nodo",
    content: "항목 질문입니다.",
    nicknameSnapshot: "익명 수달",
    isGeneral: false,
    itemId: "item-past",
    itemNumberSnapshot: "1.1",
    itemTitleSnapshot: "과거 항목",
    chapterTitleSnapshot: "첫 챕터",
    materialLabelSnapshot: "슬라이드 1",
    visibility: "PUBLIC",
    moderationStatus: "APPROVED",
    isAnswered: false,
    answer: null,
    isHidden: false,
    createdAt: "2026-07-15T01:00:00.000Z",
    updatedAt: null,
    createdAtMillis: Date.parse("2026-07-15T01:00:00.000Z"),
    schemaVersion: 1,
    ...overrides,
  };
}

function renderStudentPanel(
  overrides: Partial<React.ComponentProps<typeof LiveQuestionPanel>> = {},
) {
  return render(
    <MemoryRouter>
      <LiveQuestionPanel
        roomId="room-one"
        questions={[]}
        items={items}
        profile={studentProfile}
        user={user}
        filterContext="item-past"
        onFilterContextChange={vi.fn()}
        readWatermarkByContext={{}}
        canAnswerQuestions={false}
        canModerateQuestions={false}
        isQuestionRestricted={false}
        isRoomActive
        isLoading={false}
        subscriptionError={null}
        {...overrides}
        itemNumberById={overrides.itemNumberById ?? itemNumberById}
      />
    </MemoryRouter>,
  );
}

describe("LiveQuestionPanel", () => {
  beforeEach(() => {
    requestApiMock.mockReset().mockResolvedValue({});
  });

  it("모바일 질문 폼의 편집 컨트롤을 16px로 유지해 포커스 자동 확대를 막는다", () => {
    const panelCss = readFileSync(
      "src/features/live-course/LiveQuestionPanel.module.css",
      "utf8",
    );
    const mobileRule = panelCss.match(/@media \(max-width: 560px\) \{([\s\S]*)\}\s*$/)?.[1];

    expect(mobileRule).toContain(".filters select");
    expect(mobileRule).toContain(".answerEditor textarea");
    expect(mobileRule).toContain(".composer select");
    expect(mobileRule).toContain(".composer textarea");
    expect(mobileRule).toMatch(/font-size:\s*16px/);
  });

  it("빠른 Enter 연타를 한 POST로 묶고 선택한 과거 항목 문맥과 UUID를 보낸다", async () => {
    let resolveRequest: (value: unknown) => void = () => undefined;
    requestApiMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    renderStudentPanel();
    expect(screen.getByRole("combobox", { name: "질문 종류" })).toHaveValue(
      "CHECKLIST",
    );
    expect(
      screen.getByRole("combobox", { name: "로드맵 질문 항목" }),
    ).toHaveDisplayValue("1.1 과거 항목");
    const input = screen.getByRole("textbox", { name: "질문 입력" });
    fireEvent.change(input, { target: { value: "과거 항목 질문" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    expect(requestApiMock).toHaveBeenCalledTimes(1);
    expect(requestApiMock).toHaveBeenCalledWith(
      "/api/rooms/room-one/questions",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          content: "과거 항목 질문",
          itemId: "item-past",
          clientRequestId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        }),
      }),
    );
    expect(requestApiMock.mock.calls[0][1].body).not.toHaveProperty(
      "itemNumberSnapshot",
    );
    resolveRequest({});
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("Shift+Enter는 줄바꿈으로 남기고 일반 질문은 itemId null로 전송한다", async () => {
    renderStudentPanel({ filterContext: "GENERAL" });
    expect(screen.getByRole("combobox", { name: "질문 종류" })).toHaveValue(
      "GENERAL",
    );
    expect(
      screen.queryByRole("combobox", { name: "로드맵 질문 항목" }),
    ).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "질문 입력" });
    fireEvent.change(input, { target: { value: "일반 질문" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(requestApiMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await waitFor(() =>
      expect(requestApiMock).toHaveBeenCalledWith(
        "/api/rooms/room-one/questions",
        expect.objectContaining({
          body: expect.objectContaining({ itemId: null }),
        }),
      ),
    );
  });

  it("실패 후 같은 내용을 재전송하면 같은 clientRequestId를 재사용한다", async () => {
    requestApiMock
      .mockRejectedValueOnce(new Error("잠시 후 다시 시도해 주세요."))
      .mockResolvedValueOnce({});
    renderStudentPanel({ filterContext: "GENERAL" });
    const input = screen.getByRole("textbox", { name: "질문 입력" });
    fireEvent.change(input, { target: { value: "재시도 질문" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("잠시 후 다시 시도해 주세요.");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(requestApiMock).toHaveBeenCalledTimes(2));
    const firstBody = requestApiMock.mock.calls[0][1].body;
    const secondBody = requestApiMock.mock.calls[1][1].body;
    expect(secondBody.clientRequestId).toBe(firstBody.clientRequestId);
  });

  it("질문 제한과 강의 종료 상태에서 입력을 비활성화하고 안전한 안내를 표시한다", () => {
    const rendered = renderStudentPanel({ isQuestionRestricted: true });
    expect(screen.getByRole("textbox", { name: "질문 입력" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("질문 작성이 제한");
    rendered.rerender(
      <MemoryRouter>
        <LiveQuestionPanel
          roomId="room-one"
          questions={[]}
          items={items}
          itemNumberById={itemNumberById}
          profile={studentProfile}
          user={user}
          filterContext="ALL"
          onFilterContextChange={vi.fn()}
          readWatermarkByContext={{}}
          canAnswerQuestions={false}
          canModerateQuestions={false}
          isQuestionRestricted={false}
          isRoomActive={false}
          isLoading={false}
          subscriptionError={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("textbox", { name: "질문 입력" })).toBeDisabled();
    expect(screen.getByText(/종료된 강의입니다/)).toBeInTheDocument();
  });

  it("항목별 전체·강사별 미확인 수를 context별 readAt으로 계산한다", () => {
    const questions = [
      question(),
      question({ id: "question-two", createdAtMillis: Date.parse("2026-07-15T02:00:00.000Z") }),
      question({ id: "general", isGeneral: true, itemId: null }),
    ];
    expect(countQuestionsForContext(questions, "item-past")).toBe(2);
    expect(
      countUnreadQuestionsForContext(questions, "item-past", {
        "item-past": {
          observedAtMillis: Date.parse("2026-07-15T01:30:00.000Z"),
          observedQuestionId: "question-one",
        },
      }),
    ).toBe(1);
    expect(countUnreadQuestionsForContext(questions, "GENERAL", {})).toBe(1);
  });

  it("검토 강사에게 STAFF_ONLY 질문과 승인 UI를 표시하고 context 읽음을 독립 저장한다", async () => {
    const assistantProfile: AuthProfile = {
      uid: "assistant-reviewer",
      orgId: "org-nodo",
      accountType: "STAFF",
      organizationRole: "INSTRUCTOR",
      displayName: "검토 강사",
      nickname: null,
      email: null,
    };
    render(
      <MemoryRouter>
        <LiveQuestionPanel
          roomId="room-one"
          questions={[question({ visibility: "STAFF_ONLY", moderationStatus: "NEEDS_REVIEW" })]}
          items={items}
          itemNumberById={itemNumberById}
          profile={assistantProfile}
          user={{ uid: assistantProfile.uid } as unknown as User}
          filterContext="item-past"
          onFilterContextChange={vi.fn()}
          readWatermarkByContext={{}}
          canAnswerQuestions={false}
          canModerateQuestions
          isQuestionRestricted={false}
          isRoomActive
          isLoading={false}
          subscriptionError={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("검토 필요")).toBeInTheDocument();
    await waitFor(() => expect(requestApiMock).toHaveBeenCalledWith(
      "/api/rooms/room-one/questions/read",
      expect.objectContaining({
        method: "POST",
        body: {
          contextId: "item-past",
          observedAt: "2026-07-15T01:00:00.000Z",
          observedQuestionId: "question-one",
        },
      }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "공개 승인" }));
    await waitFor(() => expect(requestApiMock).toHaveBeenCalledWith(
      "/api/rooms/room-one/questions/question-one/approve",
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("일반 질문방에 전체·강사별 미확인 수를 표시한다", () => {
    const staffProfile: AuthProfile = {
      ...studentProfile,
      accountType: "STAFF",
      displayName: "보조 강사",
    };
    renderStudentPanel({
      profile: staffProfile,
      questions: [
        question({
          id: "general-one",
          isGeneral: true,
          itemId: null,
          itemNumberSnapshot: null,
        }),
      ],
      filterContext: "GENERAL",
    });

    expect(screen.getByRole("heading", { name: /일반 질문방.*1.*미확인 1/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /일반 질문방 \(1 · 미확인 1\)/ })).toBeInTheDocument();
  });

  it("동일 생성 시각은 questionId로 정렬하고 답변 수정으로 순서를 바꾸지 않는다", () => {
    const createdAt = "2026-07-15T05:00:00.000Z";
    const questions = [
      question({ id: "question-b", createdAt, createdAtMillis: Date.parse(createdAt) }),
      question({ id: "question-a", createdAt, createdAtMillis: Date.parse(createdAt) }),
    ];
    const rendered = renderStudentPanel({ questions, filterContext: "ALL" });
    const order = () =>
      [...rendered.container.querySelectorAll("[data-question-id]")].map(
        (element) => element.getAttribute("data-question-id"),
      );

    expect(order()).toEqual(["question-a", "question-b"]);
    rendered.rerender(
      <MemoryRouter>
        <LiveQuestionPanel
          roomId="room-one"
          questions={[
            question({ id: "question-b", createdAt, createdAtMillis: Date.parse(createdAt) }),
            question({
              id: "question-a",
              createdAt,
              createdAtMillis: Date.parse(createdAt),
              isAnswered: true,
              answer: {
                content: "수정된 답변",
                instructorDisplayName: "김강사",
                roomRole: "LEAD",
                answeredAt: "2026-07-15T06:00:00.000Z",
              },
            }),
          ]}
          items={items}
          itemNumberById={itemNumberById}
          profile={studentProfile}
          user={user}
          filterContext="ALL"
          onFilterContextChange={vi.fn()}
          readWatermarkByContext={{}}
          canAnswerQuestions={false}
          canModerateQuestions={false}
          isQuestionRestricted={false}
          isRoomActive
          isLoading={false}
          subscriptionError={null}
        />
      </MemoryRouter>,
    );
    expect(order()).toEqual(["question-a", "question-b"]);
    expect(screen.getByText("수정된 답변")).toBeInTheDocument();
  });

  it("답변 저장 후 서버 답변이 도착하면 수정 입력창을 저장 값으로 다시 채운다", async () => {
    const staffProfile: AuthProfile = {
      ...studentProfile,
      accountType: "STAFF",
      displayName: "김강사",
    };
    const rendered = renderStudentPanel({
      profile: staffProfile,
      questions: [question()],
      filterContext: "ALL",
      canAnswerQuestions: true,
    });
    const editor = screen.getByRole("textbox", { name: "익명 수달 질문 답변" });
    fireEvent.change(editor, { target: { value: "보내는 답변" } });
    fireEvent.click(screen.getByRole("button", { name: "답변 등록" }));
    await waitFor(() =>
      expect(requestApiMock).toHaveBeenCalledWith(
        "/api/rooms/room-one/questions/question-one/answer",
        expect.objectContaining({ method: "PUT", body: { answer: "보내는 답변" } }),
      ),
    );

    rendered.rerender(
      <MemoryRouter>
        <LiveQuestionPanel
          roomId="room-one"
          questions={[
            question({
              isAnswered: true,
              answer: {
                content: "서버에 저장된 답변",
                instructorDisplayName: "김강사",
                roomRole: "LEAD",
                answeredAt: "2026-07-15T07:00:00.000Z",
              },
            }),
          ]}
          items={items}
          itemNumberById={itemNumberById}
          profile={staffProfile}
          user={user}
          filterContext="ALL"
          onFilterContextChange={vi.fn()}
          readWatermarkByContext={{}}
          canAnswerQuestions
          canModerateQuestions={false}
          isQuestionRestricted={false}
          isRoomActive
          isLoading={false}
          subscriptionError={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("textbox", { name: "익명 수달 질문 답변" })).toHaveValue(
      "서버에 저장된 답변",
    );
  });
});
