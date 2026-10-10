import { Crown, KeyRound, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  addCloudRoomAssistant,
  getCloudRoomInstructorManagement,
  grantCloudRoomAssistantFullAccess,
  removeCloudRoomAssistant,
  revokeCloudRoomAssistantFullAccess,
  transferCloudRoomLead,
  updateCloudRoomAssistantPermissions,
  type CloudRoomInstructor,
  type CloudRoomInstructorManagement,
  type CloudRoomPermissions,
  type CloudRoomRecord,
} from "./roomApi";
import styles from "./CloudRoomPages.module.css";

type PendingAction =
  | { kind: "invite"; userId: string }
  | { kind: "permissions"; instructor: CloudRoomInstructor; permissions: CloudRoomPermissions }
  | { kind: "grant" | "revoke" | "remove" | "transfer"; instructor: CloudRoomInstructor };

const permissionLabels: Array<{ key: keyof CloudRoomPermissions; label: string; detail: string }> = [
  { key: "questionOperations", label: "질문 운영", detail: "답변, 숨김·복구, 읽음 처리" },
  { key: "checklistProgress", label: "로드맵 진행 관리", detail: "수업 시작과 체크·되돌리기" },
  { key: "capacityOperations", label: "정원 운영", detail: "정원 초과 확인·유지·상향" },
];

function message(error: unknown) {
  return error instanceof Error ? error.message : "강사 관리 요청을 완료하지 못했습니다.";
}

function actionText(action: PendingAction) {
  if (action.kind === "invite") return "보조 강사로 초대";
  if (action.kind === "permissions") return "권한 저장";
  if (action.kind === "grant") return "전체 권한 부여";
  if (action.kind === "revoke") return "전체 권한 회수";
  if (action.kind === "remove") return "보조 강사 제거";
  return "주 강사 넘기기";
}

export function CloudRoomInstructorManager({
  user,
  roomId,
  open,
  onClose,
  onLeadTransferred,
}: {
  user: User | null;
  roomId: string;
  open: boolean;
  onClose(): void;
  onLeadTransferred(room: CloudRoomRecord): void;
}) {
  const [management, setManagement] = useState<CloudRoomInstructorManagement | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setNotice(null);
    void getCloudRoomInstructorManagement(user, roomId)
      .then((next) => {
        if (!active) return;
        setManagement(next);
        setSelectedCandidate((current) => current || next.candidates[0]?.userId || "");
      })
      .catch((error: unknown) => {
        if (active) setNotice(message(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open, roomId, user]);

  if (!open) return null;

  async function confirm() {
    if (!pending || !management || mutating) return;
    setMutating(true);
    setNotice(null);
    try {
      if (pending.kind === "invite") {
        setManagement(await addCloudRoomAssistant(user, roomId, pending.userId, management.revision));
      } else if (pending.kind === "permissions") {
        setManagement(await updateCloudRoomAssistantPermissions(user, roomId, pending.instructor.userId, pending.permissions, management.revision));
      } else if (pending.kind === "grant") {
        setManagement(await grantCloudRoomAssistantFullAccess(user, roomId, pending.instructor.userId, management.revision));
      } else if (pending.kind === "revoke") {
        setManagement(await revokeCloudRoomAssistantFullAccess(user, roomId, pending.instructor.userId, management.revision));
      } else if (pending.kind === "remove") {
        setManagement(await removeCloudRoomAssistant(user, roomId, pending.instructor.userId, management.revision));
      } else {
        const room = await transferCloudRoomLead(user, roomId, pending.instructor.userId, management.revision);
        onLeadTransferred(room);
        onClose();
      }
      setPending(null);
    } catch (error) {
      setNotice(message(error));
      setPending(null);
    } finally {
      setMutating(false);
    }
  }

  return (
    <section className={styles.instructorDrawer} aria-label="강사 관리">
      <div className={styles.instructorDrawerHeader}>
        <div><p className={styles.eyebrow}>강사 운영</p><h2>강사 관리</h2></div>
        <button type="button" aria-label="강사 관리 닫기" title="닫기" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <p className={styles.instructorPolicy}>조직 ADMIN 권한만으로는 이 방을 운영할 수 없습니다. 방별 배정과 위임 권한이 필요합니다.</p>
      {loading ? <p role="status">강사 목록을 불러오는 중입니다.</p> : null}
      {notice ? <p role="alert">{notice}</p> : null}
      {management ? <>
        <section className={styles.instructorInvite} aria-labelledby="assistant-invite-title">
          <h3 id="assistant-invite-title">보조 강사 초대</h3>
          {management.candidates.length > 0 ? <div className={styles.instructorInviteControls}>
            <select aria-label="초대할 보조 강사" value={selectedCandidate} onChange={(event) => setSelectedCandidate(event.target.value)}>
              {management.candidates.map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.displayName} · {candidate.organizationRole === "ADMIN" ? "관리자" : "강사"}</option>)}
            </select>
            <button type="button" onClick={() => selectedCandidate && setPending({ kind: "invite", userId: selectedCandidate })}><UserPlus aria-hidden="true" /> 초대</button>
          </div> : <p className={styles.readOnly}>초대 가능한 같은 조직의 STAFF가 없습니다.</p>}
        </section>
        <section className={styles.instructorRows} aria-label="배정된 강사">
          {management.instructors.map((instructor) => instructor.role === "LEAD" ? <article className={styles.instructorLead} key={instructor.userId}>
            <Crown aria-hidden="true" /><div><strong>{instructor.displayName}</strong><span>주 강사</span></div>
          </article> : <AssistantRow key={instructor.userId} instructor={instructor} onPending={setPending} />)}
        </section>
      </> : null}
      {pending ? <div className={styles.instructorConfirmBackdrop} role="presentation">
        <section className={styles.instructorConfirm} role="dialog" aria-modal="true" aria-labelledby="instructor-confirm-title">
          <h3 id="instructor-confirm-title">{actionText(pending)} 확인</h3>
          <p>{pending.kind === "transfer" ? "주 강사를 넘기면 기존 주 강사는 전체 운영 권한을 가진 보조 강사가 됩니다. 이 변경은 즉시 적용됩니다." : "이 변경은 강의방 revision을 갱신하며 즉시 권한에 반영됩니다."}</p>
          <div className={styles.actions}><button type="button" onClick={() => setPending(null)} disabled={mutating}>취소</button><button type="button" onClick={() => void confirm()} disabled={mutating}>{mutating ? "처리 중..." : "확인"}</button></div>
        </section>
      </div> : null}
    </section>
  );
}

function AssistantRow({ instructor, onPending }: { instructor: CloudRoomInstructor; onPending(action: PendingAction): void }) {
  const [draft, setDraft] = useState(instructor.permissions);
  useEffect(() => setDraft(instructor.permissions), [instructor.permissions]);
  const hasFullAccess = permissionLabels.every(({ key }) => draft[key]);
  return <article className={styles.assistantRow}>
    <div className={styles.assistantIdentity}><ShieldCheck aria-hidden="true" /><div><strong>{instructor.displayName}</strong><span>보조 강사</span></div></div>
    <fieldset><legend>위임 권한</legend>{permissionLabels.map(({ key, label, detail }) => <label key={key}><input type="checkbox" checked={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })} /><span><strong>{label}</strong><small>{detail}</small></span></label>)}</fieldset>
    <div className={styles.assistantActions}>
      <button type="button" onClick={() => onPending({ kind: "permissions", instructor, permissions: draft })}><KeyRound aria-hidden="true" /> 권한 저장</button>
      {hasFullAccess ? <button type="button" onClick={() => onPending({ kind: "revoke", instructor })}>전체 권한 회수</button> : <button type="button" onClick={() => onPending({ kind: "grant", instructor })}>전체 권한 부여</button>}
      <button type="button" onClick={() => onPending({ kind: "transfer", instructor })}><Crown aria-hidden="true" /> 주 강사 넘기기</button>
      <button type="button" className={styles.dangerAction} onClick={() => onPending({ kind: "remove", instructor })}><Trash2 aria-hidden="true" /> 제거</button>
    </div>
  </article>;
}
