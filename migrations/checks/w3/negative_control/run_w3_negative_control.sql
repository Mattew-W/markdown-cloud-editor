-- ============================================================
-- M2 W3 · run_w3_negative_control.sql
-- 用途：负向对照。加载 negative_control/regression_wrong_expected.sql，
--       该副本把“不存在 owner”的预期 SQLSTATE 故意改成 23505。
-- 预期结果：实际 23503 与预期 23505 不符，脚本 RAISE 并以非零状态退出。
-- 这不是主回归，不应作为验收通过依据。
-- 用法：在项目根目录按 README.md 的“负向对照”命令执行；
--       推荐用 run_w3_regression.ps1 以便失败时也清理临时 schema。
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
\ir ../../../0001_init.sql

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

\echo 'W3 negative control: run wrong-expected regression (expected failure)'
\ir regression_wrong_expected.sql

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
