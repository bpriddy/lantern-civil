import { useEffect, useState } from 'react';

/**
 * PRD 3: the node vocabulary is a closed set, edited by hand. Choosing is two
 * steps — the type, then its sub-type — because the sub-type is a real decision
 * (a boundary is api or mcp; a service starts from code or from a graph) and
 * defaulting it would decide silently. A family with exactly one sub-type skips
 * the second step rather than asking a question with one answer.
 */

export interface NodeKind {
  /** The sub-type row: "Web", "API", "Code", … */
  label: string;
  hint: string;
  type: string;
  /** What generated ids start from, when the label is a description rather than a name. */
  idBase?: string;
  /** Extra manifest fields this kind requires to be valid on arrival, derived from
   *  the id the node actually gets rather than a hardcoded name. */
  defaults: (id: string) => Record<string, unknown>;
  /** Files the node must reference to be valid, written as pending changes so the
   *  node arrives whole. Paths that already exist are left alone. */
  scaffold?: (id: string) => { path: string; content: string }[];
}

export interface NodeFamily {
  label: string;
  hint: string;
  kinds: NodeKind[];
}

/** Node ids allow dashes; Python modules do not. */
const pyName = (id: string) => id.replace(/-/g, '_');

/**
 * A new code context is born role-less: a named place where code lives, not yet a
 * step and not yet a toolbox. PRD 5 gives it two possible roles — capability target
 * (an agent calls functions in it) and flow participant (it IS a step) — and the
 * role is derived from how it gets wired, never declared at creation. So the
 * scaffold is one file with a docstring and no shape at all: write utility
 * functions, classes, a harness — Civil has no opinion until an edge gives it one.
 *
 * The typed handler below appears only where a callable boundary is a fact rather
 * than a style: a function-backed service (its contract IS a function, PRD 4), and
 * a code context at the moment a flow edge makes it a step (see App.connectEdge).
 */
export function contextStub(id: string): string {
  return [
    `"""${id}: what lives here?`,
    '',
    'This is a code context: a named set of files, in whatever shape suits it.',
    'Wire an agent to it (dashed edge) and its public functions become tools the',
    'agent may call. Wire it into the flow (solid edge) and it becomes a step --',
    'Civil will set up an entrypoint at that moment.',
    `"""`,
    '',
  ].join('\n');
}

/** One typed input, one typed output, pass the value through. The i and o are in
 *  the source because PRD 7.2 keeps contracts discovered, never declared. */
export function codeStub(id: string): string {
  return [
    `"""${id}: describe what this step does.`,
    '',
    "The canvas reads this file, not a config. The handler's signature is the",
    "node's contract -- rename anything, and the ports follow the code.",
    `"""`,
    'from typing import TypedDict',
    '',
    '',
    'class Input(TypedDict):',
    '    value: str',
    '',
    '',
    'class Output(TypedDict):',
    '    value: str',
    '',
    '',
    'def handler(data: Input) -> Output:',
    '    return {"value": data["value"]}',
    '',
  ].join('\n');
}

/** An empty canvas, for a graph-backed service or a subgraph to descend into. */
function graphStub(id: string): { path: string; content: string } {
  return {
    path: `graphs/${pyName(id)}.graph.yaml`,
    content: [
      'apiVersion: civil/v1',
      'kind: Graph',
      `metadata: { id: ${id} }`,
      '',
      '# An empty canvas. Descend into the node to build it.',
      'spec:',
      '  nodes: []',
      '  edges: []',
      '',
      'layout:',
      '  nodes: {}',
      '',
    ].join('\n'),
  };
}

const COMPOSITION: NodeFamily[] = [
  {
    label: 'Client',
    hint: 'A consumer of the application: authored code, reaching services through a boundary.',
    kinds: [
      {
        label: 'Web',
        type: 'client',
        idBase: 'web',
        hint: 'A web client, built and served.',
        defaults: () => ({ client: 'web', path: 'web' }),
        scaffold: (id) => [
          {
            path: 'web/index.html',
            content: [
              '<!doctype html>',
              '<html>',
              '  <head>',
              '    <meta charset="utf-8" />',
              `    <title>${id}</title>`,
              '  </head>',
              '  <body>',
              '    <!-- Build in any framework; Civil only needs to know the directory. -->',
              '  </body>',
              '</html>',
              '',
            ].join('\n'),
          },
        ],
      },
      {
        label: 'Mobile',
        type: 'client',
        idBase: 'mobile',
        hint: 'A mobile client, built and shipped.',
        defaults: () => ({ client: 'mobile', path: 'mobile' }),
        scaffold: (id) => [
          {
            path: 'mobile/README.md',
            content: `# ${id}\n\nA mobile client. Any framework — Civil only needs to know the directory.\n`,
          },
        ],
      },
    ],
  },
  {
    label: 'Boundary',
    hint: 'A generated surface over the services it exposes.',
    kinds: [
      {
        label: 'API',
        type: 'boundary',
        idBase: 'api',
        hint: 'An HTTP boundary over the services it exposes.',
        defaults: () => ({ boundary: 'api', exposes: [] }),
      },
      {
        label: 'MCP',
        type: 'boundary',
        idBase: 'mcp',
        hint: 'Exposed services become tools an agent may call.',
        defaults: () => ({ boundary: 'mcp', exposes: [] }),
      },
    ],
  },
  {
    label: 'Service',
    hint: 'A unit of server behaviour. One thing at two resolutions — pick where it starts.',
    kinds: [
      {
        label: 'From code',
        type: 'service',
        idBase: 'service',
        hint: 'Implemented as a function; the contract is read from the code.',
        defaults: (id) => ({ impl: { entrypoint: `src/services/${pyName(id)}.py` } }),
        scaffold: (id) => [{ path: `src/services/${pyName(id)}.py`, content: codeStub(id) }],
      },
      {
        label: 'From a graph',
        type: 'service',
        idBase: 'service',
        hint: 'Implemented as a dataflow graph you descend into.',
        defaults: (id) => ({ impl: { graph: `graphs/${pyName(id)}.graph.yaml` } }),
        scaffold: (id) => [graphStub(id)],
      },
    ],
  },
  {
    label: 'Process',
    hint: 'Work that initiates rather than being called.',
    kinds: [
      {
        label: 'Schedule',
        type: 'process',
        idBase: 'process',
        hint: 'Runs on a cron schedule.',
        defaults: () => ({ trigger: { kind: 'schedule', cron: '0 3 * * *' }, calls: [] }),
      },
    ],
  },
];

const GRAPH: NodeFamily[] = [
  {
    label: 'Code',
    hint: 'A place where code lives. Wiring decides its role: agent tools, or a step.',
    kinds: [
      {
        label: 'Code',
        type: 'code',
        idBase: 'code',
        hint: 'A role-less context; an edge gives it a role.',
        // No entrypoint on arrival, deliberately. Only a flow edge requires a
        // callable boundary, and that moment scaffolds one (App.connectEdge).
        defaults: (id) => ({ include: [`src/${pyName(id)}/**/*.py`] }),
        scaffold: (id) => [{ path: `src/${pyName(id)}/__init__.py`, content: contextStub(id) }],
      },
    ],
  },
  {
    label: 'Agent',
    hint: 'An objective, a model, and the tools it may call.',
    kinds: [
      {
        label: 'Agent',
        type: 'agent',
        idBase: 'agent',
        hint: 'An objective, a model, and the tools it may call.',
        defaults: (id) => ({ ref: `agents/${pyName(id)}/agent.yaml` }),
        // The objective is the agent (PRD 5); the yaml is only where it points.
        // Model deliberately unset: absent means the project default (PRD 12).
        scaffold: (id) => [
          {
            path: `agents/${pyName(id)}/agent.yaml`,
            content: [
              'apiVersion: civil/v1',
              'kind: Agent',
              `metadata: { id: ${id} }`,
              'spec:',
              `  promptFile: agents/${pyName(id)}/prompt.md`,
              '  maxTurns: 8',
              '',
            ].join('\n'),
          },
          {
            path: `agents/${pyName(id)}/prompt.md`,
            content:
              'Describe the objective. What should this agent accomplish, and how does it know it is done?\n',
          },
        ],
      },
    ],
  },
  {
    label: 'IO',
    hint: 'The graph boundary. Directional: a source or a sink, never both.',
    kinds: [
      {
        label: 'Input',
        type: 'io',
        idBase: 'input',
        hint: 'A source at the graph boundary.',
        defaults: () => ({ direction: 'in' }),
      },
      {
        label: 'Output',
        type: 'io',
        idBase: 'output',
        hint: 'A sink at the graph boundary.',
        defaults: () => ({ direction: 'out' }),
      },
    ],
  },
  {
    label: 'Subgraph',
    hint: 'Another graph, descended into as a canvas.',
    kinds: [
      {
        label: 'Subgraph',
        type: 'subgraph',
        idBase: 'subgraph',
        hint: 'Another graph, descended into as a canvas.',
        defaults: (id) => ({ ref: `graphs/${pyName(id)}.graph.yaml` }),
        scaffold: (id) => [graphStub(id)],
      },
    ],
  },
];

export function AddNode({
  altitude,
  existingIds,
  onAdd,
  onClose,
}: {
  altitude: 'composition' | 'graph';
  existingIds: string[];
  onAdd: (node: Record<string, unknown>, scaffold: { path: string; content: string }[]) => void;
  onClose: () => void;
}) {
  const families = altitude === 'composition' ? COMPOSITION : GRAPH;
  const [family, setFamily] = useState<NodeFamily | null>(null);
  const [index, setIndex] = useState(0);

  const rows: { label: string; hint: string }[] = family ? family.kinds : families;

  const choose = (kind: NodeKind) => {
    const id = uniqueId(kind.idBase ?? kind.label, existingIds);
    onAdd({ id, type: kind.type, ...kind.defaults(id) }, kind.scaffold?.(id) ?? []);
    onClose();
  };

  const pick = (at: number) => {
    if (family) {
      choose(family.kinds[at]!);
      return;
    }
    const next = families[at]!;
    // A question with one answer is not a question.
    if (next.kinds.length === 1) {
      choose(next.kinds[0]!);
      return;
    }
    setFamily(next);
    setIndex(0);
  };

  // Arrows, Enter, Escape — adding a node never requires the mouse, and Escape
  // walks back one step before it closes. Capture phase, so the global command
  // listener never sees the keys this modal consumes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowDown') setIndex((i) => (i + 1) % rows.length);
      if (event.key === 'ArrowUp') setIndex((i) => (i - 1 + rows.length) % rows.length);
      if (event.key === 'Enter') pick(index);
      if (event.key === 'Escape') {
        if (family) {
          setFamily(null);
          setIndex(0);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="keyhelp-backdrop" onClick={onClose} role="presentation">
      <div className="addnode" onClick={(e) => e.stopPropagation()}>
        <div className="keyhelp-head">
          {family ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                setFamily(null);
                setIndex(0);
              }}
            >
              ‹ {family.label}
            </button>
          ) : (
            <span>Add node</span>
          )}
          <button type="button" className="link" onClick={onClose}>
            close
          </button>
        </div>
        <div className="addnode-body">
          {rows.map((row, i) => (
            <button
              key={row.label}
              type="button"
              className={`addnode-row${i === index ? ' is-active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(i)}
            >
              <span className="addnode-label">{row.label}</span>
              <span className="addnode-hint">{row.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Ids must match the manifest pattern and be unique within their canvas (PRD 6.4), so
 * a generated one is lowercased, hyphenated, and suffixed until it does not collide.
 */
function uniqueId(label: string, existing: string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node';
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}
