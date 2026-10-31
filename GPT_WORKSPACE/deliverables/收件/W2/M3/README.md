# M3 W2 收件目录

- 成员：M3 ｜ 周次：W2 ｜ 收件日期：2026-10-29
- 原包：`M3-W2.zip`（保存在微信原文件目录，未移动/未改名）
- 审计结论：**接收，已并入主项目 `src/auth/token.rs`（2026-10-30）**
- 核心价值：修复了**主项目中依然存在**的两处 JWT 缺陷（TTL 溢出 panic、空 sub 被接受）
- 并入结果：单测 66 → **72 passed / 0 failed**，`cargo fmt --check` 0、`cargo clippy --all-targets -- -D warnings` 0

## 目录内容

| 路径 | 说明 |
|---|---|
| `M3_W2_审核记录.md` | 完整审计记录（diff 比对、实际运行、反向回退验证、并入主项目实证、问题清单） |
| `extracted/M3-W2/` | 原包核心文件解压副本（已排除 `target/`，13 个文件） |
| `_unzip_audit.py` | 解压脚本（过滤 target/、处理 cp437/GBK 文件名、输出 SHA256） |
| `_diff_baseline.py` | 与下发基线 `materials/M3/token.rs` 的逐行 diff 脚本 |

## 审计要点

- **自述与实物一致**：与下发基线逐行 diff，仅 2 处修复 + 5 个新测试 + fmt 排序，无隐藏改动
- **日志为真**：回退两处修复重跑，同样 2 项失败、同样 chrono `lib.rs:717:17` panic 位置、11 passed / 2 failed，与组员 pre-fix 日志逐字吻合
- **已并入主项目**：主项目 `src/auth/token.rs` 应用修复 + 测试后 **72 单测全绿**、clippy 零警告、fmt 通过；并入后再次回退验证，3 项失败、其余 11 项通过，证明测试真正锁住缺陷
- **M1 一处加固**：M3 的 TTL 修复在 `ttl_secs == i64::MAX` 时仍会 panic（`Duration::seconds` 先于 `checked_add_signed` 求值），M1 改用 `Duration::try_seconds` 并补第 6 个边界测试（详见审核记录 §5.2）

## 必修项（仅打包操作，代码无需返工）

1. 排除 `target/` 后重新打包（原包 245 MB 中 1084 条为编译产物）
2. 按 `M3_W2_姓名_实际日期_v2.zip` 命名
3. 填写姓名 / 学号

> M1 的加固已在主项目侧完成，**不要求 M3 自行修补**。

## 并入主项目注意

- 已采用 `extracted/M3-W2/jwt_review/src/token.rs` 中的两处修复，依赖无需改动
- **不要**拷贝 `jwt_review/.cargo/config.toml`（rsproxy 镜像，主项目已有自己的 `.cargo/config.toml`）

## 复现方式

```powershell
Copy-Item -Recurse extracted\M3-W2\jwt_review C:\m3w2\jwt_review
cd C:\m3w2\jwt_review
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

> 本机 GNU 工具链（mingw-w64 链接器）不支持含中文的路径，Rust 编译/运行必须放在纯 ASCII 路径。
