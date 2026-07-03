import crypto from 'node:crypto';

import { AnchorProvider, Program } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import greenReputationIdl from '../../../../solana/target/idl/green_reputation.json' with { type: 'json' };
import type {
  CanonicalDataSourceKind,
  CommitmentPreimageV1,
} from '../lca/index.js';

const PROTOCOL_CONFIG_SEED = Buffer.from('protocol-config');
const USER_PROFILE_SEED = Buffer.from('user-profile');
const FOOTPRINT_COMMITMENT_SEED = Buffer.from('footprint-commitment');
const REWARD_TREASURY_SEED = Buffer.from('reward-treasury');
const REWARD_TREASURY_VAULT_SEED = Buffer.from('reward-treasury-vault');

type AnchorWallet = {
  publicKey: PublicKey;
  signTransaction<T>(transaction: T): Promise<T>;
  signAllTransactions<T>(transactions: T[]): Promise<T[]>;
};

export interface RewardPolicySnapshot {
  lamportsPerKgReduced: bigint;
  minimumReductionGrams: bigint;
  maxLamportsPerPeriod: bigint;
  maxPendingLamports: bigint;
}

export interface RankThresholdsSnapshot {
  seedlingMinReductionGrams: bigint;
  saplingMinReductionGrams: bigint;
  treeMinReductionGrams: bigint;
  forestMinReductionGrams: bigint;
}

export interface ProtocolConfigSnapshot {
  admin: PublicKey;
  verifier: PublicKey;
  metadataUpdateAuthority: PublicKey;
  treasuryAuthority: PublicKey;
  rewardPolicy: RewardPolicySnapshot;
  rankThresholds: RankThresholdsSnapshot;
}

export interface UserProfileSnapshot {
  user: PublicKey;
  lastVerifiedAt: number;
  metadataVersion: number;
  emissionHistory: Uint8Array;
}

export interface SubmitVerifiedFootprintPayload {
  user: PublicKey;
  periodKey: bigint;
  commitmentPreimage: CommitmentPreimageV1;
  rewardDeltaLamports: bigint;
}

export interface SubmitVerifiedFootprintJobPayload {
  user: PublicKey;
  periodKey: bigint;
  commitmentHash: Uint8Array;
  sourceKind: CanonicalDataSourceKind;
  emissionDeltaGrams: bigint;
  reductionDeltaGrams: bigint;
  rewardDeltaLamports: bigint;
}

export interface SyncSbtStatePayload {
  user: PublicKey;
  metadataVersion: number;
  metadataUriHash: Uint8Array;
}

export interface OracleSubmissionResult {
  signature: string;
  footprintCommitment: PublicKey;
}

export interface SyncResult {
  signature: string;
}

export interface TreasuryFundingResult {
  signature: string;
}

export interface ProgramTransport {
  signerPublicKey: PublicKey;
  fetchProtocolConfig(address: PublicKey): Promise<ProtocolConfigSnapshot>;
  fetchUserProfile(address: PublicKey): Promise<UserProfileSnapshot | null>;
  submitVerifiedFootprint(input: {
    protocolConfig: PublicKey;
    verifier: PublicKey;
    user: PublicKey;
    userProfile: PublicKey;
    rewardTreasury: PublicKey;
    footprintCommitment: PublicKey;
    args: {
      periodKey: BN;
      commitmentHash: number[];
      sourceKind: Record<string, object>;
      emissionDeltaGrams: BN;
      reductionDeltaGrams: BN;
      rewardDeltaLamports: BN;
    };
  }): Promise<{ signature: string }>;
  syncSbtState(input: {
    protocolConfig: PublicKey;
    authority: PublicKey;
    userProfile: PublicKey;
    args: {
      metadataVersion: number;
      metadataUriHash: number[];
    };
  }): Promise<{ signature: string }>;
  fundTreasury(input: {
    protocolConfig: PublicKey;
    admin: PublicKey;
    rewardTreasury: PublicKey;
    treasuryVault: PublicKey;
    amountLamports: BN;
  }): Promise<{ signature: string }>;
}

export interface OracleClientOptions {
  programId: PublicKey;
  transport: ProgramTransport;
}

export class GreenReputationOracleClient {
  readonly #programId: PublicKey;
  readonly #transport: ProgramTransport;

  constructor(options: OracleClientOptions) {
    this.#programId = options.programId;
    this.#transport = options.transport;
  }

  async loadProtocolConfig(): Promise<ProtocolConfigSnapshot> {
    return await this.#transport.fetchProtocolConfig(
      findProtocolConfigPda(this.#programId),
    );
  }

  async loadUserProfile(user: PublicKey): Promise<UserProfileSnapshot | null> {
    return await this.#transport.fetchUserProfile(
      findUserProfilePda(user, this.#programId),
    );
  }

  async submitVerifiedFootprint(
    payload: SubmitVerifiedFootprintPayload,
  ): Promise<OracleSubmissionResult> {
    return await this.submitVerifiedFootprintJob({
      user: payload.user,
      periodKey: payload.periodKey,
      commitmentHash: hashCommitmentPreimage(payload.commitmentPreimage),
      sourceKind: payload.commitmentPreimage.dataSourceKind,
      emissionDeltaGrams: toGrams(
        payload.commitmentPreimage.totalEmissionsKgCo2e,
      ),
      reductionDeltaGrams: toGrams(payload.commitmentPreimage.baseReductionKgCo2e),
      rewardDeltaLamports: payload.rewardDeltaLamports,
    });
  }

  async submitVerifiedFootprintJob(
    payload: SubmitVerifiedFootprintJobPayload,
  ): Promise<OracleSubmissionResult> {
    const protocolConfig = await this.loadProtocolConfig();
    if (!this.#transport.signerPublicKey.equals(protocolConfig.verifier)) {
      throw new Error('Configured signer is not the authorized verifier.');
    }

    const quotedReward = quoteRewardLamports(
      protocolConfig.rewardPolicy,
      payload.reductionDeltaGrams,
    );
    if (payload.rewardDeltaLamports > quotedReward) {
      throw new Error('Reward delta exceeds on-chain reward policy cap.');
    }

    const footprintCommitment = findFootprintCommitmentPda(
      payload.user,
      payload.periodKey,
      payload.commitmentHash,
      this.#programId,
    );

    const signature = await this.#transport.submitVerifiedFootprint({
      protocolConfig: findProtocolConfigPda(this.#programId),
      verifier: protocolConfig.verifier,
      user: payload.user,
      userProfile: findUserProfilePda(payload.user, this.#programId),
      rewardTreasury: findRewardTreasuryPda(this.#programId),
      footprintCommitment,
      args: {
        periodKey: new BN(payload.periodKey.toString()),
        commitmentHash: Array.from(payload.commitmentHash),
        sourceKind: toAnchorDataSourceKind(payload.sourceKind),
        emissionDeltaGrams: new BN(payload.emissionDeltaGrams.toString()),
        reductionDeltaGrams: new BN(payload.reductionDeltaGrams.toString()),
        rewardDeltaLamports: new BN(payload.rewardDeltaLamports.toString()),
      },
    });

    return { signature: signature.signature, footprintCommitment };
  }

  async syncSbtState(payload: SyncSbtStatePayload): Promise<SyncResult> {
    const protocolConfig = await this.loadProtocolConfig();
    const canSyncMetadata =
      this.#transport.signerPublicKey.equals(protocolConfig.admin) ||
      this.#transport.signerPublicKey.equals(protocolConfig.verifier) ||
      this.#transport.signerPublicKey.equals(
        protocolConfig.metadataUpdateAuthority,
      );
    if (!canSyncMetadata) {
      throw new Error('Configured signer is not authorized to sync metadata.');
    }

    const signature = await this.#transport.syncSbtState({
      protocolConfig: findProtocolConfigPda(this.#programId),
      authority: this.#transport.signerPublicKey,
      userProfile: findUserProfilePda(payload.user, this.#programId),
      args: {
        metadataVersion: payload.metadataVersion,
        metadataUriHash: Array.from(payload.metadataUriHash),
      },
    });

    return { signature: signature.signature };
  }

  async fundTreasury(amountLamports: bigint): Promise<TreasuryFundingResult> {
    const protocolConfig = await this.loadProtocolConfig();
    if (!this.#transport.signerPublicKey.equals(protocolConfig.admin)) {
      throw new Error('Configured signer is not the protocol admin.');
    }

    const signature = await this.#transport.fundTreasury({
      protocolConfig: findProtocolConfigPda(this.#programId),
      admin: protocolConfig.admin,
      rewardTreasury: findRewardTreasuryPda(this.#programId),
      treasuryVault: findTreasuryVaultPda(this.#programId),
      amountLamports: new BN(amountLamports.toString()),
    });

    return { signature: signature.signature };
  }
}

export interface CreateAnchorProgramTransportOptions {
  connection: Connection;
  programId: PublicKey;
  signer: Keypair;
}

export function createAnchorProgramTransport(
  options: CreateAnchorProgramTransportOptions,
): ProgramTransport {
  const wallet = createAnchorWallet(options.signer);
  const provider = new AnchorProvider(options.connection, wallet, {
    commitment: 'confirmed',
  });
  const program = new Program(
    greenReputationIdl as never,
    provider,
  ) as Program & {
    account: {
      protocolConfig: {
        fetch(address: PublicKey): Promise<any>;
      };
      userProfile: {
        fetch(address: PublicKey): Promise<any>;
      };
    };
    methods: Record<string, unknown>;
    programId: PublicKey;
  };

  if (!program.programId.equals(options.programId)) {
    throw new Error('Configured program id does not match the IDL program id.');
  }

  return {
    signerPublicKey: options.signer.publicKey,
    async fetchProtocolConfig(address) {
      const account = await program.account.protocolConfig.fetch(address);
      return {
        admin: account.admin,
        verifier: account.verifier,
        metadataUpdateAuthority: account.metadataUpdateAuthority,
        treasuryAuthority: account.treasuryAuthority,
        rewardPolicy: {
          lamportsPerKgReduced: BigInt(
            account.rewardPolicy.lamportsPerKgReduced.toString(),
          ),
          minimumReductionGrams: BigInt(
            account.rewardPolicy.minimumReductionGrams.toString(),
          ),
          maxLamportsPerPeriod: BigInt(
            account.rewardPolicy.maxLamportsPerPeriod.toString(),
          ),
          maxPendingLamports: BigInt(
            account.rewardPolicy.maxPendingLamports.toString(),
          ),
        },
        rankThresholds: {
          seedlingMinReductionGrams: BigInt(
            account.rankThresholds.seedlingMinReductionGrams.toString(),
          ),
          saplingMinReductionGrams: BigInt(
            account.rankThresholds.saplingMinReductionGrams.toString(),
          ),
          treeMinReductionGrams: BigInt(
            account.rankThresholds.treeMinReductionGrams.toString(),
          ),
          forestMinReductionGrams: BigInt(
            account.rankThresholds.forestMinReductionGrams.toString(),
          ),
        },
      };
    },
    async fetchUserProfile(address) {
      try {
        const account = await program.account.userProfile.fetch(address);
        return {
          user: account.user,
          lastVerifiedAt: Number(account.lastVerifiedAt.toString()),
          metadataVersion: Number(account.metadataVersion),
          emissionHistory: normalizeByteArray(account.emissionHistory),
        };
      } catch (error) {
        if (isMissingAccountError(error)) {
          return null;
        }

        throw error;
      }
    },
    async submitVerifiedFootprint(input) {
      const signature = await (program.methods as any)
        .submitVerifiedFootprint(input.args)
        .accounts({
          protocolConfig: input.protocolConfig,
          verifier: input.verifier,
          user: input.user,
          userProfile: input.userProfile,
          rewardTreasury: input.rewardTreasury,
          footprintCommitment: input.footprintCommitment,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return { signature };
    },
    async syncSbtState(input) {
      const signature = await (program.methods as any)
        .syncSbtState(input.args)
        .accounts({
          protocolConfig: input.protocolConfig,
          authority: input.authority,
          userProfile: input.userProfile,
        })
        .rpc();
      return { signature };
    },
    async fundTreasury(input) {
      const signature = await (program.methods as any)
        .fundTreasury(input.amountLamports)
        .accounts({
          protocolConfig: input.protocolConfig,
          admin: input.admin,
          rewardTreasury: input.rewardTreasury,
          treasuryVault: input.treasuryVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return { signature };
    },
  };
}

export function findProtocolConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([PROTOCOL_CONFIG_SEED], programId)[0];
}

export function findUserProfilePda(
  user: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [USER_PROFILE_SEED, user.toBuffer()],
    programId,
  )[0];
}

export function findFootprintCommitmentPda(
  user: PublicKey,
  periodKey: bigint,
  commitmentHash: Uint8Array,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      FOOTPRINT_COMMITMENT_SEED,
      user.toBuffer(),
      new BN(periodKey.toString()).toArrayLike(Buffer, 'le', 8),
      Buffer.from(commitmentHash),
    ],
    programId,
  )[0];
}

export function findRewardTreasuryPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([REWARD_TREASURY_SEED], programId)[0];
}

export function findTreasuryVaultPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [REWARD_TREASURY_VAULT_SEED],
    programId,
  )[0];
}

export function quoteRewardLamports(
  rewardPolicy: RewardPolicySnapshot,
  reductionGrams: bigint,
): bigint {
  if (reductionGrams < rewardPolicy.minimumReductionGrams) {
    return 0n;
  }

  const raw = (reductionGrams * rewardPolicy.lamportsPerKgReduced) / 1000n;
  return raw > rewardPolicy.maxLamportsPerPeriod
    ? rewardPolicy.maxLamportsPerPeriod
    : raw;
}

function normalizeByteArray(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]);
  }

  throw new Error('Anchor account returned an unexpected byte-array value.');
}

function isMissingAccountError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /account does not exist|account not initialized|could not find account/i.test(
      error.message,
    )
  );
}

export function hashCommitmentPreimage(
  commitment: CommitmentPreimageV1,
): Uint8Array {
  return new Uint8Array(
    crypto.createHash('sha256').update(JSON.stringify(commitment)).digest(),
  );
}

function toAnchorDataSourceKind(
  sourceKind: CanonicalDataSourceKind,
): Record<string, object> {
  switch (sourceKind) {
    // case 'manual':
    //   return { manual: {} };
    case 'spend':
      return { spend: {} };
    case 'activity':
      return { activity: {} };
    // case 'receipt':
    //   return { receipt: {} };
    case 'hybrid':
      return { hybrid: {} };
  }
}

function toGrams(valueInKg: number): bigint {
  return BigInt(Math.round(valueInKg * 1000));
}

function createAnchorWallet(signer: Keypair): AnchorWallet {
  return {
    publicKey: signer.publicKey,
    async signTransaction(transaction) {
      if (
        typeof transaction === 'object' &&
        transaction !== null &&
        'partialSign' in transaction &&
        typeof (transaction as { partialSign?: unknown }).partialSign ===
          'function'
      ) {
        (transaction as { partialSign(signer: Keypair): void }).partialSign(
          signer,
        );
      }

      return transaction;
    },
    async signAllTransactions(transactions) {
      for (const transaction of transactions) {
        if (
          typeof transaction === 'object' &&
          transaction !== null &&
          'partialSign' in transaction &&
          typeof (transaction as { partialSign?: unknown }).partialSign ===
            'function'
        ) {
          (transaction as { partialSign(signer: Keypair): void }).partialSign(
            signer,
          );
        }
      }

      return transactions;
    },
  };
}
