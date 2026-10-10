import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PROJECT_ID = "demo-nodo";
const ORG_ID = "demo";
const OTHER_ORG_ID = "other-org";

let testEnvironment: RulesTestEnvironment;

async function seedCloudRuleFixtures() {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();
    const createdAt = new Date("2026-07-16T00:00:00.000Z");

    await Promise.all([
      firestore.doc("organizations/" + ORG_ID).set({
        id: ORG_ID,
        orgId: ORG_ID,
        name: "DEMO",
        adminCount: 1,
        bootstrapState: "COMPLETED",
        schemaVersion: 1,
        createdAt,
        updatedAt: createdAt,
      }),
      firestore.doc("organizations/" + OTHER_ORG_ID).set({
        id: OTHER_ORG_ID,
        orgId: OTHER_ORG_ID,
        name: "Other organization",
        adminCount: 1,
        bootstrapState: "COMPLETED",
        schemaVersion: 1,
        createdAt,
        updatedAt: createdAt,
      }),
      firestore.doc("users/cloud-staff").set({
        uid: "cloud-staff",
        orgId: ORG_ID,
        accountType: "STAFF",
        organizationRole: "ADMIN",
        organizationRoleRevision: 1,
        isAnonymous: false,
      }),
      firestore.doc("users/other-staff").set({
        uid: "other-staff",
        orgId: OTHER_ORG_ID,
        accountType: "STAFF",
        organizationRole: "ADMIN",
        organizationRoleRevision: 1,
        isAnonymous: false,
      }),
      firestore.doc("users/student").set({
        uid: "student",
        orgId: ORG_ID,
        accountType: "STUDENT",
        isAnonymous: true,
      }),
      firestore.doc("users/anonymous-staff").set({
        uid: "anonymous-staff",
        orgId: ORG_ID,
        accountType: "STAFF",
        organizationRole: "INSTRUCTOR",
        organizationRoleRevision: 1,
        isAnonymous: true,
      }),
      firestore.doc("users/uid-mismatch").set({
        uid: "different-uid",
        orgId: ORG_ID,
        accountType: "STAFF",
        organizationRole: "INSTRUCTOR",
        organizationRoleRevision: 1,
        isAnonymous: false,
      }),
      firestore
        .doc("organizations/" + ORG_ID + "/auditLogs/bootstrap-owner-created")
        .set({
          eventType: "BOOTSTRAP_OWNER_CREATED",
          orgId: ORG_ID,
          actorUid: "cloud-staff",
          targetUid: "cloud-staff",
          createdAt,
        }),
      firestore
        .doc("organizations/" + ORG_ID + "/rooms/public-room")
        .set({ id: "public-room", orgId: ORG_ID, title: "공개 방", status: "READY" }),
      firestore
        .doc("organizations/" + ORG_ID + "/rooms/public-room/participants/student")
        .set({ nickname: "맑은 구름", nicknameNormalized: "맑은 구름", participantStatus: "JOINED", isAnonymous: true, createdAt }),
      firestore
        .doc("organizations/" + ORG_ID + "/staffInvitations/invitation-1")
        .set({
          id: "invitation-1",
          orgId: ORG_ID,
          emailNormalized: "employee@example.test",
          status: "PENDING",
          revision: 1,
          invitedByUid: "cloud-staff",
          createdAt,
          updatedAt: createdAt,
          expiresAt: new Date("2026-07-23T00:00:00.000Z"),
          schemaVersion: 1,
        }),
      firestore
        .doc(
          "organizations/" +
            OTHER_ORG_ID +
            "/staffInvitations/invitation-other",
        )
        .set({
          id: "invitation-other",
          orgId: OTHER_ORG_ID,
          emailNormalized: "other@example.test",
          status: "PENDING",
          revision: 1,
          invitedByUid: "other-staff",
          createdAt,
          updatedAt: createdAt,
          expiresAt: new Date("2026-07-23T00:00:00.000Z"),
          schemaVersion: 1,
        }),
      firestore.doc("emulatorChecks/cloud-staff").set({
        ownerUid: "cloud-staff",
        source: "NoDo_01-dev-emulator",
        checkedAt: createdAt,
      }),
      firestore.doc("courses/course-1").set({
        orgId: ORG_ID,
        title: "Blocked course",
      }),
      firestore.doc("rooms/room-1").set({
        orgId: ORG_ID,
        courseId: "course-1",
      }),
      firestore.doc("rooms/room-1/questions/question-1").set({
        content: "Blocked question",
      }),
      firestore.doc("courses/course-1/materials/material-1").set({
        fileName: "blocked.pdf",
      }),
    ]);
  });
}

beforeAll(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: "127.0.0.1",
      port: 8081,
      rules: readFileSync(
        resolve(process.cwd(), "../firestore.nodo.rules"),
        "utf8",
      ),
    },
  });
});

beforeEach(async () => {
  await testEnvironment.clearFirestore();
  await seedCloudRuleFixtures();
});

afterAll(async () => {
  await testEnvironment.cleanup();
});

describe("NoDo_02 Production Firestore Rules", () => {
  it("인증 사용자는 본인 사용자 문서만 get으로 읽는다", async () => {
    const firestore = testEnvironment
      .authenticatedContext("cloud-staff")
      .firestore();

    const ownProfile = await assertSucceeds(
      firestore.doc("users/cloud-staff").get(),
    );

    expect(ownProfile.data()?.uid).toBe("cloud-staff");
    await assertFails(firestore.doc("users/other-staff").get());
    await assertFails(firestore.collection("users").get());
  });

  it("NoDo STAFF만 demo 조직 문서를 get으로 읽고 다른 조직 경계는 거부한다", async () => {
    const ownOrganization = testEnvironment
      .authenticatedContext("cloud-staff")
      .firestore();
    const otherOrganization = testEnvironment
      .authenticatedContext("other-staff")
      .firestore();

    await assertSucceeds(
      ownOrganization.doc("organizations/" + ORG_ID).get(),
    );
    await assertFails(
      ownOrganization.doc("organizations/" + OTHER_ORG_ID).get(),
    );
    await assertFails(
      otherOrganization.doc("organizations/" + OTHER_ORG_ID).get(),
    );
    await assertFails(
      otherOrganization.doc("organizations/" + ORG_ID).get(),
    );
    await assertFails(ownOrganization.collection("organizations").get());
  });

  it("학생·익명 STAFF·UID가 불일치한 문서는 조직 읽기 권한을 만들지 못한다", async () => {
    for (const uid of ["student", "anonymous-staff", "uid-mismatch"]) {
      const firestore = testEnvironment.authenticatedContext(uid).firestore();
      await assertFails(firestore.doc("organizations/" + ORG_ID).get());
    }
  });

  it("미인증 사용자의 모든 사용자·조직 접근을 거부한다", async () => {
    const firestore = testEnvironment.unauthenticatedContext().firestore();

    await assertFails(firestore.doc("users/cloud-staff").get());
    await assertFails(firestore.collection("users").get());
    await assertFails(firestore.doc("organizations/" + ORG_ID).get());
    await assertFails(firestore.collection("organizations").get());
  });

  it("관리자·일반 강사·학생·미인증 사용자의 users 목록 조회를 모두 거부한다", async () => {
    const contexts = [
      testEnvironment.authenticatedContext("cloud-staff"),
      testEnvironment.authenticatedContext("other-staff"),
      testEnvironment.authenticatedContext("student"),
      testEnvironment.unauthenticatedContext(),
    ];

    for (const context of contexts) {
      const users = context.firestore().collection("users");
      await assertFails(users.get());
      await assertFails(users.where("orgId", "==", ORG_ID).get());
    }
  });

  it("브라우저의 사용자 문서 create·update·delete를 모두 거부한다", async () => {
    const firestore = testEnvironment
      .authenticatedContext("cloud-staff")
      .firestore();
    const operations = [
      () =>
        firestore.doc("users/new-user").set({
          uid: "new-user",
          orgId: ORG_ID,
          accountType: "STAFF",
        }),
      () =>
        firestore.doc("users/cloud-staff").update({
          organizationRole: "INSTRUCTOR",
        }),
      () => firestore.doc("users/cloud-staff").delete(),
    ];

    for (const operation of operations) {
      await assertFails(operation());
    }
  });

  it("브라우저의 조직 문서 create·update·delete를 모두 거부한다", async () => {
    const firestore = testEnvironment
      .authenticatedContext("cloud-staff")
      .firestore();
    const operations = [
      () =>
        firestore.doc("organizations/new-org").set({
          id: "new-org",
          orgId: "new-org",
          name: "Forged",
        }),
      () =>
        firestore.doc("organizations/" + ORG_ID).update({
          name: "Forged",
        }),
      () => firestore.doc("organizations/" + ORG_ID).delete(),
    ];

    for (const operation of operations) {
      await assertFails(operation());
    }
  });

  it("감사 로그의 get·list·create·update·delete를 모두 거부한다", async () => {
    const firestore = testEnvironment
      .authenticatedContext("cloud-staff")
      .firestore();
    const auditLogPath =
      "organizations/" + ORG_ID + "/auditLogs/bootstrap-owner-created";
    const auditLogs = firestore.collection(
      "organizations/" + ORG_ID + "/auditLogs",
    );
    const operations = [
      () => firestore.doc(auditLogPath).get(),
      () => auditLogs.get(),
      () =>
        firestore
          .doc("organizations/" + ORG_ID + "/auditLogs/forged")
          .set({ eventType: "FORGED" }),
      () => firestore.doc(auditLogPath).update({ eventType: "FORGED" }),
      () => firestore.doc(auditLogPath).delete(),
    ];

    for (const operation of operations) {
      await assertFails(operation());
    }

    for (const context of [
      testEnvironment.authenticatedContext("other-staff"),
      testEnvironment.authenticatedContext("student"),
      testEnvironment.unauthenticatedContext(),
    ]) {
      const scopedFirestore = context.firestore();
      await assertFails(scopedFirestore.doc(auditLogPath).get());
      await assertFails(
        scopedFirestore
          .collection("organizations/" + ORG_ID + "/auditLogs")
          .get(),
      );
    }
  });

  it("익명 수강생도 participants를 Firestore에서 직접 읽거나 쓰지 못한다", async () => {
    const firestore = testEnvironment.authenticatedContext("student").firestore();
    const participant = firestore.doc(
      "organizations/" + ORG_ID + "/rooms/public-room/participants/student",
    );

    await assertFails(participant.get());
    await assertFails(participant.update({ nickname: "변조" }));
    await assertFails(
      firestore
        .doc("organizations/" + ORG_ID + "/rooms/public-room/participants/forged")
        .set({ nickname: "변조", participantStatus: "JOINED", isAnonymous: true }),
    );
  });

  it("staffInvitations는 관리자를 포함한 모든 브라우저 접근을 거부한다", async () => {
    const invitationPath =
      "organizations/" + ORG_ID + "/staffInvitations/invitation-1";
    const contexts = [
      testEnvironment.authenticatedContext("cloud-staff"),
      testEnvironment.authenticatedContext("other-staff"),
      testEnvironment.authenticatedContext("student"),
      testEnvironment.unauthenticatedContext(),
    ];

    for (const context of contexts) {
      const firestore = context.firestore();
      await assertFails(firestore.doc(invitationPath).get());
      await assertFails(
        firestore
          .collection("organizations/" + ORG_ID + "/staffInvitations")
          .get(),
      );
      await assertFails(
        firestore
          .doc(
            "organizations/" +
              OTHER_ORG_ID +
              "/staffInvitations/invitation-other",
          )
          .get(),
      );
    }

    const adminFirestore = contexts[0].firestore();
    const invitation = adminFirestore.doc(invitationPath);
    await assertFails(
      adminFirestore
        .doc("organizations/" + ORG_ID + "/staffInvitations/forged")
        .set({ status: "PENDING" }),
    );
    await assertFails(invitation.update({ status: "ACCEPTED" }));
    await assertFails(invitation.delete());
  });

  it("emulatorChecks의 get·list·create·update·delete를 모두 거부한다", async () => {
    const firestore = testEnvironment
      .authenticatedContext("cloud-staff")
      .firestore();
    const diagnostic = firestore.doc("emulatorChecks/cloud-staff");
    const operations = [
      () => diagnostic.get(),
      () => firestore.collection("emulatorChecks").get(),
      () =>
        firestore.doc("emulatorChecks/new-check").set({
          ownerUid: "cloud-staff",
        }),
      () => diagnostic.update({ source: "forged" }),
      () => diagnostic.delete(),
    ];

    for (const operation of operations) {
      await assertFails(operation());
    }
  });

  it("강의·방·질문·자료 등 미구현 경로의 모든 읽기와 쓰기를 거부한다", async () => {
    const firestore = testEnvironment
      .authenticatedContext("cloud-staff")
      .firestore();
    const paths = [
      "courses/course-1",
      "rooms/room-1",
      "rooms/room-1/questions/question-1",
      "courses/course-1/materials/material-1",
      "roomJoinCodes/NODO02",
    ];

    for (const path of paths) {
      await assertFails(firestore.doc(path).get());
      await assertFails(firestore.doc(path).set({ forged: true }));
    }
  });
});
