import type { Connection, Keypair, PublicKey } from '@solana/web3.js';

import {
  OracleRetryRunner,
  type RunDueJobsResult,
} from '../modules/jobs/index.js';
import {
  GreenReputationOracleClient,
  createAnchorProgramTransport,
  type ProgramTransport,
} from '../modules/oracle/index.js';
import {
  createConfiguredBackendRuntime,
  type ConfiguredBackendRuntime,
  type CreateConfiguredBackendRuntimeOptions,
} from './create-runtime.js';
import logger from '../utils/logger.js';

export interface OracleWorkerLoopDependencies {
  pollIntervalMs: number;
  maxJobsPerTick?: number;
  runDueJobs: (maxJobs?: number) => Promise<RunDueJobsResult>;
  onTick?: (result: RunDueJobsResult) => void;
  onError?: (error: unknown) => void;
}

export class OracleWorkerLoop {
  readonly #pollIntervalMs: number;
  readonly #maxJobsPerTick: number;
  readonly #runDueJobs: OracleWorkerLoopDependencies['runDueJobs'];
  readonly #onTick?: OracleWorkerLoopDependencies['onTick'];
  readonly #onError?: OracleWorkerLoopDependencies['onError'];

  #intervalHandle: NodeJS.Timeout | undefined;
  #tickInFlight: Promise<void> | undefined;

  constructor(dependencies: OracleWorkerLoopDependencies) {
    this.#pollIntervalMs = dependencies.pollIntervalMs;
    this.#maxJobsPerTick =
      dependencies.maxJobsPerTick ?? Number.POSITIVE_INFINITY;
    this.#runDueJobs = dependencies.runDueJobs;
    this.#onTick = dependencies.onTick;
    this.#onError = dependencies.onError;
  }

  get isRunning(): boolean {
    return this.#intervalHandle !== undefined;
  }

  start(): void {
    if (this.#intervalHandle) {
      return;
    }

    void this.#scheduleTick();
    this.#intervalHandle = setInterval(() => {
      void this.#scheduleTick();
    }, this.#pollIntervalMs);
  }

  stop(): void {
    if (!this.#intervalHandle) {
      return;
    }

    clearInterval(this.#intervalHandle);
    this.#intervalHandle = undefined;
  }

  async runDueJobsOnce(
    maxJobs = this.#maxJobsPerTick,
  ): Promise<RunDueJobsResult> {
    return await this.#runDueJobs(maxJobs);
  }

  async waitForCurrentTick(): Promise<void> {
    await this.#tickInFlight;
  }

  async #scheduleTick(): Promise<void> {
    if (this.#tickInFlight) {
      return await this.#tickInFlight;
    }

    this.#tickInFlight = (async () => {
      try {
        const result = await this.#runDueJobs(this.#maxJobsPerTick);
        this.#onTick?.(result);
      } catch (error) {
        this.#onError?.(error);
      } finally {
        this.#tickInFlight = undefined;
      }
    })();

    await this.#tickInFlight;
  }
}

export interface ConfiguredWorkerRuntimeResources {
  backendRuntime: ConfiguredBackendRuntime;
  verifierOracleClient: GreenReputationOracleClient;
  metadataOracleClient: GreenReputationOracleClient;
  adminOracleClient: GreenReputationOracleClient | undefined;
  retryRunner: OracleRetryRunner;
  workerLoop: OracleWorkerLoop;
}

export interface ConfiguredWorkerRuntime {
  resources: ConfiguredWorkerRuntimeResources;
  runDueJobsOnce(maxJobs?: number): Promise<RunDueJobsResult>;
  startWorkerLoop(): void;
  stopWorkerLoop(): void;
  dispose(): void;
}

export interface CreateConfiguredWorkerRuntimeOptions extends CreateConfiguredBackendRuntimeOptions {
  metadataTransportFactory?: (
    options: Parameters<typeof createAnchorProgramTransport>[0],
  ) => ProgramTransport;
  adminTransportFactory?: (
    options: Parameters<typeof createAnchorProgramTransport>[0],
  ) => ProgramTransport;
  pollIntervalMs?: number;
  maxJobsPerTick?: number;
  onTick?: (result: RunDueJobsResult) => void;
  onError?: (error: unknown) => void;
}

export function createConfiguredWorkerRuntime(
  options: CreateConfiguredWorkerRuntimeOptions = {},
): ConfiguredWorkerRuntime {
  const backendRuntime = createConfiguredBackendRuntime(options);
  const { appEnv, connection, programId, signers, stateStore } =
    backendRuntime.resources;

  const verifierOracleClient = backendRuntime.resources.oracleClient;
  const metadataOracleClient = signers.metadataAuthority
    ? createOracleClient({
        connection,
        programId,
        signer: signers.metadataAuthority,
        ...((options.metadataTransportFactory ?? options.transportFactory)
          ? {
              transportFactory:
                options.metadataTransportFactory ?? options.transportFactory,
            }
          : {}),
      })
    : verifierOracleClient;
  const adminOracleClient = signers.admin
    ? createOracleClient({
        connection,
        programId,
        signer: signers.admin,
        ...((options.adminTransportFactory ?? options.transportFactory)
          ? {
              transportFactory:
                options.adminTransportFactory ?? options.transportFactory,
            }
          : {}),
      })
    : undefined;

  const retryRunner = new OracleRetryRunner({
    stateStore,
    ...(options.now ? { now: options.now } : {}),
    oracleClient: {
      submitVerifiedFootprintJob:
        verifierOracleClient.submitVerifiedFootprintJob.bind(
          verifierOracleClient,
        ),
      syncSbtState:
        metadataOracleClient.syncSbtState.bind(metadataOracleClient),
      fundTreasury: (
        adminOracleClient ?? verifierOracleClient
      ).fundTreasury.bind(adminOracleClient ?? verifierOracleClient),
    },
  });
  const workerLoop = new OracleWorkerLoop({
    pollIntervalMs:
      options.pollIntervalMs ?? appEnv.LOCAL_E2E_WORKER_POLL_INTERVAL_MS,
    maxJobsPerTick:
      options.maxJobsPerTick ?? appEnv.LOCAL_E2E_WORKER_MAX_JOBS_PER_TICK,
    runDueJobs: (maxJobs) => retryRunner.runDueJobs(maxJobs),
    ...(options.onTick ? { onTick: options.onTick } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });

  logger.info(
    {
      pollIntervalMs:
        options.pollIntervalMs ?? appEnv.LOCAL_E2E_WORKER_POLL_INTERVAL_MS,
      maxJobsPerTick:
        options.maxJobsPerTick ?? appEnv.LOCAL_E2E_WORKER_MAX_JOBS_PER_TICK,
      hasMetadataAuthority: Boolean(signers.metadataAuthority),
      hasAdminSigner: Boolean(signers.admin),
    },
    'Configured worker runtime resources.',
  );

  return {
    resources: {
      backendRuntime,
      verifierOracleClient,
      metadataOracleClient,
      adminOracleClient,
      retryRunner,
      workerLoop,
    },
    async runDueJobsOnce(maxJobs) {
      return await workerLoop.runDueJobsOnce(maxJobs);
    },
    startWorkerLoop() {
      logger.info('Starting oracle worker loop.');
      workerLoop.start();
    },
    stopWorkerLoop() {
      logger.info('Stopping oracle worker loop.');
      workerLoop.stop();
    },
    dispose() {
      logger.info('Disposing worker runtime resources.');
      workerLoop.stop();
      backendRuntime.resources.databaseHandle.connection.close();
    },
  };
}

function createOracleClient(input: {
  connection: Connection;
  programId: PublicKey;
  signer: Keypair;
  transportFactory?: (
    options: Parameters<typeof createAnchorProgramTransport>[0],
  ) => ProgramTransport;
}): GreenReputationOracleClient {
  const transport = (input.transportFactory ?? createAnchorProgramTransport)({
    connection: input.connection,
    programId: input.programId,
    signer: input.signer,
  });

  return new GreenReputationOracleClient({
    programId: input.programId,
    transport,
  });
}
