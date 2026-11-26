/**
 * m1_06_e2e.mjs —— M1-06 真实后端联调脚本
 *
 * 本脚本**不使用 mock**：它对着**真实运行的 Rust 后端**（Actix-web + PostgreSQL 17）
 * 驱动**真实的 sync.js**，验证端到端链路。
 *
 * 覆盖 M1-06 的验收项：
 *   1. 登录 → 创建 → 编辑 → 保存 → 重开 → 删除
 *   2. 两账号 404 隔离
 *   3. 两个旧版本并发更新**恰一成功**
 *   4. 冲突解决选择
 *   5. 保存中切换文档
 *
 * 用法：
 *   node m1_06_e2e.mjs http://127.0.0.1:18080
 *
 * 退出码：0 全部通过；1 有断言失败；2 环境不具备（服务未起）。
 */

import { SyncEngine, SyncState } from './js/sync.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:18080';
const API = `${BASE}/api/v1`;

let passed = 0;
let failed = 0;
const failures = [];

/**
 * 断言并记录。
 *
 * @param {string} name
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  [FAIL] ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

/**
 * 直接调用后端 API（不经 sync.js），用于准备数据与断言服务端状态。
 *
 * 后端已实现按 IP 的注册/登录限流（429 + Retry-After）。
 * 联调脚本会被反复执行，故必须**遵守 Retry-After** 后重试，
 * 否则第二次运行必然失败（本次实测：连续注册触发 429）。
 *
 * @param {string} path
 * @param {object} [options]
 */
async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const resp = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (resp.status === 429) {
      const retryAfter = Number.parseInt(resp.headers.get('retry-after') ?? '60', 10);
      const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
      console.log(`  [限流] ${path} 返回 429，等待 ${waitSec}s 后重试（第 ${attempt + 1} 次）`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }

    const text = await resp.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: resp.status, body: json, raw: text };
  }
  return { status: 429, body: null, raw: '' };
}

/** 唯一用户名，避免与既有数据冲突。 */
const stamp = Date.now();
const USER_A = `m1a_${stamp}`;
const USER_B = `m1b_${stamp}`;
const PASSWORD = 'Correct-Horse-Battery';

/**
 * 构造一个使用**真实 fetch**与真实可注入时钟的同步引擎。
 *
 * @param {object} [options]
 */
function makeEngine(options = {}) {
  const states = [];
  const conflicts = [];
  const engine = new SyncEngine(
    {
      onStateChange: (state, payload) => states.push({ state, payload }),
      onConflict: (info) => conflicts.push(info),
      onError: (err) => states.push({ state: 'error', payload: err.message }),
      onSaveSuccess: (resp) => states.push({ state: 'onSaveSuccess', payload: resp }),
      onStorageFailure: (info) => states.push({ state: 'storageFailure', payload: info }),
      onCloudUnavailable: (info) => states.push({ state: 'cloudUnavailable', payload: info }),
    },
    {
      // api.js 按设计发**相对路径**（`/api/v1/...`），由浏览器按当前页面
      // origin 解析（api.js 注释明确：不可构造绝对 URL，否则会发往外域）。
      // Node 的 fetch 不支持相对 URL，故这里补上 origin 解析，
      // **行为与浏览器一致**，不是对产品代码的改动。
      fetchImpl: (url, init) => fetch(new URL(url, BASE).toString(), init),
      random: () => 0,
      // 草稿写入用内存存储，避免污染浏览器 localStorage。
      storage: (() => {
        const map = new Map();
        return {
          get length() {
            return map.size;
          },
          key: (i) => [...map.keys()][i] ?? null,
          getItem: (k) => (map.has(k) ? map.get(k) : null),
          setItem: (k, v) => map.set(k, v),
          removeItem: (k) => map.delete(k),
        };
      })(),
    },
  );
  return { engine, states, conflicts };
}

/** 等待引擎进入指定状态（或超时）。 */
async function waitForState(engine, states, target, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // states 的元素是 { state, payload } 对象，不是字符串。
    if (states.some((s) => s.state === target)) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

async function main() {
  section('环境探测');
  let health;
  try {
    const resp = await fetch(`${BASE}/health`);
    health = await resp.json();
  } catch (e) {
    console.error(`无法连接后端 ${BASE}：${e.message}`);
    console.error('请先启动 Rust 服务，例如：');
    console.error('  $env:DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/mce_test"');
    console.error('  $env:JWT_SECRET="Kd8#mZ2!vQ7@xR4&pW9@jL5^nT3*yF7=hG2+Ab1"');
    console.error('  $env:BIND_ADDR="127.0.0.1:18080"');
    console.error('  cargo run --locked --bin markdown-cloud-editor');
    process.exit(2);
  }
  check('后端 /health 可达', health !== null, JSON.stringify(health));
  console.log(`  后端响应：${JSON.stringify(health)}`);

  section('1. 登录 → 创建 → 编辑 → 保存 → 重开 → 删除');

  const regA = await api('/auth/register', {
    method: 'POST',
    body: { username: USER_A, password: PASSWORD },
  });
  check('注册账号 A 返回 201', regA.status === 201, `实际 ${regA.status}`);
  const tokenA = regA.body?.token;
  check('注册返回 token', typeof tokenA === 'string' && tokenA.length > 0);

  const regB = await api('/auth/register', {
    method: 'POST',
    body: { username: USER_B, password: PASSWORD },
  });
  check('注册账号 B 返回 201', regB.status === 201, `实际 ${regB.status}`);
  const tokenB = regB.body?.token;

  // --- 创建 ---
  const created = await api('/documents', {
    method: 'POST',
    token: tokenA,
    body: { title: 'M1-06 联调文档', content: '初始正文' },
  });
  check('创建文档返回 201', created.status === 201, `实际 ${created.status}`);
  const docId = created.body?.id;
  check('创建返回 id', typeof docId === 'string');
  check('初始版本号为 1', created.body?.version === 1, `实际 ${created.body?.version}`);

  // --- 编辑并保存（真实驱动 sync.js）---
  const { engine, states } = makeEngine();
  const doc = await api(`/documents/${docId}`, { token: tokenA });
  engine.initSession(regA.body.user.id, tokenA, doc.body);

  engine.onInput('M1-06 联调文档', '编辑后的正文');
  // 必须等 onSaveSuccess（服务端已确认），不能等 synced ——
  // initSession 本身就会置一次 synced，等它会读到"保存前"的状态。
  const saved = await waitForState(engine, states, 'onSaveSuccess', 12000);
  check('自动保存后收到服务端确认', saved, `状态序列：${states.map((s) => s.state).join(' → ')}`);
  check(
    '保存完成后状态为 synced',
    states.at(-1)?.state === 'synced',
    `实际末态 ${states.at(-1)?.state}`,
  );

  const afterSave = await api(`/documents/${docId}`, { token: tokenA });
  check('服务端正文已更新', afterSave.body?.content === '编辑后的正文', `实际 ${JSON.stringify(afterSave.body?.content)}`);
  check('服务端版本已自增为 2', afterSave.body?.version === 2, `实际 ${afterSave.body?.version}`);

  // --- 重开 ---
  const reopened = await api(`/documents/${docId}`, { token: tokenA });
  check('重开读到已保存内容', reopened.body?.content === '编辑后的正文');
  check('重开读到版本 2', reopened.body?.version === 2);

  section('2. 两账号 404 隔离');
  const bSees = await api(`/documents/${docId}`, { token: tokenB });
  check('B 读取 A 的文档返回 404', bSees.status === 404, `实际 ${bSees.status}`);
  check('404 错误码为 NOT_FOUND', bSees.body?.error?.code === 'NOT_FOUND');

  const bList = await api('/documents', { token: tokenB });
  check(
    'B 的列表不含 A 的文档',
    !(bList.body?.documents ?? []).some((d) => d.id === docId),
  );

  const bUpdate = await api(`/documents/${docId}`, {
    method: 'PUT',
    token: tokenB,
    body: { title: 'B 越权', content: 'B 越权', expected_version: 2 },
  });
  check('B 更新 A 的文档返回 404', bUpdate.status === 404, `实际 ${bUpdate.status}`);

  const bDelete = await api(`/documents/${docId}?expected_version=2`, {
    method: 'DELETE',
    token: tokenB,
  });
  check('B 删除 A 的文档返回 404', bDelete.status === 404, `实际 ${bDelete.status}`);

  section('3. 两个旧版本并发更新恰一成功');
  const v = reopened.body.version;
  const [r1, r2] = await Promise.all([
    api(`/documents/${docId}`, {
      method: 'PUT',
      token: tokenA,
      body: { title: '并发一', content: '并发一', expected_version: v },
    }),
    api(`/documents/${docId}`, {
      method: 'PUT',
      token: tokenA,
      body: { title: '并发二', content: '并发二', expected_version: v },
    }),
  ]);
  const okCount = [r1, r2].filter((r) => r.status === 200).length;
  const conflictCount = [r1, r2].filter((r) => r.status === 409).length;
  check('恰一个并发更新成功（200）', okCount === 1, `实际成功 ${okCount}`);
  check('另一个返回 409', conflictCount === 1, `实际冲突 ${conflictCount}`);
  const conflictResp = [r1, r2].find((r) => r.status === 409);
  check(
    '409 携带 server_version',
    typeof conflictResp?.body?.error?.details?.server_version === 'number',
    JSON.stringify(conflictResp?.body?.error?.details),
  );

  section('4. 冲突解决选择（以服务端版本为准重试）');
  const serverVersion = conflictResp.body.error.details.server_version;
  const resolved = await api(`/documents/${docId}`, {
    method: 'PUT',
    token: tokenA,
    body: { title: '冲突已解决', content: '冲突已解决', expected_version: serverVersion },
  });
  check('用 server_version 重试成功（200）', resolved.status === 200, `实际 ${resolved.status}`);
  check(
    '解决后版本继续自增',
    resolved.body?.version === serverVersion + 1,
    `实际 ${resolved.body?.version}`,
  );

  section('5. 保存中切换文档');
  const doc2 = await api('/documents', {
    method: 'POST',
    token: tokenA,
    body: { title: '第二篇', content: '第二篇正文' },
  });
  const { engine: e2, states: s2 } = makeEngine();
  e2.initSession(regA.body.user.id, tokenA, reopened.body);

  // 发起一次保存，但在途时切到另一篇文档。
  e2.onInput('第一篇', '切换前的编辑');
  const pendingSave = e2.flushSave();
  // 不 await —— 让请求在途时切文档。
  e2.initSession(regA.body.user.id, tokenA, doc2.body);
  await pendingSave;
  await new Promise((r) => setTimeout(r, 300));

  const doc1Now = await api(`/documents/${docId}`, { token: tokenA });
  const doc2Now = await api(`/documents/${doc2.body.id}`, { token: tokenA });
  check(
    '切换后第一篇内容未被第二篇覆盖',
    doc1Now.body?.content === '冲突已解决',
    `实际 ${JSON.stringify(doc1Now.body?.content)}`,
  );
  check(
    '第二篇内容未被第一篇覆盖',
    doc2Now.body?.content === '第二篇正文',
    `实际 ${JSON.stringify(doc2Now.body?.content)}`,
  );
  check(
    '切换后引擎 baseVersion 属于第二篇',
    e2.baseVersion === doc2.body.version,
    `引擎 ${e2.baseVersion} vs 期望 ${doc2.body.version}`,
  );
  check(
    '切换后不得触发旧文档的 onSaveSuccess',
    s2.filter((x) => x.state === 'onSaveSuccess').length === 0,
    `序列 ${s2.map((x) => x.state).join(' → ')}`,
  );

  section('6. 删除');
  const current = await api(`/documents/${docId}`, { token: tokenA });
  const del = await api(`/documents/${docId}?expected_version=${current.body.version}`, {
    method: 'DELETE',
    token: tokenA,
  });
  check('删除返回 204', del.status === 204, `实际 ${del.status}`);
  check('204 响应体为空', del.raw === '', `实际 ${JSON.stringify(del.raw)}`);

  const afterDel = await api(`/documents/${docId}`, { token: tokenA });
  check('删除后再取返回 404', afterDel.status === 404, `实际 ${afterDel.status}`);

  section('汇总');
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length > 0) {
    console.log('  失败明细：');
    for (const f of failures) console.log(`    - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常终止：', e);
  process.exit(1);
});
