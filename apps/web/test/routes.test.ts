import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoute, routePath, type Route } from '../src/routes.ts';

/**
 * The URL is a location the user can bookmark, refresh, and share — so parse and
 * build must round-trip exactly, and anything unrecognized must land at home
 * rather than a broken canvas.
 */

test('routes round-trip', () => {
  const routes: Route[] = [
    { kind: 'home' },
    { kind: 'project', projectId: 'b86ce042-3bae-425d-ad8e-746940db78c6' },
    {
      kind: 'graph',
      projectId: 'b86ce042-3bae-425d-ad8e-746940db78c6',
      graphPath: 'graphs/classify.graph.yaml',
    },
  ];
  for (const route of routes) {
    assert.deepEqual(parseRoute(routePath(route)), route);
  }
});

test('graph paths keep their slashes through the URL', () => {
  const path = routePath({ kind: 'graph', projectId: 'p1', graphPath: 'a/b/c.graph.yaml' });
  assert.equal(path, '/p/p1/g/a/b/c.graph.yaml');
});

test('anything unrecognized is home', () => {
  for (const pathname of ['/', '/nope', '/p', '/p/', '/x/y/z']) {
    assert.deepEqual(parseRoute(pathname), { kind: 'home' } satisfies Route);
  }
  // A dangling /g names no graph, so it degrades to the project it belongs to.
  assert.deepEqual(parseRoute('/p/abc/g'), { kind: 'project', projectId: 'abc' });
  assert.deepEqual(parseRoute('/p/abc/g/'), { kind: 'project', projectId: 'abc' });
  assert.deepEqual(parseRoute('/p/abc'), { kind: 'project', projectId: 'abc' });
});
