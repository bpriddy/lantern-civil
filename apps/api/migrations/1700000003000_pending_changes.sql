-- Up Migration

-- The durable home for uncommitted work.
--
-- CLAUDE.md: nothing on the container filesystem may be the only copy of anything.
-- An uncommitted edit is reconstructible from nothing, so it cannot live on a disk
-- that Cloud Run destroys on every deploy. It lives here, which is also what makes
-- "start on one device, continue on another, without committing" true.
--
-- PRD 6.1 still holds: the repo is the truth. A pending change is not repo contents,
-- because it is not in the repo yet — it is Civil's own state, in the same category
-- as runs and run_events.

CREATE TABLE pending_changes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id      uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- Pending work is per branch: switching branches must not carry edits across.
    branch          text        NOT NULL,
    -- Project-relative, forward slashes, no leading slash. The path AFTER the change,
    -- so a rename is stored under its new name with from_path recording the old one.
    path            text        NOT NULL,

    kind            text        NOT NULL CHECK (kind IN ('add', 'modify', 'delete', 'rename')),
    from_path       text,

    -- Small content inline, large content in GCS. Same split as run_events, and the
    -- same reason: rows stay queryable and a big blob does not bloat the table.
    content         text,
    content_ref     text,
    size_bytes      bigint      NOT NULL DEFAULT 0,

    -- What this edit was based on. base_blob_sha is the git blob the editor last saw;
    -- comparing it to HEAD at commit time is how divergence is detected per file
    -- rather than discovered as one opaque conflict. This is the whole reason a
    -- three-way merge is not needed for a single user (docs/roadmap.md).
    base_blob_sha   text,
    base_commit_sha text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- One pending state per file per branch. A second edit updates the row rather
    -- than accumulating history — the diff is against HEAD, not against the last save.
    UNIQUE (project_id, branch, path),

    -- Content rules differ by kind, and a row that violates them would render as a
    -- file with no bytes or a deletion that somehow has content.
    CONSTRAINT pending_changes_content_shape CHECK (
        CASE kind
            WHEN 'delete' THEN content IS NULL AND content_ref IS NULL
            WHEN 'rename' THEN NOT (content IS NOT NULL AND content_ref IS NOT NULL)
            ELSE (content IS NULL) <> (content_ref IS NULL)
        END
    ),

    -- from_path is exactly the rename case, in both directions.
    CONSTRAINT pending_changes_rename_shape CHECK ((kind = 'rename') = (from_path IS NOT NULL)),

    CONSTRAINT pending_changes_path_relative CHECK (
        path !~ '^/' AND path !~ '(^|/)\.\.(/|$)'
    )
);

CREATE INDEX pending_changes_owner_idx ON pending_changes (owner_id);
CREATE INDEX pending_changes_project_branch_idx ON pending_changes (project_id, branch);

-- working_trees modelled a clone path that will never exist. Dropped rather than left
-- with permanently null columns: a table describing a thing we decided not to build
-- is worse than no table, because the next reader assumes it means something.
DROP TABLE working_trees;

-- Down Migration

CREATE TABLE working_trees (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id   uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    branch       text        NOT NULL,
    head_sha     text,
    clone_path   text,
    status       text        NOT NULL DEFAULT 'absent'
        CHECK (status IN ('absent', 'cloning', 'ready', 'error')),
    error        text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, branch)
);

CREATE INDEX working_trees_owner_idx ON working_trees (owner_id);

DROP TABLE pending_changes;
