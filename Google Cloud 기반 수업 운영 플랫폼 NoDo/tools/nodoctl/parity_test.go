package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// TestParityWithBackend runs the real backend check (backend/app/core/config.py)
// and nodoctl on the same settings, and expects the same verdict and message
// for every check. It is skipped when python3 3.9+ is not available.
func TestParityWithBackend(t *testing.T) {
	config := filepath.Join("..", "..", "backend", "app", "core", "config.py")
	if _, err := os.Stat(config); err != nil {
		t.Skip("backend config not found:", err)
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not found")
	}
	if out, err := exec.Command(python, "-c", "import sys; print(sys.version_info >= (3, 9))").Output(); err != nil || strings.TrimSpace(string(out)) != "True" {
		t.Skip("python3 3.9 or newer is required")
	}

	example := Env{}
	if err := LoadEnvFile(filepath.Join("..", "..", ".env.example"), example); err != nil {
		t.Fatal(err)
	}
	prod := productionEnv()
	cases := []struct {
		name string
		env  Env
	}{
		{"repository .env.example", example},
		{"defaults", Env{}},
		{"production", prod},
		{"public URL with trailing slash", with(prod, map[string]string{"NODO_PUBLIC_APP_URL": ExpectedHostingOrigin + "/"})},
		{"TTL written with underscore", with(prod, map[string]string{"NODO_STAFF_INVITATION_TTL_HOURS": "1_000"})},
		{"emulator with cloud project", Env{"NODO_FIREBASE_PROJECT_ID": ExpectedCloudProject}},
		{"emulator on a remote host", Env{"FIRESTORE_EMULATOR_HOST": "10.0.0.5:8081"}},
		{"emulator with APP_ENV=production", Env{"APP_ENV": "production"}},
		{"other team bucket", with(prod, map[string]string{"NODO_STORAGE_BUCKET": "other-team-bucket"})},
		{"other GCP project", with(prod, map[string]string{"GOOGLE_CLOUD_PROJECT": "other-project"})},
		{"leftover emulator variable", with(prod, map[string]string{"FIRESTORE_EMULATOR_HOST": "127.0.0.1:8081"})},
		{"service account key", with(prod, map[string]string{"GOOGLE_APPLICATION_CREDENTIALS": "/keys/sa.json"})},
		{"unknown CORS origin", with(prod, map[string]string{"NODO_CORS_ORIGINS": ExpectedHostingOrigin + ",https://evil.example"})},
		{"empty CORS origins", with(prod, map[string]string{"NODO_CORS_ORIGINS": ""})},
		{"partial CORS origins in production", with(prod, map[string]string{"NODO_CORS_ORIGINS": ExpectedHostingOrigin})},
		{"storage disabled in production", with(prod, map[string]string{"NODO_STORAGE_MODE": "disabled"})},
		{"other Gemini model", with(prod, map[string]string{"NODO_VERTEX_AI_MODEL": "gemini-1.0-pro"})},
		{"Gemini input limit too large", with(prod, map[string]string{"NODO_VERTEX_AI_MAX_INPUT_CHARACTERS": "200000"})},
		{"extra staff email domain", with(prod, map[string]string{"NODO_STAFF_EMAIL_DOMAINS": "nodo-company.test,gmail.com"})},
		{"bootstrap without owners", with(prod, map[string]string{"NODO_BOOTSTRAP_ENABLED": "true"})},
		{"bootstrap flag with spaces and capitals", with(prod, map[string]string{"NODO_BOOTSTRAP_ENABLED": " TRUE ", "NODO_BOOTSTRAP_ORG_OWNER_EMAILS": "Admin@nodo-company.test"})},
		{"runtime mode typo", Env{"NODO_RUNTIME_MODE": "cloud"}},
		{"TTL is not a number", Env{"NODO_STAFF_INVITATION_TTL_HOURS": "abc"}},
		{"bootstrap flag is yes", Env{"NODO_BOOTSTRAP_ENABLED": "yes"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd := exec.Command(python, "-I", filepath.Join("testdata", "backend_check.py"), config)
			cmd.Env = []string{"PATH=" + os.Getenv("PATH")}
			for k, v := range tc.env {
				cmd.Env = append(cmd.Env, k+"="+v)
			}
			out, err := cmd.Output()
			if err != nil {
				t.Fatalf("backend check did not run: %v", err)
			}
			var backend Report
			if err := json.Unmarshal(out, &backend); err != nil {
				t.Fatalf("backend output %q: %v", out, err)
			}
			if got, want := normalize(Check(tc.env)), normalize(backend); !reflect.DeepEqual(got, want) {
				t.Errorf("nodoctl %+v, backend %+v", got, want)
			}
		})
	}
}

func normalize(r Report) Report {
	r.Skipped = slices.Clone(r.Skipped)
	slices.Sort(r.Skipped)
	if len(r.Skipped) == 0 {
		r.Skipped = nil
	}
	if r.Checks == nil {
		r.Checks = map[string]string{}
	}
	return r
}
