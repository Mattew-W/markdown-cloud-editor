-- M2 W5 concurrency setup entry.
-- Creates the isolated schema, applies the frozen migration, loads fixtures.
-- The PowerShell runner drops that schema in a finally block.

\set ON_ERROR_STOP on
\pset pager off

SET client_encoding = 'UTF8';

\echo 'W5 concurrency: create isolated schema'
CREATE SCHEMA :"w5_schema";
SET search_path = :"w5_schema";

\echo 'W5 concurrency: apply frozen migration 0001_init.sql'
\ir ../../../0001_init.sql

\echo 'W5 concurrency: load fixtures'
\ir setup.sql

\echo 'W5 concurrency: setup DONE'
