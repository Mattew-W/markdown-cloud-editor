-- M2 W5 · 有限并发第 N 轮：写会话（M2-W5-03）
-- 调用时由 psql 传入 -v round_no=N。
-- 记录：起止时间、影响行数、SQLSTATE、写入内容。

\set ON_ERROR_STOP on

SET client_encoding = 'UTF8';
SET search_path = :"w5_schema";
SET w5.round_no = :'round_no';

DO $w5w$
DECLARE
    v_round   integer := current_setting('w5.round_no')::int;
    v_initial integer;
    v_rows    integer;
    v_start   timestamptz := clock_timestamp();
    v_end     timestamptz;
    v_state   text;
    v_message text;
BEGIN
    SELECT version INTO v_initial
      FROM documents
     WHERE id = 'b7777777-7777-4777-8777-777777777777'
       AND owner_id = 'a7777777-7777-4777-8777-777777777777';

    BEGIN
        UPDATE documents
           SET title = 'W5 轮次 ' || v_round,
               content = 'round-' || v_round,
               version = version + 1,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = 'b7777777-7777-4777-8777-777777777777'
           AND owner_id = 'a7777777-7777-4777-8777-777777777777'
           AND version = v_initial;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
        v_rows := -1;
    END;

    v_end := clock_timestamp();

    INSERT INTO w5_rounds
        (round_no, role, rows_affected, sqlstate, started_at, finished_at,
         observed_version, observed_content, read_count)
    VALUES
        (v_round, 'writer', v_rows, COALESCE(v_state, '00000'), v_start, v_end,
         v_initial, 'round-' || v_round, NULL);

    RAISE NOTICE 'W5 round % writer: initial=%, rows=%, sqlstate=%, ms=%',
        v_round, v_initial, v_rows, COALESCE(v_state, '00000'),
        round(extract(epoch FROM (v_end - v_start)) * 1000, 3);
END
$w5w$;
