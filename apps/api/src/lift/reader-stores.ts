import { posix } from 'node:path';
import ts from 'typescript';
import { parseDocument, isMap, isScalar } from 'yaml';
import { byString, civilId, isSampleCode, isTestSupport, type RepoContext } from './read.js';
import type { Skeleton, SkeletonDatastore, SkeletonService, SourceRef } from './skeleton.js';

/**
 * Datastores: where the application keeps state, and which services use them
 * (docs/lift-repo.md). Text only, like the rest of the reader. Every rule is by shape —
 * a resource type, an image name, a client package — never by a project's names.
 *
 * Where a store is declared (each a source; a store found in none is not drawn):
 *
 * 1. Terraform `resource "<type>" "<name>"` blocks of a managed-store type
 *    (TERRAFORM_STORES): the engine is the type's, or read from the block's
 *    `database_version` (Cloud SQL: POSTGRES_* → postgres, MYSQL_* → mysql,
 *    SQLSERVER_* → sqlserver) or `engine` (RDS: postgres/aurora-postgresql →
 *    postgres, mysql/aurora-mysql/mariadb → mysql, sqlserver-* → sqlserver). The id is
 *    the resource name, kebab-cased; a placeholder name (this, main, default, primary,
 *    instance) gives way to the block's own `name` when that is a fixed string, else to
 *    the merged compose service's name, else to the engine. Terraform's own state
 *    buckets (STATE_BUCKET, or a bucket a `backend` block names) are not the app's.
 * 2. docker-compose*.yml / compose*.yml services whose image is a well-known store
 *    (COMPOSE_IMAGES, matched on the image's last path segment without its tag; a local
 *    emulator such as MinIO or fake-gcs-server counts as the store it stands in for).
 *    The id is the compose service name.
 * 3. A Prisma schema's `datasource` block: its `provider` (PRISMA_PROVIDERS). The id is
 *    the datasource name. A datasource names a database, it does not create one, so it
 *    is a store of its own only when no Terraform or compose source declares its engine.
 *
 * One store per engine when that is unambiguous: if every source declares at most one
 * store of an engine, they are the same store (local compose for development, the
 * Terraform resource deployed), named by the deployed one — Terraform, then compose,
 * then Prisma. If any source declares several of an engine, all are kept separate and
 * nothing is merged: which is which is not written down.
 *
 * Which services use a store: a service uses engine E when one of its own files imports
 * a client package for E (CLIENTS; ORMs that serve several engines take the engine from
 * the database driver the package depends on, and @prisma/client from the Prisma
 * provider), directly or through one in-repo module it imports that does (a db/ module
 * exporting a client) — followed one level, through re-exports to the declaring file.
 * Type-only imports do not count. The store's id is added to the service's dependsOn
 * only when exactly one store has engine E; several are reported as ambiguous, none as
 * a client with nowhere declared to connect. An infrastructure service that owns the
 * wrapper uses the store as much as the services that import it.
 */

// --- 1. Terraform ---------------------------------------------------------------

/** Resource type → engine; null means "read it from the block" (readEngine). */
const TERRAFORM_STORES: Record<string, string | null> = {
  google_sql_database_instance: null,
  google_alloydb_cluster: 'postgres',
  google_storage_bucket: 'gcs',
  google_redis_instance: 'redis',
  google_redis_cluster: 'redis',
  google_firestore_database: 'firestore',
  google_pubsub_topic: 'pubsub',
  google_bigquery_dataset: 'bigquery',
  google_spanner_instance: 'spanner',
  google_bigtable_instance: 'bigtable',
  aws_db_instance: null,
  aws_rds_cluster: null,
  aws_s3_bucket: 's3',
  aws_elasticache_cluster: 'redis',
  aws_elasticache_replication_group: 'redis',
  aws_memorydb_cluster: 'redis',
  aws_dynamodb_table: 'dynamodb',
  aws_sqs_queue: 'sqs',
  aws_docdb_cluster: 'mongodb',
  aws_opensearch_domain: 'opensearch',
  aws_elasticsearch_domain: 'elasticsearch',
  azurerm_postgresql_flexible_server: 'postgres',
  azurerm_postgresql_server: 'postgres',
  azurerm_mysql_flexible_server: 'mysql',
  azurerm_mysql_server: 'mysql',
  azurerm_mssql_server: 'sqlserver',
  azurerm_storage_account: 'azure-storage',
  azurerm_redis_cache: 'redis',
  azurerm_cosmosdb_account: 'cosmosdb',
};

const TERRAFORM_RESOURCE = /(^|\n)[ \t]*resource\s+"([\w-]+)"\s+"([^"]+)"\s*\{/g;
const PLACEHOLDER_NAMES = new Set(['this', 'main', 'default', 'primary', 'instance']);

/** Cloud SQL `database_version` or RDS `engine` → engine. */
function sqlEngine(value: string | undefined): string | null {
  if (!value || value.includes('${')) return null;
  const v = value.toLowerCase();
  if (/^(postgres|aurora-postgresql)/.test(v)) return 'postgres';
  if (/^(mysql|aurora-mysql|aurora$|mariadb)/.test(v)) return 'mysql';
  if (/^sqlserver/.test(v)) return 'sqlserver';
  if (/^oracle/.test(v)) return 'oracle';
  return null;
}

/** A block's own `name = "value"` attribute — not one inside a nested block (`settings { … }`). */
const tfAttr = (body: string, name: string): string | undefined =>
  new RegExp(`(^|\\n)\\s*${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(topLevel(body))?.[2];

/** A block body with its nested blocks' contents removed (strings and comments respected). */
function topLevel(body: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '"') {
      let j = i + 1;
      for (; j < body.length && body[j] !== '"'; j += 1) if (body[j] === '\\') j += 1;
      if (depth === 0) out += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '#' || (ch === '/' && body[i + 1] === '/')) {
      while (i < body.length && body[i] !== '\n') i += 1;
      if (depth === 0) out += '\n';
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Terraform's own state is not the application's: a bucket named for it (`tfstate`,
 * `terraform-state` in its resource or `name`, interpolated or not), or named as a
 * `backend "…" { bucket = "…" }` in the repository, is left out.
 */
const STATE_BUCKET = /tf-?state|terraform[-_]?state/i;
function backendBuckets(files: Readonly<Record<string, string>>): Set<string> {
  const out = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.tf')) continue;
    for (const m of text.matchAll(/(^|\n)\s*backend\s+"[\w-]+"\s*\{/g)) {
      const bucket = tfAttr(blockAt(text, m.index! + m[0].length - 1), 'bucket');
      if (bucket) out.add(bucket);
    }
  }
  return out;
}

/** The text of the `{ … }` block opening at `open`, skipping strings and comments. */
function blockAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
      continue;
    }
    if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

// --- 2. docker-compose ----------------------------------------------------------

/** Image repository (last path segment, tag dropped) → engine. */
const COMPOSE_IMAGES: [RegExp, string][] = [
  [/^(postgres|postgresql|postgis|timescaledb(-ha)?|pgvector)$/, 'postgres'],
  [/^(mysql|mysql-server|mariadb|percona-server)$/, 'mysql'],
  [/^(mongo|mongodb|mongodb-community-server)$/, 'mongodb'],
  [/^(redis|redis-stack|redis-stack-server|valkey|keydb|dragonfly)$/, 'redis'],
  [/^rabbitmq$/, 'rabbitmq'],
  [/^elasticsearch$/, 'elasticsearch'],
  [/^opensearch$/, 'opensearch'],
  [/^minio$/, 's3'],
  [/^fake-gcs-server$/, 'gcs'],
  [/^(kafka|cp-kafka|redpanda)$/, 'kafka'],
  [/^nats$/, 'nats'],
  [/^memcached$/, 'memcached'],
  [/^(mssql|mssql-server)$/, 'sqlserver'],
  [/^cockroach$/, 'cockroachdb'],
];

const isComposeFile = (path: string): boolean => /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/.test(posix.basename(path));

function imageEngine(image: string): string | null {
  const last = image.split('@')[0]!.split('/').pop()!.split(':')[0]!.toLowerCase();
  return COMPOSE_IMAGES.find(([re]) => re.test(last))?.[1] ?? null;
}

// --- 3. Prisma ------------------------------------------------------------------

const PRISMA_PROVIDERS: Record<string, string> = {
  postgresql: 'postgres',
  postgres: 'postgres',
  mysql: 'mysql',
  sqlite: 'sqlite',
  mongodb: 'mongodb',
  sqlserver: 'sqlserver',
  cockroachdb: 'cockroachdb',
};

// --- Clients ----------------------------------------------------------------------

/** Client package (or exact import specifier) → engine. */
const CLIENTS: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  'pg-promise': 'postgres',
  slonik: 'postgres',
  '@neondatabase/serverless': 'postgres',
  '@vercel/postgres': 'postgres',
  '@mikro-orm/postgresql': 'postgres',
  'drizzle-orm/node-postgres': 'postgres',
  'drizzle-orm/postgres-js': 'postgres',
  'drizzle-orm/pg-core': 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  '@mikro-orm/mysql': 'mysql',
  'drizzle-orm/mysql2': 'mysql',
  'drizzle-orm/mysql-core': 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  '@libsql/client': 'sqlite',
  'drizzle-orm/better-sqlite3': 'sqlite',
  'drizzle-orm/sqlite-core': 'sqlite',
  mssql: 'sqlserver',
  tedious: 'sqlserver',
  mongodb: 'mongodb',
  mongoose: 'mongodb',
  '@nestjs/mongoose': 'mongodb',
  ioredis: 'redis',
  redis: 'redis',
  '@redis/client': 'redis',
  '@upstash/redis': 'redis',
  bull: 'redis',
  bullmq: 'redis',
  '@google-cloud/storage': 'gcs',
  '@google-cloud/firestore': 'firestore',
  'firebase-admin/firestore': 'firestore',
  '@google-cloud/pubsub': 'pubsub',
  '@google-cloud/bigquery': 'bigquery',
  '@google-cloud/spanner': 'spanner',
  '@aws-sdk/client-s3': 's3',
  '@aws-sdk/lib-storage': 's3',
  minio: 's3',
  '@aws-sdk/client-dynamodb': 'dynamodb',
  '@aws-sdk/lib-dynamodb': 'dynamodb',
  '@aws-sdk/client-sqs': 'sqs',
  amqplib: 'rabbitmq',
  'amqp-connection-manager': 'rabbitmq',
  kafkajs: 'kafka',
  nats: 'nats',
  '@elastic/elasticsearch': 'elasticsearch',
  '@opensearch-project/opensearch': 'opensearch',
  '@azure/storage-blob': 'azure-storage',
  '@azure/cosmos': 'cosmosdb',
};

/** ORMs and query builders that serve several engines: the engine is the driver's. */
const MULTI_ENGINE = new Set(['typeorm', '@nestjs/typeorm', 'knex', 'kysely', 'sequelize', '@nestjs/sequelize', 'drizzle-orm', '@mikro-orm/core', '@mikro-orm/nestjs']);
const PRISMA_CLIENT = '@prisma/client';

/** Driver packages a package.json may list → engine, for MULTI_ENGINE. */
const DRIVERS: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  '@neondatabase/serverless': 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  '@libsql/client': 'sqlite',
  mssql: 'sqlserver',
  tedious: 'sqlserver',
  mongodb: 'mongodb',
};

// ---------------------------------------------------------------------------------

type Origin = 'terraform' | 'compose' | 'prisma';
interface Found {
  id: string;
  engine: string;
  origin: Origin;
  source: SourceRef;
  /** True when the id is a stand-in (a placeholder resource name with no fixed `name`). */
  weakId?: boolean;
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

function fromTerraform(path: string, text: string, backends: ReadonlySet<string>): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(TERRAFORM_RESOURCE)) {
    const type = m[2]!;
    if (!(type in TERRAFORM_STORES)) continue;
    const start = m.index! + m[1]!.length;
    const body = blockAt(text, m.index! + m[0].length - 1);
    const engine = TERRAFORM_STORES[type] ?? sqlEngine(tfAttr(body, 'database_version') ?? tfAttr(body, 'engine'));
    const name = tfAttr(body, 'name') ?? tfAttr(body, 'bucket');
    if (/bucket|storage_account/.test(type) && (STATE_BUCKET.test(m[3]!) || (name && (STATE_BUCKET.test(name) || backends.has(name))))) continue;
    const fixedName = name && !name.includes('${') ? name : undefined;
    const placeholder = PLACEHOLDER_NAMES.has(m[3]!);
    const label = placeholder ? (fixedName ?? null) : m[3]!;
    out.push({
      id: civilId(label ?? engine ?? type),
      engine: engine ?? 'unknown',
      origin: 'terraform',
      source: { file: path, line: lineAt(text, start) },
      ...(label === null ? { weakId: true } : {}),
    });
  }
  return out;
}

function fromCompose(path: string, text: string): Found[] {
  let doc;
  try {
    doc = parseDocument(text);
  } catch {
    return [];
  }
  const services = doc.get('services');
  if (!isMap(services)) return [];
  const out: Found[] = [];
  for (const item of services.items) {
    const name = isScalar(item.key) ? String(item.key.value) : null;
    if (!name || !isMap(item.value)) continue;
    const image = item.value.get('image');
    if (typeof image !== 'string') continue;
    const engine = imageEngine(image);
    if (!engine) continue;
    const offset = isScalar(item.key) && item.key.range ? item.key.range[0] : undefined;
    out.push({ id: civilId(name), engine, origin: 'compose', source: offset === undefined ? { file: path } : { file: path, line: lineAt(text, offset) } });
  }
  return out;
}

function fromPrisma(path: string, text: string): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(/(^|\n)[ \t]*datasource\s+(\w+)\s*\{([^}]*)\}/g)) {
    const provider = /(^|\n)\s*provider\s*=\s*"([^"]+)"/.exec(m[3]!)?.[2];
    const engine = provider ? PRISMA_PROVIDERS[provider] : undefined;
    if (!engine) continue;
    out.push({ id: civilId(m[2]!), engine, origin: 'prisma', source: { file: path, line: lineAt(text, m.index! + m[1]!.length) } });
  }
  return out;
}

/** The datastores the repository declares, merged per engine where unambiguous. */
function declaredStores(ctx: RepoContext): { stores: Found[]; prismaEngines: Set<string> } {
  const found: Found[] = [];
  const backends = backendBuckets(ctx.files);
  for (const path of Object.keys(ctx.files).sort(byString)) {
    if (isTestSupport(path) || isSampleCode(path)) continue;
    const text = ctx.files[path]!;
    if (path.endsWith('.tf')) found.push(...fromTerraform(path, text, backends));
    else if (isComposeFile(path)) found.push(...fromCompose(path, text));
    else if (path.endsWith('.prisma')) found.push(...fromPrisma(path, text));
  }
  const prismaEngines = new Set(found.filter((f) => f.origin === 'prisma').map((f) => f.engine));
  const ORDER: Origin[] = ['terraform', 'compose', 'prisma'];
  const stores: Found[] = [];
  for (const engine of [...new Set(found.map((f) => f.engine))].sort(byString)) {
    const of = found.filter((f) => f.engine === engine);
    const declared = of.filter((f) => f.origin !== 'prisma');
    const perOrigin = ORDER.map((o) => of.filter((f) => f.origin === o).length);
    if (engine !== 'unknown' && perOrigin.every((n) => n <= 1)) {
      const [first, ...rest] = ORDER.map((o) => of.find((f) => f.origin === o)).filter((f): f is Found => f !== undefined);
      // A deployed resource with a placeholder name takes the next source's name.
      stores.push(first!.weakId && rest.length ? { ...first!, id: rest[0]!.id } : first!);
    } else {
      // Several of an engine: kept apart. A Prisma datasource points at one of the
      // declared stores, so it adds none when any are declared.
      stores.push(...(declared.length ? declared : of));
    }
  }
  return { stores, prismaEngines };
}

/** External packages (by specifier and package) a file imports or re-exports at runtime. */
function externalImports(ctx: RepoContext, file: string): { specifier: string; pkg: string }[] {
  const sf = ctx.sourceFile(file);
  if (!sf) return [];
  const out: { specifier: string; pkg: string }[] = [];
  const add = (specifier: string) => {
    const r = ctx.resolve(file, specifier);
    if (r.kind === 'external') out.push({ specifier, pkg: r.pkg });
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) add(stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) add(stmt.moduleSpecifier.text);
  }
  // require('x') and import('x') with a literal specifier.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** In-repo files a file imports at runtime, each with the declaring files of its names. */
function inRepoImports(ctx: RepoContext, file: string): string[] {
  const out = new Set<string>();
  for (const binding of ctx.imports(file).values()) {
    if (binding.typeOnly || binding.target.kind !== 'file') continue;
    out.add(binding.target.path);
    if (binding.imported === '*') continue;
    const decl = ctx.resolveExport(binding.target.path, binding.imported, new Set());
    if (decl && !('external' in decl)) out.add(decl.file);
  }
  const sf = ctx.sourceFile(file);
  for (const stmt of sf?.statements ?? []) {
    // `import './db.js'` (side effect) and `export * from './db.js'`.
    const spec =
      (ts.isImportDeclaration(stmt) && !stmt.importClause) || (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly)
        ? stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : null
        : null;
    if (!spec) continue;
    const r = ctx.resolve(file, spec);
    if (r.kind === 'file') out.add(r.path);
  }
  out.delete(file);
  return [...out];
}

/** Engines a file's own imports reach, with the reason for each (the import's package). */
function enginesOfFile(ctx: RepoContext, file: string, prismaEngine: string | null, cache: Map<string, Map<string, string>>): Map<string, string> {
  const cached = cache.get(file);
  if (cached) return cached;
  const out = new Map<string, string>();
  const pkg = ctx.packageOf(file);
  const root = ctx.packages.find((p) => p.dir === '');
  const drivers = new Set(
    [pkg, root]
      .filter((p) => p !== undefined)
      .flatMap((p) => Object.keys({ ...(p!.json.dependencies ?? {}), ...(p!.json.devDependencies ?? {}), ...(p!.json.peerDependencies ?? {}) }))
      .map((d) => DRIVERS[d])
      .filter((e): e is string => e !== undefined),
  );
  for (const { specifier, pkg: name } of externalImports(ctx, file)) {
    const direct = CLIENTS[specifier] ?? CLIENTS[name];
    if (direct) out.set(direct, specifier);
    else if (name === PRISMA_CLIENT && prismaEngine) out.set(prismaEngine, specifier);
    else if (MULTI_ENGINE.has(name) && drivers.size === 1) out.set([...drivers][0]!, specifier);
  }
  cache.set(file, out);
  return out;
}

const serviceFiles = (s: SkeletonService): string[] =>
  s.files ?? [s.source.file, ...s.controllers.map((c) => c.file), ...s.providers.map((p) => p.file)];

/** Adds the repository's datastores to the skeleton and the stores services use to their dependsOn. */
export function readDatastores(ctx: RepoContext, skeleton: Skeleton): void {
  const { stores, prismaEngines } = declaredStores(ctx);
  const taken = new Set(
    [...skeleton.clients, ...skeleton.servers, ...skeleton.services, ...skeleton.agents, ...skeleton.processes].map((e) => e.id),
  );
  const datastores: SkeletonDatastore[] = [];
  for (const s of stores.sort((a, b) => byString(a.id, b.id) || byString(a.source.file, b.source.file))) {
    let id = s.id;
    if (taken.has(id)) id = civilId(`${s.id}-store`);
    for (let n = 2; taken.has(id); n += 1) id = civilId(`${s.id}-store-${n}`);
    taken.add(id);
    datastores.push({ id, engine: s.engine === 'unknown' ? null : s.engine, source: s.source });
  }
  skeleton.datastores = [...(skeleton.datastores ?? []), ...datastores];

  const prismaEngine = prismaEngines.size === 1 ? [...prismaEngines][0]! : null;
  const cache = new Map<string, Map<string, string>>();
  const missing = new Map<string, { file: string; services: string[] }>();
  for (const service of skeleton.services) {
    const own = serviceFiles(service);
    const reached = new Map<string, string>(); // engine → file that imports its client
    for (const file of own) {
      for (const [engine] of enginesOfFile(ctx, file, prismaEngine, cache)) if (!reached.has(engine)) reached.set(engine, file);
      for (const dep of inRepoImports(ctx, file))
        for (const [engine] of enginesOfFile(ctx, dep, prismaEngine, cache)) if (!reached.has(engine)) reached.set(engine, dep);
    }
    for (const [engine, file] of [...reached].sort((a, b) => byString(a[0], b[0]))) {
      const candidates = datastores.filter((d) => d.engine === engine);
      if (candidates.length === 1) {
        if (!service.dependsOn.includes(candidates[0]!.id)) service.dependsOn.push(candidates[0]!.id);
      } else if (candidates.length > 1)
        skeleton.unresolved.push({
          file,
          reason: `service "${service.id}" uses a ${engine} client, and ${candidates.length} ${engine} datastores are declared (${candidates.map((c) => c.id).join(', ')}); cannot tell which, so none is drawn`,
        });
      else missing.set(engine, { file: missing.get(engine)?.file ?? file, services: [...(missing.get(engine)?.services ?? []), service.id] });
    }
    service.dependsOn.sort(byString);
  }
  for (const [engine, { file, services }] of [...missing].sort((a, b) => byString(a[0], b[0])))
    skeleton.unresolved.push({
      file,
      reason: `${services.map((s) => `"${s}"`).join(', ')} use${services.length === 1 ? 's' : ''} a ${engine} client, but no ${engine} datastore is declared in Terraform, docker-compose or a Prisma schema; not drawn`,
    });
  if (prismaEngines.size > 1)
    skeleton.unresolved.push({ file: '.', reason: `Prisma schemas name several providers (${[...prismaEngines].sort(byString).join(', ')}); @prisma/client imports are not attributed to a datastore` });
}
