import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabaseHandle,
  createStateStore,
  getPragmaJournalMode,
  listTableColumns,
} from "../../src/db/index.js";

const handles: Array<ReturnType<typeof createDatabaseHandle>> = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.connection.close();
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), "green-reputation-backend-"));
  tempDirs.push(dir);

  const handle = createDatabaseHandle({ filename: join(dir, "state.db") });
  handles.push(handle);

  return {
    handle,
    store: createStateStore(handle),
  };
}

describe("SQLite state store", () => {
  it("enables WAL mode and does not expose raw payload columns", () => {
    const { handle } = createStore();

    expect(getPragmaJournalMode(handle).toLowerCase()).toBe("wal");

    const jobColumns = listTableColumns(handle, "oracle_jobs");
    const nonceColumns = listTableColumns(handle, "used_nonces");

    expect(jobColumns).not.toContain("raw_payload");
    expect(jobColumns).not.toContain("encrypted_payload");
    expect(nonceColumns).not.toContain("request_body");
  });

  it("reserves nonces uniquely and stores expiry metadata", () => {
    const { store } = createStore();

    const reserved = store.reserveNonce({
      nonce: "nonce-1",
      issuer: "issuer",
      audience: "audience",
      subject: "user-1",
      expiresAtMs: 1_000,
      reservedAtMs: 100,
    });

    expect(reserved.nonce).toBe("nonce-1");
    expect(store.findNonce("nonce-1")?.expiresAtMs).toBe(1_000);

    expect(() =>
      store.reserveNonce({
        nonce: "nonce-1",
        issuer: "issuer",
        audience: "audience",
        subject: "user-1",
        expiresAtMs: 2_000,
        reservedAtMs: 200,
      }),
    ).toThrow();
  });

  it("enqueues jobs idempotently and claims due work with a lock", () => {
    const { store } = createStore();

    const job = store.enqueueOracleJob({
      kind: "submit_verified_footprint",
      idempotencyKey: "user-a:202604:hash-1",
      userPubkey: "user-a",
      userProfilePubkey: "profile-a",
      periodKey: 202604,
      commitmentHash: "hash-1",
      sourceKind: "hybrid",
      emissionDeltaGrams: 12_500,
      reductionDeltaGrams: 2_000,
      rewardDeltaLamports: 20_000,
      runAfterMs: 100,
      createdAtMs: 100,
    });

    expect(job.status).toBe("pending");

    expect(() =>
      store.enqueueOracleJob({
        kind: "submit_verified_footprint",
        idempotencyKey: "user-a:202604:hash-1",
        runAfterMs: 101,
        createdAtMs: 101,
      }),
    ).toThrow();

    const claimed = store.claimPendingJob("worker-1", 100, 500);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.lockKey).toBe(`oracle_job:${job.id}`);

    const secondClaim = store.claimPendingJob("worker-2", 100, 500);
    expect(secondClaim).toBeUndefined();
  });

  it("records retryable and completed job state transitions with attempts", () => {
    const { store } = createStore();

    const job = store.enqueueOracleJob({
      kind: "sync_sbt_state",
      idempotencyKey: "profile-a:metadata-v2",
      userProfilePubkey: "profile-a",
      metadataUriHash: "meta-hash",
      metadataVersion: 2,
      runAfterMs: 100,
      createdAtMs: 100,
    });

    const claimed = store.claimPendingJob("worker-1", 100, 500);
    expect(claimed).toBeDefined();

    const attempt = store.startJobAttempt({
      jobId: job.id,
      attemptNumber: 1,
      startedAtMs: 101,
    });
    expect(attempt.outcome).toBe("running");

    const retryable = store.failOracleJob({
      jobId: job.id,
      lockKey: claimed!.lockKey,
      finishedAtMs: 150,
      nextRunAfterMs: 300,
      errorCode: "rpc_timeout",
      errorMessage: "confirmation timed out",
      retryable: true,
    });
    expect(retryable.status).toBe("retryable");
    expect(retryable.lastErrorCode).toBe("rpc_timeout");

    const claimedAgain = store.claimPendingJob("worker-2", 300, 500);
    expect(claimedAgain?.id).toBe(job.id);

    store.startJobAttempt({
      jobId: job.id,
      attemptNumber: 2,
      startedAtMs: 301,
    });

    const completed = store.completeOracleJob({
      jobId: job.id,
      lockKey: claimedAgain!.lockKey,
      finishedAtMs: 350,
      transactionSignature: "signature-1",
    });
    expect(completed.status).toBe("completed");
    expect(completed.completedAtMs).toBe(350);

    const attempts = store.listJobAttempts(job.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.outcome).toBe("retryable");
    expect(attempts[1]?.outcome).toBe("completed");
    expect(attempts[1]?.transactionSignature).toBe("signature-1");
    expect(store.findOracleJobByIdempotencyKey("profile-a:metadata-v2")?.status).toBe("completed");

    const reclaimed = store.claimPendingJob("worker-3", 351, 500);
    expect(reclaimed).toBeUndefined();
  });

  it("acquires and releases service locks with expiry semantics", () => {
    const { store } = createStore();

    const first = store.acquireServiceLock({
      lockKey: "job-runner",
      ownerId: "worker-a",
      acquiredAtMs: 100,
      expiresAtMs: 200,
    });
    expect(first?.ownerId).toBe("worker-a");

    const blocked = store.acquireServiceLock({
      lockKey: "job-runner",
      ownerId: "worker-b",
      acquiredAtMs: 150,
      expiresAtMs: 250,
    });
    expect(blocked).toBeUndefined();

    const reacquired = store.acquireServiceLock({
      lockKey: "job-runner",
      ownerId: "worker-c",
      acquiredAtMs: 201,
      expiresAtMs: 300,
    });
    expect(reacquired?.ownerId).toBe("worker-c");

    store.releaseLock("job-runner");

    const released = store.acquireServiceLock({
      lockKey: "job-runner",
      ownerId: "worker-d",
      acquiredAtMs: 202,
      expiresAtMs: 400,
    });
    expect(released?.ownerId).toBe("worker-d");
  });
});