import { z } from 'zod';

/**
 * PRD 2: secrets in env and Secret Manager, never in the repo. Everything the server
 * needs is read here once and validated, so a misconfigured deploy fails at boot with
 * a readable message rather than at the first request with a stack trace.
 */
const zEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),

  /**
   * PRD 12: IAP asserts identity; there is no user table. In development there is no
   * IAP, so this stands in for it. It must never be set in production — see
   * `assertCoherent` below.
   */
  CIVIL_DEV_IDENTITY: z.string().optional(),

  /**
   * The IAP JWT audience, of the form
   * `/projects/<project-number>/locations/global/backendServices/<id>` behind a load
   * balancer, or `/projects/<project-number>/apps/<project-id>` for App Engine.
   * Required whenever assertions are verified.
   */
  CIVIL_IAP_AUDIENCE: z.string().optional(),

  /**
   * Absolute path to the built SPA. IAP fronts a single Cloud Run service, so the
   * API serves the frontend too; in development Vite serves it and this is unset.
   */
  CIVIL_WEB_ROOT: z.string().optional(),

  /**
   * Defence in depth against a misconfigured ingress. See http/identity.ts.
   * Defaults on in production and off elsewhere.
   */
  CIVIL_VERIFY_IAP_JWT: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export type Config = Readonly<{
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: string;
  databaseUrl: string;
  devIdentity: string | undefined;
  iapAudience: string | undefined;
  verifyIapJwt: boolean;
  webRoot: string | undefined;
}>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = zEnv.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }

  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const config: Config = {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    devIdentity: e.CIVIL_DEV_IDENTITY,
    iapAudience: e.CIVIL_IAP_AUDIENCE,
    verifyIapJwt: e.CIVIL_VERIFY_IAP_JWT ?? isProduction,
    webRoot: e.CIVIL_WEB_ROOT,
  };

  assertCoherent(config);
  return config;
}

/**
 * Combinations that parse individually but are wrong together. Each of these would
 * otherwise fail open — as an unauthenticated production server, which is the one
 * failure mode worth crashing at boot to avoid.
 */
function assertCoherent(c: Config): void {
  if (c.isProduction && c.devIdentity !== undefined) {
    throw new Error(
      'CIVIL_DEV_IDENTITY is set in production. It bypasses IAP entirely; refusing to start.',
    );
  }
  if (c.verifyIapJwt && !c.iapAudience) {
    throw new Error(
      'IAP assertion verification is on but CIVIL_IAP_AUDIENCE is unset. ' +
        'Set the audience, or set CIVIL_VERIFY_IAP_JWT=false if this service sits behind a proxy that already verifies it.',
    );
  }
  if (c.isProduction && !c.verifyIapJwt) {
    // Legal — the ingress may genuinely be locked to IAP — but it should be a choice
    // someone made on purpose, so it is loud.
    process.emitWarning(
      'Running in production without verifying IAP assertions. This is only safe if ingress is restricted to the load balancer.',
      'CivilSecurityWarning',
    );
  }
}
