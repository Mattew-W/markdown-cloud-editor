-- ============================================================
-- M2 W5 · run_w5_negative_control.sql  (M2-W5-04 负向对照)
-- 用途：加载 constraints_wrong_expected.sql；该副本只把
--       "username duplicate" 的预期 SQLSTATE 从 23505 改成 23514。
-- 预期结果：实际 23505 与预期 23514 不符，w5_expect 抛异常，
--           psql 以非零状态退出，临时 schema 由 runner 清理。
-- 这不是主回归，不能作为通过依据。
-- ============================================================

\set ON_ERROR_STOP on
\pset pager off

SET client_encoding = 'UTF8';

\echo 'W5 negative control: create isolated schema'
CREATE SCHEMA :"w5_schema";
SET search_path = :"w5_schema";

\echo 'W5 negative control: install public row-count helpers (reuse W4)'
\ir ../../w4/public_counts.sql

\echo 'W5 negative control: capture public counts before'
SELECT w4_capture_public_counts('before');

\echo 'W5 negative control: apply frozen migration 0001_init.sql'
\ir ../../../0001_init.sql

\echo 'W5 negative control: run wrong-expected matrix (expected failure)'
\ir constraints_wrong_expected.sql

\echo 'W5 negative control: UNEXPECTED SUCCESS (this line should not be reached)'

RESET search_path;
DROP SCHEMA :"w5_schema" CASCADE;
