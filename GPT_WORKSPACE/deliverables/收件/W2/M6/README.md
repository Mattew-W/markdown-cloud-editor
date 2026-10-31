# M6 W2 收件与完成记录

**成员**：吴泽佳（24406040201）　**收件日期**：2026-10-26
**最终状态**：✅ **已完成并合入主项目**（M1 代修 + 补全，M2 代返工方案）

---

## 目录内容

| 路径 | 说明 |
|---|---|
| `M6_W2_吴泽佳_20261026.zip` | 组员原始交件（留证） |
| `extracted/` | 原件解压（6 文件）——审阅对象，勿改 |
| `M6_W2_审核记录.md` | 交件审核：四个致命缺陷、应予肯定的部分、覆盖缺口 |
| `归因记录_提示词vs执行.md` | 归因分析：提示词 vs 执行 vs 机制 |
| `集成记录_api.js合入主项目.md` | 集成说明：修了什么、增强了什么、对齐了哪些约定 |
| `检查记录.md` | **任务书阶段4 要求的检查记录**（动作+输出+断言成对，8 条未执行项清单） |
| `交付说明.txt` | **任务书阶段4 要求的交付说明**（含三问解释） |

**合入主项目的文件**（不在本目录，在 `frontend/`）：

| 路径 | 说明 |
|---|---|
| `frontend/js/api.js` | API 客户端实现 |
| `frontend/js/tests/api.test.js` | Node 内置测试（50 项） |
| `frontend/js/README.md` | 接口说明 |
| `frontend/js/evidence_probe.mjs` | 逐例取证脚本 |
| `frontend/package.json` | 前端工具链与 npm 脚本 |
| `frontend/run_tests.mjs` | 生成真实 TAP 日志 |

---

## 交件审核结论

**设计质量显著高于 W1**：零 DOM、错误分类、204 处理、超时控制、接口签名全部对路；九类 `error.code` 映射与冻结协议 `API.md` **9/9 完全一致**。

**但交件当时完全跑不起来**——实测 `node --test tests/api.test.js`：

```
# tests 23
# pass 0
# fail 23
```

**23 项全部失败**，而组员记录写的是 `pass 1 / fail 0`。该输出与本交件不对应（`tests 1` 是把整个文件当 1 个测试的形态），不作为验收证据。

### 四个致命缺陷

| # | 缺陷 | 位置 | 后果 |
|---|---|---|---|
| 1 | **U+2011 非断行连字符** | `api.js:100/138/168` | `TypeError: ...value of 8209`，所有请求在构造 header 阶段即崩 |
| 2 | **`node:test` 导入不存在的 `assert`** | `api.test.js:1` | 23 个用例全部 `assert.deepEqual is not a function` |
| 3 | **URL 构造发往不存在外域** | `api.js:80` | `new URL(path, 'http://dummy-base')` → 实测 `ERR_NAME_NOT_RESOLVED`，真实后端永远收不到请求 |
| 4 | **Content-Type 正则漏 `+json`** | `api.js:140` | `application/vnd.api+json` 不匹配，协议明确要求支持 |

缺陷 1、2 在语法检查下完全合法（`node --check` 通过），**只有真跑才暴露**。

> 缺陷 3 的隐蔽性：原测试 `assert.equal(input.pathname, ...)` 之所以"看起来对"，是因为 mock 拿到 URL 对象、`.pathname` 恰好正确——**测试写法掩盖了真实缺陷**。这正是「Mock 不得访问真实后端」条款的盲区。

---

## 归因结论

**提示词方法论无问题，失败在执行与证据链。**

| 缺陷 | 提示词是否已写明 | 归因 |
|---|---|---|
| U+2011 | **未提及** | 提示词真实缺口 → 已补 **M6-R8** |
| assert 导入 | 未指明来源 | 执行方（Node 常识） |
| URL `dummy-base` | **已写明**「相对路径/禁止外域URL/统一拼接一次」 | 执行方（直接违反）→ 已补 **M6-R9** |
| Content-Type `+json` | **已写明**「支持 application/*+json」 | 执行方（直接违反） |

**横向对照**：M3 同样用豆包，W1 验证达标率 **83.3%** vs M6 **28.6%**。同方法论、同 AI，差异在执行不在描述。

**根因**：W1/W2 两次同构失败（功能基本正确 + 记录与交付物不对应），提示词里六条防作弊条款全部未执行——**规则没有强制力**。

**已回写** `prompt-guides/M6/README.md`：新增 M6-R8（ASCII 校验）、M6-R9（禁假 base URL）、M6-R10（记录须能复跑复现）。

---

## 最终交付状态

### 任务书阶段4 的七类交付物 —— 7/7 齐全

| 要求 | 位置 |
|---|---|
| `package.json` | `frontend/package.json` |
| `js/api.js` | `frontend/js/api.js` |
| `tests/api.test.js` | `frontend/js/tests/api.test.js` |
| `README.md` 接口说明 | `frontend/js/README.md` |
| `检查记录.md` | 本目录 |
| `交付说明.txt` | 本目录 |
| 日志 | `frontend/test-output.log`（`npm run test:log` 生成，已入 `.gitignore`） |

### 测试

```
> cd frontend && npm test
# tests 97
# suites 7
# pass 97
# fail 0
```

97 = api 50 + drafts 47，无回归。

### 相对交件的增强

| 增强 | 依据 |
|---|---|
| `request_id` 优先取响应体，缺失回落 `X-Request-Id` 头 | `API.md` §4.1（该头用于排障，无回落则无法排障） |
| 2xx 边界：仅 204 特判返回 `null`，202/206 等按 `API.md` §1 解析 JSON | 契约原文 |
| 错误文案一律中文，不透出 JS 异常的 `e.message` | 项目规范 §10 |
| 模块头写明六条硬约束 + 相对路径禁令 + ASCII 禁令 | 防止后续被改回错误写法 |
| ASCII 守卫测试 3 项，含**反证测试**（证明含 U+2011 的头名必抛 `TypeError`） | 本次事故 |

### 与主项目约定的对齐

位置 `frontend/js/`、测试 `frontend/js/tests/`、`node:test` + `node:assert/strict`、ES Module 具名导出、模块头引用 `docs/INTERFACES.md` §C8 章节号。

**`frontend/package.json` 由 M1 建立**（M5 未交 W2，无人创建）。按 `INTERFACES.md` §4.5，M5 后续**在此文件追加**脚本，**不得新建第二份**。

---

## 复跑验证

```sh
# 原交件（复现失败）
cd extracted && node --test tests/api.test.js
# → tests 23 / pass 0 / fail 23

# 合入主项目（可运行）
cd ../../../../../frontend && npm test
# → tests 97 / pass 97 / fail 0
```

**环境**：Node v22.22.2 / Chromium 149.0.7827.55 headless

---

## 未执行项（8 条，详见《检查记录.md》§4）

与真实 Rust 后端联调（`/documents` 路由尚未实现）、真实浏览器完整 API 往返、ESLint/Prettier（本机无网络）、Safari/Firefox/Edge/WebView 兼容性、真实网络下 10 秒超时、Playwright E2E、真实 IME 输入、真实配额耗尽。

**均已如实列出，无「未执行项：无」写法。**

---

## 仍可考虑的后续

| # | 事项 | 归属 |
|---|---|---|
| 1 | 组员本人复现并理解四个缺陷 | M6 —— **代修不能替代本人理解** |
| 2 | `api.js` 与 `sync.js` 接线 | M1（阶段 4） |
| 3 | 与真实后端联调 | M1（待 `/documents` 路由实现） |
| 4 | `frontend/package.json` 脚本合并 | M5（**追加，不新建**） |
