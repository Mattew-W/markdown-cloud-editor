-- PostgreSQL 初始化迁移脚本 (Gemini 3.8 Flash Edition - 严格对齐 DATABASE.md 与 PROJECT_SPEC.md §2.3)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(32) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_users_username_format CHECK (username ~ '^[a-z0-9_-]{3,32}$')
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_documents_title_not_blank CHECK (
        char_length(btrim(title, E' \t\n\r' || U&'\00A0' || U&'\3000' || U&'\2028' || U&'\2029')) > 0
    ),
    CONSTRAINT chk_documents_title_length CHECK (char_length(title) <= 255),
    CONSTRAINT chk_documents_content_size CHECK (octet_length(content) <= 262144),
    CONSTRAINT chk_documents_version_positive CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_documents_owner_updated ON documents(owner_id, updated_at DESC, id DESC);
