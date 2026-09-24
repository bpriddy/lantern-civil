import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scaffoldFiles } from '../dist/project/scaffold.js';

/**
 * scaffoldFiles is what "add Civil to this project" writes on disk (as pending
 * changes). Getting the exact path set and the civil/ refs wrong here means either
 * a broken project on creation, or civil.yaml pointing at a composition that is not
 * where CIVIL.md and the rest of the toolchain expect it.
 */

function fileAt(files: ReturnType<typeof scaffoldFiles>, path: string): string {
  const found = files.find((f) => f.path === path);
  assert.ok(found, `expected a scaffolded file at ${path}`);
  return found!.content;
}

test('scaffoldFiles writes exactly the three-file civil/ skeleton', () => {
  const files = scaffoldFiles('My Project');
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['CIVIL.md', 'civil/app.yaml', 'civil/civil.yaml']);
});

test('civil/civil.yaml points its composition ref at civil/app.yaml', () => {
  const civilYaml = fileAt(scaffoldFiles('My Project'), 'civil/civil.yaml');
  assert.match(civilYaml, /^apiVersion: civil\/v1$/m);
  assert.match(civilYaml, /^kind: Project$/m);
  assert.match(civilYaml, /composition: civil\/app\.yaml/, 'the composition ref is civil/-prefixed');
  assert.match(civilYaml, /name: My Project/);
  assert.match(civilYaml, /language: python/);
});

test('civil/app.yaml is an empty composition canvas with layout kept separate from spec', () => {
  const appYaml = fileAt(scaffoldFiles('My Project'), 'civil/app.yaml');
  assert.match(appYaml, /^apiVersion: civil\/v1$/m);
  assert.match(appYaml, /^kind: Composition$/m);
  assert.match(appYaml, /name: My Project/);
  assert.match(appYaml, /nodes: \[\]/, 'starts with no nodes');
  assert.match(appYaml, /edges: \[\]/, 'starts with no edges');
  // layout is a top-level sibling of spec, not nested inside it.
  assert.match(appYaml, /^layout:\n\s+nodes: \{\}/m);
  const specIndex = appYaml.indexOf('\nspec:');
  const layoutIndex = appYaml.indexOf('\nlayout:');
  assert.ok(specIndex > -1 && layoutIndex > specIndex, 'layout follows spec as a sibling key');
});

test('CIVIL.md lives at the repo root, not under civil/', () => {
  const files = scaffoldFiles('My Project');
  const civilMd = files.find((f) => f.path === 'CIVIL.md');
  assert.ok(civilMd, 'CIVIL.md is one of the scaffolded files');
  assert.equal(civilMd!.path, 'CIVIL.md', 'not civil/CIVIL.md');
  assert.match(civilMd!.content, /^# My Project/, 'titled after the project');
  assert.doesNotMatch(civilMd!.content, /civil\.yaml|app\.yaml/, 'the readme does not itself embed manifest refs');
});

test('both civil/ documents share the same project id, derived from the name', () => {
  const files = scaffoldFiles('My Project');
  const civilYaml = fileAt(files, 'civil/civil.yaml');
  const appYaml = fileAt(files, 'civil/app.yaml');
  const idIn = (content: string) => content.match(/id: (\S+)/)?.[1];
  assert.equal(idIn(civilYaml), 'my-project');
  assert.equal(idIn(appYaml), 'my-project');
});

test('project ids are lowercased and hyphenated (PRD 6.4)', () => {
  const civilYaml = fileAt(scaffoldFiles('Réal Wörld  Name!!'), 'civil/civil.yaml');
  const id = civilYaml.match(/id: (\S+)/)?.[1];
  assert.ok(id, 'an id was generated');
  assert.match(id!, /^[a-z][a-z0-9_-]*$/, 'id is lowercase, starts with a letter, and uses only id-safe characters');
});

test('an id that would not start with a letter is prefixed with project-', () => {
  const civilYaml = fileAt(scaffoldFiles('123 Project'), 'civil/civil.yaml');
  assert.match(civilYaml, /id: project-123-project/);
});

test('ids are truncated to 64 characters', () => {
  const longName = 'a'.repeat(100);
  const civilYaml = fileAt(scaffoldFiles(longName), 'civil/civil.yaml');
  const id = civilYaml.match(/id: (\S+)/)?.[1];
  assert.ok(id, 'an id was generated');
  assert.equal(id, 'a'.repeat(64), 'id is truncated to exactly 64 characters');
});

test('the project name itself is not mutated even when the id must be transformed', () => {
  const civilYaml = fileAt(scaffoldFiles('Réal Wörld  Name!!'), 'civil/civil.yaml');
  assert.match(civilYaml, /name: Réal Wörld {2}Name!!/, 'the display name is written verbatim');
});
