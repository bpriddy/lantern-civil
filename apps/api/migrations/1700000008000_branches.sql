-- Up Migration

-- Branches (owner's rule, 2026-10-01: no automated git, visible control of the git
-- flow — including branches and pull requests).
--
-- Until now a project had one branch, its default, and one pinned head. Each branch
-- now carries its own: the commit Civil edits against on it, the branch it was cut
-- from (where a pull request goes), and the pull request opened from it.
-- pending_changes was always keyed by branch, so edits already sit with their branch
-- and switching away from one sets them aside rather than losing them.
CREATE TABLE project_branches (
    owner_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        text        NOT NULL,
    head_sha    text,
    base_branch text,
    pr_number   integer,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, name)
);
CREATE INDEX project_branches_owner_idx ON project_branches (owner_id);

-- The branch the author is working on; null means the repository's default.
ALTER TABLE projects ADD COLUMN current_branch text;

-- Every pinned head so far is the default branch's.
INSERT INTO project_branches (owner_id, project_id, name, head_sha)
SELECT owner_id, id, default_branch, head_sha FROM projects WHERE head_sha IS NOT NULL;

-- projects.head_sha is superseded by project_branches.head_sha and no longer read
-- or written. Left in place: forward-only migrations, and dropping it buys nothing.

-- Down Migration

ALTER TABLE projects DROP COLUMN current_branch;
DROP TABLE project_branches;
