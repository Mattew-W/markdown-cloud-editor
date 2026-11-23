-- M2 W5 · 有限并发第 N 轮：读会话（M2-W5-03）
-- 调用时由 psql 传入 -v round_no=N。
-- 记录：列表查询返回行数、读到的版本、起止时间、SQLSTATE。

\set ON_ERROR_STOP on

SET client_encoding = 'UTF8';
SET search_path = :"w5_schema";
SET w5.round_no = :'round_no';

DO $w5r$
DECLARE
    v_round       integer := current_setting('w5.round_no')::int;
    v_version     integer;
    v_read_count  integer;
    v_start       timestamptz := clock_timestamp();
    v_end         timestamptz;
    v_state       text;
    v_message     text;
BEGIN
    BEGIN
        SELECT count(*) INTO v_read_count
          FROM (
              SELECT id
                FROM documents
               WHERE owner_id = 'a7777777-7777-4777-8777-777777777777'
               ORDER BY updated_at DESC, id DESC
               LIMIT 20 OFFSET 0
          ) q;

        SELECT version INTO v_version
          FROM documents
         WHERE id = 'b7777777-7777-4777-8777-777777777777';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
        v_read_count := -1;
    END;

    v_end := clock_timestamp();

    INSERT INTO w5_rounds
        (round_no, role, rows_affected, sqlstate, started_at, finished_at,
         observed_version, observed_content, read_count)
    VALUES
        (v_round, 'reader', NULL, COALESCE(v_state, '00000'), v_start, v_end,
         v_version, NULL, v_read_count);

    RAISE NOTICE 'W5 round % reader: read_count=%, observed_version=%, sqlstate=%, ms=%',
        v_round, v_read_count, v_version, COALESCE(v_state, '00000'),
        round(extract(epoch FROM (v_end - v_start)) * 1000, 3);
END
$w5r$;
