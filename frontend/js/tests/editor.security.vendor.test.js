// js/tests/editor.security.vendor.test.js —— M5 W4 补强（M5-04）
//
// 任务书第 23 行要求：「**用运行 vendor 真实版本**验证 script/onerror/javascript: 的 DOM 结果」。
// editor.security.w4.test.js 虽已覆盖两种输入形态，但其 DOM 断言跑的是 node_modules
// 里的 npm 包；vendor 构建仅被当作纯文本读入并正则提取版本号比对，从未被执行。
//
// 本文件补齐「测的就是运行时真正加载的那份构建」这一环：
//   - 用 jsdom runScripts 真实执行 vendor/marked/marked.min.js 与 vendor/dompurify/purify.min.js
//     （UMD 经典脚本，与 index.html 中 <script src="vendor/…"> 的加载方式一致）
//   - 断言 vendor 实例自述版本与 package.json 声明一致
//   - 用该 vendor 实例重复断言两条关键 DOM 结果
//
// 断言口径（与 editor.security.w4.test.js 保持一致，不重复其用例）：
//   1. 单行 Markdown 链接：a 元素保留、危险 href 被剥离为 null、链接文本保留
//   2. 连续 HTML block：无 a 元素、无 script 节点、无任何事件处理属性
//
// 不能由「没有危险 href」推断 a 元素一定保留或一定删除——两种结果都须显式断言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import { createEditor } from "../editor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");

/**
 * 以浏览器等价方式加载 vendor 里的经典脚本构建，返回其 window。
 * runScripts:"dangerously" 让 jsdom 真正执行 UMD 脚本并挂出全局对象，
 * 与浏览器 <script src> 的行为一致；否则 vendor 只是一段不会被执行的文本。
 */
function loadVendorWindow() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    runScripts: "dangerously",
  });
  dom.window.eval(
    readFileSync(path.join(root, "vendor/marked/marked.min.js"), "utf8")
  );
  dom.window.eval(
    readFileSync(path.join(root, "vendor/dompurify/purify.min.js"), "utf8")
  );
  return dom.window;
}

function buildEditorWithVendor(vendorWindow) {
  const doc = new JSDOM(
    '<input id="title"><textarea id="content"></textarea><div id="preview"></div>'
  );
  const titleInput = doc.window.document.getElementById("title");
  const contentInput = doc.window.document.getElementById("content");
  const previewElement = doc.window.document.getElementById("preview");
  const editor = createEditor({
    titleInput,
    contentInput,
    previewElement,
    parseMarkdown: (text) => vendorWindow.marked.parse(text),
    sanitizeHtml: (html) => vendorWindow.DOMPurify.sanitize(html),
  });
  return { editor, previewElement };
}

test("vendor 构建可被真实执行并自述版本（与 package.json 声明一致）", () => {
  const w = loadVendorWindow();

  assert.ok(w.marked, "vendor 的 marked 构建应挂出全局 marked");
  assert.ok(w.DOMPurify, "vendor 的 DOMPurify 构建应挂出全局 DOMPurify");
  assert.equal(
    w.DOMPurify.version,
    "3.3.3",
    "vendor 的 DOMPurify 必须自述 3.3.3（与版本对照表一致）"
  );

  const pkg = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  assert.equal(
    pkg.devDependencies.dompurify,
    w.DOMPurify.version,
    "package.json 声明的 dompurify 版本须与 vendor 运行时版本一致"
  );

  const markedVendorVer = readFileSync(
    path.join(root, "vendor/marked/marked.min.js"),
    "utf8"
  ).match(/marked v([0-9]+\.[0-9]+\.[0-9]+)/)[1];
  assert.equal(
    pkg.devDependencies.marked,
    markedVendorVer,
    "package.json 声明的 marked 版本须与 vendor 运行时版本一致"
  );
});

test("vendor 真实构建：单行 javascript: 链接——a 元素保留、href 剥离为 null、文本保留", () => {
  const w = loadVendorWindow();
  const { editor, previewElement } = buildEditorWithVendor(w);

  editor.setValue({ title: "t", content: "[点我](javascript:alert(1))" });

  const a = previewElement.querySelector("a");
  assert.ok(a, "单行链接在 vendor 构建下同样应保留 a 元素");
  assert.equal(a.getAttribute("href"), null, "javascript: href 必须被剥离");
  assert.equal(a.textContent, "点我", "链接文本作为纯文本保留");
  assert.equal(
    previewElement.querySelector('a[href^="javascript:"]'),
    null,
    "不得残留 javascript: 开头的 href"
  );
  editor.destroy();
});

test("vendor 真实构建：连续 HTML block——无 a、无 script、无事件属性", () => {
  const w = loadVendorWindow();
  const { editor, previewElement } = buildEditorWithVendor(w);

  editor.setValue({
    title: "t",
    content:
      '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n<img src="y">',
  });

  assert.equal(previewElement.querySelector("a"), null, "HTML block 不得生成链接");
  assert.equal(previewElement.querySelector("script"), null, "不得保留 script 节点");
  assert.equal(
    previewElement.querySelector("[onerror],[onload],[onclick]"),
    null,
    "不得保留任何事件处理属性"
  );
  editor.destroy();
});

test("vendor 真实构建：合法 https 链接正常保留（对照，净化不得过度删除）", () => {
  const w = loadVendorWindow();
  const { editor, previewElement } = buildEditorWithVendor(w);

  editor.setValue({ title: "t", content: "[百度](https://example.com)" });

  const a = previewElement.querySelector("a");
  assert.ok(a, "合法链接在 vendor 构建下同样应保留 a 元素");
  assert.equal(a.getAttribute("href"), "https://example.com");
  assert.equal(a.textContent, "百度");
  editor.destroy();
});
