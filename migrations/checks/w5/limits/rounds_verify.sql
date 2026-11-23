-- M2 W5 · 有限并发轮次汇总与断言（M2-W5-03）
-- 前置：run_rounds_setup.sql 与 N 轮 round_writer/round_reader 已完成。
-- 只读并断言；样本范围在 NOTICE 中写明，不从有限样本推断全局性能。

\set ON_ERROR_STOP on

SET client_encoding = 'UTF8';
SET search_path = :"w5_schema";

DO $w5v$
DECLARE
    v_rounds       integer;
    v_writers      integer;
    v_readers      integer;
    v_bad_writers  integer;
    v_bad_readers  integer;
    v_deadlocks    integer;
    v_timeouts     integer;
    v_version      integer;
    v_content      text;
    v_max_writer_ms numeric;
    v_max_reader_ms numeric;
    v_avg_writer_ms numeric;
    v_avg_reader_ms numeric;
BEGIN
    SELECT count(DISTINCT round_no) INTO v_rounds FROM w5_rounds;
    SELECT count(*) INTO v_writers FROM w5_rounds WHERE role = 'writer';
    SELECT count(*) INTO v_readers FROM w5_rounds WHERE role = 'reader';

    IF v_rounds = 0 THEN
        RAISE EXCEPTION 'W5 LIMITS FAILED [no rounds]';
    END IF;
    IF v_writers <> v_rounds OR v_readers <> v_rounds THEN
        RAISE EXCEPTION 'W5 LIMITS FAILED [role count]: rounds=%, writers=%, readers=%',
            v_rounds, v_writers, v_readers;
    END IF;

    SELECT count(*) INTO v_bad_writers
      FROM w5_rounds
     WHERE role = 'writer'
       AND (sqlstate <> '00000' OR rows_affected <> 1);
    IF v_bad_writers <> 0 THEN
        RAISE EXCEPTION 'W5 LIMITS FAILED [writer rounds]: %, expected 0', v_bad_writers;
    END IF;

    SELECT count(*) INTO v_bad_readers
      FROM w5_rounds
     WHERE role = 'reader'
       AND (sqlstate <> '00000' OR read_count <> 1);
    IF v_bad_readers <> 0 THEN
        RAISE EXCEPTION 'W5 LIMITS FAILED [reader rounds]: %, expected 0', v_bad_readers;
    END IF;

    SELECT count(*) INTO v_deadlocks FROM w5_rounds WHERE sqlstate = '40P01';
    SELECT count(*) INTO v_timeouts  FROM w5_rounds WHERE sqlstate = '57014';
    IF v_deadlocks <> 0 OR v_timeouts <> 0 THEN
        RAISE EXCEPTION 'W5 LIMITS FAILED [deadlock/timeout]: deadlocks=%, timeouts=%',
            v_deadlocks, v_timeouts;
    END IF;

    SELECT version, content INTO v_version, v_content
      FROM documents
     WHERE id = 'b7777777-7777-4777-8777-777777777777';

    IF v_version <> 1 + v_rounds THEN
        RAISE EXCEPTION 'W5 LIMITS FAILED [final version]: %, expected %',
            v_version, 1 + v_rounds;
    END IF;
    IF v_content <> 'round-' || v_rounds THEN
        RAISE EXCEPTION 'W5 LIMITS FAILED [final content]: %, expected round-%',
            v_content, v_rounds;
    END IF;

    SELECT max(round(extract(epoch FROM (finished_at - started_at)) * 1000, 3)),
           avg(round(extract(epoch FROM (finished_at - started_at)) * 1000, 3))
      INTO v_max_writer_ms, v_avg_writer_ms
      FROM w5_rounds WHERE role = 'writer';

    SELECT max(round(extract(epoch FROM (finished_at - started_at)) * 1000, 3)),
           avg(round(extract(epoch FROM (finished_at - started_at)) * 1000, 3))
      INTO v_max_reader_ms, v_avg_reader_ms
      FROM w5_rounds WHERE role = 'reader';

    RAISE NOTICE 'PASS [limited concurrency]: rounds=%, writers=% (rows=1 each), readers=% (rows=1 each)',
        v_rounds, v_writers, v_readers;
    RAISE NOTICE 'SAMPLE SCOPE: % rounds, 1 writer + 1 reader per round, single database, single host; deadlocks=%, timeouts=%', v_rounds, v_deadlocks, v_timeouts;
    RAISE NOTICE 'TIMING (ms, DB clock): writer max=%, avg=%; reader max=%, avg=%',
        v_max_writer_ms, v_avg_writer_ms, v_max_reader_ms, v_avg_reader_ms;
    RAISE NOTICE 'NOTE: 有限样本只描述本次观测，不推断全局吞吐、延迟上限或死锁概率';
    RAISE NOTICE 'ALL W5 LIMITED-CONCURRENCY CHECKS PASSED';
END
$w5v$;

\echo 'W5 rounds'
SELECT round_no, role, rows_affected, sqlstate, read_count,
       round(extract(epoch FROM (finished_at - started_at)) * 1000, 3) AS ms,
       observed_version
  FROM w5_rounds
 ORDER BY round_no, role;
