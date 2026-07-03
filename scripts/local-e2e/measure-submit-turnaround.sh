#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/common.sh"

ensure_commands
prepare_local_e2e_materials

wait_for_http "$FRONTEND_BASE_URL" 'frontend dev server'
wait_for_http "$BACKEND_BASE_URL/health" 'backend health endpoint'
assert_dev_auth_bridge

export PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-$FRONTEND_BASE_URL}"
export PLAYWRIGHT_BACKEND_BASE_URL="${PLAYWRIGHT_BACKEND_BASE_URL:-$BACKEND_BASE_URL}"
export LOCAL_E2E_ALIAS="${LOCAL_E2E_ALIAS:-Latency Probe}"
export LOCAL_E2E_COUNTRY_CODE="${LOCAL_E2E_COUNTRY_CODE:-JP}"

cd "$ROOT_DIR/frontend"

node --input-type=module <<'EOF'
import { chromium, expect } from "@playwright/test";

const frontendBaseUrl =
  process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";
const backendBaseUrl =
  process.env.PLAYWRIGHT_BACKEND_BASE_URL ?? "http://127.0.0.1:3000";
const alias = process.env.LOCAL_E2E_ALIAS ?? "Latency Probe";
const countryCode = process.env.LOCAL_E2E_COUNTRY_CODE ?? "JP";

const ingestPaths = [
  `${backendBaseUrl}/v1/footprints/ingest`,
  `${backendBaseUrl}/v1/ingestion/decrypt`,
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(frontendBaseUrl, { waitUntil: "networkidle" });

  const walletAddress = await connectWallet(page);
  await savePublicProfile(page, alias, countryCode);
  await mintSbt(page);
  await addPositiveReductionInputs(page);

  const responsePromise = page.waitForResponse((response) => {
    return (
      response.request().method() === "POST" &&
      ingestPaths.some((path) => response.url().startsWith(path))
    );
  });

  const clickStartedAt = performance.now();
  await page.getByRole("button", { name: /submit encrypted footprint/i }).click();

  const ingestResponse = await responsePromise;
  const responseReceivedAt = performance.now();

  if (ingestResponse.status() !== 202) {
    throw new Error(
      `Unexpected ingest status ${ingestResponse.status()} from ${ingestResponse.url()}`,
    );
  }

  const ingestPayload = await ingestResponse.json();

  await expect(page.getByText(/data hash:/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: /refresh job status/i }).first(),
  ).toBeVisible({ timeout: 30_000 });
  const uiUpdatedAt = performance.now();

  const result = {
    walletAddress,
    requestId: String(ingestPayload.requestId ?? ""),
    dataHash: String(ingestPayload.dataHash ?? ""),
    responseStatus: ingestResponse.status(),
    responseUrl: ingestResponse.url(),
    jobCount: Array.isArray(ingestPayload.jobs) ? ingestPayload.jobs.length : 0,
    turnaroundMs: Number((responseReceivedAt - clickStartedAt).toFixed(1)),
    uiSettleMs: Number((uiUpdatedAt - clickStartedAt).toFixed(1)),
    measuredAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));
} finally {
  await page.close();
  await browser.close();
}

async function connectWallet(page) {
  const connectButton = page.getByRole("button", { name: /connect wallet/i });
  if (await connectButton.isEnabled()) {
    await connectButton.click();
  }

  await expect(page.getByRole("button", { name: /wallet connected/i })).toBeVisible();
  const walletText = await page.getByText(/[1-9A-HJ-NP-Za-km-z]{32,44}/).first().textContent();
  if (!walletText) {
    throw new Error("Wallet address was not rendered after connection.");
  }

  return walletText.trim();
}

async function savePublicProfile(page, alias, countryCode) {
  await page.getByLabel(/display alias/i).fill(alias);
  await page.getByLabel(/country code/i).fill(countryCode);

  const saveButton = page.getByRole("button", {
    name: /register public profile|update public profile/i,
  });
  await saveButton.click();
  await expect(page.getByText(new RegExp(`profile:\\s*${escapeRegExp(alias)}`, "i"))).toBeVisible();
}

async function mintSbt(page) {
  const mintedButton = page.getByRole("button", { name: /sbt minted/i });
  if (await mintedButton.count()) {
    await expect(mintedButton).toBeVisible();
    return;
  }

  await page.getByRole("button", { name: /mint user sbt/i }).click();
  await expect(page.getByText(/soulbound token minted/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /sbt minted/i })).toBeVisible();
}

async function addPositiveReductionInputs(page) {
  const valueInput = page.getByLabel(/^value$/i);
  if (await valueInput.count()) {
    await valueInput.fill("300");
  }

  const amountInput = page.getByLabel(/amount/i);
  if (await amountInput.count()) {
    await amountInput.first().fill("15000");
  }

  const addActivityButton = page.getByRole("button", {
    name: /add activity entry|add manual activity/i,
  });
  if (!(await addActivityButton.count())) {
    throw new Error("Could not find the activity-entry add button.");
  }
  await addActivityButton.first().click();

  const baselineInput = page.getByLabel(/past average monthly emissions/i);
  if (await baselineInput.count()) {
    await baselineInput.fill("200");
  }

  await expect.poll(async () => {
    const submitButton = page.getByRole("button", {
      name: /submit encrypted footprint/i,
    });
    return await submitButton.isEnabled();
  }).toBe(true);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}
EOF