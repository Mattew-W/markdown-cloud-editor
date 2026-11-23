-- M2 W4 concurrency setup entry.
-- Creates the isolated schema, applies the frozen migration, then loads
-- setup.sql. The PowerShell runner drops the schema in a finally block.

\set ON_ERROR_STOP on
\pset pager off

SET client_encoding = 'UTF8';

\echo 'W4 concurrency: create isolated schema'
CREATE SCHEMA :"w4_schema";
SET search_path = :"w4_schema";

\echo 'W4 concurrency: apply frozen migration 0001_init.sql'
\ir ../../../0001_init.sql

\echo 'W4 concurrency: load fixtures'
\ir setup.sql

\echo 'W4 concurrency: setup DONE'
