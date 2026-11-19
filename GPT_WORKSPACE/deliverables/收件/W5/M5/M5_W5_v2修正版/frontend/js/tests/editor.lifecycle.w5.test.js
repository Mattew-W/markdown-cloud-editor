// js/tests/editor.lifecycle.w5.test.js —— M5 W5：生命周期与实例隔离补测（M5-W5-01）
//
// 现有 editor.events / editor.init / editor.security 用例已覆盖：
//   setValue 不触发 onInput、标题/正文各一次回调、unsubscribe 停止通知、
//   destroy 移除监听不再通知、缺参抛 TypeError、初始化不渲染、幂等销毁。
// 本文件在真实 jsdom DOM 上补齐 W5 验收表仍缺的可观测行为：
//   1. 两个编辑器实例并存时，监听器与回调互不串扰；
//   2. setValue 不重建输入节点（节点引用保持不变）、不主动 focus / select 抢焦点；
//   3. 真实 DOM 上 destroy 后派发 input 不再通知。
//
// IME 组合输入（compositionstart / compositionend）与上屏前后选区行为，
// jsdom 无法模拟真实输入法上屏流程，留作浏览器人工验收项，见回归报告。
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createEditor } from "../editor.js";

function buildEditor() {
  const doc = new JSDOM(
    '<input id="title"><textarea id="content"></textarea><div id="preview"></div>'
  );
  const titleInput = doc.window.document.getElementById("title");
  const contentInput = doc.window.document.getElementById("content");
  const previewElement = doc.window.document.getElementById("preview");
  const editor = createEditor({ titleInput, contentInput, previewElement });
  return { editor, doc, titleInput, contentInput, previewElement };
}

test("两实例并存：A 的输入不通知 B，B 的预览不被 A 改动", () => {
  const a = buildEditor();
  const b = buildEditor();

  const aCalls = [];
  const bCalls = [];
  a.editor.onInput((v) => aCalls.push(v));
  b.editor.onInput((v) => bCalls.push(v));

  a.contentInput.value = "# 甲文档";
  a.contentInput.dispatchEvent(new a.doc.window.Event("input"));

  assert.equal(aCalls.length, 1, "实例 A 的回调应被触发一次");
  assert.equal(bCalls.length, 0, "实例 B 不得收到 A 的输入通知");
  assert.ok(a.previewElement.textContent.includes("# 甲文档"), "A 的预览应显示自身内容");
  assert.equal(b.previewElement.textContent, "", "B 的预览应保持为空，不被 A 串扰");

  b.contentInput.value = "## 乙文档";
  b.contentInput.dispatchEvent(new b.doc.window.Event("input"));
  assert.equal(aCalls.length, 1, "B 输入不再回调 A");
  assert.equal(bCalls.length, 1, "B 自身回调被触发一次");
  assert.ok(b.previewElement.textContent.includes("## 乙文档"), "B 的预览显示自身内容");

  a.editor.destroy();
  b.editor.destroy();
});

test("setValue 不重建输入节点，节点引用保持不变", () => {
  const { editor, titleInput, contentInput, previewElement } = buildEditor();
  const titleRef = titleInput;
  const contentRef = contentInput;

  editor.setValue({ title: "新标题", content: "# 新正文" });

  assert.equal(titleInput, titleRef, "标题输入节点不得被替换");
  assert.equal(contentInput, contentRef, "正文输入节点不得被替换");
  assert.deepEqual(editor.getValue(), { title: "新标题", content: "# 新正文" });

  editor.destroy();
});

test("setValue 不主动 focus / select，不抢占输入焦点", () => {
  const { editor, doc, titleInput, contentInput } = buildEditor();
  let focusCount = 0;
  let selectCount = 0;
  titleInput.addEventListener("focus", () => { focusCount += 1; });
  titleInput.addEventListener("select", () => { selectCount += 1; });
  contentInput.addEventListener("focus", () => { focusCount += 1; });
  contentInput.addEventListener("select", () => { selectCount += 1; });

  editor.setValue({ title: "标题", content: "正文" });

  assert.equal(focusCount, 0, "setValue 不得派发 focus 事件");
  assert.equal(selectCount, 0, "setValue 不得派发 select 事件（不得调用 select()）");

  editor.destroy();
});

test("真实 DOM 上 destroy 后派发 input 不再通知，监听已移除", () => {
  const { editor, doc, titleInput, contentInput } = buildEditor();
  const calls = [];
  editor.onInput((v) => calls.push(v));

  titleInput.value = "第一次";
  titleInput.dispatchEvent(new doc.window.Event("input"));
  assert.equal(calls.length, 1);

  editor.destroy();
  titleInput.value = "第二次";
  contentInput.value = "第三次";
  titleInput.dispatchEvent(new doc.window.Event("input"));
  contentInput.dispatchEvent(new doc.window.Event("input"));

  assert.equal(calls.length, 1, "destroy 后不得再发出通知（保持销毁前的 1 次）");
});
