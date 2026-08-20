-- Up Migration

-- M0 scaffolded runs and run_events ahead of need, and better than the runtime
-- work remembered: gapless event_seq under the row lock, the typed event
-- vocabulary, tool_validation recorded per run. What M4 actually adds is small.

-- Pending work is per branch, and so are the runs that execute it.
ALTER TABLE runs ADD COLUMN branch text NOT NULL DEFAULT 'main';

-- What the run was asked and what it answered. Large values follow the same GCS
-- split as everything else when they need to; inline is fine to start.
ALTER TABLE runs ADD COLUMN input  jsonb;
ALTER TABLE runs ADD COLUMN output jsonb;

-- The runner reports events over HTTP with a per-run bearer token, hash stored —
-- the same discipline as sessions. The runner holds no platform credentials
-- (PRD 12), so this token is the only thing that lets it write, and it can write
-- only to its own run.
ALTER TABLE runs ADD COLUMN runner_token_hash text;
