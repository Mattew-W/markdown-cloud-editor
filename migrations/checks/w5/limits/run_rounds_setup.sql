-- M2 W5 limited-concurrency setup entry.
-- Called once by run_w5_rounds.ps1 before the round loop.

\set ON_ERROR_STOP on
\pset pager off

SET client_encoding = 'UTF8';

\echo 'W5 rounds: create isolated schema'
CREATE SCHEMA :"w5_schema";
SET search_path = :"w5_schema";

\echo 'W5 rounds: apply frozen migration 0001_init.sql'
\ir ../../../0001_init.sql

\echo 'W5 rounds: load fixtures'
\ir rounds_setup.sql

\echo 'W5 rounds: setup DONE'
