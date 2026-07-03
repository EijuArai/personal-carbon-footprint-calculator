#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

ensure_commands
prepare_local_e2e_materials
stop_managed_processes
reset_runtime_dirs
prepare_local_e2e_materials

printf 'Starting local Solana validator\n'
solana-test-validator \
  --reset \
  --ledger "$LEDGER_DIR" \
  --rpc-port "$SOLANA_RPC_PORT" \
  > "$LOG_DIR/validator.log" 2>&1 &
echo $! > "$VALIDATOR_PID_FILE"

wait_for_rpc

printf 'Funding local signer fixtures\n'
airdrop_keypair "$KEY_DIR/admin.json"
airdrop_keypair "$KEY_DIR/verifier.json"
airdrop_keypair "$KEY_DIR/metadata-authority.json"
airdrop_keypair "$KEY_DIR/mint-authority.json"
airdrop_keypair "$KEY_DIR/user.json"

deploy_program
bootstrap_protocol

start_backend
wait_for_http "$BACKEND_BASE_URL/health" 'backend health endpoint'
wait_for_http "$BACKEND_BASE_URL/v1/crypto/public-key" 'backend public key endpoint'
assert_dev_auth_bridge

start_worker
wait_for_worker_startup

start_frontend
wait_for_http "$FRONTEND_BASE_URL" 'frontend dev server'

print_access_summary