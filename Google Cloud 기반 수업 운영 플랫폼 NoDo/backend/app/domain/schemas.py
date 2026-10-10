from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

from app.domain.authorization import PERMISSION_KEYS
from app.domain.cloud_room_roles import DELEGABLE_ROOM_PERMISSION_KEYS
from app.domain.student_participant import normalize_participant_nickname
from app.domain.student_session import (
    normalize_room_code,
    normalize_student_nickname,
)


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class StudentSessionRequest(ApiModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    nickname: str
    room_code: str = Field(alias="roomCode")

    @field_validator("nickname", mode="before")
    @classmethod
    def validate_nickname(cls, value: object) -> str:
        return normalize_student_nickname(value)

    @field_validator("room_code", mode="before")
    @classmethod
    def validate_room_code(cls, value: object) -> str:
        return normalize_room_code(value)


class StudentSessionResponse(ApiModel):
    account_type: Literal["STUDENT"] = Field("STUDENT", alias="accountType")
    is_anonymous: Literal[True] = Field(True, alias="isAnonymous")
    identity_verified: Literal[True] = Field(True, alias="identityVerified")
    provider: Literal["anonymous"] = "anonymous"
    scope: Literal["AUTH_ONLY"] = "AUTH_ONLY"
    room_authorized: Literal[False] = Field(False, alias="roomAuthorized")
    nickname: str
    room_code: str = Field(alias="roomCode")


class CloudStudentParticipantJoin(ApiModel):
    nickname: str

    @field_validator("nickname", mode="before")
    @classmethod
    def validate_nickname(cls, value: object) -> str:
        return normalize_participant_nickname(value)


class StaffInvitationCreate(ApiModel):
    email: Annotated[str, Field(min_length=3, max_length=254)]


class OrganizationInvitationTokenAction(ApiModel):
    token: Annotated[
        str,
        Field(min_length=32, max_length=128, pattern=r"^[A-Za-z0-9_-]+$"),
    ]


class OrganizationRoleUpdate(ApiModel):
    organization_role: Literal["ADMIN", "INSTRUCTOR"] = Field(alias="organizationRole")
    expected_revision: Annotated[int, Field(ge=1)] = Field(alias="expectedRevision")


class InstructorStorageQuotaUpdate(ApiModel):
    limit_bytes: Annotated[int, Field(ge=1024**3, le=100 * 1024**3)] = Field(
        alias="limitBytes"
    )


class CloudCourseItemInput(ApiModel):
    id: Annotated[str, Field(min_length=1, max_length=100)]
    title: Annotated[str, Field(min_length=1, max_length=150)]
    description: Annotated[str, Field(max_length=1000)] = ""
    source_page_or_slide_numbers: list[Annotated[int, Field(ge=1)]] = Field(
        default_factory=list,
        max_length=20,
        alias="sourcePageOrSlideNumbers",
    )


class CloudCourseChapterInput(ApiModel):
    id: Annotated[str, Field(min_length=1, max_length=100)]
    title: Annotated[str, Field(min_length=1, max_length=100)]
    items: list[CloudCourseItemInput] = []


class CloudCourseCreate(ApiModel):
    title: Annotated[str, Field(min_length=1, max_length=100)]
    description: Annotated[str, Field(max_length=1000)] = ""
    chapters: list[CloudCourseChapterInput] = []
    material_ids: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(
        default_factory=list, max_length=20, alias="materialIds"
    )


class CloudCourseUpdate(CloudCourseCreate):
    expected_revision: Annotated[int, Field(ge=1)] = Field(alias="expectedRevision")


class CloudCourseArchive(ApiModel):
    expected_revision: Annotated[int, Field(ge=1)] = Field(alias="expectedRevision")


class CloudCourseMaterialAttach(ApiModel):
    material_id: Annotated[str, Field(min_length=1, max_length=100)] = Field(
        alias="materialId"
    )


class MaterialCourseDraftItemApplyInput(ApiModel):
    title: Annotated[str, Field(min_length=1, max_length=150)]
    description: Annotated[str, Field(max_length=1000)] = ""
    source_page_or_slide_numbers: list[Annotated[int, Field(ge=1)]] = Field(
        default_factory=list,
        max_length=20,
        alias="sourcePageOrSlideNumbers",
    )


class MaterialCourseDraftChapterApplyInput(ApiModel):
    title: Annotated[str, Field(min_length=1, max_length=100)]
    items: list[MaterialCourseDraftItemApplyInput] = Field(default_factory=list)


class MaterialCourseDraftApply(ApiModel):
    title: Annotated[str, Field(min_length=1, max_length=100)]
    description: Annotated[str, Field(max_length=1000)] = ""
    chapters: list[MaterialCourseDraftChapterApplyInput] = Field(default_factory=list)
    expected_revision: Annotated[int, Field(ge=1)] = Field(alias="expectedRevision")


class MaterialCourseDraftDiscard(ApiModel):
    expected_revision: Annotated[int, Field(ge=1)] = Field(alias="expectedRevision")


class CloudRoomCreate(ApiModel):
    source_course_id: Annotated[str, Field(min_length=1, max_length=100)] = Field(
        alias="sourceCourseId"
    )
    title: Annotated[str, Field(min_length=1, max_length=100)]
    max_active_participants: Annotated[int, Field(ge=1, le=300)] = Field(
        50, alias="maxActiveParticipants"
    )

    @field_validator("max_active_participants", mode="before")
    @classmethod
    def validate_active_participant_limit(cls, value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("maxActiveParticipants must be an integer")
        return value


class CloudRoomCapacityIncrease(ApiModel):
    """The requested ceiling is validated again by the room-presence service."""

    max_active_participants: Annotated[int, Field(ge=1, le=300)] = Field(
        alias="maxActiveParticipants"
    )

    @field_validator("max_active_participants", mode="before")
    @classmethod
    def validate_active_participant_limit(cls, value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("maxActiveParticipants must be an integer")
        return value


class CloudRoomRevisionInput(ApiModel):
    """Only the client-observed revision is accepted for room mutations."""

    expected_revision: Annotated[int, Field(ge=1)] = Field(alias="expectedRevision")


class CloudRoomEnd(CloudRoomRevisionInput):
    """A lead chooses the only post-end student access deadline."""

    student_access_window: (
        Literal["IMMEDIATE", "ONE_DAY", "SEVEN_DAYS", "THIRTY_DAYS", "CUSTOM"]
        | None
    ) = Field(default=None, alias="studentAccessWindow")
    student_access_until: AwareDatetime | None = Field(
        default=None, alias="studentAccessUntil"
    )


class CloudRoomMaterialPosition(ApiModel):
    unit_number: Annotated[int, Field(ge=1)] = Field(alias="unitNumber")
    expected_material_revision: Annotated[int, Field(ge=1)] = Field(
        alias="expectedMaterialRevision"
    )


class CloudRoomMaterialDownloadPolicy(ApiModel):
    download_enabled: bool = Field(alias="downloadEnabled")
    download_available_until: str | None = Field(
        default=None, alias="downloadAvailableUntil"
    )
    expected_download_policy_revision: Annotated[int, Field(ge=1)] = Field(
        alias="expectedDownloadPolicyRevision"
    )


class CloudRoomAssistantTarget(ApiModel):
    target_user_id: Annotated[str, Field(min_length=1, max_length=100)] = Field(
        alias="targetUserId"
    )
    expected_revision: Annotated[int, Field(ge=1)] = Field(alias="expectedRevision")


class CloudRoomAssistantPermissions(CloudRoomAssistantTarget):
    permissions: dict[str, bool]

    @field_validator("permissions")
    @classmethod
    def validate_delegable_permissions(cls, value: dict[str, bool]) -> dict[str, bool]:
        unknown = set(value) - set(DELEGABLE_ROOM_PERMISSION_KEYS)
        if unknown:
            raise ValueError(
                f"Unknown room assistant permissions: {', '.join(sorted(unknown))}"
            )
        return value


class CloudQuestionCreate(ApiModel):
    """Only learner-authored content and context selection cross the API."""

    content: Annotated[str, Field(min_length=1, max_length=500)]
    item_id: Annotated[
        str | None,
        Field(default=None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$"),
    ] = Field(alias="itemId")
    client_request_id: Annotated[
        str,
        Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$"),
    ] = Field(alias="clientRequestId")


class StudentAssistantPrompt(ApiModel):
    """Only the learner's current prompt and optional roadmap context are accepted."""

    content: Annotated[str, Field(min_length=1, max_length=500)]
    item_id: Annotated[
        str | None,
        Field(default=None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$"),
    ] = Field(alias="itemId")


class CloudQuestionAnswer(ApiModel):
    content: Annotated[str, Field(min_length=1, max_length=2000)]


class CloudQuestionRead(ApiModel):
    context_id: Annotated[
        str,
        Field(
            min_length=3, max_length=110, pattern=r"^(ALL|GENERAL|ITEM:[A-Za-z0-9_-]+)$"
        ),
    ] = Field(alias="contextId")
    observed_question_id: Annotated[str, Field(min_length=1, max_length=100)] = Field(
        alias="observedQuestionId"
    )


class CourseCreate(ApiModel):
    title: Annotated[str, Field(min_length=1, max_length=120)]
    description: Annotated[str, Field(max_length=1000)] = ""


class CourseUpdate(ApiModel):
    title: Annotated[str, Field(min_length=1, max_length=120)]
    description: Annotated[str, Field(max_length=1000)] = ""


class FlowItemInput(ApiModel):
    id: Annotated[str, Field(min_length=1, max_length=80)]
    title: Annotated[str, Field(min_length=1, max_length=200)]
    chapter_id: Annotated[str, Field(min_length=1, max_length=80)] = Field(
        alias="chapterId"
    )
    order: Annotated[int, Field(ge=0)]


class FlowChapterInput(ApiModel):
    id: Annotated[str, Field(min_length=1, max_length=80)]
    title: Annotated[str, Field(min_length=1, max_length=120)]
    order: Annotated[int, Field(ge=0)]


class CourseFlowUpdate(ApiModel):
    chapters: list[FlowChapterInput]
    items: list[FlowItemInput]

    @field_validator("items")
    @classmethod
    def validate_item_ids(cls, items: list[FlowItemInput]) -> list[FlowItemInput]:
        ids = [item.id for item in items]
        if len(ids) != len(set(ids)):
            raise ValueError("Flow item ids must be unique")
        return items


class MaterialUpdate(ApiModel):
    file_name: Annotated[str, Field(min_length=1, max_length=255)] = Field(
        alias="fileName"
    )
    file_type: Annotated[str, Field(min_length=1, max_length=20)] = Field(
        alias="fileType"
    )
    is_shared: bool = Field(alias="isShared")


class RoomCreate(ApiModel):
    join_code: Annotated[
        str | None, Field(default=None, min_length=4, max_length=12)
    ] = Field(None, alias="joinCode")


class CompletionUpdate(ApiModel):
    is_completed: bool = Field(alias="isCompleted")


class StaffCreate(ApiModel):
    user_id: Annotated[str, Field(min_length=1, max_length=128)] = Field(alias="userId")


class PermissionUpdate(ApiModel):
    permissions: dict[str, bool]

    @field_validator("permissions")
    @classmethod
    def validate_permissions(cls, value: dict[str, bool]) -> dict[str, bool]:
        unknown = set(value) - PERMISSION_KEYS
        if unknown:
            raise ValueError(
                f"Unknown assistant permissions: {', '.join(sorted(unknown))}"
            )
        return value


class JoinRoomRequest(ApiModel):
    room_code: Annotated[str, Field(min_length=4, max_length=12)] = Field(
        alias="roomCode"
    )
    nickname: Annotated[str | None, Field(default=None, min_length=2, max_length=20)]


class NicknameUpdate(ApiModel):
    nickname: Annotated[str, Field(min_length=2, max_length=20)]


class LeadInstructorUpdate(ApiModel):
    lead_instructor_id: Annotated[str, Field(min_length=1, max_length=128)] = Field(
        alias="leadInstructorId"
    )


class QuestionCreate(ApiModel):
    content: Annotated[str, Field(min_length=1, max_length=500)]
    item_id: Annotated[
        str | None,
        Field(
            default=None,
            min_length=1,
            max_length=80,
            pattern=r"^[A-Za-z0-9_-]+$",
        ),
    ] = Field(None, alias="itemId")
    client_request_id: Annotated[
        str,
        Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$"),
    ] = Field(alias="clientRequestId")


class QuestionAnswerUpdate(ApiModel):
    answer: Annotated[str, Field(min_length=1, max_length=2000)]


class QuestionReadCreate(ApiModel):
    context_id: Annotated[
        str,
        Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$"),
    ] = Field(alias="contextId")
    observed_at: AwareDatetime = Field(alias="observedAt")
    observed_question_id: Annotated[
        str,
        Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$"),
    ] = Field(alias="observedQuestionId")


class ParticipantRestrictionUpdate(ApiModel):
    is_question_restricted: bool = Field(alias="isQuestionRestricted")


def api_document(document: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow JSON-friendly document without exposing Firestore objects."""
    return {key: value for key, value in document.items()}
