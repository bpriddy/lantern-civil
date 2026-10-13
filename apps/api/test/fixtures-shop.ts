import type { Skeleton, SkeletonService } from '../dist/lift/skeleton.js';

/**
 * A synthetic shop: a web client with one directory per feature, an API with a module
 * per service, and a contracts package both sides import. Shared by the containment
 * and view tests; never a real project's names.
 */

const service = (id: string, dependsOn: string[] = []): SkeletonService => ({
  id,
  server: 'api',
  moduleClass: `${id[0]!.toUpperCase()}${id.slice(1)}Module`,
  source: { file: `apps/api/src/modules/${id}/index.ts` },
  controllers: [],
  providers: [],
  dependsOn,
  agents: [],
  infrastructure: false,
  directory: `apps/api/src/modules/${id}`,
});

export const skeleton = (): Skeleton => ({
  clients: [{ id: 'web', path: 'apps/web', framework: 'vite', devScript: 'vite', calls: ['api'], source: { file: 'apps/web/vite.config.ts' } }],
  servers: [
    {
      id: 'api',
      path: 'apps/api',
      framework: 'nestjs',
      globalPrefix: '/api',
      routes: [],
      exposes: ['catalog', 'orders', 'users', 'auth'],
      source: { file: 'apps/api/src/main.ts' },
    },
  ],
  services: [
    service('catalog', ['reviews', 'auth', 'storage', 'db']),
    service('reviews', ['mail', 'db']),
    service('orders', ['payments', 'catalog', 'auth', 'mail', 'db']),
    service('payments', ['audit', 'db']),
    service('users', ['auth', 'storage', 'audit', 'db']),
    service('auth', ['db']),
    service('mail'),
    service('storage'),
    service('audit', ['db']),
  ],
  agents: [],
  processes: [{ id: 'reindex', schedule: '0 * * * *', calls: ['catalog'], source: { file: 'apps/api/src/modules/catalog/index.ts' } }],
  datastores: [{ id: 'db', engine: 'postgres', source: { file: 'infra/main.tf' } }],
  unresolved: [],
  frameworks: ['nestjs', 'vite'],
});

export const files: Record<string, string> = {
  'packages/contracts/package.json': JSON.stringify({ name: '@acme/contracts' }),
  'packages/contracts/src/base.ts': 'export const base = 1;\n',
  'packages/contracts/src/catalog.ts': "import { base } from './base.js';\nexport const catalog = base;\n",
  'packages/contracts/src/orders.ts': "import { base } from './base.js';\nexport const orders = base;\n",
  'packages/contracts/src/users.ts': "import { base } from './base.js';\nexport const users = base;\n",
  'apps/web/src/lib/api.ts': "import { base } from '@acme/contracts/base';\nexport const call = base;\n",
  'apps/web/src/features/catalog/page.tsx': "import { catalog } from '@acme/contracts/catalog';\nimport { call } from '../../lib/api.js';\nexport default () => [catalog, call];\n",
  'apps/web/src/features/checkout/page.tsx': "import { orders } from '@acme/contracts/orders';\nimport { call } from '../../lib/api.js';\nexport default () => [orders, call];\n",
  'apps/web/src/features/account/page.tsx': "import { users } from '@acme/contracts/users';\nimport { call } from '../../lib/api.js';\nexport default () => [users, call];\n",
  'apps/api/src/main.ts': 'export {};\n',
  'apps/api/src/modules/catalog/index.ts': "import { catalog } from '@acme/contracts/catalog';\nexport const m = catalog;\n",
  'apps/api/src/modules/orders/index.ts': "import { orders } from '@acme/contracts/orders';\nexport const m = orders;\n",
  'apps/api/src/modules/users/index.ts': "import { users } from '@acme/contracts/users';\nexport const m = users;\n",
  'apps/api/src/modules/reviews/index.ts': 'export const m = 1;\n',
  'apps/api/src/modules/payments/index.ts': 'export const m = 1;\n',
  'apps/api/src/modules/auth/index.ts': "import { base } from '@acme/contracts/base';\nexport const m = base;\n",
  'apps/api/src/modules/mail/index.ts': 'export const m = 1;\n',
  'apps/api/src/modules/storage/index.ts': 'export const m = 1;\n',
  'apps/api/src/modules/audit/index.ts': 'export const m = 1;\n',
};

