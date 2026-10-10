#!/usr/bin/env bash
set -euo pipefail

# Keep the local API tunnel available when GKE Autopilot replaces the selected pod.
# Bind only to localhost; Android Emulator reaches it through 10.0.2.2.
PORT="${1:-18081}"
CONTEXT="${GKE_CONTEXT:-gke_foodigard_asia-northeast3_foodiguard-cluster}"

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use. Stop the old tunnel before starting this one." >&2
  exit 1
fi

while true; do
  echo "Forwarding localhost:${PORT} to foodiguard-api (Ctrl+C to stop)."
  kubectl --context="${CONTEXT}" -n default port-forward service/foodiguard-api "${PORT}:80" || true
  echo "API tunnel disconnected; reconnecting in 2 seconds..." >&2
  sleep 2
done
