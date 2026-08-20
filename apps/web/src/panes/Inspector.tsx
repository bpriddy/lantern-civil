import { useEffect, useRef, useState } from 'react';
import type { CompositionEdge, CompositionNode, GraphEdge, GraphNode } from '@civil/schema';
import type { Altitude } from '../canvas/Editor.js';
import type { ProjectBundle } from '../project.js';

/**
 * PRD 5: agents and io nodes are leaves — no descent, everything inspector-editable.
 * This is where "inspector-editable" becomes true: each field commits an updateNode
 * patch, the id commits a renameNode, and the buttons at the bottom are the same ops
 * the Delete key sends. Nothing here writes YAML; it posts ops like everything else
 * (PRD 7.1).
 */
export function Inspector({
  bundle,
  altitude,
  selectedId,
  selectedEdgeId,
  onPatch,
  onRename,
  onRemoveNode,
  onRemoveEdge,
}: {
  bundle: ProjectBundle | undefined;
  altitude: Altitude;
  selectedId: string | null;
  selectedEdgeId: string | null;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
  onRename: (from: string, to: string) => void;
  onRemoveNode: (id: string) => void;
  onRemoveEdge: (id: string) => void;
}) {
  const node = findNode(bundle, altitude, selectedId);
  const edge = findEdge(bundle, altitude, selectedEdgeId);

  return (
    <>
      <div className="pane-title">Inspector</div>
      <div className="pane-body">
        {node ? (
          <NodeDetail
            node={node}
            bundle={bundle}
            onPatch={(patch) => onPatch(node.id, patch)}
            onRename={(to) => onRename(node.id, to)}
            onRemove={() => onRemoveNode(node.id)}
          />
        ) : edge ? (
          <EdgeDetail edge={edge} onRemove={() => onRemoveEdge(edge.id)} />
        ) : (
          <p className="muted">Nothing selected.</p>
        )}

        {bundle && bundle.diagnostics.length > 0 ? (
          <>
            <h3 className="section">Diagnostics</h3>
            {bundle.diagnostics.map((d, i) => (
              <div key={i} className={`diagnostic diagnostic-${d.severity}`}>
                <div className="diagnostic-code">{d.code}</div>
                <div>{d.message}</div>
                <div className="diagnostic-where">
                  {d.file}
                  {d.jsonPointer}
                </div>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * One editable value. Commits on Enter or blur, only when it changed; Escape puts
 * the draft back and goes no further — reverting a field must not also clear the
 * canvas selection, which is what the global Escape would do.
 */
function Field({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  /** Returning false means the value was not accepted; the draft snaps back. */
  onCommit: (next: string) => void | false;
}) {
  const [draft, setDraft] = useState(value);
  // What was last sent, so Enter-then-blur is one commit, not two ops.
  const sent = useRef<string | null>(null);
  // A new node under the cursor replaces the draft; typing does not.
  useEffect(() => {
    setDraft(value);
    sent.current = null;
  }, [value]);

  const commit = () => {
    const next = draft.trim();
    if (next === value || sent.current === next) return;
    sent.current = next;
    if (onCommit(next) === false) {
      setDraft(value);
      sent.current = null;
    }
  };

  return (
    <div style={{ display: 'contents' }}>
      <dt>{label}</dt>
      <dd>
        <input
          className="field"
          value={draft}
          placeholder={placeholder ?? ''}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(value);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </dd>
    </div>
  );
}

/** A comma-separated list over an array field. Empty means an empty list. */
const parseList = (text: string): string[] =>
  text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

function NodeDetail({
  node,
  bundle,
  onPatch,
  onRename,
  onRemove,
}: {
  node: CompositionNode | GraphNode;
  bundle: ProjectBundle | undefined;
  onPatch: (patch: Record<string, unknown>) => void;
  onRename: (to: string) => void;
  onRemove: () => void;
}) {
  // An optional string field: emptying it removes the key rather than writing "".
  const optional = (key: string) => (v: string) => onPatch({ [key]: v === '' ? null : v });
  // A required field emptied is not a change the manifest can take; the field snaps
  // back to the value it still has rather than sitting blank over an unchanged file.
  const required = (key: string) => (v: string): void | false => {
    if (v === '') return false;
    onPatch({ [key]: v });
  };

  const fields: React.ReactNode[] = [];
  switch (node.type) {
    case 'client':
      fields.push(
        <Field key="path" label="path" value={node.path} onCommit={required('path')} />,
        <Field key="dev" label="dev" value={node.dev ?? ''} placeholder="dev command" onCommit={optional('dev')} />,
      );
      break;
    case 'boundary':
      // Wiring boundaries explicitly means the canvas shows what is reachable
      // from outside. A service with no boundary in front of it is not exposed.
      fields.push(
        <Field
          key="exposes"
          label="exposes"
          value={node.exposes.join(', ')}
          placeholder="service ids, comma-separated"
          onCommit={(v) => onPatch({ exposes: parseList(v) })}
        />,
      );
      break;
    case 'service': {
      const kind = 'graph' in node.impl ? 'graph' : 'entrypoint';
      const value = 'graph' in node.impl ? node.impl.graph : node.impl.entrypoint;
      fields.push(
        <Field
          key="impl"
          label={kind}
          value={value}
          onCommit={(v) => {
            if (v === '') return false;
            onPatch({ impl: { [kind]: v } });
          }}
        />,
      );
      break;
    }
    case 'process':
      fields.push(
        <Field
          key="cron"
          label="cron"
          value={node.trigger.cron}
          onCommit={(v) => {
            if (v === '') return false;
            onPatch({ trigger: { kind: 'schedule', cron: v } });
          }}
        />,
        <Field
          key="calls"
          label="calls"
          value={node.calls.join(', ')}
          placeholder="service ids, comma-separated"
          onCommit={(v) => onPatch({ calls: parseList(v) })}
        />,
      );
      break;
    case 'io':
      fields.push(
        <div key="direction" style={{ display: 'contents' }}>
          <dt>direction</dt>
          <dd>
            <select
              className="field"
              value={node.direction}
              onChange={(e) => onPatch({ direction: e.target.value })}
            >
              <option value="in">in</option>
              <option value="out">out</option>
            </select>
          </dd>
        </div>,
        <Field key="name" label="name" value={node.name ?? ''} onCommit={optional('name')} />,
        <Field key="schema" label="schema" value={node.schema ?? ''} placeholder="schemas/….json" onCommit={optional('schema')} />,
        <div key="kind" style={{ display: 'contents' }}>
          <dt>progress</dt>
          <dd>
            <select
              className="field"
              value={node.kind ?? ''}
              onChange={(e) => onPatch({ kind: e.target.value === '' ? null : 'progress' })}
            >
              <option value="">no</option>
              <option value="progress">yes</option>
            </select>
          </dd>
        </div>,
      );
      break;
    case 'code':
      fields.push(
        <Field key="name" label="name" value={node.name ?? ''} onCommit={optional('name')} />,
        <Field
          key="include"
          label="include"
          value={node.include.join(', ')}
          placeholder="globs, comma-separated"
          onCommit={(v) => onPatch({ include: parseList(v) })}
        />,
        <Field
          key="entrypoint"
          label="entrypoint"
          value={node.entrypoint ?? ''}
          placeholder="empty = capability target only"
          onCommit={optional('entrypoint')}
        />,
      );
      break;
    case 'subgraph':
    case 'agent':
      fields.push(<Field key="ref" label="ref" value={node.ref} onCommit={required('ref')} />);
      break;
  }

  const agent = node.type === 'agent' ? bundle?.agents[node.ref] : undefined;

  return (
    <>
      <dl className="kv">
        {/* The id commits a rename, which rewrites every reference to it (PRD 7.1). */}
        <Field label="id" value={node.id} onCommit={onRename} />
        <dt>type</dt>
        <dd>
          {node.type === 'client'
            ? `client · ${node.client}`
            : node.type === 'boundary'
              ? `boundary · ${node.boundary}`
              : node.type}
        </dd>
        {fields}
      </dl>

      {agent ? (
        <>
          <h3 className="section">Agent</h3>
          <dl className="kv">
            <dt>model</dt>
            {/* PRD 12: model ids are never hardcoded. Absent means the project default. */}
            <dd>{agent.agent.spec.model ?? '(project default)'}</dd>
            <dt>maxTurns</dt>
            <dd>{agent.agent.spec.maxTurns ?? '(unset)'}</dd>
          </dl>
          <h3 className="section">Objective</h3>
          {/* The prompt is a file, so editing it is Monaco's job — descend into the
              agent to open it. The inspector edits the node, not its files. */}
          <pre className="prompt">{agent.prompt ?? '(prompt file missing)'}</pre>
        </>
      ) : null}

      <button type="button" className="danger-link" onClick={onRemove}>
        Remove node
      </button>
    </>
  );
}

function EdgeDetail({
  edge,
  onRemove,
}: {
  edge: CompositionEdge | GraphEdge;
  onRemove: () => void;
}) {
  return (
    <>
      <dl className="kv">
        <dt>edge</dt>
        <dd>{edge.id}</dd>
        <dt>kind</dt>
        <dd>{edge.kind}</dd>
        <dt>from</dt>
        <dd>{edge.from.node}</dd>
        <dt>to</dt>
        <dd>
          {edge.to.node}
          {'function' in edge.to && edge.to.function ? ` · ${edge.to.function}` : ''}
        </dd>
      </dl>
      <button type="button" className="danger-link" onClick={onRemove}>
        Disconnect
      </button>
    </>
  );
}

function findNode(
  bundle: ProjectBundle | undefined,
  altitude: Altitude,
  selectedId: string | null,
): CompositionNode | GraphNode | undefined {
  if (!bundle || !selectedId) return undefined;
  if (altitude.kind === 'composition') {
    return bundle.composition?.spec.nodes.find((n) => n.id === selectedId);
  }
  // A code takeover has no node selection of its own; the inspector shows the
  // diagnostics list until you ascend.
  if (altitude.kind === 'code') return undefined;
  return bundle.graphs[altitude.path]?.spec.nodes.find((n) => n.id === selectedId);
}

function findEdge(
  bundle: ProjectBundle | undefined,
  altitude: Altitude,
  selectedEdgeId: string | null,
): CompositionEdge | GraphEdge | undefined {
  if (!bundle || !selectedEdgeId) return undefined;
  if (altitude.kind === 'composition') {
    return bundle.composition?.spec.edges.find((e) => e.id === selectedEdgeId);
  }
  if (altitude.kind === 'code') return undefined;
  return bundle.graphs[altitude.path]?.spec.edges.find((e) => e.id === selectedEdgeId);
}
