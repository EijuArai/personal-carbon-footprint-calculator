export type OracleJobKind = "submit_verified_footprint" | "sync_sbt_state" | "fund_treasury";

export type OracleJobStatus =
  | "pending"
  | "running"
  | "retryable"
  | "failed"
  | "completed";

export type JobAttemptOutcome = "running" | "retryable" | "failed" | "completed";

export interface ReserveNonceInput {
  nonce: string;
  issuer: string;
  audience: string;
  subject: string;
  expiresAtMs: number;
  reservedAtMs: number;
}

export interface UsedNonceRecord extends ReserveNonceInput {}

export interface OracleJobInput {
  kind: OracleJobKind;
  idempotencyKey: string;
  userPubkey?: string;
  userProfilePubkey?: string;
  periodKey?: number;
  commitmentHash?: string;
  metadataUriHash?: string;
  metadataVersion?: number;
  sourceKind?: string;
  emissionDeltaGrams?: number;
  reductionDeltaGrams?: number;
  rewardDeltaLamports?: number;
  amountLamports?: number;
  runAfterMs: number;
  createdAtMs: number;
}

export interface OracleJobRecord {
  id: number;
  kind: OracleJobKind;
  idempotencyKey: string;
  userPubkey: string | undefined;
  userProfilePubkey: string | undefined;
  periodKey: number | undefined;
  commitmentHash: string | undefined;
  metadataUriHash: string | undefined;
  metadataVersion: number | undefined;
  sourceKind: string | undefined;
  emissionDeltaGrams: number | undefined;
  reductionDeltaGrams: number | undefined;
  rewardDeltaLamports: number | undefined;
  amountLamports: number | undefined;
  runAfterMs: number;
  status: OracleJobStatus;
  claimedBy: string | undefined;
  claimedAtMs: number | undefined;
  completedAtMs: number | undefined;
  lastErrorCode: string | undefined;
  lastErrorMessage: string | undefined;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ClaimedOracleJob extends OracleJobRecord {
  lockKey: string;
}

export interface JobAttemptStartInput {
  jobId: number;
  attemptNumber: number;
  startedAtMs: number;
}

export interface JobAttemptRecord {
  id: number;
  jobId: number;
  attemptNumber: number;
  startedAtMs: number;
  finishedAtMs: number | undefined;
  outcome: JobAttemptOutcome;
  errorCode: string | undefined;
  errorMessage: string | undefined;
  transactionSignature: string | undefined;
}

export interface CompleteOracleJobInput {
  jobId: number;
  lockKey: string;
  finishedAtMs: number;
  transactionSignature?: string;
}

export interface FailOracleJobInput {
  jobId: number;
  lockKey: string;
  finishedAtMs: number;
  nextRunAfterMs?: number;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
}

export interface AcquireServiceLockInput {
  lockKey: string;
  ownerId: string;
  acquiredAtMs: number;
  expiresAtMs: number;
}

export interface ServiceLockRecord {
  lockKey: string;
  ownerId: string;
  acquiredAtMs: number;
  expiresAtMs: number;
}

export interface StateStore {
  reserveNonce(input: ReserveNonceInput): UsedNonceRecord;
  findNonce(nonce: string): UsedNonceRecord | undefined;
  enqueueOracleJob(input: OracleJobInput): OracleJobRecord;
  findOracleJobById(id: number): OracleJobRecord | undefined;
  findOracleJobByIdempotencyKey(idempotencyKey: string): OracleJobRecord | undefined;
  claimPendingJob(workerId: string, nowMs: number, lockDurationMs: number): ClaimedOracleJob | undefined;
  claimOracleJobById(jobId: number, workerId: string, nowMs: number, lockDurationMs: number): ClaimedOracleJob | undefined;
  startJobAttempt(input: JobAttemptStartInput): JobAttemptRecord;
  completeOracleJob(input: CompleteOracleJobInput): OracleJobRecord;
  failOracleJob(input: FailOracleJobInput): OracleJobRecord;
  listJobAttempts(jobId: number): JobAttemptRecord[];
  acquireServiceLock(input: AcquireServiceLockInput): ServiceLockRecord | undefined;
  releaseLock(lockKey: string): void;
}