import {
  BarChart3,
  Check,
  ChevronRight,
  Columns2,
  LogOut,
  LockKeyhole,
  Maximize2,
  MessageCircle,
  Pencil,
  Power,
  Settings2,
  Share2,
  UsersRound,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { requestApi } from "../../lib/api/apiClient";
import { useAuth } from "../auth/AuthContext";
import { profileAccountLabel, validateNickname } from "../auth/authTypes";
import {
  createCourseItemNumberMap,
  numberedCourseItemLabel,
} from "./courseItemNumbers";
import {
  countQuestionsForContext,
  countUnreadQuestionsForContext,
  LiveQuestionPanel,
} from "./LiveQuestionPanel";
import { RoomParticipantsPanel } from "./RoomParticipantsPanel";
import type { LiveCourseItem } from "./liveCourseTypes";
import { useLiveQuestions } from "./useLiveQuestions";
import { useLiveRoom } from "./useLiveRoom";
import styles from "./LiveTeachingRoomPage.module.css";

type LiveTeachingRoomPageProps = {
  view: "CHECKLIST" | "CHAT";
};

type EndRoomPreview = {
  roomId: string;
  unansweredQuestionCount: number;
  incompleteChecklistCount: number;
};

function roomIdentityLabel(
  profile: Parameters<typeof profileAccountLabel>[0] | null,
  roomRole: "LEAD" | "ASSISTANT" | null,
) {
  if (roomRole === "LEAD") return "주 강사";
  if (roomRole === "ASSISTANT") return "보조 강사";
  return profile ? profileAccountLabel(profile) : "사용자";
}

export function LiveTeachingRoomPage({ view }: LiveTeachingRoomPageProps) {
  const { roomId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { profile, user, updateNickname, logout } = useAuth();
  const live = useLiveRoom(roomId, profile);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [nickname, setNickname] = useState(profile?.nickname ?? "");
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [questionFilter, setQuestionFilter] = useState("ALL");
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [isEndDialogOpen, setIsEndDialogOpen] = useState(false);
  const [isEndingRoom, setIsEndingRoom] = useState(false);
  const [endRoomPreview, setEndRoomPreview] = useState<EndRoomPreview | null>(null);
  const [endRoomPreviewError, setEndRoomPreviewError] = useState<string | null>(null);
  const [isEndRoomPreviewLoading, setIsEndRoomPreviewLoading] = useState(false);
  const endRoomInFlightRef = useRef(false);
  const [roomShare, setRoomShare] = useState<{
    joinCode: string;
    joinPath: string;
  } | null>(null);

  useEffect(() => {
    setSelectedItemId(null);
    setQuestionFilter("ALL");
    setPendingItemId(null);
    setNotice(null);
  }, [roomId]);

  useEffect(() => {
    const requestedItemId = searchParams.get("itemId");
    if (requestedItemId === "GENERAL" && view === "CHAT") {
      setQuestionFilter("GENERAL");
      return;
    }
    const requestedItemExists = Boolean(
      requestedItemId && live.items.some((item) => item.id === requestedItemId),
    );
    if (requestedItemExists) {
      setSelectedItemId(requestedItemId);
      if (view === "CHAT") setQuestionFilter(requestedItemId as string);
      return;
    }
    if (view === "CHAT") setQuestionFilter("ALL");
    if (!selectedItemId || !live.items.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(live.room?.currentItemId ?? live.items[0]?.id ?? null);
    }
  }, [
    live.items,
    live.room?.currentItemId,
    searchParams,
    selectedItemId,
    view,
  ]);

  useEffect(() => {
    if (!live.permissions.canControlProgress && pendingItemId) {
      setPendingItemId(null);
      setNotice("진행 제어 권한이 회수되어 체크 기능을 읽기 전용으로 전환했습니다.");
    }
  }, [live.permissions.canControlProgress, pendingItemId]);

  const currentItem = live.items.find((item) => item.id === live.room?.currentItemId) ?? null;
  const selectedItem = live.items.find((item) => item.id === selectedItemId) ?? currentItem;
  const isRoomActive =
    live.room?.status === "ACTIVE" || live.room?.status === "LIVE";
  const canControlProgress =
    isRoomActive && (live.isLead || live.permissions.canControlProgress);
  const canEditFlow = live.isLead || live.permissions.canEditCourseFlow;
  const canManageMaterials = live.isLead || live.permissions.canManageMaterials;
  const canShareRoom = live.isLead || live.permissions.canShareRoom;
  const canAnswerQuestions =
    isRoomActive && (live.isLead || live.permissions.canAnswerQuestions);
  const canModerateQuestions =
    live.isLead || live.permissions.canModerateQuestions;
  const canManageParticipants =
    live.isLead || live.permissions.canManageParticipants;
  const canEndRoom = live.isLead || live.permissions.canEndRoom;
  const canViewReports =
    live.isLead || live.permissions.canViewReports || profile?.isAdmin === true;
  const canReadQuestions = Boolean(
    profile?.accountType === "STUDENT" || live.roomRole !== null,
  );
  const liveQuestions = useLiveQuestions(roomId, {
    canModerateQuestions,
    canReadQuestions,
    profile,
  });
  const completedCount = live.items.filter((item) => item.isCompleted).length;
  const completionPercent = live.items.length
    ? Math.round((completedCount / live.items.length) * 100)
    : 0;

  const unreadQuestionCount = countUnreadQuestionsForContext(
    liveQuestions.questions,
    "ALL",
    liveQuestions.readWatermarkByContext,
  );

  useEffect(() => {
    if (!canManageParticipants) setIsParticipantsOpen(false);
  }, [canManageParticipants]);

  useEffect(() => {
    if (!isRoomActive || !canEndRoom) setIsEndDialogOpen(false);
  }, [canEndRoom, isRoomActive]);

  useEffect(() => {
    let active = true;
    if (!canShareRoom || !user) {
      setRoomShare(null);
      return () => {
        active = false;
      };
    }
    void requestApi<Record<string, unknown>>(
      `/api/rooms/${encodeURIComponent(roomId)}/share`,
      { authUser: user },
    )
      .then((payload) => {
        if (!active) return;
        const joinCode = typeof payload.joinCode === "string" ? payload.joinCode : "";
        const joinPath = typeof payload.joinPath === "string" ? payload.joinPath : "";
        setRoomShare(joinCode ? { joinCode, joinPath } : null);
      })
      .catch(() => {
        if (active) setRoomShare(null);
      });
    return () => {
      active = false;
    };
  }, [canShareRoom, roomId, user]);

  const itemNumberById = useMemo(
    () => createCourseItemNumberMap(live.chapters, live.items),
    [live.chapters, live.items],
  );

  const chapterItems = useMemo(
    () =>
      [...live.chapters]
        .sort((first, second) => first.order - second.order || first.id.localeCompare(second.id))
        .map((chapter) => ({
        chapter,
        items: live.items
          .filter((item) => item.chapterId === chapter.id)
          .sort((first, second) => first.order - second.order || first.id.localeCompare(second.id)),
      })),
    [live.chapters, live.items],
  );
  const numberedItems = useMemo(() => {
    const grouped = chapterItems.flatMap((entry) => entry.items);
    const groupedIds = new Set(grouped.map((item) => item.id));
    const ungrouped = live.items
      .filter((item) => !groupedIds.has(item.id))
      .sort((first, second) => first.order - second.order || first.id.localeCompare(second.id));
    return [...grouped, ...ungrouped];
  }, [chapterItems, live.items]);

  async function toggleCompletion(item: LiveCourseItem) {
    if (!canControlProgress || pendingItemId) {
      return;
    }
    setPendingItemId(item.id);
    setNotice("변경 내용을 서버에서 확인하고 있습니다.");
    try {
      await requestApi(`/api/rooms/${encodeURIComponent(roomId)}/items/${encodeURIComponent(item.id)}/completion`, {
        method: "PATCH",
        body: { isCompleted: !item.isCompleted },
        authUser: user,
      });
      setNotice("체크 상태를 저장했습니다. 다른 화면에도 실시간 반영됩니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "체크 상태를 저장하지 못했습니다.");
    } finally {
      setPendingItemId(null);
    }
  }

  async function saveNickname(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateNickname(nickname);
    if (!validation.valid) {
      setNotice(validation.message);
      return;
    }
    try {
      await updateNickname(roomId, validation.nickname);
      setIsEditingNickname(false);
      setNotice("익명 별명을 변경했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "별명을 변경하지 못했습니다.");
    }
  }

  function changeQuestionFilter(contextId: string) {
    setQuestionFilter(contextId);
    if (contextId === "ALL") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ itemId: contextId }, { replace: true });
    }
  }

  async function endRoom() {
    if (!user || !isRoomActive || !canEndRoom || endRoomInFlightRef.current) return;
    endRoomInFlightRef.current = true;
    setIsEndingRoom(true);
    setNotice("강의를 안전하게 종료하고 요약을 만들고 있습니다.");
    try {
      await requestApi(`/api/rooms/${encodeURIComponent(roomId)}/end`, {
        method: "POST",
        body: {},
        authUser: user,
      });
      setIsEndDialogOpen(false);
      setNotice("강의를 종료했습니다. 기존 자료와 질문은 읽기 전용으로 유지됩니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "강의를 종료하지 못했습니다.");
    } finally {
      endRoomInFlightRef.current = false;
      setIsEndingRoom(false);
    }
  }

  async function openEndRoomDialog() {
    if (!user || !isRoomActive || !canEndRoom) return;
    setIsEndDialogOpen(true);
    setEndRoomPreview(null);
    setEndRoomPreviewError(null);
    setIsEndRoomPreviewLoading(true);
    try {
      const preview = await requestApi<EndRoomPreview>(
        `/api/rooms/${encodeURIComponent(roomId)}/end-preview`,
        { authUser: user },
      );
      setEndRoomPreview(preview);
    } catch (error) {
      setEndRoomPreviewError(
        error instanceof Error
          ? error.message
          : "종료 전 강의 현황을 확인하지 못했습니다.",
      );
    } finally {
      setIsEndRoomPreviewLoading(false);
    }
  }

  if (live.isLoading) {
    return <main className={styles.centerState} role="status">실시간 강의방을 불러오는 중입니다.</main>;
  }

  if (!live.room || live.error) {
    return (
      <main className={styles.centerState}>
        <LockKeyhole aria-hidden="true" />
        <h1>강의방에 접근할 수 없습니다</h1>
        <p role="alert">{live.error ?? "강의방 정보를 찾을 수 없습니다."}</p>
        <Link to="/">시작 화면으로 돌아가기</Link>
      </main>
    );
  }

  return (
    <div className={styles.page} data-live-room="true">
      <header className={styles.header}>
        <div className={styles.brandGroup}>
          <Link className={styles.logo} to="/" aria-label="NoDo"><span>NO</span><span>DO</span></Link>
          <span className={styles.livePill}>
            ● {live.room.status === "LIVE" || live.room.status === "ACTIVE" ? "진행 중" : live.room.status === "ENDING" ? "종료 처리 중" : live.room.status === "ENDED" ? "종료" : live.room.status}
          </span>
          <strong className={styles.courseTitle}>{live.courseTitle}</strong>
          {canShareRoom && roomShare ? (
            <Link className={styles.roomCode} to={roomShare.joinPath || `/join/${roomShare.joinCode}`}>
              <Share2 aria-hidden="true" size={15} /> {roomShare.joinCode}
            </Link>
          ) : null}
        </div>
        <nav className={styles.tabs} aria-label="강의 화면 전환">
          <Link className={view === "CHAT" ? styles.activeTab : ""} to={`/rooms/${roomId}/chat`}>채팅 <span title={profile?.accountType === "STUDENT" ? "전체 공개 질문" : `전체 ${liveQuestions.questions.length}개 · 미확인 ${unreadQuestionCount}개`}>{liveQuestions.questions.length}{live.roomRole && unreadQuestionCount ? ` · ${unreadQuestionCount}` : ""}</span></Link>
          <Link className={view === "CHECKLIST" ? styles.activeTab : ""} to={`/rooms/${roomId}/checklist`}>로드맵</Link>
        </nav>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.identity}>
          <span>{roomIdentityLabel(profile, live.roomRole)}</span>
          <strong>{profile?.displayName}</strong>
          {live.permissionUpdatedAt && !live.isLead ? <small>권한 실시간 연결됨</small> : null}
        </div>
        <div className={styles.toolbarActions}>
          {profile?.accountType === "STUDENT" ? (
            isEditingNickname ? (
              <form className={styles.nicknameForm} onSubmit={saveNickname}>
                <input aria-label="새 익명 별명" maxLength={20} value={nickname} onChange={(event) => setNickname(event.target.value)} />
                <button type="submit">저장</button>
              </form>
            ) : (
              <button type="button" onClick={() => setIsEditingNickname(true)}><Pencil aria-hidden="true" size={15} /> 별명 수정</button>
            )
          ) : null}
          {live.isLead ? <Link to={`/rooms/${roomId}/staff`}><UsersRound aria-hidden="true" size={16} /> 보조 강사 권한</Link> : null}
          {canEditFlow ? <Link to={`/courses/${live.room.courseId}/prepare`}><Settings2 aria-hidden="true" size={16} /> 수업 흐름 편집</Link> : null}
          {canManageParticipants ? <button type="button" onClick={() => setIsParticipantsOpen(true)}><UsersRound aria-hidden="true" size={16} /> 참여자 관리</button> : null}
          {isRoomActive && canEndRoom ? <button className={styles.endRoomButton} type="button" onClick={() => void openEndRoomDialog()}><Power aria-hidden="true" size={16} /> 강의 종료</button> : null}
          {!isRoomActive && canViewReports ? <Link to={`/rooms/${roomId}/report`}><BarChart3 aria-hidden="true" size={16} /> 강의 요약</Link> : null}
          <button type="button" onClick={() => void logout()}><LogOut aria-hidden="true" size={16} /> 로그아웃</button>
          <button type="button" aria-pressed={isExpanded} onClick={() => setIsExpanded((current) => !current)}>
            {isExpanded ? <Columns2 aria-hidden="true" size={16} /> : <Maximize2 aria-hidden="true" size={16} />}
            {isExpanded ? "자료와 함께 보기" : `${view === "CHAT" ? "채팅" : "로드맵"} 크게 보기`}
          </button>
        </div>
      </div>

      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {!canControlProgress && view === "CHECKLIST" ? (
        <p className={styles.readOnlyNotice}><LockKeyhole aria-hidden="true" size={16} /> {!isRoomActive ? "종료된 강의이므로 로드맵을 읽기 전용으로 표시합니다." : "진행 제어 권한이 없어 읽기 전용으로 표시됩니다."}</p>
      ) : null}

      <main className={`${styles.layout} ${isExpanded ? styles.expanded : ""}`}>
        {!isExpanded ? (
          <section className={styles.materialPanel} aria-labelledby="live-material-title">
            <div className={styles.materialHeading}>
              <div><p>LIVE MATERIAL</p><h1 id="live-material-title">현재 공유 자료</h1></div>
              {canManageMaterials ? <button type="button" disabled title="자료 업로드 연결은 후속 단계에서 제공합니다.">자료 관리</button> : null}
            </div>
            <nav className={styles.previewList} aria-label="수업 흐름 항목 미리보기">
              {live.items.map((item) => (
                <button key={item.id} type="button" aria-pressed={selectedItem?.id === item.id} onClick={() => setSelectedItemId(item.id)}>
                  <span>{itemNumberById.get(item.id) ?? "–"}</span>
                  <strong>{item.title}</strong>
                  <small>{item.isCompleted ? "완료" : item.id === live.room?.currentItemId ? "현재 진행" : "미완료"}</small>
                </button>
              ))}
            </nav>
            <article className={styles.materialCard} aria-live="polite">
              {selectedItem ? (
                <><span>{selectedItem.kind} · {selectedItem.id === currentItem?.id ? "현재 진행" : "미리보기"}</span><h2>{selectedItem.title}</h2><p>{selectedItem.description || "이 항목의 공유 자료를 표시합니다."}</p></>
              ) : <p>표시할 수업 흐름 항목이 없습니다.</p>}
            </article>
          </section>
        ) : null}

        <aside className={styles.sidePanel} aria-label={view === "CHECKLIST" ? "실시간 로드맵" : "실시간 질문·채팅"}>
          {view === "CHECKLIST" ? (
            <>
              <div className={styles.progressHeader}>
                <div><p>REALTIME ROADMAP</p><h2>챕터별 전체 로드맵</h2></div>
                <strong>{completedCount} / {live.items.length}</strong>
              </div>
              <div className={styles.progressTrack}><span style={{ width: `${completionPercent}%` }} /></div>
              <div className={styles.chapterList}>
                {chapterItems.map(({ chapter, items }) => (
                  <section key={chapter.id}>
                    <header><h3>{chapter.title}</h3><span>{items.filter((item) => item.isCompleted).length} / {items.length}</span></header>
                    <ol>
                      {items.map((item) => {
                        const isCurrent = item.id === live.room?.currentItemId;
                        const canToggleItem = canControlProgress && (item.isCompleted || isCurrent) && !pendingItemId;
                        return (
                          <li key={item.id} data-completion-state={item.isCompleted ? "completed" : isCurrent ? "current" : "future"}>
                            <label>
                              <input type="checkbox" checked={item.isCompleted} disabled={!canToggleItem} onChange={() => void toggleCompletion(item)} aria-label={`${numberedCourseItemLabel(item, itemNumberById)} 완료`} />
                              <span className={styles.checkmark}>{item.isCompleted ? <Check aria-hidden="true" size={15} /> : null}</span>
                              <span className={styles.itemCopy}><strong><b>{itemNumberById.get(item.id)}</b> {item.title}</strong><small>{item.isCompleted ? "완료" : isCurrent ? "현재 진행" : "미완료"}</small></span>
                            </label>
                            <Link
                              className={styles.questionBadge}
                              to={`/rooms/${roomId}/chat?itemId=${encodeURIComponent(item.id)}`}
                              aria-label={`${numberedCourseItemLabel(item, itemNumberById)} 질문 ${countQuestionsForContext(liveQuestions.questions, item.id)}개${live.roomRole ? `, 미확인 ${countUnreadQuestionsForContext(liveQuestions.questions, item.id, liveQuestions.readWatermarkByContext)}개` : ""}`}
                            >
                              <MessageCircle aria-hidden="true" size={14} />
                              <span>{countQuestionsForContext(liveQuestions.questions, item.id)}</span>
                              {live.roomRole && countUnreadQuestionsForContext(liveQuestions.questions, item.id, liveQuestions.readWatermarkByContext) > 0 ? (
                                <small>{countUnreadQuestionsForContext(liveQuestions.questions, item.id, liveQuestions.readWatermarkByContext)} 새 질문</small>
                              ) : null}
                            </Link>
                            <button type="button" onClick={() => setSelectedItemId(item.id)} aria-label={`${item.title} 자료 보기`}><ChevronRight aria-hidden="true" size={17} /></button>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                ))}
              </div>
            </>
          ) : (
            <LiveQuestionPanel
              roomId={roomId}
              questions={liveQuestions.questions}
              items={numberedItems}
              itemNumberById={itemNumberById}
              profile={profile}
              user={user}
              filterContext={questionFilter}
              onFilterContextChange={changeQuestionFilter}
              readWatermarkByContext={liveQuestions.readWatermarkByContext}
              canAnswerQuestions={canAnswerQuestions}
              canModerateQuestions={canModerateQuestions}
              isQuestionRestricted={liveQuestions.isQuestionRestricted}
              isRoomActive={isRoomActive}
              isLoading={liveQuestions.isLoading}
              subscriptionError={liveQuestions.error}
            />
          )}
        </aside>
      </main>

      <RoomParticipantsPanel
        roomId={roomId}
        user={user}
        open={isParticipantsOpen}
        isRoomActive={isRoomActive}
        onClose={() => setIsParticipantsOpen(false)}
      />

      {isEndDialogOpen ? (
        <div className={styles.dialogBackdrop} role="presentation">
          <section
            className={styles.endDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="end-room-title"
          >
            <span><Power aria-hidden="true" size={18} /> 강의 종료</span>
            <h2 id="end-room-title">정말 강의를 종료할까요?</h2>
            {isEndRoomPreviewLoading ? (
              <p role="status">전체 질문과 로드맵 현황을 확인하는 중입니다.</p>
            ) : endRoomPreviewError ? (
              <p role="alert">{endRoomPreviewError}</p>
            ) : endRoomPreview ? (
              <div className={styles.endSummary}>
                <p><strong>{endRoomPreview.unansweredQuestionCount}</strong><span>미답변 질문</span></p>
                <p><strong>{endRoomPreview.incompleteChecklistCount}</strong><span>미완료 로드맵</span></p>
              </div>
            ) : null}
            <p>종료 후 새 참여·질문·로드맵 변경이 차단됩니다. 기존 자료와 질문·답변은 읽기 전용으로 계속 확인할 수 있습니다.</p>
            <div>
              <button type="button" disabled={isEndingRoom} onClick={() => setIsEndDialogOpen(false)}>취소</button>
              {endRoomPreviewError ? (
                <button type="button" disabled={isEndRoomPreviewLoading} onClick={() => void openEndRoomDialog()}>현황 다시 확인</button>
              ) : null}
              <button type="button" disabled={isEndingRoom || isEndRoomPreviewLoading || !endRoomPreview} onClick={() => void endRoom()}>{isEndingRoom ? "종료 처리 중" : "강의 종료 확인"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
