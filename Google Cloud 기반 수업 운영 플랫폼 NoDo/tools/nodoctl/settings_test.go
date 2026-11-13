package main

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func productionEnv() Env {
	return Env{
		"APP_ENV":                    "production",
		"NODO_RUNTIME_MODE":          "cloud-auth",
		"NODO_FIREBASE_PROJECT_ID":   ExpectedCloudProject,
		"NODO_CORS_ORIGINS":          strings.Join(expectedCORSOrigins, ","),
		"NODO_PUBLIC_APP_URL":        ExpectedHostingOrigin,
		"NODO_STORAGE_MODE":          "cloud",
		"NODO_STORAGE_BUCKET":        ExpectedStorageBucket,
		"GOOGLE_CLOUD_PROJECT":       ExpectedCloudProject,
		"NODO_VERTEX_AI_MODE":        "vertex",
		"NODO_VERTEX_AI_LOCATION":    "global",
		"NODO_VERTEX_AI_MODEL":       "gemini-2.5-flash",
		"NODO_STAFF_EMAIL_DOMAINS":   "nodo-company.test",
		"NODO_EMAIL_PROVIDER":        "disabled",
		"NODO_BOOTSTRAP_ENABLED":     "false",
		"NODO_FIRESTORE_DATABASE_ID": ExpectedFirestoreDB,
	}
}

func with(base Env, changes map[string]string) Env {
	out := Env{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range changes {
		out[k] = v
	}
	return out
}

func TestCheck(t *testing.T) {
	cases := []struct {
		name string
		env  Env
		want string // empty means every check passes
	}{
		{"emulator defaults", Env{}, ""},
		{"production", productionEnv(), ""},
		{"emulator pointed at cloud project", Env{"NODO_FIREBASE_PROJECT_ID": ExpectedCloudProject}, "Only the demo-nodo Emulator project is allowed"},
		{"emulator on a remote host", Env{"FIRESTORE_EMULATOR_HOST": "10.0.0.5:8081"}, "Firestore Emulator must use the fixed loopback endpoint"},
		{"wrong bucket", with(productionEnv(), map[string]string{"NODO_STORAGE_BUCKET": "other-team-bucket"}), "The configured NoDo Storage bucket is not allowed"},
		{"leftover emulator variable", with(productionEnv(), map[string]string{"FIRESTORE_EMULATOR_HOST": "127.0.0.1:8081"}), "Firebase Emulator variables are forbidden in cloud-auth"},
		{"service account key", with(productionEnv(), map[string]string{"GOOGLE_APPLICATION_CREDENTIALS": "/keys/sa.json"}), "Service account JSON credentials are forbidden in cloud-auth"},
		{"unknown CORS origin", with(productionEnv(), map[string]string{"NODO_CORS_ORIGINS": ExpectedHostingOrigin + ",https://evil.example"}), "The configured CORS origins are not allowed"},
		{"bad runtime mode", Env{"NODO_RUNTIME_MODE": "cloud"}, "NODO_RUNTIME_MODE must be emulator or cloud-auth"},
		{"bad TTL", Env{"NODO_STAFF_INVITATION_TTL_HOURS": "abc"}, "NODO_STAFF_INVITATION_TTL_HOURS must be a positive integer"},
		{"wrong Gemini model", with(productionEnv(), map[string]string{"NODO_VERTEX_AI_MODEL": "gemini-1.0-pro"}), "The configured Gemini model is not allowed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := Check(tc.env)
			if tc.want == "" {
				if !r.OK() {
					t.Fatalf("expected pass, got %+v", r)
				}
				return
			}
			found := r.Load == tc.want
			for _, msg := range r.Checks {
				found = found || msg == tc.want
			}
			if !found {
				t.Fatalf("expected %q, got %+v", tc.want, r)
			}
		})
	}
}

func TestEnvFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	os.WriteFile(path, []byte("# comment\nexport APP_ENV=test\nNODO_STORAGE_BUCKET=\nNODO_EMAIL_FROM=\"NoDo <no-reply@nodo-company.test>\"\n"), 0o600)
	env := Env{}
	if err := LoadEnvFile(path, env); err != nil {
		t.Fatal(err)
	}
	if env["APP_ENV"] != "test" || env["NODO_EMAIL_FROM"] != "NoDo <no-reply@nodo-company.test>" {
		t.Fatalf("unexpected env %v", env)
	}
	if v, ok := env["NODO_STORAGE_BUCKET"]; !ok || v != "" {
		t.Fatal("an empty value must stay present")
	}
}

func TestExitCodes(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"check"}, &out, &errOut); code != 0 {
		t.Fatalf("emulator defaults should pass, got %d: %s", code, out.String())
	}
	if code := run([]string{"check", "--env-file", "missing.env"}, &out, &errOut); code != 2 {
		t.Fatalf("missing file should exit 2, got %d", code)
	}
	if code := run(nil, &out, &errOut); code != 2 {
		t.Fatalf("no command should exit 2, got %d", code)
	}
}

// TestBackendConstantsMatch keeps this tool honest: if someone changes a fixed
// value in the backend and forgets the CLI, this test fails.
func TestBackendConstantsMatch(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "backend", "app", "core", "config.py"))
	if err != nil {
		t.Skip("backend config not found:", err)
	}
	goValues := map[string]string{
		"EXPECTED_CLOUD_FIREBASE_PROJECT_ID":       ExpectedCloudProject,
		"EXPECTED_CLOUD_FIRESTORE_DATABASE_ID":     ExpectedFirestoreDB,
		"EXPECTED_BOOTSTRAP_ORG_ID":                ExpectedBootstrapID,
		"EXPECTED_BOOTSTRAP_ORG_NAME":              ExpectedBootstrapName,
		"EXPECTED_CLOUD_STORAGE_BUCKET":            ExpectedStorageBucket,
		"EXPECTED_NODO_HOSTING_ORIGIN":             ExpectedHostingOrigin,
		"EXPECTED_NODO_HOSTING_FIREBASEAPP_ORIGIN": ExpectedFirebaseApp,
		"EXPECTED_CLOUD_AUTH_DEVELOPMENT_ORIGIN":   ExpectedDevOrigin,
		"EXPECTED_AUTH_EMULATOR_HOST":              ExpectedAuthEmulator,
		"EXPECTED_FIRESTORE_EMULATOR_HOST":         ExpectedStoreEmulator,
	}
	re := regexp.MustCompile(`(?m)^(EXPECTED_[A-Z_]+) = \(?\s*"([^"]*)"`)
	seen := 0
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		want, ok := goValues[m[1]]
		if !ok {
			t.Errorf("backend has %s but nodoctl does not mirror it", m[1])
			continue
		}
		if want != m[2] {
			t.Errorf("%s: backend %q, nodoctl %q", m[1], m[2], want)
		}
		seen++
	}
	if seen != len(goValues) {
		t.Errorf("found %d backend constants, expected %d", seen, len(goValues))
	}
	domains := regexp.MustCompile(`EXPECTED_STAFF_EMAIL_DOMAINS = frozenset\(\{"([^"]+)"\}\)`).FindStringSubmatch(string(src))
	if domains == nil || domains[1] != expectedStaffDomains[0] {
		t.Errorf("staff email domains drifted: %v", domains)
	}
}
