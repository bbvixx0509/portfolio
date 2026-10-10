import { Check, Clipboard, Copy, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { getCloudCourse, type CourseRecord } from "../cloud-courses/courseApi";
import {
  cloudRoomShareLink,
  copyCloudRoomValue,
  createCloudRoom,
  getCloudRoom,
  getCloudRoomShare,
  isValidCloudRoomTitle,
  listCloudRooms,
  reopenCloudRoom,
  validActiveParticipantCapacity,
  type CloudRoomRecord,
  type CloudRoomSummary,
} from "./roomApi";
import { CloudRoomInstructorManager } from "./CloudRoomInstructorManager";
import { RoomReopenDialog, roomReopenErrorMessage } from "./RoomReopenDialog";
import styles from "./CloudRoomPages.module.css";

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatRoomTime(value: string | null) {
  if (!value) return "날짜 정보 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

type RoomSort = "RECENT" | "OLDEST" | "TITLE_KO";

const roomTitleCollator = new Intl.Collator("ko-KR", { numeric: true });

export function sortCloudRooms(rooms: CloudRoomSummary[], sort: RoomSort) {
  return [...rooms].sort((left, right) => {
    if (sort === "TITLE_KO") {
      return roomTitleCollator.compare(left.title, right.title) || roomTitleCollator.compare(left.id, right.id);
    }
    const leftTimestamp = left.status === "ENDED"
      ? left.endedAt ?? left.updatedAt ?? left.createdAt
      : left.updatedAt ?? left.createdAt;
    const rightTimestamp = right.status === "ENDED"
      ? right.endedAt ?? right.updatedAt ?? right.createdAt
      : right.updatedAt ?? right.createdAt;
    const leftTime = leftTimestamp ? Date.parse(leftTimestamp) : 0;
    const rightTime = rightTimestamp ? Date.parse(rightTimestamp) : 0;
    const difference = sort === "RECENT" ? rightTime - leftTime : leftTime - rightTime;
    return difference || roomTitleCollator.compare(left.title, right.title) || roomTitleCollator.compare(left.id, right.id);
  });
}

function PageHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.headerActions}>{children}</div>
  );
}

export function CloudRoomCreatePage() {
  const { courseId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sourceCourse, setSourceCourse] = useState<CourseRecord | null>(null);
  const [title, setTitle] = useState("");
  const [maxActiveParticipants, setMaxActiveParticipants] = useState("50");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getCloudCourse(user, courseId)
      .then((course) => {
        if (!active) return;
        setSourceCourse(course);
        setTitle(`${course.title} 강의방`);
      })
      .catch((error: unknown) => {
        if (active) setNotice(message(error, "원본 수업 흐름을 불러오지 못했습니다."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [courseId, user]);

  const activeCourse = sourceCourse?.status === "ACTIVE";
  const titleValid = isValidCloudRoomTitle(title);
  const capacityValue = Number(maxActiveParticipants);
  const capacityValid = validActiveParticipantCapacity(capacityValue);

  async function create() {
    if (!activeCourse || !titleValid || !capacityValid || creating) return;
    setCreating(true);
    setNotice(null);
    try {
      const room = await createCloudRoom(user, courseId, title, capacityValue);
      navigate(`/rooms/${room.id}/prepare`, { replace: true });
    } catch (error) {
      setNotice(message(error, "강의방을 만들지 못했습니다."));
      setCreating(false);
    }
  }

  if (loading) return <p role="status">원본 수업 흐름을 불러오는 중입니다.</p>;
  return (
    <main className={`${styles.page} ${styles.roomCreatePage}`}>
      <PageHeader><Link className={styles.roomCreateBack} to="/courses/import">수업 흐름 목록</Link></PageHeader>
      <section className={styles.roomCreateCard} aria-labelledby="room-create-title">
        <header className={styles.roomCreateHeader}>
          <p className={styles.eyebrow}>강의 준비</p>
          <h1 id="room-create-title">새 수업 열기</h1>
          <p>수업을 시작할 때 사용할 기본 설정을 정합니다.</p>
        </header>
        {sourceCourse ? (
          <section className={styles.roomCreateSource} aria-label="원본 수업 흐름">
            <span>원본 수업 흐름</span>
            <strong title={sourceCourse.title}>{sourceCourse.title}</strong>
          </section>
        ) : null}
        {!activeCourse ? <p role="alert">보관된 수업 흐름에서는 새 수업을 열 수 없습니다.</p> : null}
        <div className={styles.roomCreateFields}>
          <label className={styles.roomCreateField}>
            <span>수업 이름</span>
            <input
              aria-label="수업 이름"
              value={title}
              disabled={!activeCourse || creating}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={100}
            />
          </label>
          {title && !titleValid ? <p role="alert">수업 이름은 1~100자로 입력해 주세요.</p> : null}
          <fieldset className={styles.roomCreateCapacity} disabled={!activeCourse || creating}>
            <legend>동시 참여 정원</legend>
            <div className={styles.roomCreateCapacityControls}>
              <div className={styles.roomCreateCapacityChoices}>
                {[20, 50, 100].map((value) => (
                  <button key={value} type="button" onClick={() => setMaxActiveParticipants(String(value))} aria-pressed={capacityValue === value}>
                    {value}명
                  </button>
                ))}
              </div>
              <label className={styles.roomCreateCustomCapacity}>
                <span>직접 입력</span>
                <span>
                  <input
                    aria-label="동시 참여 정원"
                    inputMode="numeric"
                    min={1}
                    max={300}
                    value={maxActiveParticipants}
                    onChange={(event) => setMaxActiveParticipants(event.target.value)}
                  />
                  <em>명</em>
                </span>
              </label>
            </div>
            <p>누적 참여자가 아니라 현재 접속한 익명 수강생 기준입니다.</p>
          </fieldset>
          {maxActiveParticipants && !capacityValid ? <p role="alert">동시 참여 정원은 1~300명의 정수로 입력해 주세요.</p> : null}
          {notice ? <p role="alert">{notice}</p> : null}
        </div>
        <div className={styles.roomCreateActions}>
          <button type="button" onClick={() => navigate(`/courses/${courseId}/prepare`)} disabled={creating}>
            <X aria-hidden="true" /> 취소
          </button>
          <button type="button" onClick={() => void create()} disabled={!activeCourse || !titleValid || !capacityValid || creating}>
            <Plus aria-hidden="true" /> {creating ? "준비 중..." : "새 수업 열기"}
          </button>
        </div>
      </section>
    </main>
  );
}

export function CloudRoomListPage() {
  const { user } = useAuth();
  const [rooms, setRooms] = useState<CloudRoomSummary[]>([]);
  const [sort, setSort] = useState<RoomSort>("RECENT");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [reopenTarget, setReopenTarget] = useState<CloudRoomSummary | null>(null);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    void listCloudRooms(user)
      .then((next) => {
        if (active) setRooms(next);
      })
      .catch((error: unknown) => {
        if (active) setNotice(message(error, "강의방 목록을 불러오지 못했습니다."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user]);

  const { activeRooms, endedRooms } = useMemo(() => {
    return {
      activeRooms: sortCloudRooms(rooms.filter((room) => room.status !== "ENDED"), sort),
      endedRooms: sortCloudRooms(rooms.filter((room) => room.status === "ENDED"), sort),
    };
  }, [rooms, sort]);

  async function reopen() {
    if (!reopenTarget || reopening) return;
    setReopening(true);
    setReopenError(null);
    try {
      await reopenCloudRoom(user, reopenTarget.id, reopenTarget.revision);
      navigate(`/rooms/${encodeURIComponent(reopenTarget.id)}/checklist`, { replace: true });
    } catch (error) {
      setReopenError(roomReopenErrorMessage(error));
      setReopening(false);
    }
  }

  function openReopenDialog(room: CloudRoomSummary) {
    setReopenTarget(room);
    setReopenError(null);
  }

  function statusLabel(status: CloudRoomSummary["status"]) {
    if (status === "LIVE") return "진행 중";
    if (status === "ENDED") return "종료됨";
    return "준비 중";
  }

  function roleLabel(role: CloudRoomSummary["currentRole"]) {
    return role === "LEAD_INSTRUCTOR" ? "주 강사" : "보조 강사";
  }

  function roomAction(room: CloudRoomSummary) {
    if (room.status === "ENDED" && room.currentRole === "LEAD_INSTRUCTOR") {
      return <Link className={styles.openButton} to={`/rooms/${room.id}/summary`}>종료 요약 보기</Link>;
    }
    if (room.status === "ENDED") {
      return <Link className={styles.openButton} to={`/rooms/${room.id}/checklist`}>로드맵 보기</Link>;
    }
    return <Link className={styles.openButton} to={`/rooms/${room.id}/prepare`}>강의방 열기</Link>;
  }

  function renderRoomList(items: CloudRoomSummary[]) {
    if (items.length === 0) {
      return <p className={styles.sectionEmpty}>표시할 강의방이 없습니다.</p>;
    }
    return (
      <ul className={styles.list}>
        {items.map((room) => (
          <li key={room.id}>
            <div className={styles.roomListDetails}>
              <div className={styles.cardTitle}><h3>{room.title}</h3><span className={`${styles.roomStatus} ${styles[`status${room.status}`]}`}>{statusLabel(room.status)}</span></div>
              <p>원본 수업: {room.sourceCourseTitle}</p>
              <small>{room.status === "ENDED" ? `종료 시각: ${formatRoomTime(room.endedAt ?? null)}` : room.status === "LIVE" ? `시작 시각: ${formatRoomTime(room.startedAt ?? null)}` : `최근 수정: ${formatRoomTime(room.updatedAt ?? room.createdAt)}`}</small>
              <small>내 역할: {roleLabel(room.currentRole)}</small>
              <small>자료 다운로드 마감: {formatRoomTime(room.downloadAvailableUntil ?? null)}</small>
            </div>
            <div className={styles.roomListActions}>
              {roomAction(room)}
              {room.status === "ENDED" && room.currentRole === "LEAD_INSTRUCTOR" && room.canReopen ? (
                <button type="button" className={styles.reopenButton} onClick={() => openReopenDialog(room)}>종료 취소</button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <main className={styles.page}>
      <PageHeader><Link to="/courses/import">수업 흐름 목록</Link></PageHeader>
      <section className={styles.heading}>
        <p className={styles.eyebrow}>실제 수업 회차</p>
        <h1>강의방</h1>
        <p>내가 만들었거나 배정받은 강의방의 현재 상태를 확인합니다.</p>
        <label className={styles.sortField}>정렬
          <select aria-label="강의방 정렬" value={sort} onChange={(event) => setSort(event.target.value as RoomSort)}>
            <option value="RECENT">최신순</option>
            <option value="OLDEST">오래된순</option>
            <option value="TITLE_KO">가나다순</option>
          </select>
        </label>
      </section>
      {notice ? <p role="alert">{notice}</p> : null}
      {loading ? <p role="status">강의방 목록을 불러오는 중입니다.</p> : (
        <div className={styles.roomSections}>
          <section className={styles.roomSection} aria-labelledby="owned-rooms-title">
            <h2 id="owned-rooms-title">진행 중인 강의방</h2>
            {renderRoomList(activeRooms)}
          </section>
          <section className={styles.roomSection} aria-labelledby="assigned-rooms-title">
            <h2 id="assigned-rooms-title">종료된 강의방</h2>
            {renderRoomList(endedRooms)}
          </section>
        </div>
      )}
      <RoomReopenDialog
        open={reopenTarget !== null}
        pending={reopening}
        error={reopenError}
        onCancel={() => { if (!reopening) { setReopenTarget(null); setReopenError(null); } }}
        onConfirm={() => void reopen()}
      />
    </main>
  );
}

export function CloudRoomPreparePage() {
  const { roomId = "" } = useParams();
  const { user } = useAuth();
  const [room, setRoom] = useState<CloudRoomRecord | null>(null);
  const [shareLink, setShareLink] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [managingInstructors, setManagingInstructors] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([getCloudRoom(user, roomId), getCloudRoomShare(user, roomId)])
      .then(([nextRoom, share]) => {
        if (!active) return;
        setRoom(nextRoom);
        setShareLink(cloudRoomShareLink(share.joinPath));
      })
      .catch((error: unknown) => {
        if (active) setNotice(message(error, "강의방 정보를 불러오지 못했습니다."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [roomId, user]);

  async function copy(value: string, label: string) {
    try {
      await copyCloudRoomValue(value);
      setNotice(`${label}을 복사했습니다.`);
    } catch {
      setNotice(`${label}을 복사하지 못했습니다. 브라우저 권한을 확인해 주세요.`);
    }
  }

  if (loading) return <p role="status">강의방 준비 정보를 불러오는 중입니다.</p>;
  if (!room) return <p role="alert">{notice ?? "강의방을 찾을 수 없습니다."}</p>;
  return (
    <main className={`${styles.page} ${styles.roomPreparePage}`}>
      <section className={`${styles.card} ${styles.roomPrepareCard}`} aria-labelledby="room-prepare-title">
        <p className={styles.eyebrow}>강의 시작 전</p>
        <h1 id="room-prepare-title">{room.title}</h1>
        <dl className={styles.details}>
          <div><dt>원본 수업 흐름</dt><dd>{room.sourceCourseTitle}</dd></div>
          <div><dt>현재 역할</dt><dd>{room.currentRole === "LEAD_INSTRUCTOR" ? "주 강사" : room.currentRole === "ASSISTANT" ? "보조 강사" : "관리자"}</dd></div>
          <div><dt>방 코드</dt><dd>{room.roomCode}</dd></div>
        </dl>
        {room.currentRole === "LEAD_INSTRUCTOR" ? <button type="button" className={styles.instructorManageButton} aria-label="강사 관리 열기" title="강사 관리" onClick={() => setManagingInstructors(true)}>강사 관리</button> : null}
        <div className={styles.copyRow}>
          <label>방 코드<input aria-label="방 코드" readOnly value={room.roomCode} /></label>
          <button type="button" onClick={() => void copy(room.roomCode, "방 코드")}><Clipboard aria-hidden="true" /> 방 코드 복사</button>
        </div>
        <div className={styles.copyRow}>
          <label>공유 링크<input aria-label="공유 링크" readOnly value={shareLink} /></label>
          <button type="button" onClick={() => void copy(shareLink, "공유 링크")}><Copy aria-hidden="true" /> 링크 복사</button>
        </div>
        {notice ? <p role={notice.includes("못했습니다") ? "alert" : "status"}>{notice}</p> : null}
        <Link className={styles.openButton} to={`/rooms/${room.id}/checklist`}><Check aria-hidden="true" /> 로드맵 열기</Link>
        <p className={styles.future}><Check aria-hidden="true" /> 로드맵 진행은 이 화면에서 관리합니다. 채팅, 학생 입장과 QR은 다음 기능에서 연결합니다.</p>
      </section>
      {room.currentRole === "LEAD_INSTRUCTOR" ? <CloudRoomInstructorManager user={user} roomId={roomId} open={managingInstructors} onClose={() => setManagingInstructors(false)} onLeadTransferred={(nextRoom) => { setRoom(nextRoom); setNotice("주 강사 변경이 적용되었습니다."); }} /> : null}
    </main>
  );
}
