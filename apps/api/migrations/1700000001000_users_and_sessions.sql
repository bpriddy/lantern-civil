-- Up Migration

-- Replaces IAP with application-owned Google OAuth. PRD 12 put auth in IAP and 2
-- excluded multi-tenancy; the owner has since chosen to share the application, which
-- makes a real user table necessary. See docs/prd-deltas.md.
--
-- Migration 001 is not rewritten. It shipped and ran against Cloud SQL, and PRD 2
-- asks for real migrations from the first commit — which means forward, even when
-- the tables are still empty.

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Google's `sub` claim: stable for the lifetime of the account and the only
    -- identifier safe to key on. Email is display data — Google accounts can change
    -- their address, and keying on it would silently fork someone's projects.
    google_sub    text        NOT NULL UNIQUE,
    email         text        NOT NULL,
    email_verified boolean    NOT NULL DEFAULT false,
    name          text,
    avatar_url    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);

CREATE INDEX users_email_idx ON users (lower(email));

-- Server-side sessions rather than a self-contained token. A stateless JWT cannot be
-- revoked before it expires, and "sign this person out now" is a thing an owner of a
-- shared application eventually needs.
CREATE TABLE sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    -- Recorded for the owner's benefit when reviewing active sessions, never for
    -- authorisation: both are trivially spoofed by the client.
    user_agent  text,
    ip          inet
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- PRD 15 is GitHub-only, and the owner asked for the GitHub link to be a settings
-- step rather than part of signing in. Keeping it per-user rather than per-project
-- means one connection serves every project that user owns.
CREATE TABLE user_connections (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider        text        NOT NULL CHECK (provider IN ('github')),
    external_login  text,
    external_id     text,
    -- PRD 12: a GitHub App, not PATs. This is the installation short-lived tokens
    -- are minted against server-side; no token is ever stored here or sent to the
    -- browser.
    installation_id bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider)
);

-- owner_id was text because IAP asserted an opaque subject. It becomes a real
-- foreign key now that users exist. PRD 2 put owner_id on every table from the first
-- migration precisely so this would be a type change rather than a restructuring.
--
-- The USING clause is exact rather than lenient: every table is empty, so a row that
-- somehow existed would fail loudly instead of being silently discarded.

ALTER TABLE projects      ALTER COLUMN owner_id TYPE uuid USING owner_id::uuid;
ALTER TABLE working_trees ALTER COLUMN owner_id TYPE uuid USING owner_id::uuid;
ALTER TABLE runs          ALTER COLUMN owner_id TYPE uuid USING owner_id::uuid;
ALTER TABLE run_events    ALTER COLUMN owner_id TYPE uuid USING owner_id::uuid;
ALTER TABLE node_results  ALTER COLUMN owner_id TYPE uuid USING owner_id::uuid;

ALTER TABLE projects
    ADD CONSTRAINT projects_owner_fk
    FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE working_trees
    ADD CONSTRAINT working_trees_owner_fk
    FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE runs
    ADD CONSTRAINT runs_owner_fk
    FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE run_events
    ADD CONSTRAINT run_events_owner_fk
    FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE node_results
    ADD CONSTRAINT node_results_owner_fk
    FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE;

-- Down Migration

ALTER TABLE node_results  DROP CONSTRAINT node_results_owner_fk;
ALTER TABLE run_events    DROP CONSTRAINT run_events_owner_fk;
ALTER TABLE runs          DROP CONSTRAINT runs_owner_fk;
ALTER TABLE working_trees DROP CONSTRAINT working_trees_owner_fk;
ALTER TABLE projects      DROP CONSTRAINT projects_owner_fk;

ALTER TABLE node_results  ALTER COLUMN owner_id TYPE text USING owner_id::text;
ALTER TABLE run_events    ALTER COLUMN owner_id TYPE text USING owner_id::text;
ALTER TABLE runs          ALTER COLUMN owner_id TYPE text USING owner_id::text;
ALTER TABLE working_trees ALTER COLUMN owner_id TYPE text USING owner_id::text;
ALTER TABLE projects      ALTER COLUMN owner_id TYPE text USING owner_id::text;

DROP TABLE user_connections;
DROP TABLE sessions;
DROP TABLE users;
