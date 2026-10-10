import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { LiveRoomShell } from "../live-room/LiveRoomShell";
import { LiveRoomMaterialPane } from "./LiveRoomMaterialPane";
import {
  getCloudRoomMaterialAccess,
  getStudentRoomMaterialAccess,
  updateCloudRoomMaterialDownloadPolicy,
  type RoomMaterialAccess,
} from "./roomMaterialApi";
import { formatKoreanDateTime } from "../cloud-rooms/endAccessDeadline";

const KOREA_TIME_ZONE = "Asia/Seoul";
const MAX_DOWNLOAD_WINDOW_MS = 365 * 86_400_000;

export function StaffRoomMaterialPage() {
  const { roomId = "" } = useParams();
  const { user } = useAuth();
  const base = `/rooms/${encodeURIComponent(roomId)}`;
  const [access, setAccess] = useState<RoomMaterialAccess | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [until, setUntil] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const loadAccess = useCallback(async () => {
    if (!user) return;
    setNotice("");
    try {
      const value = await getCloudRoomMaterialAccess(user, roomId);
      setAccess(value);
      setEnabled(value.material?.downloadEnabled === true);
      setUntil(toKoreanDateTimeInput(value.material?.downloadAvailableUntil ?? null));
    } catch {
      setAccess(null);
      setNotice("다운로드 설정을 불러오지 못했습니다.");
    }
  }, [roomId, user]);
  useEffect(() => {
    void loadAccess();
  }, [loadAccess]);
  function preset(days: number) {
    setUntil(toKoreanDateTimeInput(new Date(Date.now() + days * 86_400_000).toISOString()));
    setEnabled(true);
  }
  async function save() {
    if (!user || !access?.material || saving) return;
    const deadline = enabled ? koreanInputToDate(until) : null;
    const now = new Date();
    if (enabled && (!deadline || Number.isNaN(deadline.getTime()) || deadline <= now || deadline.getTime() > now.getTime() + MAX_DOWNLOAD_WINDOW_MS)) {
      setNotice("마감 시간은 지금 이후 365일 이내로 선택해 주세요."); return;
    }
    const iso = deadline?.toISOString() ?? null;
    setSaving(true); setNotice("");
    try {
      const result = await updateCloudRoomMaterialDownloadPolicy(user, roomId, { downloadEnabled: enabled, downloadAvailableUntil: iso, expectedDownloadPolicyRevision: access.material.downloadPolicyRevision });
      setAccess(result); setNotice(enabled ? "다운로드 기간을 저장했습니다." : "자료 다운로드를 중지했습니다.");
    } catch { setNotice("다운로드 설정을 저장하지 못했습니다. 최신 상태를 확인해 주세요."); }
    finally { setSaving(false); }
  }
  const material = access?.material;
  const policy = material?.canViewDownloadPolicy ? (
    <section aria-label="자료 다운로드 기간 설정">
      <h2>자료 다운로드 기간</h2>
      <p>
        {material.downloadEnabled && material.downloadAvailableUntil
          ? `자료 다운로드 가능: ${formatKoreanDate(material.downloadAvailableUntil)}까지`
          : "자료 다운로드가 허용되지 않았습니다."}
      </p>
      {material.downloadPolicyLocked ? <p role="status">강의가 종료되어 다운로드 기간은 읽기 전용입니다.</p> : null}
      {material.canManageDownloadPolicy ? <>
        <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={saving} /> 다운로드 허용</label>
        {enabled ? <><div><button type="button" onClick={() => preset(1)} disabled={saving}>지금부터 1일</button><button type="button" onClick={() => preset(7)} disabled={saving}>7일</button><button type="button" onClick={() => preset(30)} disabled={saving}>30일</button></div><label>직접 마감 날짜·시간<input type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} max={toKoreanDateTimeInput(new Date(Date.now() + MAX_DOWNLOAD_WINDOW_MS).toISOString())} disabled={saving} /></label></> : null}
        <button type="button" onClick={() => void save()} disabled={saving}>{saving ? "저장 중" : "설정 저장"}</button>
      </> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  ) : notice ? <><p role="status">{notice}</p><button type="button" onClick={() => void loadAccess()}>다운로드 설정 다시 시도</button></> : null;
  return <LiveRoomShell homeTo="/rooms" homeLabel="강의방 목록" roomTitle="강의 자료" roomMeta="강사 운영 · 자료 보기" panelLabel="강의 자료 패널" panelTitle="강의 자료" tabs={[
    { label: "자료", to: `${base}/material`, active: true },
    { label: "채팅", to: `${base}/chat`, active: false },
    { label: "로드맵", to: `${base}/checklist`, active: false },
  ]} context={<><p>비공개 수업 자료</p><h1>강의 자료 보기</h1><p>자료는 NoDo 서버를 통해서만 표시·다운로드됩니다.</p>{policy}</>} panel={<LiveRoomMaterialPane user={user} scope={{ mode: "staff", roomId }} />} />;
}

function toKoreanDateTimeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: KOREA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function koreanInputToDate(value: string) {
  return new Date(`${value.length === 16 ? `${value}:00` : value}+09:00`);
}

function formatKoreanDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "기록 없음" : new Intl.DateTimeFormat("ko-KR", { timeZone: KOREA_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function StudentRoomMaterialPage() {
  const { orgId = "", roomCode = "" } = useParams();
  const { user } = useAuth();
  const base = `/join/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}`;
  const [access, setAccess] = useState<RoomMaterialAccess | null>(null);
  const [accessNotice, setAccessNotice] = useState("");

  useEffect(() => {
    if (!user) return;
    let active = true;
    void getStudentRoomMaterialAccess(user, orgId, roomCode)
      .then((value) => {
        if (!active) return;
        setAccess(value);
        setAccessNotice("");
      })
      .catch(() => {
        if (active) setAccessNotice("자료 열람 마감 정보를 불러오지 못했습니다.");
      });
    return () => {
      active = false;
    };
  }, [orgId, roomCode, user]);

  const deadlineMessage = access?.material
    ? access.material.downloadAvailableUntil
      ? `학생 자료 열람·다운로드 마감: ${formatKoreanDateTime(access.material.downloadAvailableUntil)}`
      : "학생 자료 열람·다운로드는 강의 종료와 함께 마감되었습니다."
    : "연결된 자료가 없거나 자료 열람 기간이 마감되었습니다.";
  return <LiveRoomShell homeTo={base} homeLabel="학생 강의 홈" roomTitle="강의 자료" roomMeta="익명 수강생 · 자료 보기" panelLabel="강의 자료 패널" panelTitle="강의 자료" tabs={[
    { label: "자료", to: `${base}/material`, active: true },
    { label: "채팅", to: `${base}/chat`, active: false },
    { label: "로드맵", to: `${base}/checklist`, active: false },
  ]} context={<><p>수업 자료</p><h1>강의 자료 보기</h1><p>학생은 마감 전 자료만 열람·다운로드할 수 있습니다.</p><section aria-label="학생 자료 열람 마감 안내"><h2>{deadlineMessage}</h2><p>종료 뒤에는 강사가 선택한 마감 정책을 다시 바꿀 수 없습니다.</p>{accessNotice ? <p role="status">{accessNotice}</p> : null}</section></>} panel={<LiveRoomMaterialPane user={user} scope={{ mode: "student", orgId, roomCode }} />} />;
}
