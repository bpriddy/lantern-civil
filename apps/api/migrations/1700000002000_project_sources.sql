-- Up Migration

-- PRD 15 is GitHub-only and PRD 12 specifies a GitHub App. Creating that App is an
-- account action the owner has not taken yet, and M1's real work is the canvas, not
-- the clone. A project therefore names where it comes from, and a local directory is
-- a legitimate answer during development.
--
-- This does not weaken PRD 6.1: the repo is still the truth. A local source is a
-- working tree that happens not to have been cloned by Civil.

ALTER TABLE projects ADD COLUMN source_kind text NOT NULL DEFAULT 'github'
    CHECK (source_kind IN ('github', 'local'));

ALTER TABLE projects ADD COLUMN local_path text;

-- Only meaningful for a GitHub source, so they cannot stay NOT NULL.
ALTER TABLE projects ALTER COLUMN repo_owner DROP NOT NULL;
ALTER TABLE projects ALTER COLUMN repo_name  DROP NOT NULL;

-- Each source kind requires exactly the fields that make it resolvable. Without this
-- a project can exist that points nowhere, and the failure surfaces much later as an
-- empty canvas rather than a rejected insert.
ALTER TABLE projects ADD CONSTRAINT projects_source_complete CHECK (
    (source_kind = 'github' AND repo_owner IS NOT NULL AND repo_name IS NOT NULL)
 OR (source_kind = 'local'  AND local_path IS NOT NULL)
);

-- The old uniqueness rule assumed every project was a GitHub repo.
ALTER TABLE projects DROP CONSTRAINT projects_owner_id_repo_owner_repo_name_key;

CREATE UNIQUE INDEX projects_owner_repo_idx
    ON projects (owner_id, repo_owner, repo_name)
    WHERE source_kind = 'github';

CREATE UNIQUE INDEX projects_owner_local_idx
    ON projects (owner_id, local_path)
    WHERE source_kind = 'local';

-- Down Migration

DROP INDEX projects_owner_local_idx;
DROP INDEX projects_owner_repo_idx;

ALTER TABLE projects ADD CONSTRAINT projects_owner_id_repo_owner_repo_name_key
    UNIQUE (owner_id, repo_owner, repo_name);

ALTER TABLE projects DROP CONSTRAINT projects_source_complete;

DELETE FROM projects WHERE repo_owner IS NULL OR repo_name IS NULL;
ALTER TABLE projects ALTER COLUMN repo_name  SET NOT NULL;
ALTER TABLE projects ALTER COLUMN repo_owner SET NOT NULL;

ALTER TABLE projects DROP COLUMN local_path;
ALTER TABLE projects DROP COLUMN source_kind;
