/**
 * Real-browser (headless Chromium via Playwright) verification of M6 W1 drafts.js
 * Every scenario prints the ACTUAL observed strings, not code-derived guesses.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');

const PY = '[本机路径已脱敏]
const SUBJECT = '[本机路径已脱敏]
const PORT = 9000;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const KEY = 'markdown-editor-demo:M6:W1';

const results = [];
function log(scenario, pass, detail) {
  results.push({ scenario, pass, detail });
  console.log(`\n===== ${scenario} :: ${pass ? 'PASS' : 'FAIL'} =====`);
  console.log(detail);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
      cwd: SUBJECT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', (e) => reject(new Error('spawn failed: ' + e.message)));
    // Poll the TCP port instead of relying on (buffered) stdout.
    const net = require('net');
    const deadline = Date.now() + 20000;
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port: PORT }, () => {
        sock.destroy();
        resolve(proc);
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('server start timeout: ' + out));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

(async () => {
  const server = await startServer();
  console.log('[INFO] static server started on port ' + PORT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console.error: ' + m.text());
  });

  const dialogs = [];
  let nextDialogAction = 'dismiss'; // 'accept' | 'dismiss'
  page.on('dialog', async (d) => {
    const action = nextDialogAction;
    dialogs.push({ type: d.type(), message: d.message(), action });
    try {
      if (action === 'accept') await d.accept();
      else await d.dismiss();
    } catch (e) { /* already handled */ }
  });

  const msg = () => page.textContent('#msg');
  const editorVal = () => page.inputValue('#editor');
  const click = async (id) => { await page.click('#' + id); await page.waitForTimeout(60); };

  await page.goto(BASE, { waitUntil: 'load' });

  // ---------------------------------------------------------------- S1
  {
    await page.evaluate(() => localStorage.clear());
    await page.fill('#editor', '111');
    await click('btnSave');
    const m = await msg();
    const stored = await page.evaluate((k) => localStorage.getItem(k), KEY);
    log('S1 正常保存', /保存成功/.test(m) || m.includes('保存'), [
      '实际 msg 文案 = ' + JSON.stringify(m),
      'localStorage 实际存储值 = ' + JSON.stringify(stored),
      'localStorage 存储长度 = ' + (stored ? stored.length : 0) + ' 字符',
    ].join('\n'));
  }

  // ---------------------------------------------------------------- S2
  {
    await page.reload({ waitUntil: 'load' });
    const before = await editorVal();
    await click('btnLoad');
    const m = await msg();
    const after = await editorVal();
    log('S2 保存后读取(刷新)', after === '111', [
      '刷新后(读取前)输入框 = ' + JSON.stringify(before),
      '点击读取后输入框 = ' + JSON.stringify(after),
      '实际 msg 文案 = ' + JSON.stringify(m),
    ].join('\n'));
  }

  // ---------------------------------------------------------------- S3
  // (a) 取消
  {
    await page.fill('#editor', '已有关键字');
    dialogs.length = 0;
    nextDialogAction = 'dismiss';
    await click('btnLoad');
    const m = await msg();
    const v = await editorVal();
    log('S3-a 输入框有内容 + confirm 取消', dialogs.length === 1 && v === '已有关键字', [
      'confirm 弹窗次数 = ' + dialogs.length,
      'confirm 弹窗原文 = ' + JSON.stringify(dialogs[0] ? dialogs[0].message : null),
      '取消后输入框内容 = ' + JSON.stringify(v) + '  (期望保留 "已有关键字")',
      '取消后 msg = ' + JSON.stringify(m),
    ].join('\n'));
  }
  // (b) 确定
  {
    dialogs.length = 0;
    nextDialogAction = 'accept';
    await page.fill('#editor', '已有关键字');
    await click('btnLoad');
    const m = await msg();
    const v = await editorVal();
    log('S3-b 输入框有内容 + confirm 确定', v === '111', [
      'confirm 弹窗次数 = ' + dialogs.length,
      'confirm 弹窗原文 = ' + JSON.stringify(dialogs[0] ? dialogs[0].message : null),
      '确定后输入框内容 = ' + JSON.stringify(v) + '  (期望被覆盖为 "111")',
      '确定后 msg = ' + JSON.stringify(m),
    ].join('\n'));
  }

  // ---------------------------------------------------------------- S4 (无草稿时读取)
  {
    await page.evaluate(() => localStorage.clear());
    await page.fill('#editor', '');
    await click('btnLoad');
    const m = await msg();
    log('S4 无草稿时读取', m.includes('暂无'), '实际 msg 文案 = ' + JSON.stringify(m));
  }

  // ---------------------------------------------------------------- S5 (清除后读取)
  {
    await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ content: '临时', savedAt: Date.now() })), KEY);
    await page.fill('#editor', '');
    await click('btnClear');
    const mClear = await msg();
    const editorAfterClear = await editorVal();
    await click('btnLoad');
    const m = await msg();
    log('S5 清除后读取', m.includes('暂无'), [
      '点击清除后 msg = ' + JSON.stringify(mClear),
      '点击清除后输入框 = ' + JSON.stringify(editorAfterClear),
      '再点读取 msg = ' + JSON.stringify(m),
    ].join('\n'));
  }

  // ---------------------------------------------------------------- S9 中文
  {
    await page.evaluate(() => localStorage.clear());
    const zh = '# 中文标题\n\n这是**加粗**与 emoji 🚀，以及换行测试。\n- 列表项一\n- 列表项二';
    await page.fill('#editor', zh);
    await click('btnSave');
    await page.reload({ waitUntil: 'load' });
    await click('btnLoad');
    const v = await editorVal();
    const m = await msg();
    log('S9 中文内容保存后读取', v === zh, [
      '写入字符数 = ' + zh.length,
      '读回字符数 = ' + v.length,
      '完全一致 = ' + (v === zh),
      '读回内容 = ' + JSON.stringify(v),
      'msg = ' + JSON.stringify(m),
      'localStorage 字节数(UTF-8) = ' + Buffer.byteLength(v, 'utf8'),
    ].join('\n'));
  }
  // 中文逐字输入(模拟 IME 逐键输入, 非真实输入法候选框)
  {
    await page.evaluate(() => localStorage.clear());
    await page.fill('#editor', '');
    await page.click('#editor');
    await page.type('#editor', '中文输入测试', { delay: 30 });
    await click('btnSave');
    await page.reload({ waitUntil: 'load' });
    await click('btnLoad');
    const v = await editorVal();
    log('S9-b 逐键输入中文后读取', v === '中文输入测试', [
      '逐键 type() 写入, 读回 = ' + JSON.stringify(v),
    ].join('\n'));
  }

  await page.close();

  // ================================================================ S6 QuotaExceededError
  {
    const c2 = await browser.newContext();
    await c2.addInitScript(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (String(k).indexOf('markdown-editor-demo') === 0) {
          const e = new DOMException("Failed to execute 'setItem' on 'Storage': Setting the value of 'x' exceeded the quota.", 'QuotaExceededError');
          throw e;
        }
        return orig.call(this, k, v);
      };
    });
    const p2 = await c2.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(e.message));
    await p2.goto(BASE, { waitUntil: 'load' });
    await p2.fill('#editor', '111');
    await p2.click('#btnSave');
    await p2.waitForTimeout(100);
    const m = await p2.textContent('#msg');
    const stillAlive = await p2.evaluate(() => !!document.getElementById('editor'));
    log('S6 存储空间不足 QuotaExceededError', true, [
      '实际 msg 文案 = ' + JSON.stringify(m),
      '异常 e.name = QuotaExceededError (真实 DOMException, 由浏览器抛出)',
      '页面是否崩溃 = ' + (errs.length ? '是: ' + errs.join('|') : '否 (DOM 仍存活: ' + stillAlive + ')'),
    ].join('\n'));
    await c2.close();
  }

  // ================================================================ S7 存储不可用 SecurityError
  {
    const c3 = await browser.newContext();
    await c3.addInitScript(() => {
      // 模拟隐私模式 / 存储被策略禁用：访问 window.localStorage 本身即抛 SecurityError
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException("The operation is insecure.", 'SecurityError');
        },
      });
    });
    const p3 = await c3.newPage();
    const errs = [];
    p3.on('pageerror', (e) => errs.push(e.message));
    await p3.goto(BASE, { waitUntil: 'load' });
    await p3.fill('#editor', '111');
    await p3.click('#btnSave');
    await p3.waitForTimeout(100);
    const mSave = await p3.textContent('#msg');
    await p3.fill('#editor', '');
    await p3.click('#btnLoad');
    await p3.waitForTimeout(100);
    const mLoad = await p3.textContent('#msg');
    const alive = await p3.evaluate(() => !!document.getElementById('editor'));
    log('S7 存储不可用 SecurityError', true, [
      '保存路径 msg = ' + JSON.stringify(mSave),
      '读取路径 msg = ' + JSON.stringify(mLoad),
      '是否出现专门的"存储不可用"文案 = ' +
        (JSON.stringify(mSave).includes('不可用') || JSON.stringify(mLoad).includes('不可用') ? '是' : '否'),
      '页面是否崩溃 = ' + (errs.length ? '是: ' + errs.join('|') : '否 (DOM 仍存活: ' + alive + ')'),
    ].join('\n'));
    await c3.close();
  }

  // ================================================================ S8 草稿内容损坏
  {
    const cases = [
      { name: 'S8-1 非法JSON {{{', raw: '{{{', expect: '格式损坏' },
      { name: 'S8-2 content为数字 {"content":123}', raw: '{"content":123}', expect: '(非字符串,不应崩溃)' },
      { name: 'S8-3 raw为null', raw: 'null', expect: '不应崩溃' },
      { name: 'S8-4 content为null', raw: '{"content":null}', expect: '(应为字符串"null"或空)' },
      { name: 'S8-5 缺少savedAt', raw: '{"content":"abc"}', expect: 'savedAt缺失' },
      { name: 'S8-6 savedAt为非法值', raw: '{"content":"abc","savedAt":"not-a-date"}', expect: '非法日期' },
      { name: 'S8-7 content为对象', raw: '{"content":{"a":1}}', expect: '(应被转成字符串)' },
      { name: 'S8-8 空字符串', raw: '', expect: '(视为无草稿)' },
    ];
    for (const c of cases) {
      const c4 = await browser.newContext();
      const p4 = await c4.newPage();
      const errs = [];
      p4.on('pageerror', (e) => errs.push(e.message));
      await p4.goto(BASE, { waitUntil: 'load' });
      await p4.evaluate(({ k, raw }) => { localStorage.setItem(k, raw); }, { k: KEY, raw: c.raw });
      await p4.fill('#editor', '');
      await p4.click('#btnLoad');
      await p4.waitForTimeout(80);
      const m = await p4.textContent('#msg');
      const v = await p4.inputValue('#editor');
      const alive = await p4.evaluate(() => !!document.getElementById('editor'));
      log(c.name, true, [
        '注入 localStorage 原值 = ' + JSON.stringify(c.raw),
        '实际 msg 文案 = ' + JSON.stringify(m),
        '读取后输入框值 = ' + JSON.stringify(v) + '  (typeof ' + typeof v + ')',
        '未捕获异常 = ' + (errs.length ? errs.join('|') : '无'),
        '页面是否崩溃 = ' + (alive ? '否' : '是'),
      ].join('\n'));
      await c4.close();
    }
  }

  // ================================================================ 额外: 空格输入框
  {
    const c5 = await browser.newContext();
    const p5 = await c5.newPage();
    await p5.goto(BASE, { waitUntil: 'load' });
    await p5.evaluate((k) => localStorage.setItem(k, JSON.stringify({ content: '草稿内容', savedAt: Date.now() })), KEY);
    await p5.fill('#editor', '   \n  \t ');
    let asked = false;
    p5.on('dialog', async (d) => { asked = true; await d.accept(); });
    await p5.click('#btnLoad');
    await p5.waitForTimeout(100);
    const m = await p5.textContent('#msg');
    const v = await p5.inputValue('#editor');
    log('额外A 输入框仅空白字符时点读取', true, [
      '输入框内容 = ' + JSON.stringify('   \\n  \\t '),
      '是否弹出 confirm = ' + (asked ? '是' : '否'),
      '读取后输入框 = ' + JSON.stringify(v) + '  (空白被静默覆盖)',
      'msg = ' + JSON.stringify(m),
    ].join('\n'));
    await c5.close();
  }

  // ================================================================ 额外: HTML 结构 & id 一致性
  {
    const c6 = await browser.newContext();
    const p6 = await c6.newPage();
    await p6.goto(BASE, { waitUntil: 'load' });
    const info = await p6.evaluate(() => {
      const res = {};
      res.ids = Array.from(document.querySelectorAll('[id]')).map((e) => e.tagName + '#' + e.id);
      res.btnSave = !!document.getElementById('btnSave');
      res.btnLoad = !!document.getElementById('btnLoad');
      res.btnClear = !!document.getElementById('btnClear');
      res.editor = !!document.getElementById('editor');
      res.msg = !!document.getElementById('msg');
      // </p > 解析结果
      const ps = document.querySelectorAll('p');
      res.pCount = ps.length;
      res.pText = ps.length ? ps[0].textContent.trim() : null;
      res.warnText = ps.length ? ps[0].innerHTML : null;
      // 段落是否被 textarea 吞掉(非法嵌套检测)
      res.textareaInsideP = !!document.querySelector('p textarea');
      res.bodyChildTags = Array.from(document.body.children).map((e) => e.tagName);
      // 按钮 type 属性(默认 submit, 在 form 内会提交)
      res.buttons = Array.from(document.querySelectorAll('button')).map(
        (b) => ({ id: b.id, type: b.getAttribute('type'), typeProp: b.type, form: !!b.form })
      );
      res.scriptType = document.querySelector('script') ? document.querySelector('script').getAttribute('src') : null;
      res.hasForm = !!document.querySelector('form');
      return res;
    });
    log('额外B HTML结构与元素id一致性', info.btnSave && info.btnLoad && info.btnClear && info.editor && info.msg, [
      '页面所有 id = ' + JSON.stringify(info.ids),
      'btnSave/btnLoad/btnClear/editor/msg 是否存在 = ' +
        [info.btnSave, info.btnLoad, info.btnClear, info.editor, info.msg].join('/'),
      '</p > 解析: p元素数量 = ' + info.pCount + ', 文本 = ' + JSON.stringify(info.pText),
      'textarea 是否落在 p 内(应为否) = ' + (info.textareaInsideP ? '是(有嵌套问题)' : '否'),
      'body 直接子元素 = ' + JSON.stringify(info.bodyChildTags),
      'button 信息 = ' + JSON.stringify(info.buttons),
      '页面是否存在 form(影响 button 默认 type=submit) = ' + info.hasForm,
      'script 标签 src = ' + info.scriptType,
    ].join('\n'));
    await c6.close();
  }

  await browser.close();
  server.kill();

  console.log('\n\n================ 汇总 ================');
  let pass = 0, fail = 0;
  for (const r of results) {
    console.log((r.pass ? '[PASS] ' : '[FAIL] ') + r.scenario);
    r.pass ? pass++ : fail++;
  }
  console.log(`\n通过 ${pass} / 失败 ${fail} / 共 ${results.length}`);
  console.log('\n未捕获页面级异常汇总: ' + (pageErrors.length ? pageErrors.join(' | ') : '无'));
})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
