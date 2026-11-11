# M6 W4 交付包说明（README）

本包是 M6 模块（前端草稿层 `drafts.js` + API 客户端）第 4 周提交。

## 1. 我做了什么

| 需求 | 结论 |
|---|---|
| M6-01 三元键隔离 | 沿用旧用例 + 新增 5 项（两账号同文档、同账号多文档/多会话、列表不泄露、键与记录身份逐段篡改）→ 全通过 |
| M6-02 存储语义与落盘形态 | 沿用 + 新增 6 项（quota/unavailable/corrupt/serialize、camelCase→snake_case、7 种非法版本修订日期）→ 全通过 |
| M6-03 条件删除与清理范围 | 沿用 + 新增 8 项（三项**逐项单独**篡改、清理五条记录隔离、点名当前会话仍不删、缓冲顺序）→ 全通过 |
| M6-04 250ms 合并写入 | **发现并修复真实缺陷**（取消路径写死全局 `clearTimeout`），新增 6 项用例；修复后 25/25 |
| M6-05 R1/R2/R3 复核 + 阶段定向变异 | 真实 HTTP 17/17 ×10 稳定；副本变异精确检出 2 项目标用例并还原核验；text/html 分类口径冲突已记录、未改协议 |
| M6-06 调用样例 | `证据/call_samples.mjs` 实跑 7 组返回值，含“保存抛错不得显示成功”的反例 |

数字：基线 **137/137** → 全量 **162/162**（0 失败、0 跳过、exit 0，连续 3 次一致）；真实 HTTP 17/17 ×10（最慢 286.4ms）。

## 2. 怎么跑（从本包解压后）

```powershell
cd 源码\frontend
npm ci
npm test                                   # 期望 162 通过 / 0 失败
node --test js/tests/drafts.w4.test.js     # 期望 25/25
node --test js/tests/api.http.test.js      # 期望 17/17（真实 127.0.0.1 服务）
node ../../证据/call_samples.mjs           # 7 组真实返回值
pwsh -NoProfile -File ../../证据/mutation_n1.ps1   # 只在副本做变异，含还原校验
```

依赖：Node ≥ 22（实测 v22.23.2）、npm 10（实测 10.9.8）。无需浏览器、数据库、Rust 工具链即可跑测试。

两个证据脚本会按自身位置找源码（`证据/call_samples.mjs` 用 `import.meta.url`、`证据/mutation_n1.ps1` 用 `$PSScriptRoot`），所以在包里直接跑即可，不需要改路径。

## 3. 改了哪些文件

| 文件 | 变化 |
|---|---|
| `源码/frontend/js/drafts.js` | +7 / −3 行：`createDraftWriter` 新增**可选** `clearDelay`；`flush/flushAll/cancel` 改走它。不传时行为与基线一致 |
| `源码/frontend/js/tests/drafts.w4.test.js` | 新增 25 项用例（独立文件，旧测试字节未动） |

**未改**：`api.js`、`api.http.test.js`、`drafts.test.js`、`sync.js`（M1）、`app.js`、`editor.js`（M5）、HTML/CSS、后端、迁移、冻结文档（`docs/`）。

## 4. 目录导览

| 路径 | 内容 |
|---|---|
| `检查记录.md` | 每条验收的命令、原始输出、退出码、未执行项、AI/本人分工、可重跑脚本 |
| `逐项验收表.md` | M6-01～06 逐行：依据、已有/新增用例、实际结果、证据路径 |
| `交付检查表.md` | 按包内模板逐行填写 |
| `契约冲突记录.md` | 3 处原文冲突（text/html 分类、三分支/四分支、isFinite/integer）+ 最小候选 |
| `M1交接表.md` | 接口、真实返回值、**先 flush/cancel 再清理**的顺序约束、文案禁令 |
| `调用样例.md` | 可直接复制的调用样例（成功/失败/删除拒绝/清理/写入器/键） |
| `变更清单.md` | 逐文件 SHA256 与差异说明 |
| `diff/drafts.js.diff` | 54 行统一差异 |
| `日志/00…08` | 基线、红、绿、全量、真实 HTTP、变异（2 份）、稳定性、缓冲顺序、调用样例 |
| `证据/` | `mutation_n1.ps1`、`probe_buffers.mjs`、`call_samples.mjs` |

## 5. 没做的事（如实标注）

- **Rust `cargo test`**：本机无 cargo。
- **PostgreSQL 迁移回归**：本机无 psql/实例。
- **真实浏览器 localStorage 持久化**：无可自动化的浏览器会话（未提供伪造截图）。
- **真实后端 `/documents` 联调**：路由未实现，属 M1 阶段 4。
- **真实 10 秒等待**：按 `SYNC.md` §13 用可控时钟替代，鉴别力由变异证明。
- **更多变异**：任务书要求只做一项。

详见 `检查记录.md` §8。

## 6. 需要本人补的三件事

1. 核对姓名/学号，填本周实际 AI 版本（`交付说明.md` 身份栏）。
2. 亲自跑一次 `npm test` 并把输出贴进 `交付说明.md` 的“本人操作”栏。
3. 与 M1 确认 `契约冲突记录.md` 冲突 1（text/html 错误体分类）的最终口径。
