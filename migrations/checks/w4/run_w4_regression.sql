-- ============================================================
-- M2 W4 · run_w4_regression.sql
-- 用途：创建唯一临时 schema，记录 public 行数，加载冻结迁移，
--       执行 W4 回归，核对 public 行数，最后删除临时 schema。
-- 用法（推荐用 run_w4_regression.ps1 生成唯一 schema 并清理）：
--   psql -X -v ON_ERROR_STOP=1 -d <练习库名> \
--        -v w4_schema=t_w4_manual \
--        -f migrations/checks/w4/run_w4_regression.sql
--
-- 注意：
--   * 只操作 :"w4_schema"；public 只读计数，不写入；
--   * 0001_init.sql 自带 BEGIN/COMMIT，不能包进外层事务；
--   * regression.sql 自带 BEGIN/ROLLBACK；
--   * 失败时 psql 退出，可能留下临时 schema；PS 入口负责兜底清理。
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

SET client_encoding = 'UTF8';

\echo 'W4 regression: create isolated schema'
CREATE SCHEMA :"w4_schema";
SET search_path = :"w4_schema";

\echo 'W4 regression: install public row-count helpers'
\ir public_counts.sql

\echo 'W4 regression: capture public counts before'
SELECT w4_capture_public_counts('before');

\echo 'W4 regression: apply frozen migration 0001_init.sql'
\ir ../../0001_init.sql

\echo 'W4 regression: run assertions'
\ir regression.sql

\echo 'W4 regression: capture public counts after'
SELECT w4_capture_public_counts('after');

\echo 'W4 regression: assert public counts unchanged'
SELECT w4_assert_public_counts();

\echo 'W4 regression: drop isolated schema'
RESET search_path;
DROP SCHEMA :"w4_schema" CASCADE;

\echo 'W4 regression: DONE'
