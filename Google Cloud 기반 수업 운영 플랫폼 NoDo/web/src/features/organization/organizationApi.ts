import type { User } from "firebase/auth";
import { ApiError, requestApi } from "../../lib/api/apiClient";

export type OrganizationRole = "ADMIN" | "INSTRUCTOR";
export type OrganizationMember = {
  uid: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
  organizationRole: OrganizationRole;
  organizationRoleRevision: number;
  createdAt: string | null;
};
export type StaffInvitationStatus =
  | "PENDING"
  | "ACCEPTED"
  | "DECLINED"
  | "EXPIRED"
  | "REVOKED";
export type StaffInvitation = {
  id: string;
  email: string;
  status: StaffInvitationStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  revokedAt: string | null;
};
export type OrganizationMembersSnapshot = { members: OrganizationMember[]; count: number };
export type OrganizationMemberRemovalResult = { removed: true };
export type StaffInvitationEmailResult = { valid: true; email: string } | { valid: false; message: string };
const emailControlPattern = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const companyEmailPattern = /^[^\s@]+@nodo-company\.test$/u;

export function validateStaffInvitationEmail(value: unknown, adminEmail?: string | null): StaffInvitationEmailResult {
  if (typeof value !== "string") return { valid: false, message: "직원 이메일을 입력해 주세요." };
  if (emailControlPattern.test(value) || /[\r\n]/u.test(value)) return { valid: false, message: "이메일에 사용할 수 없는 문자가 포함되어 있습니다." };
  const email = value.normalize("NFC").trim().toLocaleLowerCase("en-US");
  if (!email) return { valid: false, message: "직원 이메일을 입력해 주세요." };
  if (Array.from(email).length > 254) return { valid: false, message: "이메일은 254자 이하로 입력해 주세요." };
  if (!companyEmailPattern.test(email)) return { valid: false, message: "@nodo-company.test 회사 Google 이메일만 승인할 수 있습니다." };
  if (adminEmail && email === adminEmail.normalize("NFC").trim().toLocaleLowerCase("en-US")) return { valid: false, message: "자신의 이메일은 승인할 수 없습니다." };
  return { valid: true, email };
}
function record(value: unknown, message: string) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message); return value as Record<string, unknown>; }
function requiredString(value: Record<string, unknown>, key: string, message: string) { const item = value[key]; if (typeof item !== "string" || !item) throw new Error(message); return item; }
function nullableString(value: Record<string, unknown>, key: string, message: string) { const item = value[key]; if (item === null || item === undefined) return null; if (typeof item !== "string") throw new Error(message); return item; }
export function normalizeOrganizationMember(value: unknown): OrganizationMember {
  const message = "조직 구성원 응답을 확인할 수 없습니다."; const item = record(value, message); const role = item.organizationRole; const revision = item.organizationRoleRevision;
  if ((role !== "ADMIN" && role !== "INSTRUCTOR") || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new Error(message);
  return { uid: requiredString(item, "uid", message), email: requiredString(item, "email", message), displayName: nullableString(item, "displayName", message), photoURL: nullableString(item, "photoURL", message), organizationRole: role, organizationRoleRevision: revision, createdAt: nullableString(item, "createdAt", message) };
}
export function normalizeStaffInvitation(value: unknown): StaffInvitation {
  const message = "조직 로그인 승인 응답을 확인할 수 없습니다.";
  const item = record(value, message);
  const status = item.status;
  if (
    status !== "PENDING"
    && status !== "ACCEPTED"
    && status !== "DECLINED"
    && status !== "EXPIRED"
    && status !== "REVOKED"
  ) {
    throw new Error(message);
  }
  return {
    id: requiredString(item, "id", message),
    email: requiredString(item, "email", message),
    status,
    createdAt: requiredString(item, "createdAt", message),
    updatedAt: requiredString(item, "updatedAt", message),
    expiresAt: requiredString(item, "expiresAt", message),
    acceptedAt: nullableString(item, "acceptedAt", message),
    declinedAt: nullableString(item, "declinedAt", message),
    revokedAt: nullableString(item, "revokedAt", message),
  };
}
export function normalizeMembersSnapshot(value: unknown): OrganizationMembersSnapshot { const message = "조직 구성원 목록을 확인할 수 없습니다."; const item = record(value, message); if (!Array.isArray(item.members) || typeof item.count !== "number") throw new Error(message); const members = item.members.map(normalizeOrganizationMember); if (!Number.isSafeInteger(item.count) || item.count !== members.length) throw new Error(message); return { members, count: item.count }; }
export function normalizeMemberRemoval(value: unknown): OrganizationMemberRemovalResult { const message = "구성원 제거 응답을 확인할 수 없습니다."; const item = record(value, message); if (item.removed !== true) throw new Error(message); return { removed: true }; }
export function normalizeInvitationList(value: unknown) { const item = record(value, "조직 로그인 승인 목록을 확인할 수 없습니다."); if (!Array.isArray(item.invitations)) throw new Error("조직 로그인 승인 목록을 확인할 수 없습니다."); return item.invitations.map(normalizeStaffInvitation); }
export async function loadOrganizationMembers(authUser: User) { return normalizeMembersSnapshot(await requestApi<unknown>("/api/cloud/organization/members", { authUser })); }
export async function loadStaffInvitations(authUser: User) { return normalizeInvitationList(await requestApi<unknown>("/api/cloud/organization/invitations", { authUser })); }
export async function createStaffInvitation(authUser: User, email: string) { return normalizeStaffInvitation(await requestApi<unknown>("/api/cloud/organization/invitations", { method: "POST", body: { email }, authUser })); }
export async function resendStaffInvitation(authUser: User, invitationId: string) { return normalizeStaffInvitation(await requestApi<unknown>(`/api/cloud/organization/invitations/${encodeURIComponent(invitationId)}/resend`, { method: "POST", authUser })); }
export async function revokeStaffInvitation(authUser: User, invitationId: string) { return normalizeStaffInvitation(await requestApi<unknown>(`/api/cloud/organization/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE", authUser })); }
export async function respondToStaffInvitation(
  authUser: User,
  rawToken: string,
  action: "accept" | "decline",
) {
  if (!rawToken) throw new Error("유효하지 않은 초대 링크입니다.");
  return normalizeStaffInvitation(await requestApi<unknown>(
    `/api/cloud/organization/invitations/${action}`,
    { method: "POST", body: { token: rawToken }, authUser },
  ));
}
export async function updateOrganizationRole(authUser: User, uid: string, organizationRole: OrganizationRole, expectedRevision: number) { return normalizeOrganizationMember(await requestApi<unknown>(`/api/cloud/organization/members/${encodeURIComponent(uid)}/organization-role`, { method: "PATCH", body: { organizationRole, expectedRevision }, authUser })); }
export async function removeOrganizationMember(authUser: User, uid: string) { return normalizeMemberRemoval(await requestApi<unknown>(`/api/cloud/organization/members/${encodeURIComponent(uid)}`, { method: "DELETE", authUser })); }
export function organizationRequestErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : null;
    const code = typeof details?.code === "string" ? details.code : null;
    if (error.status === 401) return "로그인 상태를 다시 확인해 주세요.";
    if (error.status === 403) return "이 작업을 수행할 관리자 권한이 없습니다.";
    if (error.status === 404) return "해당 구성원 또는 승인을 찾을 수 없습니다.";
    if (code === "invitation_already_processed") {
      return "이미 대기 중인 승인입니다. 대기 목록에서 승인 갱신을 사용해 주세요.";
    }
    if (error.status === 409) return "마지막 관리자는 일반 강사로 변경할 수 없거나, 최신 상태와 다릅니다.";
    if (error.status === 422) return "입력값을 다시 확인해 주세요.";
    if (error.status >= 500) return "조직 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
  return "요청을 완료하지 못했습니다. 네트워크 연결을 확인해 주세요.";
}
export function organizationMemberRemovalErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : null;
    const code = details?.code;
    if (code === "last_organization_administrator") return "조직의 마지막 관리자입니다. 다른 관리자를 먼저 지정한 뒤 제거해 주세요.";
    if (code === "self_membership_removal") return "자기 자신은 조직에서 제거할 수 없습니다.";
    if (error.status === 401) return "로그인 상태를 다시 확인해 주세요.";
    if (error.status === 403) return "구성원을 제거할 관리자 권한이 없습니다.";
    if (error.status === 404) return "제거할 구성원을 찾을 수 없습니다.";
    if (error.status === 409) return "최신 구성원 상태를 확인한 뒤 다시 시도해 주세요.";
    if (error.status >= 500) return "구성원을 제거하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }
  return "구성원을 제거하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.";
}
