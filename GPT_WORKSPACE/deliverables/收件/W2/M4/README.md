# M4 W2 收件与审核

## 结论：通过（无 P0 / P1，仅 2 项文档一致性 P2）

王海鑫（24406040107）M4 W2 交付（正式输入规则候选模块 `document_validation`）**通过**。

关键点：**范围零偏离**——零第三方依赖，无 HTTP / 数据库 / DTO / Service / Repository / CRUD；
规则语义与冻结契约 `docs/API.md` 及主仓库现行实现**三方一致**；T1～T12 共 12 个真实断言测试全绿；
8 项演示为真实比较、失败非零退出；10 份日志经指纹比对确认为**本机真实捕获**（含两份失败留档）。

与 W1 的对比是结构性反转：W1 范围偏离、参数擅改、夹带 312.8 MB `target/` 与空 `.git`、缺两份规定文档；
W2 上述问题**全部不存在**，且规定文件超出任务书最低要求（多交 `阶段记录.md`）。

## 目录内容

| 路径 | 说明 |
|---|---|
| `extracted/document_validation/` | 原始解压件（23 文件，字节级未改动，审计对象；不含 `target/`、`.git/`） |
| `M4_W2_审核记录.md` | 完整审计记录：结论、清单核对、任务书逐条核对、实测结果、三方交叉验证、日志真实性核验、缺陷清单、后续动作 |
| `../收件/W2/M4/README.md` | 本文件 |

## 实测结果摘要（M1 独立复跑，rustc/cargo 1.99.0）

| 项 | 结果 |
|---|---|
| `cargo fmt --check` | exit 0 ✅ |
| `cargo clippy --locked --all-targets -- -D warnings` | exit 0 ✅ |
| `cargo test --locked` | **12 passed / 0 failed**，exit 0 ✅ |
| `cargo run --locked` | **8/8 PASS**，exit 0 ✅（任一失败即 exit 1，退出码 0 即等价证明） |
| `cargo doc -D warnings`（加测，任务书未要求） | exit 0 ✅ |
| 依赖数 | `Cargo.lock` 仅 1 个包 —— **零第三方依赖** ✅ |
| 旧阈值残留 | 源码中 `100` / `100_000` **零出现** ✅ |
| 与主仓库关系 | 与 `src/services/document_service.rs` 现行实现**语义同构**，无冲突 |

## 待办（均不阻塞结案）

| 编号 | 事项 | 责任方 |
|---|---|---|
| P2-1 | `交付说明.txt` 模板残留矛盾：头部仍写"当前为占位"、【未完成项】仍写"姓名学号待填写"，但同文件已填真实值 | M4（W3 前修订） |
| P2-2 | `阶段记录.md` 声明 shell 为 pwsh 7，但日志中"所在位置 行:1 字符: 121 / NativeCommandError"是 **PowerShell 5.1** 的原生 stderr 包装格式 | M4（W3 前更正） |
| P3-1 | 两个理解题待 M4 **本人**回答（M4 未代答、未写"已掌握"，合规但未闭合） | M1 提问 → M4 |
| P3-2 | W1 练习本体（F1/F2）已由 Codex 代补并下发，W2 任务书明确本周不要求重做 → **不计 M4 违约**，但豁免口径需 M1 明确并留痕 | M1 |

## M1 侧复用决策

**不建议合并代码。** 主仓库 `document_service.rs:32-73` 已实现同构逻辑并接入 `AppError`（400 / 413 映射）；
本模块的增量价值在**零依赖、可独立运行的 T1～T12 测试套件**。建议将其边界用例思路采纳为主仓库
document 层的回归用例（空白 / 全角空白 / trim 后计数等场景），而非引入第二份实现。

## 复测命令

```powershell
$env:CARGO_HOME = "C:\Users\huang\.cargo"
Set-Location "GPT_WORKSPACE\deliverables\收件\W2\M4\extracted\document_validation"
& "C:\Users\huang\.cargo\bin\cargo.exe" fmt --check
& "C:\Users\huang\.cargo\bin\cargo.exe" clippy --locked --all-targets -- -D warnings
& "C:\Users\huang\.cargo\bin\cargo.exe" test  --locked
& "C:\Users\huang\.cargo\bin\cargo.exe" run   --locked
```
