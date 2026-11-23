-- M2 W5 · index_check.sql  (M2-W5-03 索引部分)
-- 前置：run_w5_index.sql 已建 schema、SET search_path、加载 0001_init.sql。
-- 目的：
--   1) 核对契约要求的索引定义（owner_id, updated_at DESC, id DESC）；
--   2) 用固定 200 行样本核对列表查询口径与分页稳定性；
--   3) 记录 EXPLAIN 实际计划，但不把小样本计划当作全局性能结论。
-- 事务：本文件自行 BEGIN/ROLLBACK。

SET client_encoding = 'UTF8';

BEGIN;

CREATE TABLE w5_index_report (
    item  text NOT NULL,
    value text
);

DO $w5idx$
DECLARE
    v_indexdef text;
    v_count    bigint;
    v_full     text;
    v_pages    text;
    v_page     text;
    v_page_b   text;
    p          integer;
    r          record;

    c_owner constant uuid := 'a6666666-6666-4666-8666-666666666666'::uuid;
BEGIN
    -- 0. 索引定义
    SELECT indexdef INTO v_indexdef
      FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname = 'documents_owner_updated_idx';

    IF v_indexdef IS NULL THEN
        RAISE EXCEPTION 'W5 INDEX FAILED [missing]: documents_owner_updated_idx';
    END IF;
    IF v_indexdef NOT LIKE '%owner_id%'
       OR v_indexdef NOT LIKE '%updated_at DESC%'
       OR v_indexdef NOT LIKE '%id DESC%' THEN
        RAISE EXCEPTION 'W5 INDEX FAILED [definition]: %', v_indexdef;
    END IF;

    INSERT INTO w5_index_report (item, value)
    VALUES ('indexdef', v_indexdef);
    RAISE NOTICE 'PASS [index definition]: %', v_indexdef;

    -- 1. 固定样本：1 个 owner，200 篇文档，updated_at 只有 5 个取值（大量并列）
    INSERT INTO users (id, username, password_hash, created_at)
    VALUES (c_owner, 'w5_idx', 'DB_TEST_ONLY_FAKE_HASH_W5_IDX_NOT_ARGON2',
            TIMESTAMPTZ '2026-11-16 00:00:00+00');

    INSERT INTO documents (owner_id, title, content, version, created_at, updated_at)
    SELECT c_owner,
           'idx-' || g,
           'c',
           1,
           TIMESTAMPTZ '2026-11-16 00:00:00+00',
           TIMESTAMPTZ '2026-11-16 00:00:00+00' + ((g % 5) || ' seconds')::interval
      FROM generate_series(1, 200) AS g;

    SELECT count(*) INTO v_count FROM documents WHERE owner_id = c_owner;
    IF v_count <> 200 THEN
        RAISE EXCEPTION 'W5 INDEX FAILED [sample size]: %, expected 200', v_count;
    END IF;
    INSERT INTO w5_index_report (item, value) VALUES ('sample_rows', v_count::text);

    SELECT count(DISTINCT updated_at) INTO v_count FROM documents WHERE owner_id = c_owner;
    INSERT INTO w5_index_report (item, value) VALUES ('distinct_updated_at', v_count::text);
    IF v_count <> 5 THEN
        RAISE EXCEPTION 'W5 INDEX FAILED [tie setup]: distinct updated_at=%, expected 5', v_count;
    END IF;

    -- 2. 全量顺序
    SELECT string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC)
      INTO v_full
      FROM documents
     WHERE owner_id = c_owner;

    -- 3. 10 页 x 20 行，拼接后必须等于全量顺序（无重复、无遗漏）
    v_pages := '';
    FOR p IN 0..9 LOOP
        SELECT string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC)
          INTO v_page
          FROM (
              SELECT id, updated_at
                FROM documents
               WHERE owner_id = c_owner
               ORDER BY updated_at DESC, id DESC
               LIMIT 20 OFFSET p * 20
          ) q;

        IF v_page IS NULL THEN
            RAISE EXCEPTION 'W5 INDEX FAILED [page empty]: offset=%', p * 20;
        END IF;

        v_pages := CASE WHEN v_pages = '' THEN v_page ELSE v_pages || ',' || v_page END;
    END LOOP;

    IF v_pages IS DISTINCT FROM v_full THEN
        RAISE EXCEPTION 'W5 INDEX FAILED [pagination union]: pages differ from full order';
    END IF;

    -- 4. 同一页重复查询必须一致
    SELECT string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC)
      INTO v_page
      FROM (
          SELECT id, updated_at FROM documents
           WHERE owner_id = c_owner
           ORDER BY updated_at DESC, id DESC
           LIMIT 20 OFFSET 0
      ) q;
    SELECT string_agg(id::text, ',' ORDER BY updated_at DESC, id DESC)
      INTO v_page_b
      FROM (
          SELECT id, updated_at FROM documents
           WHERE owner_id = c_owner
           ORDER BY updated_at DESC, id DESC
           LIMIT 20 OFFSET 0
      ) q;
    IF v_page_b IS DISTINCT FROM v_page THEN
        RAISE EXCEPTION 'W5 INDEX FAILED [unstable page]: first and second differ';
    END IF;

    INSERT INTO w5_index_report (item, value) VALUES ('pages_checked', '10');
    INSERT INTO w5_index_report (item, value) VALUES ('page_size', '20');
    RAISE NOTICE 'PASS [stable pagination over 200 rows / 5 tied timestamps / 10 pages]';

    -- 5. EXPLAIN 记录：只记录，不断言索引扫描。
    FOR r IN EXECUTE format(
        'EXPLAIN (FORMAT TEXT) SELECT id, owner_id, title, version, created_at, updated_at '
        'FROM documents WHERE owner_id = %L ORDER BY updated_at DESC, id DESC LIMIT 20 OFFSET 0',
        c_owner)
    LOOP
        INSERT INTO w5_index_report (item, value) VALUES ('plan', r."QUERY PLAN");
    END LOOP;

    INSERT INTO w5_index_report (item, value)
    SELECT 'plan_contains_index_scan',
           CASE WHEN EXISTS (SELECT 1 FROM w5_index_report
                              WHERE item = 'plan' AND value LIKE '%Index Scan%')
                THEN 'true' ELSE 'false' END;

    INSERT INTO w5_index_report (item, value)
    SELECT 'plan_contains_seq_scan',
           CASE WHEN EXISTS (SELECT 1 FROM w5_index_report
                              WHERE item = 'plan' AND value LIKE '%Seq Scan%')
                THEN 'true' ELSE 'false' END;

    RAISE NOTICE 'NOTE: 200-row sample plan is recorded for observation only; it does not prove global index effectiveness';
    RAISE NOTICE 'ALL W5 INDEX CHECKS PASSED';
END
$w5idx$;

\echo 'W5 index report'
SELECT item, value FROM w5_index_report ORDER BY item, value;

ROLLBACK;
