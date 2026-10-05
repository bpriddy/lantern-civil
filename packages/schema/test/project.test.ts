import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zProject } from '../dist/index.js';

/**
 * civil.yaml's language: python is what Civil generates; typescript marks a project
 * lifted from an existing TypeScript codebase, whose own code is the implementation
 * (docs/lift-repo.md). Absent must still mean python — every project written before
 * the field widened says nothing and must keep generating.
 */

const project = (spec: Record<string, unknown>) => ({
  apiVersion: 'civil/v1',
  kind: 'Project',
  metadata: { id: 'demo', name: 'Demo' },
  spec,
});

test('language defaults to python when civil.yaml does not say', () => {
  const parsed = zProject.safeParse(project({}));
  assert.ok(parsed.success);
  assert.equal(parsed.data.spec.language, 'python');
});

test('language accepts typescript for a lifted project', () => {
  const parsed = zProject.safeParse(project({ language: 'typescript' }));
  assert.ok(parsed.success);
  assert.equal(parsed.data.spec.language, 'typescript');
});

test('language still accepts python explicitly and refuses anything else', () => {
  assert.equal(zProject.safeParse(project({ language: 'python' })).success, true);
  assert.equal(zProject.safeParse(project({ language: 'rust' })).success, false);
});
