import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createLocalProject, listProjects } from './project/repository.js';
import { createPool } from './db/pool.js';
import { createLogger } from './logger.js';
import { createServer } from './http/server.js';

const config = loadConfig();
const logger = createLogger(config);
const pool = createPool(config);

const app = await createServer({ config, logger, pool });

/**
 * PRD 14 M1's exit criterion is that a hand-written example app renders at both
 * altitudes. Seeding it means `./scripts/dev.sh` lands on that criterion rather than
 * on an empty state, and examples/doc-pipeline is exactly the app the PRD describes.
 *
 * Development only, and only when the user has no projects — it never overwrites
 * anything, and it is logged so it is never mistaken for data that appeared by magic.
 */
async function seedExampleProject(): Promise<void> {
  if (!config.devIdentity) return;

  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE google_sub = $1',
    [`dev:${config.devIdentity}`],
  );
  const user = rows[0];
  if (!user) return;

  if ((await listProjects(pool, user.id)).length > 0) return;

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const examplePath = path.join(repoRoot, 'examples/doc-pipeline');

  const project = await createLocalProject(pool, user.id, 'Document Pipeline', examplePath);
  logger.info({ projectId: project.id, path: examplePath }, 'seeded example project');
}

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
  await seedExampleProject();
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
