-- ============================================================
-- M2 W2 · verify_constraints.sql
-- 前置：schema.sql + fixtures.sql 已加载（同一事务）。
-- 用法：由 run_checks.sql 通过 \ir 加载；也可在夹具已加载后单独执行。
-- 事务：本文件不含 BEGIN/COMMIT。
--
-- 设计：
--   * 每条负例放在嵌套 BEGIN/EXCEPTION 子事务中；
--   * 捕获 SQLSTATE 并与预期比较；
--   * 若未报错（SQLSTATE 00000）或错误码不同，显式 RAISE EXCEPTION；
--   * 不使用 WHEN OTHERS THEN NULL 吞错。
-- ============================================================

SET client_encoding = 'UTF8';

DO $verify$
DECLARE
    v_state         text;
    v_message       text;
    v_users         integer;
    v_docs          integer;
    v_title_len     integer;
    v_content_bytes integer;
BEGIN
    -- --------------------------------------------------------
    -- 0. 夹具基线与测试数据自检
    -- --------------------------------------------------------
    SELECT count(*) INTO v_users FROM users;
    IF v_users <> 3 THEN
        RAISE EXCEPTION 'FIXTURE CHECK FAILED [users count]: expected 3, got %', v_users;
    END IF;

    SELECT count(*) INTO v_docs FROM documents;
    IF v_docs <> 6 THEN
        RAISE EXCEPTION 'FIXTURE CHECK FAILED [documents count]: expected 6, got %', v_docs;
    END IF;

    SELECT char_length(title) INTO v_title_len
      FROM documents
     WHERE id = 'a3333333-3333-4333-8333-333333333333';
    IF v_title_len IS DISTINCT FROM 255 THEN
        RAISE EXCEPTION 'FIXTURE CHECK FAILED [255-char title]: expected 255, got %', v_title_len;
    END IF;

    SELECT octet_length(content) INTO v_content_bytes
      FROM documents
     WHERE id = 'a6666666-6666-4666-8666-666666666666';
    IF v_content_bytes IS DISTINCT FROM 262144 THEN
        RAISE EXCEPTION 'FIXTURE CHECK FAILED [262144-byte content]: expected 262144, got %', v_content_bytes;
    END IF;

    -- 测试数据自身的字节数断言，防止把字符数当字节数
    v_content_bytes := octet_length(repeat('中', 87381) || 'a');
    IF v_content_bytes <> 262144 THEN
        RAISE EXCEPTION 'TEST DATA ERROR [262144]: expected 262144 bytes, got %', v_content_bytes;
    END IF;

    v_content_bytes := octet_length(repeat('中', 87381) || 'ab');
    IF v_content_bytes <> 262145 THEN
        RAISE EXCEPTION 'TEST DATA ERROR [262145]: expected 262145 bytes, got %', v_content_bytes;
    END IF;

    -- --------------------------------------------------------
    -- 1. 重复 username -> 23505
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO users (username, password_hash)
        VALUES ('alice', 'DB_TEST_ONLY_FAKE_HASH_DUPLICATE');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [duplicate username]: INSERT succeeded; expected SQLSTATE 23505';
    ELSIF v_state <> '23505' THEN
        RAISE EXCEPTION 'CHECK FAILED [duplicate username]: expected 23505, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [duplicate username]: SQLSTATE 23505';

    -- --------------------------------------------------------
    -- 2. 不存在的合法 UUID owner -> 23503
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('99999999-9999-4999-8999-999999999999', '不存在的所有者', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [nonexistent owner]: INSERT succeeded; expected SQLSTATE 23503';
    ELSIF v_state <> '23503' THEN
        RAISE EXCEPTION 'CHECK FAILED [nonexistent owner]: expected 23503, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [nonexistent owner]: SQLSTATE 23503';

    -- --------------------------------------------------------
    -- 3. version = 0 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content, version)
        VALUES ('11111111-1111-4111-8111-111111111111', '版本零测试', '正文', 0);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [version = 0]: INSERT succeeded; expected SQLSTATE 23514';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'CHECK FAILED [version = 0]: expected 23514, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [version = 0]: SQLSTATE 23514';

    -- --------------------------------------------------------
    -- 4. version = -1 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content, version)
        VALUES ('11111111-1111-4111-8111-111111111111', '版本负数测试', '正文', -1);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [version = -1]: INSERT succeeded; expected SQLSTATE 23514';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'CHECK FAILED [version = -1]: expected 23514, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [version = -1]: SQLSTATE 23514';

    -- --------------------------------------------------------
    -- 5. 正文 262145 字节 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES (
            '11111111-1111-4111-8111-111111111111',
            '正文超限测试',
            repeat('中', 87381) || 'ab'
        );
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [content 262145 bytes]: INSERT succeeded; expected SQLSTATE 23514';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'CHECK FAILED [content 262145 bytes]: expected 23514, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [content 262145 bytes]: SQLSTATE 23514';

    -- --------------------------------------------------------
    -- 6. 空标题 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('11111111-1111-4111-8111-111111111111', '', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [empty title]: INSERT succeeded; expected SQLSTATE 23514';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'CHECK FAILED [empty title]: expected 23514, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [empty title]: SQLSTATE 23514';

    -- --------------------------------------------------------
    -- 7. 普通空格标题 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('11111111-1111-4111-8111-111111111111', '   ', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [spaces-only title]: INSERT succeeded; expected SQLSTATE 23514';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'CHECK FAILED [spaces-only title]: expected 23514, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [spaces-only title]: SQLSTATE 23514';

    -- --------------------------------------------------------
    -- 8. 全角空格标题 -> 23514
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('11111111-1111-4111-8111-111111111111', U&'\3000\3000', '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [ideographic-space title]: INSERT succeeded; expected SQLSTATE 23514';
    ELSIF v_state <> '23514' THEN
        RAISE EXCEPTION 'CHECK FAILED [ideographic-space title]: expected 23514, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [ideographic-space title]: SQLSTATE 23514';

    -- --------------------------------------------------------
    -- 9. 标题 256 字符 -> 22001（VARCHAR(255) 长度错误，不是 CHECK）
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (owner_id, title, content)
        VALUES ('11111111-1111-4111-8111-111111111111', repeat('a', 256), '正文');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state = '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [title 256 chars]: INSERT succeeded; expected SQLSTATE 22001';
    ELSIF v_state <> '22001' THEN
        RAISE EXCEPTION 'CHECK FAILED [title 256 chars]: expected 22001, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [title 256 chars]: SQLSTATE 22001';

    -- --------------------------------------------------------
    -- 10. 合法边界：255 字符标题必须插入成功
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (id, owner_id, title, content, version)
        VALUES (
            'b2222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            repeat('b', 255),
            '合法标题边界',
            1
        );
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state <> '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [legal 255-char title]: expected success, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [legal 255-char title]: INSERT succeeded';
    DELETE FROM documents WHERE id = 'b2222222-2222-4222-8222-222222222222';

    -- --------------------------------------------------------
    -- 11. 合法边界：262144 字节正文必须插入成功
    -- --------------------------------------------------------
    v_state := '00000';
    v_message := NULL;
    BEGIN
        INSERT INTO documents (id, owner_id, title, content, version)
        VALUES (
            'b1111111-1111-4111-8111-111111111111',
            '11111111-1111-4111-8111-111111111111',
            '合法正文字节边界',
            repeat('中', 87381) || 'a',
            1
        );
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            v_state = RETURNED_SQLSTATE,
            v_message = MESSAGE_TEXT;
    END;

    IF v_state <> '00000' THEN
        RAISE EXCEPTION 'CHECK FAILED [legal 262144-byte content]: expected success, got % (%)', v_state, v_message;
    END IF;
    RAISE NOTICE 'PASS [legal 262144-byte content]: INSERT succeeded';
    DELETE FROM documents WHERE id = 'b1111111-1111-4111-8111-111111111111';

    RAISE NOTICE 'ALL CONSTRAINT CHECKS PASSED';
END
$verify$;
