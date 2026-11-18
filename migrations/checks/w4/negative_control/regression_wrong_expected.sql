-- ============================================================
-- M2 W4 · regression.sql
-- 目的：在隔离 schema 中验证现有 PostgreSQL CRUD 约束与 CAS 写入语义。
-- 前置：run_w4_regression.sql 已创建临时 schema、设置 search_path、
--       加载 public_counts.sql 与 0001_init.sql。
-- 事务：本文件自行 BEGIN/ROLLBACK；不写 public，不依赖真实用户数据。
--
-- 覆盖：
--   M2-02 有文档用户删除被 RESTRICT（23503），用户/文档保留；
--         合法不存在 UUID 外键 23503；非法 UUID 字符串 22P02。
--   M2-03 owner+id+expected_version 原子更新：命中一行/零行及不变性。
--   M2-05 同时间戳多文档稳定分页、用户过滤、索引定义覆盖。
--   M2-01 隔离 schema 前后行数一致（temp schema；public 由入口函数核对）。
-- ============================================================

SET client_encoding = 'UTF8';

BEGIN;

DO $w4$
DECLARE
    v_state        text;
    v_message      text;
    v_constraint   text;

    v_users_before bigint;
    v_docs_before  bigint;
    v_users_after  bigint;
    v_docs_after   bigint;

    v_count        bigint;
    v_rows         integer;
    v_version      integer;
    v_content      text;
    v_title        text;

    v_full         text;
    v_page1        text;
    v_page2        text;
    v_page1b       text;
    v_indexdef     text;

    c_user_a constant uuid := 'e1111111-1111-4111-8111-111111111111'::uuid;
    c_user_b constant uuid := 'e2222222-2222-4222-8222-222222222222'::uuid;
    c_user_c constant uuid := 'e3333333-3333-4333-8333-333333333333'::uuid;
    c_doc_a  constant uuid := 'f1111111-1111-4111-8111-111111111111'::uuid;
    c_doc_b  constant uuid := 'f2222222-2222-4222-8222-222222222222'::uuid;
    c_doc_c1 constant uuid := 'd1111111-1111-4111-8111-111111111111'::uuid;
    c_doc_c2 constant uuid := 'd2222222-2222-4222-8222-222222222222'::uuid;
    c_doc_c3 constant uuid := 'd3333333-3333-4333-8333-333333333333'::uuid;
    c_doc_c4 constant uuid := 'd4444444-4444-4444-8444-444444444444'::uuid;
BEGIN
    -- --------------------------------------------------------
    -- 0. 隔离 schema 必须为空
    -- --------------------------------------------------------
    SELECT count(*) INTO v_users_before FROM users;
    SELECT count(*) INTO v_docs_before FROM documents;
    RAISE NOTICE 'W4 baseline: users=%, documents=%', v_users_before, v_docs_before;
    IF v_users_before <> 0 OR v_docs_before <> 0 THEN
        RAISE EXCEPTION 'W4 SETUP FAILED: isolated schema is not empty (users=%, documents=%)',
            v_users_before, v_docs_before;
    END IF;

    -- --------------------------------------------------------
    -- 1. 固定夹具：三个用户；A 有一篇文档，B 有一篇，C 有四篇同时间戳文档
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO users (id, username, password_hash, created_at)
        VALUES
            (c_user_a, 'w4_alice', 'DB_TEST_ONLY_FAKE_HASH_W4_ALICE_NOT_ARGON2',
             TIMESTAMPTZ '2026-11-09 00:00:00+00'),
            (c_user_b, 'w4_bob', 'DB_TEST_ONLY_FAKE_HASH_W4_BOB_NOT_ARGON2',
             TIMESTAMPTZ '2026-11-09 00:00:00+00'),
            (c_user_c, 'w4_carol', 'DB_TEST_ONLY_FAKE_HASH_W4_CAROL_NOT_ARGON2',
             TIMESTAMPTZ '2026-11-09 00:00:00+00');

        INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
        VALUES
            (c_doc_a, c_user_a, 'W4 原文档', 'v1', 1,
             TIMESTAMPTZ '2026-11-09 00:00:00+00', TIMESTAMPTZ '2026-11-09 00:00:00+00'),
            (c_doc_b, c_user_b, 'W4 B 文档', 'b', 1,
             TIMESTAMPTZ '2026-11-09 00:00:00+00', TIMESTAMPTZ '2026-11-09 00:00:00+00'),
            (c_doc_c1, c_user_c, 'W4 C1', 'c1', 1,
             TIMESTAMPTZ '2026-11-09 00:00:00+00', TIMESTAMPTZ '2026-11-09 00:00:00+00'),
            (c_doc_c2, c_user_c, 'W4 C2', 'c2', 1,
             TIMESTAMPTZ '2026-11-09 00:00:00+00', TIMESTAMPTZ '2026-11-09 00:00:00+00'),
            (c_doc_c3, c_user_c, 'W4 C3', 'c3', 1,
             TIMESTAMPTZ '2026-11-09 00:00:00+00', TIMESTAMPTZ '2026-11-09 00:00:00+00'),
            (c_doc_c4, c_user_c, 'W4 C4', 'c4', 1,
             TIMESTAMPTZ '2026-11-09 00:00:00+00', TIMESTAMPTZ '2026-11-09 00:00:00+00');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state <> '00000' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [fixture setup]: expected success, got % (%)',
            v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [fixture setup]: 3 users, 6 documents';

    -- --------------------------------------------------------
    -- M2-02a 有文档的用户删除被 RESTRICT -> 23503，用户/文档保留
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

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [user delete restricted]: DELETE succeeded; expected 23503';
    ELSIF v_state <> '23505' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [user delete restricted]: expected 23505, got % (%)',
            v_state, v_message;
    END IF;

    SELECT count(*) INTO v_count FROM users WHERE id = c_user_a;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [user preserved]: users=%, expected 1', v_count;
    END IF;
    SELECT count(*) INTO v_count FROM documents WHERE id = c_doc_a;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [document preserved]: documents=%, expected 1', v_count;
    END IF;
    RAISE NOTICE 'PASS [user delete restricted]: 23503 (constraint=%), user and document preserved',
        v_constraint;

    -- --------------------------------------------------------
    -- M2-02b 合法但不存在的 UUID owner -> 23503
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    v_constraint := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('99999999-9999-4999-8999-999999999999', 'W4 孤儿文档', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT,
            v_constraint = CONSTRAINT_NAME;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [nonexistent owner]: INSERT succeeded; expected 23503';
    ELSIF v_state <> '23503' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [nonexistent owner]: expected 23503, got % (%)',
            v_state, v_message;
    END IF;
    SELECT count(*) INTO v_count FROM documents WHERE title = 'W4 孤儿文档';
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [nonexistent owner row]: rows=%, expected 0', v_count;
    END IF;
    RAISE NOTICE 'PASS [nonexistent owner]: 23503 (constraint=%)', v_constraint;

    -- --------------------------------------------------------
    -- M2-02c 非法 UUID 字符串 -> 22P02，与 23503 区分
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    v_constraint := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('99999', 'W4 非法 UUID', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT,
            v_constraint = CONSTRAINT_NAME;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [invalid UUID]: INSERT succeeded; expected 22P02';
    ELSIF v_state <> '22P02' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [invalid UUID]: expected 22P02, got % (%)',
            v_state, v_message;
    END IF;
    SELECT count(*) INTO v_count FROM documents WHERE title = 'W4 非法 UUID';
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [invalid UUID row]: rows=%, expected 0', v_count;
    END IF;
    RAISE NOTICE 'PASS [invalid UUID]: 22P02, distinct from 23503';

    -- --------------------------------------------------------
    -- M2-03a 正确 owner + expected_version -> 1 行，版本推进
    -- --------------------------------------------------------
    UPDATE documents
       SET title = 'W4 更新后',
           content = 'v2',
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = c_doc_a
       AND owner_id = c_user_a
       AND version = 1;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [CAS correct owner/version]: rows=%, expected 1', v_rows;
    END IF;

    SELECT version, content, title INTO v_version, v_content, v_title
      FROM documents WHERE id = c_doc_a;
    IF v_version <> 2 OR v_content <> 'v2' OR v_title <> 'W4 更新后' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [CAS correct result]: version=%, content=%, title=%',
            v_version, v_content, v_title;
    END IF;
    RAISE NOTICE 'PASS [CAS correct owner/version]: 1 row, version=2, content=v2';

    -- --------------------------------------------------------
    -- M2-03b 错误 owner -> 0 行，正文/版本不变
    -- --------------------------------------------------------
    UPDATE documents
       SET title = 'W4 错误 owner',
           content = 'should-not-land',
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = c_doc_a
       AND owner_id = c_user_b
       AND version = 2;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [CAS wrong owner]: rows=%, expected 0', v_rows;
    END IF;

    SELECT version, content, title INTO v_version, v_content, v_title
      FROM documents WHERE id = c_doc_a;
    IF v_version <> 2 OR v_content <> 'v2' OR v_title <> 'W4 更新后' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [CAS wrong owner unchanged]: version=%, content=%, title=%',
            v_version, v_content, v_title;
    END IF;
    RAISE NOTICE 'PASS [CAS wrong owner]: 0 rows, document unchanged';

    -- --------------------------------------------------------
    -- M2-03c 旧版本 -> 0 行，正文/版本不变
    -- --------------------------------------------------------
    UPDATE documents
       SET title = 'W4 旧版本',
           content = 'stale-should-not-land',
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = c_doc_a
       AND owner_id = c_user_a
       AND version = 1;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [CAS stale version]: rows=%, expected 0', v_rows;
    END IF;

    SELECT version, content, title INTO v_version, v_content, v_title
      FROM documents WHERE id = c_doc_a;
    IF v_version <> 2 OR v_content <> 'v2' OR v_title <> 'W4 更新后' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [CAS stale version unchanged]: version=%, content=%, title=%',
            v_version, v_content, v_title;
    END IF;
    RAISE NOTICE 'PASS [CAS stale version]: 0 rows, document unchanged';

    -- --------------------------------------------------------
    -- M2-05a 索引定义覆盖 owner + updated_at DESC + id DESC
    -- --------------------------------------------------------
    SELECT indexdef INTO v_indexdef
      FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname = 'documents_owner_updated_idx';

    IF v_indexdef IS NULL THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [index missing]: documents_owner_updated_idx';
    END IF;
    IF v_indexdef NOT LIKE '%owner_id%'
       OR v_indexdef NOT LIKE '%updated_at DESC%'
       OR v_indexdef NOT LIKE '%id DESC%' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [index definition]: %', v_indexdef;
    END IF;
    RAISE NOTICE 'PASS [index definition]: %', v_indexdef;

    -- --------------------------------------------------------
    -- M2-05b 同 updated_at 的多文档，按 updated_at DESC, id DESC 稳定分页
    -- --------------------------------------------------------
    SELECT string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC)
      INTO v_full
      FROM documents
     WHERE owner_id = c_user_c;

    IF v_full IS NULL OR v_full = '' THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [pagination full order]: empty result';
    END IF;

    SELECT string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC)
      INTO v_page1
      FROM (
          SELECT id, updated_at
            FROM documents
           WHERE owner_id = c_user_c
           ORDER BY updated_at DESC, id DESC
           LIMIT 2 OFFSET 0
      ) q;

    SELECT string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC)
      INTO v_page2
      FROM (
          SELECT id, updated_at
            FROM documents
           WHERE owner_id = c_user_c
           ORDER BY updated_at DESC, id DESC
           LIMIT 2 OFFSET 2
      ) q;

    IF v_page1 || ',' || v_page2 IS DISTINCT FROM v_full THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [pagination union]: full=%, page1=%, page2=%',
            v_full, v_page1, v_page2;
    END IF;

    SELECT string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC)
      INTO v_page1b
      FROM (
          SELECT id, updated_at
            FROM documents
           WHERE owner_id = c_user_c
           ORDER BY updated_at DESC, id DESC
           LIMIT 2 OFFSET 0
      ) q;
    IF v_page1b IS DISTINCT FROM v_page1 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [pagination stable]: first=%, second=%',
            v_page1, v_page1b;
    END IF;

    SELECT count(*) INTO v_count FROM documents WHERE owner_id = c_user_c;
    IF v_count <> 4 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [user filter C]: count=%, expected 4', v_count;
    END IF;
    SELECT count(*) INTO v_count FROM documents WHERE owner_id = c_user_b;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [user filter B]: count=%, expected 1', v_count;
    END IF;
    IF strpos(v_full, c_doc_b::text) <> 0 THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [user filter]: B document leaked into C list';
    END IF;
    RAISE NOTICE 'PASS [stable pagination and user filter]: full=%, page1=%, page2=%',
        v_full, v_page1, v_page2;

    -- --------------------------------------------------------
    -- M2-01 清理测试行并核对隔离 schema 前后行数
    -- --------------------------------------------------------
    DELETE FROM documents
     WHERE owner_id IN (c_user_a, c_user_b, c_user_c);
    DELETE FROM users
     WHERE id IN (c_user_a, c_user_b, c_user_c);

    SELECT count(*) INTO v_users_after FROM users;
    SELECT count(*) INTO v_docs_after FROM documents;
    RAISE NOTICE 'W4 after cleanup: users=%, documents=%', v_users_after, v_docs_after;

    IF v_users_after <> v_users_before OR v_docs_after <> v_docs_before THEN
        RAISE EXCEPTION 'W4 CHECK FAILED [row counts]: before users=%, documents=%; after users=%, documents=%',
            v_users_before, v_docs_before, v_users_after, v_docs_after;
    END IF;
    RAISE NOTICE 'PASS [row counts unchanged]: users=%, documents=%',
        v_users_after, v_docs_after;

    RAISE NOTICE 'ALL W4 REGRESSION CHECKS PASSED';
END
$w4$;

ROLLBACK;
