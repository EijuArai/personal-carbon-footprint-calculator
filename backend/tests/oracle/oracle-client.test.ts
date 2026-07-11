import crypto from 'node:crypto';

import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import type { CommitmentPreimageV1 } from '../../src/modules/lca/index.js';
import {
  InMemoryMetadataStorageProvider,
  JsonMetadataPublisher,
} from '../../src/modules/metadata/index.js';
import {
  GreenReputationOracleClient,
  findFootprintCommitmentPda,
  findProtocolConfigPda,
  findRewardTreasuryPda,
  findTreasuryVaultPda,
  findUserProfilePda,
  hashCommitmentPreimage,
  quoteRewardLamports,
  type ProgramTransport,
  type ProtocolConfigSnapshot,
} from '../../src/modules/oracle/index.js';

const programId = new PublicKey('CYTYoWKNxj4xP1vUPef2HuRb8x8kgrnzpQXMi665Q6ve');
const user = new PublicKey('4Nd1mYqV8C4QyXcXwjkA8azhbugzuDUFcPRwvx6pRPxE');
const admin = new PublicKey('11111111111111111111111111111115');
const verifier = new PublicKey('11111111111111111111111111111112');
const metadataAuthority = new PublicKey('11111111111111111111111111111113');
const treasuryAuthority = new PublicKey('11111111111111111111111111111114');

function createCommitmentPreimage(): CommitmentPreimageV1 {
  return {
    schemaVersion: 'commitment-preimage@v1',
    periodKey: '2026-04',
    dataSourceKind: 'hybrid',
    totalEmissionsKgCo2e: 80,
    baseReductionKgCo2e: 75,
    finalRewards: 97.5,
    multiplierApplied: 1.3,
    historicalBaselineKgCo2e: 200,
    sourceSummary: {
      spendRecordCount: 2,
      activityRecordCount: 1,
      categories: ['Electricity', 'Vegetables'],
      origins: ['api_activity', 'open_banking'],
      overriddenCategories: ['Electricity'],
    },
    verificationData: {
      emissionFactorDatabase: 'EXIOBASE_Mock_v1',
      timestamp: 1_712_345_678_000,
    },
  };
}

function createProtocolConfigSnapshot(): ProtocolConfigSnapshot {
  return {
    admin,
    verifier,
    metadataUpdateAuthority: metadataAuthority,
    treasuryAuthority,
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

describe('JsonMetadataPublisher', () => {
  it('publishes deterministic metadata and returns a URI hash consistent with the published URI', async () => {
    const storage = new InMemoryMetadataStorageProvider(
      'https://metadata.example.test',
    );
    const publisher = new JsonMetadataPublisher(storage);
    const document = publisher.buildMetadataDocument(
      {
        displayAlias: 'primary-user',
        countryCode: 'JP',
        avatarUri: 'https://avatars.example.test/a.png',
      },
      {
        totalEmissionsKgCo2e: 80,
        totalReductionsKgCo2e: 97.5,
        pendingRewardLamports: 20_000n,
        rank: 'Seedling',
        latestPeriodKey: '2026-04',
      },
      createCommitmentPreimage(),
    );

    const published = await publisher.publishMetadata(document, 3);
    const expectedHash = new Uint8Array(
      crypto.createHash('sha256').update(published.uri).digest(),
    );

    expect(published.metadataVersion).toBe(3);
    expect(published.uri.startsWith('https://metadata.example.test/')).toBe(
      true,
    );
    expect([...published.metadataUriHash]).toEqual([...expectedHash]);
    expect([...storage.objects.values()][0]).toContain(
      'green-reputation-metadata@v1',
    );
  });
});

describe('GreenReputationOracleClient', () => {
  it('derives PDAs and serializes verifier submission payloads correctly', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const transport: ProgramTransport = {
      signerPublicKey: verifier,
      async fetchProtocolConfig() {
        calls.push({ type: 'fetchProtocolConfig' });
        return createProtocolConfigSnapshot();
      },
      async fetchUserProfile() {
        calls.push({ type: 'fetchUserProfile' });
        return null;
      },
      async submitVerifiedFootprint(input) {
        calls.push({ type: 'submitVerifiedFootprint', input });
        return { signature: 'sig-submit-1' };
      },
      async syncSbtState() {
        throw new Error('not used');
      },
      async fundTreasury() {
        throw new Error('not used');
      },
    };

    const client = new GreenReputationOracleClient({ programId, transport });
    const commitmentPreimage = createCommitmentPreimage();
    const result = await client.submitVerifiedFootprint({
      user,
      periodKey: 202604n,
      commitmentPreimage,
      rewardDeltaLamports: 20_000n,
    });

    const submitCall = calls.find(
      (entry) => entry.type === 'submitVerifiedFootprint',
    ) as {
      input: Record<string, any>;
    };
    const expectedHash = hashCommitmentPreimage(commitmentPreimage);
    const expectedCommitmentPda = findFootprintCommitmentPda(
      user,
      202604n,
      expectedHash,
      programId,
    );

    expect(result.signature).toBe('sig-submit-1');
    expect(result.footprintCommitment.toBase58()).toBe(
      expectedCommitmentPda.toBase58(),
    );
    expect(submitCall.input.protocolConfig.toBase58()).toBe(
      findProtocolConfigPda(programId).toBase58(),
    );
    expect(submitCall.input.userProfile.toBase58()).toBe(
      findUserProfilePda(user, programId).toBase58(),
    );
    expect(submitCall.input.rewardTreasury.toBase58()).toBe(
      findRewardTreasuryPda(programId).toBase58(),
    );
    expect(submitCall.input.args.commitmentHash).toEqual(
      Array.from(expectedHash),
    );
    expect(submitCall.input.args.sourceKind).toEqual({ hybrid: {} });
    expect(submitCall.input.args.emissionDeltaGrams.toString()).toBe('80000');
    expect(submitCall.input.args.reductionDeltaGrams.toString()).toBe('75000');
    expect(submitCall.input.args.rewardDeltaLamports.toString()).toBe('20000');
  });

  it('rejects reward deltas above the on-chain cap before sending', async () => {
    const transport: ProgramTransport = {
      signerPublicKey: verifier,
      async fetchProtocolConfig() {
        return createProtocolConfigSnapshot();
      },
      async fetchUserProfile() {
        return null;
      },
      async submitVerifiedFootprint() {
        throw new Error('should not send');
      },
      async syncSbtState() {
        throw new Error('not used');
      },
      async fundTreasury() {
        throw new Error('not used');
      },
    };

    const client = new GreenReputationOracleClient({ programId, transport });

    await expect(
      client.submitVerifiedFootprint({
        user,
        periodKey: 202604n,
        commitmentPreimage: createCommitmentPreimage(),
        rewardDeltaLamports: 99_999n,
      }),
    ).rejects.toThrow('Reward delta exceeds on-chain reward policy cap.');
  });

  it('rejects verifier submissions when the configured signer is not the verifier', async () => {
    const transport: ProgramTransport = {
      signerPublicKey: metadataAuthority,
      async fetchProtocolConfig() {
        return createProtocolConfigSnapshot();
      },
      async fetchUserProfile() {
        return null;
      },
      async submitVerifiedFootprint() {
        throw new Error('should not send');
      },
      async syncSbtState() {
        throw new Error('not used');
      },
      async fundTreasury() {
        throw new Error('not used');
      },
    };

    const client = new GreenReputationOracleClient({ programId, transport });

    await expect(
      client.submitVerifiedFootprint({
        user,
        periodKey: 202604n,
        commitmentPreimage: createCommitmentPreimage(),
        rewardDeltaLamports: 20_000n,
      }),
    ).rejects.toThrow('Configured signer is not the authorized verifier.');
  });

  it('serializes metadata sync payloads consistently', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const transport: ProgramTransport = {
      signerPublicKey: metadataAuthority,
      async fetchProtocolConfig() {
        return createProtocolConfigSnapshot();
      },
      async fetchUserProfile() {
        return null;
      },
      async submitVerifiedFootprint() {
        throw new Error('not used');
      },
      async syncSbtState(input) {
        calls.push({ type: 'syncSbtState', input });
        return { signature: 'sig-sync-1' };
      },
      async fundTreasury(input) {
        calls.push({ type: 'fundTreasury', input });
        return { signature: 'sig-fund-1' };
      },
    };
    const client = new GreenReputationOracleClient({ programId, transport });
    const metadataUriHash = new Uint8Array(
      crypto
        .createHash('sha256')
        .update('https://metadata.example.test/doc.json')
        .digest(),
    );

    const syncResult = await client.syncSbtState({
      user,
      metadataVersion: 3,
      metadataUriHash,
    });

    const syncCall = calls.find((entry) => entry.type === 'syncSbtState') as {
      input: Record<string, any>;
    };

    expect(syncResult.signature).toBe('sig-sync-1');
    expect(syncCall.input.protocolConfig.toBase58()).toBe(
      findProtocolConfigPda(programId).toBase58(),
    );
    expect(syncCall.input.authority.toBase58()).toBe(
      metadataAuthority.toBase58(),
    );
    expect(syncCall.input.userProfile.toBase58()).toBe(
      findUserProfilePda(user, programId).toBase58(),
    );
    expect(syncCall.input.args.metadataVersion).toBe(3);
    expect(syncCall.input.args.metadataUriHash).toEqual(
      Array.from(metadataUriHash),
    );
  });

  it('serializes treasury funding payloads consistently', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const transport: ProgramTransport = {
      signerPublicKey: admin,
      async fetchProtocolConfig() {
        return createProtocolConfigSnapshot();
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
      async fundTreasury(input) {
        calls.push({ type: 'fundTreasury', input });
        return { signature: 'sig-fund-1' };
      },
    };
    const client = new GreenReputationOracleClient({ programId, transport });

    const fundResult = await client.fundTreasury(200_000n);
    const fundCall = calls.find((entry) => entry.type === 'fundTreasury') as {
      input: Record<string, any>;
    };

    expect(fundResult.signature).toBe('sig-fund-1');
    expect(fundCall.input.protocolConfig.toBase58()).toBe(
      findProtocolConfigPda(programId).toBase58(),
    );
    expect(fundCall.input.rewardTreasury.toBase58()).toBe(
      findRewardTreasuryPda(programId).toBase58(),
    );
    expect(fundCall.input.treasuryVault.toBase58()).toBe(
      findTreasuryVaultPda(programId).toBase58(),
    );
    expect(fundCall.input.admin.toBase58()).toBe(admin.toBase58());
    expect(fundCall.input.amountLamports.toString()).toBe('200000');
  });

  it('quotes rewards using the same cap semantics as the on-chain program', () => {
    const rewardPolicy = createProtocolConfigSnapshot().rewardPolicy;

    expect(quoteRewardLamports(rewardPolicy, 50n)).toBe(0n);
    expect(quoteRewardLamports(rewardPolicy, 2_000n)).toBe(20_000n);
    expect(quoteRewardLamports(rewardPolicy, 100_000n)).toBe(50_000n);
  });

  it('rejects treasury funding when the configured signer is not the protocol admin', async () => {
    const transport: ProgramTransport = {
      signerPublicKey: metadataAuthority,
      async fetchProtocolConfig() {
        return createProtocolConfigSnapshot();
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
        throw new Error('should not send');
      },
    };

    const client = new GreenReputationOracleClient({ programId, transport });

    await expect(client.fundTreasury(200_000n)).rejects.toThrow(
      'Configured signer is not the protocol admin.',
    );
  });
});
