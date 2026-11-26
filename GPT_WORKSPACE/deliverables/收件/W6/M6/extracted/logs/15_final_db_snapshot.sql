\pset pager off
SELECT count(*) AS users FROM users;
SELECT count(*) AS documents FROM documents;
SELECT id, owner_id, title, version, length(content) AS content_bytes, updated_at FROM documents ORDER BY updated_at;
SELECT version() AS pg_version;

