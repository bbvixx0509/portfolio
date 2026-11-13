package main

import (
	"errors"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// These values mirror backend/app/core/config.py. TestBackendConstantsMatch
// fails if the two drift apart.
const (
	EmulatorRuntimeMode   = "emulator"
	CloudAuthRuntimeMode  = "cloud-auth"
	ExpectedCloudProject  = "example-gcp-project"
	ExpectedFirestoreDB   = "(default)"
	ExpectedBootstrapID   = "demo"
	ExpectedBootstrapName = "DEMO"
	ExpectedStorageBucket = "example-gcp-project-nodo-materials"
	ExpectedHostingOrigin = "https://example-gcp-project-nodo.web.app"
	ExpectedFirebaseApp   = "https://example-gcp-project-nodo.firebaseapp.com"
	ExpectedDevOrigin     = "http://localhost:5175"
	ExpectedAuthEmulator  = "127.0.0.1:9099"
	ExpectedStoreEmulator = "127.0.0.1:8081"
)

var (
	expectedStaffDomains = []string{"nodo-company.test"}
	expectedCORSOrigins  = []string{ExpectedHostingOrigin, ExpectedFirebaseApp, ExpectedDevOrigin}
	pythonInt            = regexp.MustCompile(`^[+-]?\d+(_\d+)*$`)
)

// Settings is the subset of the backend settings that startup validation reads.
type Settings struct {
	RuntimeMode          string
	AppEnv               string
	CORSOrigins          []string
	FirebaseProjectID    string
	FirestoreDatabaseID  string
	BootstrapOrgID       string
	BootstrapOrgName     string
	BootstrapEnabled     bool
	BootstrapOwnerEmails []string
	StaffEmailDomains    []string
	StaffInvitationTTL   int
	EmailProvider        string
	EmailFrom            string
	PublicAppURL         string
	AuthEmulatorHost     string
	FirestoreEmulator    string
	StorageMode          string
	StorageBucket        string
	GoogleCloudProject   string
	VertexMode           string
	VertexLocation       string
	VertexModel          string
	VertexMaxInputChars  int

	env Env
}

func splitList(raw string, lower bool) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if lower {
			part = strings.ToLower(part)
		}
		if part != "" && !slices.Contains(out, part) {
			out = append(out, part)
		}
	}
	return out
}

func boolEnv(env Env, name string, fallback bool) (bool, error) {
	raw, ok := env.lookup(name)
	if !ok {
		return fallback, nil
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, errors.New(name + " must be true or false")
}

func positiveIntEnv(env Env, name string, fallback int) (int, error) {
	raw, ok := env.lookup(name)
	if !ok {
		return fallback, nil
	}
	raw = strings.TrimSpace(raw)
	if !pythonInt.MatchString(raw) {
		return 0, errors.New(name + " must be a positive integer")
	}
	value, err := strconv.Atoi(strings.ReplaceAll(raw, "_", ""))
	if err != nil || value <= 0 {
		return 0, errors.New(name + " must be a positive integer")
	}
	return value, nil
}

// LoadSettings applies the same defaults as the backend. Like the backend,
// a malformed boolean or integer is an error before any check runs.
func LoadSettings(env Env) (Settings, error) {
	s := Settings{env: env}
	var err error
	s.RuntimeMode = env.get("NODO_RUNTIME_MODE", EmulatorRuntimeMode)
	s.AppEnv = env.get("APP_ENV", "local")
	s.CORSOrigins = splitList(env.get("NODO_CORS_ORIGINS", env.get("CORS_ORIGINS", "http://127.0.0.1:5174")), false)
	s.FirebaseProjectID = env.get("NODO_FIREBASE_PROJECT_ID", "demo-nodo")
	s.FirestoreDatabaseID = env.get("NODO_FIRESTORE_DATABASE_ID", ExpectedFirestoreDB)
	s.BootstrapOrgID = env.get("NODO_BOOTSTRAP_ORG_ID", ExpectedBootstrapID)
	s.BootstrapOrgName = env.get("NODO_BOOTSTRAP_ORG_NAME", ExpectedBootstrapName)
	if s.BootstrapEnabled, err = boolEnv(env, "NODO_BOOTSTRAP_ENABLED", false); err != nil {
		return s, err
	}
	s.BootstrapOwnerEmails = splitList(env.get("NODO_BOOTSTRAP_ORG_OWNER_EMAILS", ""), true)
	s.StaffEmailDomains = splitList(env.get("NODO_STAFF_EMAIL_DOMAINS", "nodo-company.test"), true)
	if s.StaffInvitationTTL, err = positiveIntEnv(env, "NODO_STAFF_INVITATION_TTL_HOURS", 168); err != nil {
		return s, err
	}
	s.EmailProvider = strings.ToLower(strings.TrimSpace(env.get("NODO_EMAIL_PROVIDER", "disabled")))
	s.EmailFrom = env.get("NODO_EMAIL_FROM", "")
	s.PublicAppURL = strings.TrimRight(env.get("NODO_PUBLIC_APP_URL", ExpectedDevOrigin), "/")
	s.AuthEmulatorHost = env.get("FIREBASE_AUTH_EMULATOR_HOST", ExpectedAuthEmulator)
	s.FirestoreEmulator = env.get("FIRESTORE_EMULATOR_HOST", ExpectedStoreEmulator)
	s.StorageMode = env.get("NODO_STORAGE_MODE", "disabled")
	s.StorageBucket = env.get("NODO_STORAGE_BUCKET", "")
	s.GoogleCloudProject = env.get("GOOGLE_CLOUD_PROJECT", "")
	s.VertexMode = env.get("NODO_VERTEX_AI_MODE", "disabled")
	s.VertexLocation = env.get("NODO_VERTEX_AI_LOCATION", "global")
	s.VertexModel = env.get("NODO_VERTEX_AI_MODEL", "gemini-2.5-flash")
	if s.VertexMaxInputChars, err = positiveIntEnv(env, "NODO_VERTEX_AI_MAX_INPUT_CHARACTERS", 24000); err != nil {
		return s, err
	}
	return s, nil
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, v := range a {
		if !slices.Contains(b, v) {
			return false
		}
	}
	return true
}

func (s Settings) EnsureEmulatorOnly() error {
	switch {
	case s.RuntimeMode != EmulatorRuntimeMode:
		return errors.New("Firebase Emulator access is disabled in this mode")
	case s.AppEnv != "local" && s.AppEnv != "test":
		return errors.New("Firebase access is limited to local/test mode")
	case s.FirebaseProjectID != "demo-nodo":
		return errors.New("Only the demo-nodo Emulator project is allowed")
	case s.AuthEmulatorHost != ExpectedAuthEmulator:
		return errors.New("Authentication Emulator must use the fixed loopback endpoint")
	case s.FirestoreEmulator != ExpectedStoreEmulator:
		return errors.New("Firestore Emulator must use the fixed loopback endpoint")
	}
	return nil
}

func (s Settings) EnsureCloudAuthOnly() error {
	if s.RuntimeMode != CloudAuthRuntimeMode {
		return errors.New("Cloud Authentication is disabled in this mode")
	}
	if s.FirebaseProjectID != ExpectedCloudProject {
		return errors.New("The Cloud Authentication project is not allowed")
	}
	if s.FirestoreDatabaseID != ExpectedFirestoreDB {
		return errors.New("The Cloud Firestore database is not allowed")
	}
	if s.BootstrapOrgID != ExpectedBootstrapID {
		return errors.New("The Bootstrap organization id is not allowed")
	}
	if s.BootstrapOrgName != ExpectedBootstrapName {
		return errors.New("The Bootstrap organization name is not allowed")
	}
	if s.BootstrapEnabled && len(s.BootstrapOwnerEmails) == 0 {
		return errors.New("The Bootstrap organization owner list is required")
	}
	for _, email := range s.BootstrapOwnerEmails {
		if strings.Contains(email, "*") || !strings.Contains(email, "@") {
			return errors.New("The Bootstrap organization owner list is invalid")
		}
	}
	if !sameSet(s.StaffEmailDomains, expectedStaffDomains) {
		return errors.New("The staff email domain configuration is not allowed")
	}
	if s.StaffInvitationTTL < 1 || s.StaffInvitationTTL > 8760 {
		return errors.New("The staff invitation TTL is not allowed")
	}
	if s.EmailProvider != "disabled" && s.EmailProvider != "resend" {
		return errors.New("NODO_EMAIL_PROVIDER must be disabled or resend")
	}
	if !slices.Contains(expectedCORSOrigins, s.PublicAppURL) {
		return errors.New("The public NoDo application URL is not allowed")
	}
	if strings.ContainsAny(s.EmailFrom, "\r\n") {
		return errors.New("The invitation email sender is invalid")
	}
	if len(s.CORSOrigins) == 0 {
		return errors.New("The configured CORS origins are not allowed")
	}
	for _, origin := range s.CORSOrigins {
		if !slices.Contains(expectedCORSOrigins, origin) {
			return errors.New("The configured CORS origins are not allowed")
		}
	}
	if s.AppEnv == "production" && !sameSet(s.CORSOrigins, expectedCORSOrigins) {
		return errors.New("Production CORS origins must use the fixed NoDo origins")
	}
	for _, name := range []string{"FIREBASE_AUTH_EMULATOR_HOST", "FIRESTORE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"} {
		if s.env[name] != "" {
			return errors.New("Firebase Emulator variables are forbidden in cloud-auth")
		}
	}
	if s.env["GOOGLE_APPLICATION_CREDENTIALS"] != "" {
		return errors.New("Service account JSON credentials are forbidden in cloud-auth")
	}
	if s.AppEnv == "production" {
		if err := s.ensureStorageTarget(); err != nil {
			return err
		}
	}
	return nil
}

func (s Settings) ensureStorageTarget() error {
	switch {
	case s.StorageMode != "cloud":
		return errors.New("NoDo private Storage uploads are disabled")
	case s.StorageBucket != ExpectedStorageBucket:
		return errors.New("The configured NoDo Storage bucket is not allowed")
	case s.GoogleCloudProject != ExpectedCloudProject:
		return errors.New("The configured Google Cloud project is not allowed")
	}
	return nil
}

// ValidateStartup is the check the backend runs before it serves requests.
func (s Settings) ValidateStartup() error {
	switch s.RuntimeMode {
	case EmulatorRuntimeMode:
		return s.EnsureEmulatorOnly()
	case CloudAuthRuntimeMode:
		return s.EnsureCloudAuthOnly()
	}
	return errors.New("NODO_RUNTIME_MODE must be emulator or cloud-auth")
}

func (s Settings) EnsureStorageUploads() error {
	if s.RuntimeMode != CloudAuthRuntimeMode {
		return errors.New("NoDo private Storage is disabled outside cloud-auth")
	}
	if err := s.EnsureCloudAuthOnly(); err != nil {
		return err
	}
	return s.ensureStorageTarget()
}

func (s Settings) ensureVertexContract(disabledMessage, endpointMessage string) error {
	switch {
	case s.VertexMode != "vertex":
		return errors.New(disabledMessage)
	case s.VertexLocation != "global":
		return errors.New(endpointMessage)
	case s.VertexModel != "gemini-2.5-flash":
		return errors.New("The configured Gemini model is not allowed")
	case s.VertexMaxInputChars < 1000 || s.VertexMaxInputChars > 100000:
		return errors.New("The configured Gemini input limit is not allowed")
	}
	return nil
}

func (s Settings) EnsureVertexDrafts() error {
	if err := s.EnsureStorageUploads(); err != nil {
		return err
	}
	return s.ensureVertexContract("NoDo Vertex AI drafts are disabled", "NoDo Gemini drafts must use the global endpoint")
}

func (s Settings) EnsureVertexAssistant() error {
	if err := s.EnsureCloudAuthOnly(); err != nil {
		return err
	}
	if s.GoogleCloudProject != ExpectedCloudProject {
		return errors.New("The configured Google Cloud project is not allowed")
	}
	return s.ensureVertexContract("NoDo Vertex AI learner assistant is disabled", "NoDo Gemini learner assistant must use the global endpoint")
}
