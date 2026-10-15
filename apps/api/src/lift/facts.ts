import { posix } from 'node:path';

/**
 * The fact sheet an architecture analyst starts from (docs/interpretation.md): what can
 * be known about how a codebase is built without a model. Each package's notable
 * dependencies by what they are for, the infrastructure its Terraform declares, the
 * images its Dockerfiles build from, its CI, and the docs it keeps. Analysts are given
 * this so their reads go to judgement — why, and how the pieces fit — not inventory.
 *
 * Deterministic and pure over the file map and the listing: the same repository gives
 * the same facts.
 */

export interface PackageFacts {
  /** The package's directory, '' for the root. */
  dir: string;
  name: string | null;
  /** Purpose → the dependencies that serve it, as written in package.json. */
  notable: Record<string, string[]>;
}

export interface Facts {
  packages: PackageFacts[];
  /** Terraform resources, "type.name", by file. */
  infrastructure: Record<string, string[]>;
  /** Dockerfile → the images it builds from. */
  images: Record<string, string[]>;
  ci: string[];
  docs: string[];
}

/**
 * Dependency name → what it is for. Matched exactly or by a scope prefix ("@nestjs/").
 * General, never a project's own packages: a library's purpose is public knowledge.
 */
const PURPOSES: [string, RegExp][] = [
  ['frontend framework', /^(react|react-dom|vue|svelte|@sveltejs\/kit|@angular\/core|next|nuxt|solid-js|preact|astro|@remix-run\/.+|react-router(-dom)?|@tanstack\/react-router)$/],
  ['frontend build', /^(vite|webpack|esbuild|rollup|parcel|@vitejs\/.+|vite-plugin-pwa|turbo)$/],
  ['frontend state and data', /^(@tanstack\/react-query|@tanstack\/query-core|redux|@reduxjs\/toolkit|zustand|jotai|swr|nuqs|@apollo\/client|urql|mobx)$/],
  ['frontend ui', /^(tailwindcss|@radix-ui\/.+|@mui\/.+|@chakra-ui\/.+|antd|cmdk|lucide-react|framer-motion|motion|class-variance-authority|@headlessui\/.+)$/],
  ['backend framework', /^(@nestjs\/core|@nestjs\/common|express|fastify|koa|hono|@hapi\/hapi|restify|@trpc\/server|graphql|@apollo\/server)$/],
  ['database and orm', /^(pg|postgres|mysql2?|better-sqlite3|sqlite3|@libsql\/client|mongodb|mongoose|prisma|@prisma\/client|drizzle-orm|typeorm|knex|kysely|sequelize|@mikro-orm\/.+|@neondatabase\/serverless|ioredis|redis)$/],
  ['migrations', /^(node-pg-migrate|drizzle-kit|umzug|db-migrate|@databases\/migrations)$/],
  ['queues and jobs', /^(pg-boss|bullmq|bull|bee-queue|agenda|amqplib|kafkajs|@google-cloud\/pubsub|@google-cloud\/tasks|@aws-sdk\/client-sqs|node-cron|@nestjs\/schedule|croner)$/],
  ['auth', /^(passport(-.+)?|@nestjs\/passport|openid-client|jose|jsonwebtoken|next-auth|@auth\/.+|lucia|google-auth-library|@clerk\/.+|@supabase\/auth-.+|bcrypt|bcryptjs|argon2|@simplewebauthn\/.+|oauth4webapi)$/],
  ['security', /^(helmet|@fastify\/helmet|csurf|@fastify\/csrf-protection|express-rate-limit|@nestjs\/throttler|@google-cloud\/kms|@aws-sdk\/client-kms|@fastify\/rate-limit|sanitize-html|dompurify)$/],
  ['validation and contracts', /^(zod|class-validator|class-transformer|joi|yup|valibot|ajv|@sinclair\/typebox|io-ts|superstruct|@ts-rest\/.+)$/],
  ['ai models and agents', /^(@anthropic-ai\/sdk|openai|@google\/genai|@google\/generative-ai|@google-cloud\/vertexai|ai|@ai-sdk\/.+|langchain|@langchain\/.+|llamaindex|@mastra\/.+|@modelcontextprotocol\/sdk|@openai\/agents|cohere-ai|@mistralai\/mistralai|ollama|@xenova\/transformers|pgvector)$/],
  ['storage and cloud', /^(@google-cloud\/storage|@google-cloud\/secret-manager|@google-cloud\/firestore|@aws-sdk\/client-s3|@azure\/storage-blob|googleapis|@googleapis\/.+|firebase-admin)$/],
  ['observability', /^(pino|pino-http|nestjs-pino|winston|@sentry\/.+|@opentelemetry\/.+|dd-trace|prom-client|@google-cloud\/logging)$/],
  ['testing', /^(vitest|jest|@playwright\/test|playwright|cypress|msw|supertest|@testing-library\/.+)$/],
];

const purposeOf = (name: string): string | undefined => PURPOSES.find(([, re]) => re.test(name))?.[0];

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildFacts(files: Readonly<Record<string, string>>, listed: readonly string[]): Facts {
  const packages: PackageFacts[] = [];
  for (const path of Object.keys(files).filter((p) => (p === 'package.json' || p.endsWith('/package.json')) && !p.includes('node_modules/')).sort(byString)) {
    let json: { name?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    try {
      json = JSON.parse(files[path]!) as typeof json;
    } catch {
      continue;
    }
    const notable: Record<string, string[]> = {};
    for (const dep of Object.keys({ ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) }).sort(byString)) {
      const purpose = purposeOf(dep);
      if (purpose) (notable[purpose] ??= []).push(dep);
    }
    packages.push({ dir: posix.dirname(path) === '.' ? '' : posix.dirname(path), name: typeof json.name === 'string' ? json.name : null, notable });
  }

  const infrastructure: Record<string, string[]> = {};
  for (const path of listed.filter((p) => p.endsWith('.tf')).sort(byString)) {
    const text = files[path];
    if (text === undefined) continue;
    const resources = [...text.matchAll(/^\s*resource\s+"([^"]+)"\s+"([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`);
    const modules = [...text.matchAll(/^\s*module\s+"([^"]+)"/gm)].map((m) => `module.${m[1]}`);
    if (resources.length || modules.length) infrastructure[path] = [...resources, ...modules];
  }

  const images: Record<string, string[]> = {};
  for (const path of listed.filter((p) => /(^|\/)Dockerfile[^/]*$/.test(p)).sort(byString)) {
    const text = files[path];
    if (text === undefined) continue;
    const from = [...text.matchAll(/^\s*FROM\s+(\S+)/gim)].map((m) => m[1]!);
    if (from.length) images[path] = from;
  }

  const ci = listed.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)cloudbuild[^/]*\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\//.test(p)).sort(byString);
  const docs = listed
    .filter((p) => /\.md$/i.test(p) && !p.includes('node_modules/') && !p.startsWith('civil/') && (p.split('/').length <= 2 || /(^|\/)docs?\//.test(p) || /(README|ARCHITECTURE|CLAUDE|AGENTS|DESIGN|ADR)/i.test(p)))
    .sort(byString)
    .slice(0, 60);
  return { packages, infrastructure, images, ci, docs };
}
