import os
from dataclasses import dataclass, field

EMULATOR_RUNTIME_MODE = "emulator"
CLOUD_AUTH_RUNTIME_MODE = "cloud-auth"
EXPECTED_CLOUD_FIREBASE_PROJECT_ID = "example-gcp-project"
EXPECTED_CLOUD_FIRESTORE_DATABASE_ID = "(default)"
EXPECTED_BOOTSTRAP_ORG_ID = "demo"
EXPECTED_BOOTSTRAP_ORG_NAME = "DEMO"
EXPECTED_STAFF_EMAIL_DOMAINS = frozenset({"nodo-company.test"})
EXPECTED_CLOUD_STORAGE_BUCKET = "example-gcp-project-nodo-materials"
EXPECTED_NODO_HOSTING_ORIGIN = "https://example-gcp-project-nodo.web.app"
EXPECTED_NODO_HOSTING_FIREBASEAPP_ORIGIN = (
    "https://example-gcp-project-nodo.firebaseapp.com"
)
EXPECTED_CLOUD_AUTH_DEVELOPMENT_ORIGIN = "http://localhost:5175"
EXPECTED_CLOUD_CORS_ORIGINS = frozenset(
    {
        EXPECTED_NODO_HOSTING_ORIGIN,
        EXPECTED_NODO_HOSTING_FIREBASEAPP_ORIGIN,
        EXPECTED_CLOUD_AUTH_DEVELOPMENT_ORIGIN,
    }
)
EXPECTED_AUTH_EMULATOR_HOST = "127.0.0.1:9099"
EXPECTED_FIRESTORE_EMULATOR_HOST = "127.0.0.1:8081"


def _cors_origins() -> tuple[str, ...]:
    raw_origins = os.getenv(
        "NODO_CORS_ORIGINS",
        os.getenv("CORS_ORIGINS", "http://127.0.0.1:5174"),
    )
    return tuple(origin.strip() for origin in raw_origins.split(",") if origin.strip())


def _bootstrap_org_owner_emails() -> frozenset[str]:
    raw_emails = os.getenv("NODO_BOOTSTRAP_ORG_OWNER_EMAILS", "")
    return frozenset(
        email.strip().lower() for email in raw_emails.split(",") if email.strip()
    )


def _boolean_environment(name: str, *, default: bool) -> bool:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    normalized = raw_value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise RuntimeError(f"{name} must be true or false")


def _staff_email_domains() -> frozenset[str]:
    raw_domains = os.getenv("NODO_STAFF_EMAIL_DOMAINS", "nodo-company.test")
    return frozenset(
        domain.strip().lower() for domain in raw_domains.split(",") if domain.strip()
    )


def _positive_integer_environment(name: str, *, default: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive integer") from error
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


@dataclass(frozen=True)
class Settings:
    runtime_mode: str = os.getenv("NODO_RUNTIME_MODE", EMULATOR_RUNTIME_MODE)
    app_env: str = os.getenv("APP_ENV", "local")
    app_name: str = os.getenv("APP_NAME", "NoDo")
    app_version: str = os.getenv("APP_VERSION", "02")
    cors_origins: tuple[str, ...] = _cors_origins()
    firebase_project_id: str = os.getenv("NODO_FIREBASE_PROJECT_ID", "demo-nodo")
    firestore_database_id: str = os.getenv(
        "NODO_FIRESTORE_DATABASE_ID",
        EXPECTED_CLOUD_FIRESTORE_DATABASE_ID,
    )
    bootstrap_org_id: str = os.getenv(
        "NODO_BOOTSTRAP_ORG_ID", EXPECTED_BOOTSTRAP_ORG_ID
    )
    bootstrap_org_name: str = os.getenv(
        "NODO_BOOTSTRAP_ORG_NAME", EXPECTED_BOOTSTRAP_ORG_NAME
    )
    bootstrap_enabled: bool = _boolean_environment(
        "NODO_BOOTSTRAP_ENABLED", default=False
    )
    bootstrap_org_owner_emails: frozenset[str] = _bootstrap_org_owner_emails()
    staff_email_domains: frozenset[str] = _staff_email_domains()
    staff_invitation_ttl_hours: int = _positive_integer_environment(
        "NODO_STAFF_INVITATION_TTL_HOURS", default=168
    )
    email_provider: str = os.getenv("NODO_EMAIL_PROVIDER", "disabled").strip().lower()
    resend_api_key: str = field(
        default_factory=lambda: os.getenv("RESEND_API_KEY", ""),
        repr=False,
    )
    email_from: str = os.getenv("NODO_EMAIL_FROM", "")
    public_app_url: str = os.getenv(
        "NODO_PUBLIC_APP_URL", EXPECTED_CLOUD_AUTH_DEVELOPMENT_ORIGIN
    ).rstrip("/")
    firebase_auth_emulator_host: str = os.getenv(
        "FIREBASE_AUTH_EMULATOR_HOST", EXPECTED_AUTH_EMULATOR_HOST
    )
    firestore_emulator_host: str = os.getenv(
        "FIRESTORE_EMULATOR_HOST", EXPECTED_FIRESTORE_EMULATOR_HOST
    )
    storage_mode: str = os.getenv("NODO_STORAGE_MODE", "disabled")
    storage_bucket: str = os.getenv("NODO_STORAGE_BUCKET", "")
    google_cloud_project: str = os.getenv("GOOGLE_CLOUD_PROJECT", "")
    vertex_ai_mode: str = os.getenv("NODO_VERTEX_AI_MODE", "disabled")
    vertex_ai_location: str = os.getenv("NODO_VERTEX_AI_LOCATION", "global")
    vertex_ai_model: str = os.getenv("NODO_VERTEX_AI_MODEL", "gemini-2.5-flash")
    vertex_ai_max_input_characters: int = _positive_integer_environment(
        "NODO_VERTEX_AI_MAX_INPUT_CHARACTERS", default=24_000
    )

    def ensure_emulator_only(self) -> None:
        if self.runtime_mode != EMULATOR_RUNTIME_MODE:
            raise RuntimeError("Firebase Emulator access is disabled in this mode")
        if self.app_env not in {"local", "test"}:
            raise RuntimeError("Firebase access is limited to local/test mode")
        if self.firebase_project_id != "demo-nodo":
            raise RuntimeError("Only the demo-nodo Emulator project is allowed")
        self._ensure_exact_emulator_host(
            self.firebase_auth_emulator_host,
            EXPECTED_AUTH_EMULATOR_HOST,
            "Authentication",
        )
        self._ensure_exact_emulator_host(
            self.firestore_emulator_host,
            EXPECTED_FIRESTORE_EMULATOR_HOST,
            "Firestore",
        )

    def ensure_cloud_auth_only(self) -> None:
        if self.runtime_mode != CLOUD_AUTH_RUNTIME_MODE:
            raise RuntimeError("Cloud Authentication is disabled in this mode")
        if self.firebase_project_id != EXPECTED_CLOUD_FIREBASE_PROJECT_ID:
            raise RuntimeError("The Cloud Authentication project is not allowed")
        if self.firestore_database_id != EXPECTED_CLOUD_FIRESTORE_DATABASE_ID:
            raise RuntimeError("The Cloud Firestore database is not allowed")
        if self.bootstrap_org_id != EXPECTED_BOOTSTRAP_ORG_ID:
            raise RuntimeError("The Bootstrap organization id is not allowed")
        if self.bootstrap_org_name != EXPECTED_BOOTSTRAP_ORG_NAME:
            raise RuntimeError("The Bootstrap organization name is not allowed")
        if self.bootstrap_enabled and not self.bootstrap_org_owner_emails:
            raise RuntimeError("The Bootstrap organization owner list is required")
        if any(
            "*" in email or "@" not in email
            for email in self.bootstrap_org_owner_emails
        ):
            raise RuntimeError("The Bootstrap organization owner list is invalid")
        if self.staff_email_domains != EXPECTED_STAFF_EMAIL_DOMAINS:
            raise RuntimeError("The staff email domain configuration is not allowed")
        if not 1 <= self.staff_invitation_ttl_hours <= 8760:
            raise RuntimeError("The staff invitation TTL is not allowed")
        if self.email_provider not in {"disabled", "resend"}:
            raise RuntimeError("NODO_EMAIL_PROVIDER must be disabled or resend")
        if self.public_app_url not in EXPECTED_CLOUD_CORS_ORIGINS:
            raise RuntimeError("The public NoDo application URL is not allowed")
        if any(character in self.email_from for character in "\r\n"):
            raise RuntimeError("The invitation email sender is invalid")
        if not self.cors_origins or any(
            origin not in EXPECTED_CLOUD_CORS_ORIGINS
            for origin in self.cors_origins
        ):
            raise RuntimeError("The configured CORS origins are not allowed")
        if (
            self.app_env == "production"
            and set(self.cors_origins) != EXPECTED_CLOUD_CORS_ORIGINS
        ):
            raise RuntimeError(
                "Production CORS origins must use the fixed NoDo origins"
            )
        emulator_variables = (
            "FIREBASE_AUTH_EMULATOR_HOST",
            "FIRESTORE_EMULATOR_HOST",
            "FIREBASE_STORAGE_EMULATOR_HOST",
        )
        if any(os.getenv(name) for name in emulator_variables):
            raise RuntimeError(
                "Firebase Emulator variables are forbidden in cloud-auth"
            )
        if os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
            raise RuntimeError(
                "Service account JSON credentials are forbidden in cloud-auth"
            )
        if self.app_env == "production":
            if self.storage_mode != "cloud":
                raise RuntimeError("NoDo private Storage uploads are disabled")
            if self.storage_bucket != EXPECTED_CLOUD_STORAGE_BUCKET:
                raise RuntimeError("The configured NoDo Storage bucket is not allowed")
            if self.google_cloud_project != EXPECTED_CLOUD_FIREBASE_PROJECT_ID:
                raise RuntimeError("The configured Google Cloud project is not allowed")

    def validate_startup(self) -> None:
        if self.runtime_mode == EMULATOR_RUNTIME_MODE:
            self.ensure_emulator_only()
            return
        if self.runtime_mode == CLOUD_AUTH_RUNTIME_MODE:
            self.ensure_cloud_auth_only()
            return
        raise RuntimeError("NODO_RUNTIME_MODE must be emulator or cloud-auth")

    def ensure_private_storage_uploads_enabled(self) -> None:
        """Permit uploads only to the fixed NoDo cloud-auth bucket.

        Storage is intentionally disabled by default, including in the Emulator
        runtime.  This keeps a local test process from reaching a real bucket
        when a developer happens to have ADC available.
        """

        if self.runtime_mode != CLOUD_AUTH_RUNTIME_MODE:
            raise RuntimeError("NoDo private Storage is disabled outside cloud-auth")
        self.ensure_cloud_auth_only()
        if self.storage_mode != "cloud":
            raise RuntimeError("NoDo private Storage uploads are disabled")
        if self.storage_bucket != EXPECTED_CLOUD_STORAGE_BUCKET:
            raise RuntimeError("The configured NoDo Storage bucket is not allowed")
        if self.google_cloud_project != EXPECTED_CLOUD_FIREBASE_PROJECT_ID:
            raise RuntimeError("The configured Google Cloud project is not allowed")

    def ensure_vertex_ai_drafts_enabled(self) -> None:
        """Allow server-only Gemini drafts only with the fixed Vertex contract."""

        self.ensure_private_storage_uploads_enabled()
        if self.vertex_ai_mode != "vertex":
            raise RuntimeError("NoDo Vertex AI drafts are disabled")
        if self.vertex_ai_location != "global":
            raise RuntimeError("NoDo Gemini drafts must use the global endpoint")
        if self.vertex_ai_model != "gemini-2.5-flash":
            raise RuntimeError("The configured Gemini model is not allowed")
        if not 1_000 <= self.vertex_ai_max_input_characters <= 100_000:
            raise RuntimeError("The configured Gemini input limit is not allowed")

    def ensure_vertex_ai_student_assistant_enabled(self) -> None:
        """Allow the learner assistant through the fixed server-side Vertex path."""

        # Unlike material drafts, the learner assistant never reads or writes
        # private Storage.  It still requires the same cloud-auth, project and
        # model boundaries so an Emulator session cannot accidentally make a
        # real external AI request.
        self.ensure_cloud_auth_only()
        if self.google_cloud_project != EXPECTED_CLOUD_FIREBASE_PROJECT_ID:
            raise RuntimeError("The configured Google Cloud project is not allowed")
        if self.vertex_ai_mode != "vertex":
            raise RuntimeError("NoDo Vertex AI learner assistant is disabled")
        if self.vertex_ai_location != "global":
            raise RuntimeError(
                "NoDo Gemini learner assistant must use the global endpoint"
            )
        if self.vertex_ai_model != "gemini-2.5-flash":
            raise RuntimeError("The configured Gemini model is not allowed")
        if not 1_000 <= self.vertex_ai_max_input_characters <= 100_000:
            raise RuntimeError("The configured Gemini input limit is not allowed")

    @staticmethod
    def _ensure_exact_emulator_host(value: str, expected: str, service: str) -> None:
        if value != expected:
            raise RuntimeError(
                f"{service} Emulator must use the fixed loopback endpoint"
            )


settings = Settings()
