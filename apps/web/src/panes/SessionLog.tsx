import { useEffect, useRef, useState } from 'react';
import { getSessionLogs, type SessionLogLine } from '../project.js';

/**
 * Every process's output, in one drawer — the event log's pattern applied to the
 * app session (docs/app-session.md). Unlike the run log, the lines have exactly one
 * consumer, so the drawer does its own reading: a range poll from the last seq,
 * which is also what reconnecting after a close is.
 */

/** Dev servers talk forever; the drawer is a window, not an archive. */
const LINE_LIMIT = 2000;

export function SessionLog({
  projectId,
  live,
  onClose,
}: {
  projectId: string;
  /** Polling stops when the session does; what was read stays readable. */
  live: boolean;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<SessionLogLine[]>([]);
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length]);

  useEffect(() => {
    if (!live) return;
    // A fresh session numbers its log from the start, so a stale buffer would
    // interleave two sessions' lines under colliding seqs.
    setLines([]);
    let after = 0;
    let stopped = false;

    const tick = async () => {
      try {
        const { lines: fresh, last } = await getSessionLogs(projectId, after);
        if (stopped) return;
        after = last;
        if (fresh.length === 0) return;
        setLines((current) => {
          const next = [...current, ...fresh];
          return next.length > LINE_LIMIT ? next.slice(next.length - LINE_LIMIT) : next;
        });
      } catch {
        /* a missed poll is not a dead session; the next tick reads on */
      }
    };

    void tick();
    const interval = window.setInterval(() => void tick(), 1000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [projectId, live]);

  return (
    <div className="runlog sessionlog">
      <div className="runlog-head">
        <span className={`runlog-status${live ? ' runlog-status-running' : ''}`}>
          {live ? 'app session' : 'stopped'}
        </span>
        <span className="runlog-count">{lines.length} lines</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="link" onClick={onClose}>
          close
        </button>
      </div>
      <div className="runlog-body">
        {lines.map((entry) => (
          <div key={entry.seq} className="runlog-row sessionlog-row">
            <span className="runlog-seq">{entry.seq}</span>
            <span className="sessionlog-proc">{entry.proc}</span>
            <span className="sessionlog-line">{entry.line}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
