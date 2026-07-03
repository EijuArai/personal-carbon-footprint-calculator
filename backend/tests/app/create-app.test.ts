import crypto from 'node:crypto';

import { SignJWT } from 'jose';
import { PublicKey } from '@solana/web3.js';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app/create-app.js';
import { loadEnv } from '../../src/config/env.js';
import { createDatabaseHandle, createStateStore } from '../../src/db/index.js';
import { HmacJwtAuthService } from '../../src/modules/ingestion/auth-service.js';
import { BackendDecryptionService } from '../../src/modules/ingestion/decryption-service.js';
import { FootprintOrchestrationService } from '../../src/modules/ingestion/footprint-orchestration.js';
import { InMemoryWalletAuthService } from '../../src/modules/ingestion/wallet-auth-service.js';
import { LcaOrchestrator } from '../../src/modules/lca/index.js';
import {
  InMemoryMetadataStorageProvider,
  JsonMetadataPublisher,
} from '../../src/modules/metadata/index.js';
import type { ProtocolConfigSnapshot } from '../../src/modules/oracle/index.js';

type GeneratedEd25519KeyPair = {
  publicKey: Parameters<typeof crypto.subtle.exportKey>[1];
  privateKey: Parameters<typeof crypto.subtle.sign>[1];
};

async function createJwt(
  overrides: { audience?: string; nonce?: string } = {},
): Promise<string> {
  const secret = new TextEncoder().encode('test-siws-secret-123456');

  return await new SignJWT({ nonce: overrides.nonce ?? 'nonce-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('green-reputation.local')
    .setAudience(overrides.audience ?? 'green-reputation.web')
    .setSubject('user-123')
    .setExpirationTime('2h')
    .sign(secret);
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

async function createWalletSignature(message: string) {
  const keyPair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as GeneratedEd25519KeyPair;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', keyPair.publicKey),
  );
  const walletAddress = new PublicKey(publicKey).toBase58();
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      keyPair.privateKey,
      new TextEncoder().encode(message),
    ),
  );

  return {
    walletAddress,
    signature: Buffer.from(signature).toString('base64'),
  };
}

describe('createApp', () => {
  it('serves a health response', async () => {
    const app = createApp({ env: loadEnv({ NODE_ENV: 'test' }) });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.environment).toBe('test');
  });

  it('serves a backend public key payload', async () => {
    const app = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      publicKeyProvider: () => 'TEST_PUBLIC_KEY',
    });

    const response = await request(app).get('/v1/crypto/public-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ publicKeyPem: 'TEST_PUBLIC_KEY' });
  });

  it('issues a JWT only after a Solana wallet signs the auth challenge', async () => {
    const app = createApp({
      env: loadEnv({
        NODE_ENV: 'test',
        SIWS_JWT_SECRET: 'test-siws-secret-123456',
      }),
      walletAuthService: new InMemoryWalletAuthService({
        issuer: 'green-reputation.local',
        audience: 'green-reputation.web',
        sharedSecret: 'test-siws-secret-123456',
        challengeTtlSeconds: 300,
        tokenTtlSeconds: 900,
      }),
    });

    const challengeResponse = await request(app)
      .post('/v1/siws/challenge')
      .send({
        walletAddress: '4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE',
      });

    expect(challengeResponse.status).toBe(201);
    expect(challengeResponse.body.message).toMatch(/Sign-In With Solana/i);

    const signed = await createWalletSignature(challengeResponse.body.message);

    const verifyResponse = await request(app).post('/v1/siws/verify').send({
      challengeId: challengeResponse.body.challengeId,
      walletAddress: signed.walletAddress,
      signature: signed.signature,
    });

    expect(verifyResponse.status).toBe(401);

    const validChallengeResponse = await request(app)
      .post('/v1/siws/challenge')
      .send({ walletAddress: signed.walletAddress });

    const validVerifyResponse = await request(app)
      .post('/v1/siws/verify')
      .send({
        challengeId: validChallengeResponse.body.challengeId,
        walletAddress: signed.walletAddress,
        signature: await (async () => {
          const ephemeralKeyPair = (await crypto.subtle.generateKey(
            'Ed25519',
            true,
            ['sign', 'verify'],
          )) as GeneratedEd25519KeyPair;
          const signedMessage = new Uint8Array(
            await crypto.subtle.sign(
              'Ed25519',
              ephemeralKeyPair.privateKey,
              new TextEncoder().encode(validChallengeResponse.body.message),
            ),
          );
          return Buffer.from(signedMessage).toString('base64');
        })(),
      });

    expect(validVerifyResponse.status).toBe(401);
  });

  it('ingests encrypted footprint payloads and returns aggregate results with queued jobs', async () => {
    const handle = createDatabaseHandle();
    const stateStore = createStateStore(handle);
    const decryptionService = new BackendDecryptionService();
    const authService = new HmacJwtAuthService({
      issuer: 'green-reputation.local',
      audience: 'green-reputation.web',
      sharedSecret: 'test-siws-secret-123456',
    });
    const metadataPublisher = new JsonMetadataPublisher(
      new InMemoryMetadataStorageProvider('https://metadata.example.test'),
    );
    const protocolConfig: ProtocolConfigSnapshot = {
      admin: new PublicKey('11111111111111111111111111111115'),
      verifier: new PublicKey('11111111111111111111111111111112'),
      metadataUpdateAuthority: new PublicKey(
        '11111111111111111111111111111113',
      ),
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
    const footprintOrchestrationService = new FootprintOrchestrationService({
      stateStore,
      lcaOrchestrator: new LcaOrchestrator({ now: () => 1_712_345_678_000 }),
      metadataPublisher,
      oracleClient: {
        async loadProtocolConfig() {
          return protocolConfig;
        },
        async loadUserProfile() {
          return null;
        },
      },
      programId: new PublicKey('68EBpJsPtNkbgvF3PhNFQbtnxYvSoBCCN6QoMYGJ8xzi'),
      now: () => 1_710_385_200_000,
    });
    const app = createApp({
      env: loadEnv({
        NODE_ENV: 'test',
        SIWS_JWT_SECRET: 'test-siws-secret-123456',
      }),
      stateStore,
      authService,
      decryptionService,
      footprintOrchestrationService,
      publicKeyProvider: () => decryptionService.exportPublicKeyPem(),
      requestIdProvider: () => 'req-1',
    });
    const token = await createJwt();
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
            {
              spendId: 'txn-food',
              category: 'Vegetables',
              amount: 40_000,
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
      decryptionService.exportPublicKeyPem(),
    );

    const response = await request(app)
      .post('/v1/footprints/ingest')
      .set('authorization', `Bearer ${token}`)
      .send(encrypted);

    expect(response.status).toBe(202);
    expect(response.body.requestId).toBe('req-1');
    expect(response.body.subject).toBe('user-123');
    expect(response.body.nonce).toBe('nonce-1');
    expect(response.body.aggregateResult).toEqual({
      totalEmissionsKgCo2e: 195.24,
      baseReductionKgCo2e: 400.88,
      finalRewards: 400.88,
      multiplierApplied: 1,
      dataSourceKind: 'hybrid',
      categories: ['Electricity', 'Vegetables'],
    });
    expect(response.body.metadata.metadataVersion).toBe(3);
    expect(
      response.body.metadata.uri.startsWith('https://metadata.example.test/'),
    ).toBe(true);
    expect(response.body.jobs).toHaveLength(2);
    expect(response.body.jobs[0].status).toBe('pending');
    expect(response.body.jobs[1].status).toBe('pending');
    expect(JSON.stringify(response.body)).not.toContain('txn-electricity');
    expect(stateStore.findNonce('nonce-1')?.subject).toBe('user-123');
    expect(stateStore.findOracleJobById(response.body.jobs[0].id)?.kind).toBe(
      'submit_verified_footprint',
    );
    expect(stateStore.findOracleJobById(response.body.jobs[1].id)?.kind).toBe(
      'sync_sbt_state',
    );

    handle.connection.close();
  });

  it('rejects invalid JWT before decrypting the payload', async () => {
    const handle = createDatabaseHandle();
    const stateStore = createStateStore(handle);
    let decryptCalls = 0;
    const app = createApp({
      env: loadEnv({
        NODE_ENV: 'test',
        SIWS_JWT_SECRET: 'test-siws-secret-123456',
      }),
      stateStore,
      authService: new HmacJwtAuthService({
        issuer: 'green-reputation.local',
        audience: 'green-reputation.web',
        sharedSecret: 'test-siws-secret-123456',
      }),
      footprintOrchestrationService: {
        async ingestDecryptedPayload() {
          return {
            subject: 'user-123',
            nonce: 'nonce-1',
            requestId: 'req-1',
            aggregateResult: {
              totalEmissionsKgCo2e: 0,
              baseReductionKgCo2e: 0,
              finalRewards: 0,
              multiplierApplied: 1,
              dataSourceKind: 'manual',
              categories: [],
            },
            metadata: {
              uri: 'https://metadata.example.test/a',
              metadataVersion: 1,
            },
            jobs: [],
          };
        },
      },
      decryptionService: {
        exportPublicKeyPem: () => 'TEST_PUBLIC_KEY',
        decryptRequest: () => {
          decryptCalls += 1;
          return {};
        },
      },
    });
    const token = await createJwt({ audience: 'wrong-audience' });

    const response = await request(app)
      .post('/v1/footprints/ingest')
      .set('authorization', `Bearer ${token}`)
      .send({
        encryptedSessionKey: 'bad',
        encryptedPayload: 'bad',
        iv: 'bad',
        authTag: 'bad',
        dataHash: 'a'.repeat(64),
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_token');
    expect(decryptCalls).toBe(0);

    handle.connection.close();
  });

  it('rejects replayed nonces', async () => {
    const handle = createDatabaseHandle();
    const stateStore = createStateStore(handle);
    const decryptionService = new BackendDecryptionService();
    const authService = new HmacJwtAuthService({
      issuer: 'green-reputation.local',
      audience: 'green-reputation.web',
      sharedSecret: 'test-siws-secret-123456',
    });
    const app = createApp({
      env: loadEnv({
        NODE_ENV: 'test',
        SIWS_JWT_SECRET: 'test-siws-secret-123456',
      }),
      stateStore,
      authService,
      decryptionService,
      footprintOrchestrationService: {
        async ingestDecryptedPayload() {
          return {
            subject: 'user-123',
            nonce: 'nonce-replay',
            requestId: 'req-1',
            aggregateResult: {
              totalEmissionsKgCo2e: 0,
              baseReductionKgCo2e: 0,
              finalRewards: 0,
              multiplierApplied: 1,
              dataSourceKind: 'manual',
              categories: [],
            },
            metadata: {
              uri: 'https://metadata.example.test/a',
              metadataVersion: 1,
            },
            jobs: [],
          };
        },
      },
    });
    const token = await createJwt({ nonce: 'nonce-replay' });
    const encrypted = encryptPayload(
      { foo: 'bar' },
      decryptionService.exportPublicKeyPem(),
    );

    const first = await request(app)
      .post('/v1/footprints/ingest')
      .set('authorization', `Bearer ${token}`)
      .send(encrypted);
    const second = await request(app)
      .post('/v1/footprints/ingest')
      .set('authorization', `Bearer ${token}`)
      .send(encrypted);

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('replayed_nonce');

    handle.connection.close();
  });

  it('fails safely when payload integrity verification fails', async () => {
    const handle = createDatabaseHandle();
    const stateStore = createStateStore(handle);
    const decryptionService = new BackendDecryptionService();
    const authService = new HmacJwtAuthService({
      issuer: 'green-reputation.local',
      audience: 'green-reputation.web',
      sharedSecret: 'test-siws-secret-123456',
    });
    const app = createApp({
      env: loadEnv({
        NODE_ENV: 'test',
        SIWS_JWT_SECRET: 'test-siws-secret-123456',
      }),
      stateStore,
      authService,
      decryptionService,
      footprintOrchestrationService: {
        async ingestDecryptedPayload() {
          throw new Error('should not reach orchestration');
        },
      },
    });
    const token = await createJwt({ nonce: 'nonce-hash-mismatch' });
    const encrypted = encryptPayload(
      { spendData: [] },
      decryptionService.exportPublicKeyPem(),
    );

    const response = await request(app)
      .post('/v1/footprints/ingest')
      .set('authorization', `Bearer ${token}`)
      .send({
        ...encrypted,
        dataHash: 'b'.repeat(64),
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_payload_hash');

    handle.connection.close();
  });

  it('serves job status for queued jobs', async () => {
    const handle = createDatabaseHandle();
    const stateStore = createStateStore(handle);
    const job = stateStore.enqueueOracleJob({
      kind: 'sync_sbt_state',
      idempotencyKey: 'user-123:metadata:3:abc',
      userPubkey: '4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE',
      metadataUriHash: 'a'.repeat(64),
      metadataVersion: 3,
      runAfterMs: 100,
      createdAtMs: 100,
    });
    const app = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      stateStore,
    });

    const response = await request(app).get(`/v1/jobs/${job.id}`);

    expect(response.status).toBe(200);
    expect(response.body.job).toEqual({
      id: job.id,
      kind: 'sync_sbt_state',
      status: 'pending',
      runAfterMs: 100,
      completedAtMs: undefined,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    });

    handle.connection.close();
  });

  it('rejects non-numeric job identifiers', async () => {
    const app = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      stateStore: createStateStore(createDatabaseHandle()),
    });

    const response = await request(app).get('/v1/jobs/not-a-number');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_job_id');
  });

  it('returns not found for unknown jobs', async () => {
    const handle = createDatabaseHandle();
    const stateStore = createStateStore(handle);
    const app = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      stateStore,
    });

    const response = await request(app).get('/v1/jobs/9999');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('job_not_found');

    handle.connection.close();
  });
});
