#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
STATE_DIR="$ROOT_DIR/.local-e2e"
KEY_DIR="$STATE_DIR/keys"
ENV_DIR="$STATE_DIR/env"
RUN_DIR="$STATE_DIR/run"
LOG_DIR="$STATE_DIR/logs"
LEDGER_DIR="$STATE_DIR/validator-ledger"
BACKEND_STATE_DIR="$STATE_DIR/backend"

SOLANA_RPC_HOST="127.0.0.1"
SOLANA_RPC_PORT="8899"
SOLANA_WS_PORT="8900"
SOLANA_RPC_URL="http://${SOLANA_RPC_HOST}:${SOLANA_RPC_PORT}"
SOLANA_WS_URL="ws://${SOLANA_RPC_HOST}:${SOLANA_WS_PORT}"
BACKEND_HOST="127.0.0.1"
BACKEND_PORT="3000"
BACKEND_BASE_URL="http://${BACKEND_HOST}:${BACKEND_PORT}"
FRONTEND_HOST="127.0.0.1"
FRONTEND_PORT="4173"
FRONTEND_BASE_URL="http://${FRONTEND_HOST}:${FRONTEND_PORT}"
PROGRAM_ID="CYTYoWKNxj4xP1vUPef2HuRb8x8kgrnzpQXMi665Q6ve"

VALIDATOR_PID_FILE="$RUN_DIR/validator.pid"
BACKEND_PID_FILE="$RUN_DIR/backend.pid"
WORKER_PID_FILE="$RUN_DIR/worker.pid"
FRONTEND_PID_FILE="$RUN_DIR/frontend.pid"

BACKEND_ENV_FILE="$ENV_DIR/backend.local-e2e.env"
FRONTEND_ENV_FILE="$ENV_DIR/frontend.local-e2e.env"

ensure_commands() {
  local missing=0
  local command_name

  for command_name in node npm yarn anchor solana solana-test-validator solana-keygen curl; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      printf 'Missing required command: %s\n' "$command_name" >&2
      missing=1
    fi
  done

  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi
}

ensure_state_dirs() {
  mkdir -p "$KEY_DIR" "$ENV_DIR" "$RUN_DIR" "$LOG_DIR" "$LEDGER_DIR" "$BACKEND_STATE_DIR"
}

reset_runtime_dirs() {
  rm -rf "$RUN_DIR" "$LOG_DIR" "$LEDGER_DIR" "$BACKEND_STATE_DIR"
  mkdir -p "$RUN_DIR" "$LOG_DIR" "$LEDGER_DIR" "$BACKEND_STATE_DIR"
}

pid_is_running() {
  local pid_file="$1"

  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi

  local pid
  pid=$(<"$pid_file")
  kill -0 "$pid" >/dev/null 2>&1
}

stop_process() {
  local label="$1"
  local pid_file="$2"

  if ! pid_is_running "$pid_file"; then
    rm -f "$pid_file"
    return 0
  fi

  local pid
  pid=$(<"$pid_file")
  printf 'Stopping %s (pid=%s)\n' "$label" "$pid"
  kill "$pid" >/dev/null 2>&1 || true

  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$pid_file"
      return 0
    fi

    sleep 1
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$pid_file"
}

stop_managed_processes() {
  stop_process "frontend" "$FRONTEND_PID_FILE"
  stop_process "worker" "$WORKER_PID_FILE"
  stop_process "backend" "$BACKEND_PID_FILE"
  stop_process "validator" "$VALIDATOR_PID_FILE"
}

free_port_if_needed() {
  local port="$1"
  local label="$2"

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  local pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN -n -P 2>/dev/null || true)

  if [[ -z "$pids" ]]; then
    return 0
  fi

  printf 'Freeing %s port %s (pid=%s)\n' "$label" "$port" "$pids"
  kill $pids >/dev/null 2>&1 || true
  sleep 1

  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN -n -P 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    kill -9 $pids >/dev/null 2>&1 || true
  fi
}

generate_keypair_if_missing() {
  local output_path="$1"

  if [[ -f "$output_path" ]]; then
    return 0
  fi

  solana-keygen new --no-bip39-passphrase --force --silent --outfile "$output_path" >/dev/null
}

keypair_json_single_line() {
  local input_path="$1"
  tr -d '\n' < "$input_path"
}

keypair_pubkey() {
  local input_path="$1"
  solana-keygen pubkey "$input_path"
}

prepare_local_e2e_materials() {
  ensure_state_dirs

  generate_keypair_if_missing "$KEY_DIR/admin.json"
  generate_keypair_if_missing "$KEY_DIR/verifier.json"
  generate_keypair_if_missing "$KEY_DIR/metadata-authority.json"
  generate_keypair_if_missing "$KEY_DIR/mint-authority.json"
  generate_keypair_if_missing "$KEY_DIR/user.json"

  write_backend_env_file
  write_frontend_env_file
}

write_backend_env_file() {
  local sqlite_path="$BACKEND_STATE_DIR/green-reputation.sqlite"

  cat > "$BACKEND_ENV_FILE" <<EOF
NODE_ENV=development
HOST=${BACKEND_HOST}
PORT=${BACKEND_PORT}
BACKEND_PUBLIC_BASE_URL=${BACKEND_BASE_URL}
SQLITE_PATH=${sqlite_path}
SIWS_JWT_ISSUER=green-reputation.local
SIWS_JWT_AUDIENCE=green-reputation.web
SIWS_JWT_SECRET=dev-siws-secret-not-for-production
SOLANA_RPC_URL=${SOLANA_RPC_URL}
GREEN_REPUTATION_PROGRAM_ID=${PROGRAM_ID}
METADATA_BASE_URI=https://metadata.green-reputation.local
LOCAL_E2E_MODE=true
LOCAL_E2E_DEV_AUTH_ENABLED=true
LOCAL_E2E_DEV_AUTH_TOKEN_TTL_SECONDS=900
LOCAL_E2E_WORKER_POLL_INTERVAL_MS=250
LOCAL_E2E_WORKER_MAX_JOBS_PER_TICK=25
SOLANA_VERIFIER_SECRET_KEY_JSON='$(keypair_json_single_line "$KEY_DIR/verifier.json")'
SOLANA_METADATA_AUTHORITY_SECRET_KEY_JSON='$(keypair_json_single_line "$KEY_DIR/metadata-authority.json")'
SOLANA_ADMIN_SECRET_KEY_JSON='$(keypair_json_single_line "$KEY_DIR/admin.json")'
EOF
}

write_frontend_env_file() {
  cat > "$FRONTEND_ENV_FILE" <<EOF
VITE_FRONTEND_RUNTIME_MODE=local-e2e
VITE_BACKEND_BASE_URL=${BACKEND_BASE_URL}
VITE_SOLANA_RPC_URL=${SOLANA_RPC_URL}
VITE_SOLANA_WS_URL=${SOLANA_WS_URL}
VITE_GREEN_REPUTATION_PROGRAM_ID=${PROGRAM_ID}
VITE_LOCAL_E2E_USER_SECRET_KEY_JSON='$(keypair_json_single_line "$KEY_DIR/user.json")'
VITE_LOCAL_E2E_MINT_AUTHORITY_SECRET_KEY_JSON='$(keypair_json_single_line "$KEY_DIR/mint-authority.json")'
EOF
}

wait_for_rpc() {
  local attempt

  for attempt in $(seq 1 60); do
    if curl --silent --show-error --fail \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
      "$SOLANA_RPC_URL" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  printf 'Timed out waiting for Solana RPC at %s\n' "$SOLANA_RPC_URL" >&2
  return 1
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempt

  for attempt in $(seq 1 60); do
    if curl --silent --show-error --fail "$url" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  printf 'Timed out waiting for %s at %s\n' "$label" "$url" >&2
  return 1
}

wait_for_worker_startup() {
  local log_file="$LOG_DIR/worker.log"
  local attempt

  for attempt in $(seq 1 30); do
    if [[ -f "$log_file" ]] && grep -q 'green-reputation-worker started' "$log_file"; then
      return 0
    fi

    if ! pid_is_running "$WORKER_PID_FILE"; then
      printf 'Worker exited before readiness.\n' >&2
      return 1
    fi

    sleep 1
  done

  printf 'Timed out waiting for worker startup log line.\n' >&2
  return 1
}

assert_dev_auth_bridge() {
  (
    cd "$ROOT_DIR/frontend"
    BACKEND_BASE_URL="$BACKEND_BASE_URL" \
    LOCAL_E2E_USER_KEYPAIR_PATH="$KEY_DIR/user.json" \
    node --input-type=module <<'EOF' >/dev/null
import { readFileSync } from "node:fs";

import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";

const backendBaseUrl = process.env.BACKEND_BASE_URL;
const keypairPath = process.env.LOCAL_E2E_USER_KEYPAIR_PATH;

if (!backendBaseUrl || !keypairPath) {
  throw new Error("BACKEND_BASE_URL and LOCAL_E2E_USER_KEYPAIR_PATH are required.");
}

const signer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))),
);
const walletAddress = signer.publicKey.toBase58();

const challengeResponse = await fetch(`${backendBaseUrl}/v1/siws/challenge`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ walletAddress }),
});

if (!challengeResponse.ok) {
  throw new Error(`Challenge request failed with status ${challengeResponse.status}.`);
}

const challenge = await challengeResponse.json();
if (!challenge?.challengeId || !challenge?.message) {
  throw new Error("Challenge response is missing challenge data.");
}

const signature = Buffer.from(
  nacl.sign.detached(
    Uint8Array.from(new TextEncoder().encode(challenge.message)),
    Uint8Array.from(signer.secretKey),
  ),
).toString("base64");

const verifyResponse = await fetch(`${backendBaseUrl}/v1/siws/verify`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    challengeId: challenge.challengeId,
    walletAddress,
    signature,
  }),
});

if (!verifyResponse.ok) {
  throw new Error(`Verify request failed with status ${verifyResponse.status}.`);
}

const verified = await verifyResponse.json();
if (!verified?.token) {
  throw new Error("Verify response is missing a token.");
}
EOF
  )
}

airdrop_keypair() {
  local keypair_path="$1"
  local pubkey
  pubkey=$(keypair_pubkey "$keypair_path")
  solana --url "$SOLANA_RPC_URL" airdrop 10 "$pubkey" >/dev/null
}

deploy_program() {
  printf 'Deploying Solana program to local validator\n'
  (
    cd "$ROOT_DIR/solana"
    export ANCHOR_PROVIDER_URL="$SOLANA_RPC_URL"
    export ANCHOR_WALLET="$KEY_DIR/admin.json"
    anchor build > "$LOG_DIR/anchor-build.log" 2>&1
    anchor deploy --provider.cluster localnet --provider.wallet "$KEY_DIR/admin.json" > "$LOG_DIR/anchor-deploy.log" 2>&1
  )

  solana --url "$SOLANA_RPC_URL" program show "$PROGRAM_ID" > "$LOG_DIR/program-show.log"
}

bootstrap_protocol() {
  printf 'Bootstrapping protocol config and treasury\n'
  (
    cd "$ROOT_DIR/solana"
    export ANCHOR_PROVIDER_URL="$SOLANA_RPC_URL"
    export ANCHOR_WALLET="$KEY_DIR/admin.json"
    export LOCAL_E2E_ADMIN_KEYPAIR_PATH="$KEY_DIR/admin.json"
    export LOCAL_E2E_VERIFIER_KEYPAIR_PATH="$KEY_DIR/verifier.json"
    export LOCAL_E2E_METADATA_AUTHORITY_KEYPAIR_PATH="$KEY_DIR/metadata-authority.json"
    export LOCAL_E2E_MINT_AUTHORITY_KEYPAIR_PATH="$KEY_DIR/mint-authority.json"
    export GREEN_REPUTATION_PROGRAM_ID="$PROGRAM_ID"
    export SOLANA_RPC_URL="$SOLANA_RPC_URL"
    node app/bootstrap-local-e2e.mjs > "$LOG_DIR/bootstrap.log" 2>&1
  )
}

start_backend() {
  printf 'Starting backend API\n'
  free_port_if_needed "$BACKEND_PORT" "backend"
  (
    cd "$ROOT_DIR/backend"
    set -a
    . "$BACKEND_ENV_FILE"
    set +a
    npm run dev > "$LOG_DIR/backend.log" 2>&1 &
    echo $! > "$BACKEND_PID_FILE"
  )
}

start_worker() {
  printf 'Starting backend worker\n'
  (
    cd "$ROOT_DIR/backend"
    set -a
    . "$BACKEND_ENV_FILE"
    set +a
    npm run dev:worker > "$LOG_DIR/worker.log" 2>&1 &
    echo $! > "$WORKER_PID_FILE"
  )
}

start_frontend() {
  printf 'Starting frontend Vite dev server\n'
  free_port_if_needed "$FRONTEND_PORT" "frontend"
  (
    cd "$ROOT_DIR/frontend"
    set -a
    . "$FRONTEND_ENV_FILE"
    set +a
    npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT" --strictPort > "$LOG_DIR/frontend.log" 2>&1 &
    echo $! > "$FRONTEND_PID_FILE"
  )
}

print_access_summary() {
  cat <<EOF
Local E2E stack is ready.

Frontend: ${FRONTEND_BASE_URL}
Backend:  ${BACKEND_BASE_URL}
RPC:      ${SOLANA_RPC_URL}
WS:       ${SOLANA_WS_URL}

Env files:
  ${BACKEND_ENV_FILE}
  ${FRONTEND_ENV_FILE}

Logs:
  ${LOG_DIR}/validator.log
  ${LOG_DIR}/anchor-build.log
  ${LOG_DIR}/anchor-deploy.log
  ${LOG_DIR}/bootstrap.log
  ${LOG_DIR}/backend.log
  ${LOG_DIR}/worker.log
  ${LOG_DIR}/frontend.log
EOF
}
