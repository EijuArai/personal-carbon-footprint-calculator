import { createConfiguredWorkerRuntime } from './runtime/create-worker.js';
import logger from './utils/logger.js';

const runtime = createConfiguredWorkerRuntime({
  onTick(result) {
    if (result.processedJobIds.length > 0) {
      logger.info(`Processed jobs: ${result.processedJobIds.join(', ')}`);
    }
  },
  onError(error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`green-reputation-worker loop error: ${message}`);
  },
});

logger.info(
  `green-reputation-worker started with sqlite=${runtime.resources.backendRuntime.resources.appEnv.SQLITE_PATH} ` +
    `pollIntervalMs=${runtime.resources.backendRuntime.resources.appEnv.LOCAL_E2E_WORKER_POLL_INTERVAL_MS}`,
);

runtime.startWorkerLoop();

function shutdown(signal: string) {
  logger.info(`green-reputation-worker stopping on ${signal}`);
  runtime.dispose();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
