# 本人 / AI / 各方操作记录与未完成项（M6 · W5）

> 用途：让本人、组员与审计能分清“谁做了什么”。本轮命令行操作由助手在本机（本人电脑）代执行，所有结果均可由 `logs/` 与 `SHA256清单.txt` 复核；**真实姓名、日期与手写签名仍由本人填写**。

## 1 本人操作（已完成 / 待完成）

| 项 | 状态 | 说明 |
|---|---|---|
| 提供任务包 `M6_W5_完整包.zip` | 已完成 | 附件交付给助手 |
| 选择执行方式（本人电脑直接执行） | 已完成 | 本地 Windows 环境 |
| **实际使用工具** | 已填写 | `豆包办公（桌面端）`；`PowerShell 7.6.4 (pwsh)`；`Node v22.23.2`；`npm 10.9.8`；`python 3.13`（用于清单核对与 diff 生成） |
| **复跑三条命令并核对日志计数** | 已执行（助手在本机代跑，本人提交前复核） | 见 §5；实际输出 `# tests 236 / # pass 236 / # fail 0`，与 `logs/regression_full.log` 一致 |
| **本人理解题作答** | 已拟稿（本人可改写后签名） | 见 `M6_W5_本人理解题.md`；答案区已写入，签名与日期留空 |
| **签名与真实姓名/日期** | 待本人填写 | 交件名需为 `M6_W5_真实姓名_实际日期.zip` |

## 2 AI 操作（本轮实际做了什么）

1. 解包 → 复制 `baseline/` 到独立工作副本 `<WORK>`（未在基线目录内改动任何文件）。
2. 核对解压内容：`tools/verify_manifest.py` → 109 条目 0 缺失 0 不符（`logs/manifest_verify.log`）。
3. 安装前端依赖（`npm ci`），先跑基线：204/204 通过（确认基线本身是绿的）。
4. 先映射既有用例（`api.test.js`、`api.http.test.js`、`drafts.test.js`、`drafts.gap.test.js`、`drafts.w4.test.js`、`sync.test.js`、`app.test.js` 等），只补缺口，新增 3 个用例文件共 32 个用例：
   - `api.w5.http.test.js`（9）：响应阶段可观察、非 JSON 错误体、错误正文断连、九类映射、挂起请求清理。
   - `drafts.w5.test.js`（16）：键/raw/读回值三处隔离、匿名、迟到回调、cancel 真取消、条件删除全分支。
   - `drafts.w5.integration.test.js`（7）：真实 `SyncEngine` + 注入存储 + 可控时钟，保存结果与草稿联动。
5. 写两个诊断脚本（不进测试套件）取证源码缺口：`probe_resolve_reload_storage.mjs`（F-01）、`probe_switch_doc_draft_loss.mjs`（F-03）。
6. 做四次定向变异，确认断言有鉴别力；每次还原后重新核对源文件 SHA256 与基线一致（`logs/mutation.log`）。
7. 全量复跑 236/236 通过（`logs/regression_full.log`），生成 diff、脱敏日志、本包文档与清单。

**AI 未做的事（明确边界）**：没有改 `api.js`/`drafts.js`/`sync.js`/`app.js` 与既有测试；没有实机点按页面；没有接触数据库/Rust；没有替本人签名，也没有替本人填姓名与日期。

## 3 M1 代修与既有贡献（非本轮）

- W4 的四处空断言按提示词由 M1 修入 `drafts.w4.test.js`；本轮**未改动该文件**，只在全量复跑中确认其为绿（计入 `logs/regression_full.log`）。
- `sync.js` / `app.js` 的既有实现属于 M1 范围；本轮只读、只测、只报缺口（F-01、F-03）。

## 4 审计复跑

未执行（本轮无第三方审计角色）。本人复跑后请把命令与输出追加到 §5，并注明“审计/本人”身份。

## 5 复跑步骤（本人执行，逐条留证）

工作副本目录：`<WORK>`（本包内 `work/`）。全部命令在 `<WORK>/frontend` 下执行。

```powershell
# 0. 环境
node --version      # 期望 v22.x
npm --version

# 1. 依赖（首次或换机后）
npm ci --no-audit --no-fund

# 2. 全量（期望 # tests 236 / # pass 236 / # fail 0，退出码 0）
node --test "js/tests/*.test.js"

# 3. 分项（期望 9 / 16 / 7，均退出码 0）
node --test js/tests/api.w5.http.test.js
node --test js/tests/drafts.w5.test.js
node --test js/tests/drafts.w5.integration.test.js

# 4. 缺口取证（期望两条结论各 1 条，退出码 0）
node tools/probe_resolve_reload_storage.mjs
node tools/probe_switch_doc_draft_loss.mjs

# 5. 断言鉴别力（会自动还原源文件，末次全量应为 236/236）
pwsh -NoProfile -File ../tools/mutation_check.ps1
```

核对要点：① 计数与本包 `logs/` 一致；② `git` 不可用时以 `交付/M6_W5.diff.patch` 与 `SHA256清单.txt` 核对源码指纹；③ 变异脚本跑完必须核对 `api.js`/`drafts.js` 已还原（脚本会打印“与基线一致 = True”）。

## 6 未完成项（含受影响的验收项与复跑入口）

| # | 未完成项 | 影响的验收 | 原因 | 复跑/补齐入口 |
|---|---|---|---|---|
| 1 | 本人复跑、理解题作答、签名、填真实姓名与日期 | 全部（形式要件） | 按任务书留给本人 | §5；`M6_W5_本人理解题.md` |
| 2 | 与 M5 的“事件—可见状态”实机核对 | M6-W5-04 部分 | 本轮无浏览器 GUI 与后端联调 | 交接表 §4 清单 + §5 复跑入口 |
| 3 | 真实断网/恢复（拔网线、切网） | W5-03 失败/重试的“真实链路”部分 | 只做了模拟层（注入 fetch/可控时钟） | 交接表 §5 |
| 4 | F-01 修复（`resolveReload` 传 `this.storage`） | “恢复后无残留”的端到端结论 | 属 M1 范围，M6 不改 sync.js | 交接表 §6 F-01；修后补一条走 `engine.resolveReload()` 的用例 |
| 5 | F-03 修复（切文档前 flush 待写草稿） | W5-02“等待中的写入”在真实切文档路径上的完整性 | 同上 | 交接表 §6 F-03；修后补“切文档前 flush”用例 |
| 6 | Rust / PostgreSQL 相关检查 | 不在 W5 范围 | 本机无 cargo、无 PG17 | `docs/LOCAL_POSTGRES.md`、`.github/workflows/ci.yml` |
| 7 | 交件改名 `M6_W5_真实姓名_20261118.zip` | 形式要件 | 不知道本人真实姓名 | 解压后改名即可，内容无需变动 |

## 7 本包的自检（交件前已做）

1. 排除项已清理：`.env`、凭据、`.git`、`target`、`node_modules`、`logs/_raw/`（未脱敏原始日志只留本机）。
2. 路径可复原：解压后 `work/` 即工作副本，可直接 `npm ci && node --test`。
3. 计数自洽：基线 204 + 新增 32 = 236。
4. 指纹自洽：`SHA256清单.txt` 覆盖本包全部交付文件；`M6_W5.diff.patch` 只含新增文件。
