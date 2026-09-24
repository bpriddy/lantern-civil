import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverContracts, type Contract } from '../dist/project/contracts.js';

/**
 * Contract discovery is a nicety, never load-bearing (contracts.ts's own header): a
 * request that cannot be answered must quietly become "no contract" rather than an
 * exception, and an empty batch must not even reach for the interpreter. The one
 * path that does matter completely is the happy path, since M4's runtime binds
 * arguments against the very same civil_runtime.discover this calls.
 */

// A small, real function-backed service (examples/doc-pipeline/src/services/save_record.py)
// — TypedDict in, TypedDict out — used to check the discovered Contract's shape end to end.
const HANDLER_SOURCE = `"""A function-backed service.

PRD 4: this and the graph-backed \`classify\` are one thing at two resolutions.
Nothing upstream cares which it is, and this could become a graph later with no
change to the composition.
"""

from __future__ import annotations

from typing import TypedDict


class Record(TypedDict):
    id: str
    category: str
    confidence: float


class SaveResult(TypedDict):
    id: str
    stored: bool


def handler(record: Record) -> SaveResult:
    return {"id": record["id"], "stored": True}
`;

test('discoverContracts returns an empty map for an empty request list, without spawning python', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civil-contracts-test-'));
  const marker = path.join(dir, 'spawned.marker');
  const fakePython = path.join(dir, 'fake-python.sh');
  // If discoverContracts ever spawned this in place of a real interpreter, it would
  // leave this marker behind. An empty request list must return before that point.
  fs.writeFileSync(fakePython, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  fs.chmodSync(fakePython, 0o755);

  try {
    const results = await discoverContracts([], { python: fakePython });
    assert.equal(results.size, 0);
    assert.equal(fs.existsSync(marker), false, 'no child process was ever spawned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverContracts discovers a real Contract from a small python function (spawns civil_runtime.discover)', async () => {
  const results = await discoverContracts([{ key: 'save', source: HANDLER_SOURCE }]);

  assert.equal(results.size, 1);
  const result = results.get('save');
  assert.ok(result, 'a result exists for the request key');
  assert.ok(!('error' in result!), `expected a Contract, got an error: ${JSON.stringify(result)}`);

  const contract = result as Contract;
  assert.equal(contract.name, 'handler');
  assert.equal(contract.description, 'A function-backed service.', 'falls back to the module docstring, first line only');
  assert.equal(contract.isAsync, false);

  assert.equal(contract.inputs.length, 1);
  assert.deepEqual(contract.inputs[0], {
    name: 'record',
    type: 'Record',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        category: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['id', 'category', 'confidence'],
    },
    required: true,
  });

  assert.deepEqual(contract.output, {
    type: 'SaveResult',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        stored: { type: 'boolean' },
      },
      required: ['id', 'stored'],
    },
  });
});

test('discoverContracts can discover a named function rather than the handler convention', async () => {
  const source = `def add(a: int, b: int = 1) -> int:\n    return a + b\n`;
  const results = await discoverContracts([{ key: 'add-fn', source, function: 'add' }]);

  const contract = results.get('add-fn') as Contract;
  assert.ok(contract && !('error' in contract));
  assert.equal(contract.name, 'add');
  assert.equal(contract.inputs.length, 2);
  assert.equal(contract.inputs[0]!.required, true, 'a is positional with no default');
  assert.equal(contract.inputs[1]!.required, false, 'b has a default');
});

test('discoverContracts degrades quietly on unparseable source: no Contract, no throw', async () => {
  const badSource = 'def broken(:\n    pass\n';

  const results = await discoverContracts([{ key: 'broken', source: badSource }]);

  assert.equal(results.size, 1, 'the batch still answers for the key, just not with a contract');
  const result = results.get('broken');
  assert.ok(result);
  assert.ok('error' in result!, 'a syntax error becomes a per-key error, not a Contract');
  assert.ok(!('name' in result!), 'no Contract shape leaks through for the broken source');
  assert.equal(typeof (result as { error: string }).error, 'string');
});

test('discoverContracts answers a mixed batch: good and bad sources do not interfere', async () => {
  const goodSource = 'def handler(x: int) -> int:\n    return x\n';
  const badSource = 'def also_broken(\n';

  const results = await discoverContracts([
    { key: 'good', source: goodSource },
    { key: 'bad', source: badSource },
  ]);

  assert.equal(results.size, 2);
  assert.ok(!('error' in results.get('good')!), 'the good source in the same batch is unaffected');
  assert.ok('error' in results.get('bad')!);
});
