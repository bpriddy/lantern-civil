-- Up Migration

-- PRD 2: an owner_id on every table from the first migration, even with one owner.
-- Retrofitting it later is brutal. There is deliberately no users table — PRD 12 puts
-- auth in IAP, so owner_id is the stable subject IAP asserts, never an email, which
-- can change.

CREATE TABLE projects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        text        NOT NULL,
    name            text        NOT NULL,
    -- PRD 15: GitHub only. Stored as owner/name; the installation id is what the
    -- GitHub App mints short-lived tokens against (PRD 12).
    repo_owner      text        NOT NULL,
    repo_name       text        NOT NULL,
    installation_id bigint,
    default_branch  text        NOT NULL DEFAULT 'main',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, repo_owner, repo_name)
);

CREATE INDEX projects_owner_idx ON projects (owner_id);

-- PRD 12: Postgres holds working-tree METADATA. Never repo contents as truth — any
-- cache must be reconstructible by re-cloning, so nothing here is authoritative.
CREATE TABLE working_trees (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     text        NOT NULL,
    project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    branch       text        NOT NULL,
    head_sha     text,
    -- Where the clone currently lives. Advisory: if it is gone, re-clone.
    clone_path   text,
    status       text        NOT NULL DEFAULT 'absent'
        CHECK (status IN ('absent', 'cloning', 'ready', 'error')),
    error        text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, branch)
);

CREATE INDEX working_trees_owner_idx ON working_trees (owner_id);

-- PRD 8.1: one run model, two access patterns. Every graph run starts a job and
-- returns a run id; `wait` decides whether the caller ever learns a job existed.
CREATE TABLE runs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    text        NOT NULL,
    project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- Which graph ran, at which commit. Pinning the sha matters for the same reason
    -- PRD 11.5 pins the prompt's sha: reopening yesterday's failure must not show
    -- today's graph.
    graph_path  text        NOT NULL,
    commit_sha  text,
    -- PRD 11.2: a session_id threads through every run and is exposed to agents.
    -- Civil does not implement conversation memory; that is an app decision.
    session_id  text,
    status      text        NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'finished', 'partial', 'failed', 'cancelled')),
    -- PRD 11.3: strict in dev, lenient in prod — a property of the environment, not
    -- a per-run toggle. Recorded so a trace shows which rule was in force.
    tool_validation text     NOT NULL DEFAULT 'strict'
        CHECK (tool_validation IN ('strict', 'lenient')),
    -- Monotonic per-run event counter. Incremented under the row lock when an event
    -- is appended, which is what makes seq gapless and offset reads exact (PRD 8.2).
    event_seq   bigint      NOT NULL DEFAULT 0,
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    started_at  timestamptz,
    finished_at timestamptz
);

CREATE INDEX runs_owner_created_idx ON runs (owner_id, created_at DESC);
CREATE INDEX runs_project_idx ON runs (project_id, created_at DESC);

-- PRD 9.1: the event log is the spine. Ordered, append-only, keyed by run id, and
-- readable FROM AN OFFSET rather than only tailed (PRD 8.2) — disconnect and
-- reconnect is normal, not an error.
--
-- PRD 11.4 calls this one of the two cheap things worth building now: together with
-- the node result cache it is the substrate a checkpointer would need, so durability
-- later becomes "reconstruct state from the log" rather than "add a persistence layer".
CREATE TABLE run_events (
    run_id     uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    seq        bigint      NOT NULL,
    owner_id   text        NOT NULL,
    type       text        NOT NULL CHECK (type IN (
        'run.started',
        'node.queued', 'node.started', 'node.progress', 'node.token',
        'node.tool_call', 'node.tool_result', 'node.output', 'node.failed',
        'node.finished',
        'run.finished'
    )),
    -- Null on run-level events.
    node_id    text,
    -- Path of the subgraph this event came from, so the canvas can route an event to
    -- the right altitude while descended into a running subgraph (PRD 11.2).
    graph_path text,
    -- Small payloads inline. Large ones go to GCS and land in payload_ref, because
    -- PRD 12 puts large event payloads in object storage, not rows.
    payload     jsonb,
    payload_ref text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq),
    CONSTRAINT run_events_payload_xor CHECK (payload IS NULL OR payload_ref IS NULL)
);

CREATE INDEX run_events_owner_idx ON run_events (owner_id);

-- PRD 9.1: node results are content-addressable and cached per run. This serves the
-- single-node re-run loop (PRD 10) and means a downstream failure never costs you a
-- twelve-minute research node again.
CREATE TABLE node_results (
    run_id      uuid        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
    node_id     text        NOT NULL,
    owner_id    text        NOT NULL,
    -- Hash over node identity plus resolved inputs. Equal keys mean a reusable result.
    cache_key   text        NOT NULL,
    payload     jsonb,
    payload_ref text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, node_id),
    CONSTRAINT node_results_payload_xor CHECK (payload IS NULL OR payload_ref IS NULL)
);

CREATE INDEX node_results_cache_key_idx ON node_results (owner_id, cache_key);

-- Down Migration

DROP TABLE node_results;
DROP TABLE run_events;
DROP TABLE runs;
DROP TABLE working_trees;
DROP TABLE projects;
