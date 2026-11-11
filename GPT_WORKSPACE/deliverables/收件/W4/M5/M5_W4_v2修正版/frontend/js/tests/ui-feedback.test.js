// js/tests/ui-feedback.test.js —— M5 W4：UI 反馈层（状态徽标 / 存储失败条 / 冲突选择 / 错误提示）
// 纯映射函数直接断言；控制器用 jsdom 提供真实 DOM（classList / textContent / addEventListener）。
// 本层只接收状态、上抛选择，不持有文档版本/token/草稿，不发请求、不清草稿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  SyncState,
  ConflictChoice,
  StorageFailureReason,
  stateMeta,
  storageFailureText,
  errorNotice,
  createUiFeedback,
} from "../ui-feedback.js";

function buildDom() {
  const dom = new JSDOM(
    `<body>
      <div id="syncBadge"></div>
      <span id="statusText"></span>
      <div id="storageBanner" class="hidden">
        <span id="storageMessage"></span>
        <button id="btnDownloadDraft" type="button"></button>
      </div>
      <div id="conflictModal" class="hidden">
        <strong id="serverVersionText"></strong>
        <strong id="localVersionText"></strong>
        <pre id="cloudVersionText"></pre>
        <button id="btnViewCloud" type="button"></button>
        <button id="btnAdoptCloud" type="button"></button>
        <button id="btnSaveCopy" type="button"></button>
        <button id="btnManualMerge" type="button"></button>
        <button id="btnConflictCancel" type="button"></button>
      </div>
    </body>`
  );
  const doc = dom.window.document;
  const q = (id) => doc.getElementById(id);
  return {
    doc,
    elements: {
      syncBadge: q("syncBadge"),
      statusText: q("statusText"),
      storageBanner: q("storageBanner"),
      storageMessage: q("storageMessage"),
      storageDownloadBtn: q("btnDownloadDraft"),
      conflictModal: q("conflictModal"),
      serverVersionText: q("serverVersionText"),
      localVersionText: q("localVersionText"),
      cloudVersionText: q("cloudVersionText"),
      btnViewCloud: q("btnViewCloud"),
      btnAdoptCloud: q("btnAdoptCloud"),
      btnSaveCopy: q("btnSaveCopy"),
      btnManualMerge: q("btnManualMerge"),
      btnConflictCancel: q("btnConflictCancel"),
    },
  };
}

// ---------- 纯函数：七状态文案 ----------

test("七状态分别映射到对应徽标类与文案", () => {
  const cases = [
    [SyncState.SYNCED, "badge-synced", "✓ 已同步"],
    [SyncState.DIRTY, "badge-dirty", "• 本地已备份"],
    [SyncState.SAVING, "badge-saving", "⏳ 保存中…"],
    [SyncState.RETRY_WAIT, "badge-retry", "⚠️ 等待重试"],
    [SyncState.AUTH_REQUIRED, "badge-auth", "🔒 需要登录"],
    [SyncState.CONFLICT, "badge-conflict", "✕ 版本冲突"],
    [SyncState.INVALID, "badge-invalid", "✕ 校验错误"],
  ];
  for (const [state, badgeClass, badgeText] of cases) {
    const meta = stateMeta(state);
    assert.equal(meta.badgeClass, badgeClass, `${state} 徽标类`);
    assert.equal(meta.badgeText, badgeText, `${state} 徽标文案`);
  }
});

test("dirty 只表达本地备份，禁止出现已同步/保存成功/已保存字样", () => {
  const meta = stateMeta(SyncState.DIRTY);
  for (const banned of ["已同步", "保存成功", "已保存"]) {
    assert.ok(!meta.badgeText.includes(banned), `徽标不得含「${banned}」`);
    assert.ok(!meta.statusText.includes(banned), `状态栏不得含「${banned}」`);
  }
});

test("saving 文案不宣称已同步", () => {
  const meta = stateMeta(SyncState.SAVING);
  assert.ok(!meta.statusText.includes("已同步"), "保存中不得说已同步");
});

test("payload.message 仅覆盖 dirty / retry_wait 状态栏，payload.error 覆盖 invalid", () => {
  const dirty = stateMeta(SyncState.DIRTY, { message: "已在本地备份" });
  assert.equal(dirty.statusText, "已在本地备份");

  const retry = stateMeta(SyncState.RETRY_WAIT, { message: "网络中断，稍后重试" });
  assert.equal(retry.statusText, "网络中断，稍后重试");

  const invalid = stateMeta(SyncState.INVALID, { error: "标题超长" });
  assert.equal(invalid.statusText, "标题超长");
});

test("未知状态回落安全兜底，不抛错", () => {
  const meta = stateMeta("some_unknown_state");
  assert.equal(meta.badgeClass, "badge-invalid");
  assert.ok(meta.statusText.length > 0);
});

// ---------- 纯函数：存储失败冻结文案 ----------

test("四种 reason 使用 INTERFACES §2.5 逐字冻结文案", () => {
  assert.equal(storageFailureText(StorageFailureReason.QUOTA), "本地备份失败：存储空间不足");
  assert.equal(storageFailureText(StorageFailureReason.UNAVAILABLE), "本地备份失败：浏览器禁止本地存储");
  assert.equal(storageFailureText(StorageFailureReason.CORRUPT), "本地备份已损坏，已忽略");
  assert.equal(storageFailureText(StorageFailureReason.SERIALIZE), "本地备份失败：内容无法序列化");
});

test("未知 reason 回落通用兜底，不透出原始异常 message", () => {
  const text = storageFailureText("unknown_reason");
  assert.ok(text.includes("本地备份失败"));
  assert.ok(!text.includes("The operation is insecure"));
});

// ---------- 纯函数：错误分类提示 ----------

test("401 / 400 / 413 分别映射到对应中文提示", () => {
  assert.deepEqual(errorNotice({ code: "UNAUTHORIZED", status: 401 }), {
    kind: "auth",
    text: "登录已失效，请重新登录",
  });
  assert.deepEqual(errorNotice({ code: "BAD_REQUEST", status: 400 }), {
    kind: "invalid",
    text: "标题或正文不符合要求，请检查后再提交",
  });
  assert.deepEqual(errorNotice({ code: "PAYLOAD_TOO_LARGE", status: 413 }), {
    kind: "invalid",
    text: "正文超出大小限制，请精简后再提交",
  });
});

test("429 按传入 Retry-After 展示秒数；缺失时不带秒数", () => {
  const withDelay = errorNotice({ code: "RATE_LIMITED", status: 429, retryAfter: "30" });
  assert.equal(withDelay.text, "请求过于频繁，请 30 秒后重试");

  const noDelay = errorNotice({ code: "RATE_LIMITED", status: 429, retryAfter: null });
  assert.equal(noDelay.text, "请求过于频繁，请稍后重试");

  const badDelay = errorNotice({ code: "RATE_LIMITED", status: 429, retryAfter: "abc" });
  assert.equal(badDelay.text, "请求过于频繁，请稍后重试");
});

test("5xx / 超时 / 网络异常归入结果未知重试提示，未知错误有兜底", () => {
  assert.equal(errorNotice({ code: "INTERNAL_ERROR", status: 500 }).kind, "retry");
  assert.equal(errorNotice({ code: "SERVICE_UNAVAILABLE", status: 503 }).kind, "retry");
  assert.equal(errorNotice({ status: 0 }).kind, "retry");
  assert.equal(errorNotice({ code: "TIMEOUT" }).kind, "retry");
  assert.equal(errorNotice({}).kind, "unknown");
});

test("错误提示不拼接原始 error.message", () => {
  const notice = errorNotice({
    code: "BAD_REQUEST",
    status: 400,
    message: "The operation is insecure.",
  });
  assert.ok(!notice.text.includes("The operation is insecure"));
});

// ---------- 控制器：状态徽标渲染 ----------

test("renderSyncState 写徽标类/文案与状态栏，文本经 textContent 写入", () => {
  const { elements } = buildDom();
  const ui = createUiFeedback(elements);

  ui.renderSyncState(SyncState.CONFLICT, {});
  assert.ok(elements.syncBadge.className.includes("badge-conflict"));
  assert.equal(elements.syncBadge.textContent, "✕ 版本冲突");
  assert.equal(elements.statusText.textContent, "云端存在不同版本，请选择处理方式");

  // 含 HTML 的状态文本不得被当作标签解析
  ui.renderSyncState(SyncState.INVALID, { error: '<img src=x onerror="alert(1)">标题' });
  assert.equal(elements.statusText.querySelector("img"), null);
  assert.ok(elements.statusText.textContent.includes("onerror"));
  ui.destroy();
});

// ---------- 控制器：存储失败条 ----------

test("showStorageFailure 展示冻结文案与下载入口，保留内存内容不清空", () => {
  const { elements } = buildDom();
  let downloaded = null;
  const ui = createUiFeedback(elements, {
    onDownloadDraft: (snapshot) => {
      downloaded = snapshot;
    },
  });

  ui.showStorageFailure(StorageFailureReason.QUOTA, { title: "草稿", content: "# 正文" });
  assert.equal(elements.storageMessage.textContent, "本地备份失败：存储空间不足");
  assert.ok(!elements.storageBanner.classList.contains("hidden"), "失败条应可见");

  elements.storageDownloadBtn.click();
  assert.deepEqual(downloaded, { title: "草稿", content: "# 正文" });

  ui.hideStorageFailure();
  assert.ok(elements.storageBanner.classList.contains("hidden"));
  ui.destroy();
});

test("存储失败条不读取或改写编辑器内容，快照仅由上层传入", () => {
  const { elements } = buildDom();
  const ui = createUiFeedback(elements);
  ui.showStorageFailure(StorageFailureReason.CORRUPT);
  assert.equal(ui.getDownloadSnapshot(), null);
  ui.destroy();
});

// ---------- 控制器：冲突弹窗 ----------

test("showConflict 只读展示云端版本与本地基准，云端内容经 textContent 写入", () => {
  const { elements } = buildDom();
  const ui = createUiFeedback(elements);

  ui.showConflict({
    serverVersion: 7,
    localVersion: 3,
    cloudContent: '<img src=x onerror="alert(1)">云端正文',
  });

  assert.equal(elements.serverVersionText.textContent, "v7");
  assert.equal(elements.localVersionText.textContent, "v3");
  assert.equal(elements.cloudVersionText.querySelector("img"), null);
  assert.ok(elements.cloudVersionText.textContent.includes("onerror"));
  assert.ok(!elements.conflictModal.classList.contains("hidden"));
  ui.destroy();
});

test("四个选项分别上抛对应 choice，并带回冲突上下文；自身不发请求、不改版本", () => {
  const { elements } = buildDom();
  const choices = [];
  const ui = createUiFeedback(elements, {
    onConflictChoice: (choice, meta) => choices.push({ choice, meta }),
  });

  ui.showConflict({ serverVersion: 7, localVersion: 3, cloudContent: "云端", localContent: "本地" });

  elements.btnViewCloud.click();
  elements.btnAdoptCloud.click();
  elements.btnSaveCopy.click();
  elements.btnManualMerge.click();

  assert.deepEqual(choices.map((c) => c.choice), [
    ConflictChoice.VIEW_CLOUD,
    ConflictChoice.ADOPT_CLOUD,
    ConflictChoice.SAVE_COPY,
    ConflictChoice.MANUAL_MERGE,
  ]);
  for (const { meta } of choices) {
    assert.equal(meta.serverVersion, 7);
    assert.equal(meta.localVersion, 3);
    assert.equal(meta.cloudContent, "云端");
    assert.equal(meta.localContent, "本地");
    // 控制器不得自行推进版本号
    assert.equal(meta.expectedVersion, undefined);
  }
  ui.destroy();
});

test("取消保持当前内容：关闭弹窗并上抛 cancel，不触发覆盖/重载/清草稿", () => {
  const { elements } = buildDom();
  const choices = [];
  const ui = createUiFeedback(elements, {
    onConflictChoice: (choice) => choices.push(choice),
  });

  ui.showConflict({ serverVersion: 7, localVersion: 3 });
  elements.btnConflictCancel.click();

  assert.deepEqual(choices, [ConflictChoice.CANCEL]);
  assert.ok(elements.conflictModal.classList.contains("hidden"));
  ui.destroy();
});

test("destroy 后按钮点击不再上抛选择", () => {
  const { elements } = buildDom();
  let count = 0;
  const ui = createUiFeedback(elements, {
    onConflictChoice: () => {
      count += 1;
    },
  });
  ui.destroy();

  elements.btnAdoptCloud.click();
  elements.btnSaveCopy.click();
  assert.equal(count, 0);
});

test("缺少部分 DOM 元素时控制器不抛空引用错误", () => {
  const partial = { syncBadge: null, statusText: null };
  const ui = createUiFeedback(partial, {});
  assert.doesNotThrow(() => ui.renderSyncState(SyncState.SYNCED));
  assert.doesNotThrow(() => ui.showConflict({ serverVersion: 1 }));
  assert.doesNotThrow(() => ui.showStorageFailure(StorageFailureReason.QUOTA));
  ui.destroy();
});
