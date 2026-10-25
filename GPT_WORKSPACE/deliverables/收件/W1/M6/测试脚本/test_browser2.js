/**
 * Round 2: targeted follow-up checks that need isolated state.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const PY = '[本机路径已脱敏]
const SUBJECT = '[本机路径已脱敏]
const PORT = 9001;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const KEY = 'markdown-editor-demo:M6:W1';

function startServer(port = PORT, root = SUBJECT) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY, ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    const deadline = Date.now() + 20000;
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(proc); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('timeout: ' + out));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

const R = [];
function log(s, pass, d) { R.push({ s, pass }); console.log(`\n===== ${s} :: ${pass ? 'PASS' : 'FAIL'} =====\n${d}`); }

(async () => {
  const server = await startServer();
  const modServer = await startServer(9002, '[本机路径已脱敏]);
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let dlgAction = 'dismiss';
  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push({ message: d.message(), type: d.type() });
    try { dlgAction === 'accept' ? await d.accept() : await d.dismiss(); } catch (e) {}
  });
  const click = async (id) => { await page.click('#' + id); await page.waitForTimeout(80); };
  const msg = () => page.textContent('#msg');

  await page.goto(BASE, { waitUntil: 'load' });

  // ---- T1: cancel with a PRISTINE msg state (was the S3-a msg stale?)
  {
    await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ content: '草稿内容', savedAt: 1758392000000 })), KEY);
    await page.fill('#editor', '已有内容');
    // Force msg to a sentinel so we can tell whether loadDraft touched it
    await page.evaluate(() => { document.getElementById('msg').innerText = 'SENTINEL-未改动'; });
    dialogs.length = 0; dlgAction = 'dismiss';
    await click('btnLoad');
    const m = await msg();
    const v = await page.inputValue('#editor');
    log('T1 confirm取消后 msg 是否被更新', m === 'SENTINEL-未改动', [
      '取消前 msg 哨兵 = "SENTINEL-未改动"',
      '取消后 msg 实测 = ' + JSON.stringify(m),
      '结论 = ' + (m === 'SENTINEL-未改动'
        ? 'msg 未被改动(停留在旧值)。真实浏览器中若此前显示过"读取成功"，用户会误以为本次读取成功。'
        : 'msg 被更新为 ' + JSON.stringify(m)),
      '取消后输入框 = ' + JSON.stringify(v) + ' (内容未被覆盖, 正确)',
      'confirm 弹窗原文 = ' + JSON.stringify(dialogs[0] && dialogs[0].message),
    ].join('\n'));
  }

  // ---- T2: no draft BUT editor has content -> is confirm shown anyway?
  {
    await page.evaluate(() => localStorage.clear());
    await page.fill('#editor', '已有内容但无草稿');
    dialogs.length = 0; dlgAction = 'accept';
    await click('btnLoad');
    const m = await msg();
    log('T2 无草稿+输入框有内容时是否仍弹confirm', true, [
      'confirm 弹窗次数 = ' + dialogs.length + '  (' + (dialogs.length ? '弹了' : '没弹') + ')',
      'confirm 原文 = ' + JSON.stringify(dialogs[0] && dialogs[0].message),
      'msg = ' + JSON.stringify(m),
      '输入框 = ' + JSON.stringify(await page.inputValue('#editor')),
      '分析 = 读取前先弹确认框, 再去查localStorage。即使根本没有草稿可读, 也要求用户确认"会覆盖"。',
    ].join('\n'));
  }

  // ---- T3: clearDraft under SecurityError
  {
    const c = await browser.newContext();
    await c.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('The operation is insecure.', 'SecurityError'); },
      });
    });
    const p = await c.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(BASE, { waitUntil: 'load' });
    await p.fill('#editor', 'x');
    await p.click('#btnClear');
    await p.waitForTimeout(100);
    const m = await p.textContent('#msg');
    const v = await p.inputValue('#editor');
    log('T3 SecurityError 下点击清除', true, [
      'msg = ' + JSON.stringify(m),
      '输入框 = ' + JSON.stringify(v) + ' (注意: removeItem 抛错后 editorEl.value="" 是否执行)',
      '未捕获异常 = ' + (errs.length ? errs.join('|') : '无'),
    ].join('\n'));
    await c.close();
  }

  // ---- T4: large content vs 5MB localStorage quota
  {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: 'load' });
    const big = 'A'.repeat(3 * 1024 * 1024); // 3MB
    await p.fill('#editor', big);
    await p.click('#btnSave');
    await p.waitForTimeout(200);
    const m = await p.textContent('#msg');
    const storedLen = await p.evaluate((k) => (localStorage.getItem(k) || '').length, KEY);
    log('T4 3MB 大内容保存', true, [
      'msg = ' + JSON.stringify(m),
      '实际写入字符数 = ' + storedLen,
      '结论 = ' + (m.includes('保存成功') ? '保存成功' : '保存失败'),
    ].join('\n'));
    await c.close();
  }

  // ---- T5: XSS check - is draft content interpreted as HTML?
  {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: 'load' });
    await p.evaluate((k) => localStorage.setItem(k, JSON.stringify({
      content: '<img src=x onerror="window.__xss=1"><script>window.__xss2=1<\/script>', savedAt: Date.now()
    })), KEY);
    await p.fill('#editor', '');
    await p.click('#btnLoad');
    await p.waitForTimeout(150);
    const xss = await p.evaluate(() => ({ xss: window.__xss, xss2: window.__xss2 }));
    const imgs = await p.evaluate(() => document.querySelectorAll('img').length);
    log('T5 草稿内容XSS注入', xss.xss === undefined && xss.xss2 === undefined, [
      '注入内容 = <img src=x onerror=...><script>...</script>',
      'window.__xss = ' + xss.xss + ' , window.__xss2 = ' + xss.xss2,
      '页面中实际生成的 img 元素数 = ' + imgs,
      'msg = ' + JSON.stringify(await p.textContent('#msg')),
      '结论 = ' + (imgs === 0 ? '未执行, 内容被当作纯文本存入 textarea.value, 无XSS风险 (安全)' : '存在注入风险'),
    ].join('\n'));
    await c.close();
  }

  // ---- T6: msg uses innerText - check emoji/format rendering
  {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.fill('#editor', 'x');
    await click('btnSave');
    const innerHTML = await page.evaluate(() => document.getElementById('msg').innerHTML);
    const text = await page.textContent('#msg');
    log('T6 msg 元素渲染方式(innerText vs innerHTML)', true, [
      'msg.innerText = ' + JSON.stringify(text),
      'msg.innerHTML = ' + JSON.stringify(innerHTML),
      '结论 = ' + (innerHTML.includes('&') || innerHTML.includes('<') ? '使用了 innerHTML' : '使用 innerText, 不会解析HTML(安全)'),
    ].join('\n'));
  }

  await page.close();
  await ctx.close();

  // ---- T7: ES Module import test
  {
    const modDir = '[本机路径已脱敏]
    fs.mkdirSync(modDir, { recursive: true });
    fs.copyFileSync(path.join(SUBJECT, 'drafts.js'), path.join(modDir, 'drafts.js'));
    fs.writeFileSync(path.join(modDir, 'm1.html'), `<!DOCTYPE html><html><body>
<textarea id="editor"></textarea><div id="msg"></div>
<button id="btnSave">s</button><button id="btnLoad">l</button><button id="btnClear">c</button>
<script type="module">
  import { saveDraft, loadDraft, clearDraft } from './drafts.js';
  window.__importOk = true;
</script></body></html>`);
    fs.writeFileSync(path.join(modDir, 'm2.html'), `<!DOCTYPE html><html><body>
<textarea id="editor"></textarea><div id="msg"></div>
<button id="btnSave">s</button><button id="btnLoad">l</button><button id="btnClear">c</button>
<script type="module">
  import './drafts.js';
  window.__sideEffectImportOk = true;
</script></body></html>`);
    const c = await browser.newContext();
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await p.goto(`http://127.0.0.1:9002/m1.html`, { waitUntil: 'load' });
    await p.waitForTimeout(300);
    const named = await p.evaluate(() => window.__importOk === true);
    log('T7-a ES Module 具名导入 { saveDraft } from "./drafts.js"', named, [
      '具名导入是否成功 = ' + (named ? '是' : '否'),
      '捕获到的错误 = ' + (errs.length ? errs.join(' || ') : '无'),
      '分析 = drafts.js 是普通脚本, 内部用 const/function 声明但没有 export 关键字。',
    ].join('\n'));

    const errs2 = [];
    p.on('pageerror', (e) => errs2.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs2.push('console: ' + m.text()); });
    await p.goto(`http://127.0.0.1:9002/m2.html`, { waitUntil: 'load' });
    await p.waitForTimeout(300);
    const side = await p.evaluate(() => window.__sideEffectImportOk === true);
    // did the buttons still work under module scope?
    await p.fill('#editor', 'module测试');
    await p.click('#btnSave');
    await p.waitForTimeout(120);
    const mMsg = await p.textContent('#msg');
    log('T7-b ES Module 副作用导入 import "./drafts.js"', side && mMsg.includes('保存成功'), [
      '副作用导入是否成功 = ' + (side ? '是' : '否'),
      '捕获到的错误 = ' + (errs2.length ? errs2.join(' || ') : '无'),
      '导入后点击保存, msg = ' + JSON.stringify(mMsg),
      '分析 = 脚本在模块作用域执行, 顶层 const 不挂到 window, 但副作用(绑定按钮)仍然生效。',
    ].join('\n'));
    await c.close();
  }

  // ---- T8: file:// protocol -> real SecurityError (not injected)
  {
    const c = await browser.newContext();
    const p = await c.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const fileUrl = 'file:///' + path.join(SUBJECT, 'index.html').replace(/\\/g, '/');
    await p.goto(fileUrl, { waitUntil: 'load' });
    await p.waitForTimeout(200);
    const lsAccessible = await p.evaluate(() => {
      try { const t = '__probe__'; localStorage.setItem(t, '1'); const v = localStorage.getItem(t); localStorage.removeItem(t); return 'accessible:' + v; }
      catch (e) { return 'threw:' + e.name + ':' + e.message; }
    });
    await p.fill('#editor', 'file协议');
    await p.click('#btnSave');
    await p.waitForTimeout(150);
    const m = await p.textContent('#msg');
    log('T8 真实 file:// 协议下的行为', true, [
      'file URL = ' + fileUrl,
      'localStorage 探测结果 = ' + JSON.stringify(lsAccessible),
      '点击保存后 msg = ' + JSON.stringify(m),
      '未捕获异常 = ' + (errs.length ? errs.join('|') : '无'),
      '分析 = file:// 协议下 Chromium 通常允许 localStorage(按 file origin 处理), 与 http 不同。',
    ].join('\n'));
    await c.close();
  }

  // ---- T9: HTML strict-ish parse check for </p >
  {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: 'load' });
    const r = await p.evaluate(() => {
      const pEls = document.querySelectorAll('p');
      const ta = document.getElementById('editor');
      return {
        pCount: pEls.length,
        pOuter: pEls[0] ? pEls[0].outerHTML : null,
        taParentTag: ta.parentElement.tagName,
        taInsideP: !!ta.closest('p'),
        msgParentTag: document.getElementById('msg').parentElement.tagName,
        innerText: document.getElementById('msg').innerText,
      };
    });
    log('T9 </p > 标签解析核对', true, [
      '解析出 p 元素数量 = ' + r.pCount,
      'p 的 outerHTML = ' + JSON.stringify(r.pOuter),
      'textarea 的父元素 = ' + r.taParentTag,
      'textarea 是否被包在 p 内 = ' + (r.taInsideP ? '是(有嵌套隐患)' : '否'),
      '结论 = ' + (r.pCount === 1 && !r.taInsideP
        ? 'HTML5 解析器容忍 </p > 中的空格, 结构被正确解析, 未造成 textarea 被吞入段落。'
        : '解析异常'),
    ].join('\n'));
    await c.close();
  }

  await browser.close();
  server.kill();
  modServer.kill();

  console.log('\n\n================ 汇总 ================');
  let p = 0, f = 0;
  for (const r of R) { console.log((r.pass ? '[PASS] ' : '[FAIL] ') + r.s); r.pass ? p++ : f++; }
  console.log(`\n通过 ${p} / 失败 ${f} / 共 ${R.length}`);
})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
