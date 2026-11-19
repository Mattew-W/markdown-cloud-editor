// js/tests/vendor.preview.w5.test.js —— M5 W5：生产 vendor 路径预览与版本闭环（M5-W5-02）
//
// 现有 editor.security.test.js 通过 npm 依赖（import { marked } / import createDOMPurify）
// 走测试库做净化断言；本文件补齐验收表要求的另一条路径——直接读取并惰性执行
// 页面实际托管的 vendor/*.min.js，在与 index.html 相同的运行时库上走
// marked.parse → DOMPurify.sanitize → innerHTML 真实链路，断言净化后的 DOM 结果。
//
// 区分口径：测试依赖（node_modules）与页面 vendor（vendor/）分别记录，
// 二者版本必须与 package.json 三方一致（版本闭环）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import { createEditor } from "../editor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", ".."); // frontend/

/**
 * 把页面生产 vendor 文件惰性加载到 jsdom 窗口，返回 marked 与 DOMPurify 实例。
 * UMD 在 window.eval 的浏览器分支把挂载点落到 Node 侧 globalThis，
 * 执行后须清理，避免跨用例污染。
 */
function loadVendor(window) {
  const markedCode = readFileSync(
    path.join(root, "vendor", "marked", "marked.min.js"),
    "utf8"
  );
  const purifyCode = readFileSync(
    path.join(root, "vendor", "dompurify", "purify.min.js"),
    "utf8"
  );
  window.eval(markedCode);
  window.eval(purifyCode);

  const marked = globalThis.marked;
  const PurifyFactory = globalThis.DOMPurify;
  assert.ok(marked && typeof marked.parse === "function", "vendor marked 必须可解析");
  assert.ok(typeof PurifyFactory === "function" || typeof PurifyFactory.sanitize === "function",
    "vendor DOMPurify 必须可用");
  const Purify =
    typeof PurifyFactory.sanitize === "function" ? PurifyFactory : PurifyFactory(window);

  return {
    marked,
    Purify,
    cleanup() {
      delete globalThis.marked;
      delete globalThis.DOMPurify;
    },
  };
}

function buildEditorWithVendor() {
  const doc = new JSDOM(
    '<input id="title"><textarea id="content"></textarea><div id="preview"></div>'
  );
  const vendor = loadVendor(doc.window);
  const editor = createEditor({
    titleInput: doc.window.document.getElementById("title"),
    contentInput: doc.window.document.getElementById("content"),
    previewElement: doc.window.document.getElementById("preview"),
    parseMarkdown: (text) => vendor.marked.parse(text),
    sanitizeHtml: (html) => vendor.Purify.sanitize(html),
  });
  return { editor, doc, vendor };
}

test("生产 vendor：普通 Markdown 标题与合法 https 链接正常保留", () => {
  const { editor, previewElement, vendor } = (() => {
    const r = buildEditorWithVendor();
    const previewElement = r.doc.window.document.getElementById("preview");
    return { ...r, previewElement };
  })();
  try {
    editor.setValue({ title: "t", content: "# 一级标题\n\n[百度](https://example.com)" });
    const h1 = previewElement.querySelector("h1");
    assert.ok(h1, "应渲染出 h1");
    const a = previewElement.querySelector("a");
    assert.ok(a, "合法链接应保留 a 元素");
    assert.equal(a.getAttribute("href"), "https://example.com");
    assert.equal(a.textContent, "百度");
  } finally {
    editor.destroy();
    vendor.cleanup();
  }
});

test("生产 vendor：单行 javascript: 链接保留 a 与文本，危险 href 被剥离", () => {
  const { doc, editor, vendor } = buildEditorWithVendor();
  const previewElement = doc.window.document.getElementById("preview");
  try {
    editor.setValue({ title: "t", content: "[点我](javascript:alert(1))" });
    const a = previewElement.querySelector("a");
    assert.ok(a, "单行链接应保留 a 元素（不得因 href 被剥离就整链删除）");
    assert.equal(a.getAttribute("href"), null, "javascript: href 必须被剥离");
    assert.equal(a.textContent, "点我", "链接文本作为纯文本保留");
    assert.equal(previewElement.querySelector('a[href^="javascript:"]'), null,
      "不得残留 javascript: 开头的 href");
  } finally {
    editor.destroy();
    vendor.cleanup();
  }
});

test("生产 vendor：连续 HTML block 无 script、无事件属性、无残留链接", () => {
  const { doc, editor, vendor } = buildEditorWithVendor();
  const previewElement = doc.window.document.getElementById("preview");
  try {
    editor.setValue({
      title: "t",
      content:
        '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<img src="y">',
    });
    assert.equal(previewElement.querySelector("script"), null, "不得保留 script 节点");
    assert.equal(
      previewElement.querySelector("[onerror],[onload],[onclick]"),
      null,
      "不得保留任何事件处理属性"
    );
    assert.equal(previewElement.querySelector("a"), null, "HTML block 不得生成链接");
  } finally {
    editor.destroy();
    vendor.cleanup();
  }
});

test("版本闭环：package.json = node_modules 实测 = vendor 本地托管版本", () => {
  const pkg = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  const markedPkg = JSON.parse(
    readFileSync(path.join(root, "node_modules", "marked", "package.json"), "utf8")
  );
  const purifyPkg = JSON.parse(
    readFileSync(path.join(root, "node_modules", "dompurify", "package.json"), "utf8")
  );

  const markedVendor = readFileSync(
    path.join(root, "vendor", "marked", "marked.min.js"),
    "utf8"
  );
  const purifyVendor = readFileSync(
    path.join(root, "vendor", "dompurify", "purify.min.js"),
    "utf8"
  );
  const markedVendorVer = markedVendor.match(/marked v([0-9]+\.[0-9]+\.[0-9]+)/)[1];
  const purifyVendorVer = (
    purifyVendor.match(/DOMPurify ([0-9]+\.[0-9]+\.[0-9]+)/) ||
    purifyVendor.match(/version="([0-9]+\.[0-9]+\.[0-9]+)"/)
  )[1];

  assert.equal(pkg.devDependencies.marked, markedPkg.version,
    "package.json 与 node_modules marked 版本一致");
  assert.equal(markedVendorVer, markedPkg.version,
    "vendor marked 与运行依赖版本一致");
  assert.equal(pkg.devDependencies.dompurify, purifyPkg.version,
    "package.json 与 node_modules DOMPurify 版本一致");
  assert.equal(purifyVendorVer, purifyPkg.version,
    "vendor DOMPurify 与运行依赖版本一致");
});

test("index.html 实际加载本地 vendor 路径，不引用外部 CDN 脚本", () => {
  const html = readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.includes('src="vendor/marked/marked.min.js"'),
    "页面必须加载本地 vendor marked");
  assert.ok(html.includes('src="vendor/dompurify/purify.min.js"'),
    "页面必须加载本地 vendor DOMPurify");
  assert.equal(/<script[^>]+src="https?:\/\//i.test(html), false,
    "不得从外部 CDN 加载运行时库");
});
