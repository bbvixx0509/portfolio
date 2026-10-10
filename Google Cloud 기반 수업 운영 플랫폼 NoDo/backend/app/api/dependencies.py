import logging
from typing import Annotated, Any

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import exceptions as firebase_exceptions

from app.adapters.firebase_cloud_auth import (
    firebase_id_token_failure_code,
    verify_cloud_id_token,
)
from app.adapters.firebase_cloud_firestore import (
    FirestoreCloudCourseRepository,
    FirestoreCloudMaterialUploadRepository,
    FirestoreCloudOrganizationRepository,
    FirestoreCloudQuestionRepository,
    FirestoreCloudRoomRepository,
    FirestoreCloudStudentParticipantRepository,
)
from app.adapters.firebase_cloud_storage import GoogleCloudPrivateStorage
from app.adapters.invitation_email import (
    DisabledInvitationEmailSender,
    ResendInvitationEmailSender,
)
from app.adapters.vertex_ai_gemini import (
    VertexAIGeminiCourseDraftAdapter,
    VertexAIGeminiStudentAssistantAdapter,
)
from app.core.config import (
    CLOUD_AUTH_RUNTIME_MODE,
    EMULATOR_RUNTIME_MODE,
    Settings,
    settings,
)
from app.domain.authorization import AccountType, Principal, account_profile
from app.domain.errors import AccessDenied, AuthenticationRequired
from app.services.cloud_auth_service import (
    VerifiedCloudIdentity,
    verify_cloud_google_identity,
)
from app.services.cloud_course_service import CloudCourseRepository, CloudCourseService
from app.services.cloud_invitation_service import (
    CloudInvitationService,
    InvitationEmailSender,
)
from app.services.cloud_material_course_draft_service import (
    CloudMaterialCourseDraftRepository,
    CloudMaterialCourseDraftService,
    GeminiCourseDraftAdapter,
    PrivateDraftExtractionStorage,
)
from app.services.cloud_material_extraction_service import (
    CloudMaterialExtractionRepository,
    CloudMaterialExtractionService,
    PrivateExtractionStorage,
)
from app.services.cloud_material_storage_quota_service import (
    CloudMaterialStorageQuotaService,
)
from app.services.cloud_material_upload_service import (
    CloudMaterialUploadRepository,
    CloudMaterialUploadService,
    PrivateStorage,
)
from app.services.cloud_organization_role_service import (
    CloudOrganizationRoleService,
)
from app.services.cloud_organization_service import (
    CloudOrganizationRepository,
    CloudOrganizationService,
)
from app.services.cloud_question_service import (
    CloudQuestionRepository,
    CloudQuestionService,
)
from app.services.cloud_room_material_service import (
    CloudRoomMaterialRepository,
    CloudRoomMaterialService,
    PrivateRoomMaterialStorage,
)
from app.services.cloud_room_service import CloudRoomRepository, CloudRoomService
from app.services.cloud_staff_service import CloudStaffService
from app.services.cloud_student_assistant_service import (
    CloudStudentAssistantService,
    GeminiStudentAssistantAdapter,
)
from app.services.cloud_student_participant_service import (
    CloudStudentParticipantRepository,
    CloudStudentParticipantService,
)
from app.services.nodo_service import NoDoService
from app.services.student_auth_service import (
    VerifiedStudentIdentity,
    authorize_anonymous_student,
)

bearer_scheme = HTTPBearer(auto_error=False)
LOGGER = logging.getLogger("uvicorn.error")


def get_repository() -> Any:
    if settings.runtime_mode != EMULATOR_RUNTIME_MODE:
        raise AccessDenied("Data APIs are disabled in cloud-auth mode")
    from app.adapters.firebase_emulator import FirestoreRepository

    return FirestoreRepository()


def get_runtime_settings() -> Settings:
    return settings


def get_service(
    repository: Annotated[Any, Depends(get_repository)],
) -> NoDoService:
    return NoDoService(repository)


def get_current_principal(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    repository: Annotated[Any, Depends(get_repository)],
) -> Principal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise AuthenticationRequired("A Firebase ID token is required")
    from app.adapters.firebase_emulator import verify_emulator_id_token

    try:
        claims: Any = verify_emulator_id_token(credentials.credentials)
    except (ValueError, firebase_exceptions.FirebaseError) as exc:
        raise AuthenticationRequired("The Firebase ID token is invalid") from exc
    uid = claims.get("uid") or claims.get("sub")
    if not uid:
        raise AuthenticationRequired("The Firebase ID token has no user id")
    provider = claims.get("firebase", {}).get("sign_in_provider")
    is_anonymous = provider == "anonymous"
    profile = repository.get_user(uid)
    if profile is None:
        if not is_anonymous:
            raise AuthenticationRequired("The authenticated user has no server profile")
        return Principal(
            uid=uid,
            account_type=AccountType.STUDENT,
            org_id=None,
            is_anonymous=True,
        )
    try:
        account_type, organization_role = account_profile(profile)
    except (KeyError, ValueError) as exc:
        raise AuthenticationRequired(
            "The user profile has an invalid account type"
        ) from exc
    return Principal(
        uid=uid,
        account_type=account_type,
        org_id=profile.get("orgId"),
        organization_role=organization_role,
        email=profile.get("email"),
        display_name=profile.get("displayName"),
        is_anonymous=is_anonymous or bool(profile.get("isAnonymous")),
    )


CurrentPrincipal = Annotated[Principal, Depends(get_current_principal)]
Service = Annotated[NoDoService, Depends(get_service)]


def get_cloud_verified_identity(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> VerifiedCloudIdentity:
    if (
        credentials is None
        or credentials.scheme.lower() != "bearer"
        or not credentials.credentials
    ):
        raise AuthenticationRequired("A Firebase ID token is required")

    runtime_settings.ensure_cloud_auth_only()
    try:
        claims = verify_cloud_id_token(
            credentials.credentials,
            project_id=runtime_settings.firebase_project_id,
        )
    except (ValueError, firebase_exceptions.FirebaseError) as exc:
        if runtime_settings.app_env == "local":
            LOGGER.warning(
                "NoDo cloud auth token rejected code=%s",
                firebase_id_token_failure_code(exc),
            )
        raise AuthenticationRequired("The Firebase ID token is invalid") from exc

    return verify_cloud_google_identity(
        claims,
        project_id=runtime_settings.firebase_project_id,
    )


CloudVerifiedIdentity = Annotated[
    VerifiedCloudIdentity, Depends(get_cloud_verified_identity)
]


def get_cloud_organization_repository(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudOrganizationRepository:
    runtime_settings.ensure_cloud_auth_only()
    return FirestoreCloudOrganizationRepository.from_settings(runtime_settings)


def get_cloud_organization_service(
    repository: Annotated[
        CloudOrganizationRepository,
        Depends(get_cloud_organization_repository),
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudOrganizationService:
    return CloudOrganizationService(repository, runtime_settings)


CloudOrganization = Annotated[
    CloudOrganizationService, Depends(get_cloud_organization_service)
]


def get_cloud_organization_role_service(
    repository: Annotated[
        CloudOrganizationRepository,
        Depends(get_cloud_organization_repository),
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudOrganizationRoleService:
    return CloudOrganizationRoleService(repository, runtime_settings)


CloudOrganizationRoles = Annotated[
    CloudOrganizationRoleService,
    Depends(get_cloud_organization_role_service),
]


def get_cloud_staff_service(
    repository: Annotated[
        CloudOrganizationRepository,
        Depends(get_cloud_organization_repository),
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudStaffService:
    return CloudStaffService(repository, runtime_settings)


CloudStaff = Annotated[CloudStaffService, Depends(get_cloud_staff_service)]


def get_invitation_email_sender(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> InvitationEmailSender:
    if (
        runtime_settings.email_provider == "resend"
        and runtime_settings.resend_api_key.strip()
        and runtime_settings.email_from.strip()
    ):
        return ResendInvitationEmailSender(
            api_key=runtime_settings.resend_api_key,
            sender=runtime_settings.email_from,
        )
    return DisabledInvitationEmailSender()


def get_cloud_invitation_service(
    repository: Annotated[
        CloudOrganizationRepository,
        Depends(get_cloud_organization_repository),
    ],
    email_sender: Annotated[
        InvitationEmailSender,
        Depends(get_invitation_email_sender),
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudInvitationService:
    return CloudInvitationService(repository, email_sender, runtime_settings)


CloudInvitations = Annotated[
    CloudInvitationService,
    Depends(get_cloud_invitation_service),
]


def get_cloud_private_storage(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> PrivateStorage | None:
    # Construction is gated by the service too.  A disabled local/Emulator
    # runtime never initializes a Google Cloud Storage client.
    try:
        runtime_settings.ensure_private_storage_uploads_enabled()
    except RuntimeError:
        return None
    return GoogleCloudPrivateStorage.from_settings(runtime_settings)


def get_cloud_course_repository(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudCourseRepository:
    runtime_settings.ensure_cloud_auth_only()
    return FirestoreCloudCourseRepository.from_settings(runtime_settings)


def get_cloud_course_service(
    repository: Annotated[CloudCourseRepository, Depends(get_cloud_course_repository)],
    storage: Annotated[PrivateStorage | None, Depends(get_cloud_private_storage)],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudCourseService:
    return CloudCourseService(repository, runtime_settings, storage=storage)


CloudCourses = Annotated[CloudCourseService, Depends(get_cloud_course_service)]


def get_cloud_material_upload_repository(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudMaterialUploadRepository:
    runtime_settings.ensure_cloud_auth_only()
    return FirestoreCloudMaterialUploadRepository.from_settings(runtime_settings)


def get_cloud_material_upload_service(
    repository: Annotated[
        CloudMaterialUploadRepository,
        Depends(get_cloud_material_upload_repository),
    ],
    storage: Annotated[PrivateStorage | None, Depends(get_cloud_private_storage)],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudMaterialUploadService:
    return CloudMaterialUploadService(repository, storage, runtime_settings)


CloudMaterialUploads = Annotated[
    CloudMaterialUploadService, Depends(get_cloud_material_upload_service)
]


def get_cloud_material_storage_quota_service(
    repository: Annotated[
        CloudMaterialUploadRepository,
        Depends(get_cloud_material_upload_repository),
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudMaterialStorageQuotaService:
    return CloudMaterialStorageQuotaService(repository, runtime_settings)


CloudMaterialStorageQuota = Annotated[
    CloudMaterialStorageQuotaService, Depends(get_cloud_material_storage_quota_service)
]


def get_cloud_material_extraction_repository(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudMaterialExtractionRepository:
    runtime_settings.ensure_cloud_auth_only()
    return FirestoreCloudMaterialUploadRepository.from_settings(runtime_settings)


def get_cloud_material_extraction_service(
    repository: Annotated[
        CloudMaterialExtractionRepository,
        Depends(get_cloud_material_extraction_repository),
    ],
    storage: Annotated[
        PrivateExtractionStorage | None, Depends(get_cloud_private_storage)
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudMaterialExtractionService:
    return CloudMaterialExtractionService(repository, storage, runtime_settings)


CloudMaterialExtractions = Annotated[
    CloudMaterialExtractionService, Depends(get_cloud_material_extraction_service)
]


def get_cloud_material_course_draft_repository(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudMaterialCourseDraftRepository:
    runtime_settings.ensure_cloud_auth_only()
    return FirestoreCloudMaterialUploadRepository.from_settings(runtime_settings)


def get_vertex_gemini_course_draft_adapter(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> GeminiCourseDraftAdapter | None:
    try:
        runtime_settings.ensure_vertex_ai_drafts_enabled()
    except RuntimeError:
        return None
    return VertexAIGeminiCourseDraftAdapter(runtime_settings)


def get_cloud_material_course_draft_service(
    repository: Annotated[
        CloudMaterialCourseDraftRepository,
        Depends(get_cloud_material_course_draft_repository),
    ],
    storage: Annotated[
        PrivateDraftExtractionStorage | None, Depends(get_cloud_private_storage)
    ],
    gemini: Annotated[
        GeminiCourseDraftAdapter | None,
        Depends(get_vertex_gemini_course_draft_adapter),
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudMaterialCourseDraftService:
    return CloudMaterialCourseDraftService(
        repository, storage, gemini, runtime_settings
    )


CloudMaterialCourseDrafts = Annotated[
    CloudMaterialCourseDraftService, Depends(get_cloud_material_course_draft_service)
]


def get_cloud_room_repository(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudRoomRepository:
    runtime_settings.ensure_cloud_auth_only()
    return FirestoreCloudRoomRepository.from_settings(runtime_settings)


def get_cloud_room_service(
    repository: Annotated[CloudRoomRepository, Depends(get_cloud_room_repository)],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudRoomService:
    return CloudRoomService(repository, runtime_settings)


CloudRooms = Annotated[CloudRoomService, Depends(get_cloud_room_service)]


def get_cloud_room_material_repository(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudRoomMaterialRepository:
    if runtime_settings.runtime_mode == CLOUD_AUTH_RUNTIME_MODE:
        runtime_settings.ensure_cloud_auth_only()
        return FirestoreCloudRoomRepository.from_settings(runtime_settings)
    if runtime_settings.runtime_mode == EMULATOR_RUNTIME_MODE:
        runtime_settings.ensure_emulator_only()
        return FirestoreCloudRoomRepository.from_emulator_settings(runtime_settings)
    runtime_settings.validate_startup()
    raise RuntimeError("Unsupported NoDo runtime mode")


def get_cloud_room_material_service(
    repository: Annotated[
        CloudRoomMaterialRepository, Depends(get_cloud_room_material_repository)
    ],
    storage: Annotated[
        PrivateRoomMaterialStorage | None, Depends(get_cloud_private_storage)
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudRoomMaterialService:
    return CloudRoomMaterialService(repository, storage, runtime_settings)


CloudRoomMaterials = Annotated[
    CloudRoomMaterialService, Depends(get_cloud_room_material_service)
]


def get_cloud_question_repository(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudQuestionRepository:
    if runtime_settings.runtime_mode == CLOUD_AUTH_RUNTIME_MODE:
        runtime_settings.ensure_cloud_auth_only()
        return FirestoreCloudQuestionRepository.from_settings(runtime_settings)
    if runtime_settings.runtime_mode == EMULATOR_RUNTIME_MODE:
        runtime_settings.ensure_emulator_only()
        return FirestoreCloudQuestionRepository.from_emulator_settings(runtime_settings)
    runtime_settings.validate_startup()
    raise RuntimeError("Unsupported NoDo runtime mode")


def get_cloud_question_service(
    repository: Annotated[
        CloudQuestionRepository,
        Depends(get_cloud_question_repository),
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudQuestionService:
    return CloudQuestionService(repository, runtime_settings)


CloudQuestions = Annotated[CloudQuestionService, Depends(get_cloud_question_service)]


def get_vertex_gemini_student_assistant_adapter(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> GeminiStudentAssistantAdapter | None:
    try:
        runtime_settings.ensure_vertex_ai_student_assistant_enabled()
    except RuntimeError:
        return None
    return VertexAIGeminiStudentAssistantAdapter(runtime_settings)


def get_cloud_student_assistant_service(
    questions: Annotated[CloudQuestionService, Depends(get_cloud_question_service)],
    gemini: Annotated[
        GeminiStudentAssistantAdapter | None,
        Depends(get_vertex_gemini_student_assistant_adapter),
    ],
) -> CloudStudentAssistantService:
    return CloudStudentAssistantService(questions, gemini)


CloudStudentAssistant = Annotated[
    CloudStudentAssistantService, Depends(get_cloud_student_assistant_service)
]


def get_student_participant_repository(
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudStudentParticipantRepository:
    if runtime_settings.runtime_mode == CLOUD_AUTH_RUNTIME_MODE:
        runtime_settings.ensure_cloud_auth_only()
        return FirestoreCloudStudentParticipantRepository.from_settings(
            runtime_settings
        )
    if runtime_settings.runtime_mode == EMULATOR_RUNTIME_MODE:
        runtime_settings.ensure_emulator_only()
        return FirestoreCloudStudentParticipantRepository.from_emulator_settings(
            runtime_settings
        )
    runtime_settings.validate_startup()
    raise RuntimeError("Unsupported NoDo runtime mode")


def get_student_participant_service(
    repository: Annotated[
        CloudStudentParticipantRepository,
        Depends(get_student_participant_repository),
    ],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> CloudStudentParticipantService:
    return CloudStudentParticipantService(repository, runtime_settings)


StudentParticipants = Annotated[
    CloudStudentParticipantService, Depends(get_student_participant_service)
]


def get_student_authenticated_identity(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    runtime_settings: Annotated[Settings, Depends(get_runtime_settings)],
) -> VerifiedStudentIdentity:
    if (
        credentials is None
        or credentials.scheme.lower() != "bearer"
        or not credentials.credentials
    ):
        raise AuthenticationRequired("A Firebase ID token is required")

    try:
        if runtime_settings.runtime_mode == CLOUD_AUTH_RUNTIME_MODE:
            runtime_settings.ensure_cloud_auth_only()
            claims = verify_cloud_id_token(
                credentials.credentials,
                project_id=runtime_settings.firebase_project_id,
            )
        elif runtime_settings.runtime_mode == EMULATOR_RUNTIME_MODE:
            runtime_settings.ensure_emulator_only()
            from app.adapters.firebase_emulator import verify_emulator_id_token

            claims = verify_emulator_id_token(credentials.credentials)
        else:
            runtime_settings.validate_startup()
            raise RuntimeError("Unsupported NoDo runtime mode")
    except (ValueError, firebase_exceptions.FirebaseError) as exc:
        raise AuthenticationRequired("The Firebase ID token is invalid") from exc

    return authorize_anonymous_student(
        claims,
        project_id=runtime_settings.firebase_project_id,
    )


StudentAuthenticatedIdentity = Annotated[
    VerifiedStudentIdentity, Depends(get_student_authenticated_identity)
]
