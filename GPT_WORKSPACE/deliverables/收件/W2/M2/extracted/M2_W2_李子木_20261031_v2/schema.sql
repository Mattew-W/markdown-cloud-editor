-- ============================================================
-- 0001_init.sql —— users / documents 建表
--
-- 来源：M2_W1 交件 `schema-draft.sql`（李子木，2026-10-25）
-- 本文件由 M1 迁入为正式迁移，内容与组员草稿一致，仅作下列**规范性调整**：
--   1. 去掉草稿状态标注，补齐迁移文件头；
--   2. 标题非空检查由 `btrim` 改为覆盖 Unicode 空白（见下方说明）；
--   3. 用户名字符集与规范 §06 对齐。
--
-- 目标数据库：PostgreSQL 17（`gen_random_uuid()` 需 13 版以上）
-- 规范依据：§07 数据库结构、§06 字段约束
--
-- 【验证状态】本文件在编写时尚未在真实 PostgreSQL 实例上执行过。
--              首次执行后请在本节记录执行日期与结果。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- users：用户账号
-- ------------------------------------------------------------
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      VARCHAR(32) NOT NULL,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- 用户名全表唯一。注册重名由应用层映射为 409 USERNAME_TAKEN。
    CONSTRAINT users_username_unique UNIQUE (username),

    -- 规范 §06：去首尾空白转小写后，字符集为 [a-z0-9_-]，长度 3–32。
    -- 归一化（trim + 转小写）由应用层完成，此约束是兜底。
    CONSTRAINT users_username_format
        CHECK (username ~ '^[a-z0-9_-]{3,32}$')
);

-- ------------------------------------------------------------
-- documents：Markdown 文档
-- ------------------------------------------------------------
CREATE TABLE documents (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   UUID        NOT NULL,
    title      VARCHAR(255) NOT NULL,
    content    TEXT        NOT NULL DEFAULT '',
    version    INTEGER     NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- 每篇文档必须属于一个已存在的用户。
    -- RESTRICT 而非 CASCADE：首版不提供删号功能，避免误删他人文档。
    CONSTRAINT documents_owner_fk
        FOREIGN KEY (owner_id) REFERENCES users (id)
        ON DELETE RESTRICT,

    -- 标题非空：按 **Unicode 标量值**去掉首尾空白后必须至少剩一个字符。
    --
    -- 【修订记录】2026-10-20 在真实 PostgreSQL 17.11 上实测发现：
    --   初版用 `btrim(title, E' \t\n\r')`，只覆盖 ASCII 空白，
    --   **U+3000 全角空格、U+00A0 不换行空格等 Unicode 空白仍能通过**。
    --   实测插入 title = U+3000 的文档成功（title_hex = e38080），
    --   证明该写法达不到规范 §06「去首尾空白后 1–255 字符」的要求。
    --
    -- 现改用 `btrim` 的第二参数传入**显式的 Unicode 空白字符列表**，
    -- 覆盖规范实际会遇到的空白：半角空格、制表、换行、回车、
    -- 不换行空格 U+00A0、全角空格 U+3000、上下空白 U+2028/U+2029。
    --
    -- 【仍存在的局限】PostgreSQL 17 未内置完整的 Unicode 属性表，
    -- 无法用 `\p{Z}` 一次性匹配全部空白字符。上述列表覆盖常见情况，
    -- 但**应用层仍是唯一真防线**——Rust 侧用 `char::is_whitespace`
    -- 做完整的 Unicode 空白判定，见 src/routes/documents.rs。
    CONSTRAINT documents_title_not_blank
        CHECK (char_length(btrim(title, E' \t\n\r' || U&'\00A0' || U&'\3000' || U&'\2028' || U&'\2029')) > 0),

    -- 标题字符数上限。与规范 §06「按 Unicode 标量值计数 1–255」一致。
    -- 注：VARCHAR(255) 本身按字符计数，因此此约束实际不会额外触发，
    --     保留是为了让长度语义在库侧自解释。
    CONSTRAINT documents_title_length
        CHECK (char_length(title) <= 255),

    -- 正文字节上限 262144 = 256 KiB。允许空串。
    CONSTRAINT documents_content_size
        CHECK (octet_length(content) <= 262144),

    -- 版本号必须为正数。乐观锁的基准值。
    CONSTRAINT documents_version_positive
        CHECK (version > 0)
);

-- 列表查询：按所有者过滤，按 updated_at DESC、id DESC 稳定排序。
-- 次序与规范 §06 列表排序要求一致；id 作为次排序键保证分页稳定。
CREATE INDEX documents_owner_updated_idx
    ON documents (owner_id, updated_at DESC, id DESC);

-- 说明：**不使用触发器**。规范 §07 明确要求 updated_at 由 UPDATE 语句显式设置，
-- 触发器会让「乐观锁更新是否真的刷新了 updated_at」变得不可见，
-- 且在测试中难以断言。应用层的原子更新 SQL 负责维护该字段。

COMMIT;
