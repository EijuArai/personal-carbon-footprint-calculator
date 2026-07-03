import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/lib/app-error.js';
import { createDatabaseHandle, createStateStore } from '../../src/db/index.js';
import { FootprintOrchestrationService } from '../../src/modules/ingestion/footprint-orchestration.js';
import type { AuthContext } from '../../src/modules/ingestion/auth-service.js';
import { LcaOrchestrator } from '../../src/modules/lca/index.js';
import {
  InMemoryMetadataStorageProvider,
  JsonMetadataPublisher,
} from '../../src/modules/metadata/index.js';
import type {
  ProtocolConfigSnapshot,
  UserProfileSnapshot,
} from '../../src/modules/oracle/index.js';

const programId = new PublicKey('68EBpJsPtNkbgvF3PhNFQbtnxYvSoBCCN6QoMYGJ8xzi');
const protocolConfig: ProtocolConfigSnapshot = {
  admin: new PublicKey('11111111111111111111111111111115'),
  verifier: new PublicKey('11111111111111111111111111111112'),
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
const authContext: AuthContext = {
  issuer: 'issuer',
  audience: 'audience',
  subject: 'user-123',
  nonce: 'nonce-1',
  expiresAtMs: 1_800_000_000_000,
};

function createService() {
  const nowMs = 1_710_385_200_000;
  const handle = createDatabaseHandle();
  const stateStore = createStateStore(handle);
  const metadataStorage = new InMemoryMetadataStorageProvider(
    'https://metadata.example.test',
  );
  const service = new FootprintOrchestrationService({
    stateStore,
    lcaOrchestrator: new LcaOrchestrator({ now: () => 1_712_345_678_000 }),
    metadataPublisher: new JsonMetadataPublisher(metadataStorage),
    oracleClient: {
      async loadProtocolConfig() {
        return protocolConfig;
      },
      async loadUserProfile() {
        return null;
      },
    },
    programId,
    now: () => nowMs,
  });

  return { handle, stateStore, metadataStorage, service };
}

function createUserProfileSnapshot(input: {
  emissionHistory: Uint8Array;
  lastVerifiedAt?: number;
}): UserProfileSnapshot {
  return {
    user: new PublicKey('4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE'),
    lastVerifiedAt: input.lastVerifiedAt ?? 1_710_385_200,
    metadataVersion: 2,
    emissionHistory: input.emissionHistory,
  };
}

function createDailyEmissionHistory(
  dailyEmissions: number[],
  endTimestamp: number,
): Uint8Array {
  const bytes = new Uint8Array(dailyEmissions.length * 16);
  const startOfDay = Math.floor(endTimestamp / 86_400) * 86_400;

  dailyEmissions.forEach((emissionGrams, index) => {
    const dayStart = startOfDay - (dailyEmissions.length - 1 - index) * 86_400;
    const view = new DataView(bytes.buffer, index * 16, 16);
    view.setBigInt64(0, BigInt(dayStart), true);
    view.setBigUint64(8, BigInt(emissionGrams), true);
  });

  return bytes;
}

function createServiceWithUserProfile(userProfile: UserProfileSnapshot | null) {
  const nowMs = 1_710_385_200_000;
  const handle = createDatabaseHandle();
  const stateStore = createStateStore(handle);
  const metadataStorage = new InMemoryMetadataStorageProvider(
    'https://metadata.example.test',
  );
  const service = new FootprintOrchestrationService({
    stateStore,
    lcaOrchestrator: new LcaOrchestrator({ now: () => 1_712_345_678_000 }),
    metadataPublisher: new JsonMetadataPublisher(metadataStorage),
    oracleClient: {
      async loadProtocolConfig() {
        return protocolConfig;
      },
      async loadUserProfile() {
        return userProfile;
      },
    },
    programId,
    now: () => nowMs,
  });

  return { handle, stateStore, metadataStorage, service, nowMs };
}

describe('FootprintOrchestrationService', () => {
  it('rejects decrypted payloads that do not match the contract', async () => {
    const { handle, service } = createService();

    try {
      await service.ingestDecryptedPayload({}, authContext, 'req-1');
      throw new Error('expected invalid decrypted payload error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: 'invalid_decrypted_payload',
        statusCode: 400,
      });
    }

    handle.connection.close();
  });

  it('rejects decrypted payloads with invalid user public keys', async () => {
    const { handle, service } = createService();

    try {
      await service.ingestDecryptedPayload(
        {
          userPubkey: 'not-a-pubkey',
          currentMetadataVersion: 2,
          publicProfile: {
            displayAlias: 'primary-user',
            countryCode: 'JP',
            avatarUri: '',
          },
          aggregateStateHint: {
            totalEmissionsKgCo2e: 10,
            totalReductionsKgCo2e: 5,
            pendingRewardLamports: '0',
          },
          lca: {
            periodKey: '2026-04',
            spendEntries: [],
            activityEntries: [],
            history: { pastAverageMonthlyEmissions: 100 },
          },
        },
        authContext,
        'req-1',
      );
      throw new Error('expected invalid user pubkey error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: 'invalid_user_pubkey',
        statusCode: 400,
      });
    }

    handle.connection.close();
  });

  it('persists only aggregate queue data and metadata without raw source identifiers', async () => {
    const { handle, stateStore, metadataStorage, service } = createService();

    const result = await service.ingestDecryptedPayload(
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
      authContext,
      'req-1',
    );

    const persistedJobs = result.jobs.map((job) =>
      stateStore.findOracleJobById(job.id),
    );
    const metadataJson = [...metadataStorage.objects.values()].join('\n');

    expect(JSON.stringify(result)).not.toContain('txn-electricity');
    expect(JSON.stringify(persistedJobs)).not.toContain('txn-electricity');
    expect(metadataJson).not.toContain('txn-electricity');
    expect(metadataJson).not.toContain('meter-reading');

    handle.connection.close();
  });

  it('uses on-chain emission history instead of user-supplied baseline input', async () => {
    const nowMs = 1_710_385_200_000;
    const { handle, service } = createServiceWithUserProfile(
      createUserProfileSnapshot({
        emissionHistory: createDailyEmissionHistory(
          new Array(10).fill(20_000),
          Math.floor(nowMs / 1000),
        ),
      }),
    );

    const result = await service.ingestDecryptedPayload(
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
      authContext,
      'req-2',
    );

    expect(result.aggregateResult.multiplierApplied).toBe(1);
    expect(result.aggregateResult.finalRewards).toBe(400.88);

    handle.connection.close();
  });

  it('derives the multiplier from the previous 30 full days and excludes today', async () => {
    const nowMs = 1_710_385_200_000;
    const { handle, service } = createServiceWithUserProfile(
      createUserProfileSnapshot({
        emissionHistory: createDailyEmissionHistory(
          new Array(30).fill(25_000),
          Math.floor(nowMs / 1000) - 86_400,
        ),
        lastVerifiedAt: Math.floor(nowMs / 1000) - 86_400,
      }),
    );

    const result = await service.ingestDecryptedPayload(
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
      authContext,
      'req-3',
    );

    expect(result.aggregateResult.multiplierApplied).toBeLessThan(1);
    expect(result.aggregateResult.finalRewards).toBeLessThan(400.88);

    handle.connection.close();
  });
});
