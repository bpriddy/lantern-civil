import { BaseEdge, EdgeLabelRenderer, getBezierPath, useStore, type EdgeProps } from '@xyflow/react';

/**
 * A diagram line and what passes along it (docs/interpretation.md). The text is a chip,
 * not tiny type on the line, and it is shown in context so the canvas stays scannable:
 *
 * - on the lines of the node you point at or select, and on the line you select;
 * - otherwise not at all: shown on every line, chips land on cards and cover them.
 * The full text of a selected line is in the inspector.
 *
 * A line not in focus while something is focused fades, so the focused path reads.
 */

export interface LabelledEdgeData extends Record<string, unknown> {
  label?: string;
  kind: string;
  /** The line touches what the person is pointing at or has selected. */
  focus?: boolean;
  /** Something else is focused: this line steps back. */
  dim?: boolean;
  uncertain?: boolean;
}

export function LabelledEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected } = props;
  const data = (props.data ?? { kind: 'next' }) as LabelledEdgeData;
  const zoom = useStore((s) => s.transform[2]);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const show = !!data.label && (data.focus || selected);
  const uses = data.kind !== 'next' && data.kind !== 'calls';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        {...(markerEnd ? { markerEnd } : {})}
        className={['edge-labelled', `edge-diagram-${data.kind}`, data.focus || selected ? 'edge-focus' : '', data.dim && !selected ? 'edge-dim' : '', data.uncertain ? 'edge-uncertain' : ''].filter(Boolean).join(' ')}
        style={uses ? { strokeDasharray: '5 5' } : {}}
      />
      {show ? (
        <EdgeLabelRenderer>
          <div
            className={`edge-chip${data.focus || selected ? ' edge-chip-focus' : ''}`}
            // One size on screen at any zoom, like a map's labels: readable when the
            // canvas is fitted, never swamping it when zoomed in.
            style={{ transform: `translate(${labelX}px, ${labelY}px) scale(${1 / zoom}) translate(-50%, -50%)`, transformOrigin: '0 0' }}
            title={data.label}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const diagramEdgeTypes = { labelled: LabelledEdge };
