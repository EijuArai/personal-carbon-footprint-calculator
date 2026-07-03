import { createServer } from 'node:http';

import { createConfiguredBackendRuntime } from './runtime/create-runtime.js';
import logger from './utils/logger.js';

const runtime = createConfiguredBackendRuntime();
const { appEnv: env } = runtime.resources;
const app = runtime.app;
const server = createServer(app);

server.listen(env.PORT, env.HOST, () => {
  logger.info(`Server started in ${env.NODE_ENV} environment`);
});
