import { ArrowLeft, BarChart3, Download, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../features/auth/AuthContext";
import type {
  LiveRoomSummary,
  RoomSummaryItemCount,
} from "../features/live-course/liveCourseTypes";
import { requestApi } from "../lib/api/apiClient";
import styles from "./LiveRoomReportPage.module.css";

function numberValue(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof data[key] === "number") return data[key] as number;
  }
  return 0;
}

function stringValue(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof data[key] === "string") return data[key] as string;
  }
  return "";
}

function normalizeItemCounts(value: unknown): RoomSummaryItemCount[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const data = entry as Record<string, unknown>;
        return {
          itemId: stringValue(data, "itemId") || null,
          itemNumber:
            stringValue(data, "itemNumber", "itemNumberSnapshot") || null,
          itemTitle:
            stringValue(data, "itemTitle", "itemTitleSnapshot", "title") ||
            "일반 질문방",
          questionCount: numberValue(data, "questionCount", "count"),
        };
      })
      .filter((entry): entry is RoomSummaryItemCount => Boolean(entry));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(
      ([itemId, count]) => ({
        itemId: itemId === "GENERAL" ? null : itemId,
        itemNumber: null,
        itemTitle: itemId === "GENERAL" ? "일반 질문방" : itemId,
        questionCount: typeof count === "number" ? count : 0,
      }),
    );
  }
  return [];
}

export function normalizeRoomSummary(payload: unknown): LiveRoomSummary {
  const root =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const data =
    root.summary && typeof root.summary === "object"
      ? (root.summary as Record<string, unknown>)
      : root;
  return {
    roomId: stringValue(data, "roomId"),
    roomTitle: stringValue(data, "roomTitle", "title") || "NoDo 강의 요약",
    participantCount: numberValue(data, "participantCount"),
    totalQuestionCount: numberValue(
      data,
      "totalQuestionCount",
      "questionCount",
    ),
    publicQuestionCount: numberValue(data, "publicQuestionCount"),
    reviewQuestionCount: numberValue(data, "reviewQuestionCount"),
    hiddenQuestionCount: numberValue(data, "hiddenQuestionCount"),
    answeredQuestionCount: numberValue(data, "answeredQuestionCount"),
    unansweredQuestionCount: numberValue(data, "unansweredQuestionCount"),
    checklistTotalCount: numberValue(data, "checklistTotalCount"),
    checklistCompletedCount: numberValue(data, "checklistCompletedCount"),
    itemQuestionCounts: normalizeItemCounts(data.itemQuestionCounts),
    endedAt: stringValue(data, "endedAt") || null,
    endedByDisplayName:
      stringValue(data, "endedByDisplayName") || "강의 담당자",
    exportStatus: stringValue(data, "exportStatus") || "NOT_CONFIGURED",
  };
}

function formatDate(value: string | null) {
  if (!value) return "종료 시각을 확인할 수 없습니다.";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

export function LiveRoomReportPage() {
  const { roomId = "" } = useParams();
  const { user, profile, isLoading: isAuthLoading } = useAuth();
  const [summary, setSummary] = useState<LiveRoomSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!user) {
      setError("강의 요약을 보려면 로그인이 필요합니다.");
      setIsLoading(false);
      return;
    }
    let active = true;
    setIsLoading(true);
    setError(null);
    void requestApi<unknown>(`/api/rooms/${encodeURIComponent(roomId)}/report`, {
      authUser: user,
    })
      .then((payload) => {
        if (active) setSummary(normalizeRoomSummary(payload));
      })
      .catch((nextError: unknown) => {
        if (active) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "강의 요약을 불러오지 못했습니다.",
          );
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isAuthLoading, roomId, user]);

  if (isLoading) {
    return <main className={styles.state} role="status">강의 요약을 불러오는 중입니다.</main>;
  }

  if (!summary || error) {
    return (
      <main className={styles.state}>
        <LockKeyhole aria-hidden="true" />
        <h1>강의 요약을 볼 수 없습니다</h1>
        <p role="alert">{error ?? "요약 데이터가 없습니다."}</p>
        <Link to={`/rooms/${roomId}/checklist`}>강의 화면으로 돌아가기</Link>
      </main>
    );
  }

  const metrics = [
    ["참여 인원", summary.participantCount],
    ["전체 질문", summary.totalQuestionCount],
    ["공개 질문", summary.publicQuestionCount],
    ["검토 질문", summary.reviewQuestionCount],
    ["숨김 질문", summary.hiddenQuestionCount],
    ["답변 완료", summary.answeredQuestionCount],
    ["미답변", summary.unansweredQuestionCount],
    ["체크 완료", `${summary.checklistCompletedCount} / ${summary.checklistTotalCount}`],
  ];

  return (
    <div className={styles.page}>
      <header>
        <Link to={`/rooms/${roomId}/checklist`}>
          <ArrowLeft aria-hidden="true" size={17} /> 강의 화면
        </Link>
        <strong aria-label="NoDo">NO<span>DO</span></strong>
        <span>{profile?.displayName ?? "강의 담당자"}</span>
      </header>
      <main>
        <section className={styles.hero}>
          <div>
            <p><BarChart3 aria-hidden="true" size={15} /> LOCAL ROOM REPORT</p>
            <h1>{summary.roomTitle}</h1>
            <span>{formatDate(summary.endedAt)} · {summary.endedByDisplayName} 종료</span>
          </div>
          <button type="button" disabled title="Google Sheets 내보내기는 NoDo_02 이후에 연결합니다.">
            <Download aria-hidden="true" size={16} /> 결과 내보내기 준비 중
          </button>
        </section>

        <section className={styles.metrics} aria-label="강의 요약 지표">
          {metrics.map(([label, value]) => (
            <article key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </section>

        <section className={styles.itemReport}>
          <div><h2>항목별 질문</h2><span>질문이 생성될 당시의 항목 문맥 기준</span></div>
          {summary.itemQuestionCounts.length ? (
            <ol>
              {summary.itemQuestionCounts.map((entry, index) => (
                <li key={entry.itemId ?? `general-${index}`}>
                  <span>{entry.itemNumber ?? "일반"}</span>
                  <strong>{entry.itemTitle}</strong>
                  <b>{entry.questionCount}개</b>
                </li>
              ))}
            </ol>
          ) : <p>항목별 질문이 없습니다.</p>}
        </section>

        <p className={styles.exportNotice}>
          내보내기 상태: <strong>{summary.exportStatus}</strong> · 이번 버전은 Emulator 로컬 요약만 제공하며 외부 Sheets에는 전송하지 않습니다.
        </p>
      </main>
    </div>
  );
}
