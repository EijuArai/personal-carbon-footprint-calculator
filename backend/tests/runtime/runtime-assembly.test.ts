import crypto from 'node:crypto';

import { SignJWT } from 'jose';
import { Keypair, PublicKey } from '@solana/web3.js';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/config/env.js';
import { createConfiguredBackendRuntime } from '../../src/runtime/create-runtime.js';
import type {
  ProgramTransport,
  ProtocolConfigSnapshot,
} from '../../src/modules/oracle/index.js';

type GeneratedEd25519KeyPair = {
  publicKey: Parameters<typeof crypto.subtle.exportKey>[1];
  privateKey: Parameters<typeof crypto.subtle.sign>[1];
};

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

function createProtocolConfig(verifier: PublicKey): ProtocolConfigSnapshot {
  return {
    admin: new PublicKey('11111111111111111111111111111115'),
    verifier,
    metadataUpdateAuthority: new PublicKey('11111111111111111111111111111113'),
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

describe('createConfiguredBackendRuntime', () => {
  it('issues wallet-signed ingest tokens only when local E2E auth bridge is explicitly enabled', async () => {
    const verifierSigner = Keypair.generate();
    const metadataAuthoritySigner = Keypair.generate();
    const authSecret = 'test-siws-secret-123456';
    const env = loadEnv({
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',
      SIWS_JWT_SECRET: authSecret,
      LOCAL_E2E_MODE: 'true',
      LOCAL_E2E_DEV_AUTH_ENABLED: 'true',
      SOLANA_VERIFIER_SECRET_KEY_JSON: JSON.stringify(
        Array.from(verifierSigner.secretKey),
      ),
      SOLANA_METADATA_AUTHORITY_SECRET_KEY_JSON: JSON.stringify(
        Array.from(metadataAuthoritySigner.secretKey),
      ),
      METADATA_BASE_URI: 'https://metadata.example.test',
    });

    const runtime = createConfiguredBackendRuntime({
      env,
      connectionFactory: () => ({}) as never,
      transportFactory: ({ signer }) => {
        const transport: ProgramTransport = {
          signerPublicKey: signer.publicKey,
          async fetchProtocolConfig() {
            return createProtocolConfig(signer.publicKey);
          },
          async fetchUserProfile() {
            return null;
          },
          async submitVerifiedFootprint() {
            throw new Error('not used');
          },
          async syncSbtState() {
            throw new Error('not used');
          },
          async fundTreasury() {
            throw new Error('not used');
          },
        };

        return transport;
      },
    });

    expect(runtime.resources.walletAuthService).toBeDefined();
    const keyPair = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as GeneratedEd25519KeyPair;
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey('raw', keyPair.publicKey),
    );
    const walletAddress = new PublicKey(publicKey).toBase58();

    const challengeResponse = await request(runtime.app)
      .post('/v1/siws/challenge')
      .send({ walletAddress });

    expect(challengeResponse.status).toBe(201);

    const signature = Buffer.from(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          keyPair.privateKey,
          new TextEncoder().encode(challengeResponse.body.message as string),
        ),
      ),
    ).toString('base64');

    const tokenResponse = await request(runtime.app)
      .post('/v1/siws/verify')
      .send({
        challengeId: challengeResponse.body.challengeId,
        walletAddress,
        signature,
      });

    expect(tokenResponse.status).toBe(201);
    expect(tokenResponse.body.subject).toBe(walletAddress);
    expect(tokenResponse.body.issuer).toBe('green-reputation.local');
    expect(tokenResponse.body.audience).toBe('green-reputation.web');
    expect(tokenResponse.body.token).toEqual(expect.any(String));
    expect(
      runtime.resources.signers.metadataAuthority?.publicKey.toBase58(),
    ).toBe(metadataAuthoritySigner.publicKey.toBase58());

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
      runtime.resources.decryptionService.exportPublicKeyPem(),
    );

    const ingestResponse = await request(runtime.app)
      .post('/v1/footprints/ingest')
      .set('authorization', `Bearer ${tokenResponse.body.token as string}`)
      .send(encrypted);

    expect(ingestResponse.status).toBe(202);
    expect(ingestResponse.body.subject).toBe(walletAddress);

    runtime.resources.databaseHandle.connection.close();
  });

  it('assembles a stock runtime that accepts encrypted ingest requests', async () => {
    const verifierSigner = Keypair.generate();
    const authSecret = 'test-siws-secret-123456';
    const env = loadEnv({
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',
      SIWS_JWT_SECRET: authSecret,
      SOLANA_VERIFIER_SECRET_KEY_JSON: JSON.stringify(
        Array.from(verifierSigner.secretKey),
      ),
      METADATA_BASE_URI: 'https://metadata.example.test',
    });

    const runtime = createConfiguredBackendRuntime({
      env,
      connectionFactory: () => ({}) as never,
      transportFactory: ({ signer }) => {
        const transport: ProgramTransport = {
          signerPublicKey: signer.publicKey,
          async fetchProtocolConfig() {
            return createProtocolConfig(signer.publicKey);
          },
          async fetchUserProfile() {
            return null;
          },
          async submitVerifiedFootprint() {
            throw new Error('not used');
          },
          async syncSbtState() {
            throw new Error('not used');
          },
          async fundTreasury() {
            throw new Error('not used');
          },
        };

        return transport;
      },
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
      runtime.resources.decryptionService.exportPublicKeyPem(),
    );

    const response = await request(runtime.app)
      .post('/v1/footprints/ingest')
      .set('authorization', `Bearer ${token}`)
      .send(encrypted);

    expect(response.status).toBe(202);
    expect(response.body.aggregateResult.finalRewards).toBe(400.88);
    expect(response.body.jobs).toHaveLength(2);
    expect(runtime.resources.signers.verifier.publicKey.toBase58()).toBe(
      verifierSigner.publicKey.toBase58(),
    );

    runtime.resources.databaseHandle.connection.close();
  });

  it('does not expose the dev auth bridge without explicit local E2E flags', async () => {
    const verifierSigner = Keypair.generate();
    const env = loadEnv({
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',
      SIWS_JWT_SECRET: 'test-siws-secret-123456',
      SOLANA_VERIFIER_SECRET_KEY_JSON: JSON.stringify(
        Array.from(verifierSigner.secretKey),
      ),
    });

    const runtime = createConfiguredBackendRuntime({
      env,
      connectionFactory: () => ({}) as never,
      transportFactory: ({ signer }) => ({
        signerPublicKey: signer.publicKey,
        async fetchProtocolConfig() {
          return createProtocolConfig(signer.publicKey);
        },
        async fetchUserProfile() {
          return null;
        },
        async submitVerifiedFootprint() {
          throw new Error('not used');
        },
        async syncSbtState() {
          throw new Error('not used');
        },
        async fundTreasury() {
          throw new Error('not used');
        },
      }),
    });

    const response = await request(runtime.app)
      .post('/v1/siws/challenge')
      .send({
        walletAddress: '4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE',
      });

    expect(response.status).toBe(404);
    expect(runtime.resources.walletAuthService).toBeUndefined();

    runtime.resources.databaseHandle.connection.close();
  });

  it('fails fast when the verifier signer secret is missing', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',
      SIWS_JWT_SECRET: 'test-siws-secret-123456',
    });

    expect(() => createConfiguredBackendRuntime({ env })).toThrow(
      /SOLANA_VERIFIER_SECRET_KEY_JSON/i,
    );
  });

  it('fails fast when the metadata authority signer secret is missing in local E2E mode', () => {
    const verifierSigner = Keypair.generate();
    const env = loadEnv({
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',
      SIWS_JWT_SECRET: 'test-siws-secret-123456',
      LOCAL_E2E_MODE: 'true',
      SOLANA_VERIFIER_SECRET_KEY_JSON: JSON.stringify(
        Array.from(verifierSigner.secretKey),
      ),
    });

    expect(() => createConfiguredBackendRuntime({ env })).toThrow(
      /SOLANA_METADATA_AUTHORITY_SECRET_KEY_JSON/i,
    );
  });
});
