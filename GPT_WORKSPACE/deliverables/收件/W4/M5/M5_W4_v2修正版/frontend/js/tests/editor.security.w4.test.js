// js/tests/editor.security.w4.test.js —— M5 W4：安全渲染补强（M5-04）+ 版本闭环（M5-05）
// 使用 jsdom + 真实 marked 12.0.2 + 真实 DOMPurify 3.3.3（与运行时 vendor 同版本），
// 检查真实 DOM 结果；单行 Markdown 链接与连续 HTML block 分开测，
// 不能由“没有危险 href”推断 a 元素一定保留或删除。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { marked } from "marked";
import { createEditor } from "../editor.js";

const baseDom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const DOMPurify = createDOMPurify(baseDom.window);
const parseMarkdown = (text) => marked.parse(text);
const sanitizeHtml = (html) => DOMPurify.sanitize(html);

function buildEditor() {
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
    parseMarkdown,
    sanitizeHtml,
  });
  return { editor, previewElement };
}

test("单行 javascript: 链接：a 元素保留、危险 href 被剥离、链接文本保留", () => {
  const { editor, previewElement } = buildEditor();
  editor.setValue({ title: "t", content: "[点我](javascript:alert(1))" });

  const a = previewElement.querySelector("a");
  assert.ok(a, "单行链接应保留 a 元素（不能因 href 被剥离就判定整链删除）");
  assert.equal(a.getAttribute("href"), null, "javascript: href 必须被剥离");
  assert.equal(a.textContent, "点我", "链接文本作为纯文本保留");
  assert.equal(
    previewElement.querySelector('a[href^="javascript:"]'),
    null,
    "不得残留 javascript: 开头的 href"
  );
  editor.destroy();
});

test("连续 HTML block：无链接、无脚本、无任何事件属性", () => {
  const { editor, previewElement } = buildEditor();
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

test("普通 https 链接正常保留 href（对照：安全净化不得过度删除合法链接）", () => {
  const { editor, previewElement } = buildEditor();
  editor.setValue({ title: "t", content: "[百度](https://example.com)" });

  const a = previewElement.querySelector("a");
  assert.ok(a, "合法链接应保留 a 元素");
  assert.equal(a.getAttribute("href"), "https://example.com");
  assert.equal(a.textContent, "百度");
  editor.destroy();
});

test("版本闭环：package.json 精确版本 = node_modules 实测 = vendor 本地托管版本", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, "..", "..");

  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const markedPkg = JSON.parse(
    readFileSync(path.join(root, "node_modules/marked/package.json"), "utf8")
  );
  const purifyPkg = JSON.parse(
    readFileSync(path.join(root, "node_modules/dompurify/package.json"), "utf8")
  );

  const markedVendor = readFileSync(
    path.join(root, "vendor/marked/marked.min.js"),
    "utf8"
  );
  const purifyVendor = readFileSync(
    path.join(root, "vendor/dompurify/purify.min.js"),
    "utf8"
  );
  const markedVendorVer = markedVendor.match(/marked v([0-9]+\.[0-9]+\.[0-9]+)/)[1];
  const purifyVendorVer = purifyVendor.match(/version="([0-9]+\.[0-9]+\.[0-9]+)"/)[1];

  assert.equal(
    pkg.devDependencies.marked,
    markedPkg.version,
    "package.json 与 node_modules marked 版本一致"
  );
  assert.equal(
    markedVendorVer,
    markedPkg.version,
    "vendor marked 与运行依赖版本一致"
  );
  assert.equal(
    pkg.devDependencies.dompurify,
    purifyPkg.version,
    "package.json 与 node_modules DOMPurify 版本一致"
  );
  assert.equal(
    purifyVendorVer,
    purifyPkg.version,
    "vendor DOMPurify 与运行依赖版本一致"
  );
});
