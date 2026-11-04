-- ============================================================
-- M2 W2 · run_checks.sql
-- 用途：加载夹具并执行约束验证；结束后回滚，不留下测试数据。
-- 前置：schema.sql 已在独立空练习库中单独执行。
-- 用法：psql -X -v ON_ERROR_STOP=1 -d <练习库名> -f run_checks.sql
--
-- 说明：
--   * \ir 相对于本文件所在目录解析 fixtures.sql / verify_constraints.sql；
--   * BEGIN/ROLLBACK 包住夹具和检查；成功时回滚夹具；
--   * 任一语句失败时 ON_ERROR_STOP 让 psql 退出，未提交事务随连接关闭回滚；
--   * schema.sql 自带事务，必须在首次单独执行，不放进本文件。
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

\echo 'M2_W2 run_checks: BEGIN'
BEGIN;

\echo 'M2_W2 run_checks: loading fixtures.sql'
\ir fixtures.sql

\echo 'M2_W2 run_checks: running verify_constraints.sql'
\ir verify_constraints.sql

\echo 'M2_W2 run_checks: ROLLBACK (discard fixtures)'
ROLLBACK;

\echo 'M2_W2 run_checks: DONE'
