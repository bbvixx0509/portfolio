import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deleteApp, initializeApp } from "firebase/app";
import {
  connectAuthEmulator,
  deleteUser,
  getAuth,
  signInAnonymously,
} from "firebase/auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PROJECT_ID = "demo-nodo";
const STORAGE_BUCKET = `gs://${PROJECT_ID}.appspot.com`;

const ORG_ID = "org-nodo";
const OTHER_ORG_ID = "org-other";
const COURSE_ID = "course-nodo";
const ACTIVE_ROOM_ID = "room-active";
const ENDED_ROOM_ID = "room-ended";

const ALL_PERMISSIONS = {
  canEditCourse: false,
  canEditCourseFlow: false,
  canManageMaterials: false,
  canShareRoom: false,
  canControlProgress: true,
  canAnswerQuestions: false,
  canModerateQuestions: false,
  canAnnotate: false,
  canManageParticipants: false,
  canEndRoom: false,
  canViewReports: false,
  canExportResults: false,
};

let testEnvironment: RulesTestEnvironment;

function validDiagnostic(ownerUid: string) {
  return {
    ownerUid,
    source: "NoDo_01-dev-emulator",
    checkedAt: new Date(),
  };
}

function metadata(orgId: string) {
  return {
    orgId,
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
    updatedAt: new Date("2026-07-15T00:00:00.000Z"),
    schemaVersion: 1,
  };
}

async function seedSecurityRuleFixtures() {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const firestore = context.firestore();

    await Promise.all([
      firestore.doc(`organizations/${ORG_ID}`).set({
        ...metadata(ORG_ID),
        name: "NoDo 교육 조직",
        adminCount: 1,
      }),
      firestore.doc(`organizations/${OTHER_ORG_ID}`).set({
        ...metadata(OTHER_ORG_ID),
        name: "다른 조직",
      }),
      firestore.doc("users/org-admin").set({
        ...metadata(ORG_ID),
        userId: "org-admin",
        accountType: "STAFF",
        organizationRole: "ADMIN",
        organizationRoleRevision: 1,
        displayName: "관리자",
      }),
      firestore.doc("users/lead").set({
        ...metadata(ORG_ID),
        userId: "lead",
        accountType: "STAFF",
        organizationRole: "INSTRUCTOR",
        organizationRoleRevision: 1,
        displayName: "주 강사",
      }),
      firestore.doc("users/assistant-invited").set({
        ...metadata(ORG_ID),
        userId: "assistant-invited",
        accountType: "STAFF",
        organizationRole: "INSTRUCTOR",
        organizationRoleRevision: 1,
        displayName: "초대된 보조 강사",
      }),
      firestore.doc("users/assistant-second").set({
        ...metadata(ORG_ID),
        userId: "assistant-second",
        accountType: "STAFF",
        organizationRole: "INSTRUCTOR",
        organizationRoleRevision: 1,
        displayName: "두 번째 보조 강사",
      }),
      firestore.doc("users/assistant-uninvited").set({
        ...metadata(ORG_ID),
        userId: "assistant-uninvited",
        accountType: "STAFF",
        organizationRole: "INSTRUCTOR",
        organizationRoleRevision: 1,
        displayName: "초대되지 않은 보조 강사",
      }),
      firestore.doc("users/student").set({
        ...metadata(ORG_ID),
        userId: "student",
        accountType: "STUDENT",
        displayName: "익명 수강생",
      }),
      firestore.doc("users/student-not-joined").set({
        ...metadata(ORG_ID),
        userId: "student-not-joined",
        accountType: "STUDENT",
        displayName: "미참여 수강생",
      }),
      firestore.doc("users/student-lead-spoof").set({
        ...metadata(ORG_ID),
        userId: "student-lead-spoof",
        accountType: "STUDENT",
        displayName: "잘못 지정된 학생",
      }),
      firestore.doc("users/other-lead").set({
        ...metadata(OTHER_ORG_ID),
        userId: "other-lead",
        accountType: "STAFF",
        organizationRole: "INSTRUCTOR",
        organizationRoleRevision: 1,
        displayName: "다른 조직 직원",
      }),
      firestore.doc(`courses/${COURSE_ID}`).set({
        ...metadata(ORG_ID),
        courseId: COURSE_ID,
        title: "NoDo 실시간 수업",
        leadInstructorId: "lead",
        activeRoomId: ACTIVE_ROOM_ID,
      }),
      firestore.doc(`courses/${COURSE_ID}/chapters/chapter-1`).set({
        ...metadata(ORG_ID),
        chapterId: "chapter-1",
        title: "첫 번째 챕터",
        order: 0,
      }),
      firestore.doc(`courses/${COURSE_ID}/items/item-1`).set({
        ...metadata(ORG_ID),
        itemId: "item-1",
        chapterId: "chapter-1",
        title: "첫 번째 항목",
        order: 0,
        isCompleted: false,
      }),
      firestore.doc(`courses/${COURSE_ID}/materials/shared`).set({
        ...metadata(ORG_ID),
        fileName: "public.pdf",
        fileType: "PDF",
        isShared: true,
      }),
      firestore.doc(`courses/${COURSE_ID}/materials/private`).set({
        ...metadata(ORG_ID),
        fileName: "instructor-only.pdf",
        fileType: "PDF",
        isShared: false,
      }),
      firestore.doc("roomJoinCodes/NODO01").set({
        ...metadata(ORG_ID),
        roomId: ACTIVE_ROOM_ID,
      }),
      firestore.doc("courses/course-ended").set({
        ...metadata(ORG_ID),
        courseId: "course-ended",
        title: "종료된 수업",
        leadInstructorId: "lead",
        activeRoomId: ENDED_ROOM_ID,
      }),
      firestore.doc("courses/course-other").set({
        ...metadata(OTHER_ORG_ID),
        courseId: "course-other",
        title: "다른 조직 수업",
        leadInstructorId: "other-lead",
        activeRoomId: "room-other",
      }),
      firestore.doc("courses/course-spoof").set({
        ...metadata(ORG_ID),
        courseId: "course-spoof",
        title: "역할 무결성 검사",
        leadInstructorId: "student-lead-spoof",
        activeRoomId: "room-spoof",
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}`).set({
        ...metadata(ORG_ID),
        roomId: ACTIVE_ROOM_ID,
        courseId: COURSE_ID,
        leadInstructorId: "lead",
        status: "ACTIVE",
        currentItemId: "item-1",
      }),
      firestore.doc(`rooms/${ENDED_ROOM_ID}`).set({
        ...metadata(ORG_ID),
        roomId: ENDED_ROOM_ID,
        courseId: "course-ended",
        leadInstructorId: "lead",
        status: "ENDED",
        currentItemId: null,
      }),
      firestore.doc("rooms/room-other").set({
        ...metadata(OTHER_ORG_ID),
        roomId: "room-other",
        courseId: "course-other",
        leadInstructorId: "other-lead",
        status: "ACTIVE",
        currentItemId: null,
      }),
      firestore.doc("rooms/room-spoof").set({
        ...metadata(ORG_ID),
        roomId: "room-spoof",
        courseId: "course-spoof",
        leadInstructorId: "student-lead-spoof",
        status: "ACTIVE",
        currentItemId: null,
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/staff/assistant-invited`).set({
        ...metadata(ORG_ID),
        userId: "assistant-invited",
        roomId: ACTIVE_ROOM_ID,
        permissions: {
          ...ALL_PERMISSIONS,
          canAnswerQuestions: true,
        },
        grantedBy: "lead",
        grantedAt: new Date("2026-07-15T00:00:00.000Z"),
        updatedBy: "lead",
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/staff/assistant-second`).set({
        ...metadata(ORG_ID),
        userId: "assistant-second",
        roomId: ACTIVE_ROOM_ID,
        permissions: {
          ...ALL_PERMISSIONS,
          canControlProgress: false,
          canModerateQuestions: true,
          canManageParticipants: true,
          canViewReports: true,
        },
        grantedBy: "lead",
        grantedAt: new Date("2026-07-15T00:00:00.000Z"),
        updatedBy: "lead",
      }),
      firestore.doc("rooms/room-other/staff/assistant-invited").set({
        ...metadata(OTHER_ORG_ID),
        userId: "assistant-invited",
        roomId: "room-other",
        permissions: {
          ...ALL_PERMISSIONS,
          canAnswerQuestions: true,
        },
        grantedBy: "other-lead",
        grantedAt: new Date("2026-07-15T00:00:00.000Z"),
        updatedBy: "other-lead",
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/participants/student`).set({
        ...metadata(ORG_ID),
        userId: "student",
        nickname: "익명 수강생",
        joinedAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
      firestore.doc(`rooms/${ENDED_ROOM_ID}/participants/student`).set({
        ...metadata(ORG_ID),
        userId: "student",
        nickname: "익명 수강생",
        joinedAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/permissionLogs/log-1`).set({
        ...metadata(ORG_ID),
        targetUserId: "assistant-invited",
        changedBy: "lead",
        beforePermissions: {},
        afterPermissions: ALL_PERMISSIONS,
        changeType: "INVITED",
        changedAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/questions/question-public`).set({
        ...metadata(ORG_ID),
        roomId: ACTIVE_ROOM_ID,
        courseId: COURSE_ID,
        content: "공개 질문입니다.",
        nicknameSnapshot: "익명 수강생",
        isGeneral: false,
        itemId: "item-1",
        itemTitleSnapshot: "첫 번째 항목",
        chapterTitleSnapshot: "첫 번째 챕터",
        materialLabelSnapshot: "public.pdf",
        visibility: "PUBLIC",
        moderationStatus: "APPROVED",
        isAnswered: false,
        answer: null,
        isHidden: false,
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/questions/question-review`).set({
        ...metadata(ORG_ID),
        roomId: ACTIVE_ROOM_ID,
        courseId: COURSE_ID,
        content: "강사 검토가 필요한 질문입니다.",
        nicknameSnapshot: "익명 수강생",
        isGeneral: true,
        itemId: null,
        itemTitleSnapshot: null,
        chapterTitleSnapshot: null,
        materialLabelSnapshot: null,
        visibility: "STAFF_ONLY",
        moderationStatus: "NEEDS_REVIEW",
        isAnswered: false,
        answer: null,
        isHidden: false,
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/questions/question-hidden`).set({
        ...metadata(ORG_ID),
        roomId: ACTIVE_ROOM_ID,
        courseId: COURSE_ID,
        content: "숨김 처리된 질문입니다.",
        nicknameSnapshot: "익명 수강생",
        isGeneral: true,
        itemId: null,
        itemTitleSnapshot: null,
        chapterTitleSnapshot: null,
        materialLabelSnapshot: null,
        visibility: "PUBLIC",
        moderationStatus: "APPROVED",
        isAnswered: false,
        answer: null,
        isHidden: true,
      }),
      firestore.doc(`rooms/${ENDED_ROOM_ID}/questions/question-ended`).set({
        ...metadata(ORG_ID),
        roomId: ENDED_ROOM_ID,
        courseId: "course-ended",
        content: "종료된 강의의 공개 질문입니다.",
        nicknameSnapshot: "익명 수강생",
        isGeneral: true,
        itemId: null,
        itemTitleSnapshot: null,
        chapterTitleSnapshot: null,
        materialLabelSnapshot: null,
        visibility: "PUBLIC",
        moderationStatus: "APPROVED",
        isAnswered: true,
        answer: {
          content: "종료 후에도 읽을 수 있는 답변입니다.",
          instructorDisplayName: "주 강사",
          roomRole: "LEAD",
          answeredAt: new Date("2026-07-15T00:05:00.000Z"),
        },
        isHidden: false,
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/questionAuthors/question-public`).set({
        participantUid: "student",
        clientRequestId: "request-public",
        createdAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/questionRateLimits/student`).set({
        participantUid: "student",
        recentRequestCount: 1,
        updatedAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/moderationLogs/log-question`).set({
        action: "QUESTION_APPROVED",
        targetDocumentId: "question-public",
        actorUid: "lead",
        createdAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/questionReads/lead`).set({
        staffUid: "lead",
        updatedAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
      firestore
        .doc(`rooms/${ACTIVE_ROOM_ID}/questionReads/lead/contexts/item-1`)
        .set({
          contextId: "item-1",
          readAt: new Date("2026-07-15T00:00:00.000Z"),
        }),
      firestore
        .doc(
          `rooms/${ACTIVE_ROOM_ID}/questionReads/assistant-invited/contexts/item-1`,
        )
        .set({
          contextId: "item-1",
          readAt: new Date("2026-07-15T00:00:00.000Z"),
        }),
      firestore.doc(`rooms/${ACTIVE_ROOM_ID}/summary/current`).set({
        ...metadata(ORG_ID),
        roomId: ACTIVE_ROOM_ID,
        participantCount: 1,
        totalQuestionCount: 3,
        publicQuestionCount: 1,
        reviewQuestionCount: 1,
        hiddenQuestionCount: 1,
        answeredQuestionCount: 0,
        unansweredQuestionCount: 3,
        exportStatus: "NOT_CONFIGURED",
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
      rules: readFileSync(resolve(process.cwd(), "../firestore.rules"), "utf8"),
    },
    storage: { host: "127.0.0.1", port: 9199 },
  });
});

beforeEach(async () => {
  await testEnvironment.clearFirestore();
  await testEnvironment.clearStorage();
  await seedSecurityRuleFixtures();
});

afterAll(async () => {
  await testEnvironment.cleanup();
});

describe("NoDo_01 로컬 Firebase Emulator", () => {
  it("Authentication Emulator에서 익명 인증한다", async () => {
    const app = initializeApp(
      {
        apiKey: "local-demo-api-key",
        projectId: PROJECT_ID,
      },
      `anonymous-auth-test-${Date.now()}`,
    );
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });

    try {
      const credential = await signInAnonymously(auth);

      expect(credential.user.isAnonymous).toBe(true);
      expect(credential.user.uid).toBeTruthy();
      await deleteUser(credential.user);
    } finally {
      await deleteApp(app);
    }
  });

  it("인증 사용자가 본인 진단 문서를 작성·읽기·삭제한다", async () => {
    const alice = testEnvironment.authenticatedContext("alice");
    const reference = alice.firestore().doc("emulatorChecks/alice");

    await assertSucceeds(reference.set(validDiagnostic("alice")));
    const snapshot = await assertSucceeds(reference.get());
    expect(snapshot.data()?.ownerUid).toBe("alice");
    await assertSucceeds(reference.delete());
  });

  it("인증되지 않은 사용자의 진단 문서 접근을 거부한다", async () => {
    const reference = testEnvironment
      .unauthenticatedContext()
      .firestore()
      .doc("emulatorChecks/guest");

    await assertFails(reference.set(validDiagnostic("guest")));
    await assertFails(reference.get());
    await assertFails(reference.delete());
  });

  it("다른 UID의 진단 문서 접근을 거부한다", async () => {
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc("emulatorChecks/alice")
        .set(validDiagnostic("alice"));
    });

    const aliceDocument = testEnvironment
      .authenticatedContext("bob")
      .firestore()
      .doc("emulatorChecks/alice");

    await assertFails(aliceDocument.get());
    await assertFails(aliceDocument.set(validDiagnostic("alice")));
    await assertFails(aliceDocument.delete());
  });

  it("허용되지 않은 필드가 있는 쓰기를 거부한다", async () => {
    const reference = testEnvironment
      .authenticatedContext("alice")
      .firestore()
      .doc("emulatorChecks/alice");

    await assertFails(
      reference.set({
        ...validDiagnostic("alice"),
        admin: true,
      }),
    );
  });

  it("진단 컬렉션 외의 Firestore 읽기와 쓰기를 거부한다", async () => {
    const reference = testEnvironment
      .authenticatedContext("alice")
      .firestore()
      .doc("courses/demo-course");

    await assertFails(reference.set({ title: "차단 대상" }));
    await assertFails(reference.get());
  });

  it("02-3 조직 직원 초대 하위 컬렉션의 모든 브라우저 접근을 거부한다", async () => {
    const invitationPath =
      "organizations/" + ORG_ID + "/staffInvitations/invitation-1";

    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc(invitationPath).set({
        id: "invitation-1",
        orgId: ORG_ID,
        emailNormalized: "employee@example.test",
        status: "PENDING",
        revision: 1,
      });
    });

    for (const context of [
      testEnvironment.authenticatedContext("org-admin"),
      testEnvironment.authenticatedContext("lead"),
      testEnvironment.authenticatedContext("student"),
      testEnvironment.unauthenticatedContext(),
    ]) {
      const firestore = context.firestore();
      await assertFails(firestore.doc(invitationPath).get());
      await assertFails(
        firestore
          .collection("organizations/" + ORG_ID + "/staffInvitations")
          .get(),
      );
    }

    const admin = testEnvironment
      .authenticatedContext("org-admin")
      .firestore();
    const invitation = admin.doc(invitationPath);
    await assertFails(
      admin
        .doc("organizations/" + ORG_ID + "/staffInvitations/forged")
        .set({ status: "PENDING" }),
    );
    await assertFails(invitation.update({ status: "ACCEPTED" }));
    await assertFails(invitation.delete());
  });

  it("Storage 읽기와 쓰기를 모두 거부한다", async () => {
    const path = "diagnostics/blocked.txt";

    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await context.storage(STORAGE_BUCKET).ref(path).putString("seed");
    });

    const file = testEnvironment
      .authenticatedContext("alice")
      .storage(STORAGE_BUCKET)
      .ref(path);

    await assertFails(file.putString("blocked write"));
    await assertFails(file.getDownloadURL());
  });

  it("02-3 조직 초대와 관련된 Storage 경로도 직접 접근을 거부한다", async () => {
    const path = "organizations/demo/staff-invitations/invitation.json";

    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await context.storage(STORAGE_BUCKET).ref(path).putString("seed");
    });

    for (const context of [
      testEnvironment.authenticatedContext("org-admin"),
      testEnvironment.authenticatedContext("student"),
      testEnvironment.unauthenticatedContext(),
    ]) {
      const file = context.storage(STORAGE_BUCKET).ref(path);
      await assertFails(file.putString("blocked write"));
      await assertFails(file.getDownloadURL());
    }
  });
});

describe("NoDo_01 역할·조직·강의방 읽기 규칙", () => {
  it("사용자는 본인 프로필만 기본적으로 읽을 수 있다", async () => {
    const student = testEnvironment.authenticatedContext("student").firestore();

    await assertSucceeds(student.doc("users/student").get());
    await assertFails(student.doc("users/lead").get());
    await assertFails(student.doc(`organizations/${ORG_ID}`).get());
  });

  it("주 강사는 조직·본인 강의를 읽고 후보 개인정보는 FastAPI로 조회한다", async () => {
    const lead = testEnvironment.authenticatedContext("lead").firestore();

    await assertSucceeds(lead.doc(`organizations/${ORG_ID}`).get());
    await assertFails(lead.doc("users/assistant-invited").get());
    await assertSucceeds(lead.doc(`courses/${COURSE_ID}`).get());
    await assertSucceeds(
      lead.doc(`courses/${COURSE_ID}/chapters/chapter-1`).get(),
    );
    await assertSucceeds(
      lead.doc(`courses/${COURSE_ID}/items/item-1`).get(),
    );
  });

  it("다른 조직의 강사는 조직·사용자·강의·강의방을 읽지 못한다", async () => {
    const otherLead = testEnvironment
      .authenticatedContext("other-lead")
      .firestore();

    await assertFails(otherLead.doc(`organizations/${ORG_ID}`).get());
    await assertFails(otherLead.doc("users/lead").get());
    await assertFails(otherLead.doc(`courses/${COURSE_ID}`).get());
    await assertFails(otherLead.doc(`rooms/${ACTIVE_ROOM_ID}`).get());
  });

  it("주 강사는 담당 강의방·담당자·권한 기록을 읽되 참여자 UID 문서는 API로 조회한다", async () => {
    const lead = testEnvironment.authenticatedContext("lead").firestore();

    await assertSucceeds(lead.doc(`rooms/${ACTIVE_ROOM_ID}`).get());
    await assertSucceeds(
      lead.doc(`rooms/${ACTIVE_ROOM_ID}/staff/assistant-invited`).get(),
    );
    await assertFails(
      lead.doc(`rooms/${ACTIVE_ROOM_ID}/participants/student`).get(),
    );
    await assertSucceeds(
      lead.doc(`rooms/${ACTIVE_ROOM_ID}/permissionLogs/log-1`).get(),
    );
  });

  it("관리자는 같은 조직 강의방 현황만 읽고 담당자·권한 기록에는 개입하지 않는다", async () => {
    const admin = testEnvironment.authenticatedContext("org-admin").firestore();

    await assertSucceeds(admin.doc(`rooms/${ACTIVE_ROOM_ID}`).get());
    await assertFails(
      admin.doc(`rooms/${ACTIVE_ROOM_ID}/staff/assistant-invited`).get(),
    );
    await assertFails(
      admin.doc(`rooms/${ACTIVE_ROOM_ID}/permissionLogs/log-1`).get(),
    );
    await assertFails(admin.doc("rooms/room-other").get());
  });

  it("초대된 보조 강사는 강의방과 본인 권한 문서만 읽는다", async () => {
    const assistant = testEnvironment
      .authenticatedContext("assistant-invited")
      .firestore();

    await assertSucceeds(assistant.doc(`courses/${COURSE_ID}`).get());
    await assertSucceeds(assistant.doc(`rooms/${ACTIVE_ROOM_ID}`).get());
    await assertSucceeds(
      assistant.doc(`rooms/${ACTIVE_ROOM_ID}/staff/assistant-invited`).get(),
    );
    await assertFails(
      assistant.doc(`rooms/${ACTIVE_ROOM_ID}/staff/assistant-second`).get(),
    );
    await assertFails(
      assistant.doc(`rooms/${ACTIVE_ROOM_ID}/permissionLogs/log-1`).get(),
    );
    await assertFails(assistant.doc("users/assistant-second").get());
    await assertSucceeds(assistant.doc(`organizations/${ORG_ID}`).get());
    await assertFails(assistant.doc("roomJoinCodes/NODO01").get());
  });

  it("보조 강사는 본인 staff 배정만 collectionGroup으로 실시간 구독한다", async () => {
    const assistant = testEnvironment
      .authenticatedContext("assistant-invited")
      .firestore();

    const ownAssignments = await assertSucceeds(
      assistant
        .collectionGroup("staff")
        .where("userId", "==", "assistant-invited")
        .where("orgId", "==", ORG_ID)
        .get(),
    );
    expect(ownAssignments.size).toBe(1);
    await assertFails(assistant.collectionGroup("staff").get());
    await assertFails(
      assistant
        .collectionGroup("staff")
        .where("userId", "==", "assistant-second")
        .where("orgId", "==", ORG_ID)
        .get(),
    );
    await assertFails(
      assistant
        .collectionGroup("staff")
        .where("userId", "==", "assistant-invited")
        .get(),
    );
    await assertFails(
      assistant
        .collectionGroup("staff")
        .where("userId", "==", "assistant-invited")
        .where("orgId", "==", OTHER_ORG_ID)
        .get(),
    );
  });

  it("초대되지 않은 보조 강사는 같은 조직이어도 강의와 강의방을 읽지 못한다", async () => {
    const assistant = testEnvironment
      .authenticatedContext("assistant-uninvited")
      .firestore();

    await assertFails(assistant.doc(`courses/${COURSE_ID}`).get());
    await assertFails(
      assistant.doc(`courses/${COURSE_ID}/chapters/chapter-1`).get(),
    );
    await assertFails(assistant.doc(`rooms/${ACTIVE_ROOM_ID}`).get());
    await assertFails(assistant.doc("users/assistant-invited").get());
  });

  it("참여자 목록은 관리 권한이 있어도 FastAPI를 거치도록 직접 읽기를 거부한다", async () => {
    const assistant = testEnvironment
      .authenticatedContext("assistant-invited")
      .firestore();
    const manager = testEnvironment
      .authenticatedContext("assistant-second")
      .firestore();
    const participantPath = `rooms/${ACTIVE_ROOM_ID}/participants/student`;

    await assertFails(assistant.doc(participantPath).get());
    await assertFails(manager.doc(participantPath).get());
    await assertFails(
      manager.collection(`rooms/${ACTIVE_ROOM_ID}/participants`).get(),
    );
  });

  it("수강생은 참여 중인 활성 강의방과 연결된 강의·챕터·항목을 읽는다", async () => {
    const student = testEnvironment.authenticatedContext("student").firestore();

    await assertSucceeds(student.doc(`rooms/${ACTIVE_ROOM_ID}`).get());
    await assertSucceeds(
      student.doc(`rooms/${ACTIVE_ROOM_ID}/participants/student`).get(),
    );
    await assertSucceeds(student.doc(`courses/${COURSE_ID}`).get());
    await assertSucceeds(
      student.doc(`courses/${COURSE_ID}/chapters/chapter-1`).get(),
    );
    await assertSucceeds(
      student.doc(`courses/${COURSE_ID}/items/item-1`).get(),
    );
    await assertSucceeds(
      student.doc(`courses/${COURSE_ID}/materials/shared`).get(),
    );
    await assertFails(
      student.doc(`courses/${COURSE_ID}/materials/private`).get(),
    );
    await assertFails(student.doc("roomJoinCodes/NODO01").get());
  });

  it("수강생은 미참여 방은 읽지 못하지만 참여했던 종료 강의는 계속 읽는다", async () => {
    const student = testEnvironment.authenticatedContext("student").firestore();
    const notJoined = testEnvironment
      .authenticatedContext("student-not-joined")
      .firestore();

    await assertSucceeds(student.doc(`rooms/${ENDED_ROOM_ID}`).get());
    await assertSucceeds(student.doc("courses/course-ended").get());
    await assertFails(notJoined.doc(`rooms/${ACTIVE_ROOM_ID}`).get());
    await assertFails(notJoined.doc(`courses/${COURSE_ID}`).get());
  });

  it("leadInstructorId가 같아도 STUDENT 계정이면 주 강사 권한을 얻지 못한다", async () => {
    const malformedLead = testEnvironment
      .authenticatedContext("student-lead-spoof")
      .firestore();

    await assertFails(malformedLead.doc("rooms/room-spoof").get());
    await assertFails(malformedLead.doc("courses/course-spoof").get());
  });
});

describe("NoDo_01 익명 질문·요약 읽기 규칙", () => {
  const activeQuestionPath = `rooms/${ACTIVE_ROOM_ID}/questions`;

  it("참여 학생은 활성·종료 중·종료 강의의 공개·비숨김 질문만 읽는다", async () => {
    const student = testEnvironment.authenticatedContext("student").firestore();

    await assertSucceeds(
      student.doc(`${activeQuestionPath}/question-public`).get(),
    );
    await assertFails(
      student.doc(`${activeQuestionPath}/question-review`).get(),
    );
    await assertFails(
      student.doc(`${activeQuestionPath}/question-hidden`).get(),
    );
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .doc(`rooms/${ACTIVE_ROOM_ID}`)
        .update({ status: "ENDING" });
    });
    await assertSucceeds(
      student.doc(`${activeQuestionPath}/question-public`).get(),
    );
    const endedQuestion = await assertSucceeds(
      student
        .doc(`rooms/${ENDED_ROOM_ID}/questions/question-ended`)
        .get(),
    );
    expect(endedQuestion.data()?.answer?.content).toBe(
      "종료 후에도 읽을 수 있는 답변입니다.",
    );
  });

  it("학생 질문 목록은 Rules와 같은 공개·비숨김 조건을 사용해야 한다", async () => {
    const questions = testEnvironment
      .authenticatedContext("student")
      .firestore()
      .collection(activeQuestionPath);

    const publicQuestions = await assertSucceeds(
      questions
        .where("visibility", "==", "PUBLIC")
        .where("isHidden", "==", false)
        .get(),
    );

    expect(publicQuestions.docs.map((snapshot) => snapshot.id)).toEqual([
      "question-public",
    ]);
    await assertFails(questions.get());
  });

  it("주 강사는 담당 강의의 공개·검토·숨김 질문을 모두 읽는다", async () => {
    const lead = testEnvironment.authenticatedContext("lead").firestore();

    for (const questionId of [
      "question-public",
      "question-review",
      "question-hidden",
    ]) {
      await assertSucceeds(
        lead.doc(`${activeQuestionPath}/${questionId}`).get(),
      );
    }
    const allQuestions = await assertSucceeds(
      lead.collection(activeQuestionPath).get(),
    );
    expect(allQuestions.size).toBe(3);
  });

  it("일반 초대 보조 강사는 공개 질문만, 검토 권한 보조 강사는 모든 질문을 읽는다", async () => {
    const invited = testEnvironment
      .authenticatedContext("assistant-invited")
      .firestore();
    const moderator = testEnvironment
      .authenticatedContext("assistant-second")
      .firestore();

    await assertSucceeds(
      invited.doc(`${activeQuestionPath}/question-public`).get(),
    );
    await assertFails(
      invited.doc(`${activeQuestionPath}/question-review`).get(),
    );
    await assertFails(
      invited.doc(`${activeQuestionPath}/question-hidden`).get(),
    );
    await assertSucceeds(
      invited
        .collection(activeQuestionPath)
        .where("visibility", "==", "PUBLIC")
        .where("isHidden", "==", false)
        .get(),
    );
    await assertFails(invited.collection(activeQuestionPath).get());
    await assertSucceeds(
      moderator.doc(`${activeQuestionPath}/question-review`).get(),
    );
    await assertSucceeds(
      moderator.doc(`${activeQuestionPath}/question-hidden`).get(),
    );
    const allQuestions = await assertSucceeds(
      moderator.collection(activeQuestionPath).get(),
    );
    expect(allQuestions.size).toBe(3);
  });

  it("초대되지 않은 직원과 다른 조직 직원은 질문을 읽지 못한다", async () => {
    for (const uid of [
      "assistant-uninvited",
      "student-not-joined",
      "other-lead",
    ]) {
      const firestore = testEnvironment.authenticatedContext(uid).firestore();
      await assertFails(
        firestore.doc(`${activeQuestionPath}/question-public`).get(),
      );
    }
  });

  it("작성자 UID·도배 제한·검토 로그는 모든 클라이언트에 비공개다", async () => {
    const internalPaths = [
      `rooms/${ACTIVE_ROOM_ID}/questionAuthors/question-public`,
      `rooms/${ACTIVE_ROOM_ID}/questionRateLimits/student`,
      `rooms/${ACTIVE_ROOM_ID}/moderationLogs/log-question`,
    ];

    for (const uid of ["student", "lead", "assistant-second", "org-admin"]) {
      const firestore = testEnvironment.authenticatedContext(uid).firestore();
      for (const path of internalPaths) {
        await assertFails(firestore.doc(path).get());
      }
    }
  });

  it("강사는 본인의 읽음 문맥만 읽고 직접 갱신할 수 없다", async () => {
    const lead = testEnvironment.authenticatedContext("lead").firestore();
    const assistant = testEnvironment
      .authenticatedContext("assistant-invited")
      .firestore();
    const leadContext = lead.doc(
      `rooms/${ACTIVE_ROOM_ID}/questionReads/lead/contexts/item-1`,
    );
    const assistantContext = assistant.doc(
      `rooms/${ACTIVE_ROOM_ID}/questionReads/assistant-invited/contexts/item-1`,
    );

    await assertSucceeds(leadContext.get());
    await assertSucceeds(assistantContext.get());
    await assertFails(
      lead
        .doc(
          `rooms/${ACTIVE_ROOM_ID}/questionReads/assistant-invited/contexts/item-1`,
        )
        .get(),
    );
    await assertFails(leadContext.update({ readAt: new Date() }));
    await assertFails(assistantContext.delete());
  });

  it("요약은 주 강사·리포트 권한 보조 강사·동일 조직 관리자만 읽는다", async () => {
    const summaryPath = `rooms/${ACTIVE_ROOM_ID}/summary/current`;

    for (const uid of ["lead", "assistant-second", "org-admin"]) {
      await assertSucceeds(
        testEnvironment.authenticatedContext(uid).firestore().doc(summaryPath).get(),
      );
    }
    for (const uid of [
      "assistant-invited",
      "assistant-uninvited",
      "student",
      "other-lead",
    ]) {
      await assertFails(
        testEnvironment.authenticatedContext(uid).firestore().doc(summaryPath).get(),
      );
    }
  });

  it("질문·작성자·읽음·제한·로그·요약의 모든 직접 쓰기를 거부한다", async () => {
    const student = testEnvironment.authenticatedContext("student").firestore();
    const lead = testEnvironment.authenticatedContext("lead").firestore();
    const moderator = testEnvironment
      .authenticatedContext("assistant-second")
      .firestore();

    const operations = [
      () =>
        student.doc(`${activeQuestionPath}/forged`).set({
          visibility: "PUBLIC",
          isHidden: false,
          content: "직접 저장 시도",
        }),
      () =>
        lead
          .doc(`${activeQuestionPath}/question-public`)
          .update({ answer: { content: "직접 답변" } }),
      () =>
        moderator
          .doc(`${activeQuestionPath}/question-review`)
          .update({ visibility: "PUBLIC" }),
      () =>
        lead
          .doc(`rooms/${ACTIVE_ROOM_ID}/questionAuthors/question-public`)
          .delete(),
      () =>
        lead
          .doc(`rooms/${ACTIVE_ROOM_ID}/questionRateLimits/student`)
          .update({ recentRequestCount: 0 }),
      () =>
        lead
          .doc(
            `rooms/${ACTIVE_ROOM_ID}/questionReads/lead/contexts/item-new`,
          )
          .set({ readAt: new Date() }),
      () =>
        lead
          .doc(`rooms/${ACTIVE_ROOM_ID}/moderationLogs/forged`)
          .set({ action: "FORGED" }),
      () =>
        lead
          .doc(`rooms/${ACTIVE_ROOM_ID}/summary/current`)
          .update({ totalQuestionCount: 0 }),
    ];

    for (const operation of operations) {
      await assertFails(operation());
    }
  });
});

describe("NoDo_01 서버 전용 중요 데이터 쓰기 규칙", () => {
  it("가장 높은 조직 역할의 클라이언트도 중요 문서에 직접 쓸 수 없다", async () => {
    const admin = testEnvironment.authenticatedContext("org-admin").firestore();
    const operations = [
      () => admin.doc(`organizations/${ORG_ID}`).update({ name: "변조" }),
      () => admin.doc("users/lead").update({ organizationRole: "ADMIN" }),
      () => admin.doc(`courses/${COURSE_ID}`).update({ title: "변조" }),
      () =>
        admin
          .doc(`courses/${COURSE_ID}/chapters/chapter-1`)
          .update({ title: "변조" }),
      () =>
        admin
          .doc(`courses/${COURSE_ID}/items/item-1`)
          .update({ isCompleted: true }),
      () => admin.doc(`rooms/${ACTIVE_ROOM_ID}`).update({ status: "ENDED" }),
      () =>
        admin
          .doc(`rooms/${ACTIVE_ROOM_ID}/staff/new-assistant`)
          .set({ userId: "new-assistant" }),
      () =>
        admin
          .doc(`rooms/${ACTIVE_ROOM_ID}/participants/new-student`)
          .set({ userId: "new-student" }),
      () =>
        admin
          .doc(`rooms/${ACTIVE_ROOM_ID}/permissionLogs/new-log`)
          .set({ changeType: "FORGED" }),
    ];

    for (const operation of operations) {
      await assertFails(operation());
    }
  });

  it("보조 강사는 본인의 담당자 권한을 변경하거나 삭제할 수 없다", async () => {
    const assistant = testEnvironment
      .authenticatedContext("assistant-invited")
      .firestore();
    const ownStaff = assistant.doc(
      `rooms/${ACTIVE_ROOM_ID}/staff/assistant-invited`,
    );

    await assertFails(
      ownStaff.update({ "permissions.canEditCourseFlow": true }),
    );
    await assertFails(ownStaff.delete());
  });

  it("보조 강사는 다른 보조 강사의 권한도 변경할 수 없다", async () => {
    const assistant = testEnvironment
      .authenticatedContext("assistant-invited")
      .firestore();
    const otherStaff = assistant.doc(
      `rooms/${ACTIVE_ROOM_ID}/staff/assistant-second`,
    );

    await assertFails(
      otherStaff.update({ "permissions.canControlProgress": true }),
    );
    await assertFails(otherStaff.delete());
  });

  it("권한 변경 기록은 보조 강사와 주 강사 클라이언트 모두 수정·삭제할 수 없다", async () => {
    const assistantLog = testEnvironment
      .authenticatedContext("assistant-invited")
      .firestore()
      .doc(`rooms/${ACTIVE_ROOM_ID}/permissionLogs/log-1`);
    const leadLog = testEnvironment
      .authenticatedContext("lead")
      .firestore()
      .doc(`rooms/${ACTIVE_ROOM_ID}/permissionLogs/log-1`);

    await assertFails(assistantLog.update({ changeType: "FORGED" }));
    await assertFails(assistantLog.delete());
    await assertFails(leadLog.update({ changeType: "FORGED" }));
    await assertFails(leadLog.delete());
  });
});
