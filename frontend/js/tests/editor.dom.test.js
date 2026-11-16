// js/tests/editor.dom.test.js —— M5 W4：编辑器 DOM 稳定性补强（M5-03）
//
// 任务书第 22 行要求：「保存状态变化不重建 textarea、不改变选区」。
//
// 本文件严格区分两条路径，断言各自允许的语义（这是 W3→W4 的关键区分点）：
//
//   A. 加载路径（setValue 换文档）
//      换文档本就换了内容，jsdom 在赋**不同**值时会把选区推到末尾——
//      那是「换文档」的合理结果，不是缺陷。因此本路径只断言：
//        · 节点身份不变、父节点不变
//        · 不主动 focus/select
//        · 内容**相同**时选区数值不变（任何路径下都不应发生的行为）
//
//   B. 保存路径（用户输入 → 预览重渲染 / 同步状态变化 → 徽标与状态栏改写）
//      这是 T13（docs/SYNC.md §11.3「自动保存不得重建 <textarea>，否则焦点丢失、
//      光标跳位、IME 组合输入被打断」）的落点。本路径断言：
//        · textarea / 标题 / 预览节点身份不变
//        · selectionStart / selectionEnd 的**具体数值**不变
//        · 编辑区内容不丢失
//
// ⚠ 断言写法说明（两处关键，勿改）：
//
// 1) 选区必须断言**具体数值**，不能用 `typeof x === "number"`
//    ——typeof 对任何取值恒真，检不出选区被重置。
//
// 2) 节点身份必须用 `isConnected` 断言，不能用 `strictEqual(el, elRef)`
//    ——若 elRef 就是同一个对象，该断言恒真（等于 assert.strictEqual(x, x)），
//    即使 DOM 节点已被 cloneNode+replaceChild 替换掉也检不出。
//    真正的判据是：被持有的节点**仍连接在文档中**（isConnected === true），
//    且 document.getElementById 取到的仍是同一个节点。
//
// IME 中文输入法组合输入的人工浏览器验收另记，不在本 DOM 测试内冒充通过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createEditor } from "../editor.js";
import {
  createUiFeedback,
  SyncState,
  StorageFailureReason,
} from "../ui-feedback.js";

function buildEditor() {
  const doc = new JSDOM(
    '<input id="title"><textarea id="content"></textarea><div id="preview"></div>'
  ).window.document;
  const titleInput = doc.getElementById("title");
  const contentInput = doc.getElementById("content");
  const previewElement = doc.getElementById("preview");
  const editor = createEditor({ titleInput, contentInput, previewElement });
  return { editor, doc, titleInput, contentInput, previewElement };
}

test("A 加载路径 setValue：不重建标题/正文节点，也不替换其父节点", () => {
  const { editor, titleInput, contentInput, previewElement } = buildEditor();

  const titleRef = titleInput;
  const contentRef = contentInput;
  const titleParent = titleInput.parentNode;
  const contentParent = contentInput.parentNode;

  editor.setValue({ title: "新标题", content: "# 新正文" });

  // 判据：节点仍连接在文档中，且 document 取到的仍是同一节点
  assert.equal(titleInput.isConnected, true, "标题输入框不得被替换出文档");
  assert.equal(contentInput.isConnected, true, "正文输入框不得被替换出文档");
  assert.equal(
    titleInput.ownerDocument.getElementById("title"),
    titleInput,
    "document 中的标题节点须仍是原节点"
  );
  assert.equal(
    contentInput.ownerDocument.getElementById("content"),
    contentInput,
    "document 中的正文节点须仍是原节点"
  );
  assert.strictEqual(titleInput.parentNode, titleParent, "标题父节点不得改变");
  assert.strictEqual(contentInput.parentNode, contentParent, "正文父节点不得改变");
  // 预览写入的是预览区，不得把输入框挪进预览区
  assert.equal(previewElement.contains(titleInput), false);
  assert.equal(previewElement.contains(contentInput), false);

  editor.destroy();
});

test("A 加载路径 setValue：不主动调用 focus/select，不打断正在进行的输入", () => {
  const { editor, titleInput, contentInput } = buildEditor();

  let focusCalls = 0;
  let selectCalls = 0;
  const contentFocus = contentInput.focus.bind(contentInput);
  contentInput.focus = () => {
    focusCalls += 1;
    contentFocus();
  };
  const contentSelect = contentInput.select.bind(contentInput);
  contentInput.select = () => {
    selectCalls += 1;
    contentSelect();
  };
  const titleFocus = titleInput.focus.bind(titleInput);
  titleInput.focus = () => {
    focusCalls += 1;
    titleFocus();
  };

  editor.setValue({ title: "标题", content: "正文内容" });

  assert.equal(focusCalls, 0, "setValue 不得主动 focus 输入框");
  assert.equal(selectCalls, 0, "setValue 不得主动 select 全选");
  editor.destroy();
});

test("A 加载路径 setValue：内容相同时选区数值保持不变（显式断言具体数值）", () => {
  // 语义边界：加载路径换文档时若内容不同，jsdom 会把选区推到末尾——那是
  // 「换文档」的合理结果。本用例断言的是**内容相同**时选区数值不被改动，
  // 这是任何路径下都不应发生的行为。
  const { editor, contentInput } = buildEditor();
  const contentRef = contentInput;

  contentInput.value = "abcdef";
  contentInput.selectionStart = 2;
  contentInput.selectionEnd = 4;

  editor.setValue({ title: "t", content: "abcdef" });

  assert.equal(contentInput.isConnected, true, "正文节点不得被替换出文档");
  assert.equal(
    contentInput.ownerDocument.getElementById("content"),
    contentInput,
    "document 中的正文节点须仍是原节点"
  );
  assert.equal(contentInput.selectionStart, 2, "选区起点不得被改动");
  assert.equal(contentInput.selectionEnd, 4, "选区终点不得被改动");
  editor.destroy();
});

test("B 保存路径：用户输入导致预览重渲染时，不重建 textarea、不改变选区", () => {
  // 真正的保存路径：用户每次输入都会触发 preview.innerHTML 重写。
  // 若该过程重建了 textarea 或重置了选区，光标会跳位、IME 组合输入会被打断。
  const { editor, doc, titleInput, contentInput, previewElement } = buildEditor();

  const contentRef = contentInput;
  const titleRef = titleInput;
  const previewRef = previewElement;

  contentInput.value = "合并云端版本冲突";
  contentInput.selectionStart = 4;
  contentInput.selectionEnd = 8;

  // 连续多次输入（模拟自动保存期间的连续编辑）
  for (let i = 0; i < 5; i += 1) {
    contentInput.value = `合并云端版本冲突 ${i}`;
    contentInput.selectionStart = 4;
    contentInput.selectionEnd = 8;
    contentInput.dispatchEvent(new doc.defaultView.Event("input"));

    assert.equal(contentInput.isConnected, true, "输入后正文节点不得被替换出文档");
    assert.equal(
      contentInput.ownerDocument.getElementById("content"),
      contentInput,
      "输入后 document 中的正文节点须仍是原节点"
    );
    assert.equal(previewElement.isConnected, true, "输入后预览节点不得被替换出文档");
    assert.equal(
      previewElement.ownerDocument.getElementById("preview"),
      previewElement,
      "输入后 document 中的预览节点须仍是原节点"
    );
    assert.equal(contentInput.selectionStart, 4, "输入后选区起点不得改变");
    assert.equal(contentInput.selectionEnd, 8, "输入后选区终点不得改变");
  }

  editor.destroy();
});

test("B 保存路径：同步状态变化不改写编辑区（节点身份与选区均不变）", () => {
  // ui-feedback.js 是纯 UI 层，elements 中不含编辑器节点，
  // 因此本用例断言的是**可观测的等价事实**：无论状态如何变化，
  // 编辑区的节点身份、选区与内容都不受影响。
  // （若将来 ui-feedback 改为持有编辑器节点，此断言会立即失败——这正是目的。）
  const doc = new JSDOM(
    '<input id="title"><textarea id="content"></textarea>' +
      '<div id="preview"></div>' +
      '<span id="syncBadge"></span><span id="statusText"></span>' +
      '<div id="storageBanner" hidden><span id="storageMessage"></span>' +
      '<button id="btnDownloadDraft"></button></div>'
  ).window.document;

  const titleInput = doc.getElementById("title");
  const contentInput = doc.getElementById("content");
  const previewElement = doc.getElementById("preview");

  const ui = createUiFeedback(
    {
      syncBadge: doc.getElementById("syncBadge"),
      statusText: doc.getElementById("statusText"),
      storageBanner: doc.getElementById("storageBanner"),
      storageMessage: doc.getElementById("storageMessage"),
      storageDownloadBtn: doc.getElementById("btnDownloadDraft"),
    },
    {}
  );

  const contentRef = contentInput;
  const previewRef = previewElement;
  const titleRef = titleInput;

  contentInput.value = "合并云端版本冲突";
  contentInput.selectionStart = 4;
  contentInput.selectionEnd = 8;

  const states = [
    SyncState.DIRTY,
    SyncState.SAVING,
    SyncState.SYNCED,
    SyncState.RETRY_WAIT,
    SyncState.AUTH_REQUIRED,
    SyncState.CONFLICT,
    SyncState.INVALID,
  ];
  for (const state of states) {
    ui.renderSyncState(state, {});
    assert.equal(contentInput.isConnected, true, `${state}: 正文节点不得被替换出文档`);
    assert.equal(
      contentInput.ownerDocument.getElementById("content"),
      contentInput,
      `${state}: document 中的正文节点须仍是原节点`
    );
    assert.equal(previewElement.isConnected, true, `${state}: 预览节点不得被替换出文档`);
    assert.equal(contentInput.selectionStart, 4, `${state}: 选区起点不得改变`);
    assert.equal(contentInput.selectionEnd, 8, `${state}: 选区终点不得改变`);
  }

  // 存储失败条（另一条会改写界面文案的路径）同样不得动编辑区
  ui.showStorageFailure(StorageFailureReason.QUOTA, {
    title: "t",
    content: "合并云端版本冲突",
  });
  assert.equal(contentInput.isConnected, true, "存储失败条: 正文节点不得被替换出文档");
  assert.equal(contentInput.selectionStart, 4, "存储失败条: 选区起点不得改变");
  assert.equal(contentInput.selectionEnd, 8, "存储失败条: 选区终点不得改变");

  // 内存内容不得丢失
  assert.equal(contentInput.value, "合并云端版本冲突", "编辑区内容不得丢失");

  ui.destroy();
});

test("B 保存路径：状态变化不得重建 textarea（节点身份逐状态比对）", () => {
  // 独立用例：即使状态文案完全不变，重复调用 renderSyncState 也不得
  // 以任何方式替换 DOM 节点（防止实现里出现「重建后写回」的写法）。
  const doc = new JSDOM(
    '<span id="syncBadge"></span><span id="statusText"></span>' +
      '<textarea id="content"></textarea>'
  ).window.document;
  const contentInput = doc.getElementById("content");
  const ui = createUiFeedback(
    {
      syncBadge: doc.getElementById("syncBadge"),
      statusText: doc.getElementById("statusText"),
    },
    {}
  );

  const before = contentInput;
  for (let i = 0; i < 20; i += 1) {
    ui.renderSyncState(SyncState.SAVING, {});
  }
  assert.equal(contentInput.isConnected, true, "多次状态变化后正文节点不得被替换出文档");
  assert.equal(
    contentInput.ownerDocument.getElementById("content"),
    contentInput,
    "多次状态变化后 document 中的正文节点须仍是原节点"
  );
  assert.equal(
    doc.querySelectorAll("textarea").length,
    1,
    "不得出现第二个 textarea（重建会留下重复节点）"
  );
  ui.destroy();
});

test("A 加载路径 setValue 不触发 onInput（加载文档不算用户编辑，jsdom 真实事件）", () => {
  const { editor, titleInput, contentInput } = buildEditor();
  const window = titleInput.ownerDocument.defaultView;
  let notified = 0;
  editor.onInput(() => {
    notified += 1;
  });

  editor.setValue({ title: "标题", content: "正文" });
  assert.equal(notified, 0, "setValue 不得触发 onInput");

  // 真实 input 事件仍只回调一次
  contentInput.value = "# 再次输入";
  contentInput.dispatchEvent(new window.Event("input"));
  assert.equal(notified, 1);
  editor.destroy();
});

test("destroy 移除两个输入框的监听，重复调用保持幂等", () => {
  const { editor, titleInput, contentInput } = buildEditor();
  let notified = 0;
  editor.onInput(() => {
    notified += 1;
  });

  editor.destroy();
  editor.destroy();

  titleInput.value = "x";
  contentInput.value = "y";
  titleInput.dispatchEvent(new titleInput.ownerDocument.defaultView.Event("input"));
  contentInput.dispatchEvent(new contentInput.ownerDocument.defaultView.Event("input"));

  assert.equal(notified, 0, "destroy 后不再通知");
  editor.destroy();
});
