import { useEffect, useState } from 'react';

/**
 * PRD 3: the node vocabulary is a closed set, edited by hand. That is why this is a
 * short list of buttons rather than a search field — there are three choices at the
 * composition altitude and four inside a graph, and there will not be more without a
 * commit to Civil.
 */

export interface NodeKind {
  type: string;
  label: string;
  hint: string;
  /** Extra manifest fields this kind requires to be valid on arrival. */
  defaults: Record<string, unknown>;
}

const COMPOSITION: NodeKind[] = [
  { type: 'service', label: 'Service', hint: 'A unit of server behaviour with a typed contract.', defaults: { impl: { entrypoint: 'src/services/new_service.py' } } },
  { type: 'client', label: 'API client', hint: 'A generated HTTP boundary over the services it exposes.', defaults: { client: 'api', exposes: [] } },
  { type: 'process', label: 'Process', hint: 'Work that initiates rather than being called.', defaults: { trigger: { kind: 'schedule', cron: '0 3 * * *' }, calls: [] } },
];

const GRAPH: NodeKind[] = [
  { type: 'code', label: 'Code', hint: 'A step, or a set of functions an agent may call.', defaults: { include: ['src/steps/new_step/**/*.py'], entrypoint: 'src/steps/new_step/main.py' } },
  { type: 'agent', label: 'Agent', hint: 'An objective, a model, and the tools it may call.', defaults: { ref: 'agents/new_agent/agent.yaml' } },
  { type: 'io', label: 'Input', hint: 'A source at the graph boundary.', defaults: { direction: 'in' } },
  { type: 'io', label: 'Output', hint: 'A sink at the graph boundary.', defaults: { direction: 'out' } },
  { type: 'subgraph', label: 'Subgraph', hint: 'Another graph, descended into as a canvas.', defaults: { ref: 'graphs/new_graph.graph.yaml' } },
];

export function AddNode({
  altitude,
  existingIds,
  onAdd,
  onClose,
}: {
  altitude: 'composition' | 'graph';
  existingIds: string[];
  onAdd: (node: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const kinds = altitude === 'composition' ? COMPOSITION : GRAPH;
  const [index, setIndex] = useState(0);

  // Arrow keys and Enter, so adding a node never requires the mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => (i + 1) % kinds.length); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => (i - 1 + kinds.length) % kinds.length); }
      if (event.key === 'Enter') { event.preventDefault(); choose(kinds[index]!); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const choose = (kind: NodeKind) => {
    onAdd({ id: uniqueId(kind.label, existingIds), type: kind.type, ...kind.defaults });
    onClose();
  };

  return (
    <div className="keyhelp-backdrop" onClick={onClose} role="presentation">
      <div className="addnode" onClick={(e) => e.stopPropagation()}>
        <div className="keyhelp-head">
          <span>Add node</span>
          <button type="button" className="link" onClick={onClose}>close</button>
        </div>
        <div className="addnode-body">
          {kinds.map((kind, i) => (
            <button
              key={kind.label}
              type="button"
              className={`addnode-row${i === index ? ' is-active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(kind)}
            >
              <span className="addnode-label">{kind.label}</span>
              <span className="addnode-hint">{kind.hint}</span>
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
