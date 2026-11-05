/**
 * R1/R2/R3 鉴别力验证 —— 定向变异测试（M6-R15）
 *
 * 目的：证明新补的三个用例**真的在测它声称的东西**，而不是"看起来通过"。
 * 方法：逐个注入定向变异，看对应用例是否失败。
 *
 * 变异 1（针对 R2）：把 api.js 的超时判定从 AbortError 改为永远走网络错误
 *   → 期望：两个"正文读取超时"用例失败
 * 变异 2（针对 R2）：让超时计时器只覆盖 fetch 阶段，不覆盖正文读取
 *   → 期望：正文读取超时用例失败（json() 未被调用 → abort 落在错误阶段）
 * 变异 3（针对 R1）：让断连发生在响应头送出之前（即恢复 res.destroy() 立即销毁）
 *   → 期望："客户端必须先收到响应头"断言失败
 * 变异 4（针对 R3）：让 server_version 缺失时编造版本号 1
 *   → 期望："缺 server_version → ProtocolError"用例失败
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const API = 'D:/WORKbuddy1/RUST/frontend/js/api.js';
const TEST = 'D:/WORKbuddy1/RUST/frontend/js/tests/api.http.test.js';
const cwd = 'D:/WORKbuddy1/RUST/frontend';

const origApi = readFileSync(API, 'utf8');
const origTest = readFileSync(TEST, 'utf8');

function sha(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function runTests() {
  try {
    const out = execFileSync(
      process.execPath,
      ['--test', 'js/tests/api.http.test.js'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }
    );
    return { out, code: 0 };
  } catch (e) {
    return {
      out: (e.stdout || '') + (e.stderr || '') + `\n[runner-exception] ${e.message}`,
      code: e.status ?? 1,
    };
  }
}

function listFailures(out) {
  const fails = [];
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*not ok \d+ - (.+)$/);
    if (m) {
      let detail = '';
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
        const d = lines[j].match(/^\s*(error|expected|actual|message):\s*(.+)$/);
        if (d) detail += `${d[1]}=${d[2].trim()} `;
        if (/^\s*not ok/.test(lines[j])) break;
      }
      fails.push(`${m[1].trim()} :: ${detail.trim()}`);
    }
  }
  return fails;
}

/**
 * 按**行**定位并替换，避免 CRLF/LF 换行差异导致锚点不命中。
 * @returns {{ok: boolean, text: string}}
 */
function patchByLines(src, findLines, replaceLines) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const n = findLines.length;
  for (let i = 0; i + n <= lines.length; i += 1) {
    let match = true;
    for (let j = 0; j < n; j += 1) {
      if (lines[i + j].trim() !== findLines[j].trim()) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const next = [...lines.slice(0, i), ...replaceLines, ...lines.slice(i + n)];
    return { ok: true, text: next.join(eol) };
  }
  return { ok: false, text: src };
}

const mutations = [
  {
    id: 'M1',
    name: '超时判定改为永不走 AbortError 分支',
    target: 'api.js',
    find: ["if (error && error.name === 'AbortError') {"],
    replace: ["if (false && error && error.name === 'AbortError') {"],
    expect: /正文读取超时/,
  },
  {
    id: 'M2',
    name: '超时仅覆盖 fetch 阶段（fetch 返回后立刻清定时器，正文读取无保护）',
    target: 'api.js',
    find: [
      'const response = await fetchImpl(url, {',
      'method,',
      'headers,',
      'body: requestBody,',
      'signal: controller.signal,',
      '});',
    ],
    replace: [
      'const response = await fetchImpl(url, {',
      'method,',
      'headers,',
      'body: requestBody,',
      'signal: controller.signal,',
      '});',
      'if (timerId !== null) { timers.clearTimeout(timerId); timerId = null; } // 变异：正文读取阶段不再受超时保护',
    ],
    expect: /正文读取超时/,
  },
  {
    id: 'M3',
    name: '断连发生在响应头送出之前（恢复立即 destroy）',
    target: 'api.http.test.js',
    find: [
      'res.flushHeaders(); // 强制写出响应头',
      'setTimeout(() => res.destroy(), 30); // 留出传输窗口，确保响应头抵达客户端',
    ],
    replace: ['res.destroy(); // 变异：立即销毁，响应头未送达'],
    expect: /断开连接/,
  },
  {
    id: 'M4',
    name: 'server_version 缺失时编造版本号',
    target: 'api.js',
    find: ['if (!Number.isSafeInteger(serverVersion) || serverVersion <= 0) {'],
    replace: ['if (false && (!Number.isSafeInteger(serverVersion) || serverVersion <= 0)) {'],
    expect: /缺 server_version/,
  },
];

console.log('\n=== 变异测试：R1/R2/R3 鉴别力验证 ===');
console.log(`基线 api.js  SHA256[0:12] = ${sha(origApi)}`);
console.log(`基线 测试文件 SHA256[0:12] = ${sha(origTest)}`);

let base;
try {
  base = runTests();
} catch (e) {
  console.log(`[基线运行异常] ${e.stack || e.message}`);
  process.exit(2);
}
const baseFails = listFailures(base.out);
console.log(`\n[基线] 退出码=${base.code}  失败用例数=${baseFails.length}`);
if (baseFails.length) baseFails.forEach((f) => console.log(`   FAIL ${f}`));

let detected = 0;
let missed = 0;
const summary = [];

for (const m of mutations) {
  const isApi = m.target === 'api.js';
  const orig = isApi ? origApi : origTest;
  const patched = patchByLines(orig, m.find, m.replace);
  if (!patched.ok) {
    console.log(`\n[${m.id}] ⚠ 锚点未命中，跳过（源码已变化）`);
    missed += 1;
    summary.push(`${m.id} 锚点未命中`);
    continue;
  }
  if (isApi) writeFileSync(API, patched.text, 'utf8');
  else writeFileSync(TEST, patched.text, 'utf8');

  const r = runTests();
  const fails = listFailures(r.out);
  const hit = fails.some((f) => m.expect.test(f));
  const pass = r.code === 0 && fails.length === 0;

  if (isApi) writeFileSync(API, origApi, 'utf8');
  else writeFileSync(TEST, origTest, 'utf8');

  if (hit) {
    detected += 1;
    console.log(`\n[${m.id}] ✅ 变异被检出  —— ${m.name}`);
    fails.forEach((f) => console.log(`      ${f}`));
  } else {
    missed += 1;
    console.log(`\n[${m.id}] ❌ 变异未被检出 —— ${m.name}`);
    console.log(`      退出码=${r.code} 失败数=${fails.length}${pass ? '（全部通过 = 漏检）' : ''}`);
    fails.forEach((f) => console.log(`      ${f}`));
  }
  summary.push(`${m.id} ${hit ? '检出' : '漏检'} —— ${m.name}`);
}

// 还原校验
const restoredApi = readFileSync(API, 'utf8');
const restoredTest = readFileSync(TEST, 'utf8');
console.log('\n=== 还原校验 ===');
console.log(`api.js 还原一致: ${restoredApi === origApi ? '✅' : '❌'}`);
console.log(`测试文件还原一致: ${restoredTest === origTest ? '✅' : '❌'}`);

console.log('\n=== 汇总 ===');
summary.forEach((s) => console.log(`  ${s}`));
console.log(`\n检出 ${detected} / ${mutations.length}，漏检 ${missed}`);
