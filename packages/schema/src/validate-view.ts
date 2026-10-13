import type { Diagnostic } from './diagnostics.js';
import { fromZod } from './validate.js';
import { zDomain, zView, type Domain, type View } from './manifest/view.js';

/**
 * A view checked against the composition it looks at (docs/prd-deltas.md §21). The
 * composition is the master: a view may only name parts it has. Within a view a part
 * is placed once, a domain's parent is a domain of the same view, and no domain is
 * inside itself. A domain file is named for its id.
 */
export interface ViewSource {
  /** civil/views/<id>/view.yaml and its parsed document. */
  path: string;
  raw: unknown;
  /** The view's other documents: one per domain. */
  domains: { path: string; raw: unknown }[];
}

export interface ViewResult {
  view?: View;
  /** Domain id → its document and path, for every domain that parsed. */
  domains: Record<string, { path: string; doc: Domain }>;
  diagnostics: Diagnostic[];
}

const at = (path: string, pointer: string, code: Diagnostic['code'], message: string, nodeId?: string): Diagnostic => ({
  file: path,
  jsonPointer: pointer,
  code,
  message,
  severity: 'error',
  ...(nodeId ? { nodeId } : {}),
});

export function validateView(source: ViewSource, parts: ReadonlySet<string>): ViewResult {
  const diagnostics: Diagnostic[] = [];
  const parsed = zView.safeParse(source.raw);
  if (!parsed.success) diagnostics.push(...fromZod(parsed.error.issues, source.path));
  const view = parsed.success ? parsed.data : undefined;
  const dir = source.path.split('/').slice(-2, -1)[0];
  if (view && dir !== undefined && view.metadata.id !== dir) {
    diagnostics.push(at(source.path, '/metadata/id', 'invalid-manifest', `view "${view.metadata.id}" is in views/${dir}/; a view's directory is named for its id`));
  }

  const domains: ViewResult['domains'] = {};
  for (const file of source.domains) {
    const result = zDomain.safeParse(file.raw);
    if (!result.success) {
      diagnostics.push(...fromZod(result.error.issues, file.path));
      continue;
    }
    const id = result.data.metadata.id;
    const named = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '');
    if (named !== id) {
      diagnostics.push(at(file.path, '/metadata/id', 'invalid-manifest', `domain "${id}" is in ${named}.yaml; a domain file is named for its id`, id));
    }
    if (domains[id]) {
      diagnostics.push(at(file.path, '/metadata/id', 'duplicate-id', `domain "${id}" is defined twice in this view`, id));
      continue;
    }
    if (parts.has(id)) {
      diagnostics.push(at(file.path, '/metadata/id', 'duplicate-id', `domain "${id}" has the id of a part in the composition`, id));
    }
    domains[id] = { path: file.path, doc: result.data };
  }

  // Every placement names a real part, and a part is placed once in this view.
  const placedAt = new Map<string, string>();
  const place = (part: string, where: string, path: string, pointer: string, owner?: string) => {
    if (!parts.has(part)) {
      diagnostics.push(at(path, pointer, 'unknown-node', `${where} holds "${part}", which is not a part in the composition`, owner));
      return;
    }
    const before = placedAt.get(part);
    if (before) {
      diagnostics.push(at(path, pointer, 'placed-twice', `"${part}" is placed in ${before} and in ${where}; a view places a part once`, owner));
      return;
    }
    placedAt.set(part, where);
  };
  view?.spec.members.forEach((part, i) => place(part, 'the top level', source.path, `/spec/members/${i}`));
  for (const [id, { path, doc }] of Object.entries(domains)) {
    doc.spec.members.forEach((part, i) => place(part, `domain "${id}"`, path, `/spec/members/${i}`, id));
    const parent = doc.spec.parent;
    if (parent !== undefined && !domains[parent]) {
      diagnostics.push(at(path, '/spec/parent', 'parent-not-domain', `domain "${id}" is inside "${parent}", which is not a domain of this view`, id));
    }
  }

  // No domain inside itself; the cycle is named once, from its first domain.
  const reported = new Set<string>();
  for (const id of Object.keys(domains).sort()) {
    const chain = [id];
    for (let up = domains[id]!.doc.spec.parent; up !== undefined && domains[up]; up = domains[up]!.doc.spec.parent) {
      if (up === id) {
        const key = [...chain].sort().join('>');
        if (!reported.has(key)) {
          reported.add(key);
          diagnostics.push({
            ...at(domains[id]!.path, '/spec/parent', 'domain-cycle', `domain "${id}" is inside itself: ${[...chain, id].join(' → ')}`, id),
            cyclePath: [...chain, id],
          });
        }
        break;
      }
      if (chain.includes(up)) break; // a cycle further up, reported from its own domain
      chain.push(up);
    }
  }

  return { ...(view ? { view } : {}), domains, diagnostics };
}
