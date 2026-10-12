-- Up Migration

-- The repo lift's agent stage (docs/lift-repo.md, "The agent stage"), now behind the
-- button: analysis takes minutes, so it reports progress, and it is memoised per area
-- so an Update over unchanged code proposes nothing.

-- Progress of one lift, written as it goes and read by the canvas while the request
-- that runs it is still open. Keyed by an id the client chose, so it can ask before
-- the lift has answered.
CREATE TABLE lift_runs (
    owner_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    run_id      uuid        NOT NULL,
    state       text        NOT NULL CHECK (state IN ('running', 'done', 'failed')),
    stage       text        NOT NULL,
    detail      text        NOT NULL DEFAULT '',
    areas_total integer,
    areas_done  integer,
    started_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, run_id)
);
CREATE INDEX lift_runs_owner_idx ON lift_runs (owner_id);

-- What the analysts and verifiers said about one area of a repository, keyed by a
-- fingerprint of that area's files, the reader's claims about it, the prompt version
-- and the model. A cache in the CLAUDE.md sense — reconstructible by asking again —
-- that keeps agents from rewording what has not changed.
CREATE TABLE lift_area_memos (
    owner_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    fingerprint text        NOT NULL,
    -- Which area it was, so a failed call can fall back to the area's last answer.
    area_id     text        NOT NULL,
    claims      jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, fingerprint)
);
CREATE INDEX lift_area_memos_owner_idx ON lift_area_memos (owner_id);
CREATE INDEX lift_area_memos_area_idx ON lift_area_memos (project_id, area_id, created_at DESC);

-- Down Migration

DROP TABLE lift_area_memos;
DROP TABLE lift_runs;
