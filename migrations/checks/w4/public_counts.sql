-- ============================================================
-- M2 W4 · public_counts.sql
-- 用途：在隔离 schema 中记录 public.users / public.documents 的运行前后行数。
--
-- 关键点：
--   * 用 to_regclass('public.users') 判断表是否存在；
--   * 只有存在时才 EXECUTE 动态 COUNT；
--   * 不写 CASE WHEN to_regclass(...) IS NOT NULL
--         THEN (SELECT count(*) FROM public.users) ELSE 0 END，
--     因为 PostgreSQL 在解析阶段就会解析 CASE 分支里的表引用，
--     表不存在时仍会报错，CASE 不能规避解析。
-- ============================================================

CREATE TABLE IF NOT EXISTS w4_public_counts (
    phase                  text PRIMARY KEY,
    users_table_exists     boolean NOT NULL,
    documents_table_exists boolean NOT NULL,
    users_count            bigint,
    documents_count        bigint
);

CREATE OR REPLACE FUNCTION w4_capture_public_counts(p_phase text)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_users_reg regclass;
    v_docs_reg  regclass;
    v_users     bigint;
    v_docs      bigint;
BEGIN
    v_users_reg := to_regclass('public.users');
    v_docs_reg  := to_regclass('public.documents');

    IF v_users_reg IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM public.users' INTO v_users;
    END IF;
    IF v_docs_reg IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM public.documents' INTO v_docs;
    END IF;

    INSERT INTO w4_public_counts
        (phase, users_table_exists, documents_table_exists, users_count, documents_count)
    VALUES
        (p_phase, v_users_reg IS NOT NULL, v_docs_reg IS NOT NULL, v_users, v_docs)
    ON CONFLICT (phase) DO UPDATE
       SET users_table_exists     = EXCLUDED.users_table_exists,
           documents_table_exists = EXCLUDED.documents_table_exists,
           users_count            = EXCLUDED.users_count,
           documents_count        = EXCLUDED.documents_count;
END
$fn$;

CREATE OR REPLACE FUNCTION w4_assert_public_counts()
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
    b w4_public_counts%ROWTYPE;
    a w4_public_counts%ROWTYPE;
BEGIN
    IF (SELECT count(*) FROM w4_public_counts WHERE phase IN ('before', 'after')) <> 2 THEN
        RAISE EXCEPTION 'W4 PUBLIC COUNT CHECK FAILED: before/after rows missing';
    END IF;

    SELECT * INTO b FROM w4_public_counts WHERE phase = 'before';
    SELECT * INTO a FROM w4_public_counts WHERE phase = 'after';

    IF b.users_table_exists <> a.users_table_exists
       OR b.documents_table_exists <> a.documents_table_exists
       OR b.users_count IS DISTINCT FROM a.users_count
       OR b.documents_count IS DISTINCT FROM a.documents_count THEN
        RAISE EXCEPTION
            'W4 PUBLIC COUNT CHECK FAILED: before users(table=%,count=%) documents(table=%,count=%); after users(table=%,count=%) documents(table=%,count=%)',
            b.users_table_exists, b.users_count,
            b.documents_table_exists, b.documents_count,
            a.users_table_exists, a.users_count,
            a.documents_table_exists, a.documents_count;
    END IF;

    RAISE NOTICE 'PASS [public counts unchanged]: users_table=%, users_count=%, documents_table=%, documents_count=%',
        a.users_table_exists, a.users_count, a.documents_table_exists, a.documents_count;
END
$fn$;
