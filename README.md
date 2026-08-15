# Green Reputation

Green Reputation is a three-workspace project for collecting user footprint data,
scoring it privately, and syncing verified reputation state to Solana.

The repository includes:

| Workspace  | Role                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `frontend` | React 19 + Vite app for wallet onboarding, input review, encrypted submission, and dashboard UI              |
| `backend`  | Express + SQLite API for auth, decryption, LCA orchestration, metadata publishing, and Oracle job enqueueing |
| `solana`   | Anchor program for protocol config, user profiles, Token-2022 SBTs, verified footprint state, and rewards    |

## Technology Stack

| Area               | Technologies                                              |
| ------------------ | --------------------------------------------------------- |
| Frontend           | React 19, TypeScript, Vite, Vitest                        |
| Backend            | Node.js, TypeScript, Express, SQLite, Vitest              |
| Solana             | Rust, Anchor, Solana CLI, Token-2022                      |
| Local E2E tooling  | Bash scripts, local Solana validator, generated env files |
| Package management | npm for frontend and backend, yarn for solana             |

## What This Repo Covers

- Solana program logic for registration, SBT minting, verified footprint submission, and reward claiming
- A backend that accepts encrypted footprint submissions, computes aggregate results, publishes metadata, and stores Oracle jobs in SQLite
- A frontend that supports wallet onboarding, OCR-assisted input review, encrypted submission, and a reputation dashboard
- A managed local E2E workflow that starts validator, backend, worker, and frontend together

## Runtime Modes

There are two practical ways to work in this repo.

| Mode                  | Purpose                                                             | How to run                               |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| Workspace development | Develop or test one workspace at a time                             | `npm run dev`, `npm test`, `anchor test` |
| Managed local E2E     | Bring up validator + backend + worker + frontend as one local stack | `bash scripts/local-e2e/up.sh`           |

The frontend supports one browser runtime contract:

- `local-e2e`: the supported frontend runtime, backed by the local validator,
  backend, and generated `.local-e2e/env/*` files

For isolated workspace development you can still run frontend commands such as
`npm run test`, `npm run build`, and focused component work from `frontend/`,
but browser startup now expects the managed local E2E environment.

## Prerequisites

- Ubuntu 24.04, 26.04 (Operation on other operating systems is not guaranteed.)
- Node.js 24+
- npm
- Rust toolchain
- Solana CLI `3.x`
- Anchor CLI `0.32.x`
- yarn

Quick checks:

```bash
node --version
npm --version
solana --version
anchor --version
yarn --version
```

## Initial Setup

Install dependencies in each workspace:

```bash
cd frontend && npm install
cd ../backend && npm install
cd ../solana && yarn install
```

## Quick Validation Path

If you want the fastest confidence check, run the workspace quality gates first.

```bash
cd solana && anchor test
cd ../backend && npm test
cd ../frontend && npm test && npm run build
```

This verifies:

- on-chain instruction and account behavior
- backend unit and integration coverage
- frontend component, domain, and build health

## Running Each Workspace

### Solana

```bash
cd solana
anchor test
```

### Backend

From `backend/`:

```bash
npm run typecheck
npm test
npm run dev
```

> #### NOTE
>
> the configured backend runtime requires Solana signer material.
> For a clean local boot you should usually use the managed local E2E workflow,
> which generates the required env file and keypairs under `.local-e2e/`.

Useful endpoints:

- `GET /health`
- `GET /v1/crypto/public-key`
- `POST /v1/footprints/ingest`
- `POST /v1/ingestion/decrypt`
- `GET /v1/jobs/:jobId`
- `POST /v1/dev/auth/ingest-token` in local E2E mode only

### Frontend

From `frontend/`:

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm run quality
```

Frontend startup expects `VITE_FRONTEND_RUNTIME_MODE=local-e2e` plus the
generated local signer inputs written by `scripts/local-e2e/up.sh`.

For a working browser session, prefer the managed local E2E workflow instead of
starting Vite against ad hoc local environment values.

## Managed Local E2E Workflow

Use the scripts in `scripts/local-e2e` from the repository root:

```bash
bash scripts/local-e2e/up.sh
bash scripts/local-e2e/status.sh
bash scripts/local-e2e/down.sh
```

> #### NOTE
>
> All hardcoded program IDs in the current project are placeholders. To execute the local E2E workflow, replace all program IDs using the following steps.
>
> 1. Update Solana deploy key
>
> ```bash
> cd solana
> anchor keys sync
> ```
>
> 2. Replace all placeholders with new program ID.
>    Open `solana/Anchor.toml` and copy the program ID for the `green_reputation` field. Next, use your IDE's replace feature to replace all placeholders (`CYTYoWKNxj4xP1vUPef2HuRb8x8kgrnzpQXMi665Q6ve`) with that program ID.
> 3. Build Solana program
>
> ```bash
> anchor build
> ```

`up.sh` performs the full local bootstrap:

1. resets the local validator
2. creates or reuses managed keypairs
3. funds local signers
4. deploys the Anchor program
5. bootstraps protocol state
6. starts the backend
7. starts the worker
8. starts the frontend
9. runs readiness checks

Fixed local endpoints:

- frontend: `http://127.0.0.1:4173`
- backend: `http://127.0.0.1:3000`
- Solana RPC: `http://127.0.0.1:8899`
- Solana WS: `ws://127.0.0.1:8900`

Generated local state lives under `.local-e2e/`, including:

- `.local-e2e/keys/`
- `.local-e2e/env/`
- `.local-e2e/logs/`
- `.local-e2e/backend/green-reputation.sqlite`

## Seed Mock Data

To calculate rewards, at least 30 days of input data are required.
The following shell script inputs simulated daily CO2 emission data into Solana's on-chain.
This shell script uses data from the National Institute for Environmental Studies, inputting an average daily CO2 emission of 25 kg per Japanese person.

```bash
bash scripts/local-e2e/seed-emission-history.sh
```

To measure E2E performance run the following shell.

```bash
bash scripts/local-e2e/measure-submit-turnaround.sh
```

## Current Architecture Summary

- The frontend collects wallet state, reviewed footprint input, and verified submission results
- The backend verifies auth, decrypts the payload, computes aggregate LCA results, publishes metadata, and enqueues Oracle jobs
- The worker drains queued jobs and submits on-chain updates using configured Solana signers
- The Solana program stores protocol config, user profile state, SBT metadata state, commitments, and rewards

## Dev-Only Safety Notes

- `LOCAL_E2E_MODE=true` and `LOCAL_E2E_DEV_AUTH_ENABLED=true` are for local development only
- `.local-e2e/env/frontend.local-e2e.env` injects signer material into the browser for local testing
- `GET /v1/jobs/:jobId` is an internal observability surface, not a hardened public contract
- Never use the default `SIWS_JWT_SECRET` outside local development

## Recommended Documents

- `docs/complete-e2e-runbook.md` For detailed procedure to run e2e mode.
- `docs/emission-history-seeding-runbook.md` For how to seed past 30 days emission history to Solana on testing purpose.
