# Emission History Seeding Runbook

## Scope

This runbook explains how to seed a local E2E user with 30 days of on-chain
emission history so reward calculations that depend on a trailing 30-day
baseline can be tested reliably.

It covers:

- prerequisites
- default workflow
- command examples
- available options
- important local-only caveats

## What The Seeder Does

The repository includes a local-only helper entrypoint:

```bash
bash scripts/local-e2e/seed-emission-history.sh
```

That script uses the managed local E2E signer fixtures and performs the
following actions:

1. reuses the local E2E user keypair under `.local-e2e/keys/user.json`
2. registers the user profile if it does not exist yet
3. mints the user SBT if it has not been minted yet
4. builds 30 daily emission-history entries ending on the current local day
5. uses an admin-authorized local seeding instruction to write those entries to
   the on-chain `user_profile`

This means the script prepares historical emissions deterministically without
depending on validator time warping.

## Prerequisites

Before running the seeder:

1. Start the managed local E2E stack.
2. Confirm the local validator is the active RPC target for this workflow.
3. Keep the stack running while the seeding process executes.

Repository root commands:

```bash
bash scripts/local-e2e/up.sh
bash scripts/local-e2e/status.sh
```

The seeder expects the managed materials created by `up.sh`, especially:

- `.local-e2e/keys/user.json`
- `.local-e2e/keys/verifier.json`
- `.local-e2e/keys/mint-authority.json`

## Default Usage

Run the command from the repository root:

```bash
bash scripts/local-e2e/seed-emission-history.sh
```

Default behavior:

- seeds `30` days
- uses `25000` grams of emissions per day
- registers the user with alias `local-e2e-user`
- uses country code `JP`

At the end of the run, the script prints the final number of history entries and
the trailing 30-day total in kilograms.

## Common Examples

Seed the default 30-day history:

```bash
bash scripts/local-e2e/seed-emission-history.sh
```

Seed the same 30-day window with a different daily emission amount:

```bash
bash scripts/local-e2e/seed-emission-history.sh --daily-emission-grams 30000
```

Use a custom display alias during auto-registration:

```bash
bash scripts/local-e2e/seed-emission-history.sh --display-alias reward-test-user
```

Seed fewer than 30 days when you only want partial history:

```bash
bash scripts/local-e2e/seed-emission-history.sh --days 10
```

## Available Options

The seeder accepts these flags:

| Flag                       | Purpose                                                        | Default                               |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------- |
| `--days`                   | Number of historical days to seed. Maximum is 30.              | `30`                                  |
| `--daily-emission-grams`   | Emissions added per seeded day.                                | `25000`                               |
| `--display-alias`          | Public profile alias used if the user must be registered.      | `local-e2e-user`                      |
| `--country-code`           | Public profile country code used if registration is needed.    | `JP`                                  |
| `--avatar-uri`             | Public profile avatar URI used if registration is needed.      | empty                                 |
| `--rpc-url`                | Override the Solana RPC URL.                                   | local E2E RPC                         |
| `--program-id`             | Override the Green Reputation program id.                      | managed local program id              |
| `--user-keypair`           | Override the seeded user keypair path.                         | `.local-e2e/keys/user.json`           |
| `--admin-keypair`          | Override the admin keypair path used for the seed instruction. | `.local-e2e/keys/admin.json`          |
| `--mint-authority-keypair` | Override the mint authority keypair path.                      | `.local-e2e/keys/mint-authority.json` |

In normal repository usage, you usually do not need to pass the keypair or RPC
flags because `scripts/local-e2e/seed-emission-history.sh` exports the managed
local E2E values automatically.

## Important Caveats

- This workflow is for local development only.
- The script assumes `solana-test-validator`, not a shared or production RPC.
- The script now depends on an admin-authorized local seeding instruction in
  the program.
- If the user already has emission history, the script appends into the existing
  workflow by overwriting the stored rolling window for that user profile.
- If you need a perfectly controlled 30-day baseline, start from a fresh local
  E2E stack first.

## Troubleshooting

### Seeder Fails Before Submission

Check whether the local stack is up:

```bash
bash scripts/local-e2e/status.sh
```

Then inspect:

- `.local-e2e/logs/validator.log`
- `.local-e2e/logs/backend.log`
- `.local-e2e/logs/worker.log`

### Seeder Overwrites Existing History

That is expected. The seeder now writes a deterministic rolling window directly
to the user profile.

If the local state was already partially seeded and you want a clean baseline,
restart from a fresh stack:

```bash
bash scripts/local-e2e/down.sh
bash scripts/local-e2e/up.sh
bash scripts/local-e2e/seed-emission-history.sh
```

### Seeder Uses An Existing User Profile

That is expected behavior. The script only auto-registers and auto-mints when
the managed local E2E user does not already have those accounts.

If you want a clean baseline, rebuild the local E2E stack and seed again from
scratch.
