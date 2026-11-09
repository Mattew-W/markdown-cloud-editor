# 数据库结构与迁移契约

| 项 | 值 |
| --- | --- |
| 文档状态 | **已冻结**（Frozen） |
| 冻结日期 | 2026-10-21 |
| 规范依据 | 项目规范 §07（v1.2） |
| 数据库 | PostgreSQL **17 系列**（本机 17.11） |
| 验证状态 | ✅ **已在真实 PostgreSQL 17.11 上执行并逐条实测**（见 §7） |
| 相关文档 | [`API.md`](API.md)、[`INTERFACES.md`](INTERFACES.md)、[`LOCAL_POSTGRES.md`](LOCAL_POSTGRES.md)、[`ARCHITECTURE.md`](ARCHITECTURE.md) |

> **本文档取代先前的英文占位稿。** 旧稿写"time­stamp 命名""可选 `document_revisions`"，
> 与规范 §07 的**递增编号制**及首版范围冲突，已废弃。凡不一致，以本表为准。

---

## 1. 表结构

### 1.1 `users`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | UUID | PK，`DEFAULT gen_random_uuid()` | 由数据库生成 |
| `username` | VARCHAR(32) | `NOT NULL`，`UNIQUE` | **已规范化**（trim + 转小写） |
| `password_hash` | TEXT | `NOT NULL` | Argon2id **PHC 格式**。禁止返回前端 |
| `created_at` | TIMESTAMPTZ | `NOT NULL`，`DEFAULT CURRENT_TIMESTAMP` | 数据库生成 |

### 1.2 `documents`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | UUID | PK，`DEFAULT gen_random_uuid()` | |
| `owner_id` | UUID | `NOT NULL`，FK → `users(id)` `ON DELETE RESTRICT` | RESTRICT 而非 CASCADE：首版无删号功能 |
| `title` | VARCHAR(255) | `NOT NULL`，trim 后非空 | 按 Unicode 标量值计 |
| `content` | TEXT | `NOT NULL`，`DEFAULT ''` | ≤ 262144 字节 |
| `version` | INTEGER | `NOT NULL`，`DEFAULT 1`，`> 0` | 每次更新 +1 |
| `created_at` | TIMESTAMPTZ | `NOT NULL`，`DEFAULT CURRENT_TIMESTAMP` | |
| `updated_at` | TIMESTAMPTZ | `NOT NULL`，`DEFAULT CURRENT_TIMESTAMP` | **由 UPDATE 语句显式设置** |

### 1.3 索引

```sql
CREATE INDEX documents_owner_updated_idx
    ON documents (owner_id, updated_at DESC, id DESC);
```

`id` 作次排序键保证分页稳定，列与方向与规范 §06 的列表排序要求一致。

---

## 2. 约束清单与职责划分

规范 §07：**应用执行输入验证，数据库保留非空、唯一、外键和长度约束作为兜底。**

| 约束 | 类型 | 归属层 | 说明 |
|---|---|---|---|
| `users_username_unique` | UNIQUE | DB | 注册重名 → 应用层映射 `409 USERNAME_TAKEN` |
| `users_username_format` | CHECK `^[a-z0-9_-]{3,32}$` | DB（**加固项**） | 规范未要求，属超出规范的加固。应用层已完成 trim + 转小写 |
| `documents_owner_fk` | FK RESTRICT | DB | |
| `documents_title_not_blank` | CHECK | DB（兜底） | 见 §3，**不能完全覆盖 Unicode 空白** |
| `documents_title_length` | CHECK `char_length(title) <= 255` | DB（自解释） | `VARCHAR(255)` 本身已按字符限制，保留为让长度语义在库侧自解释 |
| `documents_content_size` | CHECK `octet_length(content) <= 262144` | DB（兜底） | `octet_length` 是**字节**口径，与规范一致 |
| `documents_version_positive` | CHECK `version > 0` | DB | |

**不在 DB 层的**：密码长度（12–128 **UTF-8 字节**）。哈希长度 ≠ 密码长度，
在 DB 加这个 CHECK 是错的，**只归应用层**。

---

## 3. 关于 Unicode 空白的实测发现（重要）

初版 `documents_title_not_blank` 用 `btrim(title, E' \t\n\r')`，只覆盖 ASCII 空白。
**在真实 PostgreSQL 17.11 上实测：插入 `title = U+3000`（全角空格）成功**，
`title_hex = e38080`，证明达不到规范 §06「去首尾空白后 1–255 字符」的要求。

现改为 `btrim` 第二参数传入**显式 Unicode 空白列表**：
半角空格、`\t`、`\n`、`\r`、U+00A0、U+3000、U+2028、U+2029。

```sql
CHECK (char_length(btrim(title, E' \t\n\r' || U&'\00A0' || U&'\3000' || U&'\2028' || U&'\2029')) > 0)
```

**仍存在的局限（如实标注）**：PostgreSQL 17 未内置完整 Unicode 属性表，
无法用 `\p{Z}` 一次性匹配全部空白字符。

**应用层是唯一真防线** —— Rust 侧用 `char::is_whitespace()` 做完整判定。
DB 的 CHECK 只是兜底，不要因为它存在就以为应用层可以省略校验。

---

## 4. 迁移规范

| 项 | 规定 |
|---|---|
| 目录 | `migrations/` |
| 命名 | **递增编号制**：`0001_init.sql`（4 位数字 + `_` + snake_case 描述）。**不用时间戳** |
| 已合并迁移 | **不得改写**；变更一律新增迁移文件 |
| 方向 | 前向迁移 |
| 事务 | 迁移文件可自带 `BEGIN/COMMIT`；SQLx 自动把每个文件包在一个事务里，**嵌套 BEGIN 只会产生告警** |
| CI | 从空测试库执行，`ON_ERROR_STOP=1` |

**当前迁移文件**：

| 文件 | 用途 |
|---|---|
| `0001_init.sql` | 建表、约束、索引 |
| `checks/fixtures.sql` | 断言式验证的固定夹具（3 用户 + 6 文档） |
| `checks/verify_constraints.sql` | 断言式约束验证（11 个用例，带 SQLSTATE 断言） |
| `checks/run_checks.sql` | 验证入口：夹具与检查同事务，结束回滚、零残留 |
| `cleanup_test_data.sql` | 清 `public` schema 测试数据 |
| `cleanup_test_schemas.sql` | 清隔离测试 schema（`t_%` 前缀） |
| `verify_constraints_legacy_manual.sql` | 旧观察式脚本，**已归档**，不再作为验收依据 |
| `verify_whitespace.sql` | 标题 Unicode 空白边界专项检查 |

---

## 5. 查询与访问安全

- **所有 SQL 走绑定参数**，禁止字符串拼接用户输入。
- **每条文档查询都必须限定 `owner_id`** —— 权限隔离不是 UI 层的事。
- **原子更新**（乐观锁）：

```sql
UPDATE documents
   SET title = $1, content = $2, version = version + 1, updated_at = CURRENT_TIMESTAMP
 WHERE id = $3 AND owner_id = $4 AND version = $5
RETURNING id, version, updated_at;
```

**严禁**"先读版本、再执行无版本条件的 UPDATE"——那会让自动保存静默覆盖他人修改。

零行时分流（仅在可见范围内再查一次）：不可见 → `404`；可见但版本不同 → `409`。

- **不使用触发器**维护 `updated_at`。规范 §07 明确要求由 UPDATE 语句显式设置。
  触发器会让"乐观锁是否真的刷新了 `updated_at`"变得不可见，且难以在测试中断言。
  实测 `pg_trigger` 中两表非内部触发器数量为 **0**。

---

## 6. 测试隔离

`tests/auth_db.rs` 的每个用例建**独立 schema**（`t_<线程>_<序号>_<时间戳>`），
经 `after_connect` 钩子给池中每条连接设 `search_path`。

schema 内用 `include_str!("../migrations/0001_init.sql")` 复用**真实迁移**，
保证测的就是生产 schema，而不是另写一套。

清理：用例内不删（sqlx 0.8 无 `before_release`，在归还连接时删 schema 会与仍在
使用的连接冲突），改为 CI 在数据库测试**前后各执行一次** `cleanup_test_schemas.sql`。

---

## 7. 实测记录（真实 PostgreSQL 17.11）

环境：`D:\PostgreSQL\17`，库 `mce_test`，客户端 `psql`。

> **2026-10-31 更新**：原第 7 节记录的观察式脚本（`verify_constraints.sql`，靠人工看
> ERROR 输出判断）已归档为 `verify_constraints_legacy_manual.sql`。现行验收依据是
> **断言式**脚本 `migrations/checks/`，见下节 7.1。

### 7.1 断言式约束验证（现行依据，2026-10-31 实测）

执行命令：

```powershell
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -f migrations/0001_init.sql
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -f migrations/checks/run_checks.sql
```

与旧脚本的本质差别：每条负例放在**嵌套 BEGIN/EXCEPTION 子事务**中，捕获
`RETURNED_SQLSTATE` 并与预期**逐项比较**；错误码不同或根本没报错，都显式
`RAISE EXCEPTION` 使整轮失败。不使用 `WHEN OTHERS THEN NULL` 吞错。

实测结果（PostgreSQL 17.11，11/11 PASS，`ALL CONSTRAINT CHECKS PASSED`）：

| # | 用例 | 期望 SQLSTATE | 实测 |
|---|---|---|---|
| 1 | 重复 username | `23505` | ✅ |
| 2 | owner 为不存在但合法的 UUID | `23503` | ✅ |
| 3 | `version = 0` | `23514` | ✅ |
| 4 | `version = -1` | `23514` | ✅ |
| 5 | 正文 262145 字节 | `23514` | ✅ |
| 6 | 空标题 | `23514` | ✅ |
| 7 | 纯普通空格标题 | `23514` | ✅ |
| 8 | 全角空格标题 U+3000 | `23514` | ✅ |
| 9 | 标题 256 字符 | `22001`（VARCHAR 长度错误，非 CHECK） | ✅ |
| 10 | 合法 255 字符标题 | 成功 INSERT | ✅ |
| 11 | 合法 262144 字节正文 | 成功 INSERT | ✅ |

补充核实：
- **可重复**：连续执行两遍均成功；业务表零残留（`users=0, documents=0`）。
- **证伪能力**：8 个变异体（逐条移除约束 / 篡改预期错误码 / 放宽 VARCHAR）全部被检出并判失败，
  证明脚本不是"永远报 PASS"的空壳。
- **事务隔离**：单条负例失败被嵌套子事务捕获后，外层事务仍可继续执行后续检查与写入。
- 多字节正文按 `octet_length` 计（`repeat('中',87381)||'a'` = 262144 字节），
  未用字符数替代字节数。

---

### 7.2 旧观察式脚本的历史记录（2026-10-21，已归档）

原执行命令：`psql -U postgres -d mce_test -f migrations/verify_constraints.sql`

| # | 用例 | 期望 | 实测 |
|---|---|---|---|
| 5a | 用户名含大写 | 拒绝 | ✅ `users_username_format` |
| 5b | 用户名过短 | 拒绝 | ✅ `users_username_format` |
| 5c | 用户名重复 | 拒绝 | ✅ `users_username_unique` |
| 5d | 标题纯空白 | 拒绝 | ✅ `documents_title_not_blank` |
| 5e | 标题为全角空格 U+3000 | 拒绝 | ✅ `documents_title_not_blank` |
| 5f | `version = 0` | 拒绝 | ✅ `documents_version_positive` |
| 5g | 正文 262145 字节 | 拒绝 | ✅ `documents_content_size` |
| 5h | 正文恰好 262144 字节 | **允许** | ✅ 插入成功（边界值合法） |
| 5i | 外键指向不存在用户 | 拒绝 | ✅ `documents_owner_fk` |
| 5j | 正文空串 | **允许** | ✅ 插入成功（规范允许空串） |

另核实：
- 索引定义 `(owner_id, updated_at DESC, id DESC)` 与规范一致；
- `pg_trigger` 中两表非内部触发器数量 = **0**；
- 集成测试 9 个用例（8 认证 + 1 健康检查）在真实库上全部通过。
---

## 8. 本地环境

见 [`LOCAL_POSTGRES.md`](LOCAL_POSTGRES.md)。**连接串只写入 `.env`（已被 `.gitignore` 排除），
仓库内只有 `.env.example` 占位样例。**
