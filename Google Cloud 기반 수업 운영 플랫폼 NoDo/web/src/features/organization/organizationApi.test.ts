import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestApi: vi.fn() }));
vi.mock("../../lib/api/apiClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api/apiClient")>();
  return { ...original, requestApi: mocks.requestApi };
});

import {
  createStaffInvitation,
  loadOrganizationMembers,
  loadStaffInvitations,
  normalizeInvitationList,
  normalizeMemberRemoval,
  normalizeMembersSnapshot,
  organizationRequestErrorMessage,
  removeOrganizationMember,
  resendStaffInvitation,
  respondToStaffInvitation,
  revokeStaffInvitation,
  updateOrganizationRole,
  validateStaffInvitationEmail,
} from "./organizationApi";
import { ApiError } from "../../lib/api/apiClient";

const authUser = { uid: "masked-admin" } as unknown as User;
const invitation = {
  id: "masked-invitation",
  email: "employee@nodo-company.test",
  status: "PENDING",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
  expiresAt: "2026-07-23T00:00:00.000Z",
  acceptedAt: null,
  declinedAt: null,
  revokedAt: null,
};

describe("조직 로그인 승인 이메일 검증", () => {
  it("공백과 대소문자를 정규화하고 정확한 nodo-company.test 도메인만 허용한다", () => {
    expect(validateStaffInvitationEmail("  Employee@NODO-COMPANY.TEST  ")).toEqual({
      valid: true,
      email: "employee@nodo-company.test",
    });
    expect(validateStaffInvitationEmail("employee@gmail.com")).toMatchObject({ valid: false });
    expect(validateStaffInvitationEmail("employee@other.nodo-company.test")).toMatchObject({ valid: false });
    expect(validateStaffInvitationEmail("employee@nodo-company.test.evil.test")).toMatchObject({ valid: false });
  });

  it("관리자 자신, 제어문자, 줄바꿈과 254자 초과를 거부한다", () => {
    expect(validateStaffInvitationEmail(
      "ADMIN@NODO-COMPANY.TEST",
      "admin@nodo-company.test",
    )).toMatchObject({ valid: false, message: expect.stringMatching(/자신/) });
    expect(validateStaffInvitationEmail("employee\n@nodo-company.test")).toMatchObject({ valid: false });
    expect(validateStaffInvitationEmail(`employee\u0000@nodo-company.test`)).toMatchObject({ valid: false });
    expect(validateStaffInvitationEmail(`${"a".repeat(247)}@nodo-company.test`)).toMatchObject({ valid: false });
  });
});

describe("조직 구성원 API 계약", () => {
  beforeEach(() => mocks.requestApi.mockReset());

  it("구성원과 초대 목록의 안전한 응답 필드를 변환한다", () => {
    expect(normalizeMembersSnapshot({
      members: [{
        uid: "admin-uid",
        email: "admin@nodo-company.test",
        displayName: "테스트 관리자",
        photoURL: null,
        organizationRole: "ADMIN",
        organizationRoleRevision: 1,
        createdAt: "2026-07-16T00:00:00.000Z",
      }],
      count: 1,
    })).toMatchObject({ count: 1, members: [{ organizationRole: "ADMIN" }] });
    expect(normalizeInvitationList({ invitations: [invitation] })).toHaveLength(1);
    expect(normalizeMemberRemoval({ removed: true })).toEqual({ removed: true });
    expect(() => normalizeMembersSnapshot({ organization: {}, members: [], count: 1 })).toThrow();
    expect(normalizeInvitationList({
      invitations: [
        invitation,
        { ...invitation, id: "declined", status: "DECLINED" },
        { ...invitation, id: "expired", status: "EXPIRED" },
      ],
    })).toHaveLength(3);
    expect(() => normalizeInvitationList({
      invitations: [{ ...invitation, status: "UNKNOWN" }],
    })).toThrow();
    expect(() => normalizeMemberRemoval({ removed: false })).toThrow();
  });

  it("목록·생성·취소 요청을 FastAPI에만 정확한 계약으로 전달한다", async () => {
    mocks.requestApi
      .mockResolvedValueOnce({
      members: [],
        count: 0,
      })
      .mockResolvedValueOnce({ invitations: [invitation] })
      .mockResolvedValueOnce(invitation)
      .mockResolvedValueOnce(invitation)
      .mockResolvedValueOnce({
        ...invitation,
        status: "REVOKED",
        revokedAt: "2026-07-17T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        ...invitation,
        status: "ACCEPTED",
        acceptedAt: "2026-07-17T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        ...invitation,
        status: "DECLINED",
        declinedAt: "2026-07-17T00:00:00.000Z",
      });

    await loadOrganizationMembers(authUser);
    await loadStaffInvitations(authUser);
    await createStaffInvitation(authUser, "employee@nodo-company.test");
    await resendStaffInvitation(authUser, "masked/invitation");
    await revokeStaffInvitation(authUser, "masked/invitation");
    await respondToStaffInvitation(authUser, "raw/token", "accept");
    await respondToStaffInvitation(authUser, "raw/token", "decline");
    mocks.requestApi.mockResolvedValueOnce({
      uid: "employee-uid", email: "employee@nodo-company.test", displayName: null,
      photoURL: null, organizationRole: "ADMIN", organizationRoleRevision: 2,
      createdAt: "2026-07-16T00:00:00.000Z",
    });
    await updateOrganizationRole(authUser, "employee-uid", "ADMIN", 1);
    mocks.requestApi.mockResolvedValueOnce({ removed: true });
    await removeOrganizationMember(authUser, "employee/uid");

    expect(mocks.requestApi.mock.calls).toEqual([
      ["/api/cloud/organization/members", { authUser }],
      ["/api/cloud/organization/invitations", { authUser }],
      ["/api/cloud/organization/invitations", {
        method: "POST",
        body: { email: "employee@nodo-company.test" },
        authUser,
      }],
      ["/api/cloud/organization/invitations/masked%2Finvitation/resend", {
        method: "POST",
        authUser,
      }],
      ["/api/cloud/organization/invitations/masked%2Finvitation", {
        method: "DELETE",
        authUser,
      }],
      ["/api/cloud/organization/invitations/accept", {
        method: "POST",
        body: { token: "raw/token" },
        authUser,
      }],
      ["/api/cloud/organization/invitations/decline", {
        method: "POST",
        body: { token: "raw/token" },
        authUser,
      }],
      ["/api/cloud/organization/members/employee-uid/organization-role", {
        method: "PATCH", body: { organizationRole: "ADMIN", expectedRevision: 1 }, authUser,
      }],
      ["/api/cloud/organization/members/employee%2Fuid", {
        method: "DELETE", authUser,
      }],
    ]);
  });

  it("대기 중 중복 승인과 서버 오류를 안전하게 구분한다", () => {
    expect(organizationRequestErrorMessage(new ApiError(
      "server detail",
      409,
      { code: "invitation_already_processed" },
    ))).toBe("이미 대기 중인 승인입니다. 대기 목록에서 승인 갱신을 사용해 주세요.");
    expect(organizationRequestErrorMessage(new ApiError(
      "server detail",
      503,
      { code: "temporarily_unavailable" },
    ))).toBe("조직 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
  });
});
