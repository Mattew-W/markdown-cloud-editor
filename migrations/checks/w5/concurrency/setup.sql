-- M2 W5 · 独立会话 CAS 夹具（M2-W5-02）
-- 前置：run_setup.sql 已建 schema、SET search_path、加载 0001_init.sql。

SET client_encoding = 'UTF8';

CREATE TABLE w5_barrier (
    session text NOT NULL,
    phase   text NOT NULL,
    PRIMARY KEY (session, phase)
);

-- 每个会话一行：记录起跑/结束时间、影响行数、提交后的回读结果。
CREATE TABLE w5_attempts (
    session           text PRIMARY KEY,
    initial_version   integer,
    attempted_content text NOT NULL,
    started_at        timestamptz,
    finished_at       timestamptz,
    rows_affected     integer,
    readback_version  integer,
    readback_content  text,
    readback_at       timestamptz
);

INSERT INTO users (id, username, password_hash, created_at)
VALUES (
    'a5555555-5555-4555-8555-555555555555',
    'w5_conc',
    'DB_TEST_ONLY_FAKE_HASH_W5_CONC_NOT_ARGON2',
    TIMESTAMPTZ '2026-11-16 00:00:00+00'
);

INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
VALUES (
    'b5555555-5555-4555-8555-555555555555',
    'a5555555-5555-4555-8555-555555555555',
    'W5 并发文档',
    'v1',
    1,
    TIMESTAMPTZ '2026-11-16 00:00:00+00',
    TIMESTAMPTZ '2026-11-16 00:00:00+00'
);

\echo 'W5 concurrency setup complete'
