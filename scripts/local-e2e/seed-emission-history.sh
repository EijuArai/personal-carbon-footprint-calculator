#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

ensure_commands
prepare_local_e2e_materials
wait_for_rpc

export SOLANA_RPC_URL="$SOLANA_RPC_URL"
export GREEN_REPUTATION_PROGRAM_ID="$PROGRAM_ID"
export LOCAL_E2E_USER_KEYPAIR_PATH="$KEY_DIR/user.json"
export LOCAL_E2E_ADMIN_KEYPAIR_PATH="$KEY_DIR/admin.json"
export LOCAL_E2E_MINT_AUTHORITY_KEYPAIR_PATH="$KEY_DIR/mint-authority.json"

(
  cd "$ROOT_DIR/backend"
  npx tsx scripts/local-e2e/seed-emission-history.ts "$@"
)
