import { z } from 'zod';

/**
 * PRD 2: secrets in env and Secret Manager, never in the repo. Everything the server
 * needs is read once and validated, so a misconfigured deploy fails at boot with a
 * readable message rather than at the first request with a stack trace.
 *
 * Auth was IAP (PRD 12) until the owner chose to share the application, which IAP
 * cannot do without a Workspace organisation. It is now application-owned Google
 * OAuth. See docs/prd-deltas.md.
 */
const zEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),

  /** Absolute origin this instance is reached at. The OAuth redirect must match exactly. */
  CIVIL_PUBLIC_URL: z.string().url().optional(),
  /** Where the credential-free runner listens (PRD 12). Absent = runs cannot execute. */
  CIVIL_RUNNER_URL: z.string().url().optional(),

  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  /** Signs the session cookie. Rotating it invalidates every existing login. */
  SESSION_SECRET: z.string().min(32).optional(),

  /** PRD 12's GitHub App. The key mints installation tokens; the client pair links accounts. */
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_KEY: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),

  /**
   * Skips OAuth entirely and treats every request as this user. PRD 2 asks for one
   * command to run locally, and a laptop has no OAuth redirect. Refused in
   * production by assertCoherent below.
   */
  CIVIL_DEV_IDENTITY: z.string().email().optional(),

  /** Where the built SPA lives. Unset in development, where Vite serves it. */
  CIVIL_WEB_ROOT: z.string().optional(),

  CIVIL_PAYLOAD_BUCKET: z.string().optional(),
});

export type Config = Readonly<{
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: string;
  databaseUrl: string;
  publicUrl: string | undefined;
  runnerUrl: string | undefined;
  google: { clientId: string; clientSecret: string } | undefined;
  sessionSecret: string | undefined;
  github:
    | { appId: string; privateKey: string; clientId: string; clientSecret: string }
    | undefined;
  devIdentity: string | undefined;
  webRoot: string | undefined;
  payloadBucket: string | undefined;
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
  const config: Config = {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    publicUrl: e.CIVIL_PUBLIC_URL,
    runnerUrl: e.CIVIL_RUNNER_URL,
    google:
      e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
        ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET }
        : undefined,
    sessionSecret: e.SESSION_SECRET,
    github:
      e.GITHUB_APP_ID && e.GITHUB_APP_KEY && e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET
        ? {
            appId: e.GITHUB_APP_ID,
            privateKey: e.GITHUB_APP_KEY,
            clientId: e.GITHUB_CLIENT_ID,
            clientSecret: e.GITHUB_CLIENT_SECRET,
          }
        : undefined,
    devIdentity: e.CIVIL_DEV_IDENTITY,
    webRoot: e.CIVIL_WEB_ROOT,
    payloadBucket: e.CIVIL_PAYLOAD_BUCKET,
  };

  assertCoherent(config);
  return config;
}

function origin(config: Config): string {
  return config.publicUrl ?? `http://127.0.0.1:${config.port}`;
}

/** The OAuth redirect Google must be told about, and which it will match exactly. */
export function redirectUri(config: Config): string {
  return new URL('/auth/google/callback', origin(config)).toString();
}

/** The callback registered on the GitHub App. */
export function githubRedirectUri(config: Config): string {
  return new URL('/auth/github/callback', origin(config)).toString();
}

/**
 * Combinations that parse individually but are wrong together. Each one would leave
 * a production server either unauthenticated or unable to authenticate anyone, and
 * both are worth crashing at boot to avoid.
 */
function assertCoherent(c: Config): void {
  if (!c.isProduction) {
    if (!c.devIdentity && !c.google) {
      throw new Error(
        'Neither CIVIL_DEV_IDENTITY nor Google OAuth credentials are set, so nobody could sign in. ' +
          'Set CIVIL_DEV_IDENTITY for local work.',
      );
    }
    return;
  }

  if (c.devIdentity) {
    throw new Error(
      'CIVIL_DEV_IDENTITY is set in production. It authenticates every request as one user without any credential check; refusing to start.',
    );
  }
  if (!c.google) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production.');
  }
  if (!c.sessionSecret) {
    throw new Error('SESSION_SECRET is required in production; it signs the session cookie.');
  }
  if (!c.publicUrl) {
    throw new Error(
      'CIVIL_PUBLIC_URL is required in production. The OAuth redirect must be an absolute URL that matches what Google was told.',
    );
  }
}
