-- ============================================================
-- M2 W2 · fixtures.sql
-- 用途：为 users / documents 的约束验证提供固定夹具。
-- 范围：仅独立练习库；本夹具不参与登录。
-- 前置：schema.sql 已执行。
-- 事务：本文件不含 BEGIN/COMMIT，由 run_checks.sql 统一包裹。
-- ============================================================

SET client_encoding = 'UTF8';

-- ------------------------------------------------------------
-- 固定 UUID 清单
--
-- 用户：
--   alice   11111111-1111-4111-8111-111111111111
--   bob     22222222-2222-4222-8222-222222222222
--   charlie 33333333-3333-4333-8333-333333333333
--
-- 文档：
--   d1 a1111111-1111-4111-8111-111111111111  alice   中文正文
--   d2 a2222222-2222-4222-8222-222222222222  alice   英文正文
--   d3 a3333333-3333-4333-8333-333333333333  bob     255 字符标题边界
--   d4 a4444444-4444-4444-8444-444444444444  bob     空正文
--   d5 a5555555-5555-4555-8555-555555555555  charlie 普通多段 Markdown
--   d6 a6666666-6666-4666-8666-666666666666  charlie 262144 字节正文边界
--
-- 预留的“不存在”合法 UUID（仅用于外键负例，不插入）：
--   99999999-9999-4999-8999-999999999999
--
-- 假哈希说明：以下 password_hash 是明确标注的数据库测试假值，
-- 不是有效 Argon2 哈希，不能用于登录，也不代表真实用户密码。
-- ------------------------------------------------------------

INSERT INTO users (id, username, password_hash, created_at)
VALUES
    ('11111111-1111-4111-8111-111111111111',
     'alice',
     'DB_TEST_ONLY_FAKE_HASH_ALICE_NOT_ARGON2',
     TIMESTAMPTZ '2026-10-25 08:00:00+00'),
    ('22222222-2222-4222-8222-222222222222',
     'bob',
     'DB_TEST_ONLY_FAKE_HASH_BOB_NOT_ARGON2',
     TIMESTAMPTZ '2026-10-25 08:05:00+00'),
    ('33333333-3333-4333-8333-333333333333',
     'charlie',
     'DB_TEST_ONLY_FAKE_HASH_CHARLIE_NOT_ARGON2',
     TIMESTAMPTZ '2026-10-25 08:10:00+00');

-- d1：中文正文
INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
VALUES (
    'a1111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    '中文笔记',
    $md$# 中文笔记

这是中文正文，包含多字节字符。$md$,
    1,
    TIMESTAMPTZ '2026-10-25 09:00:00+00',
    TIMESTAMPTZ '2026-10-25 09:00:00+00'
);

-- d2：英文正文
INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
VALUES (
    'a2222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'English Note',
    $md$# English Note

This is an English paragraph with multiple sentences. It verifies that ASCII content is stored unchanged.$md$,
    1,
    TIMESTAMPTZ '2026-10-25 09:05:00+00',
    TIMESTAMPTZ '2026-10-25 09:05:00+00'
);

-- d3：255 字符标题边界（repeat 生成 255 个 ASCII 字符）
INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
VALUES (
    'a3333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222',
    repeat('a', 255),
    '标题边界测试正文。',
    1,
    TIMESTAMPTZ '2026-10-25 09:10:00+00',
    TIMESTAMPTZ '2026-10-25 09:10:00+00'
);

-- d4：空正文（允许空字符串）
INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
VALUES (
    'a4444444-4444-4444-8444-444444444444',
    '22222222-2222-4222-8222-222222222222',
    '空正文',
    '',
    1,
    TIMESTAMPTZ '2026-10-25 09:15:00+00',
    TIMESTAMPTZ '2026-10-25 09:15:00+00'
);

-- d5：普通多段 Markdown
INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
VALUES (
    'a5555555-5555-4555-8555-555555555555',
    '33333333-3333-4333-8333-333333333333',
    '多段 Markdown',
    $md$# 多段 Markdown

第一段内容。

第二段内容，包含 **粗体** 和 `代码`。

- 列表项一
- 列表项二$md$,
    1,
    TIMESTAMPTZ '2026-10-25 09:20:00+00',
    TIMESTAMPTZ '2026-10-25 09:20:00+00'
);

-- d6：262144 字节正文边界（UTF-8 多字节）
-- repeat('中', 87381) = 87381 * 3 = 262143 字节，再加 ASCII 'a' 共 262144 字节。
INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at)
VALUES (
    'a6666666-6666-4666-8666-666666666666',
    '33333333-3333-4333-8333-333333333333',
    '262144 字节正文',
    repeat('中', 87381) || 'a',
    1,
    TIMESTAMPTZ '2026-10-25 09:25:00+00',
    TIMESTAMPTZ '2026-10-25 09:25:00+00'
);
