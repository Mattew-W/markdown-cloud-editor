# M2 W3 收件与审核

## 结论：通过（并已完成 M1 侧集成落地）

李子木（D10774023）M2 W3 交付（迁移与约束的可复现回归）**通过**，**无 P0 / P1 问题**。

这是本组目前质量最高的一次收件：

- baseline 60 文件**逐字节未改**（仅 README 纯追加），新增 11 文件全在 W3 范围内；
- 隔离 schema 机制经实测成立：`public` 预置数据时仍 10/10 PASS 且 public 数据不变；
- 主回归 10/10 PASS，三遍可重复，零残留；
- 负向对照（预期码 `23503`→`23505`，差异仅 2 行）实测 `rc=3` 被正确检出；
- W2 遗留的 SQLSTATE 表述已**正确纠正**（42804 / 22P02 / 42883 三条经 M1 实测全部准确）；
- 未执行项与 M1 证据严格分开（4 处明确声明"M1 的实测不是本人执行"）。

## 目录内容

| 路径 | 说明 |
|---|---|
| `extracted/M2_W3_李子木_20261107/` | 原始解压件（78 文件，字节级未改动，审计对象） |
| `M2_W3_审核记录.md` | 完整审计记录：结论、边界核对、实测、任务书逐条核对、SQLSTATE 复核、缺陷、M1 落地动作 |
| `README.md` | 本文件 |

## 实测结果摘要

| 项 | 结果 |
|---|---|
| baseline 一致性 | 59/60 逐字节一致，README 纯追加（原文 1655 字符原样保留为前缀） |
| 冻结文件 | 19 个逐一确认未改（含 `0001_init.sql`、`src/`、`frontend/js/`、`tests/`） |
| W3 主回归 | **10/10 PASS**，`ALL W3 REGRESSION CHECKS PASSED` |
| 隔离性 | public 预置数据时仍 10/10，且 public 行数不变 |
| 可重复 | 连跑三遍全绿，无残留累积 |
| 负向对照 | `rc=3`，检出 `expected 23505, got 23503` |
| 保护路径 | 无 psql → 127；Entry 缺 → 2；schema 名非法 → 2 |

## 唯一待办（不阻塞）

**D1**：交付说明提到 `42883` 时标注为"本次未实测"。M1 已实测确认该说法准确，
若 M2 愿意可把实测表补入检查记录使文档与执行证据对齐。**不要求返工。**

**答辩提醒（高优先级）**：涉及本人理解题的部分（为何用临时 schema、为何断言 SQLSTATE
而非看屏幕报错、负向对照的作用）**只能由李子木本人用自己的话回答**，AI 不得代答。

## M1 已完成的集成落地

| 动作 | 位置 |
|---|---|
| 迁入 W3 脚本 | `migrations/checks/w3/`（含 `negative_control/`） |
| 接入 CI 必检（双向实测 5/5） | `.github/workflows/ci.yml` → 步骤「W3 隔离回归」 |
| 文档同步 | `docs/DATABASE.md` §4 文件清单 + §7.2 W3 隔离回归 |
| 冻结迁移完整性 | `migrations/0001_init.sql` SHA256 仍为 `15083085…` |

### 接入 CI 时修正的两处自身缺陷（值得记）

1. **`psql` 的 NOTICE 输出在 stderr**，`| tee` 捕获不到 → grep 找不到成功标志 → CI 误报失败。
   正确写法：`> file 2>&1`。
2. **残留检测不能查 `public.users`**——W3 从不在 public 建表，该表可能不存在；
   且 `CASE` 的 ELSE 分支会被 PostgreSQL 提前解析（走不到也报错），不能靠 CASE 兜底。

## 复测命令

```powershell
# psql 默认用 OS 用户名，需显式指定角色
$env:PGUSER = 'postgres'
.\migrations\checks\w3\run_w3_regression.ps1 -Database <练习库名>
# 负向对照（预期非零退出 rc=3）
.\migrations\checks\w3\run_w3_regression.ps1 -Database <练习库名> -Entry negative_control\run_w3_negative_control.sql
```

> Windows：`psql` 需 PATH 含 `D:\PostgreSQL\17\bin` 与 PortableGit `1.3.0\usr\bin`（提供 cat.exe）。