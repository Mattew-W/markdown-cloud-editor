# M6 W2 集成记录：`api.js` 合入主项目

**日期**：2026-10-26　**执行**：M1（WorkBuddy 代修）　**交件**：吴泽佳 `M6_W2_吴泽佳2026.10.26.zip`

---

## 一、结论

M6 W2 的**设计**（接口签名、九类错误码映射、204 处理、超时控制）经核对**完全符合冻结契约** `docs/INTERFACES.md` §C8 与 `docs/API.md` §4.1。

**交件本身不可运行**（23 个用例全挂），已由 M1 修复后合入主项目：

| 路径 | 说明 | 行数 |
|---|---|---|
| `frontend/js/api.js` | API 客户端正式实现 | 约 350 |
| `frontend/js/tests/api.test.js` | Node 内置测试 | 43 项 |

**实测**：`node --test frontend/js/tests/api.test.js frontend/js/tests/drafts.test.js` → **90 通过 / 0 失败**（api 43 + drafts 47，无回归）。

---

## 二、修复的四类缺陷

| # | 缺陷 | 位置 | 修法 |
|---|---|---|---|
| 1 | **U+2011 非断行连字符污染** | 交件 `api.js:100/138/168` | 全部替换为 ASCII `-`；并新增 ASCII 守卫测试 |
| 2 | **`node:test` 导入不存在的 `assert`** | 交件 `api.test.js:1` | 改为 `import { test, describe } from 'node:test'` + `import assert from 'node:assert/strict'` |
| 3 | **URL 构造发往 `dummy-base` 外域** | 交件 `api.js:80` | 改为相对路径直传 `fetch`，由浏览器按页面 origin 解析 |
| 4 | **Content-Type 正则漏 `+json`** | 交件 `api.js:140` | 改为 `/^application\/(?:json\|[a-z0-9!#$&^_.+-]*\+json)\b/` |

### 缺陷 3 的实测证据

真实 Chromium 149 实测原实现：

```
api.js 构造出的绝对 URL : http://dummy-base/api/v1/documents
fetch 实际结果: "Failed to fetch"
捕获到的请求:
   GET http://dummy-base/api/v1/documents (失败: net::ERR_NAME_NOT_RESOLVED)
```

**原测试 `assert.equal(input.pathname, ...)` 之所以"看起来对"**，是因为 mock 拿到 URL 对象、`.pathname` 恰好正确——**mock 验的是拼接，不是最终目的地**。这正是「Mock 不得访问真实后端」条款的盲区。

---

## 三、正式实现相对交件的三处增强

除修复缺陷外，按 `docs/INTERFACES.md` §C8 与项目规范 §09/§10 补强：

| 增强 | 依据 | 说明 |
|---|---|---|
| **错误文案一律中文** | 项目规范 §10 | 交件把 `e.message` 透给用户（`network fail: socket drop`）。正式版全部改为固定中文文案，不透出原始异常 |
| **模块头注释写明六条硬约束与两条禁令** | INTERFACES.md §C8 | 含"相对路径禁令"与"协议字面量 ASCII 禁令"，防止后续被改回错误写法 |
| **新增 ASCII 守卫测试（3 项）** | 本次事故 | ①协议标识符字面量必须纯 ASCII ②运行时验证标准头名可用 ③运行时验证非 ASCII 头名必抛错 |

第 ③ 项是刻意写的**反证测试**：证明含 U+2011 的头名必然抛 `TypeError`，让守卫本身可被验证，而不是一条无法证伪的规则。

---

## 四、ASCII 守卫的设计说明

第一版守卫写得太宽，把**中文错误文案**也判成了违规。中文文案是规范明确要求的，不该拦。收窄后的规则只检查**协议标识符位置**：

```js
/headers\.set\(\s*'([^']*)'/g    // 头名
/headers\.get\(\s*'([^']*)'/g    // 头名
/'([A-Z][A-Z_]{2,})'/g           // 错误码字面量
/'application\/[^']*'/g          // Content-Type 匹配串
```

这样既拦得住真正致命的污染（头名、错误码），又不会误伤中文文案和注释里的破折号。

---

## 五、与主项目现有约定的对齐

| 约定 | `frontend/js/drafts.js` | 本次 `frontend/js/api.js` |
|---|---|---|
| 位置 | `frontend/js/` | `frontend/js/` ✅ |
| 测试位置 | `frontend/js/tests/` | `frontend/js/tests/` ✅ |
| 测试框架 | `node:test` + `node:assert/strict` | 同 ✅ |
| 模块形式 | ES Module + 具名 export | 同 ✅ |
| 契约来源注释 | 引用 `docs/INTERFACES.md` 章节号 | 引用 §C8 + `docs/API.md` ✅ |
| 中文错误文案 | 是 | 是 ✅ |
| `base URL` 单一常量 | — | `BASE_URL` ✅（C8 要求不硬编码在多个文件） |

**未新增 `package.json`**：根目录目前无 `package.json`，`docs/INTERFACES.md` §4.5 规定「M5 的 `frontend/package.json` 与 `npm test` 脚本须先就位，否则 M6 无处跑测试」。**本模块测试用 `node --test` 直接跑，不依赖 npm 脚本**，因此不抢先创建，避免与 M5 产生两份 `package.json`——那正是 INTERFACES.md 明确禁止的。

---

## 六、明确的边界

**本次未做（属 M1 集成期，INTERFACES.md §4.4）**

- 与真实后端联调——`/documents` 路由尚未实现（`docs/API.md` §8 标注为阶段 4，依赖 M4 的 document service）。**本轮只验证了真实浏览器中的 URL 解析行为，未验证真实 HTTP 往返。**
- `sync.js` 接线、遗留草稿选择界面、退出账号提示、Markdown 下载兜底

**本次新增的接口暴露**

- `BASE_URL` / `TIMEOUT_MS` / 11 个错误类 / `apiFetch`，共 14 个具名导出。**与冻结契约 §C8 一致，未超出。**

---

## 七、待办

| # | 事项 | 归属 | 状态 |
|---|---|---|---|
| 1 | M6 本人复现并理解四个缺陷 | M6 | **待办**——M1 代修不能替代本人理解 |
| 2 | 补 `README.md` 接口说明（交件中的 `readme.md` 内容被截断） | M6 | **待办** |
| 3 | `阶段记录.md` 按任务书格式重写 | M6 | **待办** |
| 4 | `frontend/package.json` 与 `npm test` 脚本 | M5 | 待 M5 就位 |
| 5 | `api.js` 与 `sync.js` 接线 | M1 | 阶段 4 |
| 6 | 与真实后端联调 | M1 | 待 `/documents` 路由实现 |

第 1 项仍需完成。**M1 代修解决了"代码不可用"，但组员对四个缺陷的理解只能由本人复现获得**——尤其缺陷 1（AI 生成的字符污染）与缺陷 3（mock 掩盖真实目的地），这两条不撞一次下次还会犯。

---

**相关**
- `GPT_WORKSPACE/deliverables/收件/W2/M6/M6_W2_审核记录.md` — 交件审核
- `GPT_WORKSPACE/deliverables/收件/W2/M6/归因记录_提示词vs执行.md` — 归因分析
- `docs/INTERFACES.md` §C8 — 冻结契约
- `docs/API.md` §4.1 — HTTP 错误契约
