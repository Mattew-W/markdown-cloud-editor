-- M2 W5 · 有限并发轮次夹具（M2-W5-03 并发部分）
-- 前置：run_rounds_setup.sql 已建 schema、SET search_path、加载 0001_init.sql。

SET client_encoding = 'UTF8';

CREATE TABLE w5_rounds (
    round_no         integer     NOT NULL,
    role             text        NOT NULL,
    rows_affected    integer,
    sqlstate         text        NOT NULL,
    started_at       timestamptz NOT NULL,
    finished_at      timestamptz NOT NULL,
    observed_version integer,
    observed_content text,
    read_count       integer,
    PRIMARY KEY (round_no, role)
);

INSERT INTO users (id, username, password_hash, created_at)
VALUES (
    'a7777777-7777-4777-8777-777777777777',
    'w5_rounds',
    'DB_TEST_ONLY_FAKE_HASH_W5_ROUNDS_NOT_ARGON2',
    TIMESTAMPTZ '2026-11-16 00:00:00+00'
);

INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
VALUES (
    'b7777777-7777-4777-8777-777777777777',
    'a7777777-7777-4777-8777-777777777777',
    'W5 轮次文档',
    'v1',
    1,
    TIMESTAMPTZ '2026-11-16 00:00:00+00',
    TIMESTAMPTZ '2026-11-16 00:00:00+00'
);

\echo 'W5 rounds setup complete'
