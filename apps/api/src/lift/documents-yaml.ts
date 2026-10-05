import { stringify } from 'yaml';

/**
 * Fresh civil/ documents, written in the house style of examples/doc-pipeline: block
 * nodes with a blank line between them on the composition canvas, one flow mapping per
 * line for edges and graph nodes, `layout` a sibling of `spec`. Written by hand rather
 * than by a serialiser's global choices, because the documents a lift produces are the
 * first ones the author reads and they should look like the ones Civil ships.
 *
 * Only a first lift uses this. An Update edits the existing text through the op layer
 * (manifest/apply.ts), so the author's comments and formatting survive — and text
 * written here, read back, matches the model exactly, so re-running a lift over its own
 * output finds nothing to change.
 */

/** A scalar as YAML says it; quoted (as JSON, which YAML accepts) whenever plain is unsafe. */
export function scalar(value: unknown, flow = true): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  // Plain only when the serialiser would also write it plain (so `true`, `null` and
  // numbers stay strings) and, inside a flow collection, nothing in it could end the
  // item early — so flow values are held to a conservative character set.
  if (flow && !/^[A-Za-z_./@][A-Za-z0-9_./@-]*$/.test(text)) return JSON.stringify(text);
  return stringify(text, { lineWidth: 0 }).trim() === text ? text : JSON.stringify(text);
}

/** `{ a: 1, b: [x, y], c: { d: e } }` — one line, flow throughout. */
export function flow(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${flow(v)}`);
    return `{ ${pairs.join(', ')} }`;
  }
  return scalar(value);
}

const header = (kind: string, id: string, name: string | undefined): string[] => [
  'apiVersion: civil/v1',
  `kind: ${kind}`,
  'metadata:',
  `  id: ${scalar(id)}`,
  ...(name ? [`  name: ${scalar(name, false)}`] : []),
];

const layoutBlock = (layout: ReadonlyMap<string, { x: number; y: number }>): string[] =>
  layout.size === 0
    ? ['layout:', '  nodes: {}']
    : ['layout:', '  nodes:', ...[...layout].map(([id, p]) => `    ${scalar(id)}: { x: ${p.x}, y: ${p.y} }`)];

export function projectYaml(id: string, name: string, compositionPath: string, typescript = true): string {
  return [
    ...header('Project', id, name),
    'spec:',
    '  # The composition canvas: the top level of this project.',
    `  composition: ${scalar(compositionPath)}`,
    ...(typescript
      ? [
          "  # Read from the repository by Generate graph from repo. The repo's own TypeScript",
          '  # is the implementation; Civil generates Python only, so Apply is not offered.',
          '  language: typescript',
        ]
      : []),
    '',
  ].join('\n');
}

export function compositionYaml(
  id: string,
  name: string,
  nodes: readonly Record<string, unknown>[],
  edges: readonly Record<string, unknown>[],
  layout: ReadonlyMap<string, { x: number; y: number }>,
): string {
  const lines = [
    ...header('Composition', id, name),
    '',
    '# Generated from the repository by Generate graph from repo. Clients, the api',
    '# boundary over each backend app, its services, and scheduled processes; the',
    '# infrastructure modules are described in civil/architecture.md, not drawn here.',
    'spec:',
  ];
  if (nodes.length === 0) lines.push('  nodes: []');
  else {
    lines.push('  nodes:');
    nodes.forEach((node, i) => {
      if (i > 0) lines.push('');
      Object.entries(node).forEach(([key, value], j) => {
        // Composition values that are strings with spaces (a dev command, a cron) are
        // quoted, as the house example quotes them.
        const rendered = typeof value === 'object' && value !== null ? flow(value) : scalar(value);
        lines.push(`${j === 0 ? '    - ' : '      '}${key}: ${rendered}`);
      });
    });
  }
  lines.push('');
  if (edges.length === 0) lines.push('  edges: []');
  else lines.push('  edges:', ...edges.map((e) => `    - ${flow(e)}`));
  lines.push('', ...layoutBlock(layout), '');
  return lines.join('\n');
}

export function graphYaml(
  id: string,
  name: string,
  nodes: readonly Record<string, unknown>[],
  edges: readonly Record<string, unknown>[],
  layout: ReadonlyMap<string, { x: number; y: number }>,
): string {
  const lines = [...header('Graph', id, name), 'spec:'];
  if (nodes.length === 0) lines.push('  nodes: []');
  else lines.push('  nodes:', ...nodes.map((n) => `    - ${flow(n)}`));
  lines.push('');
  if (edges.length === 0) lines.push('  edges: []');
  else lines.push('  edges:', ...edges.map((e) => `    - ${flow(e)}`));
  lines.push('', ...layoutBlock(layout), '');
  return lines.join('\n');
}
