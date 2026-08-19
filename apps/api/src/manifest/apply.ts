import { stringify } from 'yaml';
import {
  ManifestEditError,
  applySplices,
  findSequence,
  readManifest,
  trimEnd,
  type ManifestDocument,
  type Splice,
} from './document.js';

/**
 * PRD 7.1: the client never constructs YAML. It posts ops; the server applies them to
 * the document, re-serialises preserving comments, validates, and returns diff +
 * validation.
 *
 * "Re-serialises preserving comments" is implemented as splicing rather than
 * regenerating — see document.ts for why that is the only way the byte-identical
 * requirement in PRD 6.5 can hold.
 *
 * This op layer is the seam for the roadmap agent (PRD 16) and for the command
 * registry: every mutation the UI can perform is expressible here, with no UI-only
 * shortcuts.
 */

export interface AddNodeOp {
  op: 'addNode';
  node: Record<string, unknown>;
}

export interface SetLayoutOp {
  op: 'setLayout';
  id: string;
  x: number;
  y: number;
}

export type ManifestOp = AddNodeOp | SetLayoutOp;

export interface ApplyResult {
  source: string;
  /** What was done, in words — the same string the toast and an agent transcript show. */
  summary: string;
}

/** The file's own indentation step, so a first entry lands in its column. */
function indentStepOf(source: string): number {
  let previous = 0;
  for (const line of source.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const width = line.length - line.trimStart().length;
    if (width > previous && !line.trimStart().startsWith('- ')) return width - previous;
    previous = width;
  }
  return 2;
}

/** How long a one-line item may get before block style reads better. */
const FLOW_WIDTH = 110;

/**
 * A value rendered so it can follow `key: ` on one line.
 *
 * The serialiser renders collections as block sequences and block mappings, which are
 * valid YAML on their own lines and nonsense inlined after a key — `include: - a` does
 * not parse. Collections are therefore rendered in flow style, which is also what the
 * manifests already use for exactly this: `include: ["src/**\/*.py"]`.
 */
function renderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(renderValue).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => `${key}: ${renderValue(v)}`)
      .join(', ');
    return `{ ${pairs} }`;
  }
  // Scalars go through the serialiser so quoting rules are its problem, not ours.
  return stringify(value, { lineWidth: 0 }).trim();
}

/**
 * One-line flow mapping, matching the style the PRD's own examples use.
 *
 * Each value is serialised on its own — asking the serialiser for the whole mapping
 * returns block style by definition, so testing its output for newlines said nothing
 * about whether this mapping fits on a line.
 */
function flowMapping(value: Record<string, unknown>, indent: string): string {
  const pairs = Object.entries(value).map(([key, v]) => {
    const text = renderValue(v);
    return { key, text, multiline: text.includes('\n') };
  });

  const line = `{ ${pairs.map((p) => `${p.key}: ${p.text}`).join(', ')} }`;

  // A value that is itself multi-line cannot sit in a flow mapping, and a very long
  // line is worse to read than the block form even where the neighbours are flow.
  if (pairs.some((p) => p.multiline) || line.length + indent.length > FLOW_WIDTH) {
    return blockMapping(value, indent);
  }
  return line;
}

function blockMapping(value: Record<string, unknown>, indent: string): string {
  return Object.entries(value)
    .map(([key, v], index) => `${index === 0 ? '' : indent}${key}: ${renderValue(v)}`)
    .join('\n');
}

export function applyOps(source: string, ops: readonly ManifestOp[]): ApplyResult {
  let current = source;
  const summaries: string[] = [];

  // Re-read between ops: each splice moves every offset after it, so ranges from a
  // previous parse are stale. Manifests are small and correctness is the point.
  for (const op of ops) {
    const manifest = readManifest(current);
    const { source: next, summary } = applyOne(manifest, op);
    current = next;
    summaries.push(summary);
  }

  return { source: current, summary: summaries.join('; ') };
}

function applyOne(manifest: ManifestDocument, op: ManifestOp): ApplyResult {
  switch (op.op) {
    case 'addNode':
      return addNode(manifest, op);
    case 'setLayout':
      return setLayout(manifest, op);
  }
}

function addNode(manifest: ManifestDocument, op: AddNodeOp): ApplyResult {
  const id = op.node['id'];
  if (typeof id !== 'string') throw new ManifestEditError('a node needs an id');

  const target = findSequence(manifest, ['spec', 'nodes']);

  // Written in the style of the items already there, because a manifest that suddenly
  // switches from flow to block at item seven does not look hand-written.
  // The continuation indent for a block item: the item prefix with its dash replaced
  // by spaces, so subsequent keys line up under the first.
  const continuation = target.itemPrefix.replace('\n', '').replace(/-\s*$/, '  ');

  const body = target.flow
    ? flowMapping(op.node, continuation)
    : blockMapping(op.node, continuation);

  const splice: Splice = {
    start: target.insertAt,
    end: target.replaceTo,
    text: `${target.itemPrefix}${body}`,
  };

  return {
    source: applySplices(manifest.source, [splice]),
    summary: `Added ${op.node['type'] ?? 'node'} “${id}”.`,
  };
}

/**
 * PRD 6.3: layout is a sibling of spec, never inside it. Dragging a node must not
 * produce a diff that looks like a semantic change, which is also why this op is
 * separate from addNode rather than folded into it.
 */
function setLayout(manifest: ManifestDocument, op: SetLayoutOp): ApplyResult {
  const nodes = manifest.doc.getIn(['layout', 'nodes'], true);
  if (!nodes || typeof nodes !== 'object' || !('range' in nodes)) {
    throw new ManifestEditError('this manifest has no layout.nodes block');
  }

  const existing = manifest.doc.getIn(['layout', 'nodes', op.id], true) as
    | { range?: [number, number, number] }
    | undefined;

  const text = `{ x: ${op.x}, y: ${op.y} }`;

  if (existing?.range) {
    return {
      source: applySplices(manifest.source, [
        { start: existing.range[0], end: existing.range[1], text },
      ]),
      summary: `Moved “${op.id}”.`,
    };
  }

  const range = (nodes as { range: [number, number, number] }).range;
  const block = manifest.source.slice(range[0], range[1]);

  // `layout: { nodes: {} }` is what a scaffolded project starts with, and an entry
  // cannot be appended after `{}` — the empty mapping has to be replaced, exactly as
  // an empty sequence does. Every new project's first node hits both.
  const lineStart = manifest.source.lastIndexOf('\n', range[0] - 1) + 1;
  const keyIndent = /^\s*/.exec(manifest.source.slice(lineStart, range[0]))?.[0] ?? '';

  if (block.trim() === '{}') {
    const step = ' '.repeat(indentStepOf(manifest.source));
    let start = range[0];
    while (start > lineStart && manifest.source[start - 1] === ' ') start -= 1;
    return {
      source: applySplices(manifest.source, [
        { start, end: range[1], text: `\n${keyIndent}${step}${op.id}: ${text}` },
      ]),
      summary: `Placed “${op.id}”.`,
    };
  }

  // Append in the column the existing entries use. The indent is read from the last
  // line that has content: a mapping's range can end past a trailing newline, and
  // measuring the empty remainder put the new entry at column zero, outside the block
  // it belongs to.
  const insertAt = trimEnd(manifest.source, range[1]);
  const entryLineStart = manifest.source.lastIndexOf('\n', insertAt - 1) + 1;
  const indent = /^\s*/.exec(manifest.source.slice(entryLineStart))?.[0] ?? `${keyIndent}  `;

  return {
    source: applySplices(manifest.source, [
      { start: insertAt, end: insertAt, text: `\n${indent}${op.id}: ${text}` },
    ]),
    summary: `Placed “${op.id}”.`,
  };
}
