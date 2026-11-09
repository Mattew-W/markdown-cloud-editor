-- ============================================================
-- M2 W3 · regression.sql
-- 目的：在隔离 schema 中对冻结迁移 0001_init.sql 的约束做可复现回归。
-- 前置：run_w3_regression.sql 已创建临时 schema、设置 search_path，
--       并在同一会话中加载 migrations/0001_init.sql。
-- 事务：本文件自行 BEGIN/ROLLBACK；不写 public，不依赖现有用户数据。
--
-- 覆盖（至少）：
--   1. 两个合法 UUID 用户可以有同名文档标题
--   2. 合法但不存在的 UUID owner -> 23503
--   3. 标题 255 字符成功 / 256 字符 -> 22001
--   4. 正文 262144 UTF-8 字节成功 / 262145 字节 -> 23514
--   5. version = 0 -> 23514
--   6. 前后行数一致，最终 ROLLBACK
-- ============================================================

SET client_encoding = 'UTF8';

BEGIN;

DO $w3$
DECLARE
    v_state           text;
    v_message         text;
    v_users_before    bigint;
    v_docs_before     bigint;
    v_users_after     bigint;
    v_docs_after      bigint;
    v_count           bigint;
    v_distinct_owners bigint;
    v_title_len       integer;
    v_content_bytes   integer;
BEGIN
    -- --------------------------------------------------------
    -- 0. 隔离 schema 必须为空，避免依赖现有数据
    -- --------------------------------------------------------
    SELECT count(*) INTO v_users_before FROM users;
    SELECT count(*) INTO v_docs_before FROM documents;
    RAISE NOTICE 'W3 baseline: users=%, documents=%', v_users_before, v_docs_before;

    IF v_users_before <> 0 OR v_docs_before <> 0 THEN
        RAISE EXCEPTION 'W3 SETUP FAILED: isolated schema is not empty (users=%, documents=%)',
            v_users_before, v_docs_before;
    END IF;

    -- --------------------------------------------------------
    -- 1. 两个合法 UUID 用户可以有同名标题
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO users (id, username, password_hash, created_at)
        VALUES
            ('c1111111-1111-4111-8111-111111111111',
             'w3_alice',
             'DB_TEST_ONLY_FAKE_HASH_W3_ALICE_NOT_ARGON2',
             TIMESTAMPTZ '2026-11-01 00:00:00+00'),
            ('c2222222-2222-4222-8222-222222222222',
             'w3_bob',
             'DB_TEST_ONLY_FAKE_HASH_W3_BOB_NOT_ARGON2',
             TIMESTAMPTZ '2026-11-01 00:01:00+00');

        INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
        VALUES
            ('d1111111-1111-4111-8111-111111111111',
             'c1111111-1111-4111-8111-111111111111',
             'W3 同名标题',
             'alice 的内容',
             1,
             TIMESTAMPTZ '2026-11-01 00:10:00+00',
             TIMESTAMPTZ '2026-11-01 00:10:00+00'),
            ('d2222222-2222-4222-8222-222222222222',
             'c2222222-2222-4222-8222-222222222222',
             'W3 同名标题',
             'bob 的内容',
             1,
             TIMESTAMPTZ '2026-11-01 00:11:00+00',
             TIMESTAMPTZ '2026-11-01 00:11:00+00');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state <> '00000' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [same-title setup]: expected success, got % (%)',
            v_state, v_message;
    END IF;

    SELECT count(*), count(DISTINCT owner_id)
      INTO v_count, v_distinct_owners
      FROM documents
     WHERE title = 'W3 同名标题';

    IF v_count <> 2 OR v_distinct_owners <> 2 THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [same title across two users]: rows=%, distinct owners=%',
            v_count, v_distinct_owners;
    END IF;
    RAISE NOTICE 'PASS [same title across two users]: rows=2, owners=2';

    -- --------------------------------------------------------
    -- 2. 合法但不存在的 UUID owner -> 23503
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('99999999-9999-4999-8999-999999999999', 'W3 外键测试', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [nonexistent owner]: INSERT succeeded; expected 23503';
    ELSIF v_state <> '23505' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [nonexistent owner]: expected 23505, got % (%)',
            v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [nonexistent owner]: SQLSTATE 23503';

    -- --------------------------------------------------------
    -- 3a. 标题 255 字符 -> 成功
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (id, owner_id, title, content, version)
        VALUES (
            'd3333333-3333-4333-8333-333333333333',
            'c1111111-1111-4111-8111-111111111111',
            repeat('t', 255),
            '标题边界正文',
            1
        );
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state <> '00000' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [title 255]: expected success, got % (%)',
            v_state, v_message;
    END IF;

    SELECT char_length(title) INTO v_title_len
      FROM documents
     WHERE id = 'd3333333-3333-4333-8333-333333333333';
    IF v_title_len IS DISTINCT FROM 255 THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [title 255]: stored char_length=%, expected 255', v_title_len;
    END IF;
    RAISE NOTICE 'PASS [title 255]: INSERT succeeded, char_length=255';

    -- --------------------------------------------------------
    -- 3b. 标题 256 字符 -> 22001（VARCHAR(255) 长度错误）
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('c1111111-1111-4111-8111-111111111111', repeat('t', 256), '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [title 256]: INSERT succeeded; expected 22001';
    ELSIF v_state <> '22001' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [title 256]: expected 22001, got % (%)',
            v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [title 256]: SQLSTATE 22001';

    -- --------------------------------------------------------
    -- 4a. 正文 262144 UTF-8 字节 -> 成功
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (id, owner_id, title, content, version)
        VALUES (
            'd4444444-4444-4444-8444-444444444444',
            'c1111111-1111-4111-8111-111111111111',
            'W3 正文字节边界',
            repeat('中', 87381) || 'a',
            1
        );
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state <> '00000' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [content 262144]: expected success, got % (%)',
            v_state, v_message;
    END IF;

    SELECT octet_length(content) INTO v_content_bytes
      FROM documents
     WHERE id = 'd4444444-4444-4444-8444-444444444444';
    IF v_content_bytes IS DISTINCT FROM 262144 THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [content 262144]: stored bytes=%, expected 262144',
            v_content_bytes;
    END IF;
    RAISE NOTICE 'PASS [content 262144]: INSERT succeeded, octet_length=262144';

    -- --------------------------------------------------------
    -- 4b. 正文 262145 字节 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES (
            'c1111111-1111-4111-8111-111111111111',
            'W3 正文超限',
            repeat('中', 87381) || 'ab'
        );
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [content 262145]: INSERT succeeded; expected 23514';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [content 262145]: expected 23514, got % (%)',
            v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [content 262145]: SQLSTATE 23514';

    -- --------------------------------------------------------
    -- 5. version = 0 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content, version)
        VALUES ('c1111111-1111-4111-8111-111111111111', 'W3 版本零', '正文', 0);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [version 0]: INSERT succeeded; expected 23514';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [version 0]: expected 23514, got % (%)',
            v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [version 0]: SQLSTATE 23514';

    -- --------------------------------------------------------
    -- 6. 清理测试行，核对前后行数
    -- --------------------------------------------------------
    DELETE FROM documents
     WHERE owner_id IN ('c1111111-1111-4111-8111-111111111111',
                        'c2222222-2222-4222-8222-222222222222');
    DELETE FROM users
     WHERE id IN ('c1111111-1111-4111-8111-111111111111',
                  'c2222222-2222-4222-8222-222222222222');

    SELECT count(*) INTO v_users_after FROM users;
    SELECT count(*) INTO v_docs_after FROM documents;
    RAISE NOTICE 'W3 after cleanup: users=%, documents=%', v_users_after, v_docs_after;

    IF v_users_after <> v_users_before OR v_docs_after <> v_docs_before THEN
        RAISE EXCEPTION 'W3 CHECK FAILED [row counts]: before users=%, documents=%; after users=%, documents=%',
            v_users_before, v_docs_before, v_users_after, v_docs_after;
    END IF;
    RAISE NOTICE 'PASS [row counts unchanged]: users=%, documents=%',
        v_users_after, v_docs_after;

    RAISE NOTICE 'ALL W3 REGRESSION CHECKS PASSED';
END
$w3$;

ROLLBACK;
