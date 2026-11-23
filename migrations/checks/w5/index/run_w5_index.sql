-- M2 W5 · run_w5_index.sql  (M2-W5-03 索引入口)
-- 用法：由 run_w5_regression.ps1 -Entry index\run_w5_index.sql 调用，
--       或直接 psql -X -v ON_ERROR_STOP=1 -d <库> -v w5_schema=t_w5_idx
--            -f migrations/checks/w5/index/run_w5_index.sql

\set ON_ERROR_STOP on
\pset pager off

SET client_encoding = 'UTF8';

\echo 'W5 index: create isolated schema'
CREATE SCHEMA :"w5_schema";
SET search_path = :"w5_schema";

\echo 'W5 index: apply frozen migration 0001_init.sql'
\ir ../../../0001_init.sql

\echo 'W5 index: run index and pagination checks'
\ir index_check.sql

\echo 'W5 index: drop isolated schema'
RESET search_path;
DROP SCHEMA :"w5_schema" CASCADE;

\echo 'W5 index: DONE'
