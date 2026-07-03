import Database from 'better-sqlite3';

import type {
  AcquireServiceLockInput,
  ClaimedOracleJob,
  CompleteOracleJobInput,
  FailOracleJobInput,
  JobAttemptRecord,
  JobAttemptStartInput,
  OracleJobInput,
  OracleJobRecord,
  ReserveNonceInput,
  ServiceLockRecord,
  StateStore,
  UsedNonceRecord,
} from '../modules/storage/state-store.js';
import logger from '../utils/logger.js';

const JOB_LOCK_PREFIX = 'oracle_job:';

export interface DatabaseHandle {
  kind: 'sqlite';
  connection: Database.Database;
}

export interface CreateDatabaseOptions {
  filename?: string;
}

type NonceRow = {
  nonce: string;
  issuer: string;
  audience: string;
  subject: string;
  expires_at_ms: number;
  reserved_at_ms: number;
};

type OracleJobRow = {
  id: number;
  kind: OracleJobRecord['kind'];
  idempotency_key: string;
  user_pubkey: string | null;
  user_profile_pubkey: string | null;
  period_key: number | null;
  commitment_hash: string | null;
  metadata_uri_hash: string | null;
  metadata_version: number | null;
  source_kind: string | null;
  emission_delta_grams: number | null;
  reduction_delta_grams: number | null;
  reward_delta_lamports: number | null;
  amount_lamports: number | null;
  status: OracleJobRecord['status'];
  claimed_by: string | null;
  claimed_at_ms: number | null;
  completed_at_ms: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  run_after_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
};

type AttemptRow = {
  id: number;
  job_id: number;
  attempt_number: number;
  started_at_ms: number;
  finished_at_ms: number | null;
  outcome: JobAttemptRecord['outcome'];
  error_code: string | null;
  error_message: string | null;
  transaction_signature: string | null;
};

type LockRow = {
  lock_key: string;
  owner_id: string;
  acquired_at_ms: number;
  expires_at_ms: number;
};

function applyPragmas(connection: Database.Database): void {
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');
}

function migrate(connection: Database.Database): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS used_nonces (
      nonce TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      audience TEXT NOT NULL,
      subject TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      reserved_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oracle_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      user_pubkey TEXT,
      user_profile_pubkey TEXT,
      period_key INTEGER,
      commitment_hash TEXT,
      metadata_uri_hash TEXT,
      metadata_version INTEGER,
      source_kind TEXT,
      emission_delta_grams INTEGER,
      reduction_delta_grams INTEGER,
      reward_delta_lamports INTEGER,
      amount_lamports INTEGER,
      status TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at_ms INTEGER,
      completed_at_ms INTEGER,
      last_error_code TEXT,
      last_error_message TEXT,
      run_after_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      attempt_number INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      outcome TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      transaction_signature TEXT,
      UNIQUE(job_id, attempt_number),
      FOREIGN KEY(job_id) REFERENCES oracle_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS service_locks (
      lock_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_used_nonces_expires_at_ms ON used_nonces(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_oracle_jobs_status_run_after_ms ON oracle_jobs(status, run_after_ms);
    CREATE INDEX IF NOT EXISTS idx_job_attempts_job_id ON job_attempts(job_id);
    CREATE INDEX IF NOT EXISTS idx_service_locks_expires_at_ms ON service_locks(expires_at_ms);
  `);
}

function mapNonce(row: NonceRow): UsedNonceRecord {
  return {
    nonce: row.nonce,
    issuer: row.issuer,
    audience: row.audience,
    subject: row.subject,
    expiresAtMs: row.expires_at_ms,
    reservedAtMs: row.reserved_at_ms,
  };
}

function mapOracleJob(row: OracleJobRow): OracleJobRecord {
  return {
    id: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    userPubkey: row.user_pubkey ?? undefined,
    userProfilePubkey: row.user_profile_pubkey ?? undefined,
    periodKey: row.period_key ?? undefined,
    commitmentHash: row.commitment_hash ?? undefined,
    metadataUriHash: row.metadata_uri_hash ?? undefined,
    metadataVersion: row.metadata_version ?? undefined,
    sourceKind: row.source_kind ?? undefined,
    emissionDeltaGrams: row.emission_delta_grams ?? undefined,
    reductionDeltaGrams: row.reduction_delta_grams ?? undefined,
    rewardDeltaLamports: row.reward_delta_lamports ?? undefined,
    amountLamports: row.amount_lamports ?? undefined,
    status: row.status,
    claimedBy: row.claimed_by ?? undefined,
    claimedAtMs: row.claimed_at_ms ?? undefined,
    completedAtMs: row.completed_at_ms ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    runAfterMs: row.run_after_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapAttempt(row: AttemptRow): JobAttemptRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms ?? undefined,
    outcome: row.outcome,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    transactionSignature: row.transaction_signature ?? undefined,
  };
}

function mapLock(row: LockRow): ServiceLockRecord {
  return {
    lockKey: row.lock_key,
    ownerId: row.owner_id,
    acquiredAtMs: row.acquired_at_ms,
    expiresAtMs: row.expires_at_ms,
  };
}

export function createDatabaseHandle(
  options: CreateDatabaseOptions = {},
): DatabaseHandle {
  const connection = new Database(options.filename ?? ':memory:');
  applyPragmas(connection);
  migrate(connection);

  return { kind: 'sqlite', connection };
}

export function createStateStore(handle: DatabaseHandle): StateStore {
  const { connection } = handle;

  const normalizeOracleJobInput = (input: OracleJobInput) => ({
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    userPubkey: input.userPubkey ?? null,
    userProfilePubkey: input.userProfilePubkey ?? null,
    periodKey: input.periodKey ?? null,
    commitmentHash: input.commitmentHash ?? null,
    metadataUriHash: input.metadataUriHash ?? null,
    metadataVersion: input.metadataVersion ?? null,
    sourceKind: input.sourceKind ?? null,
    emissionDeltaGrams: input.emissionDeltaGrams ?? null,
    reductionDeltaGrams: input.reductionDeltaGrams ?? null,
    rewardDeltaLamports: input.rewardDeltaLamports ?? null,
    amountLamports: input.amountLamports ?? null,
    runAfterMs: input.runAfterMs,
    createdAtMs: input.createdAtMs,
  });

  const insertNonce = connection.prepare(`
    INSERT INTO used_nonces (nonce, issuer, audience, subject, expires_at_ms, reserved_at_ms)
    VALUES (@nonce, @issuer, @audience, @subject, @expiresAtMs, @reservedAtMs)
  `);
  const selectNonce = connection.prepare<[string], NonceRow>(`
    SELECT nonce, issuer, audience, subject, expires_at_ms, reserved_at_ms
    FROM used_nonces
    WHERE nonce = ?
  `);

  const insertOracleJob = connection.prepare(`
    INSERT INTO oracle_jobs (
      kind,
      idempotency_key,
      user_pubkey,
      user_profile_pubkey,
      period_key,
      commitment_hash,
      metadata_uri_hash,
      metadata_version,
      source_kind,
      emission_delta_grams,
      reduction_delta_grams,
      reward_delta_lamports,
      amount_lamports,
      status,
      run_after_ms,
      created_at_ms,
      updated_at_ms
    ) VALUES (
      @kind,
      @idempotencyKey,
      @userPubkey,
      @userProfilePubkey,
      @periodKey,
      @commitmentHash,
      @metadataUriHash,
      @metadataVersion,
      @sourceKind,
      @emissionDeltaGrams,
      @reductionDeltaGrams,
      @rewardDeltaLamports,
      @amountLamports,
      'pending',
      @runAfterMs,
      @createdAtMs,
      @createdAtMs
    )
  `);
  const selectOracleJobById = connection.prepare<[number], OracleJobRow>(`
    SELECT * FROM oracle_jobs WHERE id = ?
  `);
  const selectOracleJobByIdempotencyKey = connection.prepare<
    [string],
    OracleJobRow
  >(`
    SELECT * FROM oracle_jobs WHERE idempotency_key = ?
  `);
  const selectClaimableJob = connection.prepare<[number], OracleJobRow>(`
    SELECT *
    FROM oracle_jobs
    WHERE status IN ('pending', 'retryable')
      AND run_after_ms <= ?
    ORDER BY created_at_ms ASC, id ASC
    LIMIT 1
  `);
  const selectClaimableJobById = connection.prepare<
    [number, number],
    OracleJobRow
  >(`
    SELECT *
    FROM oracle_jobs
    WHERE id = ?
      AND status IN ('pending', 'retryable')
      AND run_after_ms <= ?
    LIMIT 1
  `);
  const updateClaimedJob = connection.prepare(`
    UPDATE oracle_jobs
    SET status = 'running', claimed_by = @workerId, claimed_at_ms = @nowMs, updated_at_ms = @nowMs
    WHERE id = @jobId
  `);
  const insertLock = connection.prepare(`
    INSERT INTO service_locks (lock_key, owner_id, acquired_at_ms, expires_at_ms)
    VALUES (@lockKey, @ownerId, @acquiredAtMs, @expiresAtMs)
  `);
  const deleteExpiredLock = connection.prepare(`
    DELETE FROM service_locks WHERE lock_key = ? AND expires_at_ms <= ?
  `);
  const selectLock = connection.prepare<[string], LockRow>(`
    SELECT lock_key, owner_id, acquired_at_ms, expires_at_ms
    FROM service_locks WHERE lock_key = ?
  `);
  const deleteLock = connection.prepare<[string]>(
    `DELETE FROM service_locks WHERE lock_key = ?`,
  );

  const insertAttempt = connection.prepare(`
    INSERT INTO job_attempts (job_id, attempt_number, started_at_ms, outcome)
    VALUES (@jobId, @attemptNumber, @startedAtMs, 'running')
  `);
  const updateAttempt = connection.prepare(`
    UPDATE job_attempts
    SET finished_at_ms = @finishedAtMs,
        outcome = @outcome,
        error_code = @errorCode,
        error_message = @errorMessage,
        transaction_signature = @transactionSignature
    WHERE job_id = @jobId AND attempt_number = (
      SELECT MAX(attempt_number) FROM job_attempts WHERE job_id = @jobId
    )
  `);
  const selectAttempts = connection.prepare<[number], AttemptRow>(`
    SELECT id, job_id, attempt_number, started_at_ms, finished_at_ms, outcome, error_code, error_message, transaction_signature
    FROM job_attempts
    WHERE job_id = ?
    ORDER BY attempt_number ASC
  `);

  const updateJobCompleted = connection.prepare(`
    UPDATE oracle_jobs
    SET status = 'completed',
        completed_at_ms = @finishedAtMs,
        updated_at_ms = @finishedAtMs,
        last_error_code = NULL,
        last_error_message = NULL
    WHERE id = @jobId
  `);
  const updateJobFailed = connection.prepare(`
    UPDATE oracle_jobs
    SET status = @status,
        run_after_ms = @runAfterMs,
        updated_at_ms = @finishedAtMs,
        last_error_code = @errorCode,
        last_error_message = @errorMessage
    WHERE id = @jobId
  `);

  const reserveNonce = (input: ReserveNonceInput): UsedNonceRecord => {
    insertNonce.run(input);
    return input;
  };

  const claimPendingJobTx = connection.transaction(
    (
      workerId: string,
      nowMs: number,
      lockDurationMs: number,
    ): ClaimedOracleJob | undefined => {
      const row = selectClaimableJob.get(nowMs);
      if (!row) {
        return undefined;
      }

      const lockKey = `${JOB_LOCK_PREFIX}${row.id}`;
      deleteExpiredLock.run(lockKey, nowMs);

      try {
        insertLock.run({
          lockKey,
          ownerId: workerId,
          acquiredAtMs: nowMs,
          expiresAtMs: nowMs + lockDurationMs,
        });
      } catch {
        return undefined;
      }

      updateClaimedJob.run({ workerId, nowMs, jobId: row.id });

      const claimed = selectOracleJobById.get(row.id);
      if (!claimed) {
        return undefined;
      }

      return {
        ...mapOracleJob(claimed),
        lockKey,
      };
    },
  );

  const claimJobByIdTx = connection.transaction(
    (
      jobId: number,
      workerId: string,
      nowMs: number,
      lockDurationMs: number,
    ): ClaimedOracleJob | undefined => {
      const row = selectClaimableJobById.get(jobId, nowMs);
      if (!row) {
        return undefined;
      }

      const lockKey = `${JOB_LOCK_PREFIX}${row.id}`;
      deleteExpiredLock.run(lockKey, nowMs);

      try {
        insertLock.run({
          lockKey,
          ownerId: workerId,
          acquiredAtMs: nowMs,
          expiresAtMs: nowMs + lockDurationMs,
        });
      } catch {
        return undefined;
      }

      updateClaimedJob.run({ workerId, nowMs, jobId: row.id });

      const claimed = selectOracleJobById.get(row.id);
      if (!claimed) {
        return undefined;
      }

      return {
        ...mapOracleJob(claimed),
        lockKey,
      };
    },
  );

  const completeOracleJobTx = connection.transaction(
    (input: CompleteOracleJobInput): OracleJobRecord => {
      const lock = selectLock.get(input.lockKey);
      if (!lock) {
        throw new Error(`Missing lock for ${input.lockKey}`);
      }

      updateJobCompleted.run(input);
      updateAttempt.run({
        jobId: input.jobId,
        finishedAtMs: input.finishedAtMs,
        outcome: 'completed',
        errorCode: null,
        errorMessage: null,
        transactionSignature: input.transactionSignature ?? null,
      });
      deleteLock.run(input.lockKey);

      const row = selectOracleJobById.get(input.jobId);
      if (!row) {
        throw new Error(`Missing job ${input.jobId}`);
      }

      return mapOracleJob(row);
    },
  );

  const failOracleJobTx = connection.transaction(
    (input: FailOracleJobInput): OracleJobRecord => {
      const lock = selectLock.get(input.lockKey);
      if (!lock) {
        throw new Error(`Missing lock for ${input.lockKey}`);
      }

      const nextStatus: OracleJobRecord['status'] = input.retryable
        ? 'retryable'
        : 'failed';
      updateJobFailed.run({
        jobId: input.jobId,
        status: nextStatus,
        runAfterMs: input.nextRunAfterMs ?? input.finishedAtMs,
        finishedAtMs: input.finishedAtMs,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      });
      updateAttempt.run({
        jobId: input.jobId,
        finishedAtMs: input.finishedAtMs,
        outcome: input.retryable ? 'retryable' : 'failed',
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        transactionSignature: null,
      });
      deleteLock.run(input.lockKey);

      const row = selectOracleJobById.get(input.jobId);
      if (!row) {
        throw new Error(`Missing job ${input.jobId}`);
      }

      return mapOracleJob(row);
    },
  );

  const acquireServiceLock = (
    input: AcquireServiceLockInput,
  ): ServiceLockRecord | undefined => {
    deleteExpiredLock.run(input.lockKey, input.acquiredAtMs);

    try {
      insertLock.run(input);
    } catch {
      return undefined;
    }

    const row = selectLock.get(input.lockKey);
    return row ? mapLock(row) : undefined;
  };

  return {
    reserveNonce,
    findNonce(nonce: string): UsedNonceRecord | undefined {
      const row = selectNonce.get(nonce);
      return row ? mapNonce(row) : undefined;
    },
    enqueueOracleJob(input: OracleJobInput): OracleJobRecord {
      const result = insertOracleJob.run(normalizeOracleJobInput(input));
      const row = selectOracleJobById.get(Number(result.lastInsertRowid));
      if (!row) {
        throw new Error('Failed to create oracle job');
      }
      return mapOracleJob(row);
    },
    findOracleJobById(id: number): OracleJobRecord | undefined {
      const row = selectOracleJobById.get(id);
      return row ? mapOracleJob(row) : undefined;
    },
    findOracleJobByIdempotencyKey(
      idempotencyKey: string,
    ): OracleJobRecord | undefined {
      const row = selectOracleJobByIdempotencyKey.get(idempotencyKey);
      return row ? mapOracleJob(row) : undefined;
    },
    claimPendingJob(
      workerId: string,
      nowMs: number,
      lockDurationMs: number,
    ): ClaimedOracleJob | undefined {
      return claimPendingJobTx(workerId, nowMs, lockDurationMs);
    },
    claimOracleJobById(
      jobId: number,
      workerId: string,
      nowMs: number,
      lockDurationMs: number,
    ): ClaimedOracleJob | undefined {
      return claimJobByIdTx(jobId, workerId, nowMs, lockDurationMs);
    },
    startJobAttempt(input: JobAttemptStartInput): JobAttemptRecord {
      const result = insertAttempt.run(input);
      const rows = selectAttempts.all(input.jobId);
      const row = rows.find(
        (candidate) => candidate.id === Number(result.lastInsertRowid),
      );
      if (!row) {
        logger.error(
          { input },
          `Failed to find job attempt for job ${input.jobId} after inserting attempt record.`,
        );
        throw new Error(`Failed to create job attempt for job ${input.jobId}`);
      }
      return mapAttempt(row);
    },
    completeOracleJob(input: CompleteOracleJobInput): OracleJobRecord {
      return completeOracleJobTx(input);
    },
    failOracleJob(input: FailOracleJobInput): OracleJobRecord {
      return failOracleJobTx(input);
    },
    listJobAttempts(jobId: number): JobAttemptRecord[] {
      return selectAttempts.all(jobId).map(mapAttempt);
    },
    acquireServiceLock,
    releaseLock(lockKey: string): void {
      deleteLock.run(lockKey);
    },
  };
}

export function getPragmaJournalMode(handle: DatabaseHandle): string {
  const result = handle.connection.pragma('journal_mode', { simple: true });
  return String(result);
}

export function listTableColumns(
  handle: DatabaseHandle,
  tableName: string,
): string[] {
  const rows = handle.connection.pragma(`table_info(${tableName})`) as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}
