import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

import type { AuthContext } from './auth-service.js';
import { AppError } from '../../lib/app-error.js';
import type {
  HistoricalData,
  LcaOrchestrator,
  RawLcaRequestInput,
} from '../lca/index.js';
import type { MetadataPublisher } from '../metadata/index.js';
import {
  findUserProfilePda,
  hashCommitmentPreimage,
  quoteRewardLamports,
  type GreenReputationOracleClient,
  type UserProfileSnapshot,
} from '../oracle/index.js';
import type { OracleJobRecord, StateStore } from '../storage/state-store.js';
import logger from '../../utils/logger.js';

const publicProfileSchema = z.object({
  displayAlias: z.string().min(1),
  countryCode: z.string().max(2).default(''),
  avatarUri: z.string().default(''),
});

const aggregateStateHintSchema = z.object({
  totalEmissionsKgCo2e: z.number().finite().nonnegative().default(0),
  totalReductionsKgCo2e: z.number().finite().nonnegative().default(0),
  pendingRewardLamports: z.coerce.bigint().default(0n),
});

export const decryptedFootprintSubmissionSchema = z.object({
  userPubkey: z.string().min(1),
  currentMetadataVersion: z.coerce.number().int().nonnegative().default(0),
  publicProfile: publicProfileSchema,
  aggregateStateHint: aggregateStateHintSchema.default({
    totalEmissionsKgCo2e: 0,
    totalReductionsKgCo2e: 0,
    pendingRewardLamports: 0n,
  }),
  lca: z.custom<RawLcaRequestInput>(),
});

export type DecryptedFootprintSubmission = z.infer<
  typeof decryptedFootprintSubmissionSchema
>;

export interface FootprintOrchestrationDependencies {
  stateStore: StateStore;
  lcaOrchestrator: LcaOrchestrator;
  metadataPublisher: MetadataPublisher;
  oracleClient: Pick<
    GreenReputationOracleClient,
    'loadProtocolConfig' | 'loadUserProfile'
  >;
  programId: PublicKey;
  now?: () => number;
}

export interface FootprintIngestionResult {
  subject: string;
  nonce: string;
  requestId: string;
  aggregateResult: {
    totalEmissionsKgCo2e: number;
    baseReductionKgCo2e: number;
    finalRewards: number;
    multiplierApplied: number;
    dataSourceKind: string;
    categories: string[];
  };
  metadata: {
    uri: string;
    metadataVersion: number;
  };
  jobs: Array<{
    id: number;
    kind: string;
    status: string;
  }>;
}

export class FootprintOrchestrationService {
  readonly #stateStore: StateStore;
  readonly #lcaOrchestrator: LcaOrchestrator;
  readonly #metadataPublisher: MetadataPublisher;
  readonly #oracleClient: Pick<
    GreenReputationOracleClient,
    'loadProtocolConfig' | 'loadUserProfile'
  >;
  readonly #programId: PublicKey;
  readonly #now: () => number;

  constructor(dependencies: FootprintOrchestrationDependencies) {
    this.#stateStore = dependencies.stateStore;
    this.#lcaOrchestrator = dependencies.lcaOrchestrator;
    this.#metadataPublisher = dependencies.metadataPublisher;
    this.#oracleClient = dependencies.oracleClient;
    this.#programId = dependencies.programId;
    this.#now = dependencies.now ?? Date.now;
  }

  async ingestDecryptedPayload(
    decryptedPayload: unknown,
    authContext: AuthContext,
    requestId: string,
  ): Promise<FootprintIngestionResult> {
    const parsed =
      decryptedFootprintSubmissionSchema.safeParse(decryptedPayload);
    if (!parsed.success) {
      logger.error(
        { err: parsed.error },
        'Decrypted payload failed validation against the ingestion contract.',
      );
      throw new AppError(
        'invalid_decrypted_payload',
        400,
        'Decrypted payload does not match the ingestion contract.',
      );
    }

    const submission = parsed.data;
    const userPubkey = parseUserPubkey(submission.userPubkey);
    const normalized = this.#lcaOrchestrator.normalizeInput(submission.lca);
    const userProfile = await this.#oracleClient.loadUserProfile(userPubkey);
    const historicalData = deriveHistoricalDataFromUserProfile(
      userProfile,
      Math.max(
        Math.floor(this.#now() / 1000),
        userProfile?.lastVerifiedAt ?? 0,
      ),
    );
    const lcaResult = this.#lcaOrchestrator.calculateFootprint(
      normalized.spendData,
      normalized.activityData,
      historicalData,
    );
    const commitmentPreimage = this.#lcaOrchestrator.buildCommitmentPayload(
      lcaResult,
      {
        ...normalized,
        history: historicalData,
      },
    );
    const commitmentHash = hashCommitmentPreimage(commitmentPreimage);
    const protocolConfig = await this.#oracleClient.loadProtocolConfig();
    const rewardDeltaLamports = quoteRewardLamports(
      protocolConfig.rewardPolicy,
      BigInt(Math.round(lcaResult.baseReduction * 1000)),
    );

    const totalEmissionsKgCo2e =
      submission.aggregateStateHint.totalEmissionsKgCo2e +
      lcaResult.totalEmissions;
    const totalReductionsKgCo2e =
      submission.aggregateStateHint.totalReductionsKgCo2e +
      lcaResult.baseReduction;
    const pendingRewardLamports =
      submission.aggregateStateHint.pendingRewardLamports + rewardDeltaLamports;
    const totalReductionGrams = BigInt(
      Math.round(totalReductionsKgCo2e * 1000),
    );
    const rank = deriveRank(totalReductionGrams, protocolConfig.rankThresholds);
    const metadataVersion = submission.currentMetadataVersion + 1;

    const document = this.#metadataPublisher.buildMetadataDocument(
      submission.publicProfile,
      {
        totalEmissionsKgCo2e,
        totalReductionsKgCo2e,
        pendingRewardLamports,
        rank,
        ...(normalized.periodKey === undefined
          ? {}
          : { latestPeriodKey: normalized.periodKey }),
      },
      commitmentPreimage,
    );
    const publishedMetadata = await this.#metadataPublisher.publishMetadata(
      document,
      metadataVersion,
    );

    const nowMs = this.#now();
    const userProfilePubkey = findUserProfilePda(
      userPubkey,
      this.#programId,
    ).toBase58();
    const commitmentHashHex = Buffer.from(commitmentHash).toString('hex');
    const metadataUriHashHex = Buffer.from(
      publishedMetadata.metadataUriHash,
    ).toString('hex');
    const submitJob = this.#stateStore.enqueueOracleJob({
      kind: 'submit_verified_footprint',
      idempotencyKey: `${submission.userPubkey}:${normalized.periodKey ?? 'no-period'}:${commitmentHashHex}`,
      userPubkey: submission.userPubkey,
      userProfilePubkey,
      periodKey: normalizeQueuedPeriodKey(normalized.periodKey),
      commitmentHash: commitmentHashHex,
      sourceKind: commitmentPreimage.dataSourceKind,
      emissionDeltaGrams: Math.round(lcaResult.totalEmissions * 1000),
      reductionDeltaGrams: Math.round(lcaResult.baseReduction * 1000),
      rewardDeltaLamports: Number(rewardDeltaLamports),
      runAfterMs: nowMs,
      createdAtMs: nowMs,
    });
    const syncJob = this.#stateStore.enqueueOracleJob({
      kind: 'sync_sbt_state',
      idempotencyKey: `${submission.userPubkey}:metadata:${metadataVersion}:${metadataUriHashHex}`,
      userPubkey: submission.userPubkey,
      userProfilePubkey,
      metadataUriHash: metadataUriHashHex,
      metadataVersion,
      runAfterMs: nowMs,
      createdAtMs: nowMs,
    });

    logger.info(
      {
        requestId,
        userPubkey: submission.userPubkey,
        commitmentHash: commitmentHashHex,
        metadataUriHash: metadataUriHashHex,
        totalEmissionsKgCo2e: lcaResult.totalEmissions,
        baseReductionKgCo2e: lcaResult.baseReduction,
        finalRewards: lcaResult.finalRewards,
        multiplierApplied: lcaResult.multiplierApplied,
        rewardDeltaLamports: rewardDeltaLamports.toString(),
        rank,
        submitJobId: submitJob.id,
        syncJobId: syncJob.id,
      },
      'Successfully ingested footprint submission and enqueued jobs.',
    );
    return {
      subject: authContext.subject,
      nonce: authContext.nonce,
      requestId,
      aggregateResult: {
        totalEmissionsKgCo2e: lcaResult.totalEmissions,
        baseReductionKgCo2e: lcaResult.baseReduction,
        finalRewards: lcaResult.finalRewards,
        multiplierApplied: lcaResult.multiplierApplied,
        dataSourceKind: commitmentPreimage.dataSourceKind,
        categories: normalized.sourceSummary.categories,
      },
      metadata: {
        uri: publishedMetadata.uri,
        metadataVersion,
      },
      jobs: [submitJob, syncJob].map(mapJobSummary),
    };
  }
}

function parseUserPubkey(value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new AppError(
      'invalid_user_pubkey',
      400,
      'Decrypted payload user pubkey is invalid.',
    );
  }
}

function mapJobSummary(job: OracleJobRecord) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
  };
}

function deriveRank(
  totalReductionGrams: bigint,
  thresholds: {
    seedlingMinReductionGrams: bigint;
    saplingMinReductionGrams: bigint;
    treeMinReductionGrams: bigint;
    forestMinReductionGrams: bigint;
  },
): string {
  if (totalReductionGrams >= thresholds.forestMinReductionGrams) {
    return 'Forest';
  }
  if (totalReductionGrams >= thresholds.treeMinReductionGrams) {
    return 'Tree';
  }
  if (totalReductionGrams >= thresholds.saplingMinReductionGrams) {
    return 'Sapling';
  }
  if (totalReductionGrams >= thresholds.seedlingMinReductionGrams) {
    return 'Seedling';
  }
  return 'Sprout';
}

function normalizeQueuedPeriodKey(periodKey: string | undefined): number {
  if (!periodKey) {
    return 0;
  }

  const normalized = periodKey.replace(/[^0-9]/g, '');
  if (!normalized || !/^[0-9]+$/.test(normalized)) {
    throw new AppError(
      'invalid_period_key',
      400,
      'Period key must contain digits only or a YYYY-MM style value.',
    );
  }

  const numeric = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new AppError(
      'invalid_period_key',
      400,
      'Period key is outside the supported range.',
    );
  }

  return numeric;
}

const DAILY_EMISSION_HISTORY_ENTRY_BYTES = 16;
const DAILY_EMISSION_HISTORY_DAYS = 30;
const SECONDS_PER_DAY = 86_400;

function deriveHistoricalDataFromUserProfile(
  userProfile: UserProfileSnapshot | null,
  asOfTimestamp: number,
): HistoricalData {
  if (!userProfile) {
    return { pastAverageMonthlyEmissions: 0 };
  }

  const entries = decodeEmissionHistory(userProfile.emissionHistory);
  const currentDayStart = dayBucketStart(asOfTimestamp);
  const windowStart =
    currentDayStart - DAILY_EMISSION_HISTORY_DAYS * SECONDS_PER_DAY;
  const activeEntries = entries.filter(
    (entry) =>
      entry.dayStartTimestamp >= windowStart &&
      entry.dayStartTimestamp < currentDayStart,
  );

  if (activeEntries.length === 0) {
    return { pastAverageMonthlyEmissions: 0 };
  }

  activeEntries.sort(
    (left, right) => left.dayStartTimestamp - right.dayStartTimestamp,
  );
  const firstEntry = activeEntries[0];

  if (
    activeEntries.length < DAILY_EMISSION_HISTORY_DAYS ||
    !firstEntry ||
    firstEntry.dayStartTimestamp > windowStart
  ) {
    return { pastAverageMonthlyEmissions: 0 };
  }

  const totalGrams = activeEntries.reduce(
    (total, entry) => total + entry.emissionGrams,
    0,
  );

  return {
    pastAverageMonthlyEmissions: Number(
      (totalGrams / 1000 / DAILY_EMISSION_HISTORY_DAYS).toFixed(2),
    ),
  };
}

function decodeEmissionHistory(bytes: Uint8Array) {
  if (bytes.length === 0) {
    return [];
  }

  if (bytes.length % DAILY_EMISSION_HISTORY_ENTRY_BYTES !== 0) {
    throw new AppError(
      'invalid_emission_history',
      500,
      'On-chain emission history bytes are malformed.',
    );
  }

  const entries: Array<{ dayStartTimestamp: number; emissionGrams: number }> =
    [];
  for (
    let offset = 0;
    offset < bytes.length;
    offset += DAILY_EMISSION_HISTORY_ENTRY_BYTES
  ) {
    const chunk = bytes.slice(
      offset,
      offset + DAILY_EMISSION_HISTORY_ENTRY_BYTES,
    );
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const dayStartTimestamp = Number(view.getBigInt64(0, true));
    const emissionGrams = Number(view.getBigUint64(8, true));
    entries.push({ dayStartTimestamp, emissionGrams });
  }

  return entries;
}

function dayBucketStart(timestamp: number): number {
  return Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}
