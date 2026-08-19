import type { CompositionNode, GraphNode } from '@civil/schema';
import type { Altitude } from '../canvas/Editor.js';
import type { ProjectBundle } from '../project.js';

/**
 * PRD 5: agents and io nodes are leaves — no descent, everything inspector-editable.
 * M1 is read-only, so this shows what M3 will let you change, and nothing more.
 */
export function Inspector({
  bundle,
  altitude,
  selectedId,
}: {
  bundle: ProjectBundle | undefined;
  altitude: Altitude;
  selectedId: string | null;
}) {
  const node = findNode(bundle, altitude, selectedId);

  return (
    <>
      <div className="pane-title">Inspector</div>
      <div className="pane-body">
        {!node ? (
          <p className="muted">Nothing selected.</p>
        ) : (
          <NodeDetail node={node} bundle={bundle} />
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

function NodeDetail({
  node,
  bundle,
}: {
  node: CompositionNode | GraphNode;
  bundle: ProjectBundle | undefined;
}) {
  const rows: [string, string][] = [['id', node.id], ['type', node.type]];

  switch (node.type) {
    case 'client':
      rows.push(['client', node.client]);
      if (node.client === 'frontend') {
        rows.push(['path', node.path]);
        if (node.dev) rows.push(['dev', node.dev]);
      } else {
        // PRD 4: wiring clients explicitly means the canvas shows what is reachable
        // from outside. A service with no client attached is not exposed.
        rows.push(['exposes', node.exposes.join(', ') || '(nothing)']);
      }
      break;
    case 'service':
      rows.push(['graph' in node.impl ? 'graph' : 'entrypoint', 'graph' in node.impl ? node.impl.graph : node.impl.entrypoint]);
      break;
    case 'process':
      rows.push(['trigger', `${node.trigger.kind} ${node.trigger.cron}`]);
      rows.push(['calls', node.calls.join(', ') || '(nothing)']);
      break;
    case 'io':
      rows.push(['direction', node.direction]);
      if (node.kind) rows.push(['kind', node.kind]);
      rows.push(['schema', node.schema ?? '(none)']);
      break;
    case 'code':
      rows.push(['include', node.include.join(', ')]);
      rows.push(['entrypoint', node.entrypoint ?? '(capability target only)']);
      break;
    case 'subgraph':
      rows.push(['ref', node.ref]);
      break;
    case 'agent':
      rows.push(['ref', node.ref]);
      break;
  }

  const agent = node.type === 'agent' ? bundle?.agents[node.ref] : undefined;

  return (
    <>
      <dl className="kv">
        {rows.map(([key, value]) => (
          <div key={key} style={{ display: 'contents' }}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
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
          {/* PRD 5: the prompt in a monospace editor. Read-only until M3. */}
          <pre className="prompt">{agent.prompt ?? '(prompt file missing)'}</pre>
        </>
      ) : null}
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
