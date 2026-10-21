-- migrations 验证脚本
-- 逐条核对 0001_init.sql 的约束是否真的在 PostgreSQL 17 上生效。
-- 规范 §12：最终验收必须连接真实数据库，故约束必须实测而非只看 SQL。

\echo '=== 1. 索引定义（规范要求 owner_id, updated_at DESC, id DESC）==='
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'documents';

\echo ''
\echo '=== 2. documents 全部检查约束 ==='
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'documents'::regclass AND contype = 'c'
ORDER BY conname;

\echo ''
\echo '=== 3. users 全部检查约束 ==='
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'users'::regclass AND contype = 'c'
ORDER BY conname;

\echo ''
\echo '=== 4. 确认未使用触发器（规范 §07 明确禁止）==='
SELECT COUNT(*) AS trigger_count
FROM pg_trigger
WHERE tgrelid IN ('users'::regclass, 'documents'::regclass)
  AND NOT tgisinternal;

\echo ''
\echo '=== 5. 约束实测：每条都应报 ERROR ==='

\echo '--- 5a. 用户名大写（应失败：字符集不含大写）---'
INSERT INTO users (username, password_hash) VALUES ('Alice', 'x');

\echo '--- 5b. 用户名过短（应失败：< 3 字符）---'
INSERT INTO users (username, password_hash) VALUES ('ab', 'x');

\echo '--- 5c. 用户名重复（应失败：唯一约束）---'
INSERT INTO users (username, password_hash) VALUES ('alice', 'x');
INSERT INTO users (username, password_hash) VALUES ('alice', 'y');

\echo '--- 5d. 标题为空白（应失败：btrim 后为空）---'
INSERT INTO documents (owner_id, title) SELECT id, '   ' FROM users LIMIT 1;

\echo '--- 5e. 标题含全角空格 U+3000（应失败：规范要求的 Unicode 空白防护）---'
INSERT INTO documents (owner_id, title) SELECT id, E'\u3000' FROM users LIMIT 1;

\echo '--- 5f. version 为 0（应失败：必须为正数）---'
INSERT INTO documents (owner_id, title, version) SELECT id, 'ok', 0 FROM users LIMIT 1;

\echo '--- 5g. 正文超 256 KiB（应失败：octet_length > 262144）---'
INSERT INTO documents (owner_id, title, content)
SELECT id, 'ok', repeat('x', 262145) FROM users LIMIT 1;

\echo '--- 5h. 正文恰好 256 KiB（应成功：边界值合法）---'
INSERT INTO documents (owner_id, title, content)
SELECT id, '边界正文', repeat('x', 262144) FROM users LIMIT 1;

\echo '--- 5i. 外键指向不存在的用户（应失败：FK 约束）---'
INSERT INTO documents (owner_id, title)
VALUES ('00000000-0000-0000-0000-000000000000', '孤儿文档');

\echo '--- 5j. 空字符串正文（应成功：规范允许空串）---'
INSERT INTO documents (owner_id, title, content) SELECT id, '空正文', '' FROM users LIMIT 1;

\echo ''
\echo '=== 6. 清理测试数据 ==='
DELETE FROM users WHERE username = 'alice';
DELETE FROM documents WHERE title IN ('边界正文', '空正文');
SELECT COUNT(*) AS users_left FROM users;
SELECT COUNT(*) AS documents_left FROM documents;
