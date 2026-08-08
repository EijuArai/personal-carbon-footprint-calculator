import { PublicKey } from '@solana/web3.js';

import type {
  MetadataPublisher,
  PublishMetadataResult,
} from '../metadata/index.js';
import type { GreenReputationOracleClient } from '../oracle/index.js';
import type {
  ClaimedOracleJob,
  OracleJobRecord,
  StateStore,
} from '../storage/state-store.js';
import logger from '../../utils/logger.js';

const DEFAULT_RUNNER_LOCK_KEY = 'oracle-job-runner';

export interface RetryableJobErrorOptions {
  code: string;
  message: string;
}

export class RetryableJobError extends Error {
  readonly code: string;

  constructor(options: RetryableJobErrorOptions) {
    super(options.message);
    this.code = options.code;
  }
}

export class TerminalJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MetadataSyncPreparationResult {
  metadataUriHash: Uint8Array;
  metadataVersion: number;
}

export interface RetryRunnerDependencies {
  stateStore: StateStore;
  oracleClient: Pick<
    GreenReputationOracleClient,
    'submitVerifiedFootprintJob' | 'syncSbtState' | 'fundTreasury'
  >;
  metadataPublisher?: MetadataPublisher;
  prepareMetadataSync?: (
    job: OracleJobRecord,
  ) => Promise<MetadataSyncPreparationResult> | MetadataSyncPreparationResult;
  now?: () => number;
  workerId?: string;
  runnerLockKey?: string;
  runnerLockDurationMs?: number;
  jobLockDurationMs?: number;
  backoffMs?: (attemptNumber: number, job: OracleJobRecord) => number;
}

export interface RunDueJobsResult {
  processedJobIds: number[];
}

export class OracleRetryRunner {
  readonly #stateStore: StateStore;
  readonly #oracleClient: RetryRunnerDependencies['oracleClient'];
  readonly #prepareMetadataSync?: RetryRunnerDependencies['prepareMetadataSync'];
  readonly #now: () => number;
  readonly #workerId: string;
  readonly #runnerLockKey: string;
  readonly #runnerLockDurationMs: number;
  readonly #jobLockDurationMs: number;
  readonly #backoffMs: (attemptNumber: number, job: OracleJobRecord) => number;

  constructor(dependencies: RetryRunnerDependencies) {
    this.#stateStore = dependencies.stateStore;
    this.#oracleClient = dependencies.oracleClient;
    this.#prepareMetadataSync = dependencies.prepareMetadataSync;
    this.#now = dependencies.now ?? Date.now;
    this.#workerId = dependencies.workerId ?? 'oracle-worker';
    this.#runnerLockKey = dependencies.runnerLockKey ?? DEFAULT_RUNNER_LOCK_KEY;
    this.#runnerLockDurationMs = dependencies.runnerLockDurationMs ?? 30_000;
    this.#jobLockDurationMs = dependencies.jobLockDurationMs ?? 30_000;
    this.#backoffMs = dependencies.backoffMs ?? defaultBackoffMs;
  }

  async runDueJobs(
    maxJobs = Number.POSITIVE_INFINITY,
  ): Promise<RunDueJobsResult> {
    const nowMs = this.#now();
    const runnerLock = this.#stateStore.acquireServiceLock({
      lockKey: this.#runnerLockKey,
      ownerId: this.#workerId,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + this.#runnerLockDurationMs,
    });

    if (!runnerLock) {
      return { processedJobIds: [] };
    }

    const processedJobIds: number[] = [];

    try {
      while (processedJobIds.length < maxJobs) {
        const claimed = this.#stateStore.claimPendingJob(
          this.#workerId,
          this.#now(),
          this.#jobLockDurationMs,
        );
        if (!claimed) {
          break;
        }

        processedJobIds.push(claimed.id);
        await this.#executeClaimedJob(claimed);
      }

      return { processedJobIds };
    } finally {
      this.#stateStore.releaseLock(this.#runnerLockKey);
    }
  }

  async executeJob(jobId: number): Promise<OracleJobRecord | undefined> {
    const claimed = this.#stateStore.claimOracleJobById(
      jobId,
      this.#workerId,
      this.#now(),
      this.#jobLockDurationMs,
    );
    if (!claimed) {
      return undefined;
    }

    return await this.#executeClaimedJob(claimed);
  }

  releaseLock(lockKey: string): void {
    this.#stateStore.releaseLock(lockKey);
  }

  async #executeClaimedJob(
    claimed: ClaimedOracleJob,
  ): Promise<OracleJobRecord> {
    const attemptNumber =
      this.#stateStore.listJobAttempts(claimed.id).length + 1;
    logger.info(
      {
        jobId: claimed.id,
        jobKind: claimed.kind,
        attemptNumber,
        workerId: this.#workerId,
      },
      'Executing oracle job',
    );
    this.#stateStore.startJobAttempt({
      jobId: claimed.id,
      attemptNumber,
      startedAtMs: this.#now(),
    });

    try {
      const execution = await this.#dispatchJob(claimed);
      const completedJob = this.#stateStore.completeOracleJob({
        jobId: claimed.id,
        lockKey: claimed.lockKey,
        finishedAtMs: this.#now(),
        transactionSignature: execution.signature,
      });

      logger.info(
        {
          jobId: claimed.id,
          jobKind: claimed.kind,
          attemptNumber,
          workerId: this.#workerId,
          transactionSignature: execution.signature,
        },
        'Oracle job completed successfully.',
      );

      return completedJob;
    } catch (error) {
      const details = classifyJobError(error);
      const failedJob = this.#stateStore.failOracleJob({
        jobId: claimed.id,
        lockKey: claimed.lockKey,
        finishedAtMs: this.#now(),
        ...(details.retryable
          ? {
              nextRunAfterMs:
                this.#now() + this.#backoffMs(attemptNumber, claimed),
            }
          : {}),
        errorCode: details.code,
        errorMessage: details.message,
        retryable: details.retryable,
      });

      logger.error(
        {
          err: error,
          jobId: claimed.id,
          jobKind: claimed.kind,
          attemptNumber,
          workerId: this.#workerId,
          retryable: details.retryable,
          errorCode: details.code,
        },
        'Oracle job execution failed.',
      );

      return failedJob;
    }
  }

  async #dispatchJob(job: OracleJobRecord): Promise<{ signature: string }> {
    switch (job.kind) {
      case 'submit_verified_footprint':
        return await this.#oracleClient.submitVerifiedFootprintJob(
          parseSubmitVerifiedFootprintJob(job),
        );
      case 'sync_sbt_state': {
        const prepared = this.#prepareMetadataSync?.(job);
        const syncPayload = prepared === undefined ? undefined : await prepared;

        const metadataUriHash =
          syncPayload?.metadataUriHash ??
          parseMetadataUriHash(job.metadataUriHash);
        const metadataVersion =
          syncPayload?.metadataVersion ?? job.metadataVersion;
        if (metadataVersion === undefined) {
          throw new TerminalJobError(
            'invalid_job_payload',
            'Missing metadata version for sync_sbt_state job.',
          );
        }

        return await this.#oracleClient.syncSbtState({
          user: parsePublicKey(
            job.userPubkey,
            'user pubkey for sync_sbt_state job',
          ),
          metadataVersion,
          metadataUriHash,
        });
      }
      case 'fund_treasury':
        if (job.amountLamports === undefined) {
          throw new TerminalJobError(
            'invalid_job_payload',
            'Missing amountLamports for fund_treasury job.',
          );
        }
        return await this.#oracleClient.fundTreasury(
          BigInt(job.amountLamports),
        );
    }
  }
}

export function classifyJobError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof RetryableJobError) {
    return { code: error.code, message: error.message, retryable: true };
  }

  if (error instanceof TerminalJobError) {
    return { code: error.code, message: error.message, retryable: false };
  }

  if (error instanceof Error) {
    const normalizedMessage = error.message.toLowerCase();
    if (
      normalizedMessage.includes('timeout') ||
      normalizedMessage.includes('unavailable') ||
      normalizedMessage.includes('429') ||
      normalizedMessage.includes('metadata publish') ||
      normalizedMessage.includes('confirmation')
    ) {
      return {
        code: inferRetryableErrorCode(normalizedMessage),
        message: error.message,
        retryable: true,
      };
    }

    return {
      code: 'job_execution_failed',
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: 'job_execution_failed',
    message: 'Unknown job execution failure.',
    retryable: false,
  };
}

function inferRetryableErrorCode(message: string): string {
  if (message.includes('metadata publish')) {
    return 'metadata_publish_failed';
  }
  if (message.includes('confirmation')) {
    return 'confirmation_timeout';
  }
  if (message.includes('unavailable') || message.includes('429')) {
    return 'rpc_unavailable';
  }
  return 'rpc_timeout';
}

function parseSubmitVerifiedFootprintJob(job: OracleJobRecord) {
  if (
    job.periodKey === undefined ||
    job.commitmentHash === undefined ||
    job.sourceKind === undefined ||
    job.emissionDeltaGrams === undefined ||
    job.reductionDeltaGrams === undefined ||
    job.rewardDeltaLamports === undefined
  ) {
    throw new TerminalJobError(
      'invalid_job_payload',
      'Missing required payload fields for submit_verified_footprint job.',
    );
  }

  return {
    user: parsePublicKey(
      job.userPubkey,
      'user pubkey for submit_verified_footprint job',
    ),
    periodKey: BigInt(job.periodKey),
    commitmentHash: parseMetadataUriHash(job.commitmentHash),
    sourceKind: parseSourceKind(job.sourceKind),
    emissionDeltaGrams: BigInt(job.emissionDeltaGrams),
    reductionDeltaGrams: BigInt(job.reductionDeltaGrams),
    rewardDeltaLamports: BigInt(job.rewardDeltaLamports),
  };
}

function parsePublicKey(value: string | undefined, label: string): PublicKey {
  if (!value) {
    throw new TerminalJobError('invalid_job_payload', `Missing ${label}.`);
  }

  try {
    return new PublicKey(value);
  } catch {
    throw new TerminalJobError('invalid_job_payload', `Invalid ${label}.`);
  }
}

function parseMetadataUriHash(value: string | undefined): Uint8Array {
  if (!value) {
    throw new TerminalJobError(
      'invalid_job_payload',
      'Missing 32-byte hash payload.',
    );
  }

  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new TerminalJobError(
      'invalid_job_payload',
      'Hash payload must be a 32-byte hex string.',
    );
  }

  return Uint8Array.from(Buffer.from(normalized, 'hex'));
}

function parseSourceKind(value: string) {
  switch (value) {
    // case "manual":
    case 'spend':
    case 'activity':
    // case 'receipt':
    case 'hybrid':
      return value;
    default:
      throw new TerminalJobError(
        'invalid_job_payload',
        `Unsupported source kind: ${value}`,
      );
  }
}

function defaultBackoffMs(attemptNumber: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attemptNumber - 1));
}
