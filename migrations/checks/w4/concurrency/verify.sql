-- M2 W4 concurrency verifier.
-- Precondition: setup.sql and session_a.sql/session_b.sql have run in the same
-- isolated schema. This file only reads and asserts; it does not modify data.

\set ON_ERROR_STOP on

SET client_encoding = 'UTF8';
SET search_path = :"w4_schema";

DO $verify$
DECLARE
    v_count          integer;
    v_read_rows      integer;
    v_initial_rows   integer;
    v_winners        integer;
    v_losers         integer;
    v_result_rows    integer;
    v_winner_session text;
    v_winner_content text;
    v_version        integer;
    v_content        text;
BEGIN
    SELECT count(*) INTO v_read_rows
      FROM w4_sessions
     WHERE phase = 'read';
    IF v_read_rows <> 2 THEN
        RAISE EXCEPTION 'W4 CONCURRENCY FAILED [read rows]: %, expected 2', v_read_rows;
    END IF;

    SELECT count(*) INTO v_initial_rows
      FROM w4_sessions
     WHERE phase = 'read'
       AND initial_version = 1
       AND initial_content = 'v1';
    IF v_initial_rows <> 2 THEN
        RAISE EXCEPTION 'W4 CONCURRENCY FAILED [initial version/content]: %, expected 2 rows at version 1/v1',
            v_initial_rows;
    END IF;

    SELECT count(*) INTO v_result_rows FROM w4_results;
    IF v_result_rows <> 2 THEN
        RAISE EXCEPTION 'W4 CONCURRENCY FAILED [result rows]: %, expected 2', v_result_rows;
    END IF;

    SELECT count(*) INTO v_winners FROM w4_results WHERE rows_affected = 1;
    SELECT count(*) INTO v_losers  FROM w4_results WHERE rows_affected = 0;
    IF v_winners <> 1 OR v_losers <> 1 THEN
        RAISE EXCEPTION 'W4 CONCURRENCY FAILED [rows affected set]: winners=%, losers=%, expected 1/1',
            v_winners, v_losers;
    END IF;

    SELECT session, attempted_content
      INTO v_winner_session, v_winner_content
      FROM w4_results
     WHERE rows_affected = 1;

    SELECT version, content
      INTO v_version, v_content
      FROM documents
     WHERE id = 'f4444444-4444-4444-8444-444444444444';

    IF v_version IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'W4 CONCURRENCY FAILED [final version]: %, expected 2', v_version;
    END IF;
    IF v_content IS DISTINCT FROM v_winner_content THEN
        RAISE EXCEPTION 'W4 CONCURRENCY FAILED [final content]: %, expected winner % content %',
            v_content, v_winner_session, v_winner_content;
    END IF;

    -- ----------------------------------------------------------------
    -- 【M1 审计备注 2026-11-15】关于「败者归因」的鉴别力边界
    --
    -- 本文件断言「影响行数集合 = {1,0}」。经 M1 阶段定向变异实测：
    --   * 去掉**败者**（可能后执行的那一方）的 version 条件 → 立即检出（{1,1}）。
    --   * 去掉**赢家**的 version 条件 → 不检出，因赢家的 version 条件
    --     不参与「谁失败」的判定（赢家本来就该命中）。
    --   * 去掉 owner_id 条件 → 不检出，因 owner_id 与 version 是 AND 条件，
    --     去掉 owner 后 version 仍会拦住败者。
    -- 后两项属并发场景的固有局限：
    --   * CAS 的 version 条件语义由主回归 M2-03c 专门覆盖
    --     （旧版本 → 0 行且正文/版本不变）；
    --   * owner_id 条件由 M2-03b 专门覆盖（错误 owner → 0 行且不变）。
    -- 故此处不再追加额外断言，避免制造"看起来更严、实则无效"的复杂度。
    -- ----------------------------------------------------------------

    RAISE NOTICE 'PASS [two-session CAS]: winner=%, rows_affected={1,0}, initial version=1, final version=2, final content=%',
        v_winner_session, v_content;
END
$verify$;
