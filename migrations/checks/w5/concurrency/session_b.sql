-- M2 W5 concurrency session B (M2-W5-02).
-- 每条语句自动提交，使另一会话能看到 barrier 行。
-- 顺序：arrived barrier -> 读取 version=1 -> read barrier -> CAS UPDATE
--       -> done barrier -> 提交后回读，记录败者观察到的最终版本/正文。
-- 固定 owner 与目标行，避免「同一行」前提含糊。

\set ON_ERROR_STOP on

SET client_encoding = 'UTF8';
SET search_path = :"w5_schema";

\echo 'W5 concurrency B: arrived'
INSERT INTO w5_barrier (session, phase) VALUES ('B', 'arrived');

\echo 'W5 concurrency B: wait for both arrived'
DO $wait_arrived$
DECLARE
    v_count integer;
    v_tries integer := 0;
BEGIN
    LOOP
        SELECT count(*) INTO v_count FROM w5_barrier WHERE phase = 'arrived';
        EXIT WHEN v_count >= 2;
        v_tries := v_tries + 1;
        IF v_tries > 2400 THEN
            RAISE EXCEPTION 'W5 concurrency B timeout waiting for arrived (count=%)', v_count;
        END IF;
        PERFORM pg_sleep(0.05);
    END LOOP;
END
$wait_arrived$;

\echo 'W5 concurrency B: read initial version'
INSERT INTO w5_attempts (session, initial_version, attempted_content, started_at)
SELECT 'B', version, 'winner-B', clock_timestamp()
  FROM documents
 WHERE id = 'b5555555-5555-4555-8555-555555555555'
   AND owner_id = 'a5555555-5555-4555-8555-555555555555';

\echo 'W5 concurrency B: wait for both read'
DO $wait_read$
DECLARE
    v_count integer;
    v_tries integer := 0;
BEGIN
    LOOP
        SELECT count(*) INTO v_count FROM w5_attempts WHERE initial_version IS NOT NULL;
        EXIT WHEN v_count >= 2;
        v_tries := v_tries + 1;
        IF v_tries > 2400 THEN
            RAISE EXCEPTION 'W5 concurrency B timeout waiting for read (count=%)', v_count;
        END IF;
        PERFORM pg_sleep(0.05);
    END LOOP;
END
$wait_read$;

\echo 'W5 concurrency B: CAS update'
DO $cas$
DECLARE
    v_initial integer;
    v_rows    integer;
    v_state   text;
    v_message text;
BEGIN
    SELECT initial_version INTO v_initial FROM w5_attempts WHERE session = 'B';

    BEGIN
        UPDATE documents
           SET title = 'W5 并发 B',
               content = 'winner-B',
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = 'b5555555-5555-4555-8555-555555555555'
           AND owner_id = 'a5555555-5555-4555-8555-555555555555'
           AND version = v_initial;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
        RAISE EXCEPTION 'W5 concurrency B CAS error: % (%)', v_state, v_message;
    END;

    UPDATE w5_attempts
       SET rows_affected = v_rows,
           finished_at = clock_timestamp()
     WHERE session = 'B';

    RAISE NOTICE 'W5 concurrency B: initial=%, rows_affected=%', v_initial, v_rows;
END
$cas$;

\echo 'W5 concurrency B: wait for both attempts'
DO $wait_done$
DECLARE
    v_count integer;
    v_tries integer := 0;
BEGIN
    LOOP
        SELECT count(*) INTO v_count FROM w5_attempts WHERE rows_affected IS NOT NULL;
        EXIT WHEN v_count >= 2;
        v_tries := v_tries + 1;
        IF v_tries > 2400 THEN
            RAISE EXCEPTION 'W5 concurrency B timeout waiting for attempts (count=%)', v_count;
        END IF;
        PERFORM pg_sleep(0.05);
    END LOOP;
END
$wait_done$;

\echo 'W5 concurrency B: read back after both attempts'
DO $readback$
DECLARE
    v_version integer;
    v_content text;
BEGIN
    SELECT version, content INTO v_version, v_content
      FROM documents
     WHERE id = 'b5555555-5555-4555-8555-555555555555';

    UPDATE w5_attempts
       SET readback_version = v_version,
           readback_content = v_content,
           readback_at = clock_timestamp()
     WHERE session = 'B';

    RAISE NOTICE 'W5 concurrency B: readback version=%, content=%', v_version, v_content;
END
$readback$;

\echo 'W5 concurrency B: result'
SELECT session, initial_version, rows_affected,
       readback_version, readback_content, started_at, finished_at, readback_at
  FROM w5_attempts
 WHERE session = 'B';
