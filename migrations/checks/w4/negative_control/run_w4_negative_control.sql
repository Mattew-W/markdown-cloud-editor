-- ============================================================
-- M2 W4 · run_w4_negative_control.sql
-- 用途：负向对照。加载 negative_control/regression_wrong_expected.sql，
--       该副本故意把“有文档用户删除”的预期 SQLSTATE 从 23503 改成 23505。
-- 预期结果：实际 23503 与预期 23505 不符，脚本 RAISE 并以非零状态退出。
-- 这不是主回归，不应作为验收通过依据。
-- 用法：在项目根目录按 README 的负向对照命令执行；
--       推荐用 run_w4_regression.ps1 以便失败时也清理临时 schema。
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

SET client_encoding = 'UTF8';

\echo 'W4 regression: create isolated schema'
CREATE SCHEMA :"w4_schema";
SET search_path = :"w4_schema";

\echo 'W4 negative control: install public row-count helpers'
\ir ../public_counts.sql

\echo 'W4 negative control: capture public counts before'
SELECT w4_capture_public_counts('before');

\echo 'W4 negative control: apply frozen migration 0001_init.sql'
\ir ../../../0001_init.sql

\echo 'W4 negative control: run wrong-expected regression (expected failure)'
\ir regression_wrong_expected.sql

\echo 'W4 regression: capture public counts after'
SELECT w4_capture_public_counts('after');

\echo 'W4 regression: assert public counts unchanged'
SELECT w4_assert_public_counts();

\echo 'W4 regression: drop isolated schema'
RESET search_path;
DROP SCHEMA :"w4_schema" CASCADE;

\echo 'W4 regression: DONE'
