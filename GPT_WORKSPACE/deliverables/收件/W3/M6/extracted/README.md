# M6 W3 交付说明（吴泽佳 / 豆包）

本目录是 M6 第 3 周交件。基线为 `baseline/`（Git main 提交
`42e9e7fce4a76f41e69ee33f6f208383e8e04f44` 快照），本周成果为**新增的真实 HTTP
传输回归测试**与对应的使用说明。

## 本周成果（相对基线的新增/修改）

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `baseline/frontend/js/tests/api.http.test.js` | **新增** | 真实 HTTP 传输回归测试（`node:http` 127.0.0.1 随机端口 + 真实 fetch） |
| `baseline/frontend/js/README.md` | **修改** | §5 更新为"mock + 真实传输"两种测试；新增 §5.1 真实 HTTP 传输测试说明 |

> `api.js` **未做任何修改**：现有实现通过了全部真实传输测试，无需修复。
> 未改动任何冻结契约、`api.test.js`、`drafts.test.js`、后端代码或迁移文件。

## 如何运行

环境要求：**Node.js ≥ 22**（`package.json` 声明 `engines.node >= 22`；
本机验证版本 `v22.23.2`）。

```sh
cd baseline/frontend

npm test                      # 全部前端测试（api / api.http / drafts）
node --test js/tests/api.http.test.js   # 仅本周新增的真实 HTTP 传输测试
npm run test:log              # 生成真实 TAP 原始日志 test-output.log
```

本机实测结果（完整原始输出见 `日志/test-output.log`）：

```
# tests 113
# suites 8
# pass 113
# fail 0
# duration_ms 262.7   （全量 npm test 时长约 0.7s，未真等 10 秒）
```

新增 `api.http.test.js` 共 12 个用例，全部通过；原有 `api.test.js`、
`drafts.test.js` 全部通过，回归无破坏。

## 真实 HTTP 传输测试覆盖范围

- 实际请求路径为 `/api/v1/documents`（断言服务端收到的 `req.url`）
- `Authorization` 只在请求头，不进 URL
- JSON 请求体真实发送，带 `Content-Type: application/json`
- 错误响应映射：400/404/500 → 对应错误类；429 `RATE_LIMITED` 保留 `Retry-After`
- 返回 JSON 响应头 + 不完整正文后断开连接 → `NetworkError`
- 成功（200）/错误（400）正文读取超时 → `TimeoutError`（注入可控时钟，不真等 10 秒）
- 恶意畸形 JSON → `ProtocolError`
- 204 真实传输返回 `null`
- 连接被拒（端口无服务监听）→ `NetworkError`

全部流量只走 `127.0.0.1`，**不访问外网**。

## 依赖

- 运行时：Node.js ≥ 22（自带 `node:test`、`node:assert/strict`、`node:http`、全局 `fetch`）
- 无第三方 npm 依赖，无需 `npm install`

## 交付目录结构

```
M6_W3_吴泽佳_20261104/
├── baseline/               # 基线快照 + 本周修改（api.http.test.js、README.md）
├── README.md               # 本文件
├── 检查记录.md              # 逐项输入/预期/实际、命令与结果
├── 交付说明.txt             # 本人身份与操作说明（身份部分由本人填写）
└── 日志/
    └── test-output.log     # 真实 TAP 原始输出（npm run test:log 生成）
```
