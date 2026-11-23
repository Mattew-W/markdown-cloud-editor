-- M2 W5 · 独立会话 CAS 验证（M2-W5-02）
-- 前置：setup.sql 与 session_a.sql / session_b.sql 已在同一 schema 内完成。
-- 本文件只读并断言，不修改数据。
--
-- 与 W4 的差别：W4 只断言 rows_affected = {1,0}；W5 额外记录并断言
--   1) 双方起跑时的 initial_version 都是 1（同一旧版本）；
--   2) 败方在双方尝试完成后回读，读到 version=2 与胜方正文；
--   3) 最终正文/版本只反映一次写入（败方 attempted_content 不在最终行）；
--   4) 败方回读发生在胜方 finished_at 之后（支持性证据；顺序由 done barrier 保证）。

\set ON_ERROR_STOP on

SET client_encoding = 'UTF8';
SET search_path = :"w5_schema";

DO $verify$
DECLARE
    v_rows            integer;
    v_initial_ok      integer;
    v_total           integer;
    v_winners         integer;
    v_losers          integer;
    v_winner_session  text;
    v_winner_content  text;
    v_winner_finished timestamptz;
    v_loser_session   text;
    v_loser_content   text;
    v_loser_readback_v integer;
    v_loser_readback_c text;
    v_loser_readback_t timestamptz;
    v_version         integer;
    v_content         text;
BEGIN
    SELECT count(*) INTO v_total FROM w5_attempts;
    IF v_total <> 2 THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [attempt rows]: %, expected 2', v_total;
    END IF;

    SELECT count(*) INTO v_initial_ok
      FROM w5_attempts
     WHERE initial_version = 1;
    IF v_initial_ok <> 2 THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [initial version]: %, expected 2 rows at version 1',
            v_initial_ok;
    END IF;

    SELECT count(*) INTO v_rows FROM w5_attempts WHERE rows_affected IS NULL;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [missing rows_affected]: %', v_rows;
    END IF;

    SELECT count(*) INTO v_winners FROM w5_attempts WHERE rows_affected = 1;
    SELECT count(*) INTO v_losers  FROM w5_attempts WHERE rows_affected = 0;
    IF v_winners <> 1 OR v_losers <> 1 THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [rows affected set]: winners=%, losers=%, expected 1/1',
            v_winners, v_losers;
    END IF;

    SELECT session, attempted_content, finished_at
      INTO v_winner_session, v_winner_content, v_winner_finished
      FROM w5_attempts
     WHERE rows_affected = 1;

    SELECT session, attempted_content, readback_version, readback_content, readback_at
      INTO v_loser_session, v_loser_content, v_loser_readback_v, v_loser_readback_c, v_loser_readback_t
      FROM w5_attempts
     WHERE rows_affected = 0;

    SELECT version, content INTO v_version, v_content
      FROM documents
     WHERE id = 'b5555555-5555-4555-8555-555555555555';

    -- 只有一次写入：version 从 1 推进到 2
    IF v_version IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [final version]: %, expected 2', v_version;
    END IF;

    IF v_content IS DISTINCT FROM v_winner_content THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [final content]: %, expected winner % content %',
            v_content, v_winner_session, v_winner_content;
    END IF;

    IF v_content IS NOT DISTINCT FROM v_loser_content THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [loser content landed]: final content equals loser % attempted content',
            v_loser_session;
    END IF;

    -- 败方归因：回读必须看到胜方版本 2 与胜方正文
    IF v_loser_readback_v IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [loser readback version]: %, expected 2',
            v_loser_readback_v;
    END IF;
    IF v_loser_readback_c IS DISTINCT FROM v_winner_content THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [loser readback content]: %, expected winner % content %',
            v_loser_readback_c, v_winner_session, v_winner_content;
    END IF;
    IF v_loser_readback_t IS NULL OR v_winner_finished IS NULL
       OR v_loser_readback_t < v_winner_finished THEN
        RAISE EXCEPTION 'W5 CONCURRENCY FAILED [readback ordering]: loser readback_at=%, winner finished_at=%',
            v_loser_readback_t, v_winner_finished;
    END IF;

    -- 时间戳仅为支持性证据；真正的先后顺序由 done barrier 保证。
    RAISE NOTICE 'PASS [independent-session CAS]: winner=%, loser=%, rows_affected={1,0}, final version=2, final content=%, loser readback=(v=%, content=%)',
        v_winner_session, v_loser_session, v_content, v_loser_readback_v, v_loser_readback_c;
    RAISE NOTICE 'NOTE: SQL-layer CAS only; HTTP 409 mapping is verified separately by M4/route tests';
END
$verify$;

\echo 'W5 concurrency attempts'
SELECT session, initial_version, rows_affected,
       readback_version, readback_content, started_at, finished_at, readback_at
  FROM w5_attempts
 ORDER BY session;
