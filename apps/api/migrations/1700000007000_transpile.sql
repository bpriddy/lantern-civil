-- Up Migration

-- The transpiler's memo. docs/emitted-code.md redefines determinism as "same
-- documents + same pattern prompt → same bytes", and this table is what holds Civil
-- to it: the hash covers every file the model sees plus a prompt version, so a
-- repeated transpile is a read, and any change to the inputs is a new row rather
-- than a stale answer served with confidence.
CREATE TABLE transpilations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    input_hash  text        NOT NULL,
    -- {files, attempts}: the emitted file set exactly as the runner answered it,
    -- inline because emitted modules are the same order of size as pending_changes
    -- content — the GCS split remains available if that stops being true.
    output      jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- One answer per input state per project.
    UNIQUE (project_id, input_hash)
);

CREATE INDEX transpilations_owner_idx ON transpilations (owner_id);

-- Pattern-analysis staleness. The analyzer runs on exactly the two "a human wrote
-- code" triggers (docs/emitted-code.md): a handwritten save in Monaco sets
-- patterns_stale; patterns_head records which commit civil/patterns.md described,
-- so an inbound change — the head moving under the project — is the other trigger,
-- detected by comparison rather than by a flag anyone has to remember to set.
ALTER TABLE projects ADD COLUMN patterns_stale boolean NOT NULL DEFAULT true;
ALTER TABLE projects ADD COLUMN patterns_head  text;

-- Down Migration

ALTER TABLE projects DROP COLUMN patterns_head;
ALTER TABLE projects DROP COLUMN patterns_stale;

DROP TABLE transpilations;
