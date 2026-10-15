import { parse, stringify } from 'yaml';
import { VIEWS_DIR } from '@civil/schema';
import dagre from '@dagrejs/dagre';
import type { ReadDiagram, Reading } from './interpret.js';
import type { FileMap } from './skeleton.js';

/**
 * The flow and architecture views a lift writes (docs/interpretation.md):
 * civil/views/<shape>/view.yaml and one Diagram document per diagram. They are a
 * reading of the code, rebuilt on every lift from answers memoised on the code — so an
 * Update over unchanged code writes the same bytes — and the author's positions win:
 * a node the author has moved keeps its place.
 */

type Point = { x: number; y: number };

/** A node's face on the canvas, for spacing: wide enough for a name and a summary line. */
const NODE_W = 220;
const NODE_H = 90;

/**
 * Laid out as a layered graph (dagre): left to right in the order work passes, lines
 * kept from crossing where they can. A flow's loops are drawn back without pushing the
 * layout right forever (dagre reverses a cycle's back edge to rank it). Architecture
 * reads the same way — people's apps on the left, what is kept on the right — with
 * concerns, which govern everything, pinned to the first rank.
 */
export function layoutDiagram(diagram: ReadDiagram, shape: 'flow' | 'architecture'): Map<string, Point> {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 90, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of diagram.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  const ids = new Set(diagram.nodes.map((n) => n.id));
  // Only lines that order work rank the layout: a uses line (a store read, a tool
  // called) and a governs line (a concern over everything) would only tangle it.
  diagram.edges.forEach((e, i) => {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return;
    if (e.kind === 'governs' || (shape === 'flow' && e.kind !== 'next')) return;
    g.setEdge(e.from, e.to, {}, `e${i}`);
  });
  const at = new Map<string, Point>();
  try {
    dagre.layout(g);
    for (const n of diagram.nodes) {
      const p = g.node(n.id) as { x: number; y: number } | undefined;
      at.set(n.id, { x: Math.round((p?.x ?? 0) - NODE_W / 2), y: Math.round((p?.y ?? 0) - NODE_H / 2) });
    }
  } catch {
    // A layout is a convenience: if it cannot be computed, a plain grid stands, and the
    // author can arrange it. It never costs the lift.
    diagram.nodes.forEach((n, i) => at.set(n.id, { x: 40 + (i % 4) * (NODE_W + 60), y: 40 + Math.floor(i / 4) * (NODE_H + 40) }));
  }
  return at;
}

const parseSafely = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  try {
    const doc = parse(text) as unknown;
    return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const VIEW_NAMES = { flow: 'Flow', architecture: 'Architecture' } as const;
const VIEW_DESCRIPTIONS = {
  flow: 'How the application thinks: the roles work passes through, from what starts it to what a person receives.',
  architecture: 'What the application is built on, and the decisions that define each piece.',
} as const;

export function readingDocuments(
  reading: Reading,
  /** Skeleton entity id → the composition's id for the part drawn from it. */
  partId: ReadonlyMap<string, string>,
  existing: FileMap,
): Record<string, string> {
  const dir = `${VIEWS_DIR}/${reading.shape}`;
  const files: Record<string, string> = {};
  files[`${dir}/view.yaml`] =
    '# A reading of the code by Generate graph from repo (docs/interpretation.md). Rebuilt on every\n' +
    '# Update; positions you set are kept.\n' +
    stringify(
      {
        apiVersion: 'civil/v1',
        kind: 'View',
        metadata: { id: reading.shape, name: VIEW_NAMES[reading.shape] },
        spec: { shape: reading.shape, entry: reading.entry, description: VIEW_DESCRIPTIONS[reading.shape] },
      },
      { lineWidth: 0 },
    );
  for (const d of reading.diagrams) {
    const path = `${dir}/${d.id}.yaml`;
    const fresh = layoutDiagram(d, reading.shape);
    const theirs = ((parseSafely(existing[path])?.['layout'] as { nodes?: Record<string, Point> } | undefined)?.nodes ?? {}) as Record<string, Point>;
    const layout: Record<string, Point> = {};
    for (const n of d.nodes) {
      const kept = theirs[n.id];
      layout[n.id] = kept && typeof kept.x === 'number' && typeof kept.y === 'number' ? { x: kept.x, y: kept.y } : fresh.get(n.id)!;
    }
    const body = {
      apiVersion: 'civil/v1',
      kind: 'Diagram',
      metadata: { id: d.id, name: d.name },
      spec: {
        ...(d.description ? { description: d.description } : {}),
        nodes: d.nodes.map((n) => {
          const parts = [...new Set(n.realizedBy.map((e) => partId.get(e)).filter((p): p is string => !!p))].sort();
          return {
            id: n.id,
            kind: n.kind,
            name: n.name,
            ...(n.summary ? { summary: n.summary } : {}),
            ...(parts.length ? { realizedBy: parts } : {}),
            ...(n.ref ? { ref: n.ref } : {}),
            confidence: n.confidence,
            ...(n.evidence.length ? { evidence: n.evidence } : {}),
            ...(n.decisions.length
              ? {
                  decisions: n.decisions.map((x) => ({
                    statement: x.statement,
                    ...(x.why ? { why: x.why } : {}),
                    ...(x.source ? { source: x.source } : {}),
                    ...(x.evidence.length ? { evidence: x.evidence } : {}),
                  })),
                }
              : {}),
          };
        }),
        edges: d.edges.map((e, i) => ({
          id: `e${i + 1}`,
          from: e.from,
          to: e.to,
          kind: e.kind,
          ...(e.label ? { label: e.label } : {}),
          confidence: e.confidence,
          ...(e.evidence.length ? { evidence: e.evidence } : {}),
        })),
      },
      layout: { nodes: layout },
    };
    files[path] = stringify(body, { lineWidth: 0 });
  }
  return files;
}
