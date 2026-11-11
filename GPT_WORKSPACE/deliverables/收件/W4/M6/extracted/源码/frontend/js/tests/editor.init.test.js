// js/tests/editor.init.test.js —— M5 W3 集成候选：初始化与幂等性测试
// 覆盖 W3 任务书第 12 行「至少覆盖初始化与销毁」中的「初始化」，
// 以及第 11 行要求的「unsubscribe、destroy 幂等」。
// 幂等指重复调用不得产生额外副作用（不抛错、不重复通知）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditor } from "../editor.js";

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
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

function makeFakePreview() {
  return { textContent: "", innerHTML: "" };
}

test("createEditor 缺少必填参数时抛 TypeError", () => {
  const title = makeFakeInput();
  const content = makeFakeInput();

  assert.throws(
    () => createEditor({ titleInput: title, contentInput: content }),
    TypeError,
    "缺 previewElement 必须抛 TypeError"
  );
  assert.throws(
    () => createEditor({ titleInput: title, previewElement: makeFakePreview() }),
    TypeError,
    "缺 contentInput 必须抛 TypeError"
  );
  assert.throws(
    () => createEditor({ contentInput: content, previewElement: makeFakePreview() }),
    TypeError,
    "缺 titleInput 必须抛 TypeError"
  );
});

test("初始化：注册 input 监听但不渲染预览、不触发 onInput", () => {
  const title = makeFakeInput("初始标题");
  const content = makeFakeInput("初始正文");
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

  assert.equal(title.listenerCount("input"), 1, "标题输入应注册 1 个 input 监听");
  assert.equal(content.listenerCount("input"), 1, "正文输入应注册 1 个 input 监听");
  assert.equal(preview.textContent, "", "初始化阶段不得渲染预览");
  assert.equal(preview.innerHTML, "", "初始化阶段不得写入 innerHTML");
  assert.equal(notified, 0, "初始化不得触发 onInput");

  // 初始值原样可读
  assert.deepEqual(editor.getValue(), { title: "初始标题", content: "初始正文" });
});

test("unsubscribe 重复调用保持幂等（不抛错、不重复通知）", () => {
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
  assert.equal(payloads.length, 1);

  unsubscribe();
  unsubscribe();
  unsubscribe();

  title.value = "第二次";
  title.fire("input");
  content.value = "第三次";
  content.fire("input");

  assert.equal(payloads.length, 1, "重复退订后不得再收到通知");
  assert.deepEqual(payloads[0], { title: "第一次", content: "b" });
  assert.equal(title.listenerCount("input"), 1, "退订不得影响 DOM 监听（编辑器仍需响应输入）");
});

test("destroy 重复调用保持幂等（不抛错、监听不重复移除）", () => {
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
  // 二次调用不得使监听器被重复移除（removeEventListener 若被重复调用，
  // 在真实 DOM 中是幂等的，但此处断言"移除后监听数仍为 0"以锚定最终状态）
  editor.destroy();
  editor.destroy();

  title.value = "x";
  title.fire("input");
  content.value = "y";
  content.fire("input");

  assert.equal(payloads.length, 0, "重复 destroy 后不得再通知");
  assert.equal(title.listenerCount("input"), 0, "destroy 后监听应被移除");
  assert.equal(content.listenerCount("input"), 0, "destroy 后监听应被移除");
});

test("destroy 后再 onInput 订阅无效：销毁后的实例不再响应输入", () => {
  // 说明（变异测试结论，勿删）：
  // editor.js:41 的 `if (destroyed) return;` 属于**防御性冗余**——
  // destroy() 已移除 title/content 的 DOM 监听，因此 notify 根本不会被调用，
  // 移除该早退分支不会产生任何可观测的行为差异（变异测试实测：该变异未被检出）。
  // 与 M6 的 SyntaxError 判别属同类情形：代码路径存在但不可达。
  //
  // 本用例断言的是**可观测的最终状态**（销毁后的实例不再响应输入），
  // 而非"某一行早退代码存在"。后者无法用行为断言证明。
  const title = makeFakeInput("a");
  const content = makeFakeInput("b");
  const preview = makeFakePreview();
  const editor = createEditor({
    titleInput: title,
    contentInput: content,
    previewElement: preview,
  });

  editor.destroy();

  const payloads = [];
  editor.onInput((v) => payloads.push(v));

  title.value = "x";
  title.fire("input");
  content.value = "y";
  content.fire("input");

  assert.equal(payloads.length, 0, "destroy 后的实例不得再发出通知");
});
