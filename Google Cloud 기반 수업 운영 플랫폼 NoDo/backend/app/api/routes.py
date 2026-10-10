from datetime import UTC, datetime
from tempfile import SpooledTemporaryFile
from typing import Annotated, Any, Literal
from urllib.parse import unquote

from fastapi import APIRouter, Query, Request, Response, status

from app.api.dependencies import (
    CloudCourses,
    CloudInvitations,
    CloudMaterialCourseDrafts,
    CloudMaterialExtractions,
    CloudMaterialStorageQuota,
    CloudMaterialUploads,
    CloudOrganization,
    CloudOrganizationRoles,
    CloudQuestions,
    CloudRoomMaterials,
    CloudRooms,
    CloudStaff,
    CloudStudentAssistant,
    CloudVerifiedIdentity,
    CurrentPrincipal,
    Service,
    StudentAuthenticatedIdentity,
    StudentParticipants,
)
from app.core.config import settings
from app.domain.errors import InvalidOperation
from app.domain.room_student_access import utc_datetime
from app.domain.schemas import (
    CloudCourseArchive,
    CloudCourseCreate,
    CloudCourseMaterialAttach,
    CloudCourseUpdate,
    CloudQuestionAnswer,
    CloudQuestionCreate,
    CloudQuestionRead,
    CloudRoomAssistantPermissions,
    CloudRoomAssistantTarget,
    CloudRoomCapacityIncrease,
    CloudRoomCreate,
    CloudRoomEnd,
    CloudRoomMaterialDownloadPolicy,
    CloudRoomMaterialPosition,
    CloudRoomRevisionInput,
    CloudStudentParticipantJoin,
    CompletionUpdate,
    CourseCreate,
    CourseFlowUpdate,
    CourseUpdate,
    InstructorStorageQuotaUpdate,
    JoinRoomRequest,
    LeadInstructorUpdate,
    MaterialCourseDraftApply,
    MaterialCourseDraftDiscard,
    MaterialUpdate,
    NicknameUpdate,
    OrganizationInvitationTokenAction,
    OrganizationRoleUpdate,
    ParticipantRestrictionUpdate,
    PermissionUpdate,
    QuestionAnswerUpdate,
    QuestionCreate,
    QuestionReadCreate,
    RoomCreate,
    StaffCreate,
    StaffInvitationCreate,
    StudentAssistantPrompt,
    StudentSessionRequest,
    StudentSessionResponse,
)

router = APIRouter()

MAX_MATERIAL_UPLOAD_BYTES = 30 * 1024 * 1024
PPTX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
)


@router.post("/api/cloud/material-uploads", status_code=status.HTTP_201_CREATED)
async def upload_cloud_material(
    request: Request,
    identity: CloudVerifiedIdentity,
    uploads: CloudMaterialUploads,
) -> dict[str, Any]:
    """Stream one raw browser file to a spooled temporary file.

    Raw request bodies avoid multipart parser dependencies and keep the
    browser from converting the document into a base64 string.  The filename
    is URL-encoded in a dedicated request header, then fully validated by the
    server before any metadata or Storage write occurs.
    """

    encoded_filename = request.headers.get("x-nodo-upload-filename", "")
    try:
        original_filename = unquote(encoded_filename, errors="strict")
    except UnicodeDecodeError:
        original_filename = ""
    content_type_hint = request.headers.get("content-type")
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_MATERIAL_UPLOAD_BYTES:
                raise InvalidOperation("파일은 30MB 이하만 업로드할 수 있습니다.")
        except ValueError as error:
            raise InvalidOperation("파일 크기를 확인할 수 없습니다.") from error

    with SpooledTemporaryFile(max_size=1_024 * 1_024, mode="w+b") as source:
        size_bytes = 0
        async for chunk in request.stream():
            size_bytes += len(chunk)
            if size_bytes > MAX_MATERIAL_UPLOAD_BYTES:
                raise InvalidOperation("파일은 30MB 이하만 업로드할 수 있습니다.")
            source.write(chunk)
        source.seek(0)
        return uploads.upload(
            identity,
            original_filename=original_filename,
            content_type_hint=content_type_hint,
            size_bytes=size_bytes,
            source=source,
        )


@router.get("/api/cloud/material-storage/usage")
def cloud_material_storage_usage(
    identity: CloudVerifiedIdentity,
    quota: CloudMaterialStorageQuota,
) -> dict[str, Any]:
    return quota.own_usage(identity)


@router.post("/api/cloud/material-uploads/{upload_id}/extract")
def start_cloud_material_extraction(
    upload_id: str,
    identity: CloudVerifiedIdentity,
    extractions: CloudMaterialExtractions,
) -> dict[str, Any]:
    return extractions.start(identity, upload_id)


@router.get("/api/cloud/material-uploads/latest")
def latest_cloud_material_extraction(
    identity: CloudVerifiedIdentity,
    extractions: CloudMaterialExtractions,
) -> dict[str, Any]:
    return extractions.latest(identity)


@router.get("/api/cloud/material-uploads/{upload_id}/extraction")
def cloud_material_extraction_status(
    upload_id: str,
    identity: CloudVerifiedIdentity,
    extractions: CloudMaterialExtractions,
) -> dict[str, Any]:
    return extractions.get_status(identity, upload_id)


@router.post(
    "/api/cloud/materials/{material_id}/course-drafts",
    status_code=status.HTTP_201_CREATED,
)
def create_cloud_material_course_draft(
    material_id: str,
    identity: CloudVerifiedIdentity,
    drafts: CloudMaterialCourseDrafts,
) -> dict[str, Any]:
    return drafts.create(identity, material_id)


@router.get("/api/cloud/material-course-drafts/{draft_id}")
def get_cloud_material_course_draft(
    draft_id: str,
    identity: CloudVerifiedIdentity,
    drafts: CloudMaterialCourseDrafts,
) -> dict[str, Any]:
    return drafts.get(identity, draft_id)


@router.post("/api/cloud/material-course-drafts/{draft_id}/apply")
def apply_cloud_material_course_draft(
    draft_id: str,
    body: MaterialCourseDraftApply,
    identity: CloudVerifiedIdentity,
    drafts: CloudMaterialCourseDrafts,
) -> dict[str, Any]:
    return drafts.apply(identity, draft_id, body.model_dump(by_alias=True))


@router.post("/api/cloud/material-course-drafts/{draft_id}/discard")
def discard_cloud_material_course_draft(
    draft_id: str,
    body: MaterialCourseDraftDiscard,
    identity: CloudVerifiedIdentity,
    drafts: CloudMaterialCourseDrafts,
) -> dict[str, Any]:
    return drafts.discard(identity, draft_id, body.expected_revision)


@router.get("/api/cloud/courses")
def cloud_courses(
    identity: CloudVerifiedIdentity,
    courses: CloudCourses,
    rooms: CloudRooms,
    course_status: Annotated[
        Literal["ACTIVE", "ARCHIVED"], Query(alias="status")
    ] = "ACTIVE",
) -> dict[str, Any]:
    response = courses.list_courses(identity, status=course_status)
    all_rooms = rooms.list_rooms(identity).get("rooms", [])

    now = datetime.now(UTC)

    def room_activity_key(room: dict[str, Any]) -> tuple[int, datetime, str]:
        activity_at = next(
            (
                parsed
                for field in ("updatedAt", "endedAt", "startedAt", "createdAt")
                if (parsed := utc_datetime(room.get(field))) is not None
            ),
            datetime.min.replace(tzinfo=UTC),
        )
        status = room.get("status")

        if status == "LIVE":
            priority = 4
        elif status == "READY":
            priority = 3
        elif status == "ENDED":
            download_until = utc_datetime(room.get("downloadAvailableUntil"))
            if download_until is not None and download_until > now:
                priority = 2
            else:
                priority = 1
        else:
            priority = 0

        room_id = room.get("id")
        return (priority, activity_at, room_id if isinstance(room_id, str) else "")

    rooms_by_course: dict[str, list[dict[str, Any]]] = {}
    for room in all_rooms:
        course_id = room.get("sourceCourseId")
        if not isinstance(course_id, str) or not course_id:
            continue
        rooms_by_course.setdefault(course_id, []).append(room)

    for course in response.get("courses", []):
        course_id = course.get("id")
        course_rooms = rooms_by_course.get(course_id, [])
        if course_rooms:
            course_rooms.sort(key=room_activity_key, reverse=True)
            latest = course_rooms[0]
            course["latestAccessibleRoom"] = {
                "roomId": latest.get("id"),
                "status": latest.get("status"),
                "downloadAvailableUntil": latest.get("downloadAvailableUntil"),
                "endedAt": latest.get("endedAt"),
            }

    return response


@router.post("/api/cloud/courses", status_code=status.HTTP_201_CREATED)
def create_cloud_course(
    body: CloudCourseCreate, identity: CloudVerifiedIdentity, courses: CloudCourses
) -> dict[str, Any]:
    return courses.create_course(identity, body.model_dump(by_alias=True))


@router.get("/api/cloud/courses/{course_id}")
def cloud_course(
    course_id: str, identity: CloudVerifiedIdentity, courses: CloudCourses
) -> dict[str, Any]:
    return courses.get_course(identity, course_id)


@router.put("/api/cloud/courses/{course_id}")
def update_cloud_course(
    course_id: str,
    body: CloudCourseUpdate,
    identity: CloudVerifiedIdentity,
    courses: CloudCourses,
) -> dict[str, Any]:
    return courses.update_course(identity, course_id, body.model_dump(by_alias=True))


@router.post(
    "/api/cloud/courses/{course_id}/duplicate", status_code=status.HTTP_201_CREATED
)
def duplicate_cloud_course(
    course_id: str, identity: CloudVerifiedIdentity, courses: CloudCourses
) -> dict[str, Any]:
    return courses.duplicate_course(identity, course_id)


@router.post(
    "/api/cloud/courses/{course_id}/archive", status_code=status.HTTP_204_NO_CONTENT
)
def archive_cloud_course(
    course_id: str,
    body: CloudCourseArchive,
    identity: CloudVerifiedIdentity,
    courses: CloudCourses,
) -> Response:
    courses.archive_course(identity, course_id, body.expected_revision)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/api/cloud/courses/{course_id}/materials")
def cloud_course_materials(
    course_id: str, identity: CloudVerifiedIdentity, courses: CloudCourses
) -> dict[str, Any]:
    return courses.list_materials(identity, course_id)


@router.post("/api/cloud/courses/{course_id}/materials")
def attach_cloud_course_material(
    course_id: str,
    body: CloudCourseMaterialAttach,
    identity: CloudVerifiedIdentity,
    courses: CloudCourses,
) -> dict[str, Any]:
    return courses.attach_material(identity, course_id, body.material_id)


@router.delete("/api/cloud/courses/{course_id}/materials/{material_id}")
def detach_cloud_course_material(
    course_id: str,
    material_id: str,
    identity: CloudVerifiedIdentity,
    courses: CloudCourses,
) -> dict[str, Any]:
    return courses.detach_material(identity, course_id, material_id)


@router.get(
    "/api/cloud/courses/{course_id}/materials/{material_id}/content",
    response_model=None,
)
def cloud_course_material_content(
    course_id: str,
    material_id: str,
    identity: CloudVerifiedIdentity,
    courses: CloudCourses,
) -> Response:
    content = courses.material_content(identity, course_id, material_id)
    return Response(content=content["content"], media_type=content["contentType"])


@router.get("/api/cloud/rooms")
def cloud_rooms(identity: CloudVerifiedIdentity, rooms: CloudRooms) -> dict[str, Any]:
    return rooms.list_rooms(identity)


@router.post("/api/cloud/rooms", status_code=status.HTTP_201_CREATED)
def create_cloud_room(
    body: CloudRoomCreate, identity: CloudVerifiedIdentity, rooms: CloudRooms
) -> dict[str, Any]:
    return rooms.create_room(identity, body.model_dump(by_alias=True))


@router.get("/api/cloud/rooms/{room_id}/material")
def cloud_room_material(
    room_id: str, identity: CloudVerifiedIdentity, materials: CloudRoomMaterials
) -> dict[str, Any]:
    return materials.staff_material(identity, room_id)


@router.get("/api/cloud/rooms/{room_id}/material-access")
def cloud_room_material_access(
    room_id: str, identity: CloudVerifiedIdentity, materials: CloudRoomMaterials
) -> dict[str, Any]:
    return materials.staff_access(identity, room_id)


@router.patch("/api/cloud/rooms/{room_id}/material-download-policy")
def update_cloud_room_material_download_policy(
    room_id: str,
    body: CloudRoomMaterialDownloadPolicy,
    identity: CloudVerifiedIdentity,
    materials: CloudRoomMaterials,
) -> dict[str, Any]:
    return materials.update_download_policy(
        identity, room_id, body.model_dump(by_alias=True)
    )


@router.get("/api/cloud/rooms/{room_id}/material/download", response_model=None)
def download_cloud_room_material(
    room_id: str, identity: CloudVerifiedIdentity, materials: CloudRoomMaterials
) -> Response:
    download = materials.staff_download(identity, room_id)
    return Response(
        content=download.content,
        media_type="application/pdf"
        if download.file_type == "pdf"
        else PPTX_MEDIA_TYPE,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{download.filename}"',
        },
    )


@router.get("/api/cloud/rooms/{room_id}/material/content", response_model=None)
def cloud_room_material_content(
    room_id: str,
    response: Response,
    identity: CloudVerifiedIdentity,
    materials: CloudRoomMaterials,
) -> Any:
    content = materials.staff_content(identity, room_id)
    if content.kind == "pdf":
        return Response(
            content=content.data,
            media_type="application/pdf",
            headers={"Cache-Control": "no-store"},
        )
    response.headers["Cache-Control"] = "no-store"
    return content.data  # type: ignore[return-value]


@router.patch("/api/cloud/rooms/{room_id}/material-position")
def update_cloud_room_material_position(
    room_id: str,
    body: CloudRoomMaterialPosition,
    identity: CloudVerifiedIdentity,
    materials: CloudRoomMaterials,
) -> dict[str, Any]:
    return materials.update_position(
        identity,
        room_id,
        body.unit_number,
        body.expected_material_revision,
    )


@router.get("/api/cloud/rooms/{room_id}")
def cloud_room(
    room_id: str, identity: CloudVerifiedIdentity, rooms: CloudRooms
) -> dict[str, Any]:
    return rooms.get_room(identity, room_id)


@router.get("/api/cloud/rooms/{room_id}/share")
def cloud_room_share(
    room_id: str, identity: CloudVerifiedIdentity, rooms: CloudRooms
) -> dict[str, str]:
    return rooms.get_share(identity, room_id)


@router.get("/api/cloud/rooms/{room_id}/checklist")
def cloud_room_checklist(
    room_id: str, identity: CloudVerifiedIdentity, rooms: CloudRooms
) -> dict[str, Any]:
    return rooms.get_checklist(identity, room_id)


@router.get("/api/cloud/rooms/{room_id}/instructors")
def cloud_room_instructors(
    room_id: str, identity: CloudVerifiedIdentity, rooms: CloudRooms
) -> dict[str, Any]:
    return rooms.instructor_management(identity, room_id)


@router.post("/api/cloud/rooms/{room_id}/instructors/assistants")
def add_cloud_room_assistant(
    room_id: str,
    body: CloudRoomAssistantTarget,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.add_assistant(
        identity, room_id, body.target_user_id, body.expected_revision
    )


@router.put("/api/cloud/rooms/{room_id}/instructors/assistants/permissions")
def update_cloud_room_assistant_permissions(
    room_id: str,
    body: CloudRoomAssistantPermissions,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.update_assistant_permissions(
        identity,
        room_id,
        body.target_user_id,
        body.permissions,
        body.expected_revision,
    )


@router.post("/api/cloud/rooms/{room_id}/instructors/assistants/full-access/grant")
def grant_cloud_room_assistant_full_access(
    room_id: str,
    body: CloudRoomAssistantTarget,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.grant_assistant_full_access(
        identity, room_id, body.target_user_id, body.expected_revision
    )


@router.post("/api/cloud/rooms/{room_id}/instructors/assistants/full-access/revoke")
def revoke_cloud_room_assistant_full_access(
    room_id: str,
    body: CloudRoomAssistantTarget,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.revoke_assistant_full_access(
        identity, room_id, body.target_user_id, body.expected_revision
    )


@router.delete("/api/cloud/rooms/{room_id}/instructors/assistants")
def remove_cloud_room_assistant(
    room_id: str,
    body: CloudRoomAssistantTarget,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.remove_assistant(
        identity, room_id, body.target_user_id, body.expected_revision
    )


@router.post("/api/cloud/rooms/{room_id}/instructors/lead-transfer")
def transfer_cloud_room_lead(
    room_id: str,
    body: CloudRoomAssistantTarget,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.transfer_lead(
        identity, room_id, body.target_user_id, body.expected_revision
    )


@router.get("/api/cloud/rooms/{room_id}/capacity")
def cloud_room_capacity(
    room_id: str,
    identity: CloudVerifiedIdentity,
    participants: StudentParticipants,
) -> dict[str, Any]:
    return participants.staff_capacity(identity, room_id)


@router.post("/api/cloud/rooms/{room_id}/capacity/keep")
def keep_cloud_room_capacity(
    room_id: str,
    identity: CloudVerifiedIdentity,
    participants: StudentParticipants,
) -> dict[str, Any]:
    return participants.keep_capacity(identity, room_id)


@router.post("/api/cloud/rooms/{room_id}/capacity/increase")
def increase_cloud_room_capacity(
    room_id: str,
    body: CloudRoomCapacityIncrease,
    identity: CloudVerifiedIdentity,
    participants: StudentParticipants,
) -> dict[str, Any]:
    return participants.increase_capacity(
        identity, room_id, body.max_active_participants
    )


@router.post("/api/cloud/rooms/{room_id}/start")
def start_cloud_room(
    room_id: str,
    body: CloudRoomRevisionInput,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.start_room(identity, room_id, body.expected_revision)


@router.post("/api/cloud/rooms/{room_id}/end")
def end_cloud_room(
    room_id: str,
    body: CloudRoomEnd,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.end_room(
        identity,
        room_id,
        body.expected_revision,
        student_access_window=body.student_access_window,
        student_access_until=body.student_access_until,
    )


@router.post("/api/cloud/rooms/{room_id}/reopen")
def reopen_cloud_room(
    room_id: str,
    body: CloudRoomRevisionInput,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.reopen_room(identity, room_id, body.expected_revision)


@router.get("/api/cloud/rooms/{room_id}/end-summary")
def cloud_room_end_summary(
    room_id: str, identity: CloudVerifiedIdentity, rooms: CloudRooms
) -> dict[str, Any]:
    return rooms.end_summary(identity, room_id)


@router.post("/api/cloud/rooms/{room_id}/checklist/{item_id}/complete")
def complete_cloud_room_checklist_item(
    room_id: str,
    item_id: str,
    body: CloudRoomRevisionInput,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.complete_checklist_item(
        identity, room_id, item_id, body.expected_revision
    )


@router.post("/api/cloud/rooms/{room_id}/checklist/{item_id}/undo")
def undo_cloud_room_checklist_item(
    room_id: str,
    item_id: str,
    body: CloudRoomRevisionInput,
    identity: CloudVerifiedIdentity,
    rooms: CloudRooms,
) -> dict[str, Any]:
    return rooms.undo_checklist_item(identity, room_id, item_id, body.expected_revision)


@router.get("/api/cloud/rooms/{room_id}/questions")
def cloud_room_questions(
    room_id: str, identity: CloudVerifiedIdentity, questions: CloudQuestions
) -> dict[str, Any]:
    return questions.staff_questions(identity, room_id)


@router.get("/api/cloud/rooms/{room_id}/questions/summary")
def cloud_room_question_summary(
    room_id: str, identity: CloudVerifiedIdentity, questions: CloudQuestions
) -> dict[str, Any]:
    return questions.staff_question_summary(identity, room_id)


@router.get("/api/cloud/rooms/{room_id}/questions/export")
def export_cloud_room_questions(
    room_id: str, identity: CloudVerifiedIdentity, questions: CloudQuestions
) -> Response:
    return Response(
        content=questions.export_ended_room_questions_csv(identity, room_id),
        media_type="text/csv",
        headers={
            "Content-Disposition": 'attachment; filename="ended-room-questions.csv"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/api/cloud/rooms/{room_id}/questions/{question_id}/answer")
def answer_cloud_room_question(
    room_id: str,
    question_id: str,
    body: CloudQuestionAnswer,
    identity: CloudVerifiedIdentity,
    questions: CloudQuestions,
) -> dict[str, Any]:
    return questions.answer_question(identity, room_id, question_id, body.content)


@router.delete("/api/cloud/rooms/{room_id}/questions/{question_id}/answer")
def cancel_cloud_room_question_answer(
    room_id: str,
    question_id: str,
    identity: CloudVerifiedIdentity,
    questions: CloudQuestions,
) -> dict[str, Any]:
    return questions.cancel_answer(identity, room_id, question_id)


@router.post("/api/cloud/rooms/{room_id}/questions/{question_id}/hide")
def hide_cloud_room_question(
    room_id: str,
    question_id: str,
    identity: CloudVerifiedIdentity,
    questions: CloudQuestions,
) -> dict[str, Any]:
    return questions.set_hidden(identity, room_id, question_id, hidden=True)


@router.post("/api/cloud/rooms/{room_id}/questions/{question_id}/restore")
def restore_cloud_room_question(
    room_id: str,
    question_id: str,
    identity: CloudVerifiedIdentity,
    questions: CloudQuestions,
) -> dict[str, Any]:
    return questions.set_hidden(identity, room_id, question_id, hidden=False)


@router.post("/api/cloud/rooms/{room_id}/questions/read")
def mark_cloud_room_questions_read(
    room_id: str,
    body: CloudQuestionRead,
    identity: CloudVerifiedIdentity,
    questions: CloudQuestions,
) -> dict[str, Any]:
    return questions.mark_read(
        identity, room_id, body.context_id, body.observed_question_id
    )


@router.get("/api/public/rooms/{org_id}/{room_code}")
def public_room(
    org_id: str, room_code: str, participants: StudentParticipants
) -> dict[str, Any]:
    return participants.public_room(org_id, room_code)


@router.post("/api/public/rooms/{org_id}/{room_code}/participants")
def join_public_room(
    org_id: str,
    room_code: str,
    body: CloudStudentParticipantJoin,
    identity: StudentAuthenticatedIdentity,
    participants: StudentParticipants,
) -> dict[str, Any]:
    return participants.join(identity, org_id, room_code, body.nickname)


@router.get("/api/public/rooms/{org_id}/{room_code}/session")
def public_student_session(
    org_id: str,
    room_code: str,
    identity: StudentAuthenticatedIdentity,
    participants: StudentParticipants,
) -> dict[str, Any]:
    return participants.session(identity, org_id, room_code)


@router.post("/api/public/rooms/{org_id}/{room_code}/heartbeat")
def heartbeat_public_room_participant(
    org_id: str,
    room_code: str,
    identity: StudentAuthenticatedIdentity,
    participants: StudentParticipants,
) -> dict[str, str]:
    return participants.heartbeat(identity, org_id, room_code)


@router.post("/api/public/rooms/{org_id}/{room_code}/leave")
def leave_public_room_participant(
    org_id: str,
    room_code: str,
    identity: StudentAuthenticatedIdentity,
    participants: StudentParticipants,
) -> dict[str, bool]:
    return participants.leave(identity, org_id, room_code)


@router.get("/api/public/rooms/{org_id}/{room_code}/questions")
def public_room_questions(
    org_id: str,
    room_code: str,
    identity: StudentAuthenticatedIdentity,
    questions: CloudQuestions,
) -> dict[str, Any]:
    return questions.student_questions(identity, org_id, room_code)


@router.get("/api/public/rooms/{org_id}/{room_code}/checklist")
def public_room_checklist(
    org_id: str,
    room_code: str,
    identity: StudentAuthenticatedIdentity,
    questions: CloudQuestions,
) -> dict[str, Any]:
    return questions.student_checklist(identity, org_id, room_code)


@router.post("/api/public/rooms/{org_id}/{room_code}/ai-assistant")
def ask_public_room_ai_assistant(
    org_id: str,
    room_code: str,
    body: StudentAssistantPrompt,
    identity: StudentAuthenticatedIdentity,
    assistant: CloudStudentAssistant,
) -> dict[str, Any]:
    return assistant.answer(
        identity,
        org_id,
        room_code,
        content=body.content,
        item_id=body.item_id,
    )


@router.get("/api/public/rooms/{org_id}/{room_code}/material")
def public_room_material(
    org_id: str,
    room_code: str,
    identity: StudentAuthenticatedIdentity,
    materials: CloudRoomMaterials,
) -> dict[str, Any]:
    return materials.student_material(identity, org_id, room_code)


@router.get("/api/public/rooms/{org_id}/{room_code}/material-access")
def public_room_material_access(
    org_id: str,
    room_code: str,
    identity: StudentAuthenticatedIdentity,
    materials: CloudRoomMaterials,
) -> dict[str, Any]:
    return materials.student_access(identity, org_id, room_code)


@router.get(
    "/api/public/rooms/{org_id}/{room_code}/material/download", response_model=None
)
def download_public_room_material(
    org_id: str,
    room_code: str,
    identity: StudentAuthenticatedIdentity,
    materials: CloudRoomMaterials,
) -> Response:
    download = materials.student_download(identity, org_id, room_code)
    return Response(
        content=download.content,
        media_type="application/pdf"
        if download.file_type == "pdf"
        else PPTX_MEDIA_TYPE,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{download.filename}"',
        },
    )


@router.get(
    "/api/public/rooms/{org_id}/{room_code}/material/content",
    response_model=None,
)
def public_room_material_content(
    org_id: str,
    room_code: str,
    response: Response,
    identity: StudentAuthenticatedIdentity,
    materials: CloudRoomMaterials,
) -> Any:
    content = materials.student_content(identity, org_id, room_code)
    if content.kind == "pdf":
        return Response(
            content=content.data,
            media_type="application/pdf",
            headers={"Cache-Control": "no-store"},
        )
    response.headers["Cache-Control"] = "no-store"
    return content.data  # type: ignore[return-value]


@router.post(
    "/api/public/rooms/{org_id}/{room_code}/questions",
    status_code=status.HTTP_201_CREATED,
)
def create_public_room_question(
    org_id: str,
    room_code: str,
    body: CloudQuestionCreate,
    identity: StudentAuthenticatedIdentity,
    questions: CloudQuestions,
) -> dict[str, Any]:
    return questions.create_student_question(
        identity, org_id, room_code, body.model_dump(by_alias=True)
    )


@router.get("/health")
@router.get("/healthz", include_in_schema=False)
def health_check() -> dict[str, str]:
    """Return a public, dependency-free process health response.

    Cloud Run reserves some paths ending in ``z`` for platform handling, so
    deployed callers use ``/health``.  The ``/healthz`` alias remains for
    existing local callers.
    """

    return {"status": "ok", "service": "nodo", "version": settings.app_version}


@router.get("/readyz")
def readiness_check() -> dict[str, str]:
    return {"status": "ready"}


@router.get("/api/version")
def version() -> dict[str, str]:
    return {"name": settings.app_name, "version": settings.app_version}


@router.get("/api/auth/me")
def cloud_authenticated_user(
    identity: CloudVerifiedIdentity,
    organization: CloudOrganization,
) -> dict[str, Any]:
    return organization.authenticated_user(identity)


@router.post("/api/auth/bootstrap-organization")
def bootstrap_organization(
    identity: CloudVerifiedIdentity,
    organization: CloudOrganization,
) -> dict[str, Any]:
    return organization.bootstrap_organization(identity)


@router.post("/api/auth/accept-organization-invitation")
def accept_organization_invitation(
    identity: CloudVerifiedIdentity,
    staff: CloudStaff,
) -> dict[str, Any]:
    return staff.accept_invitation(identity)


@router.get("/api/cloud/organization/members")
def cloud_organization_members(
    identity: CloudVerifiedIdentity,
    roles: CloudOrganizationRoles,
) -> dict[str, Any]:
    return roles.list_members(identity)


@router.get("/api/organization/staff-invitations")
def organization_staff_invitations(
    identity: CloudVerifiedIdentity,
    invitations: CloudInvitations,
) -> dict[str, Any]:
    return invitations.list_invitations(identity)


@router.post("/api/organization/staff-invitations")
def create_organization_staff_invitation(
    body: StaffInvitationCreate,
    identity: CloudVerifiedIdentity,
    invitations: CloudInvitations,
) -> dict[str, Any]:
    return invitations.create_invitation(identity, body.email)


@router.delete("/api/organization/staff-invitations/{invitation_id}")
def revoke_organization_staff_invitation(
    invitation_id: str,
    identity: CloudVerifiedIdentity,
    invitations: CloudInvitations,
) -> dict[str, Any]:
    return invitations.revoke_invitation(identity, invitation_id)


@router.get("/api/cloud/organization/invitations")
def cloud_organization_invitations(
    identity: CloudVerifiedIdentity,
    invitations: CloudInvitations,
) -> dict[str, Any]:
    return invitations.list_invitations(identity)


@router.post(
    "/api/cloud/organization/invitations",
    status_code=status.HTTP_201_CREATED,
)
def create_cloud_organization_invitation(
    body: StaffInvitationCreate,
    identity: CloudVerifiedIdentity,
    invitations: CloudInvitations,
) -> dict[str, Any]:
    return invitations.create_invitation(identity, body.email)


@router.post("/api/cloud/organization/invitations/{invitation_id}/resend")
def resend_cloud_organization_invitation(
    invitation_id: str,
    identity: CloudVerifiedIdentity,
    invitations: CloudInvitations,
) -> dict[str, Any]:
    return invitations.resend_invitation(identity, invitation_id)


@router.delete("/api/cloud/organization/invitations/{invitation_id}")
def revoke_cloud_organization_invitation(
    invitation_id: str,
    identity: CloudVerifiedIdentity,
    invitations: CloudInvitations,
) -> dict[str, Any]:
    return invitations.revoke_invitation(identity, invitation_id)


@router.post("/api/cloud/organization/invitations/accept")
def accept_cloud_organization_invitation(
    body: OrganizationInvitationTokenAction,
    identity: CloudVerifiedIdentity,
    invitations: CloudInvitations,
) -> dict[str, Any]:
    return invitations.accept_invitation(identity, body.token)


@router.post("/api/cloud/organization/invitations/decline")
def decline_cloud_organization_invitation(
    body: OrganizationInvitationTokenAction,
    identity: CloudVerifiedIdentity,
    invitations: CloudInvitations,
) -> dict[str, Any]:
    return invitations.decline_invitation(identity, body.token)


@router.patch("/api/cloud/organization/members/{target_uid}/organization-role")
def update_cloud_organization_member_role(
    target_uid: str,
    body: OrganizationRoleUpdate,
    identity: CloudVerifiedIdentity,
    roles: CloudOrganizationRoles,
) -> dict[str, Any]:
    return roles.update_role(
        identity,
        target_uid,
        body.organization_role,
        body.expected_revision,
    )


@router.delete("/api/cloud/organization/members/{target_uid}")
def remove_cloud_organization_member(
    target_uid: str, identity: CloudVerifiedIdentity, roles: CloudOrganizationRoles
) -> dict[str, Any]:
    return roles.remove_member(identity, target_uid)


@router.get("/api/cloud/organization/storage/instructors")
def cloud_organization_storage_instructors(
    identity: CloudVerifiedIdentity,
    quota: CloudMaterialStorageQuota,
) -> dict[str, Any]:
    return quota.list_instructor_usage(identity)


@router.patch("/api/cloud/organization/storage/instructors/{target_key}")
def update_cloud_organization_storage_quota(
    target_key: str,
    body: InstructorStorageQuotaUpdate,
    identity: CloudVerifiedIdentity,
    quota: CloudMaterialStorageQuota,
) -> dict[str, Any]:
    return quota.set_instructor_limit(
        identity, target_key=target_key, limit_bytes=body.limit_bytes
    )


@router.post(
    "/api/auth/student-session",
    response_model=StudentSessionResponse,
)
def student_authenticated_session(
    body: StudentSessionRequest,
    _authenticated_identity: StudentAuthenticatedIdentity,
) -> StudentSessionResponse:
    return StudentSessionResponse(
        nickname=body.nickname,
        roomCode=body.room_code,
    )


@router.get("/api/me")
def current_user(principal: CurrentPrincipal, service: Service) -> dict[str, Any]:
    return service.me(principal)


@router.get("/api/courses")
def courses(principal: CurrentPrincipal, service: Service) -> list[dict[str, Any]]:
    return service.list_courses(principal)


@router.post("/api/courses", status_code=status.HTTP_201_CREATED)
def create_course(
    body: CourseCreate, principal: CurrentPrincipal, service: Service
) -> dict[str, Any]:
    return service.create_course(
        principal,
        title=body.title,
        description=body.description,
    )


@router.put("/api/courses/{course_id}")
def update_course(
    course_id: str,
    body: CourseUpdate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.update_course(
        principal, course_id, title=body.title, description=body.description
    )


@router.put("/api/courses/{course_id}/flow")
def update_course_flow(
    course_id: str,
    body: CourseFlowUpdate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.update_course_flow(
        principal,
        course_id,
        chapters=[chapter.model_dump(by_alias=True) for chapter in body.chapters],
        items=[item.model_dump(by_alias=True) for item in body.items],
    )


@router.put("/api/courses/{course_id}/materials")
def update_course_material(
    course_id: str,
    body: MaterialUpdate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.update_material(principal, course_id, body.model_dump(by_alias=True))


@router.post("/api/courses/{course_id}/rooms", status_code=status.HTTP_201_CREATED)
def create_room(
    course_id: str,
    body: RoomCreate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.create_room(principal, course_id, body.join_code)


@router.post("/api/rooms/join")
def join_room(
    body: JoinRoomRequest,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.join_room(principal, body.room_code, body.nickname)


@router.get("/api/rooms/{room_id}")
def room(room_id: str, principal: CurrentPrincipal, service: Service) -> dict[str, Any]:
    return service.get_room(principal, room_id)


@router.get("/api/rooms/{room_id}/share")
def room_share(
    room_id: str, principal: CurrentPrincipal, service: Service
) -> dict[str, Any]:
    return service.get_room_share(principal, room_id)


@router.patch("/api/rooms/{room_id}/items/{item_id}/completion")
def update_completion(
    room_id: str,
    item_id: str,
    body: CompletionUpdate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.update_completion(principal, room_id, item_id, body.is_completed)


@router.get("/api/rooms/{room_id}/staff")
def room_staff(
    room_id: str, principal: CurrentPrincipal, service: Service
) -> dict[str, Any]:
    return service.staff_overview(principal, room_id)


@router.post("/api/rooms/{room_id}/staff", status_code=status.HTTP_201_CREATED)
def add_room_staff(
    room_id: str,
    body: StaffCreate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.add_staff(principal, room_id, body.user_id)


@router.put("/api/rooms/{room_id}/staff/{uid}/permissions")
def update_room_staff_permissions(
    room_id: str,
    uid: str,
    body: PermissionUpdate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.update_staff_permissions(principal, room_id, uid, body.permissions)


@router.delete(
    "/api/rooms/{room_id}/staff/{uid}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_room_staff(
    room_id: str,
    uid: str,
    principal: CurrentPrincipal,
    service: Service,
) -> Response:
    service.remove_staff(principal, room_id, uid)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/api/rooms/{room_id}/lead")
def update_room_lead(
    room_id: str,
    body: LeadInstructorUpdate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.update_room_lead(principal, room_id, body.lead_instructor_id)


@router.put("/api/rooms/{room_id}/participants/me")
def update_participant_nickname(
    room_id: str,
    body: NicknameUpdate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.update_nickname(principal, room_id, body.nickname)


@router.post("/api/rooms/{room_id}/questions", status_code=status.HTTP_201_CREATED)
def create_question(
    room_id: str,
    body: QuestionCreate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.create_question(
        principal,
        room_id,
        content=body.content,
        item_id=body.item_id,
        client_request_id=body.client_request_id,
    )


@router.put("/api/rooms/{room_id}/questions/{question_id}/answer")
def answer_question(
    room_id: str,
    question_id: str,
    body: QuestionAnswerUpdate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.answer_question(principal, room_id, question_id, body.answer)


@router.delete("/api/rooms/{room_id}/questions/{question_id}/answer")
def cancel_question_answer(
    room_id: str,
    question_id: str,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.cancel_question_answer(principal, room_id, question_id)


@router.post("/api/rooms/{room_id}/questions/{question_id}/hide")
def hide_question(
    room_id: str,
    question_id: str,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.moderate_question(principal, room_id, question_id, "HIDE")


@router.post("/api/rooms/{room_id}/questions/{question_id}/restore")
def restore_question(
    room_id: str,
    question_id: str,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.moderate_question(principal, room_id, question_id, "RESTORE")


@router.post("/api/rooms/{room_id}/questions/{question_id}/approve")
def approve_question(
    room_id: str,
    question_id: str,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.moderate_question(principal, room_id, question_id, "APPROVE")


@router.post("/api/rooms/{room_id}/questions/read")
def mark_questions_read(
    room_id: str,
    body: QuestionReadCreate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.mark_questions_read(
        principal,
        room_id,
        body.context_id,
        body.observed_at,
        body.observed_question_id,
    )


@router.get("/api/rooms/{room_id}/participants")
def room_participants(
    room_id: str, principal: CurrentPrincipal, service: Service
) -> dict[str, Any]:
    return service.participants(principal, room_id)


@router.patch("/api/rooms/{room_id}/participants/{participant_id}")
def update_participant_restriction(
    room_id: str,
    participant_id: str,
    body: ParticipantRestrictionUpdate,
    principal: CurrentPrincipal,
    service: Service,
) -> dict[str, Any]:
    return service.update_participant_restriction(
        principal,
        room_id,
        participant_id,
        body.is_question_restricted,
    )


@router.post("/api/rooms/{room_id}/end")
def end_room(
    room_id: str, principal: CurrentPrincipal, service: Service
) -> dict[str, Any]:
    return service.end_room(principal, room_id)


@router.get("/api/rooms/{room_id}/end-preview")
def end_room_preview(
    room_id: str, principal: CurrentPrincipal, service: Service
) -> dict[str, Any]:
    return service.end_room_preview(principal, room_id)


@router.get("/api/rooms/{room_id}/report")
def room_report(
    room_id: str, principal: CurrentPrincipal, service: Service
) -> dict[str, Any]:
    return service.room_report(principal, room_id)
