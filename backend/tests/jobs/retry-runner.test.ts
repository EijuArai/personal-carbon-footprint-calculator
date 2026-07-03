import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabaseHandle, createStateStore } from '../../src/db/index.js';
import {
  OracleRetryRunner,
  RetryableJobError,
} from '../../src/modules/jobs/index.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'green-reputation-jobs-'));
  tempDirs.push(dir);

  const handle = createDatabaseHandle({ filename: join(dir, 'state.db') });
  handles.push(handle);

  return createStateStore(handle);
}

function createHashHex(seed: string): string {
  return Buffer.from(seed.padEnd(32, '0')).toString('hex').slice(0, 64);
}

describe('OracleRetryRunner', () => {
  it('processes a due submit_verified_footprint job and stores a completed attempt', async () => {
    const stateStore = createStore();
    const user = new PublicKey('4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE');
    const calls: Array<Record<string, unknown>> = [];
    const job = stateStore.enqueueOracleJob({
      kind: 'submit_verified_footprint',
      idempotencyKey: 'user:202604:hash-a',
      userPubkey: user.toBase58(),
      periodKey: 202604,
      commitmentHash: createHashHex('a'),
      sourceKind: 'hybrid',
      emissionDeltaGrams: 12_500,
      reductionDeltaGrams: 2_000,
      rewardDeltaLamports: 20_000,
      runAfterMs: 100,
      createdAtMs: 100,
    });
    const runner = new OracleRetryRunner({
      stateStore,
      workerId: 'worker-1',
      now: () => 100,
      oracleClient: {
        async submitVerifiedFootprintJob(payload) {
          calls.push({ type: 'submit', payload });
          return { signature: 'sig-1', footprintCommitment: user };
        },
        async syncSbtState() {
          throw new Error('not used');
        },
        async fundTreasury() {
          throw new Error('not used');
        },
      },
    });

    const result = await runner.runDueJobs();
    const persisted = stateStore.findOracleJobById(job.id);
    const attempts = stateStore.listJobAttempts(job.id);

    expect(result.processedJobIds).toEqual([job.id]);
    expect(calls).toHaveLength(1);
    expect(
      (calls[0] as { payload: { periodKey: bigint } }).payload.periodKey,
    ).toBe(202604n);
    expect(persisted?.status).toBe('completed');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('completed');
    expect(attempts[0]?.transactionSignature).toBe('sig-1');
  });

  it('marks invalid payloads as terminal failures', async () => {
    const stateStore = createStore();
    const job = stateStore.enqueueOracleJob({
      kind: 'submit_verified_footprint',
      idempotencyKey: 'broken-job',
      runAfterMs: 100,
      createdAtMs: 100,
    });
    const runner = new OracleRetryRunner({
      stateStore,
      workerId: 'worker-1',
      now: () => 100,
      oracleClient: {
        async submitVerifiedFootprintJob() {
          throw new Error('should not reach client');
        },
        async syncSbtState() {
          throw new Error('not used');
        },
        async fundTreasury() {
          throw new Error('not used');
        },
      },
    });

    await runner.runDueJobs();

    const persisted = stateStore.findOracleJobById(job.id);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.lastErrorCode).toBe('invalid_job_payload');
  });

  it('marks malformed sync payload hashes as terminal failures', async () => {
    const stateStore = createStore();
    const job = stateStore.enqueueOracleJob({
      kind: 'sync_sbt_state',
      idempotencyKey: 'profile-a:metadata-bad',
      userPubkey: '4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE',
      metadataUriHash: 'not-a-hash',
      metadataVersion: 3,
      runAfterMs: 100,
      createdAtMs: 100,
    });
    const runner = new OracleRetryRunner({
      stateStore,
      workerId: 'worker-1',
      now: () => 100,
      oracleClient: {
        async submitVerifiedFootprintJob() {
          throw new Error('not used');
        },
        async syncSbtState() {
          throw new Error('should not reach client');
        },
        async fundTreasury() {
          throw new Error('not used');
        },
      },
    });

    await runner.runDueJobs();

    const persisted = stateStore.findOracleJobById(job.id);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.lastErrorCode).toBe('invalid_job_payload');
  });

  it('treats metadata publish preparation failures as retryable', async () => {
    const stateStore = createStore();
    const user = new PublicKey('4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE');
    const job = stateStore.enqueueOracleJob({
      kind: 'sync_sbt_state',
      idempotencyKey: 'profile-a:metadata-retry',
      userPubkey: user.toBase58(),
      runAfterMs: 100,
      createdAtMs: 100,
    });
    const runner = new OracleRetryRunner({
      stateStore,
      workerId: 'worker-1',
      now: () => 100,
      backoffMs: () => 250,
      prepareMetadataSync() {
        throw new Error('metadata publish unavailable');
      },
      oracleClient: {
        async submitVerifiedFootprintJob() {
          throw new Error('not used');
        },
        async syncSbtState() {
          throw new Error('should not reach client');
        },
        async fundTreasury() {
          throw new Error('not used');
        },
      },
    });

    await runner.runDueJobs();

    const persisted = stateStore.findOracleJobById(job.id);
    const attempts = stateStore.listJobAttempts(job.id);
    expect(persisted?.status).toBe('retryable');
    expect(persisted?.lastErrorCode).toBe('metadata_publish_failed');
    expect(persisted?.runAfterMs).toBe(350);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('retryable');
  });

  it('respects the global runner lock to avoid parallel loops', async () => {
    const stateStore = createStore();
    const runnerA = new OracleRetryRunner({
      stateStore,
      workerId: 'worker-a',
      now: () => 100,
      oracleClient: {
        async submitVerifiedFootprintJob() {
          throw new Error('not used');
        },
        async syncSbtState() {
          throw new Error('not used');
        },
        async fundTreasury() {
          throw new Error('not used');
        },
      },
    });
    const runnerB = new OracleRetryRunner({
      stateStore,
      workerId: 'worker-b',
      now: () => 100,
      oracleClient: {
        async submitVerifiedFootprintJob() {
          throw new Error('not used');
        },
        async syncSbtState() {
          throw new Error('not used');
        },
        async fundTreasury() {
          throw new Error('not used');
        },
      },
    });

    stateStore.acquireServiceLock({
      lockKey: 'oracle-job-runner',
      ownerId: 'external',
      acquiredAtMs: 100,
      expiresAtMs: 150,
    });

    expect((await runnerA.runDueJobs()).processedJobIds).toEqual([]);

    stateStore.releaseLock('oracle-job-runner');
    expect((await runnerB.runDueJobs()).processedJobIds).toEqual([]);
  });

  it('can resume a retryable job after a process restart via executeJob', async () => {
    const stateStore = createStore();
    const user = new PublicKey('4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE');
    const job = stateStore.enqueueOracleJob({
      kind: 'fund_treasury',
      idempotencyKey: 'fund:200000',
      amountLamports: 200_000,
      runAfterMs: 100,
      createdAtMs: 100,
    });
    const firstRunner = new OracleRetryRunner({
      stateStore,
      workerId: 'worker-a',
      now: () => 100,
      backoffMs: () => 50,
      oracleClient: {
        async submitVerifiedFootprintJob() {
          throw new Error('not used');
        },
        async syncSbtState() {
          throw new Error('not used');
        },
        async fundTreasury() {
          throw new RetryableJobError({
            code: 'rpc_unavailable',
            message: 'rpc unavailable',
          });
        },
      },
    });

    await firstRunner.runDueJobs();
    expect(stateStore.findOracleJobById(job.id)?.status).toBe('retryable');

    const secondRunner = new OracleRetryRunner({
      stateStore,
      workerId: 'worker-b',
      now: () => 150,
      oracleClient: {
        async submitVerifiedFootprintJob() {
          throw new Error('not used');
        },
        async syncSbtState() {
          throw new Error('not used');
        },
        async fundTreasury() {
          return { signature: 'sig-fund-1' };
        },
      },
    });

    const executed = await secondRunner.executeJob(job.id);
    const attempts = stateStore.listJobAttempts(job.id);

    expect(executed?.status).toBe('completed');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.outcome).toBe('retryable');
    expect(attempts[1]?.outcome).toBe('completed');
  });

  it('classifies metadata publish failures as retryable before sync submission', async () => {
    const stateStore = createStore();
    const user = new PublicKey('4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE');
    const job = stateStore.enqueueOracleJob({
      kind: 'sync_sbt_state',
      idempotencyKey: 'sync:profile:3',
      userPubkey: user.toBase58(),
      metadataVersion: 3,
      runAfterMs: 100,
      createdAtMs: 100,
    });
    const runner = new OracleRetryRunner({
      stateStore,
      workerId: 'worker-a',
      now: () => 100,
      async prepareMetadataSync() {
        throw new RetryableJobError({
          code: 'metadata_publish_failed',
          message: 'metadata publish unavailable',
        });
      },
      oracleClient: {
        async submitVerifiedFootprintJob() {
          throw new Error('not used');
        },
        async syncSbtState() {
          throw new Error('should not reach sync');
        },
        async fundTreasury() {
          throw new Error('not used');
        },
      },
    });

    await runner.runDueJobs();
    const persisted = stateStore.findOracleJobById(job.id);
    expect(persisted?.status).toBe('retryable');
    expect(persisted?.lastErrorCode).toBe('metadata_publish_failed');
  });
});
