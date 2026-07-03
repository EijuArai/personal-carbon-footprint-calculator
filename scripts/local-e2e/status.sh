#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

component_status() {
  local label="$1"
  local pid_file="$2"

  if pid_is_running "$pid_file"; then
    printf '%-10s running (pid=%s)\n' "$label" "$(<"$pid_file")"
  else
    printf '%-10s stopped\n' "$label"
  fi
}

http_status() {
  local label="$1"
  local url="$2"

  if curl --silent --show-error --fail "$url" >/dev/null 2>&1; then
    printf '%-10s ready  %s\n' "$label" "$url"
  else
    printf '%-10s down   %s\n' "$label" "$url"
  fi
}

printf 'Process state\n'
component_status validator "$VALIDATOR_PID_FILE"
component_status backend "$BACKEND_PID_FILE"
component_status worker "$WORKER_PID_FILE"
component_status frontend "$FRONTEND_PID_FILE"

printf '\nReadiness\n'
if curl --silent --show-error --fail \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
  "$SOLANA_RPC_URL" >/dev/null 2>&1; then
  printf '%-10s ready  %s\n' rpc "$SOLANA_RPC_URL"
else
  printf '%-10s down   %s\n' rpc "$SOLANA_RPC_URL"
fi
http_status backend "$BACKEND_BASE_URL/health"
http_status frontend "$FRONTEND_BASE_URL"

if [[ -f "$BACKEND_ENV_FILE" && -f "$FRONTEND_ENV_FILE" ]]; then
  printf '\nEnv files\n'
  printf 'backend    %s\n' "$BACKEND_ENV_FILE"
  printf 'frontend   %s\n' "$FRONTEND_ENV_FILE"
fi