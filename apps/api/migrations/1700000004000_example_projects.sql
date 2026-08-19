-- Up Migration

-- Examples ship inside Civil and exist to be opened as quickstarts. They are not a
-- repository, so they do not bend the one-project-per-repository rule — they are a
-- third kind of source with no repository at all.
--
-- Reading them from the container image does not bend the no-local-file-storage rule
-- either: they are immutable, shipped with the code, and reconstructible by
-- rebuilding the image, exactly like the SPA bundle. Nothing on that disk is the only
-- copy of anything.

ALTER TABLE projects DROP CONSTRAINT projects_source_complete;
ALTER TABLE projects DROP CONSTRAINT projects_source_kind_check;

ALTER TABLE projects ADD CONSTRAINT projects_source_kind_check
    CHECK (source_kind IN ('github', 'local', 'example'));

-- Which bundled example this is. A slug rather than a path, because the location
-- inside the image is Civil's business and may move.
ALTER TABLE projects ADD COLUMN example_slug text;

ALTER TABLE projects ADD CONSTRAINT projects_example_slug_shape CHECK (
    example_slug IS NULL OR example_slug ~ '^[a-z][a-z0-9-]{0,63}$'
);

ALTER TABLE projects ADD CONSTRAINT projects_source_complete CHECK (
    (source_kind = 'github'  AND repo_owner IS NOT NULL AND repo_name IS NOT NULL)
 OR (source_kind = 'local'   AND local_path IS NOT NULL)
 OR (source_kind = 'example' AND example_slug IS NOT NULL)
);

-- One copy of a given example per person. Opening it twice should return you to the
-- one you already have, pending edits and all.
CREATE UNIQUE INDEX projects_owner_example_idx
    ON projects (owner_id, example_slug)
    WHERE source_kind = 'example';

-- Down Migration

DROP INDEX projects_owner_example_idx;
ALTER TABLE projects DROP CONSTRAINT projects_source_complete;
ALTER TABLE projects DROP CONSTRAINT projects_example_slug_shape;

DELETE FROM projects WHERE source_kind = 'example';
ALTER TABLE projects DROP COLUMN example_slug;

ALTER TABLE projects DROP CONSTRAINT projects_source_kind_check;
ALTER TABLE projects ADD CONSTRAINT projects_source_kind_check
    CHECK (source_kind IN ('github', 'local'));

ALTER TABLE projects ADD CONSTRAINT projects_source_complete CHECK (
    (source_kind = 'github' AND repo_owner IS NOT NULL AND repo_name IS NOT NULL)
 OR (source_kind = 'local'  AND local_path IS NOT NULL)
);
