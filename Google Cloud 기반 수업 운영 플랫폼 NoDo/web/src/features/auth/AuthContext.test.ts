import { describe, expect, it } from "vitest";
import { normalizeAuthProfile, normalizeCloudAuthProfile } from "./AuthContext";

const firebaseUser = { uid: "staff-uid", email: "staff@nodo-company.test", displayName: "강사", photoURL: null } as never;
const cloudResponse = (organizationRole: "ADMIN" | "INSTRUCTOR" = "ADMIN") => ({
  uid: "staff-uid", orgId: "demo", email: "staff@nodo-company.test", displayName: "강사", photoURL: null,
  accountType: "STAFF", organizationRole, isAdmin: organizationRole === "ADMIN",
  isAnonymous: false, provider: "google.com", emailVerified: true, authorized: true,
});

describe("normalizeAuthProfile", () => {
  it("STAFF organizationRole을 인증 프로필로 변환한다", () => {
    expect(normalizeAuthProfile({ uid: "staff-uid", orgId: "demo", accountType: "STAFF", organizationRole: "INSTRUCTOR", displayName: "강사", email: "staff@nodo-company.test" })).toMatchObject({ organizationRole: "INSTRUCTOR", isAdmin: false });
  });
  it("학생 프로필은 조직 역할 없이 복원한다", () => {
    expect(normalizeAuthProfile({ uid: "student", orgId: "demo", accountType: "STUDENT", nickname: "수달" })).toMatchObject({ uid: "student", isAdmin: false });
  });
  it("STAFF 역할 누락을 거부한다", () => {
    expect(() => normalizeAuthProfile({ uid: "staff", orgId: "demo", accountType: "STAFF" })).toThrow(/조직 역할 정보/);
  });
  it("지원하지 않는 계정 유형을 거부한다", () => {
    expect(() => normalizeAuthProfile({ uid: "staff", orgId: "demo", accountType: "UNKNOWN" })).toThrow(/계정 유형/);
  });
  it("식별 정보 누락을 거부한다", () => {
    expect(() => normalizeAuthProfile({ accountType: "STUDENT" })).toThrow(/식별 정보/);
  });
});

describe("normalizeCloudAuthProfile", () => {
  it("ADMIN 응답을 관리자 프로필로 변환한다", () => {
    expect(normalizeCloudAuthProfile(cloudResponse(), firebaseUser)).toMatchObject({ organizationRole: "ADMIN", isAdmin: true });
  });
  it("INSTRUCTOR 응답을 일반 강사 프로필로 변환한다", () => {
    expect(normalizeCloudAuthProfile(cloudResponse("INSTRUCTOR"), firebaseUser)).toMatchObject({ organizationRole: "INSTRUCTOR", isAdmin: false });
  });
  it("역할과 isAdmin 불일치를 거부한다", () => {
    expect(() => normalizeCloudAuthProfile({ ...cloudResponse(), isAdmin: false }, firebaseUser)).toThrow(/접근 권한/);
  });
  it("Firebase UID 불일치를 거부한다", () => {
    expect(() => normalizeCloudAuthProfile({ ...cloudResponse(), uid: "other" }, firebaseUser)).toThrow(/일치하지 않습니다/);
  });
});
