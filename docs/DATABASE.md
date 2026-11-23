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
| `checks/w3/regression.sql` | W3 隔离回归断言（8 组用例 + 前后行数核对） |
| `checks/w3/run_w3_regression.sql` | W3 入口：建临时 schema → 加载冻结迁移 → 回归 → 删 schema |
| `checks/w3/run_w3_regression.ps1` | W3 推荐入口：唯一 schema 名，`finally` 清理（失败也不留） |
| `checks/w3/negative_control/` | 负向对照：故意改错预期码的副本，用于证明断言非空壳 |
| `checks/w4/regression.sql` | W4 数据层回归断言（RESTRICT / CAS / 稳定分页 / 索引定义） |
| `checks/w4/public_counts.sql` | public 行数前后对照（`to_regclass` + 动态 EXECUTE） |
| `checks/w4/run_w4_regression.sql` | W4 入口：建临时 schema → 计数 → 迁移 → 回归 → 复核 → 删 schema |
| `checks/w4/run_w4_regression.ps1` | W4 推荐入口：唯一 schema 名，`finally` 清理 |
| `checks/w4/concurrency/` | W4 双会话 CAS 并发验证（A/B 独立 psql 进程 + barrier） |
| `checks/w4/negative_control/` | W4 负向对照：预期码 `23503`→`23505` 的副本 |
| `checks/w5/constraints.sql` | W5 隔离约束回归（16 条精确 SQLSTATE 观测 + 合规对照） |
| `checks/w5/run_w5_regression.ps1` | W5 runner：唯一 schema、finally 清理、残留与挂起连接核查 |
| `checks/w5/concurrency/` | W5 独立会话 CAS：**败者归因**（回读版本/正文、只反映一次写入） |
| `checks/w5/index/` | W5 索引定义核对 + 200 行/5 并列时间戳/10 页稳定分页 |
| `checks/w5/limits/` | W5 有限并发轮次（固定轮数，记录 SQLSTATE/超时/死锁与样本范围） |
| `checks/w5/negative_control/` | W5 负向对照：预期码 `23505`→`23514` 的副本 |
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

### 7.2 W3 隔离回归（2026-11-07，由 M2 交付、M1 实测）

W2 的 11 例在 `public` 上执行；W3 改为在**独立临时 schema** 中执行冻结迁移，
不写 `public`、不依赖现有用户数据，因此可在任意有 `public` 数据的库中安全运行。

**隔离机制**：`CREATE SCHEMA t_w3_*` → `SET search_path` 指向该 schema →
在同一会话加载原 `0001_init.sql` → 执行 `regression.sql`（自行 `BEGIN/ROLLBACK`）→
`DROP SCHEMA ... CASCADE`。PowerShell 入口在 `finally` 中兜底清理，失败路径也不留 schema。

执行命令：

```powershell
$env:PGUSER = 'postgres'          # psql 默认用 OS 用户名，需显式指定角色
.\migrations\checks\w3\run_w3_regression.ps1 -Database <练习库名>
# 负向对照（预期非零退出 rc=3）
.\migrations\checks\w3\run_w3_regression.ps1 -Database <练习库名> -Entry negative_control\run_w3_negative_control.sql
```

实测结果（PostgreSQL 17.11，10/10 PASS，`ALL W3 REGRESSION CHECKS PASSED`）：

| # | 用例 | 期望 | 实测 |
|---|---|---|---|
| 1 | 两个合法 UUID 用户各有同名标题文档 | 两行成功，行数 2、不同 owner 数 2 | ✅ |
| 2 | owner 为合法但未注册的 UUID | `23503` | ✅ |
| 3 | 标题 255 字符 | 成功，`char_length=255` | ✅ |
| 4 | 标题 256 字符 | `22001` | ✅ |
| 5 | 正文 262144 UTF-8 字节 | 成功，`octet_length=262144` | ✅ |
| 6 | 正文 262145 字节 | `23514` | ✅ |
| 7 | `version = 0` | `23514` | ✅ |
| 8 | 前后行数一致 | `users=0, documents=0` | ✅ |

补充核实：
- **隔离性**：`public` 预置数据时仍 10/10 PASS，且 `public` 行数不变。
- **可重复**：连续三遍均 10/10 PASS，无残留累积。
- **证伪能力**：负向对照（预期码 `23503`→`23505`）实测 `rc=3`，检出
  `W3 CHECK FAILED [nonexistent owner]: expected 23505, got 23503`；差异仅 2 行，不动原迁移。
- **保护路径**：无 psql → `rc=127`；Entry 不存在 → `rc=2`；schema 名非法 → `rc=2`。

> **CI 接入注意**：`psql` 的 `RAISE NOTICE` 输出到 **stderr**，不是 stdout。
> 用 `| tee file` 捕获日志会导致 grep 找不到成功标志而误报失败，须用 `> file 2>&1`。
> 残留检测不能查 `public.users`——W3 从不在 `public` 建表，该表可能根本不存在；
> 应查「无残留 `t_w3_*` schema」+「`public` 若有表则行数前后一致」。

---

### 7.3 W4 数据层回归（2026-11-15，由 M2 交付、M1 实测）

W2/W3 验证的是**约束本身**；W4 验证的是**现有 CRUD 约束与 CAS 写入语义**——
在隔离 schema 中加载冻结迁移后，对「有约束的用户/文档」「乐观锁原子更新」「稳定分页」
做数据层断言。

覆盖对应任务书 M2-01～M2-06：

| 编号 | 要求 | 实测 |
|---|---|---|
| M2-01 | 唯一临时 schema；ON_ERROR_STOP；正常/失败路径都清理；前后行数一致 | ✅ 前后一致；两路径均零残留 |
| M2-02 | 有文档用户删除被 RESTRICT → `23503`，用户与文档均保留；合法不存在 UUID → `23503`；非法 UUID → `22P02` | ✅ 三项全过 |
| M2-03 | `owner_id + id + expected_version` 原子更新：正确命中 1 行且版本推进；错误 owner / 旧版本 0 行且正文与版本不变 | ✅ 1 行/version=2；0 行/不变 |
| M2-04 | 两独立会话同一初始版本并发；显式同步起点；恰一成功另一零行 | ✅ 8/8 命中 {1,0}，**行锁等待铁证** |
| M2-05 | 同 `updated_at` 多文档按 `updated_at DESC, id DESC` 稳定分页、用户过滤；确认索引定义覆盖 | ✅ 并集=全集；无跨用户泄漏；索引含三列 |
| M2-06 | 复制脚本改一个预期 SQLSTATE；基线成功、对照非零退出且清理完成 | ✅ `rc=3` 被检出，零残留 |

主回归实测 **11/11 PASS**（`ALL W4 REGRESSION CHECKS PASSED`），两遍可重复。

#### 并发真实性的专项验证

任务书明确「顺序两次 UPDATE 只能证明旧版本拒绝，不能标并发」，故 M1 对并发脚本做了专项验证：

- **胜者翻转实验**：原始脚本连跑 8 次胜者恒为 A；人为让 A 延后到达 barrier，
  胜者**全部变为 B**。顺序执行不可能出现胜者随到达顺序翻转。
- **行锁等待观测**：让 A 用显式事务持有行锁 6 秒，第三连接轮询 `pg_locks`，
  观测到 **10 次 `granted=false` 的锁等待**（t=1.65s～4.4s）——
  B 的 UPDATE 确实被 A 的行锁阻塞，数据库层面的直接证据。

> **鉴别力边界（阶段定向变异实测）**：去掉**可能成为败者**那一方的 `version` 条件 →
> 立即检出（`{1,1}`）；去掉**赢家**的 `version` 条件 → 不检出（赢家的 version 条件
> 不参与"谁失败"的判定）；去掉 `owner_id` 条件 → 不检出（`owner_id` 与 `version` 是 AND
> 条件，去掉前者后者仍会拦住败者）。后两项属并发场景固有局限，
> 已由主回归 **M2-03b / M2-03c** 专门覆盖（错误 owner / 旧版本 → 0 行且不变）。

> **边界声明**：数据库层「影响 0 行」**不等于** HTTP 404 / 409 已验证。
> 后者的状态码映射须由 API 层集成测试覆盖。

执行命令：

```powershell
$env:PGUSER = 'postgres'      # psql 默认用 OS 用户名，本机为 huang，PG 无此角色
.\migrations\checks\w4\run_w4_regression.ps1 -Database <练习库名>
.\migrations\checks\w4\concurrency\run_w4_concurrency.ps1 -Database <练习库名>
# 负向对照（预期非零退出 rc=3）
.\migrations\checks\w4\run_w4_regression.ps1 -Database <练习库名> -Entry negative_control\run_w4_negative_control.sql
```

> 并发测试与负向对照**不进 CI 必检**（前者需双进程与时间同步，CI 抖动会影响稳定性；
> 后者按设计必然失败），保留为手动复测与证伪手段。

---

### 7.4 W5 数据库联调回归（2026-11-23，由 M2 交付、M1 实测）

W4 只断言「影响行数集合 {1,0}」。W5 补齐**败者归因**：
额外记录双方起跑时的 `initial_version`、起止时间、影响行数，以及**败方在双方尝试完成后回读到的版本与正文**。

| 编号 | 要求 | 实测 |
|---|---|---|
| M2-W5-01 | 隔离约束回归，精确 SQLSTATE、合规对照、失败退出 | ✅ 17/17 PASS（16 条约束观测 + 2 条合规对照） |
| M2-W5-02 | 独立会话 CAS：记录起跑/提交/影响行数，败方回读到胜方版本，最终只反映一次写入 | ✅ `{1,0}`，败方 readback v=2 且内容为胜方正文 |
| M2-W5-03 | 索引定义与关键查询口径；固定轮数并发读写，不从有限样本推断全局性能 | ✅ 索引定义与 200 行/5 并列时间戳/10 页分页通过；20 轮并发读写无超时/死锁 |
| M2-W5-04 | 负向对照证明检查会非零退出；成功/失败路径都清理并记录残留数 | ✅ 负向对照 psql 退出码 3、残留 0、挂起连接 0 |

实测细节：
- 主回归 **17/17 PASS**：`ALL W5 REGRESSION CHECKS PASSED`。
- 并发实测输出：`winner=A, loser=B, rows_affected={1,0}, final version=2, final content=winner-A,
  loser readback=(v=2, content=winner-A)` —— 败方归因成立。
- 负向对照：psql 原始退出码 **3**，`W5 CHECK FAILED [username duplicate]: expected SQLSTATE 23514,
  but statement succeeded`（副本把 `23505` 改成 `23514`）。
- 限流轮次：20 轮，每轮 1 写 1 读，**0 超时、0 死锁**；脚本自身声明
  「有限样本只描述本次观测，不推断全局吞吐、延迟上限或死锁概率」。

#### runner 的清理核查（W5 的增量设计）

`run_w5_regression.ps1` 除唯一 schema + finally 清理外，还报告三组数字：
本轮 schema 残留数、库内 `t_w5_*` 总残留数、`application_name` 匹配的**挂起连接数**。

> **一处边界（M1 实测发现）**：runner 的判定只看**本轮那个** schema（`afterExact`）与
> **本轮** app 的挂起连接（`lingering`）；库内 `t_w5_*` 总残留（`afterResidual`）
> **仅报告、不参与判定**。即：若上一轮异常退出留下 schema，后续运行仍会判 PASS。
> → M1 接入 CI 时在 runner 之后**追加一条全局断言**（库内 `t_w5_*` 计数必须为 0），
> 实测可捕获该场景（预置残留 → CI rc=1；清除后恢复 rc=0）。

#### 鉴别力验证（M1 阶段定向变异）

| 变体 | 结果 |
|---|---|
| 移除 `users_username_unique` | ✅ 检出（`[username duplicate]: expected SQLSTATE 23505, but statement succeeded`） |
| 移除 `version > 0` | ✅ 检出（`[version 0]`） |
| 移除 content 262144 字节约束 | ✅ 检出（`[content 262145 bytes]`） |
| 移除标题非空约束 | ✅ 检出（`[title empty]`） |
| 破坏败方 readback 断言 | ✅ 检出（`W5 CONCURRENCY FAILED [loser readback version]`） |

执行命令：

```powershell
$env:PGUSER = 'postgres'      # psql 默认用 OS 用户名，本机为 huang，PG 无此角色
.\migrations\checks\w5\run_w5_regression.ps1 -Database <练习库名>
.\migrations\checks\w5\concurrency\run_w5_concurrency.ps1 -Database <练习库名>
.\migrations\checks\w5\run_w5_regression.ps1 -Database <练习库名> -Entry index\run_w5_index.sql
.\migrations\checks\w5\limits\run_w5_rounds.ps1 -Database <练习库名> -Rounds 20
# 负向对照：runner 在「psql 非零 + 残留 0 + 挂起 0」时返回 0
.\migrations\checks\w5\run_w5_regression.ps1 -Database <练习库名> `
    -Entry negative_control\run_w5_negative_control.sql -ExpectFailure
```

> CI 必检接入：主回归、索引检查、负向对照（`-ExpectFailure`）。
> 并发与限流轮次**不进必检**（需双进程时间同步 / 20 轮耗时），保留为手动复测。

> **边界声明**：数据库层「影响 0 行」**不等于** HTTP 404 / 409 已验证。
> `WHERE id+owner_id+version` 的 0 行同时覆盖「id 不存在」「owner 不符」「版本已变」，
> 必须再做限定 owner 的只读探测才能分流 404 与 409；HTTP 映射由 M4/路由测试单独验证。

---

### 7.5 旧观察式脚本的历史记录（2026-10-21，已归档）

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
