import {
  CheckCircle2,
  ChevronLeft,
  Save,
  ShieldCheck,
  Trash2,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { collection, onSnapshot, type DocumentData, type Timestamp } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { requestApi } from "../lib/api/apiClient";
import { getLocalFirebaseFirestore } from "../lib/firebase/firebaseFirestore";
import { useAuth } from "../features/auth/AuthContext";
import {
  createEmptyPermissions,
  delegatedPermissionGroups,
  delegatedPermissionKeys,
  normalizePermissions,
  type RoomPermissions,
} from "../features/auth/authTypes";
import type { AvailableStaffCandidate, LiveStaffMember } from "../features/live-course/liveCourseTypes";
import styles from "./RoomStaffPage.module.css";

type StaffApiResponse = {
  room?: Record<string, unknown>;
  lead?: Record<string, unknown>;
  staff?: unknown[];
  availableInstructors?: unknown[];
};

type SaveState = "idle" | "dirty" | "saving" | "success" | "error";

const connectedPermissions = new Set([
  "canEditCourse",
  "canEditCourseFlow",
  "canManageMaterials",
  "canShareRoom",
  "canControlProgress",
  "canAnswerQuestions",
  "canModerateQuestions",
  "canManageParticipants",
  "canEndRoom",
  "canViewReports",
]);

function readString(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof data[key] === "string") {
      return data[key] as string;
    }
  }
  return null;
}

function toIso(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as Timestamp).toDate().toISOString();
  }
  return typeof value === "string" ? value : null;
}

function normalizeStaffCandidate(value: unknown): AvailableStaffCandidate | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const userId = readString(data, "userId", "uid");
  if (!userId) return null;
  return {
    userId,
    displayName: readString(data, "displayName", "name") ?? userId,
    email: readString(data, "email"),
  };
}

function normalizeStaff(value: unknown): LiveStaffMember | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const userId = readString(data, "userId", "uid");
  if (!userId) return null;
  const permissions =
    data.permissions && typeof data.permissions === "object"
      ? (data.permissions as Partial<Record<(typeof delegatedPermissionKeys)[number], unknown>>)
      : undefined;
  return {
    userId,
    displayName: readString(data, "displayName", "name") ?? userId,
    email: readString(data, "email"),
    permissions: normalizePermissions(permissions),
    updatedAt: toIso(data.updatedAt),
    updatedBy: readString(data, "updatedBy"),
    changerDisplayName: readString(data, "changerDisplayName"),
    grantedAt: toIso(data.grantedAt),
    grantedBy: readString(data, "grantedBy"),
  };
}

function normalizeStaffSnapshot(id: string, data: DocumentData) {
  return normalizeStaff({ ...data, userId: typeof data.userId === "string" ? data.userId : id });
}

function formatDate(value: string | null) {
  if (!value) return "아직 저장 기록 없음";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function RoomStaffPage() {
  const { roomId = "" } = useParams();
  const { profile, user, isLoading: isAuthLoading } = useAuth();
  const [lead, setLead] = useState<AvailableStaffCandidate | null>(null);
  const [staff, setStaff] = useState<LiveStaffMember[]>([]);
  const [available, setAvailable] = useState<AvailableStaffCandidate[]>([]);
  const [selectedInstructorId, setSelectedInstructorId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, RoomPermissions>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [expandedStaff, setExpandedStaff] = useState<Record<string, boolean>>({});
  const [isInviting, setIsInviting] = useState(false);
  const saveStatesRef = useRef(saveStates);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageNotice, setPageNotice] = useState<string | null>(null);

  const loadStaff = useCallback(async () => {
    if (!user) return;
    setIsLoading(true);
    setPageError(null);
    try {
      const response = await requestApi<StaffApiResponse>(`/api/rooms/${encodeURIComponent(roomId)}/staff`, { authUser: user });
      const nextLead = normalizeStaffCandidate(response.lead);
      const nextStaff = (response.staff ?? []).map(normalizeStaff).filter((member): member is LiveStaffMember => Boolean(member));
      const nextAvailable = (response.availableInstructors ?? []).map(normalizeStaffCandidate).filter((member): member is AvailableStaffCandidate => Boolean(member));
      setLead(nextLead);
      setStaff(nextStaff);
      setAvailable(nextAvailable);
      setSelectedInstructorId((current) => current || nextAvailable[0]?.userId || "");
      setDrafts((current) => {
        const next = { ...current };
        for (const member of nextStaff) {
          if (saveStatesRef.current[member.userId] !== "dirty") next[member.userId] = member.permissions;
        }
        return next;
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "권한 관리 정보를 불러오지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }, [roomId, user]);

  useEffect(() => {
    saveStatesRef.current = saveStates;
  }, [saveStates]);

  useEffect(() => {
    if (!isAuthLoading && user) void loadStaff();
    if (!isAuthLoading && !user) {
      setIsLoading(false);
      setPageError("로그인이 필요합니다.");
    }
  }, [isAuthLoading, loadStaff, user]);

  useEffect(() => {
    if (!user || pageError) return;
    return onSnapshot(
      collection(getLocalFirebaseFirestore(), "rooms", roomId, "staff"),
      (snapshot) => {
        const liveMembers = snapshot.docs
          .map((entry) => normalizeStaffSnapshot(entry.id, entry.data()))
          .filter((member): member is LiveStaffMember => Boolean(member));
        setStaff((current) =>
          liveMembers.map((member) => {
            const apiMember = current.find((entry) => entry.userId === member.userId);
            return {
              ...member,
              displayName: apiMember?.displayName ?? member.displayName,
              email: apiMember?.email ?? member.email,
              changerDisplayName:
                apiMember?.changerDisplayName ?? member.changerDisplayName,
            };
          }),
        );
        setDrafts((current) => {
          const next = { ...current };
          for (const member of liveMembers) {
            if (saveStatesRef.current[member.userId] !== "dirty" && saveStatesRef.current[member.userId] !== "saving") next[member.userId] = member.permissions;
          }
          return next;
        });
      },
      () => undefined,
    );
  }, [pageError, roomId, user]);

  const availableOptions = useMemo(
    () => available.filter((candidate) => !staff.some((member) => member.userId === candidate.userId)),
    [available, staff],
  );

  function updateDraft(userId: string, next: RoomPermissions) {
    setDrafts((current) => ({ ...current, [userId]: next }));
    setSaveStates((current) => ({ ...current, [userId]: "dirty" }));
  }

  function togglePermission(userId: string, key: (typeof delegatedPermissionKeys)[number]) {
    const current = drafts[userId] ?? createEmptyPermissions();
    updateDraft(userId, { ...current, [key]: !current[key] });
  }

  function setAllPermissions(userId: string, enabled: boolean) {
    updateDraft(
      userId,
      Object.fromEntries(delegatedPermissionKeys.map((key) => [key, enabled])) as RoomPermissions,
    );
  }

  async function addStaff() {
    if (!selectedInstructorId) return;
    setIsInviting(true);
    setPageNotice("보조 강사를 초대하고 있습니다.");
    try {
      await requestApi(`/api/rooms/${encodeURIComponent(roomId)}/staff`, {
        method: "POST",
        body: { userId: selectedInstructorId },
        authUser: user,
      });
      setPageNotice("보조 강사를 기본 권한으로 초대했습니다. 추가 권한은 별도로 설정할 수 있습니다.");
      setSelectedInstructorId("");
      await loadStaff();
    } catch (error) {
      setPageNotice(error instanceof Error ? error.message : "보조 강사를 초대하지 못했습니다.");
    } finally {
      setIsInviting(false);
    }
  }

  async function savePermissions(userId: string) {
    const permissions = drafts[userId] ?? createEmptyPermissions();
    setSaveStates((current) => ({ ...current, [userId]: "saving" }));
    try {
      await requestApi(`/api/rooms/${encodeURIComponent(roomId)}/staff/${encodeURIComponent(userId)}/permissions`, {
        method: "PUT",
        body: { permissions },
        authUser: user,
      });
      setSaveStates((current) => ({ ...current, [userId]: "success" }));
      setPageNotice("권한을 저장했습니다. 열린 보조 강사 화면에도 즉시 반영됩니다.");
    } catch (error) {
      setSaveStates((current) => ({ ...current, [userId]: "error" }));
      setPageNotice(error instanceof Error ? error.message : "권한을 저장하지 못했습니다.");
    }
  }

  async function removeStaff(userId: string) {
    setPageNotice("보조 강사를 강의방에서 제거하고 있습니다.");
    try {
      await requestApi(`/api/rooms/${encodeURIComponent(roomId)}/staff/${encodeURIComponent(userId)}`, {
        method: "DELETE",
        authUser: user,
      });
      setStaff((current) => current.filter((member) => member.userId !== userId));
      setPageNotice("보조 강사를 제거하고 모든 강의방 권한을 회수했습니다.");
      await loadStaff();
    } catch (error) {
      setPageNotice(error instanceof Error ? error.message : "보조 강사를 제거하지 못했습니다.");
    }
  }

  if (isLoading || isAuthLoading) return <main className={styles.centerState} role="status">권한 관리 정보를 불러오는 중입니다.</main>;
  if (pageError) return <main className={styles.centerState}><ShieldCheck aria-hidden="true" /><h1>권한 관리에 접근할 수 없습니다</h1><p role="alert">{pageError}</p><Link to={`/rooms/${roomId}/checklist`}>강의방으로 돌아가기</Link></main>;

  return (
    <div className={styles.page}>
      <header className={styles.topHeader}>
        <Link className={styles.logo} to="/" aria-label="NoDo"><span>NO</span><span>DO</span></Link>
        <Link to={`/rooms/${roomId}/checklist`}><ChevronLeft aria-hidden="true" size={17} /> 강의방으로 돌아가기</Link>
      </header>
      <main className={styles.main}>
        <section className={styles.intro}>
          <div><p>ROOM STAFF · {roomId}</p><h1>보조 강사 <span>권한 관리</span></h1><p>주 강사가 강의방마다 필요한 기능만 선택해서 부여합니다.</p></div>
          <div className={styles.leadCard}><ShieldCheck aria-hidden="true" /><span><small>현재 주 강사 · 모든 권한 고정</small><strong>{lead?.displayName ?? profile?.displayName}</strong><small>{lead?.email ?? profile?.email}</small></span></div>
        </section>

        <section className={styles.addSection} aria-labelledby="add-staff-title">
          <div><UserPlus aria-hidden="true" /><span><h2 id="add-staff-title">보조 강사 초대</h2><p>같은 조직의 다른 직원만 초대할 수 있어요.</p><strong className={styles.defaultPermission}>기본 권한: 강의 조회 및 질문 답변</strong><small>추가 권한은 초대 후 설정할 수 있습니다.</small></span></div>
          <div><select aria-label="초대할 직원" value={selectedInstructorId} onChange={(event) => setSelectedInstructorId(event.target.value)}><option value="">직원을 선택해 주세요</option>{availableOptions.map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.displayName} · {candidate.email}</option>)}</select><button type="button" disabled={!selectedInstructorId || isInviting} onClick={() => void addStaff()}>{isInviting ? "초대 중" : "보조 강사 초대"}</button></div>
        </section>

        {pageNotice ? <p className={styles.notice} role="status">{pageNotice}</p> : null}

        <section className={styles.staffSection} aria-labelledby="staff-list-title">
          <div className={styles.sectionTitle}><UsersRound aria-hidden="true" /><div><h2 id="staff-list-title">초대된 보조 강사</h2><p>미저장 변경과 서버에 저장된 권한을 구분해서 표시합니다.</p></div><strong>{staff.length}명</strong></div>
          {staff.length === 0 ? <div className={styles.emptyState}>아직 초대된 보조 강사가 없습니다.</div> : (
            <div className={styles.staffList}>
              {staff.map((member) => {
                const permissions = drafts[member.userId] ?? member.permissions;
                const saveState = saveStates[member.userId] ?? "idle";
                return (
                  <article className={styles.staffCard} key={member.userId}>
                    <header><div><span className={styles.avatar}>{member.displayName.slice(0, 1)}</span><span><strong>{member.displayName}</strong><small>{member.email ?? member.userId}</small><small>기본 권한 · 강의 조회 및 질문 답변</small></span></div><div className={styles.cardControls}><div className={styles.saveState} data-state={saveState}>{saveState === "dirty" ? "저장 전" : saveState === "saving" ? "저장 중" : saveState === "success" ? "저장 완료" : saveState === "error" ? "저장 실패" : "서버에 저장됨"}</div><button className={styles.expandButton} type="button" aria-expanded={expandedStaff[member.userId] === true} onClick={() => setExpandedStaff((current) => ({ ...current, [member.userId]: !current[member.userId] }))}>{expandedStaff[member.userId] ? "권한 설정 닫기" : "추가 권한 설정"}</button></div></header>
                    {expandedStaff[member.userId] ? <><div className={styles.bulkActions}><button type="button" onClick={() => setAllPermissions(member.userId, true)}>전체 권한 선택</button><button type="button" onClick={() => setAllPermissions(member.userId, false)}>전체 권한 해제</button></div>
                    <div className={styles.permissionGroups}>
                      {delegatedPermissionGroups.map((group) => (
                        <fieldset key={group.label}><legend>{group.label}</legend>{group.permissions.map(([key, label]) => <label key={key}><input type="checkbox" checked={permissions[key]} onChange={() => togglePermission(member.userId, key)} /><span aria-hidden="true" /><strong>{label}</strong>{!connectedPermissions.has(key) ? <small>권한만 저장 · 후속 단계</small> : null}</label>)}</fieldset>
                      ))}
                    </div></> : null}
                    <footer><div><small>마지막 변경</small><span>{formatDate(member.updatedAt)} · {member.changerDisplayName ?? member.updatedBy ?? "주 강사"}</span></div><div><button className={styles.removeButton} type="button" onClick={() => void removeStaff(member.userId)}><Trash2 aria-hidden="true" size={15} /> 권한 회수·제거</button><button className={styles.saveButton} type="button" disabled={saveState !== "dirty" && saveState !== "error"} onClick={() => void savePermissions(member.userId)}>{saveState === "saving" ? <CheckCircle2 aria-hidden="true" size={16} /> : <Save aria-hidden="true" size={16} />}{saveState === "saving" ? "저장 중" : "변경 저장"}</button></div></footer>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
