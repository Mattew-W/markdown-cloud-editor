// logs/probe-security.mjs —— 安全探针（M5-04 补强）
//
// 变更（M1 代修，2026-11-11）：改为**真实执行 vendor 里的浏览器构建**，
// 与 index.html 中 <script src="vendor/…"> 的运行时加载方式一致。
// 原版导入的是 node_modules 的 npm 包，与运行时加载的那份不是同一构建，
// 不足以支撑「用运行 vendor 真实版本验证」这一验收要求。
//
// 运行方式（在本 frontend 目录）：
//   npm ci
//   node logs/probe-security.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// runScripts:'dangerously' 让 jsdom 真正执行 UMD 脚本并挂出全局对象
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  runScripts: 'dangerously',
});
dom.window.eval(readFileSync(path.join(root, 'vendor/marked/marked.min.js'), 'utf8'));
dom.window.eval(readFileSync(path.join(root, 'vendor/dompurify/purify.min.js'), 'utf8'));

const { marked, DOMPurify } = dom.window;

console.log('=== vendor 构建自述版本 ===');
const markedVendorVer = readFileSync(
  path.join(root, 'vendor/marked/marked.min.js'),
  'utf8'
).match(/marked v([0-9]+\.[0-9]+\.[0-9]+)/)[1];
console.log('  marked   :', markedVendorVer, '(vendor 文件头)');
console.log('  DOMPurify:', DOMPurify.version, '(运行时实例自述)');
console.log('');

function render(text) {
  const html = DOMPurify.sanitize(marked.parse(text));
  const wrap = new JSDOM(`<div id="w">${html}</div>`);
  const w = wrap.window.document.getElementById('w');
  return {
    html,
    links: [...w.querySelectorAll('a')].map(a => ({
      href: a.getAttribute('href'),
      text: a.textContent,
      outer: a.outerHTML,
    })),
    hasScript: !!w.querySelector('script'),
    hasImg: !!w.querySelector('img'),
    hasEventAttr: !!w.querySelector('[onerror],[onload],[onclick]'),
    text: w.textContent,
  };
}

console.log('--- 单行链接（应保留 a、href 为 null、文本保留）---');
console.log(JSON.stringify(render('[点我](javascript:alert(1))'), null, 2));
console.log('--- 连续 HTML block 三行（应无 a、无 script、无事件属性）---');
console.log(JSON.stringify(render('<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<img src="y">'), null, 2));
console.log('--- 普通链接对照（href 应原样保留）---');
console.log(JSON.stringify(render('[百度](https://example.com)'), null, 2));
