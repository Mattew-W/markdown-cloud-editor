-- 修订后的空白字符防护实测（2026-10-20）
-- 初版 btrim(title, E' \t\n\r') 漏过 U+3000，本脚本验证修订是否真的堵住。

\echo '=== 准备测试用户 ==='
INSERT INTO users (username, password_hash) VALUES ('alice', 'dummy-hash');

\echo ''
\echo '=== 应全部失败（8 种空白标题）==='

\echo '--- 半角空格 ---'
INSERT INTO documents (owner_id, title) SELECT id, '   ' FROM users LIMIT 1;
\echo '--- 制表符 ---'
INSERT INTO documents (owner_id, title) SELECT id, E'\t' FROM users LIMIT 1;
\echo '--- 换行 ---'
INSERT INTO documents (owner_id, title) SELECT id, E'\n' FROM users LIMIT 1;
\echo '--- U+0020 不换行空格（此前会通过）---'
INSERT INTO documents (owner_id, title) SELECT id, U&'\00A0' FROM users LIMIT 1;
\echo '--- U+3000 全角空格（初版漏过，本次修复目标）---'
INSERT INTO documents (owner_id, title) SELECT id, U&'\3000' FROM users LIMIT 1;
\echo '--- U+3000 前后夹正常文字（首尾空白应被去掉，不该失败）---'
INSERT INTO documents (owner_id, title) SELECT id, U&'\3000' || '课程笔记' FROM users LIMIT 1;
\echo '--- U+2028 行分隔符 ---'
INSERT INTO documents (owner_id, title) SELECT id, U&'\2028' FROM users LIMIT 1;

\echo ''
\echo '=== 应成功（正常标题）==='
INSERT INTO documents (owner_id, title) SELECT id, '课程笔记' FROM users LIMIT 1;
INSERT INTO documents (owner_id, title) SELECT id, '  前后有空格但不为空  ' FROM users LIMIT 1;

\echo ''
\echo '=== 结果统计：documents 应为 3 条（2 条正常 + 1 条 U+3000 夹文字）==='
SELECT id, '[' || title || ']' AS title_bracketed
FROM documents
ORDER BY title;

\echo ''
\echo '=== 确认无全空白标题残留 ==='
SELECT COUNT(*) AS blank_titles_should_be_0
FROM documents
WHERE char_length(btrim(title, E' \t\n\r' || U&'\00A0' || U&'\3000' || U&'\2028' || U&'\2029')) = 0;

\echo ''
\echo '=== 清理 ==='
DELETE FROM documents;
DELETE FROM users;
SELECT (SELECT COUNT(*) FROM users) AS users_left,
       (SELECT COUNT(*) FROM documents) AS documents_left;
