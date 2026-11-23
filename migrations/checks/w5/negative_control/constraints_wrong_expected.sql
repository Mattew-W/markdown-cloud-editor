-- ============================================================
-- M2 W5 · constraints.sql  (M2-W5-01)
-- 目的：在隔离 schema 中对冻结迁移 0001_init.sql 的关键约束做精确 SQLSTATE 回归，
--       同时保留合规对照（合法输入必须成功）。
-- 前置：run_w5_regression.sql 已建临时 schema、SET search_path、加载 0001_init.sql。
-- 事务：本文件自行 BEGIN/ROLLBACK。
-- 记录：每条用例把 expected/actual SQLSTATE 写入 w5_observations，
--       便于日志中逐条核对，而不是只看 PASS 字样。
-- ============================================================

SET client_encoding = 'UTF8';

BEGIN;

CREATE TABLE w5_observations (
    case_id        text PRIMARY KEY,
    expected_state text NOT NULL,
    actual_state   text NOT NULL,
    detail         text,
    recorded_at    timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 断言助手：expected = 'SUCCESS' 表示语句必须成功；否则必须报出指定 SQLSTATE。
CREATE OR REPLACE FUNCTION w5_expect(
    p_case     text,
    p_expected text,
    p_actual   text,
    p_detail   text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
    INSERT INTO w5_observations (case_id, expected_state, actual_state, detail)
    VALUES (p_case, p_expected, p_actual, p_detail);

    IF p_expected = 'SUCCESS' THEN
        IF p_actual <> '00000' THEN
            RAISE EXCEPTION 'W5 CHECK FAILED [%]: expected success, got % (%)',
                p_case, p_actual, p_detail;
        END IF;
    ELSE
        IF p_actual = '00000' THEN
            RAISE EXCEPTION 'W5 CHECK FAILED [%]: expected SQLSTATE %, but statement succeeded',
                p_case, p_expected;
        ELSIF p_actual <> p_expected THEN
            RAISE EXCEPTION 'W5 CHECK FAILED [%]: expected %, got % (%)',
                p_case, p_expected, p_actual, p_detail;
        END IF;
    END IF;

    RAISE NOTICE 'PASS [%]: expected=%, actual=%', p_case, p_expected, p_actual;
END
$fn$;

DO $w5$
DECLARE
    v_state      text;
    v_message    text;
    v_constraint text;
    v_count      bigint;
    v_title_len  integer;
    v_bytes      integer;

    c_user_a constant uuid := 'a1111111-1111-4111-8111-111111111111'::uuid;
    c_user_b constant uuid := 'a2222222-2222-4222-8222-222222222222'::uuid;
    c_user_c constant uuid := 'a3333333-3333-4333-8333-333333333333'::uuid;
    c_user_d constant uuid := 'a4444444-4444-4444-8444-444444444444'::uuid;
    c_doc_a  constant uuid := 'b1111111-1111-4111-8111-111111111111'::uuid;
BEGIN
    -- --------------------------------------------------------
    -- 0. 夹具：A 有文档；B、C、D 无文档（D 用于合法删除对照）
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO users (id, username, password_hash, created_at)
        VALUES
            (c_user_a, 'w5_alice', 'DB_TEST_ONLY_FAKE_HASH_W5_ALICE_NOT_ARGON2',
             TIMESTAMPTZ '2026-11-16 00:00:00+00'),
            (c_user_b, 'w5_bob', 'DB_TEST_ONLY_FAKE_HASH_W5_BOB_NOT_ARGON2',
             TIMESTAMPTZ '2026-11-16 00:00:00+00'),
            (c_user_c, 'w5_carol', 'DB_TEST_ONLY_FAKE_HASH_W5_CAROL_NOT_ARGON2',
             TIMESTAMPTZ '2026-11-16 00:00:00+00'),
            (c_user_d, 'w5_dave', 'DB_TEST_ONLY_FAKE_HASH_W5_DAVE_NOT_ARGON2',
             TIMESTAMPTZ '2026-11-16 00:00:00+00');

        INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
        VALUES (c_doc_a, c_user_a, 'W5 夹具文档', 'v1', 1,
                TIMESTAMPTZ '2026-11-16 00:00:00+00', TIMESTAMPTZ '2026-11-16 00:00:00+00');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;

    PERFORM w5_expect('fixture setup', 'SUCCESS', v_state, v_message);

    -- --------------------------------------------------------
    -- 1. 唯一约束：重复 username -> 23505
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO users (username, password_hash) VALUES ('w5_alice', 'fake');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('username duplicate', '23514', v_state, v_message);

    -- --------------------------------------------------------
    -- 2. 用户名格式（加固 CHECK）：大写 / 过短 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO users (username, password_hash) VALUES ('W5_UPPER', 'fake');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('username uppercase', '23514', v_state, v_message);

    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO users (username, password_hash) VALUES ('ab', 'fake');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('username too short', '23514', v_state, v_message);

    -- --------------------------------------------------------
    -- 3. 外键：合法但不存在的 owner -> 23503；非法 UUID 字符串 -> 22P02
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('99999999-9999-4999-8999-999999999999', 'W5 孤儿', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('owner nonexistent uuid', '23503', v_state, v_message);

    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('99999', 'W5 非法 uuid', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('owner invalid uuid text', '22P02', v_state, v_message);

    -- --------------------------------------------------------
    -- 4. 标题：空 / 空格 / 全角空格 -> 23514；256 字符 -> 22001
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content) VALUES (c_user_a, '', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('title empty', '23514', v_state, v_message);

    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content) VALUES (c_user_a, '   ', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('title spaces', '23514', v_state, v_message);

    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content) VALUES (c_user_a, U&'\3000\3000', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('title ideographic space', '23514', v_state, v_message);

    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content) VALUES (c_user_a, repeat('a', 256), '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('title 256 chars', '22001', v_state, v_message);

    -- --------------------------------------------------------
    -- 5. 正文字节上限：262145 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES (c_user_a, 'W5 正文超限', repeat('中', 87381) || 'ab');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('content 262145 bytes', '23514', v_state, v_message);

    -- --------------------------------------------------------
    -- 6. version 非正 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content, version)
        VALUES (c_user_a, 'W5 版本零', '正文', 0);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('version 0', '23514', v_state, v_message);

    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content, version)
        VALUES (c_user_a, 'W5 版本负', '正文', -1);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('version -1', '23514', v_state, v_message);

    -- --------------------------------------------------------
    -- 7. 外键 RESTRICT：删除有文档的用户 -> 23503；用户/文档保留
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    v_constraint := NULL;
    BEGIN
        DELETE FROM users WHERE id = c_user_a;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT,
            v_constraint = CONSTRAINT_NAME;
    END;
    PERFORM w5_expect('delete user with documents', '23503', v_state,
        format('constraint=%s', v_constraint));

    SELECT count(*) INTO v_count FROM users WHERE id = c_user_a;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'W5 CHECK FAILED [user preserved after restricted delete]: count=%', v_count;
    END IF;
    SELECT count(*) INTO v_count FROM documents WHERE id = c_doc_a;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'W5 CHECK FAILED [document preserved after restricted delete]: count=%', v_count;
    END IF;

    -- --------------------------------------------------------
    -- 8. 合规对照：合法输入必须成功
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (id, owner_id, title, content, version)
        VALUES ('b2222222-2222-4222-8222-222222222222', c_user_a,
                repeat('a', 255), repeat('中', 87381) || 'a', 1);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('control title 255 / content 262144', 'SUCCESS', v_state, v_message);

    SELECT char_length(title), octet_length(content)
      INTO v_title_len, v_bytes
      FROM documents
     WHERE id = 'b2222222-2222-4222-8222-222222222222';
    IF v_title_len IS DISTINCT FROM 255 THEN
        RAISE EXCEPTION 'W5 CHECK FAILED [control title length]: %', v_title_len;
    END IF;
    IF v_bytes IS DISTINCT FROM 262144 THEN
        RAISE EXCEPTION 'W5 CHECK FAILED [control content bytes]: %', v_bytes;
    END IF;

    v_state := '00000';
    v_message := NULL;
    BEGIN
        DELETE FROM users WHERE id = c_user_d;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    END;
    PERFORM w5_expect('control delete user without documents', 'SUCCESS', v_state, v_message);

    -- --------------------------------------------------------
    -- 9. 汇总并核对观测条数
    -- --------------------------------------------------------
    SELECT count(*) INTO v_count FROM w5_observations;
    IF v_count <> 16 THEN
        RAISE EXCEPTION 'W5 CHECK FAILED [observation count]: %, expected 16', v_count;
    END IF;
    RAISE NOTICE 'W5 observations recorded: %', v_count;
    RAISE NOTICE 'ALL W5 CONSTRAINT CHECKS PASSED';
END
$w5$;

\echo 'W5 observations'
SELECT case_id, expected_state, actual_state
  FROM w5_observations
 ORDER BY case_id;

ROLLBACK;
