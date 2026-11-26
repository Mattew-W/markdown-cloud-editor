# evidence/ —— M1 补充实测证据（**非 M5 本人产出**）

- **产出人**：M1（架构方）
- **产出日期**：2026-11-26
- **用途**：补齐 M5 W6 交付中被审计指出「只有源码/DOM 测试、缺真实页面证据」的三处验收点。
- **重要声明**：本目录全部内容由 **M1 用 Chrome CDP 在本机实测生成**，
  **不计入 M5 本人成果**，也不替代任务书要求 M5 本人完成的「真实中文 IME 录屏」。
- **环境**：Chrome 158.0.8127.37（headless=new）+ Windows；静态服务由探针脚本内置（127.0.0.1 随机端口）；
  `window.innerWidth/innerHeight = 1200×900`，`outerWidth/outerHeight = 1200×900`，`devicePixelRatio = 1`。

## 目录

```
evidence/
├─ probes/
│  ├─ probe_t13_dom_state.mjs      T13：焦点 / 选区 / 节点身份的 DOM 实测
│  ├─ probe_visible_states.mjs     可见状态：未同步 / 已同步 / dirty / 等待重试 / 冲突 / 本地备份失败
│  └─ probe_conflict_versions.mjs  冲突两按钮：覆盖与重载分别落到哪个版本
├─ probe_t13_dom_state.json        T13 原始测量结果
├─ states/                         可见状态截图 6 张 + states.json 原始读数
└─ conflict/                       冲突弹窗与两按钮结果截图 4 张 + conflict.json 原始请求记录
```

## 一、T13 焦点 / 选区 / 光标（`probe_t13_dom_state.json`）

被测对象是**固定基线 `3373a9e8` 的真实 `index.html`**，在 Chrome 中打开后由 CDP 注入输入并读取 DOM 状态。

| 观察点 | 实测值 |
| --- | --- |
| 输入前焦点 | `document.activeElement.id === "docContent"` |
| 输入前选区 | `selectionStart = 8`，`selectionEnd = 15` |
| 触发 `input` 事件（会重渲染预览）后焦点 | 仍为 `docContent` |
| 触发 `input` 后选区 | **`selectionStart = 8`，`selectionEnd = 15`（未变）** |
| 输入后节点身份 | `document.getElementById("docContent") === 原节点` → `true`（未重建） |
| 输入后预览是否含 `script` | `false` |
| 合成 `compositionstart → update → end` 期间焦点 | 仍为 `docContent` |
| 合成分结束后选区 | `27 / 27`，节点仍为同一节点，值尾部「中文」已上屏 |
| 7 种状态轮换期间节点身份 | 全部 `sameNode = true` |
| 7 种状态轮换期间选区 | 全部保持 `5 / 11` 不变 |
| 标题框注入 `<img src=x onerror=alert(9)>` | `input.value === 原串`（纯文本保留）、`childElementCount = 0`、预览无 `[onerror]` |

**必须说明的边界**：上表的 composition 事件是 **CDP 合成的 `CompositionEvent`，不是真实中文输入法**。
它只能证明「DOM 层在组合态期间不重建节点、不改选区」，**不能代替任务书要求的真实 IME 录屏**。
真实 IME 的组合开始/上屏两帧，仍以 M5 原交付的 3 张截图为准；**保存全过程与真实 IME 录屏仍待本人补**。

## 二、可见状态（`states/states.json` + 6 张截图）

用**同源 mock API**（探针脚本内置 `/api/v1/*` 路由）驱动 `app.js` 的真实代码路径，
不是给 DOM 打桩。实测六种状态：

| 截图 | 触发方式 | 徽标 | 状态栏 | 选区是否保持 |
| --- | --- | --- | --- | --- |
| `01_首屏_未同步.png` | 打开页面未登录 | `未同步` | `系统就绪` | — |
| `02_登录后_文档打开.png` | mock 登录 + 取文档 | `✓ 已同步` | `所有更改已同步至云端` | — |
| `03_dirty_有未保存修改.png` | 输入触发 `onInput` | `• 等待本地备份` | `正在准备本地草稿` | 6 / 12 |
| `04_等待重试_429.png` | PUT 返回 429 + `Retry-After: 3` | `⚠️ 等待重试` | `错误: 请求过于频繁` | **6 / 12 保持** |
| `05_版本冲突_409.png` | PUT 返回 409 `VERSION_CONFLICT(server_version=7)` | `✕ 版本冲突` | `检测到并发编辑冲突`，弹窗 `v7 / v5` | **6 / 12 保持** |
| `06_本地备份失败.png` | `localStorage.setItem` 抛 `QuotaExceededError` | （见下） | `本地备份失败：存储空间不足` | 23 / 23 |

**两点值得记录**：

1. **存储失败文案已符合 `INTERFACES.md` §2.5 冻结文案**：横幅显示
   「本地备份失败：存储空间不足。内容目前只在内存中，请立即下载 Markdown，或保持页面不关闭。」
   ——W5 审计提的冲突 C-1（原先是「本地备份失败（quota）」带英文 reason 码）**在基线 `3373a9e8` 已闭合**。
2. **`06` 图中徽标仍显示「✕ 版本冲突」是正确行为，不是缺陷**：按 `INTERFACES.md`，
   本地备份失败与云端同步状态**正交**，前者不覆盖后者。截图前的步骤确实处于未解决的冲突态，
   因此徽标保持不变、只弹出存储失败横幅，正是设计意图。

**局限**：`06` 图的徽标不是「干净状态下的存储失败」，因为探针没有先消化上一个冲突。
存储失败横幅、状态栏文案、选区保持三项不受影响。

## 三、冲突两按钮落到预期版本（`conflict/conflict.json` + 4 张截图）

mock 服务在 409 时给 `server_version = 7`，本地基线为 `v5`。

**强制覆盖**（点 `btnConflictOverwrite`）：

```
PUT /api/v1/documents/doc-1
{ "title": "冲突复核", "content": "…本地修改后的正文。", "expected_version": 7 }
```

→ `expected_version` 取的是**服务端版本 7**，不是本地基线 5；PUT 成功后弹窗关闭、
徽标转 `✓ 已同步`、`版本: v8`。**落到预期版本，符合 `SYNC.md` §6.2。**

**重新载入**（点 `btnConflictReload`）：

```
GET /api/v1/documents/doc-1        ← 先拉云端
PUT … { "expected_version": 8 }    ← 随后仍自动保存了一次本地内容
```

→ UI 侧弹窗关闭、状态栏 `已采用云端版本`、编辑区内容变为云端正文、`版本: v9`。
GET 拉云端、UI 切云端内容、版本前推，这三项符合预期。

**一处需真实后端复核的观察（不是 M5 缺陷，属同步逻辑）**：
重载路径记录到「GET 之后仍有一次 PUT」。探针的 mock 在 GET 时硬编码返回云端正文、
不做服务端侧写入，因此无法判断这次 PUT 是否会把本地内容覆盖回云端。
**这属于 `sync.js` 的时序问题，应由 M6 / M1 在真实后端上复核**，
不建议据本文结论认定或否定任何一方。原始请求序列见 `conflict.json`。

## 四、复现方式

```powershell
# 依赖：Node 22、Chrome（默认路径 C:\Program Files\Google\Chrome\Application\chrome.exe）
# 把三个探针脚本内的 FE 常量指向本包 frontend/ 的绝对路径，然后：
node evidence/probes/probe_t13_dom_state.mjs
node evidence/probes/probe_visible_states.mjs
node evidence/probes/probe_conflict_versions.mjs
```

三个脚本都会：内置静态服务 → 启动 headless Chrome → 通过 CDP 注入并读取 →
输出 JSON 与 PNG。**不依赖外部 npm 包**（只用 Node 内置 `http`、`fs` 与全局 `WebSocket`）。
