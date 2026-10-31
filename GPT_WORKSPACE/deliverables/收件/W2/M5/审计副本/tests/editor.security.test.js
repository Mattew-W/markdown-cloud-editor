// tests/editor.security.test.js —— W2 阶段2：真实净化安全测试
// 使用 jsdom 提供 DOM，真实 DOMPurify 通过该 DOM 环境初始化；
// 真实 marked 解析。测试检查 DOM 结果，不只看"函数被调用"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { marked } from "marked";
import { createEditor } from "../js/editor.js";

const baseDom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
const { window } = baseDom;
const DOMPurify = createDOMPurify(window);
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
  return { editor, doc, titleInput, contentInput, previewElement };
}

test("正常 Markdown：标题/加粗/代码块正确渲染", () => {
  const { editor, previewElement } = buildEditor();
  editor.setValue({
    title: "t",
    content: "# 一级标题\n\n**加粗**\n\n```js\nconst a = 1;\n```",
  });

  const h1 = previewElement.querySelector("h1");
  assert.ok(h1, "应渲染出 h1");
  assert.equal(h1.textContent, "一级标题");

  const strong = previewElement.querySelector("strong");
  assert.ok(strong, "应渲染出 strong");
  assert.equal(strong.textContent, "加粗");

  assert.ok(previewElement.querySelector("pre code"), "应渲染出代码块 pre code");
});

test("script 标签经真实净化后不保留", () => {
  const { editor, previewElement } = buildEditor();
  editor.setValue({
    title: "t",
    content: "<script>alert(1)</script>\n\n# 标题",
  });

  assert.equal(previewElement.querySelector("script"), null, "不得存在 script 节点");
  assert.ok(!previewElement.textContent.includes("alert(1)"), "脚本内容不得残留");
});

test("img onerror 事件属性经真实净化后移除", () => {
  const { editor, previewElement } = buildEditor();
  editor.setValue({
    title: "t",
    content: '<img src="x" onerror="alert(1)">',
  });

  assert.equal(
    previewElement.querySelector("[onerror]"),
    null,
    "不得存在带 onerror 属性的元素"
  );
});

test("javascript: 链接经真实净化后不保留危险 href", () => {
  const { editor, previewElement } = buildEditor();
  editor.setValue({
    title: "t",
    content: "[点我](javascript:alert(1))",
  });

  assert.equal(
    previewElement.querySelector('a[href^="javascript:"]'),
    null,
    "不得存在 javascript: 开头的链接"
  );
  const allLinks = previewElement.querySelectorAll("a[href]");
  for (const a of allLinks) {
    assert.ok(
      !a.getAttribute("href").toLowerCase().startsWith("javascript:"),
      "任何链接都不得带 javascript: href"
    );
  }
});

test("标题/列表恶意字符串仍是文本（textContent 渲染）", () => {
  // 文档列表：与 demo.js 相同的方式——createElement + textContent
  const doc = new JSDOM('<ul id="list"></ul>');
  const list = doc.window.document.getElementById("list");
  const maliciousTitle =
    '<img src=x onerror="alert(1)"><script>alert(2)</script>标题';

  const li = doc.window.document.createElement("li");
  li.textContent = maliciousTitle;
  list.appendChild(li);

  assert.equal(list.querySelector("img,script"), null, "不得生成危险节点");
  assert.equal(li.textContent, maliciousTitle, "原文作为纯文本保留");

  // 标题输入：input.value 只是字符串，不解释为 HTML
  const { editor, titleInput } = buildEditor();
  titleInput.value = maliciousTitle;
  assert.equal(editor.getValue().title, maliciousTitle);
});

test("setValue 不发输入通知（真实 DOM）", () => {
  const { editor, doc, titleInput, contentInput } = buildEditor();
  let notified = 0;
  editor.onInput(() => {
    notified += 1;
  });

  editor.setValue({ title: "a", content: "b" });
  assert.equal(notified, 0, "setValue 不得触发 onInput");
});

test("标题与正文各自输入都发一次正确载荷（真实 DOM）", () => {
  const { editor, doc, titleInput, contentInput } = buildEditor();
  const payloads = [];
  editor.onInput((v) => payloads.push(v));

  titleInput.value = "新标题";
  titleInput.dispatchEvent(new doc.window.Event("input"));
  assert.equal(payloads.length, 1, "标题 input 一次事件一次回调");
  assert.deepEqual(payloads[0], { title: "新标题", content: "" });

  contentInput.value = "# 正文";
  contentInput.dispatchEvent(new doc.window.Event("input"));
  assert.equal(payloads.length, 2, "正文 input 一次事件一次回调");
  assert.deepEqual(payloads[1], { title: "新标题", content: "# 正文" });
});

test("取消订阅/destroy 后不再通知（真实 DOM）", () => {
  const { editor, doc, titleInput, contentInput } = buildEditor();
  const payloads = [];
  const unsubscribe = editor.onInput((v) => payloads.push(v));

  titleInput.value = "x";
  titleInput.dispatchEvent(new doc.window.Event("input"));
  assert.equal(payloads.length, 1);

  unsubscribe();
  contentInput.value = "y";
  contentInput.dispatchEvent(new doc.window.Event("input"));
  assert.equal(payloads.length, 1, "unsubscribe 后不再通知");

  editor.destroy();
  contentInput.dispatchEvent(new doc.window.Event("input"));
  assert.equal(payloads.length, 1, "destroy 后不再通知");
});
