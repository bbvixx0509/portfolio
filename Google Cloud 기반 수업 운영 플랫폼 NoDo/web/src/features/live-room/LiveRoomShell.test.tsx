import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveRoomPanelSwitch, LiveRoomShell } from "./LiveRoomShell";

vi.mock("../../components/navigation/CommonHeader", () => ({
  CommonHeader: () => <header>공통 헤더</header>,
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function RoomPanel({ active }: { active: "roadmap" | "chat" }) {
  const { roomId = "room-1" } = useParams();
  const base = `/rooms/${roomId}`;
  return (
    <LiveRoomShell
      homeTo="/rooms"
      homeLabel="강의방 목록"
      roomTitle="테스트 강의방"
      roomMeta="강의 운영"
      panelLabel="작업 패널"
      panelTitle="강의 운영"
      tabs={[
        { label: "채팅", to: `${base}/chat`, active: active === "chat" },
        { label: "로드맵", to: `${base}/checklist`, active: active === "roadmap" },
      ]}
      context={<p>자료 영역</p>}
      panelFixed={<p>정원 20명</p>}
      panel={<p>{active === "chat" ? "채팅 내용" : "로드맵 내용"}</p>}
    />
  );
}

function PersistentPanelProbe() {
  const [activeTab, setActiveTab] = useState<"roadmap" | "chat">("roadmap");

  return (
    <>
      <button type="button" onClick={() => setActiveTab("roadmap")}>로드맵</button>
      <button type="button" onClick={() => setActiveTab("chat")}>채팅</button>
      <LiveRoomPanelSwitch
        activeTab={activeTab}
        roadmap={<input data-testid="roadmap-draft" aria-label="로드맵 메모" defaultValue="초기 로드맵" />}
        chat={<input data-testid="chat-draft" aria-label="채팅 메모" defaultValue="초기 채팅" />}
      />
    </>
  );
}

function renderRoom(path: "/rooms/room-1/checklist" | "/rooms/room-1/chat") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/rooms/:roomId/checklist" element={<RoomPanel active="roadmap" />} />
        <Route path="/rooms/:roomId/chat" element={<RoomPanel active="chat" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function viewTransitionSpy(directions: string[]) {
  return vi.fn((update: () => void | Promise<void>) => {
    directions.push(document.documentElement.dataset.liveRoomTabTransition ?? "");
    const updateResult = update();
    return { finished: Promise.resolve(updateResult) };
  });
}

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  Reflect.deleteProperty(document, "startViewTransition");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  delete document.documentElement.dataset.liveRoomTabTransition;
});

describe("LiveRoomShell tab transitions", () => {
  it("탭을 바꿔도 양쪽 패널을 유지해 로드맵·채팅의 입력 상태가 사라지지 않는다", () => {
    render(<PersistentPanelProbe />);

    fireEvent.change(screen.getByTestId("roadmap-draft"), { target: { value: "로드맵 입력 유지" } });
    fireEvent.click(screen.getByRole("button", { name: "채팅" }));
    fireEvent.change(screen.getByTestId("chat-draft"), { target: { value: "채팅 입력 유지" } });
    fireEvent.click(screen.getByRole("button", { name: "로드맵" }));

    expect(screen.getByTestId("roadmap-draft")).toHaveValue("로드맵 입력 유지");
    fireEvent.click(screen.getByRole("button", { name: "채팅" }));
    expect(screen.getByTestId("chat-draft")).toHaveValue("채팅 입력 유지");
  });

  it("로드맵에서 채팅으로 갈 때 패널을 왼쪽에서 내보내고 오른쪽에서 들어오는 방향을 지정한다", async () => {
    const directions: string[] = [];
    const startViewTransition = viewTransitionSpy(directions);
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });

    renderRoom("/rooms/room-1/checklist");
    fireEvent.click(screen.getByRole("link", { name: "채팅" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/rooms/room-1/chat"));
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(directions).toEqual(["roadmap-to-chat"]);
    expect(screen.getByText("정원 20명")).toBeInTheDocument();
  });

  it("채팅에서 로드맵으로 갈 때 반대 방향을 지정한다", async () => {
    const directions: string[] = [];
    const startViewTransition = viewTransitionSpy(directions);
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });

    renderRoom("/rooms/room-1/chat");
    fireEvent.click(screen.getByRole("link", { name: "로드맵" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/rooms/room-1/checklist"));
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(directions).toEqual(["chat-to-roadmap"]);
  });

  it("동작 줄이기 환경에서는 즉시 전환하고 View Transition을 시작하지 않는다", async () => {
    const startViewTransition = vi.fn();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: startViewTransition });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn().mockReturnValue({ matches: true }) });

    renderRoom("/rooms/room-1/checklist");
    fireEvent.click(screen.getByRole("link", { name: "채팅" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/rooms/room-1/chat"));
    expect(startViewTransition).not.toHaveBeenCalled();
  });
});
