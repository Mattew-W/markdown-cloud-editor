-- ============================================================
-- Markdown 云同步编辑器：users / documents 建表草稿
-- 文件：M2_W1/schema-draft.sql
-- 状态：草稿，待 M1 确认后并入正式 migrations
-- 数据库：PostgreSQL 17 系列（gen_random_uuid() 需 13 版以上）
-- 范围：仅建表、约束和索引；不包含查询、接口或 Rust 数据模型
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

    -- 用户名全表唯一
    CONSTRAINT users_username_unique UNIQUE (username),

    -- 按项目规范：小写 ASCII 字母、数字、下划线、短横线，长度 3–32
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

    -- 每篇文档必须属于一个已存在的用户；首版禁止级联删除
    CONSTRAINT documents_owner_fk
        FOREIGN KEY (owner_id) REFERENCES users (id)
        ON DELETE RESTRICT,

    -- 标题去掉首尾普通空格后不能为空（Unicode 空白由应用层处理）
    CONSTRAINT documents_title_not_blank
        CHECK (char_length(btrim(title)) > 0),

    -- 正文字节上限 262144 = 256 KiB
    CONSTRAINT documents_content_size
        CHECK (octet_length(content) <= 262144),

    -- 版本号必须为正数
    CONSTRAINT documents_version_positive
        CHECK (version > 0)
);

-- 列表查询：按所有者过滤，按 updated_at DESC、id DESC 稳定排序
CREATE INDEX documents_owner_updated_idx
    ON documents (owner_id, updated_at DESC, id DESC);

COMMIT;
