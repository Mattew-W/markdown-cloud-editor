# M2 W2 收件与审核

## 结论：通过（并已完成 M1 侧集成落地）

李子木（D10774023）M2 W2 交付（数据库夹具与约束验证）**通过**。

关键点：**M1 在本机 PostgreSQL 17.11 上完成了全套实测**——李子木的机器确实没有数据库
（环境检查记录属实），但 W2 的核心目标「实测约束行为」已由 M1 代为达成：11 个用例全部真实通过，
脚本具备证伪能力（变异测试 8/8 检出），可重复且零残留。

与 W1 的对比：W1 存在「姓名已填却写未填」的自相矛盾、SQL 从未验证；本周该矛盾已修正。

## 目录内容

| 路径 | 说明 |
|---|---|
| `extracted/M2_W2_李子木_20261031_v2/` | 原始解压件（8 文件，字节级未改动，审计对象） |
| `M2_W2_审核记录.md` | 完整审计记录：结论、清单核对、实测结果、变异测试、缺陷清单、M1 落地动作 |
| `../收件/W2/M2/README.md` | 本文件 |

## 实测结果摘要

| 项 | 结果 |
|---|---|
| `schema.sql` vs M1 附件 | SHA256 完全一致（`72666CA8…8AA59`），未改 schema |
| 约束验证 | **11/11 PASS**，实测 SQLSTATE 与预期逐项吻合 |
| 可重复性 | 连续两遍均成功 |
| 零残留 | 两遍后 `users=0, documents=0` |
| 证伪能力 | 8 个变异体全部被检出并判失败 |
| 事务隔离 | 单条负例失败被嵌套子事务捕获，外层事务仍可继续 |

## 唯一待办（不阻塞）

**D1**：交付说明第六节第 1 问称「用 99999 测 UUID 外键会报 22P02」。实测：

- 插入**整数** `99999` → **42804**（`column "owner_id" is of type uuid but expression is of type integer`）
- 插入**字符串** `'99999'` → **22P02**（invalid_text_representation）
- 插入合法但未注册的 UUID → **23503**（foreign_key_violation）✅

结论方向（必须用合法 UUID 才能测到外键拒绝）**完全正确**，仅错误码取值有误。
建议李子木在 W3 交付时一并修订，**不要求重新打包**。

## M1 已完成的集成落地

| 动作 | 位置 |
|---|---|
| 回填迁移文件验证状态（原写「尚未执行过」，已被实测推翻） | `migrations/0001_init.sql` 头部 |
| 旧观察式脚本归档，消除同名歧义 | `migrations/verify_constraints.sql` → `verify_constraints_legacy_manual.sql` |
| 验证脚本迁入仓库 | `migrations/checks/{fixtures,verify_constraints,run_checks}.sql` |
| 接入 CI 作为必检关卡（双向实测：好脚本过、坏脚本被拦） | `.github/workflows/ci.yml` |
| 文档同步 | `docs/DATABASE.md` 第 4、7 节 |

## 复测命令

```powershell
# 需在 PATH 中含 D:\PostgreSQL\17\bin 与 PortableGit 1.3.0 的 usr\bin（提供 cat.exe）
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -f migrations/0001_init.sql
psql -X -v ON_ERROR_STOP=1 -d <练习库名> -f migrations/checks/run_checks.sql
```