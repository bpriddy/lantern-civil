import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { CompositionNode, Diagnostic, GraphNode } from '@civil/schema';

/**
 * PRD 3: node types are units of architecture, never units of computation. Every face
 * here is something you would draw on a whiteboard. The visual vocabulary is
 * deliberately small — there are seven node types in the whole product and there will
 * not be more without a commit to Civil.
 */

/**
 * PRD 5: "No blended contexts. A node is a canvas or it is code. Never both."
 *
 * That rule is invisible unless the face says which one is behind the door, so
 * descent is typed rather than boolean. A canvas-descent node shows a nested frame
 * with the interior's ports; a code-descent node shows a gutter and its files. You
 * should know what kind of context you are entering before you double-click.
 */
export type Descent =
  | { into: 'canvas'; ports: { name: string; direction: 'in' | 'out' }[] }
  // `note` is carried rather than inferred from the entrypoint: "capability target"
  // is only meaningful for a code node inside a graph, and deriving it made a
  // frontend describe itself as one.
  | { into: 'code'; files: number; note: string }
  | undefined;

export interface NodeData extends Record<string, unknown> {
  label: string;
  descent: Descent;
  diagnostics: Diagnostic[];
  detail: string | undefined;
  manifest: CompositionNode | GraphNode;
}

function Face({
  kind,
  glyph,
  data,
  ports,
}: {
  kind: string;
  glyph: string;
  data: NodeData;
  ports: { in: boolean; out: boolean };
}) {
  const fatal = data.diagnostics.some((d) => d.severity === 'error');
  const blocked = data.diagnostics.length > 0 && !fatal;
  const descent = data.descent;

  return (
    <div
      className={[
        'node',
        `node-${kind}`,
        fatal ? 'node-error' : '',
        blocked ? 'node-blocked' : '',
        descent ? `node-descends node-descends-${descent.into}` : '',
      ].filter(Boolean).join(' ')}
      title={data.diagnostics.map((d) => d.message).join('\n') || undefined}
    >
      {ports.in ? <Handle type="target" position={Position.Left} /> : null}
      <div className="node-head">
        <span className="node-glyph">{glyph}</span>
        <span className="node-kind">{kind}</span>
        {descent ? (
          <span
            className="node-descend"
            title={descent.into === 'canvas' ? 'Double-click to descend into its canvas' : 'Double-click to open its code'}
          >
            {/* Two different doors, two different marks. */}
            {descent.into === 'canvas' ? '⧉' : '{…}'}
          </span>
        ) : null}
      </div>
      <div className="node-label">{data.label}</div>
      {data.detail ? <div className="node-detail">{data.detail}</div> : null}

      {/* PRD 5: "Node face shows its io nodes as ports." The interior, previewed. */}
      {descent?.into === 'canvas' ? (
        <div className="node-interior">
          {descent.ports.length === 0 ? (
            <div className="node-interior-empty">no io nodes</div>
          ) : (
            descent.ports.map((port) => (
              <div key={`${port.direction}-${port.name}`} className={`node-port node-port-${port.direction}`}>
                <span className="node-port-arrow">{port.direction === 'in' ? '→' : '⇥'}</span>
                {port.name}
              </div>
            ))
          )}
        </div>
      ) : null}

      {descent?.into === 'code' ? (
        <div className="node-code-meta">
          {descent.note}
          {descent.note ? ' · ' : ''}
          {descent.files} {descent.files === 1 ? 'file' : 'files'}
        </div>
      ) : null}
      {data.diagnostics.length > 0 ? (
        <div className="node-diagnostic">{data.diagnostics[0]!.message}</div>
      ) : null}
      {ports.out ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

// --- composition altitude (PRD 4) -----------------------------------------

const ClientNode = (props: NodeProps) => {
  const data = props.data as NodeData;
  const flavour = (data.manifest as { client?: string }).client ?? 'client';
  // PRD 4: api and mcp are generated boundaries, frontend is an app you build.
  const glyph = flavour === 'frontend' ? '▤' : flavour === 'mcp' ? '⛁' : '⇄';
  // A frontend originates traffic and is never a target. An api or mcp boundary is
  // both: a frontend routes to it, and it routes on to the services it exposes.
  return (
    <Face
      kind={flavour}
      glyph={glyph}
      data={data}
      ports={{ in: flavour !== 'frontend', out: true }}
    />
  );
};

const ServiceNode = (props: NodeProps) => {
  const data = props.data as NodeData;
  return <Face kind="service" glyph="◈" data={data} ports={{ in: true, out: true }} />;
};

const ProcessNode = (props: NodeProps) => {
  const data = props.data as NodeData;
  // PRD 4: a process has a trigger, not a caller — so it has no input port.
  return <Face kind="process" glyph="◷" data={data} ports={{ in: false, out: true }} />;
};

// --- dataflow altitude (PRD 5) --------------------------------------------

const IoNode = (props: NodeProps) => {
  const data = props.data as NodeData;
  const node = data.manifest as { direction: 'in' | 'out'; kind?: string };
  const isProgress = node.kind === 'progress';
  return (
    <Face
      kind={isProgress ? 'progress' : node.direction === 'in' ? 'input' : 'output'}
      glyph={isProgress ? '≋' : node.direction === 'in' ? '→' : '⇥'}
      data={data}
      // PRD 5: directional, never both. Inputs are sources, outputs are sinks.
      ports={{ in: node.direction === 'out', out: node.direction === 'in' }}
    />
  );
};

const AgentNode = (props: NodeProps) => {
  const data = props.data as NodeData;
  return <Face kind="agent" glyph="✦" data={data} ports={{ in: true, out: true }} />;
};

const CodeNode = (props: NodeProps) => {
  const data = props.data as NodeData;
  return <Face kind="code" glyph="{ }" data={data} ports={{ in: true, out: true }} />;
};

/** A service is one thing at two resolutions (PRD 4), so its face follows its descent. */

const SubgraphNode = (props: NodeProps) => {
  const data = props.data as NodeData;
  return <Face kind="subgraph" glyph="⊞" data={data} ports={{ in: true, out: true }} />;
};

export const compositionNodeTypes = {
  client: ClientNode,
  service: ServiceNode,
  process: ProcessNode,
};

export const graphNodeTypes = {
  io: IoNode,
  agent: AgentNode,
  code: CodeNode,
  subgraph: SubgraphNode,
};
