import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createLogger } from './logger.js';
import { createServer } from './http/server.js';

const config = loadConfig();
const logger = createLogger(config);
const pool = createPool(config);

const app = await createServer({ config, logger, pool });

// Cloud Run sends SIGTERM and then waits. Draining rather than exiting immediately is
// what keeps a deploy from severing in-flight requests — and PRD 8.2 will need this
// hook to mean considerably more once runs outlive requests.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'error during shutdown');
        process.exit(1);
      });
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
  logger.info(
    { port: config.port, env: config.env, verifyIapJwt: config.verifyIapJwt },
    'civil api listening',
  );
} catch (error) {
  logger.error({ err: error }, 'failed to start');
  process.exit(1);
}
