import { parse, parseDocument, isSeq, isMap } from 'yaml';
import { VIEWS_DIR } from '@civil/schema';
import { columnLayout, freeSpot } from './documents-model.js';
import { flow, scalar } from './documents-yaml.js';
import type { ModelDomain, ModelView } from './views.js';
import type { FileMap } from './skeleton.js';

/**
 * The view documents a lift writes (docs/prd-deltas.md §21): civil/views/<view>/view.yaml
 * and one file per domain. Written fresh on a first lift; on Update merged under the
 * same rules as the composition (documents-merge.ts):
 *
 * - **The author's arrangement wins.** A part the view already places stays where it is;
 *   a domain file the author has is kept, its members, name and positions untouched.
 * - **What is new is placed.** A part the view does not place yet goes where the lift
 *   proposes: into its domain (the file is created when the author has none), or at
 *   the top. Its position is a free spot beside what is already placed.
 * - **Nothing is removed.** A domain the lift no longer proposes is the author's to delete.
 * - **No change, no bytes.** A view with nothing new to place is left exactly as it is.
 */

type Point = { x: number; y: number };

const viewDir = (id: string) => `${VIEWS_DIR}/${id}`;

/** A column per kind of thing, left to right as traffic flows; domains beside services. */
const columnOf = (id: string, partColumns: ReadonlyMap<string, number>, domains: ReadonlyMap<string, ModelDomain>): number => {
  const d = domains.get(id);
  if (d) return d.foundation ? 5 : 2;
  return partColumns.get(id) ?? 2;
};

function layoutLines(layout: ReadonlyMap<string, Point>): string[] {
  return layout.size === 0
    ? ['layout:', '  nodes: {}']
    : ['layout:', '  nodes:', ...[...layout].map(([id, p]) => `    ${scalar(id)}: { x: ${p.x}, y: ${p.y} }`)];
}

function viewYaml(view: ModelView, top: string[], layout: ReadonlyMap<string, Point>): string {
  return [
    'apiVersion: civil/v1',
    'kind: View',
    'metadata:',
    `  id: ${scalar(view.id)}`,
    `  name: ${scalar(view.name, false)}`,
    '',
    '# A way of looking at civil/app.yaml: it groups and places the parts, never adds one.',
    '# Written by Generate graph from repo; rearrange it freely — Update keeps your arrangement.',
    'spec:',
    `  description: ${scalar(view.description, false)}`,
    `  unplaced: ${view.unplaced}`,
    `  members: ${flow(top)}`,
    '',
    ...layoutLines(layout),
    '',
  ].join('\n');
}

function domainYaml(d: ModelDomain, members: string[], unsure: string[], layout: ReadonlyMap<string, Point>): string {
  return [
    'apiVersion: civil/v1',
    'kind: Domain',
    'metadata:',
    `  id: ${scalar(d.id)}`,
    `  name: ${scalar(d.name, false)}`,
    'spec:',
    ...(d.parent ? [`  parent: ${scalar(d.parent)}`] : []),
    ...(d.description ? [`  description: ${scalar(d.description, false)}`] : []),
    ...(d.foundation ? ['  foundation: true'] : []),
    `  members: ${flow(members)}`,
    ...(unsure.length ? [`  unsure: ${flow(unsure)}`] : []),
    ...(d.evidence.length ? [`  evidence: ${flow(d.evidence)}`] : []),
    '',
    ...layoutLines(layout),
    '',
  ].join('\n');
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
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const pointsOf = (doc: Record<string, unknown> | undefined): Point[] =>
  Object.values(((doc?.['layout'] as { nodes?: Record<string, unknown> } | undefined)?.nodes ?? {}) as Record<string, Point>).filter(
    (p) => p && typeof p.x === 'number' && typeof p.y === 'number',
  );

/**
 * Appends to a document's spec.members and layout.nodes through the YAML document
 * model, so the author's comments and the rest of the text survive.
 */
function appendTo(text: string, members: string[], positions: ReadonlyMap<string, Point>): string {
  const doc = parseDocument(text);
  const seq = doc.getIn(['spec', 'members'], true);
  if (isSeq(seq)) for (const m of members) seq.add(m);
  else doc.setIn(['spec', 'members'], members);
  const nodes = doc.getIn(['layout', 'nodes'], true);
  for (const [id, p] of positions) {
    const point = doc.createNode({ x: p.x, y: p.y });
    point.flow = true;
    if (isMap(nodes)) nodes.set(id, point);
    else doc.setIn(['layout', 'nodes', id], point);
  }
  return doc.toString({ lineWidth: 0 });
}

export interface ViewWrite {
  files: Record<string, string>;
  notes: string[];
}

/**
 * The view documents for this lift. `ids` maps the lift's part ids to the ids the
 * composition uses (the author's, after an Update); `present` is every part id the
 * composition will have; `columns` is each part's layout column.
 */
export function viewDocuments(
  views: readonly ModelView[],
  ids: ReadonlyMap<string, string>,
  present: ReadonlySet<string>,
  columns: ReadonlyMap<string, number>,
  existing: FileMap,
): ViewWrite {
  const files: Record<string, string> = {};
  const notes: string[] = [];
  const idOf = (lift: string) => ids.get(lift) ?? lift;

  for (const view of views) {
    const dir = viewDir(view.id);
    const domains = new Map(view.domains.map((d) => [d.id, d]));
    const partsOf = (list: string[]) => list.map(idOf).filter((id) => present.has(id));
    const viewPath = `${dir}/view.yaml`;
    const have = parseSafely(existing[viewPath]);

    if (!have) {
      // Fresh: every level laid out on its own grid.
      const levelLayout = (items: string[]) =>
        columnLayout(items.map((id) => ({ id, column: columnOf(id, columns, domains) })));
      const topDomains = view.domains.filter((d) => !d.parent).map((d) => d.id);
      const top = partsOf(view.top);
      files[viewPath] = viewYaml(view, top, levelLayout([...topDomains, ...top]));
      for (const d of view.domains) {
        const members = partsOf(d.members);
        const inner = view.domains.filter((c) => c.parent === d.id).map((c) => c.id);
        files[`${dir}/${d.id}.yaml`] = domainYaml(d, members, partsOf(d.unsure), levelLayout([...inner, ...members]));
      }
      continue;
    }

    // Update: place only what the view does not place yet.
    const domainPaths = Object.keys(existing).filter(
      (p) => p.startsWith(`${dir}/`) && p !== viewPath && !p.slice(dir.length + 1).includes('/') && /\.ya?ml$/.test(p),
    );
    const theirs = new Map(domainPaths.map((p) => [p, parseSafely(existing[p])]));
    const placed = new Set([
      ...strings((have['spec'] as Record<string, unknown> | undefined)?.['members']),
      ...[...theirs.values()].flatMap((doc) => strings((doc?.['spec'] as Record<string, unknown> | undefined)?.['members'])),
    ]);
    const unplacedIn = (list: string[]) => partsOf(list).filter((id) => !placed.has(id));
    let added = 0;
    const place = (path: string, text: string | undefined, fresh: () => string, members: string[], doc: Record<string, unknown> | undefined) => {
      if (members.length === 0) return;
      added += members.length;
      if (text === undefined) {
        files[path] = fresh();
        return;
      }
      const occupied = pointsOf(doc);
      const spots = new Map<string, Point>();
      const start = columnLayout(members.map((id) => ({ id, column: columns.get(id) ?? 2 })));
      for (const id of members) {
        const at = freeSpot(start.get(id)!, occupied);
        occupied.push(at);
        spots.set(id, at);
      }
      files[path] = appendTo(text, members, spots);
    };
    for (const d of view.domains) {
      const path = `${dir}/${d.id}.yaml`;
      const members = unplacedIn(d.members);
      members.forEach((m) => placed.add(m));
      place(
        path,
        existing[path],
        () => domainYaml(d, members, partsOf(d.unsure).filter((u) => members.includes(u)), columnLayout(members.map((id) => ({ id, column: columns.get(id) ?? 2 })))),
        members,
        theirs.get(path),
      );
    }
    const top = unplacedIn(view.top);
    place(viewPath, existing[viewPath], () => '', top, have);
    // The rest of the view as it stands, so the result is the whole view either way.
    for (const path of [viewPath, ...domainPaths]) files[path] ??= existing[path]!;
    if (added) notes.push(`placed ${added} new part${added === 1 ? '' : 's'} in the ${view.name} view; your arrangement is unchanged`);
  }
  return { files, notes };
}
