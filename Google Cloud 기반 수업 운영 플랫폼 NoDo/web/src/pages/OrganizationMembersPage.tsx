import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Clock3,
  MailPlus,
  RefreshCw,
  Send,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserRound,
  UsersRound,
  XCircle,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../features/auth/AuthContext";
import {
  createStaffInvitation,
  loadOrganizationMembers,
  loadStaffInvitations,
  organizationMemberRemovalErrorMessage,
  organizationRequestErrorMessage,
  removeOrganizationMember,
  resendStaffInvitation,
  revokeStaffInvitation,
  updateOrganizationRole,
  type OrganizationMember,
  type OrganizationMembersSnapshot,
  type OrganizationRole,
  type StaffInvitation,
  validateStaffInvitationEmail,
} from "../features/organization/organizationApi";
import styles from "./OrganizationMembersPage.module.css";

function dateLabel(value: string | null) {
  if (!value) return "기록 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "기록 확인 필요"
    : new Intl.DateTimeFormat("ko-KR", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function invitationStatusLabel(invitation: StaffInvitation) {
  if (invitation.status === "PENDING") return "대기 중";
  if (invitation.status === "ACCEPTED") return "수락됨";
  if (invitation.status === "DECLINED") return "거절됨";
  if (invitation.status === "EXPIRED") return "만료됨";
  return "취소됨";
}

function replaceInvitation(items: StaffInvitation[], next: StaffInvitation) {
  return [next, ...items.filter((item) => item.id !== next.id)];
}

function roleLabel(role: OrganizationRole) {
  return role === "ADMIN" ? "관리자" : "일반 강사";
}

export function OrganizationMembersPage() {
  const { user, profile } = useAuth();
  const [snapshot, setSnapshot] = useState<OrganizationMembersSnapshot | null>(null);
  const [invitations, setInvitations] = useState<StaffInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [changingUid, setChangingUid] = useState<string | null>(null);
  const [removingMember, setRemovingMember] = useState<OrganizationMember | null>(null);
  const [removalConfirmed, setRemovalConfirmed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!user) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const [members, nextInvitations] = await Promise.all([
        loadOrganizationMembers(user),
        loadStaffInvitations(user),
      ]);
      setSnapshot(members);
      setInvitations(nextInvitations);
    } catch (error) {
      setLoadError(organizationRequestErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const pendingInvitations = useMemo(
    () => invitations.filter((item) => item.status === "PENDING"),
    [invitations],
  );
  const invitationHistory = useMemo(
    () => invitations.filter((item) => item.status !== "PENDING"),
    [invitations],
  );
  const activeAdminCount = useMemo(
    () => snapshot?.members.filter((member) => member.organizationRole === "ADMIN").length ?? 0,
    [snapshot],
  );

  function removalBlockReason(member: OrganizationMember) {
    if (member.organizationRole === "ADMIN" && activeAdminCount <= 1) {
      return "조직의 마지막 관리자입니다. 다른 관리자를 먼저 지정한 뒤 제거해 주세요.";
    }
    return null;
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || isSaving) return;
    setActionError(null);
    setSuccess(null);
    const result = validateStaffInvitationEmail(email, profile?.email);
    if (!result.valid) {
      setActionError(result.message);
      return;
    }
    if (
      snapshot?.members.some(
        (member) => member.email.toLocaleLowerCase("en-US") === result.email,
      )
    ) {
      setActionError("이미 DEMO 조직에 가입한 직원입니다.");
      return;
    }
    if (
      pendingInvitations.some(
        (invitation) => invitation.email.toLocaleLowerCase("en-US") === result.email,
      )
    ) {
      setActionError("이미 대기 중인 승인입니다. 대기 목록에서 승인 갱신을 사용해 주세요.");
      return;
    }
    setIsSaving(true);
    try {
      const invitation = await createStaffInvitation(user, result.email);
      setInvitations((items) => replaceInvitation(items, invitation));
      setEmail("");
      setSuccess(`${invitation.email} 조직 로그인 승인을 등록했습니다.`);
    } catch (error) {
      setActionError(organizationRequestErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRevoke(invitation: StaffInvitation) {
    if (!user || revokingId || resendingId || invitation.status !== "PENDING") return;
    setActionError(null);
    setSuccess(null);
    setRevokingId(invitation.id);
    try {
      const revoked = await revokeStaffInvitation(user, invitation.id);
      setInvitations((items) => replaceInvitation(items, revoked));
      setSuccess(`${revoked.email} 조직 로그인 승인을 취소했습니다.`);
    } catch (error) {
      setActionError(organizationRequestErrorMessage(error));
    } finally {
      setRevokingId(null);
    }
  }

  async function handleResend(invitation: StaffInvitation) {
    if (!user || resendingId || revokingId || invitation.status !== "PENDING") return;
    setActionError(null);
    setSuccess(null);
    setResendingId(invitation.id);
    try {
      const resent = await resendStaffInvitation(user, invitation.id);
      setInvitations((items) => replaceInvitation(items, resent));
      setSuccess(`${resent.email} 조직 로그인 승인을 갱신했습니다.`);
    } catch (error) {
      setActionError(organizationRequestErrorMessage(error));
    } finally {
      setResendingId(null);
    }
  }

  async function handleRoleChange(member: OrganizationMember, role: OrganizationRole) {
    if (
      !user
      || changingUid
      || member.uid === profile?.uid
      || member.organizationRole === role
    ) return;
    const message = role === "ADMIN"
      ? `${member.email}을 관리자로 지정할까요?`
      : `${member.email}을 일반 강사로 변경할까요?\n마지막 관리자는 변경할 수 없습니다.`;
    if (!window.confirm(message)) return;
    setActionError(null);
    setSuccess(null);
    setChangingUid(member.uid);
    try {
      const updated = await updateOrganizationRole(
        user,
        member.uid,
        role,
        member.organizationRoleRevision,
      );
      setSnapshot((current) => current
        ? {
            ...current,
            members: current.members.map((item) => item.uid === updated.uid ? updated : item),
          }
        : current);
      setSuccess(`${updated.email}의 역할을 ${roleLabel(updated.organizationRole)}로 변경했습니다.`);
    } catch (error) {
      setActionError(organizationRequestErrorMessage(error));
    } finally {
      setChangingUid(null);
    }
  }

  function openRemoval(member: OrganizationMember) {
    setActionError(null);
    setRemovalError(null);
    setSuccess(null);
    setRemovalConfirmed(false);
    setRemovingMember(member);
  }

  function closeRemoval() {
    if (changingUid) return;
    setRemovingMember(null);
    setRemovalError(null);
    setRemovalConfirmed(false);
  }

  async function confirmRemoval() {
    if (
      !user
      || !removingMember
      || changingUid
      || !removalConfirmed
    ) return;
    setRemovalError(null);
    setChangingUid(removingMember.uid);
    try {
      await removeOrganizationMember(user, removingMember.uid);
      setSnapshot((current) => current
        ? {
            members: current.members.filter((member) => member.uid !== removingMember.uid),
            count: Math.max(0, current.count - 1),
          }
        : current);
      setSuccess("구성원을 제거했습니다. NoDo 조직 접근 권한이 해제되었습니다.");
      setRemovingMember(null);
    } catch (error) {
      setRemovalError(organizationMemberRemovalErrorMessage(error));
    } finally {
      setChangingUid(null);
    }
  }

  return (
    <div className={styles.page}>
      {profile?.organizationRole === "ADMIN" ? (
        <div className={styles.pageActions}>
          <Link className={styles.storageButton} to="/organization/storage">
            자료 용량 관리
          </Link>
        </div>
      ) : null}
      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="members-title">
          <div className={styles.heroIcon}><Building2 aria-hidden="true" /></div>
          <div>
            <p className={styles.eyebrow}>ORGANIZATION · MEMBERS</p>
            <h1 id="members-title">DEMO 구성원 관리</h1>
            <p>관리자는 조직 로그인 승인과 조직 역할을 관리할 수 있습니다.</p>
          </div>
          <div className={styles.memberCount} aria-label="현재 구성원 수">
            <UsersRound aria-hidden="true" />
            <span>현재 구성원</span>
            <strong>{snapshot?.count ?? 0}명</strong>
          </div>
        </section>

        <section className={styles.inviteCard} aria-labelledby="invite-title">
          <div className={styles.sectionHeading}>
            <MailPlus aria-hidden="true" />
            <div>
              <h2 id="invite-title">조직 로그인 승인</h2>
              <p>승인된 Google 이메일로 로그인하면 일반 강사로 자동 활성화됩니다.</p>
            </div>
          </div>
          <form onSubmit={handleInvite} noValidate>
            <label htmlFor="staff-email">회사 Google 이메일</label>
            <div className={styles.inviteRow}>
              <input
                id="staff-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="employee@nodo-company.test"
                disabled={isSaving}
              />
              <button type="submit" disabled={isSaving || !email.trim()}>
                <MailPlus aria-hidden="true" />
                {isSaving ? "등록 중..." : "승인 등록"}
              </button>
            </div>
          </form>
          <div className={styles.feedback} aria-live="polite">
            {actionError ? (
              <p className={styles.error} role="alert">
                <AlertCircle aria-hidden="true" />
                {actionError}
              </p>
            ) : null}
            {success ? (
              <p className={styles.success}>
                <CheckCircle2 aria-hidden="true" />
                {success}
              </p>
            ) : null}
          </div>
        </section>

        {isLoading ? (
          <section className={styles.stateCard} role="status">
            <RefreshCw className={styles.spin} aria-hidden="true" />
            <h2>조직 정보를 불러오는 중입니다</h2>
          </section>
        ) : loadError && !snapshot ? (
          <section className={styles.stateCard}>
            <AlertCircle aria-hidden="true" />
            <h2>조직 정보를 불러오지 못했습니다</h2>
            <p>{loadError}</p>
            <button type="button" onClick={() => void loadData()}>
              <RefreshCw aria-hidden="true" /> 다시 시도
            </button>
          </section>
        ) : (
          <div className={styles.grid}>
            <section className={styles.listCard} aria-labelledby="joined-title">
              <div className={styles.sectionHeading}>
                <UsersRound aria-hidden="true" />
                <div>
                  <h2 id="joined-title">가입한 구성원</h2>
                  <p>최소 한 명의 관리자가 유지됩니다.</p>
                </div>
              </div>
              {snapshot?.members.length ? (
                <ul className={styles.memberList}>
                  {snapshot.members.map((member) => {
                    const isCurrentUser = member.uid === profile?.uid;
                    const blockReason = removalBlockReason(member);
                    const reasonId = `member-removal-reason-${member.uid}`;
                    return (
                      <li key={member.uid}>
                        {member.photoURL ? (
                          <img src={member.photoURL} alt="" referrerPolicy="no-referrer" />
                        ) : (
                          <span className={styles.avatar}><UserRound aria-hidden="true" /></span>
                        )}
                        <div className={styles.memberIdentity}>
                          <strong>{member.displayName || "이름 미등록"}</strong>
                          <span>{member.email}</span>
                        </div>
                        <span className={styles.roleBadge}>{roleLabel(member.organizationRole)}</span>
                        {profile?.organizationRole === "ADMIN" && !isCurrentUser ? (
                          <div className={styles.memberActions}>
                            <button
                              type="button"
                              className={styles.adminRoleButton}
                              aria-label={`${member.email} ${member.organizationRole === "ADMIN" ? "일반 강사로 변경" : "관리자로 지정"}`}
                              onClick={() => void handleRoleChange(
                                member,
                                member.organizationRole === "ADMIN" ? "INSTRUCTOR" : "ADMIN",
                              )}
                              disabled={Boolean(changingUid)}
                            >
                              {member.organizationRole === "ADMIN"
                                ? <ShieldOff aria-hidden="true" />
                                : <ShieldCheck aria-hidden="true" />}
                              {member.organizationRole === "ADMIN"
                                ? "일반 강사로 변경"
                                : "관리자로 지정"}
                            </button>
                            <button
                              type="button"
                              className={styles.removeMemberButton}
                              aria-label={`${member.displayName || "이름 미등록"} 구성원 제거`}
                              aria-describedby={blockReason ? reasonId : undefined}
                              title={blockReason ?? "NoDo 조직 접근 권한 제거"}
                              onClick={() => openRemoval(member)}
                              disabled={Boolean(changingUid) || Boolean(blockReason)}
                            >
                              <Trash2 aria-hidden="true" />
                              구성원 제거
                            </button>
                            {blockReason ? (
                              <p id={reasonId} className={styles.removalReason}>{blockReason}</p>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className={styles.empty}>아직 가입한 구성원이 없습니다.</p>
              )}
            </section>

            <section className={styles.listCard} aria-labelledby="pending-title">
              <div className={styles.sectionHeading}>
                <Clock3 aria-hidden="true" />
                <div>
                  <h2 id="pending-title">대기 중인 승인</h2>
                  <p>승인된 이메일과 만료 시각을 확인하고 갱신하거나 취소할 수 있습니다.</p>
                </div>
              </div>
              {pendingInvitations.length ? (
                <ul className={styles.invitationList}>
                  {pendingInvitations.map((invitation) => (
                    <li key={invitation.id}>
                      <div>
                        <strong>{invitation.email}</strong>
                        <span>만료 {dateLabel(invitation.expiresAt)}</span>
                      </div>
                      <span className={styles.invitationActions}>
                        <button
                          type="button"
                          onClick={() => void handleResend(invitation)}
                          disabled={Boolean(revokingId) || Boolean(resendingId)}
                          aria-label={`${invitation.email} 승인 갱신`}
                        >
                          <Send aria-hidden="true" />
                          {resendingId === invitation.id ? "갱신 중..." : "승인 갱신"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRevoke(invitation)}
                          disabled={Boolean(revokingId) || Boolean(resendingId)}
                          aria-label={`${invitation.email} 승인 취소`}
                        >
                          <XCircle aria-hidden="true" />
                          {revokingId === invitation.id ? "취소 중..." : "승인 취소"}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>대기 중인 조직 로그인 승인이 없습니다.</p>
              )}
            </section>

            <section
              className={`${styles.listCard} ${styles.historyCard}`}
              aria-labelledby="history-title"
            >
              <div className={styles.sectionHeading}>
                <CheckCircle2 aria-hidden="true" />
                <div><h2 id="history-title">승인 기록</h2></div>
              </div>
              {invitationHistory.length ? (
                <ul className={styles.historyList}>
                  {invitationHistory.map((invitation) => (
                    <li key={invitation.id}>
                      <div>
                        <strong>{invitation.email}</strong>
                        <span>{dateLabel(invitation.updatedAt)}</span>
                      </div>
                      <span data-status={invitation.status}>
                        {invitationStatusLabel(invitation)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>완료되거나 취소된 승인이 없습니다.</p>
              )}
            </section>
          </div>
        )}
      </main>

      {removingMember ? (
        <div className={styles.dialogBackdrop}>
          <section
            className={styles.removalDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="member-removal-title"
            aria-describedby="member-removal-description"
          >
            <div className={styles.dialogIcon}><Trash2 aria-hidden="true" /></div>
            <h2 id="member-removal-title">구성원을 제거할까요?</h2>
            <p id="member-removal-description">
              제거된 구성원은 NoDo 조직과 강의방에 더 이상 접근할 수 없습니다.
              Firebase 또는 Google 계정은 삭제되지 않습니다.
            </p>
            <ul className={styles.removalImpactList}>
              <li>기존 자료와 수업 기록은 삭제되지 않습니다.</li>
              <li>제거 후 새 자료 업로드와 수업 운영은 할 수 없습니다.</li>
              <li>
                진행 중이거나 준비 중인 수업의 주 강사 권한이 현재 관리자에게
                자동 이관됩니다.
              </li>
            </ul>
            <label className={styles.removalConfirmation}>
              <input
                type="checkbox"
                checked={removalConfirmed}
                onChange={(event) => setRemovalConfirmed(event.target.checked)}
                disabled={Boolean(changingUid)}
              />
              <span>기존 자료와 기록은 보존되며, 조직 접근 권한만 제거되는 것을 확인했습니다.</span>
            </label>
            {removalError ? (
              <p className={styles.dialogError} role="alert">
                <AlertCircle aria-hidden="true" />
                {removalError}
              </p>
            ) : null}
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.dialogCancel}
                onClick={closeRemoval}
                disabled={Boolean(changingUid)}
              >
                취소
              </button>
              <button
                type="button"
                className={styles.dialogConfirm}
                onClick={() => void confirmRemoval()}
                disabled={Boolean(changingUid) || !removalConfirmed}
              >
                <Trash2 aria-hidden="true" />
                {changingUid ? "제거 중..." : "구성원 제거"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
