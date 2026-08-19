-- Up Migration

-- The commit Civil is editing against.
--
-- Until now every request re-resolved the branch to find its head, so loading a
-- project, opening a file, saving, adding a node and committing were each at least
-- one GitHub call — enough, when browsing, for GitHub to answer 403 and mention
-- scraping. But a commit is immutable: once Civil knows which one it is looking at,
-- the tree and every blob under it can be read from cache forever.
--
-- Pinning it also makes the question "what am I editing against" answerable, which is
-- what pending_changes.base_commit_sha has always assumed.
ALTER TABLE projects ADD COLUMN head_sha text;

-- Down Migration

ALTER TABLE projects DROP COLUMN head_sha;
