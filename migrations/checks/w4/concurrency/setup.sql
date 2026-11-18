-- M2 W4 concurrency fixtures.
-- Precondition: run_setup.sql has created the schema, set search_path, and
-- loaded 0001_init.sql.

SET client_encoding = 'UTF8';

CREATE TABLE w4_sessions (
    session          text        NOT NULL,
    phase            text        NOT NULL,
    initial_version  integer,
    initial_content  text,
    created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session, phase)
);

CREATE TABLE w4_results (
    session           text        PRIMARY KEY,
    rows_affected     integer     NOT NULL,
    attempted_content text        NOT NULL,
    final_version     integer,
    final_content     text,
    created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (id, username, password_hash, created_at)
VALUES (
    'e4444444-4444-4444-8444-444444444444',
    'w4_conc',
    'DB_TEST_ONLY_FAKE_HASH_W4_CONC_NOT_ARGON2',
    TIMESTAMPTZ '2026-11-09 00:00:00+00'
);

INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
VALUES (
    'f4444444-4444-4444-8444-444444444444',
    'e4444444-4444-4444-8444-444444444444',
    'W4 并发文档',
    'v1',
    1,
    TIMESTAMPTZ '2026-11-09 00:00:00+00',
    TIMESTAMPTZ '2026-11-09 00:00:00+00'
);

\echo 'W4 concurrency setup complete'
