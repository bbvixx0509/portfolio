import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { LiveRoomShell } from "../live-room/LiveRoomShell";
import { LiveRoomShareControl } from "../live-room/LiveRoomHeaderControls";
import styles from "./CloudRoomPages.module.css";
import {
  exportCloudRoomQuestionsCsv,
  csvExportErrorMessage,
} from "../cloud-questions/cloudQuestionApi";
import {
  getCloudRoom,
  getCloudRoomEndSummary,
  reopenCloudRoom,
  type CloudRoomEndSummary,
  type CloudRoomRecord,
} from "./roomApi";
import { RoomReopenDialog, roomReopenErrorMessage } from "./RoomReopenDialog";
import {
  formatKoreanDateTime,
  isStudentAccessOpen,
  studentAccessDeadline,
} from "./endAccessDeadline";

function formatDate(value: string | null) {
  return formatKoreanDateTime(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "종료 요약을 불러오지 못했습니다.";
}

export function CloudRoomEndSummaryPage() {
  const { roomId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [summary, setSummary] = useState<CloudRoomEndSummary | null>(null);
  const [room, setRoom] = useState<CloudRoomRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [reopenDialogOpen, setReopenDialogOpen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const exportInFlightRef = useRef(false);

  useEffect(() => {
    let active = true;
    void Promise.all([getCloudRoomEndSummary(user, roomId), getCloudRoom(user, roomId)])
      .then(([nextSummary, nextRoom]) => {
        if (!active) return;
        setSummary(nextSummary);
        setRoom(nextRoom);
      })
      .catch((error: unknown) => {
        if (active) setNotice(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [roomId, user]);

  if (notice) return <p role="alert">{notice}</p>;
  if (!summary || !room) return <p role="status">종료 요약을 불러오는 중입니다.</p>;

  const completedLabel = `${summary.checklistCompletedCount} / ${summary.checklistTotalCount}`;
  const questionLabel = `${summary.totalQuestionCount} / ${summary.answeredQuestionCount}`;
  const downloadMessage = summary.downloadEnabled
    ? summary.downloadAvailableUntil
      ? `학생 자료 열람·다운로드 마감: ${formatDate(summary.downloadAvailableUntil)}`
      : "학생 자료 열람·다운로드는 강의 종료와 함께 마감되었습니다."
    : "학생 자료 열람·다운로드는 강의 종료와 함께 마감되었습니다.";
  const deadline = studentAccessDeadline(summary.endedAt, summary.downloadAvailableUntil);
  const canExport = room.currentRole === "LEAD_INSTRUCTOR"
    && summary.status === "ENDED"
    && isStudentAccessOpen(summary.endedAt, summary.downloadAvailableUntil);
  const canShare = (room.currentRole === "LEAD_INSTRUCTOR" || room.currentRole === "ASSISTANT")
    && isStudentAccessOpen(summary.endedAt, summary.downloadAvailableUntil);
  const exportPeriodMessage = canExport
    ? "채팅 기록은 자료 다운로드 마감 전까지 내보낼 수 있습니다."
    : "채팅 기록 내보내기 기간이 종료되었습니다.";

  async function exportChatHistory() {
    if (!canExport || exportInFlightRef.current) return;
    exportInFlightRef.current = true;
    setExporting(true);
    setExportError(null);
    try {
      const { blob, filename } = await exportCloudRoomQuestionsCsv(user, roomId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error: unknown) {
      setExportError(csvExportErrorMessage(error));
    } finally {
      exportInFlightRef.current = false;
      setExporting(false);
    }
  }

  async function reopenRoom() {
    if (!room || reopening) return;
    setReopening(true);
    setReopenError(null);
    try {
      await reopenCloudRoom(user, roomId, room.revision);
      navigate(`/rooms/${encodeURIComponent(roomId)}/checklist`, { replace: true });
    } catch (error) {
      setReopenError(roomReopenErrorMessage(error));
      setReopening(false);
    }
  }

  return (
    <>
      <LiveRoomShell
      homeTo="/rooms"
      homeLabel="강의방 목록"
      roomTitle={summary.title}
      roomMeta="강사 운영 · 종료됨"
      panelLabel="강의 종료 요약"
      panelTitle="종료 요약"
      headerAction={
        <>
          {canShare ? <LiveRoomShareControl roomId={roomId} roomCode={room.roomCode} message="자료 열람 기간 동안 학생이 다시 접속할 수 있습니다." /> : null}
        </>
      }
      tabs={[
        { label: "종료 요약", to: `/rooms/${encodeURIComponent(roomId)}/summary`, active: true },
        { label: "자료", to: `/rooms/${encodeURIComponent(roomId)}/material`, active: false },
      ]}
      context={
        <>
          <div className={styles.liveContextHeading}>
            <p className={styles.eyebrow}>강의 종료 요약</p>
            <h1>{summary.title}</h1>
            <p>강의가 종료되어 로드맵과 질문은 읽기 전용으로 유지됩니다.</p>
          </div>
          <dl className={styles.liveContextFacts}>
            <div><dt>강의 상태</dt><dd>종료됨</dd></div>
            <div><dt>완료율</dt><dd>{summary.completionRate}%</dd></div>
          </dl>
          <section className={styles.currentFlowContext}>
            <p>학생 자료 열람 마감</p>
            <h2>{downloadMessage}</h2>
            <span>종료 뒤에는 이 마감 정책을 다시 편집할 수 없습니다.</span>
          </section>
          {summary.status === "ENDED" && room.currentRole === "LEAD_INSTRUCTOR" ? (
            <section className={styles.currentFlowContext} aria-label="채팅 기록 내보내기">
              <p>채팅 기록 내보내기</p>
              <h2>{deadline ? formatDate(deadline.toISOString()) : "마감 시각을 확인할 수 없습니다."}</h2>
              <span>{exportPeriodMessage}</span>
              {canExport ? (
                <button
                  className={styles.primaryAction}
                  type="button"
                  onClick={() => void exportChatHistory()}
                  disabled={exporting}
                >
                  {exporting ? "내보내는 중" : "채팅 기록 내보내기"}
                </button>
              ) : null}
              {exportError ? (
                <div>
                  <p role="alert">{exportError}</p>
                  <button
                    type="button"
                    onClick={() => void exportChatHistory()}
                    disabled={exporting || !canExport}
                  >
                    다시 시도
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
          {room.currentRole === "LEAD_INSTRUCTOR" && room.canReopen ? (
            <section className={styles.currentFlowContext} aria-label="강의 종료 취소">
              <p>강의 종료 취소</p>
              <h2>방금 종료한 강의방을 다시 열 수 있습니다.</h2>
              <span>학생 입장과 질문 기능이 다시 활성화됩니다.</span>
              <button
                className={styles.primaryAction}
                type="button"
                onClick={() => { setReopenError(null); setReopenDialogOpen(true); }}
              >
                종료 취소
              </button>
            </section>
          ) : null}
        </>
      }
      panel={
        <article className={styles.livePanelContent}>
          <dl className={styles.details}>
            <div><dt>시작 시각</dt><dd>{formatDate(summary.startedAt)}</dd></div>
            <div><dt>종료 시각</dt><dd>{formatDate(summary.endedAt)}</dd></div>
            <div><dt>로드맵 완료</dt><dd>{completedLabel}</dd></div>
            <div><dt>질문 / 답변 완료</dt><dd>{questionLabel}</dd></div>
            <div><dt>누적 참여자</dt><dd>{summary.participantCount}명</dd></div>
            <div><dt>종료 시점 접속</dt><dd>{summary.activeParticipantCount}명</dd></div>
          </dl>
          <p className={styles.readOnly}>이 강의방은 종료되어 읽기 전용입니다.</p>
          <Link className={styles.openButton} to={`/rooms/${encodeURIComponent(roomId)}/checklist`}>로드맵 보기</Link>
        </article>
      }
      />
      <RoomReopenDialog
        open={reopenDialogOpen}
        pending={reopening}
        error={reopenError}
        onCancel={() => { if (!reopening) { setReopenDialogOpen(false); setReopenError(null); } }}
        onConfirm={() => void reopenRoom()}
      />
    </>
  );
}
