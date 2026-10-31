# M2 W2 — 数据库夹具与约束验证

## 状态

**本机未执行。** 未找到 `psql`、PostgreSQL 服务或 Docker。下面的命令是复测步骤，
不是执行记录；不要据此认为 schema 或约束已经验证通过。

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `schema.sql` | M1 随包 `materials/M2/0001_init.sql` 的逐字节副本；创建 `users`、`documents` 和列表索引 |
| `fixtures.sql` | 三个固定 UUID 用户（alice、bob、charlie）和六篇固定 UUID 文档 |
| `verify_constraints.sql` | 9 个负例和 2 个合法边界；捕获并比较实际 SQLSTATE |
| `run_checks.sql` | psql 入口：在同一个 `BEGIN` / `ROLLBACK` 中加载夹具并执行检查 |
| `检查记录.md` | 环境检查、静态检查和运行测试矩阵（运行项均为未执行） |
| `运行日志.txt` | 真实环境检查日志；没有执行 SQL |
| `交付说明.txt` | 交付说明 |

## 前置条件

- PostgreSQL 17 系列（schema 使用 `gen_random_uuid()`，至少需要 13 版）。
- `psql` 已加入 `PATH`。
- 一个**独立、空的练习数据库**，编码为 UTF-8。
  不要使用个人数据库、课程共享数据库或正式数据库。
- 在 PowerShell 中执行；SQL 文件必须保持 UTF-8 编码。
- 在 `M2_W2` 目录执行下面的命令，或者给 `-f` 传完整的 SQL 文件路径。
  `run_checks.sql` 使用 `\ir`，包含文件相对于脚本所在目录解析，不依赖当前目录。

创建练习库（占位命令，**未执行**）：

```powershell
createdb -U <用户名> -E UTF8 -T template0 <练习库名>
```

如果 `createdb` 不可用，可以改用：

```powershell
psql -X -v ON_ERROR_STOP=1 -U <用户名> -d postgres -c "CREATE DATABASE <练习库名> ENCODING 'UTF8' TEMPLATE template0;"
```

## 首次建表

在空练习库中**只执行一次**。`schema.sql` 自带 `BEGIN` / `COMMIT`，
不能放进 `run_checks.sql` 的事务里。

```powershell
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -f schema.sql
```

预期：成功创建 `users`、`documents`、索引，并成功 `COMMIT`。

## 执行检查

```powershell
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -f run_checks.sql
```

`run_checks.sql` 的执行顺序：

1. 设置 `ON_ERROR_STOP on`。
2. 打开 `BEGIN`。
3. 用 `\ir` 加载 `fixtures.sql`。
4. 用 `\ir` 加载 `verify_constraints.sql`。
5. 执行 `ROLLBACK`，丢弃夹具和合法边界测试行。

如果任一检查失败，`ON_ERROR_STOP` 会让 psql 以非零状态退出；
连接关闭时未提交事务回滚。因此失败运行也不会留下未提交的测试数据。

预期成功输出包含 11 个 `PASS` 提示、最后的 `ALL CONSTRAINT CHECKS PASSED`，
随后是 `ROLLBACK`。

## 检查残留

`run_checks.sql` 成功执行后，练习库中应只剩 `schema.sql` 创建的空表：

```powershell
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -c "SELECT count(*) AS users FROM users;"
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -c "SELECT count(*) AS documents FROM documents;"
```

预期：两个计数均为 `0`。

要判断是否可重复，应连续执行 `run_checks.sql` 两遍；两遍都成功且计数仍为 `0`，
才能写“可重复、无残留”。**本次没有执行**，所以当前不声称可重复或零残留。

## 说明

- `fixtures.sql` 使用固定 UUID 和明确 UTC 时间；所有文档 `version = 1`。
- 预留的不存在 owner 是合法 UUID：
  `99999999-9999-4999-8999-999999999999`，未插入 `users`。
- `password_hash` 是明确标注的数据库测试假值
  （`DB_TEST_ONLY_FAKE_HASH_*_NOT_ARGON2`），不是有效 Argon2 哈希，不参与登录。
- `schema.sql` 的标题检查扩展了常见 Unicode 空白，但不是完整 Unicode 覆盖；
  应用层仍是最终防线。
- `schema.sql` 与 M1 附件一致，本次没有修改。
