-- 清理 verify_constraints.sql 留下的测试数据
-- 顺序：先删 documents（子表），再删 users（父表），否则触发 FK RESTRICT。

\echo '=== 残留数据（含 5e 漏过的 U+3000 标题）==='
SELECT id,
       '[' || title || ']' AS title_bracketed,
       encode(convert_to(title, 'UTF8'), 'hex') AS title_hex
FROM documents;

\echo ''
\echo '=== 确认 U+3000 是否真的写入了数据库 ==='
SELECT COUNT(*) AS u3000_titles
FROM documents
WHERE title = U&'\3000';

\echo ''
\echo '=== 清理 ==='
DELETE FROM documents;
DELETE FROM users;
SELECT (SELECT COUNT(*) FROM users) AS users_left,
       (SELECT COUNT(*) FROM documents) AS documents_left;
