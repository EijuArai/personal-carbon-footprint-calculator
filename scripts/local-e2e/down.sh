#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

stop_managed_processes

printf 'Managed local E2E processes have been stopped.\n'