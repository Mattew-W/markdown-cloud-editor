-- ============================================================
-- M2 W3 · run_w3_regression.sql
-- 用途：创建一个隔离 schema，加载冻结迁移 0001_init.sql，
--       执行 regression.sql，最后删除隔离 schema。
-- 用法（推荐用 run_w3_regression.ps1 自动生成 schema 名并清理）：
--   psql -X -v ON_ERROR_STOP=1 -d <练习库名> \
--        -v w3_schema=t_w3_manual \
--        -f migrations/checks/w3/run_w3_regression.sql
--
-- 注意：
--   * 只操作 :"w3_schema" 指向的临时 schema，不写 public；
--   * 0001_init.sql 自带 BEGIN/COMMIT，因此不能把它包进外层事务；
--   * regression.sql 自带 BEGIN/ROLLBACK，夹具和检查数据最终回滚；
--   * 失败时 psql 退出，可能留下临时 schema；用 PS 入口或
--     migrations/cleanup_test_schemas.sql（t_% 前缀）清理。
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

SET client_encoding = 'UTF8';

\echo 'W3 regression: create isolated schema'
CREATE SCHEMA :"w3_schema";
SET search_path = :"w3_schema";

\echo 'W3 regression: current_schema'
SELECT current_schema() AS current_schema;

\echo 'W3 regression: apply frozen migration 0001_init.sql'
\ir ../../0001_init.sql

\echo 'W3 regression: pre-check empty isolated schema'
DO $pre$
DECLARE
    v_schema text;
    v_users  bigint;
    v_docs   bigint;
BEGIN
    SELECT current_schema() INTO v_schema;
    IF v_schema IS NULL OR v_schema = 'public' THEN
        RAISE EXCEPTION 'W3 SETUP FAILED: current_schema=%, expected isolated schema', v_schema;
    END IF;

    SELECT count(*) INTO v_users FROM users;
    SELECT count(*) INTO v_docs FROM documents;
    IF v_users <> 0 OR v_docs <> 0 THEN
        RAISE EXCEPTION 'W3 SETUP FAILED: isolated schema is not empty (users=%, documents=%)',
            v_users, v_docs;
    END IF;
    RAISE NOTICE 'PASS [pre-check empty schema]: schema=%, users=0, documents=0', v_schema;
END
$pre$;

\echo 'W3 regression: run assertions'
\ir regression.sql

\echo 'W3 regression: post-rollback counts'
DO $post$
DECLARE
    v_users bigint;
    v_docs  bigint;
BEGIN
    SELECT count(*) INTO v_users FROM users;
    SELECT count(*) INTO v_docs FROM documents;
    IF v_users <> 0 OR v_docs <> 0 THEN
        RAISE EXCEPTION 'W3 POST-ROLLBACK CHECK FAILED: users=%, documents=%', v_users, v_docs;
    END IF;
    RAISE NOTICE 'PASS [post-rollback counts]: users=0, documents=0';
END
$post$;

\echo 'W3 regression: drop isolated schema'
RESET search_path;
DROP SCHEMA :"w3_schema" CASCADE;

\echo 'W3 regression: DONE'
