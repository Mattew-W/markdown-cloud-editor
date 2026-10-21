-- 清理数据库测试留下的隔离 schema
--
-- 背景（PR #3 审查意见 P2「隔离数据库 fixtures」的配套）：
-- 早期 `tests/auth_db.rs` 让所有用例共用 `public` schema 并各自 TRUNCATE，
-- 并发时互相擦除数据。修复后每个用例建自己的 schema（`t_<...>` 前缀），
-- 用例内不再删除——清理统一放在这里。
--
-- 为什么不在用例内删：sqlx 0.8 的 `PoolOptions` 只提供 `after_release`，
-- 在归还连接时删 schema 既不幂等，也会与仍在使用该连接的查询冲突。
--
-- 本脚本幂等，可反复执行；只删 `t_%` 前缀的 schema，不会误伤业务对象。

\echo '=== 清理前：隔离 schema 清单 ==='
SELECT nspname AS schema
FROM pg_namespace
WHERE nspname LIKE 't\_%'
ORDER BY nspname;

DO $$
DECLARE
    s record;
BEGIN
    FOR s IN
        SELECT nspname FROM pg_namespace WHERE nspname LIKE 't\_%'
    LOOP
        EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s.nspname);
        RAISE NOTICE '已删除 schema: %', s.nspname;
    END LOOP;
END
$$;

\echo ''
\echo '=== 清理后：应为空 ==='
SELECT COUNT(*) AS leftover_test_schemas
FROM pg_namespace
WHERE nspname LIKE 't\_%';