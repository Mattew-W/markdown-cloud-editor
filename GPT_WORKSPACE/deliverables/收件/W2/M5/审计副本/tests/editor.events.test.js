// tests/editor.events.test.js —— W2 阶段1：事件逻辑测试
// 使用最小 DOM 桩（仅测试事件逻辑，任务允许 mock）；
// 安全净化测试必须使用真实 DOMPurify，将在阶段2 进行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditor } from "../js/editor.js";

function makeFakeInput(initialValue = "") {
  const listeners = new Map();
  return {
    value: initialValue,
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(cb);
    },
    removeEventListener(type, cb) {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    },
    fire(type) {
      const arr = listeners.get(type) || [];
      arr.slice().forEach((cb) => cb());
    },
  };
}

function makeFakePreview() {
  return { textContent: "", innerHTML: "" };
}

test("setValue 更新标题/正文/预览且不触发 onInput", () => {
  const title = makeFakeInput("旧标题");
  const content = makeFakeInput("旧正文");
  const preview = makeFakePreview();
  const editor = createEditor({
    titleInput: title,
    contentInput: content,
    previewElement: preview,
  });

  let notified = 0;
  editor.onInput(() => {
    notified += 1;
  });

  editor.setValue({ title: "新标题", content: "新正文" });

  assert.equal(title.value, "新标题");
  assert.equal(content.value, "新正文");
  assert.equal(preview.textContent, "新正文");
  assert.equal(notified, 0, "setValue 不得触发 onInput（加载文档不算用户编辑）");
});

test("标题 input 触发一次回调，载荷含完整 title/content", () => {
  const title = makeFakeInput("a");
  const content = makeFakeInput("b");
  const preview = makeFakePreview();
  const editor = createEditor({
    titleInput: title,
    contentInput: content,
    previewElement: preview,
  });

  const payloads = [];
  editor.onInput((v) => payloads.push(v));

  title.value = "新标题";
  title.fire("input");

  assert.equal(payloads.length, 1, "一次 input 事件只回调一次");
  assert.deepEqual(payloads[0], { title: "新标题", content: "b" });
});

test("正文 input 触发一次回调并刷新预览", () => {
  const title = makeFakeInput("标题");
  const content = makeFakeInput("旧正文");
  const preview = makeFakePreview();
  const editor = createEditor({
    titleInput: title,
    contentInput: content,
    previewElement: preview,
  });

  const payloads = [];
  editor.onInput((v) => payloads.push(v));

  content.value = "# 新正文";
  content.fire("input");

  assert.equal(payloads.length, 1, "一次 input 事件只回调一次");
  assert.deepEqual(payloads[0], { title: "标题", content: "# 新正文" });
  assert.equal(preview.textContent, "# 新正文");
});

test("onInput 返回的 unsubscribe 可停止通知", () => {
  const title = makeFakeInput("a");
  const content = makeFakeInput("b");
  const preview = makeFakePreview();
  const editor = createEditor({
    titleInput: title,
    contentInput: content,
    previewElement: preview,
  });

  const payloads = [];
  const unsubscribe = editor.onInput((v) => payloads.push(v));

  title.value = "第一次";
  title.fire("input");
  unsubscribe();
  title.value = "第二次";
  title.fire("input");

  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], { title: "第一次", content: "b" });
});

test("destroy 后移除监听且不再通知", () => {
  const title = makeFakeInput("a");
  const content = makeFakeInput("b");
  const preview = makeFakePreview();
  const editor = createEditor({
    titleInput: title,
    contentInput: content,
    previewElement: preview,
  });

  const payloads = [];
  editor.onInput((v) => payloads.push(v));
  editor.destroy();

  title.value = "x";
  title.fire("input");
  content.value = "y";
  content.fire("input");

  assert.equal(payloads.length, 0, "destroy 后不得再通知");
});

test("getValue 返回当前标题与正文", () => {
  const title = makeFakeInput("我的标题");
  const content = makeFakeInput("我的正文");
  const preview = makeFakePreview();
  const editor = createEditor({
    titleInput: title,
    contentInput: content,
    previewElement: preview,
  });

  assert.deepEqual(editor.getValue(), { title: "我的标题", content: "我的正文" });
});
