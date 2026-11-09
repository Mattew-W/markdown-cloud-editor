# M3 W3 收件目录

> 本次 GitHub 集成说明：本分支采用 M3 原交件的固定校验参数上限和测试；下文关于 `VerifyLimits` / `AuthConfig` 的内容记录的是另一份本地 M1 工作区状态，并非本次合入内容。超过固定上限的历史 PHC 哈希会返回 IncompatibleParams，调整生产哈希参数前需要评估兼容性。1 GiB / 64 次迭代只是上限，不代表资源耗尽风险已完全消除。

- 成员：M3 ｜ 周次：W3 ｜ 收件日期：2026-11-09
- 原包：`M3_W3_姓名_20261104.zip`（`D:\wechat_4\...`，未移动/未改名）
- 审计结论：**代码与测试接收；文档层补 2 项后接收。本项目迄今质量最高的 M3 交件。**
- **并入状态（2026-11-09）：已并入主项目并完成 M1 接线** —— 主项目 `87 passed 0 failed`、fmt 0、clippy `--locked -D warnings` 零警告
- 核心价值：修掉一个**真实的 Argon2 参数 DoS 漏洞**（4.4TB 内存分配 → 进程中止），并补 14 条边界测试

## 目录内容

| 路径 | 说明 |
|---|---|
| `M3_W3_审核记录.md` | 完整审计记录（范围核对、逐行 diff、实际运行、反向回退验证、契约核对、问题清单） |
| `extracted/M3_W3_姓名_20261104/` | 原包解压副本（75 文件 / 0.66 MB，无 target、无 node_modules、无 .git） |
| `_unzip_audit.py` | 解压脚本（过滤构建产物、cp437/GBK 文件名处理） |
| `_scope_check.py` | 逐文件 SHA256 范围越界检查 |
| `_diff_baseline.py` | 与 baseline 的逐行 diff |
| `_revert_test.py` | 反向回退验证脚本 |

## 三项关键发现

1. **参数 DoS 漏洞是真实的**：无闸门时 argon2 按哈希串里的 `m=4294967295` 直接申请 4,398,046,507,008 字节（4.4TB）→ 进程中止，退出码 `0xc0000409`。M3 新增的 `ensure_verifiable` 在此之前拦下。
2. **范围控制零越界**：60 个文件中仅 2 个改动（`src/auth/token.rs`、`src/auth/password.rs`），其余 58 个字节级一致；`Cargo.toml`/`Cargo.lock` 未动，冻结契约未碰。
3. **主项目已含 W2 修复**：主项目当前两文件与 W3 baseline 字节一致，M3 W3 是纯增量，无重复劳动。

## 待补（文档与打包层面，代码无需返工）

**两项必修**：

1. **补一段「JWT 验签与加密的区别」的事实说明**——任务书要求「说明」，但交件中全包零命中，连事实素材都没给（对比 i64::MAX 那题给了可核对事实，两题待遇不一致）。需给出可核对事实（HS256 是 HMAC 对称签名、签名提供完整性+来源认证但不提供机密性、载荷 base64url 未加密、持有密钥即可伪造等），**事实与个人理解分段**，不得让 AI 段落充当「我的理解」。
2. **补填姓名 / 学号 / AI 工具名称**，重新打包为 `M3_W3_<姓名>_20261104.zip`（当前「姓名」是未替换占位符；组员未编造，做法正确，但 M1 不能代填）。

**建议补**：① `fmt` / `clippy` 的完整原始输出（现 `01`/`04` 只有命令+退出码，缺 `Checking` 行与 warning 计数）；② 带 `exit_code` 的完整日志集（`00`/`05`/`06` 三份末行缺该行）；③ 统一「包内 baseline」口径（基线实际在任务包内，不在交件包内）；④ 修正 clippy 耗时数值（文档 `4.99s` vs 日志 `3.34s`）与「四项边界」计数（任务书实为 6 类）。

## 并入主项目（已完成 2026-11-09）

| 内容 | 位置 |
|---|---|
| 参数闸（DoS 防护）+ 14 条测试 | `src/auth/password.rs` |
| 空白 `sub` 加固 + 10 条测试 | `src/auth/token.rs` |
| **M1 接线**：阈值抽为 `VerifyLimits`，经 `AuthConfig` 注入登录路径（真实用户分支与虚拟哈希分支同一份 limits） | `src/auth/password.rs` / `src/routes/auth.rs` / `src/services/auth_service.rs` |
| `AuthConfig` 增 `Default` 实现，测试改用 `..Default::default()` | `src/routes/auth.rs` / 3 个测试文件 |

验证：`cargo fmt --check` 0 ｜ `cargo clippy --locked --all-targets -- -D warnings` 0 零警告 ｜ `cargo test --locked` **87 passed 0 failed**（原 72 + M3 的 14 + M1 的 1）。

并入前备份：`Temp/merge-backup-m3w3/`（可回滚）。

**待 M1 决策（未做）**：`TokenError::NotYetValid` 是否加 `validate_nbf` —— 属行为变更，不在 W3 范围。

## 复现方式

```powershell
Copy-Item -Recurse extracted\M3_W3_姓名_20261104\源码 C:\m3w3\proj
cd C:\m3w3\proj
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

> 本机 GNU 工具链（mingw-w64 链接器）不支持含中文的路径，Rust 编译/运行必须放在纯 ASCII 路径。
