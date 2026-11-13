package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// Env holds environment variables the way the backend sees them: a key that is
// present with an empty value is different from a missing key.
type Env map[string]string

func (e Env) lookup(name string) (string, bool) {
	v, ok := e[name]
	return v, ok
}

func (e Env) get(name, fallback string) string {
	if v, ok := e[name]; ok {
		return v
	}
	return fallback
}

// ProcessEnv returns the current process environment.
func ProcessEnv() Env {
	env := Env{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	return env
}

// LoadEnvFile reads KEY=VALUE lines. Blank lines and # comments are skipped,
// an optional "export " prefix is allowed, and matching quotes are removed.
func LoadEnvFile(path string, into Env) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	line := 0
	for scanner.Scan() {
		line++
		text := strings.TrimSpace(scanner.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		text = strings.TrimPrefix(text, "export ")
		key, value, ok := strings.Cut(text, "=")
		if !ok {
			return fmt.Errorf("%s:%d: expected KEY=VALUE", path, line)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		into[key] = value
	}
	return scanner.Err()
}
