# M5 W4 — Markdown 编辑器冲突 / 异常状态 UI 反馈候选

## 1. 这是什么

本目录是 M5（前端 UI）在 W4 交付的**纯 UI 反馈层候选**：在现有 editor 与三栏页面之上，补齐七种同步状态、本地备份失败提示、错误归类与版本冲突选择弹窗的界面与验收；沿用既有三栏响应式布局，不从零重做页面，也不接管同步状态机。

- 基线：`baseline/`（本地工作树候选快照，HEAD `c919eb35acd56e90f69ff2472f99ad642f80289c`，含未提交/未跟踪，未声称已合并或验收通过）。
- 本候选在复制出的 work 副本内修改，**不覆盖 baseline / reference**；与 M1 的接线由 `M1交接表.md` 说明。
- 本周范围**不包含**：同步状态机、网络层、草稿层、后端、真实云保存与端到端联调。

## 2. 目录结构

```
M5_W4_刘欣怡_261111/
├── frontend/                    # 可被 M1 集成的前端候选（无 node_modules）
│   ├── index.html               # 页面入口；冲突四选项、存储失败条、兼容桩
│   ├── package.json             # 保留基线包名与全部 scripts
│   ├── package-lock.json        # 与 package.json 匹配的 lock
│   ├── run_tests.mjs            # 生成 TAP 日志
│   ├── css/style.css            # 三栏布局、900/600 断点、状态/弹窗样式
│   ├── js/
│   │   ├── editor.js            # 冻结编辑器契约（沿用，本周未改）
│   │   ├── ui-feedback.js       # 本周新增：纯 UI 反馈层
│   │   ├── app.js / sync.js / api.js / drafts.js   # 沿用，本周未改
│   │   └── tests/
│   │       ├── ui-feedback.test.js        # 状态/失败条/错误/冲突弹窗（19）
│   │       ├── editor.dom.test.js         # DOM 稳定性补强（5）
│   │       ├── editor.security.w4.test.js # 安全 DOM 分开测 + 版本闭环（4）
│   │       └── （基线既有测试沿用）
│   └── vendor/                  # 本地托管 marked 12.0.2、DOMPurify 3.3.3
├── 检查记录.md          # 逐项 M5-01~06 对照、环境/测试/未执行项
├── 交付检查表.md        # 交付模板：M5-01~06 逐行证据，执行者/本人理解待本人填
├── 变更清单.md          # 新增 / 修改 / 未改文件与测试计数
├── M1交接表.md          # UI 输入/事件接口表与待接线动作
├── 版本对照表.md        # package.json / lock / node_modules / vendor 四方版本
├── 截图索引.md          # 截图来源、动作、真实视口与结论
├── 交付说明.txt         # 身份、AI 工具、本人/AI 分工、排除项
├── screenshots/          # 本周浏览器截图（仅已采集档位）
└── logs/                # 安装/测试原始 TAP 日志与基线哈希校验
```

## 3. 范围边界

**允许修改**：`frontend/index.html`、`frontend/css/`、`js/editor.js`（仅必要修复，本周未改）、新增 `js/ui-feedback.js` 与对应 UI 测试。

**未直接修改**：`app.js`（M1 总控）、`sync.js`（状态机）、`api.js`（网络层）、`drafts.js`（草稿层）。

`ui-feedback.js` 只接收上层传入的状态与错误、把用户选择上抛；不读取编辑器内容、不发网络请求、不自增版本号、不清草稿、不维护第二份文档状态。

## 4. 如何运行

### 4.1 环境要求
- Node.js **>= 22**（验证使用 v22.23.2）
- npm 10.x（验证使用 10.9.8）

### 4.2 安装依赖
```sh
npm ci
```

### 4.3 运行测试
```sh
npm test        # node --test "js/tests/*.test.js"，全量 165 pass / 0 fail
npm run test:log
```

### 4.4 本地打开页面
页面使用 ES Module，必须通过本地 HTTP 服务（不能双击 `file://`）：
```sh
# 在 frontend/ 目录任选一种静态服务，例如
python -m http.server 8090 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8090/
```

## 5. 依赖与版本

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| marked | 12.0.2 | Markdown 解析；运行时 vendor，测试 npm 包 |
| DOMPurify | 3.3.3 | HTML 净化；运行时 vendor，测试 npm 包 |
| jsdom | ^30.1.3（实测 30.1.3） | 仅测试环境 DOM |

四方版本对照见 `版本对照表.md`；运行时第三方库本地托管于 `vendor/`，不依赖 CDN。

## 6. 本轮完成情况与未执行项

**已完成（证据见 `检查记录.md` 第 4–6 节与 `screenshots/`）**

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 1200 / 750 / 500 三档浏览器布局实测 | **已执行（Edge 157 人工）** | `screenshots/宽_1200px_*`、`中_750px_*`、`窄_500px_*`；记录见 `截图索引.md` §一 |
| IME 中文输入法组合输入实测 | **已执行（Edge 157 人工，500px）** | `screenshots/IME_组合输入中_候选词.png`、`IME_上屏完成_预览同步.png` |
| 离线（断外网）本地页面加载 | **已执行** | `screenshots/离线_断外网本地页面加载.png`（本地 HTML/CSS/JS/vendor 正常加载、不白屏） |

**未执行 / 未闭环（不写成通过）**

| 项 | 状态 | 原因与可复现步骤 |
| --- | --- | --- |
| 离线状态下输入 Markdown 的本地解析预览 | **未执行** | 断网后未录入内容、未单独截图；不作为离线解析已实测的结论 |
| 真实后端联调 / 409 冲突真实触发 / 真实云保存 | **未执行（本周范围外）** | 实际保存、版本推进、草稿清理仍由 M1 / M6 持有 |
| 除 Edge 外的浏览器（Chrome / Firefox） | **未执行** | 本轮仅在 Edge 157 实测 |

逐项状态与可复现步骤见 `检查记录.md` 第 6 节；未执行项不写成通过。
