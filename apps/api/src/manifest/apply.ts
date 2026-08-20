import { isMap, isScalar, isSeq, stringify, type YAMLMap } from 'yaml';
import { ID_PATTERN } from '@civil/schema';
import {
  ManifestEditError,
  applySplices,
  findItemMap,
  findSequence,
  readManifest,
  removeMapEntries,
  removeMapEntry,
  removeSequenceItem,
  removeSequenceItems,
  setMapEntries,
  trimEnd,
  valueStartOfKey,
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

export interface AddEdgeOp {
  op: 'addEdge';
  edge: Record<string, unknown>;
}

export interface RemoveEdgeOp {
  op: 'removeEdge';
  id: string;
}

export interface RemoveNodeOp {
  op: 'removeNode';
  id: string;
  /** Defaults to true: a node's edges go with it, or the manifest dangles. */
  cascadeEdges?: boolean;
}

export interface UpdateNodeOp {
  op: 'updateNode';
  id: string;
  /** Field → new value. `null` removes the field. `id` and `type` are refused. */
  patch: Record<string, unknown>;
}

export interface UpdateEdgeOp {
  op: 'updateEdge';
  id: string;
  patch: Record<string, unknown>;
}

export interface RenameNodeOp {
  op: 'renameNode';
  from: string;
  to: string;
  /** Defaults to true: edge endpoints, exposes/calls lists, invocation keys, and the
   *  layout entry are rewritten in the same application, so the rename is atomic. */
  updateReferences?: boolean;
}

export type ManifestOp =
  | AddNodeOp
  | SetLayoutOp
  | AddEdgeOp
  | RemoveEdgeOp
  | RemoveNodeOp
  | UpdateNodeOp
  | UpdateEdgeOp
  | RenameNodeOp;

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
  // A string with a newline would serialise as a block scalar — several lines, which
  // no inline position can hold. JSON's escaped form is valid YAML on one line.
  if (typeof value === 'string' && value.includes('\n')) return JSON.stringify(value);
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
    case 'addEdge':
      return addEdge(manifest, op);
    case 'removeEdge':
      return removeEdge(manifest, op);
    case 'removeNode':
      return removeNode(manifest, op);
    case 'updateNode':
      return updateItem(manifest, ['spec', 'nodes'], op.id, op.patch, 'node');
    case 'updateEdge':
      return updateItem(manifest, ['spec', 'edges'], op.id, op.patch, 'edge');
    case 'renameNode':
      return renameNode(manifest, op);
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

  // Inside inline brackets there is no falling back to block style — a block item
  // cannot exist there, so the one-line form is used however long it gets.
  const body =
    target.itemPrefix === ', '
      ? renderValue(op.node)
      : target.flow
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

function addEdge(manifest: ManifestDocument, op: AddEdgeOp): ApplyResult {
  const id = op.edge['id'];
  if (typeof id !== 'string') throw new ManifestEditError('an edge needs an id');

  const target = findSequence(manifest, ['spec', 'edges']);
  const continuation = target.itemPrefix.replace('\n', '').replace(/-\s*$/, '  ');
  const body =
    target.itemPrefix === ', '
      ? renderValue(op.edge)
      : target.flow
        ? flowMapping(op.edge, continuation)
        : blockMapping(op.edge, continuation);

  const from = (op.edge['from'] as { node?: string } | undefined)?.node;
  const to = (op.edge['to'] as { node?: string } | undefined)?.node;

  return {
    source: applySplices(manifest.source, [
      { start: target.insertAt, end: target.replaceTo, text: `${target.itemPrefix}${body}` },
    ]),
    summary: `Connected ${from ?? '?'} → ${to ?? '?'}.`,
  };
}

/**
 * PRD 6.4 forbids dangling edges, so removing one is how a connection is undone —
 * and removing a node has to take its edges with it.
 */
function removeEdge(manifest: ManifestDocument, op: RemoveEdgeOp): ApplyResult {
  return {
    source: applySplices(manifest.source, [removeSequenceItem(manifest, ['spec', 'edges'], op.id)]),
    summary: `Disconnected “${op.id}”.`,
  };
}

/** What the document says right now, for deciding what an op has to touch. */
function manifestData(manifest: ManifestDocument): {
  nodes: Record<string, unknown>[];
  edges: { id?: string; from?: { node?: string }; to?: { node?: string } }[];
} {
  const data = manifest.doc.toJS() as {
    spec?: { nodes?: unknown; edges?: unknown };
  } | null;
  return {
    nodes: Array.isArray(data?.spec?.nodes) ? (data.spec.nodes as Record<string, unknown>[]) : [],
    edges: Array.isArray(data?.spec?.edges) ? (data.spec.edges as never[]) : [],
  };
}

/**
 * PRD 7.1's example op. The cascade is the point: a removed node's edges go with it
 * in the same application, because a manifest referring to a node that is not there
 * is worse than the node was.
 */
function removeNode(manifest: ManifestDocument, op: RemoveNodeOp): ApplyResult {
  const { nodes, edges } = manifestData(manifest);
  const node = nodes.find((n) => n['id'] === op.id);
  if (!node) throw new ManifestEditError(`no item with id "${op.id}" in spec.nodes`);

  const touching = edges.filter((e) => e.from?.node === op.id || e.to?.node === op.id);

  if (op.cascadeEdges === false && touching.length > 0) {
    const names = touching.map((e) => `"${e.id}"`).join(', ');
    throw new ManifestEditError(
      `“${op.id}” still has ${touching.length} edge${touching.length === 1 ? '' : 's'} (${names}). ` +
        'Remove them first, or let cascadeEdges take them along.',
    );
  }

  const splices: Splice[] = [removeSequenceItem(manifest, ['spec', 'nodes'], op.id)];

  if (touching.length > 0) {
    const edgeIds = touching.map((edge) => {
      if (typeof edge.id !== 'string') {
        throw new ManifestEditError(`an edge touching “${op.id}” has no id; remove it by hand`);
      }
      return edge.id;
    });
    // One call for the whole set: adjacent flow items share commas, so their spans
    // must be computed together or they overlap — and when the set is every edge,
    // the list is written back as `[]` rather than shredded item by item.
    splices.push(...removeSequenceItems(manifest, ['spec', 'edges'], edgeIds));
  }

  const layoutSplice = removeLayoutEntry(manifest, op.id);
  if (layoutSplice) splices.push(layoutSplice);

  const kind = typeof node['type'] === 'string' ? (node['type'] as string) : 'node';
  const cascade =
    touching.length > 0
      ? ` and ${touching.length} edge${touching.length === 1 ? '' : 's'}`
      : '';
  return {
    source: applySplices(manifest.source, splices),
    summary: `Removed ${kind} “${op.id}”${cascade}.`,
  };
}

/** The layout entry goes with its node; an emptied layout block is written as {}. */
function removeLayoutEntry(manifest: ManifestDocument, id: string): Splice | undefined {
  const nodes = manifest.doc.getIn(['layout', 'nodes'], true);
  if (!isMap(nodes)) return undefined;

  const entry = removeMapEntry(manifest, nodes as YAMLMap, id);
  if (!entry) return undefined;

  if ((nodes as YAMLMap).items.length === 1 && !(nodes as { flow?: boolean }).flow) {
    return { start: valueStartOfKey(manifest, ['layout', 'nodes']), end: entry.end, text: ' {}' };
  }
  return entry;
}

/**
 * updateNode and updateEdge are one mechanism: set fields, remove fields set to
 * null, and leave every byte the patch does not name alone. The identity fields are
 * refused — id has renameNode, and a node's type decides which fields may exist at
 * all, so changing it is a remove-and-add, not an edit.
 */
function updateItem(
  manifest: ManifestDocument,
  path: readonly string[],
  id: string,
  patch: Record<string, unknown>,
  what: 'node' | 'edge',
): ApplyResult {
  if ('id' in patch) {
    throw new ManifestEditError(
      what === 'node' ? 'an id is changed with renameNode, not a patch' : 'an edge id cannot be patched',
    );
  }
  if (what === 'node' && 'type' in patch) {
    throw new ManifestEditError(
      'a node\'s type decides its whole shape; remove the node and add the one you mean',
    );
  }
  if (Object.keys(patch).length === 0) {
    throw new ManifestEditError('an empty patch changes nothing');
  }

  const map = findItemMap(manifest, path, id);
  const rendered = new Map<string, string>();
  const set: string[] = [];
  const nulled: string[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      nulled.push(key);
      continue;
    }
    rendered.set(key, renderValue(value));
    set.push(key);
  }

  // Removals go through one call so that adjacent flow entries — whose spans share
  // a comma — are merged rather than overlapping.
  const { splices, removed } = removeMapEntries(manifest, map, nulled);
  splices.push(...setMapEntries(manifest, map, rendered));

  if (set.length === 0 && removed.length === 0) {
    throw new ManifestEditError(`nothing in that patch applies to “${id}”`);
  }

  const parts = [
    set.length > 0 ? `set ${set.join(', ')}` : '',
    removed.length > 0 ? `removed ${removed.join(', ')}` : '',
  ].filter(Boolean);
  return {
    source: applySplices(manifest.source, splices),
    summary: `Updated “${id}” (${parts.join('; ')}).`,
  };
}

/** A scalar's replacement splice, when it holds exactly the value being renamed. */
function renamedScalar(node: unknown, from: string, rendered: string): Splice | undefined {
  if (!isScalar(node) || node.value !== from || !node.range) return undefined;
  return { start: node.range[0], end: node.range[1], text: rendered };
}

/**
 * PRD 7.1 gives renameNode updateReferences, and this is why: an id is not a label,
 * it is what everything else holds on to. Edge endpoints, exposes and calls lists,
 * invocation keys, and the layout entry all say it by name, and a rename that misses
 * one leaves the manifest pointing at a node that no longer exists.
 *
 * Everything is rewritten from one parse and applied as one splice set, so the
 * rename cannot half-happen.
 */
function renameNode(manifest: ManifestDocument, op: RenameNodeOp): ApplyResult {
  if (!ID_PATTERN.test(op.to)) {
    throw new ManifestEditError(`"${op.to}" is not a valid id (${ID_PATTERN.source})`);
  }

  const { nodes } = manifestData(manifest);
  if (!nodes.some((n) => n['id'] === op.from)) {
    throw new ManifestEditError(`no item with id "${op.from}" in spec.nodes`);
  }
  if (nodes.some((n) => n['id'] === op.to)) {
    throw new ManifestEditError(`there is already a node called "${op.to}"`);
  }

  const splices: Splice[] = [];

  // ID_PATTERN admits ids YAML would read as something else entirely — `true`,
  // `null`, `on` — so the replacement text comes from the serialiser, which quotes
  // exactly when quoting is needed.
  const rendered = renderValue(op.to);

  const own = findItemMap(manifest, ['spec', 'nodes'], op.from);
  const idSplice = renamedScalar(own.get('id', true), op.from, rendered);
  if (!idSplice) throw new ManifestEditError(`the id of "${op.from}" has no position in the source`);
  splices.push(idSplice);

  if (op.updateReferences !== false) {
    const push = (splice: Splice | undefined) => {
      if (splice) splices.push(splice);
    };

    const nodeSeq = manifest.doc.getIn(['spec', 'nodes'], true);
    if (isSeq(nodeSeq)) {
      for (const item of nodeSeq.items) {
        if (!isMap(item)) continue;
        // Composition references: what a client exposes, what a process calls, and
        // which services a client overrides invocation for.
        for (const listKey of ['exposes', 'calls']) {
          const list = item.get(listKey, true);
          if (isSeq(list)) for (const entry of list.items) push(renamedScalar(entry, op.from, rendered));
        }
        const invocation = item.get('invocation', true);
        if (isMap(invocation)) {
          for (const pair of invocation.items) push(renamedScalar(pair.key, op.from, rendered));
        }
      }
    }

    const edgeSeq = manifest.doc.getIn(['spec', 'edges'], true);
    if (isSeq(edgeSeq)) {
      for (const item of edgeSeq.items) {
        if (!isMap(item)) continue;
        for (const endKey of ['from', 'to']) {
          const end = item.get(endKey, true);
          if (isMap(end)) push(renamedScalar(end.get('node', true), op.from, rendered));
        }
      }
    }

    const layout = manifest.doc.getIn(['layout', 'nodes'], true);
    if (isMap(layout)) {
      for (const pair of layout.items) push(renamedScalar(pair.key, op.from, rendered));
    }
  }

  const references = splices.length - 1;
  const detail =
    references > 0 ? ` (${references} reference${references === 1 ? '' : 's'} updated)` : '';
  return {
    source: applySplices(manifest.source, splices),
    summary: `Renamed “${op.from}” to “${op.to}”${detail}.`,
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
