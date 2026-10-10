import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { CommonHeader } from "../components/navigation/CommonHeader";
import { isCloudAuthMode } from "../config/runtimeMode";
import { AuthProvider } from "../features/auth/AuthContext";
import {
  OrganizationManagementGuard,
  StaffCloudAuthGuard,
} from "../features/auth/CloudAuthGuard";
import { DemoCourseProvider } from "../features/demo-course/DemoCourseContext";
import { AdaptiveCourseFlowBuilderPage } from "../features/live-course/AdaptiveCourseFlowBuilderPage";
import {
  AdaptiveImportCoursesPage,
  AdaptiveStartPage,
} from "../features/live-course/AdaptiveCatalogPages";
import { AdaptiveTeachingRoomPage } from "../features/live-course/AdaptiveTeachingRoomPage";
import { AdaptiveNewCoursePage } from "../features/live-course/AdaptiveNewCoursePage";
import { JoinRoomPage } from "../pages/JoinRoomPage";
import { CloudStartPage } from "../pages/CloudStartPage";
import {
  CloudCourseCatalogPage,
} from "../features/cloud-courses/CloudCoursePages";
import {
  CloudRoomCreatePage,
  CloudRoomListPage,
  CloudRoomPreparePage,
} from "../features/cloud-rooms/CloudRoomPages";
import { CloudRoomChecklistPage } from "../features/cloud-rooms/CloudRoomChecklistPage";
import { CloudRoomEndSummaryPage } from "../features/cloud-rooms/CloudRoomEndSummaryPage";
import { LoginPage } from "../pages/LoginPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { StudentEntryPage } from "../pages/StudentEntryPage";
import { CloudStudentEntryPage } from "../features/cloud-students/CloudStudentEntryPage";
import { CloudStudentChecklistPage } from "../features/cloud-students/CloudStudentChecklistPage";
import { StaffRoomMaterialPage, StudentRoomMaterialPage } from "../features/live-material/RoomMaterialPage";
import { CourseFlowEditorPage } from "../features/material-selection/CourseFlowEditorPage";

const EmulatorDiagnosticsPage = import.meta.env.DEV
  ? lazy(async () => {
      const module = await import("../pages/EmulatorDiagnosticsPage");
      return { default: module.EmulatorDiagnosticsPage };
    })
  : null;

const RoomStaffPage = lazy(async () => {
  const module = await import("../pages/RoomStaffPage");
  return { default: module.RoomStaffPage };
});

const LiveRoomReportPage = lazy(async () => {
  const module = await import("../pages/LiveRoomReportPage");
  return { default: module.LiveRoomReportPage };
});

const MaterialSelectionPage = lazy(async () => {
  const module = await import("../pages/MaterialSelectionPage");
  return { default: module.MaterialSelectionPage };
});

const MaterialCourseDraftEditorPage = lazy(async () => {
  const module = await import("../features/material-selection/MaterialCourseDraftEditorPage");
  return { default: module.MaterialCourseDraftEditorPage };
});

const OrganizationMembersPage = lazy(async () => {
  const module = await import("../pages/OrganizationMembersPage");
  return { default: module.OrganizationMembersPage };
});
const OrganizationStoragePage = lazy(async () => {
  const module = await import("../pages/OrganizationStoragePage");
  return { default: module.OrganizationStoragePage };
});

const OrganizationJoinPage = lazy(async () => {
  const module = await import("../pages/OrganizationJoinPage");
  return { default: module.OrganizationJoinPage };
});

const OrganizationInvitationActionPage = lazy(async () => {
  const module = await import("../pages/OrganizationInvitationActionPage");
  return { default: module.OrganizationInvitationActionPage };
});
const OrganizationInvitationDeclinedPage = lazy(async () => {
  const module = await import("../pages/OrganizationInvitationActionPage");
  return { default: module.OrganizationInvitationDeclinedPage };
});

export function AppRoutes() {
  return (
    <AuthProvider>
      {isCloudAuthMode ? <CloudRoutes /> : <EmulatorRoutes />}
    </AuthProvider>
  );
}

function CloudProtectedPage() {
  return (
    <StaffCloudAuthGuard>
      <CloudStartPage />
    </StaffCloudAuthGuard>
  );
}

function CloudRoutes() {
  return (
    <>
      <CloudRouteHeader />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<CloudProtectedPage />} />
        <Route path="/join/:orgId/:roomCode" element={<CloudStudentEntryPage />} />
        <Route path="/join/:orgId/:roomCode/checklist" element={<CloudStudentChecklistPage />} />
        <Route path="/join/:orgId/:roomCode/material" element={<StudentRoomMaterialPage />} />
        <Route path="/join/:orgId/:roomCode/chat" element={<CloudStudentChecklistPage />} />
        <Route path="/join/:orgId/:roomCode/assistant" element={<CloudStudentChecklistPage />} />
        <Route path="/join/:orgId/:roomCode/questions" element={<StudentQuestionsRedirect />} />
        <Route path="/join/:roomCode" element={<StudentEntryPage />} />
        <Route
          path="/join-organization"
          element={
            <Suspense fallback={<p role="status">조직 초대 화면 준비 중</p>}>
              <OrganizationJoinPage />
            </Suspense>
          }
        />
        <Route
          path="/organization/members"
          element={
            <OrganizationManagementGuard>
              <Suspense fallback={<p role="status">구성원 관리 화면 준비 중</p>}>
                <OrganizationMembersPage />
              </Suspense>
            </OrganizationManagementGuard>
          }
        />
        <Route
          path="/organization/invitations/:rawToken/accept"
          element={
            <Suspense fallback={<p role="status">조직 초대 화면 준비 중</p>}>
              <OrganizationInvitationActionPage action="accept" />
            </Suspense>
          }
        />
        <Route
          path="/organization/invitations/:rawToken/decline"
          element={
            <Suspense fallback={<p role="status">조직 초대 화면 준비 중</p>}>
              <OrganizationInvitationActionPage action="decline" />
            </Suspense>
          }
        />
        <Route
          path="/organization/invitations/declined"
          element={
            <Suspense fallback={<p role="status">조직 초대 화면 준비 중</p>}>
              <OrganizationInvitationDeclinedPage />
            </Suspense>
          }
        />
        <Route path="/organization/storage" element={<OrganizationManagementGuard><Suspense fallback={<p role="status">자료 용량 관리 화면 준비 중</p>}><OrganizationStoragePage /></Suspense></OrganizationManagementGuard>} />
        <Route
          path="/create/material"
          element={
            <StaffCloudAuthGuard>
              <Suspense fallback={<p role="status">자료 선택 화면 준비 중</p>}>
                <MaterialSelectionPage />
              </Suspense>
            </StaffCloudAuthGuard>
          }
        />
        <Route
          path="/material-course-drafts/:draftId/edit"
          element={
            <StaffCloudAuthGuard>
              <Suspense fallback={<p role="status">AI 초안 편집 화면 준비 중</p>}>
                <MaterialCourseDraftEditorPage />
              </Suspense>
            </StaffCloudAuthGuard>
          }
        />
        <Route path="/create/manual" element={<StaffCloudAuthGuard><CourseFlowEditorPage creating /></StaffCloudAuthGuard>} />
        <Route path="/courses/import" element={<StaffCloudAuthGuard><CloudCourseCatalogPage /></StaffCloudAuthGuard>} />
        <Route path="/courses/:courseId/rooms/new" element={<StaffCloudAuthGuard><CloudRoomCreatePage /></StaffCloudAuthGuard>} />
        <Route path="/courses/:courseId/edit" element={<StaffCloudAuthGuard><CourseFlowEditorPage /></StaffCloudAuthGuard>} />
        <Route path="/courses/:courseId/prepare" element={<StaffCloudAuthGuard><CourseFlowEditorPage /></StaffCloudAuthGuard>} />
        <Route path="/rooms" element={<StaffCloudAuthGuard><CloudRoomListPage /></StaffCloudAuthGuard>} />
        <Route path="/rooms/:roomId/prepare" element={<StaffCloudAuthGuard><CloudRoomPreparePage /></StaffCloudAuthGuard>} />
        <Route path="/rooms/:roomId/checklist" element={<StaffCloudAuthGuard><CloudRoomChecklistPage /></StaffCloudAuthGuard>} />
        <Route path="/rooms/:roomId/summary" element={<StaffCloudAuthGuard><CloudRoomEndSummaryPage /></StaffCloudAuthGuard>} />
        <Route path="/rooms/:roomId/material" element={<StaffCloudAuthGuard><StaffRoomMaterialPage /></StaffCloudAuthGuard>} />
        <Route path="/rooms/:roomId/chat" element={<StaffCloudAuthGuard><CloudRoomChecklistPage /></StaffCloudAuthGuard>} />
        <Route path="/rooms/:roomId/staff" element={<CloudProtectedPage />} />
        <Route path="/rooms/:roomId/report" element={<CloudProtectedPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}

function CloudRouteHeader() {
  const { pathname } = useLocation();
  const isLiveRoom = /^\/rooms\/[^/]+\/(?:checklist|chat|material|summary)$/.test(pathname);
  const isStudentLiveRoom = /^\/join\/[^/]+\/[^/]+\/(?:checklist|chat|assistant|material)$/.test(pathname);
  const isOrganizationInvitation =
    pathname === "/organization/invitations/declined"
    || /^\/organization\/invitations\/[^/]+\/(?:accept|decline)$/.test(pathname);
  if (
    pathname === "/login"
    || pathname === "/join-organization"
    || isOrganizationInvitation
    || isLiveRoom
    || isStudentLiveRoom
  ) return null;
  if (pathname.startsWith("/join/")) return <CommonHeader variant="student" homeTo={pathname} homeLabel="학생 강의 홈" />;
  return <CommonHeader />;
}

function StudentQuestionsRedirect() {
  const { orgId = "", roomCode = "" } = useParams();
  return <Navigate replace to={`/join/${encodeURIComponent(orgId)}/${encodeURIComponent(roomCode)}/chat`} />;
}

function EmulatorRoutes() {
  return (
    <DemoCourseProvider>
        <Routes>
          <Route path="/" element={<AdaptiveStartPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/join/:orgId/:roomCode" element={<CloudStudentEntryPage />} />
          <Route path="/join/:orgId/:roomCode/checklist" element={<CloudStudentChecklistPage />} />
          <Route path="/join/:orgId/:roomCode/material" element={<StudentRoomMaterialPage />} />
          <Route path="/join/:orgId/:roomCode/chat" element={<CloudStudentChecklistPage />} />
          <Route path="/join/:orgId/:roomCode/assistant" element={<CloudStudentChecklistPage />} />
          <Route path="/join/:orgId/:roomCode/questions" element={<StudentQuestionsRedirect />} />
          <Route path="/join/:roomCode" element={<JoinRoomPage />} />
        <Route
          path="/create/material"
          element={<AdaptiveNewCoursePage source="material" />}
        />
        <Route
          path="/create/manual"
          element={<AdaptiveNewCoursePage source="manual" />}
        />
        <Route
          path="/material-course-drafts/:draftId/edit"
          element={
            <Suspense fallback={<p role="status">강의 준비 편집 화면 준비 중</p>}>
              <MaterialCourseDraftEditorPage />
            </Suspense>
          }
        />
        <Route path="/courses/import" element={<AdaptiveImportCoursesPage />} />
        <Route path="/courses/:courseId/rooms/new" element={<CloudRoomCreatePage />} />
        <Route
          path="/courses/:courseId/prepare"
          element={<AdaptiveCourseFlowBuilderPage />}
        />
          <Route
            path="/rooms/:roomId/checklist"
            element={<AdaptiveTeachingRoomPage view="CHECKLIST" />}
          />
          <Route path="/rooms/:roomId/material" element={<StaffRoomMaterialPage />} />
          <Route
            path="/rooms/:roomId/chat"
            element={<AdaptiveTeachingRoomPage view="CHAT" />}
          />
          <Route
            path="/rooms/:roomId/staff"
            element={
              <Suspense fallback={<p role="status">권한 관리 화면 준비 중</p>}>
                <RoomStaffPage />
              </Suspense>
            }
          />
          <Route
            path="/rooms/:roomId/report"
            element={
              <Suspense fallback={<p role="status">강의 요약 화면 준비 중</p>}>
                <LiveRoomReportPage />
              </Suspense>
            }
          />
        {EmulatorDiagnosticsPage && (
          <Route
            path="/dev/emulator"
            element={
              <Suspense fallback={<p role="status">진단 화면 준비 중</p>}>
                <EmulatorDiagnosticsPage />
              </Suspense>
            }
          />
        )}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
    </DemoCourseProvider>
  );
}
