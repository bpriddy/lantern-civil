import { useEffect, useRef } from 'react';
import type { RunEvent, RunSummary } from '../project.js';

/**
 * PRD 9.1: the event log is the spine, and this is it on screen — a drawer under
 * the canvas, in run order, following as events arrive. Watching is reading; the
 * drawer polls nothing itself and closes without the run noticing (PRD 8.2).
 */
export function RunLog({
  status,
  events,
  onCancel,
  onClose,
}: {
  status: RunSummary['status'];
  events: RunEvent[];
  onCancel: () => void;
  onClose: () => void;
}) {
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [events.length]);

  const live = status === 'queued' || status === 'running';

  return (
    <div className="runlog">
      <div className="runlog-head">
        <span className={`runlog-status runlog-status-${status}`}>{status}</span>
        <span className="runlog-count">{events.length} events</span>
        <span style={{ flex: 1 }} />
        {live ? (
          <button type="button" className="link" onClick={onCancel}>
            cancel
          </button>
        ) : null}
        <button type="button" className="link" onClick={onClose}>
          close
        </button>
      </div>
      <div className="runlog-body">
        {events.map((event) => (
          <div key={event.seq} className={`runlog-row runlog-${event.type.replace('.', '-')}`}>
            <span className="runlog-seq">{event.seq}</span>
            <span className="runlog-type">{event.type}</span>
            <span className="runlog-node">{event.nodeId ?? ''}</span>
            <span className="runlog-detail">{detailOf(event)}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}

function detailOf(event: RunEvent): string {
  const p = event.payload ?? {};
  if (typeof p['error'] === 'string') return p['error'];
  if ('tool' in p) {
    const tool = String(p['tool']);
    if ('input' in p) return `${tool}(${compact(p['input'])})`;
    if ('output' in p) return `${tool} → ${compact(p['output'])}`;
    return tool;
  }
  if ('output' in p) return compact(p['output']);
  if ('value' in p) return compact(p['value']);
  if ('status' in p) return String(p['status']);
  return '';
}

function compact(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? '' : text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
