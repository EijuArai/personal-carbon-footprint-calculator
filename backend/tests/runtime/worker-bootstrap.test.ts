import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SignJWT } from 'jose';
import { Keypair, PublicKey } from '@solana/web3.js';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../../src/config/env.js';
import { createConfiguredBackendRuntime } from '../../src/runtime/create-runtime.js';
import {
  OracleWorkerLoop,
  createConfiguredWorkerRuntime,
} from '../../src/runtime/create-worker.js';
import type {
  ProgramTransport,
  ProtocolConfigSnapshot,
} from '../../src/modules/oracle/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

async function createJwt(
  secret: string,
  overrides: { audience?: string; nonce?: string } = {},
): Promise<string> {
  return await new SignJWT({ nonce: overrides.nonce ?? 'nonce-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('green-reputation.local')
    .setAudience(overrides.audience ?? 'green-reputation.web')
    .setSubject('user-123')
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(secret));
}

function encryptPayload(rawData: unknown, publicKeyPem: string) {
  const payload = JSON.stringify(rawData);
  const dataHash = crypto.createHash('sha256').update(payload).digest('hex');
  const sessionKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  let encryptedPayload = cipher.update(payload, 'utf8', 'base64');
  encryptedPayload += cipher.final('base64');

  const encryptedSessionKey = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    sessionKey,
  );

  return {
    encryptedSessionKey: encryptedSessionKey.toString('base64'),
    encryptedPayload,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    dataHash,
  };
}

function createProtocolConfig(
  verifier: PublicKey,
  metadataAuthority: PublicKey,
): ProtocolConfigSnapshot {
  return {
    admin: new PublicKey('11111111111111111111111111111115'),
    verifier,
    metadataUpdateAuthority: metadataAuthority,
    treasuryAuthority: new PublicKey('11111111111111111111111111111114'),
    rewardPolicy: {
      lamportsPerKgReduced: 10_000n,
      minimumReductionGrams: 100n,
      maxLamportsPerPeriod: 50_000n,
      maxPendingLamports: 100_000n,
    },
    rankThresholds: {
      seedlingMinReductionGrams: 1_000n,
      saplingMinReductionGrams: 5_000n,
      treeMinReductionGrams: 10_000n,
      forestMinReductionGrams: 25_000n,
    },
  };
}

function createSqlitePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'green-reputation-worker-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

describe('OracleWorkerLoop', () => {
  it('starts a periodic polling loop and stops cleanly', async () => {
    vi.useFakeTimers();

    const runDueJobs = vi.fn(async () => ({ processedJobIds: [1] }));
    const loop = new OracleWorkerLoop({
      pollIntervalMs: 50,
      runDueJobs,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    expect(runDueJobs).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(125);
    expect(runDueJobs).toHaveBeenCalledTimes(4);

    const callCountBeforeStop = runDueJobs.mock.calls.length;
    loop.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(runDueJobs).toHaveBeenCalledTimes(callCountBeforeStop);

    vi.useRealTimers();
  });

  it('keeps the polling interval referenced so the worker process stays alive', () => {
    const runDueJobs = vi.fn(async () => ({ processedJobIds: [] }));
    const intervalHandle = {
      unref: vi.fn(),
    } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue(intervalHandle);
    const clearIntervalSpy = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation(() => undefined);

    try {
      const loop = new OracleWorkerLoop({
        pollIntervalMs: 50,
        runDueJobs,
      });

      loop.start();
      expect(intervalHandle.unref).not.toHaveBeenCalled();

      loop.stop();
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});

describe('createConfiguredWorkerRuntime', () => {
  it('drains queued ingest jobs to completion and records transaction signatures', async () => {
    const verifierSigner = Keypair.generate();
    const metadataAuthoritySigner = Keypair.generate();
    const authSecret = 'test-siws-secret-123456';
    const sqlitePath = createSqlitePath();
    const transportCalls: Array<{ signer: string; operation: string }> = [];
    const env = loadEnv({
      NODE_ENV: 'test',
      LOCAL_E2E_MODE: 'true',
      SQLITE_PATH: sqlitePath,
      SIWS_JWT_SECRET: authSecret,
      SOLANA_VERIFIER_SECRET_KEY_JSON: JSON.stringify(
        Array.from(verifierSigner.secretKey),
      ),
      SOLANA_METADATA_AUTHORITY_SECRET_KEY_JSON: JSON.stringify(
        Array.from(metadataAuthoritySigner.secretKey),
      ),
      METADATA_BASE_URI: 'https://metadata.example.test',
    });

    const backendRuntime = createConfiguredBackendRuntime({
      env,
      connectionFactory: () => ({}) as never,
      transportFactory: ({ signer }) => ({
        signerPublicKey: signer.publicKey,
        async fetchProtocolConfig() {
          return createProtocolConfig(
            verifierSigner.publicKey,
            metadataAuthoritySigner.publicKey,
          );
        },
        async fetchUserProfile() {
          return null;
        },
        async submitVerifiedFootprint() {
          transportCalls.push({
            signer: signer.publicKey.toBase58(),
            operation: 'submit',
          });
          return { signature: 'sig-submit' };
        },
        async syncSbtState() {
          transportCalls.push({
            signer: signer.publicKey.toBase58(),
            operation: 'sync',
          });
          return { signature: 'sig-sync' };
        },
        async fundTreasury() {
          transportCalls.push({
            signer: signer.publicKey.toBase58(),
            operation: 'fund',
          });
          return { signature: 'sig-fund' };
        },
      }),
    });
    const workerRuntime = createConfiguredWorkerRuntime({
      env,
      connectionFactory: () => ({}) as never,
      transportFactory: ({ signer }) => ({
        signerPublicKey: signer.publicKey,
        async fetchProtocolConfig() {
          return createProtocolConfig(
            verifierSigner.publicKey,
            metadataAuthoritySigner.publicKey,
          );
        },
        async fetchUserProfile() {
          return null;
        },
        async submitVerifiedFootprint() {
          transportCalls.push({
            signer: signer.publicKey.toBase58(),
            operation: 'submit',
          });
          return { signature: 'sig-submit' };
        },
        async syncSbtState() {
          transportCalls.push({
            signer: signer.publicKey.toBase58(),
            operation: 'sync',
          });
          return { signature: 'sig-sync' };
        },
        async fundTreasury() {
          transportCalls.push({
            signer: signer.publicKey.toBase58(),
            operation: 'fund',
          });
          return { signature: 'sig-fund' };
        },
      }),
    });

    const token = await createJwt(authSecret);
    const encrypted = encryptPayload(
      {
        userPubkey: '4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE',
        currentMetadataVersion: 2,
        publicProfile: {
          displayAlias: 'primary-user',
          countryCode: 'JP',
          avatarUri: '',
        },
        aggregateStateHint: {
          totalEmissionsKgCo2e: 20,
          totalReductionsKgCo2e: 10,
          pendingRewardLamports: '5000',
        },
        lca: {
          periodKey: '2026-04',
          spendEntries: [
            {
              spendId: 'txn-electricity',
              category: 'Electricity',
              amount: 15_000,
              source: 'open_banking',
            },
          ],
          activityEntries: [
            {
              activityId: 'meter-reading',
              category: 'Electricity',
              value: 300,
              unit: 'kWh',
              source: 'api_activity',
              isRenewable: true,
            },
          ],
          history: { pastAverageMonthlyEmissions: 200 },
        },
      },
      backendRuntime.resources.decryptionService.exportPublicKeyPem(),
    );

    const response = await request(backendRuntime.app)
      .post('/v1/footprints/ingest')
      .set('authorization', `Bearer ${token}`)
      .send(encrypted);

    expect(response.status).toBe(202);

    const runResult = await workerRuntime.runDueJobsOnce();
    expect(runResult.processedJobIds).toHaveLength(2);

    const [submitJob, syncJob] = response.body.jobs as Array<{ id: number }>;
    if (!submitJob || !syncJob) {
      throw new Error(
        'Expected both queued oracle jobs to be returned from ingest.',
      );
    }
    const persistedSubmit =
      workerRuntime.resources.backendRuntime.resources.stateStore.findOracleJobById(
        submitJob.id,
      );
    const persistedSync =
      workerRuntime.resources.backendRuntime.resources.stateStore.findOracleJobById(
        syncJob.id,
      );
    const submitAttempts =
      workerRuntime.resources.backendRuntime.resources.stateStore.listJobAttempts(
        submitJob.id,
      );
    const syncAttempts =
      workerRuntime.resources.backendRuntime.resources.stateStore.listJobAttempts(
        syncJob.id,
      );

    expect(persistedSubmit?.status).toBe('completed');
    expect(persistedSync?.status).toBe('completed');
    expect(submitAttempts[0]?.transactionSignature).toBe('sig-submit');
    expect(syncAttempts[0]?.transactionSignature).toBe('sig-sync');
    expect(transportCalls).toContainEqual({
      signer: verifierSigner.publicKey.toBase58(),
      operation: 'submit',
    });
    expect(transportCalls).toContainEqual({
      signer: metadataAuthoritySigner.publicKey.toBase58(),
      operation: 'sync',
    });

    backendRuntime.resources.databaseHandle.connection.close();
    workerRuntime.dispose();
  });
});
