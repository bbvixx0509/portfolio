// Command nodoctl checks a NoDo backend configuration before it is deployed.
// It reads settings only; it never connects to Firebase or Google Cloud.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

const version = "0.1.0"

const usage = `nodoctl checks NoDo backend settings before deployment.

Usage:
  nodoctl check [--env-file PATH] [--with-process-env] [--json]
  nodoctl version
`

// Report lists the outcome of every check. An empty string means the check passed.
type Report struct {
	Load    string            `json:"load,omitempty"`
	Checks  map[string]string `json:"checks"`
	Skipped []string          `json:"skipped,omitempty"`
}

func (r Report) OK() bool {
	if r.Load != "" {
		return false
	}
	for _, msg := range r.Checks {
		if msg != "" {
			return false
		}
	}
	return true
}

// Check runs the startup check, then the Storage and Vertex AI checks when
// those features are switched on, in the same order the backend reaches them.
func Check(env Env) Report {
	r := Report{Checks: map[string]string{}}
	s, err := LoadSettings(env)
	if err != nil {
		r.Load = err.Error()
		return r
	}
	record := func(name string, err error) {
		r.Checks[name] = ""
		if err != nil {
			r.Checks[name] = err.Error()
		}
	}
	record("startup", s.ValidateStartup())
	if s.StorageMode == "cloud" {
		record("storage_uploads", s.EnsureStorageUploads())
	} else {
		r.Skipped = append(r.Skipped, "storage_uploads")
	}
	if s.VertexMode == "vertex" {
		record("vertex_drafts", s.EnsureVertexDrafts())
		record("vertex_assistant", s.EnsureVertexAssistant())
	} else {
		r.Skipped = append(r.Skipped, "vertex_drafts", "vertex_assistant")
	}
	return r
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "version":
		fmt.Fprintln(stdout, "nodoctl", version)
		return 0
	case "check":
		fs := flag.NewFlagSet("check", flag.ContinueOnError)
		fs.SetOutput(stderr)
		envFile := fs.String("env-file", "", "read settings from this KEY=VALUE file")
		withProcess := fs.Bool("with-process-env", false, "start from the current environment before reading --env-file")
		asJSON := fs.Bool("json", false, "print the report as JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return 2
		}
		env := Env{}
		if *withProcess {
			env = ProcessEnv()
		}
		if *envFile != "" {
			if err := LoadEnvFile(*envFile, env); err != nil {
				fmt.Fprintln(stderr, "nodoctl:", err)
				return 2
			}
		}
		report := Check(env)
		if *asJSON {
			enc := json.NewEncoder(stdout)
			enc.SetIndent("", "  ")
			enc.Encode(report)
		} else {
			printReport(stdout, report)
		}
		if report.OK() {
			return 0
		}
		return 1
	}
	fmt.Fprint(stderr, usage)
	return 2
}

func printReport(w io.Writer, r Report) {
	if r.Load != "" {
		fmt.Fprintf(w, "FAIL  settings: %s\n", r.Load)
		return
	}
	for _, name := range []string{"startup", "storage_uploads", "vertex_drafts", "vertex_assistant"} {
		msg, ran := r.Checks[name]
		switch {
		case !ran:
			fmt.Fprintf(w, "SKIP  %s (feature disabled)\n", name)
		case msg == "":
			fmt.Fprintf(w, "PASS  %s\n", name)
		default:
			fmt.Fprintf(w, "FAIL  %s: %s\n", name, msg)
		}
	}
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}
