import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudRoomRecord } from "./roomApi";

const mocks = vi.hoisted(() => ({
  getCloudRoomChecklist: vi.fn(),
  getCloudRoomShare: vi.fn(),
  copyCloudRoomValue: vi.fn(),
  startCloudRoom: vi.fn(),
  endCloudRoom: vi.fn(),
  completeCloudRoomChecklistItem: vi.fn(),
  undoCloudRoomChecklistItem: vi.fn(),
  getCloudRoomQuestionSummary: vi.fn(),
}));
const authUser = { uid: "masked-lead" };

vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: authUser }) }));
vi.mock("./roomApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./roomApi")>();
  return { ...original, ...mocks };
});
vi.mock("../cloud-questions/cloudQuestionApi", () => ({
  getCloudRoomQuestionSummary: mocks.getCloudRoomQuestionSummary,
}));

import { CloudRoomChecklistPage } from "./CloudRoomChecklistPage";

const flowItems = [
  {
    chapterId: "chapter-1",
    chapterTitle: "첫 번째 챕터",
    chapterPosition: 0,
    itemId: "item-1",
    itemTitle: "첫 번째 항목",
    itemDescription: "첫 항목 설명",
    itemPosition: 0,
    isCompleted: false,
  },
  {
    chapterId: "chapter-1",
    chapterTitle: "첫 번째 챕터",
    chapterPosition: 0,
    itemId: "item-2",
    itemTitle: "두 번째 항목",
    itemDescription: "둘째 항목 설명",
    itemPosition: 1,
    isCompleted: false,
  },
];

function room(overrides: Partial<CloudRoomRecord> = {}): CloudRoomRecord {
  return {
    id: "room-1",
    title: "로드맵 테스트 강의방",
    status: "READY" as const,
    roomCode: "ABCDEFGH",
    sourceCourseId: "course-1",
    sourceCourseRevision: 1,
    sourceCourseTitle: "원본 수업 흐름",
    leadInstructorDisplayNameSnapshot: "테스트 강사",
    createdAt: null,
    updatedAt: null,
    revision: 1,
    flowItems,
    currentRole: "LEAD_INSTRUCTOR" as const,
    currentItemId: "item-1",
    isComplete: false,
    ...overrides,
  };
}

function renderChecklist() {
  return render(
    <MemoryRouter initialEntries={["/rooms/room-1/checklist"]}>
      <Routes>
        <Route path="/rooms/:roomId/checklist" element={<CloudRoomChecklistPage />} />
        <Route path="/rooms/:roomId/summary" element={<p>종료 요약 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CloudRoomChecklistPage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    mocks.getCloudRoomChecklist.mockReset();
    mocks.getCloudRoomShare.mockReset().mockResolvedValue({
      roomId: "room-1",
      orgId: "demo",
      roomCode: "ABCDEFGH",
      joinPath: "/join/demo/ABCDEFGH",
    });
    mocks.copyCloudRoomValue.mockReset().mockResolvedValue(undefined);
    mocks.startCloudRoom.mockReset();
    mocks.endCloudRoom.mockReset();
    mocks.completeCloudRoomChecklistItem.mockReset();
    mocks.undoCloudRoomChecklistItem.mockReset();
    mocks.getCloudRoomQuestionSummary.mockReset().mockResolvedValue({
      allCount: 3,
      newCount: 1,
      generalCount: 1,
      generalNewCount: 1,
      itemCounts: [
        { itemId: "item-1", itemNumber: "1.1", totalCount: 2, newCount: 1 },
        { itemId: "item-2", itemNumber: "1.2", totalCount: 0, newCount: 0 },
      ],
    });
    mocks.getCloudRoomChecklist.mockResolvedValue(room());
    mocks.startCloudRoom.mockResolvedValue(
      room({ status: "LIVE", revision: 2, currentItemId: "item-1" }),
    );
    mocks.endCloudRoom.mockResolvedValue(room({ status: "ENDED", revision: 3, currentItemId: null }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cloud-auth 로드맵 라우트가 시작 화면 대신 READY 화면을 표시한다", async () => {
    renderChecklist();

    expect(
      await screen.findByRole("heading", { name: "로드맵 테스트 강의방" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "수업 시작" })).toBeEnabled();
    expect(screen.getByRole("link", { name: /채팅 3 · 새 1/ })).toHaveAttribute("href", "/rooms/room-1/chat");
    expect(screen.getByTestId("live-room-shell")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "첫 번째 항목: 현재 진행" })).toBeDisabled();
  });

  it("server summary with an ALL read position shows zero badges in the checklist", async () => {
    mocks.getCloudRoomQuestionSummary.mockResolvedValue({
      allCount: 3,
      newCount: 0,
      generalCount: 1,
      generalNewCount: 0,
      itemCounts: [
        { itemId: "item-1", itemNumber: "1.1", totalCount: 2, newCount: 0 },
        { itemId: "item-2", itemNumber: "1.2", totalCount: 0, newCount: 0 },
      ],
    });
    renderChecklist();

    expect(await screen.findByRole("link", { name: /채팅 3 · 새 0/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /질문 2 · 새 0/ })).toBeInTheDocument();
  });

  it("READY 강의방의 LEAD는 헤더에서 방 코드와 학생 링크를 공유한다", async () => {
    renderChecklist();
    fireEvent.click(await screen.findByRole("button", { name: "공유하기" }));

    expect(await screen.findByRole("textbox", { name: "방 코드" })).toHaveValue("ABCDEFGH");
    expect((screen.getByRole("textbox", { name: "학생 입장 링크" }) as HTMLInputElement).value).toMatch(/\/join\/demo\/ABCDEFGH$/);
    fireEvent.click(screen.getAllByRole("button", { name: "복사" })[0]);
    await waitFor(() => expect(mocks.copyCloudRoomValue).toHaveBeenCalledWith("ABCDEFGH"));
  });

  it("수업 시작 뒤 첫 미완료 항목만 현재 진행으로 활성화한다", async () => {
    renderChecklist();
    await screen.findByRole("button", { name: "수업 시작" });
    fireEvent.click(screen.getByRole("button", { name: "수업 시작" }));

    expect(await screen.findByText("현재 진행")).toBeInTheDocument();
    expect(mocks.startCloudRoom).toHaveBeenCalledWith(authUser, "room-1", 1);
    expect(screen.getByRole("button", { name: "첫 번째 항목: 현재 진행" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "두 번째 항목: 미완료" })).toBeDisabled();
  });

  it("완료 뒤 다음 항목을 현재로 바꾸고 완료 해제는 이후 항목을 초기화한다", async () => {
    mocks.getCloudRoomChecklist.mockResolvedValue(
      room({ status: "LIVE", revision: 2, currentItemId: "item-1" }),
    );
    mocks.completeCloudRoomChecklistItem.mockResolvedValue(
      room({
        status: "LIVE",
        revision: 3,
        currentItemId: "item-2",
        flowItems: [{ ...flowItems[0], isCompleted: true }, flowItems[1]],
      }),
    );
    mocks.undoCloudRoomChecklistItem.mockResolvedValue(
      room({ status: "LIVE", revision: 4, currentItemId: "item-1" }),
    );
    renderChecklist();

    const first = await screen.findByRole("button", { name: "첫 번째 항목: 현재 진행" });
    fireEvent.click(first);
    await waitFor(() =>
      expect(mocks.completeCloudRoomChecklistItem).toHaveBeenCalledWith(
        authUser,
        "room-1",
        "item-1",
        2,
      ),
    );
    expect(screen.getByRole("button", { name: "두 번째 항목: 현재 진행" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "첫 번째 항목: 완료" }));
    await waitFor(() =>
      expect(mocks.undoCloudRoomChecklistItem).toHaveBeenCalledWith(
        authUser,
        "room-1",
        "item-1",
        3,
      ),
    );
    expect(screen.getByRole("button", { name: "두 번째 항목: 미완료" })).toBeDisabled();
  });

  it("전체 완료와 ADMIN 읽기 전용 상태를 표시한다", async () => {
    mocks.getCloudRoomChecklist.mockResolvedValue(
      room({
        status: "LIVE",
        revision: 4,
        currentRole: "ADMIN",
        currentItemId: null,
        isComplete: true,
        flowItems: flowItems.map((item) => ({ ...item, isCompleted: true })),
      }),
    );
    renderChecklist();

    await screen.findByRole("heading", { name: "로드맵 테스트 강의방" });
    expect(screen.queryByText("현재 진행 항목")).not.toBeInTheDocument();
    expect(screen.getByText(/현재 계정에는 이 강의방의 로드맵 진행 권한이 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "챕터 펼치기" }));
    expect(screen.getByRole("button", { name: "첫 번째 항목: 완료" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "강의 종료" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "종료 요약 보기" })).not.toBeInTheDocument();
  });

  it("로드맵 권한이 있는 ASSISTANT만 원형 진행 표시를 조작할 수 있다", async () => {
    mocks.getCloudRoomChecklist.mockResolvedValue(
      room({
        status: "LIVE",
        currentRole: "ASSISTANT",
        roomPermissions: { checklistProgress: true, questionOperations: false, capacityOperations: false },
      }),
    );
    const view = renderChecklist();
    expect(await screen.findByRole("button", { name: "첫 번째 항목: 현재 진행" })).toBeEnabled();

    view.unmount();
    mocks.getCloudRoomChecklist.mockResolvedValue(
      room({
        status: "LIVE",
        currentRole: "ASSISTANT",
        roomPermissions: { checklistProgress: false, questionOperations: false, capacityOperations: false },
      }),
    );
    renderChecklist();
    expect(await screen.findByRole("button", { name: "첫 번째 항목: 현재 진행" })).toBeDisabled();
  });

  it("LEAD는 기본 7일 정책으로 종료에 성공하면 종료 요약 화면으로 이동한다", async () => {
    mocks.getCloudRoomChecklist.mockResolvedValue(
      room({ status: "LIVE", revision: 2, currentItemId: "item-1" }),
    );
    renderChecklist();
    fireEvent.click(await screen.findByRole("button", { name: "강의 종료" }));
    const dialog = screen.getByRole("dialog", { name: "학생 자료 열람 마감일을 선택하세요" });
    expect(within(dialog).getByRole("radio", { name: /종료 후 7일/ })).toBeChecked();
    expect(within(dialog).getByText(/서버가 실제 종료 시각을 기준으로 학생 자료 열람·다운로드를 7일 뒤 마감/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "강의 종료" }));

    await waitFor(() => expect(mocks.endCloudRoom).toHaveBeenCalledWith(
      authUser,
      "room-1",
      2,
      { studentAccessWindow: "SEVEN_DAYS" },
    ));
    expect(await screen.findByText("종료 요약 화면")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "로드맵 테스트 강의방" })).not.toBeInTheDocument();
  });

  it("강의 종료 API가 실패하면 checklist에 남고 기존 오류를 표시한다", async () => {
    mocks.getCloudRoomChecklist.mockResolvedValue(
      room({ status: "LIVE", revision: 2, currentItemId: "item-1" }),
    );
    mocks.endCloudRoom.mockRejectedValueOnce(new Error("강의 종료 요청이 실패했습니다."));
    renderChecklist();

    fireEvent.click(await screen.findByRole("button", { name: "강의 종료" }));
    const dialog = screen.getByRole("dialog", { name: "학생 자료 열람 마감일을 선택하세요" });
    fireEvent.click(within(dialog).getByRole("button", { name: "강의 종료" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("강의 종료 요청이 실패했습니다.");
    expect(screen.getByRole("heading", { name: "로드맵 테스트 강의방" })).toBeInTheDocument();
    expect(screen.queryByText("종료 요약 화면")).not.toBeInTheDocument();
  });

  it("LEAD는 CUSTOM 정책에 KST 오프셋을 포함하고 과거 시각은 전송하지 않는다", async () => {
    mocks.getCloudRoomChecklist.mockResolvedValue(
      room({ status: "LIVE", revision: 2, currentItemId: "item-1" }),
    );
    renderChecklist();
    fireEvent.click(await screen.findByRole("button", { name: "강의 종료" }));
    const dialog = screen.getByRole("dialog", { name: "학생 자료 열람 마감일을 선택하세요" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "직접 날짜·시간 지정 (KST)" }));
    const input = within(dialog).getByLabelText(/직접 마감 날짜·시간/);
    fireEvent.change(input, { target: { value: "2000-01-01T09:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "강의 종료" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("현재 시각 이후");
    expect(mocks.endCloudRoom).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2099-01-01T09:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "강의 종료" }));
    await waitFor(() => expect(mocks.endCloudRoom).toHaveBeenCalledWith(
      authUser,
      "room-1",
      2,
      {
        studentAccessWindow: "CUSTOM",
        studentAccessUntil: "2099-01-01T09:00:00+09:00",
      },
    ));
  });

  it("ENDED LEAD에게만 종료 요약 진입점을 보여 준다", async () => {
    mocks.getCloudRoomChecklist.mockResolvedValue(
      room({ status: "ENDED", revision: 3, currentItemId: null }),
    );
    renderChecklist();

    expect(await screen.findByRole("link", { name: "종료 요약 보기" })).toHaveAttribute("href", "/rooms/room-1/summary");
    expect(screen.queryByRole("button", { name: "강의 종료" })).not.toBeInTheDocument();
  });

  it("LIVE 상태에서 중복 polling을 막고 unmount 시 timer를 정리한다", async () => {
    vi.useFakeTimers();
    mocks.getCloudRoomChecklist.mockResolvedValue(
      room({ status: "LIVE", revision: 2, currentItemId: "item-1" }),
    );
    const view = renderChecklist();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "로드맵 테스트 강의방" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(mocks.getCloudRoomChecklist).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.getCloudRoomChecklist).toHaveBeenCalledTimes(2);
  });

  it("polling 오류에서도 마지막 정상 화면과 재시도 안내를 유지한다", async () => {
    vi.useFakeTimers();
    mocks.getCloudRoomChecklist
      .mockResolvedValueOnce(room({ status: "LIVE", revision: 2, currentItemId: "item-1" }))
      .mockRejectedValueOnce(new Error("네트워크 오류"));
    renderChecklist();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "로드맵 테스트 강의방" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("마지막 정상 화면을 유지합니다");
    expect(screen.getAllByText("첫 번째 항목")).not.toHaveLength(0);
  });

  it("390px 폭에서도 제목과 체크 조작 영역을 유지하고 별도 확대 버튼을 두지 않는다", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    renderChecklist();

    expect((await screen.findAllByText("첫 번째 항목"))[0]).toBeVisible();
    expect(screen.getByRole("button", { name: "수업 시작" })).toBeVisible();
    expect(screen.getByRole("link", { name: /질문 2 · 새 1/ })).toHaveAttribute("href", "/rooms/room-1/chat?item=item-1");
    expect(screen.getByRole("separator", { name: "작업 패널 너비 조절" })).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.queryByRole("button", { name: "작업 패널 넓게 보기" })).not.toBeInTheDocument();
  });

  it("작업 패널 폭을 키보드와 드래그로 제한 범위 안에서 조절하고 저장한다", async () => {
    window.localStorage.setItem("nodo.live-room.panel-width", "400");
    const view = renderChecklist();
    const resizeHandle = await screen.findByRole("separator", { name: "작업 패널 너비 조절" });
    const workspace = screen.getByRole("region", { name: "라이브 강의 작업 영역" });
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      bottom: 0, height: 0, left: 0, right: 1_000, top: 0, width: 1_000, x: 0, y: 0,
      toJSON: () => ({}),
    });

    expect(resizeHandle).toHaveAttribute("aria-valuenow", "400");
    fireEvent.keyDown(resizeHandle, { key: "ArrowRight" });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "376");
    expect(window.localStorage.getItem("nodo.live-room.panel-width")).toBe("376");

    fireEvent.pointerDown(resizeHandle, { pointerId: 1 });
    fireEvent.pointerMove(resizeHandle, { pointerId: 1, clientX: 100 });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "668");
    fireEvent.pointerMove(resizeHandle, { pointerId: 1, clientX: 900 });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "340");
    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });
    view.unmount();
    renderChecklist();
    expect(await screen.findByRole("separator", { name: "작업 패널 너비 조절" })).toHaveAttribute("aria-valuenow", "340");
  });
});
