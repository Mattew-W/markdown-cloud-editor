const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const PY = '[本机路径已脱敏]
const SUBJECT = '[本机路径已脱敏]
const PORT = 9003;
const KEY = 'markdown-editor-demo:M6:W1';

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: SUBJECT, stdio: ['ignore', 'pipe', 'pipe'] });
    const deadline = Date.now() + 20000;
    const tryOnce = () => {
      const s = net.connect({ host: '127.0.0.1', port: PORT }, () => { s.destroy(); resolve(proc); });
      s.on('error', () => { s.destroy(); Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(tryOnce, 250); });
    };
    tryOnce();
  });
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch();

  // ---- P1: content:null exact coercion semantics
  {
    const c = await browser.newContext(); const p = await c.newPage();
    await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    const probe = await p.evaluate(() => {
      const ta = document.getElementById('editor');
      const out = {};
      ta.value = null;  out.assignNull = ta.value;
      ta.value = 123;   out.assignNumber = ta.value;
      ta.value = {a:1}; out.assignObject = ta.value;
      ta.value = undefined; out.assignUndef = ta.value;
      ta.value = false; out.assignFalse = ta.value;
      return out;
    });
    await p.evaluate((k) => localStorage.setItem(k, '{"content":null,"savedAt":1758392000000}'), KEY);
    await p.fill('#editor', '');
    await p.click('#btnLoad');
    await p.waitForTimeout(120);
    console.log('===== P1 content:null 精确行为 =====');
    console.log('textarea.value 赋值强制转换实测:');
    console.log('  value = null      -> ' + JSON.stringify(probe.assignNull));
    console.log('  value = 123       -> ' + JSON.stringify(probe.assignNumber));
    console.log('  value = {a:1}     -> ' + JSON.stringify(probe.assignObject));
    console.log('  value = undefined -> ' + JSON.stringify(probe.assignUndef));
    console.log('  value = false     -> ' + JSON.stringify(probe.assignFalse));
    console.log('注入 {"content":null} 后读取:');
    console.log('  msg      = ' + JSON.stringify(await p.textContent('#msg')));
    console.log('  输入框值  = ' + JSON.stringify(await p.inputValue('#editor')));
    await c.close();
  }

  // ---- P2: does the CLAIMED case-1 message string exist anywhere in the code?
  {
    const fs = require('fs');
    const src = fs.readFileSync('[本机路径已脱敏] 'utf8');
    const claimed = '读取成功，上次保存：';
    console.log('\n===== P2 组员声称的文案核对 =====');
    console.log('声称用例1保存后显示含 ' + JSON.stringify(claimed));
    console.log('该字符串在 drafts.js 中出现次数 = ' + (src.split(claimed).length - 1) + '  (仅出现在 loadDraft 读取分支)');
    const saveMsg = src.match(/showMsg\(`([^`]*保存成功[^`]*)`\)/);
    console.log('saveDraft 实际使用的模板 = ' + JSON.stringify(saveMsg && saveMsg[1]));
    // Reproduce the claimed timestamp format
    const c = await browser.newContext(); const p = await c.newPage();
    await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await p.fill('#editor', '111');
    await p.click('#btnSave');
    await p.waitForTimeout(100);
    const saveMsgOut = await p.textContent('#msg');
    await p.reload({ waitUntil: 'load' });
    await p.click('#btnLoad');
    await p.waitForTimeout(100);
    const loadMsgOut = await p.textContent('#msg');
    console.log('\n实测复现(同样输入111):');
    console.log('  点【保存到本机】后 -> ' + JSON.stringify(saveMsgOut));
    console.log('  点【读取本机草稿】后 -> ' + JSON.stringify(loadMsgOut));
    console.log('  组员声称用例1(保存) -> "读取成功，上次保存：2026/10/20 12:38:44"');
    console.log('  判定 = 声称的文案实际属于【读取】分支, 出现在保存分支属于张冠李戴');
    await c.close();
  }

  // ---- P3: confirm dialog appears BEFORE checking draft existence (ordering proof)
  {
    const c = await browser.newContext(); const p = await c.newPage();
    let asked = 0;
    p.on('dialog', async (d) => { asked++; await d.accept(); });
    await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await p.evaluate(() => localStorage.clear());
    await p.fill('#editor', 'x');
    await p.click('#btnLoad');
    await p.waitForTimeout(150);
    console.log('\n===== P3 confirm 与"无草稿"的先后顺序 =====');
    console.log('  完全没有草稿 + 输入框有内容 -> confirm 弹出次数 = ' + asked);
    console.log('  最终 msg = ' + JSON.stringify(await p.textContent('#msg')));
    console.log('  判定 = confirm 在检查草稿是否存在之前弹出 (用户为"不存在的覆盖"做了确认)');
    await c.close();
  }

  await browser.close();
  server.kill();
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
