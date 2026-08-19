import { loadConfig } from './config.js';
import { contractDiscoveryProblem, discoverContracts } from './project/contracts.js';
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

/**
 * Contract discovery degrades quietly on purpose — without it the canvas still
 * renders, nodes just show no ports (PRD 7.2). Quiet degradation with no signal is
 * indistinguishable from a project that genuinely has no contracts, so it is checked
 * once at boot and said out loud.
 */
async function reportContractDiscovery(): Promise<void> {
  const probe = await discoverContracts([
    { key: 'probe', source: 'def handler(x: str) -> int:\n    return 1\n' },
  ]);

  const problem = contractDiscoveryProblem();
  if (problem || !probe.has('probe')) {
    logger.warn(
      { problem: problem ?? 'probe returned nothing' },
      'contract discovery unavailable; node ports will not be shown',
    );
  } else {
    logger.info('contract discovery ready');
  }
}

try {
  await reportContractDiscovery();
  await app.listen({ port: config.port, host: config.host });
  logger.info(
    {
      port: config.port,
      env: config.env,
      auth: config.devIdentity ? 'dev-identity' : 'google-oauth',
    },
    'civil api listening',
  );
} catch (error) {
  logger.error({ err: error }, 'failed to start');
  process.exit(1);
}
