import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadBundle } from '../dist/project/bundle.js';
import { LocalSource } from '../dist/project/source.js';

/**
 * Contract discovery reads Python (contracts.ts). A project lifted from a TypeScript
 * repo (docs/lift-repo.md) points its service nodes at .ts files; those must show no
 * ports, not a Python parse error on every node of the canvas.
 */
test('only Python entrypoints are sent to contract discovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civil-bundle-'));
  const write = (p: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  };
  write('civil/civil.yaml', 'apiVersion: civil/v1\nkind: Project\nmetadata: { id: mixed }\nspec: { composition: civil/app.yaml }\n');
  write(
    'civil/app.yaml',
    [
      'apiVersion: civil/v1',
      'kind: Composition',
      'metadata: { id: app }',
      'spec:',
      '  nodes:',
      '    - { id: py, type: service, impl: { entrypoint: src/py_service.py } }',
      '    - { id: ts, type: service, impl: { entrypoint: server/src/tasks.service.ts } }',
      '  edges: []',
      '',
    ].join('\n'),
  );
  write('src/py_service.py', 'def run(text: str) -> str:\n    """Echo."""\n    return text\n');
  // Not Python: Python's parser would call this an unterminated string literal.
  write('server/src/tasks.service.ts', "export class TasksService { list() { return `it's`; } }\n");

  try {
    const bundle = await loadBundle(new LocalSource(root));
    assert.equal(bundle.contracts['civil/app.yaml:ts'], undefined, 'a .ts entrypoint has no contract, and no error');
    const py = bundle.contracts['civil/app.yaml:py'];
    assert.ok(py && !('error' in py), `the Python one is still discovered: ${JSON.stringify(py)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
