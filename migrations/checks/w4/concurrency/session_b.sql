-- M2 W4 concurrency session B.
-- Each statement autocommits so the other session can see the barrier rows.
-- Both sessions read version=1, wait until both have read, then perform the
-- same CAS UPDATE; exactly one may affect one row.

\set ON_ERROR_STOP on

SET client_encoding = 'UTF8';
SET search_path = :"w4_schema";

\echo 'W4 concurrency B: arrived'
INSERT INTO w4_sessions (session, phase) VALUES ('B', 'arrived');

\echo 'W4 concurrency B: wait for both arrived'
DO $wait_arrived$
DECLARE
    v_count integer;
    v_tries integer := 0;
BEGIN
    LOOP
        SELECT count(*) INTO v_count FROM w4_sessions WHERE phase = 'arrived';
        EXIT WHEN v_count >= 2;
        v_tries := v_tries + 1;
        IF v_tries > 1200 THEN
            RAISE EXCEPTION 'W4 concurrency B timeout waiting for arrived (count=%)', v_count;
        END IF;
        PERFORM pg_sleep(0.05);
    END LOOP;
END
$wait_arrived$;

\echo 'W4 concurrency B: read initial version'
INSERT INTO w4_sessions (session, phase, initial_version, initial_content)
SELECT 'B', 'read', version, content
  FROM documents
 WHERE id = 'f4444444-4444-4444-8444-444444444444';

\echo 'W4 concurrency B: wait for both read'
DO $wait_read$
DECLARE
    v_count integer;
    v_tries integer := 0;
BEGIN
    LOOP
        SELECT count(*) INTO v_count FROM w4_sessions WHERE phase = 'read';
        EXIT WHEN v_count >= 2;
        v_tries := v_tries + 1;
        IF v_tries > 1200 THEN
            RAISE EXCEPTION 'W4 concurrency B timeout waiting for read (count=%)', v_count;
        END IF;
        PERFORM pg_sleep(0.05);
    END LOOP;
END
$wait_read$;

\echo 'W4 concurrency B: CAS update'
WITH upd AS (
    UPDATE documents
       SET title = 'W4 并发 B',
           content = 'winner-B',
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = 'f4444444-4444-4444-8444-444444444444'
       AND owner_id = 'e4444444-4444-4444-8444-444444444444'
       AND version = (
           SELECT initial_version
             FROM w4_sessions
            WHERE session = 'B' AND phase = 'read'
       )
    RETURNING version, content
)
INSERT INTO w4_results
    (session, rows_affected, attempted_content, final_version, final_content)
SELECT 'B', count(*), 'winner-B', max(version), max(content)
  FROM upd;

\echo 'W4 concurrency B: result'
SELECT session, phase, initial_version, initial_content
  FROM w4_sessions
 WHERE session = 'B'
 ORDER BY phase;

SELECT session, rows_affected, final_version, final_content
  FROM w4_results
 WHERE session = 'B';
