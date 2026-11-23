-- ============================================================
-- M2 W5 · run_w5_regression.sql  (M2-W5-01)
-- 入口：建唯一临时 schema -> 记录 public 行数 -> 加载冻结迁移 ->
--       执行 W5 约束矩阵 -> 复核 public 行数 -> 删除本 schema -> 报告残留。
-- 用法（推荐用 run_w5_regression.ps1 生成唯一 schema 并清理）：
--   psql -X -v ON_ERROR_STOP=1 -d <练习库名> \
--        -v w5_schema=t_w5_manual \
--        -f migrations/checks/w5/run_w5_regression.sql
--
-- 说明：
--   * 只操作 :"w5_schema"；public 只读计数；
--   * 0001_init.sql 自带 BEGIN/COMMIT，不能包进外层事务；
--   * constraints.sql 自带 BEGIN/ROLLBACK；
--   * 表存在性检查复用 w4/public_counts.sql 的 to_regclass + EXECUTE，
--     不使用 CASE 分支直接引用可能不存在的表。
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

SET client_encoding = 'UTF8';

\echo 'W5 regression: create isolated schema'
CREATE SCHEMA :"w5_schema";
SET search_path = :"w5_schema";

\echo 'W5 regression: install public row-count helpers (reuse W4)'
\ir ../w4/public_counts.sql

\echo 'W5 regression: capture public counts before'
SELECT w4_capture_public_counts('before');

\echo 'W5 regression: apply frozen migration 0001_init.sql'
\ir ../../0001_init.sql

\echo 'W5 regression: run constraint matrix'
\ir constraints.sql

\echo 'W5 regression: capture public counts after'
SELECT w4_capture_public_counts('after');

\echo 'W5 regression: assert public counts unchanged'
SELECT w4_assert_public_counts();

\echo 'W5 regression: drop isolated schema'
RESET search_path;
DROP SCHEMA :"w5_schema" CASCADE;

\echo 'W5 regression: residual schema check (this run)'
SELECT count(*) AS residual_this_schema
  FROM pg_namespace
 WHERE nspname = :'w5_schema';

\echo 'W5 regression: residual t_w5_* schemas in database'
SELECT count(*) AS residual_t_w5_schemas
  FROM pg_namespace
 WHERE nspname LIKE 't\_w5\_%';

\echo 'W5 regression: DONE'
