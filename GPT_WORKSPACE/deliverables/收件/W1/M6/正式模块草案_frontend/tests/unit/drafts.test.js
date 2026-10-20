/**
 * drafts.test.js —— 本地草稿层单元测试
 *
 * 位置：frontend/tests/unit/drafts.test.js
 * 运行：node --test frontend/tests/unit/
 * 依赖：仅 Node 内置 test runner，无第三方包（规范 §02 前端验证要求）
 *
 * 覆盖契约 C1–C6 与规范 §08「本地草稿」的关键要求：
 *   1. 键生成与解析，含分隔符转义
 *   2. user_id / doc_id 隔离，不同账号互相不可见
 *   3. 多编辑会话草稿并存
 *   4. 250ms 合并写入（用可控时钟，不依赖真实等待）
 *   5. 清理前三重核对（会话 + 修订号 + 内容）拒绝误删
 *   6. quota / unavailable / corrupt 三类存储错误
 *   7. 恢复三分支判定
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DRAFT_KEY_PREFIX,
  DraftStorageError,
  buildDraftKey,
  clearSessionDrafts,
  classifyRestore,
  createDraftWriter,
  createEditSessionId,
  discardDraft,
  isDraftKey,
  isValidDraftRecord,
  listDrafts,
  parseDraftKey,
  readDraft,
  saveDraft,
  byteLength,
} from "../../js/drafts.js";

// ── 测试替身 ────────────────────────────────────────────────

/** 可控 localStorage 替身，可注入异常。 */
function createFakeStorage({ failOn = null, quotaAfter = Infinity } = {}) {
  const map = new Map();
  let writeCount = 0;

  const storage = {
    get length() {
      return map.size;
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    getItem(k) {
      if (failOn === "getItem") {
        const e = new Error("denied");
        e.name = "SecurityError";
        throw e;
      }
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (failOn === "setItem") {
        const e = new Error("quota");
        e.name = "QuotaExceededError";
        throw e;
      }
      writeCount += 1;
      if (writeCount > quotaAfter) {
        const e = new Error("quota");
        e.name = "QuotaExceededError";
        throw e;
      }
      map.set(k, String(v));
    },
    removeItem(k) {
      if (failOn === "removeItem") {
        const e = new Error("denied");
        e.name = "SecurityError";
        throw e;
      }
      map.delete(k);
    },
    clear() {
      map.clear();
    },
  };

  return { storage, map };
}

/** 构造一条合法草稿记录。 */
function makeDraft(overrides = {}) {
  return {
    user_id: "user-a",
    doc_id: "doc-1",
    edit_session_id: "sess-1",
    base_version: 3,
    title: "课程笔记",
    content: "# 正文",
    local_revision: 7,
    recorded_at: "2026-10-20T06:00:00.000Z",
    ...overrides,
  };
}

// ── 1. 键生成与解析 ─────────────────────────────────────────

describe("草稿键", () => {
  test("三元组键格式正确", () => {
    const key = buildDraftKey({ userId: "u1", docId: "d1", sessionId: "s1" });
    assert.equal(key, `${DRAFT_KEY_PREFIX}:u1:d1:s1`);
  });

  test("键可往返解析", () => {
    const parts = { userId: "u1", docId: "d1", sessionId: "s1" };
    assert.deepEqual(parseDraftKey(buildDraftKey(parts)), parts);
  });

  test("分段含冒号时转义且可往返", () => {
    const parts = { userId: "a:b", docId: "c:d", sessionId: "e:f" };
    const key = buildDraftKey(parts);
    assert.deepEqual(parseDraftKey(key), parts);
  });

  test("非草稿键返回 null", () => {
    assert.equal(parseDraftKey("other:key"), null);
    assert.equal(parseDraftKey("markdown-editor:draft:only:two"), null);
    assert.equal(isDraftKey("markdown-editor:draft:u:d:s"), true);
    assert.equal(isDraftKey("nope"), false);
  });

  test("缺少任一段即抛 invalid", () => {
    assert.throws(
      () => buildDraftKey({ userId: "", docId: "d", sessionId: "s" }),
      (e) => e instanceof DraftStorageError && e.reason === "invalid"
    );
  });
});

// ── 2. 会话 ID ──────────────────────────────────────────────

describe("编辑会话 ID", () => {
  test("每次生成都不同且非空", () => {
    const ids = new Set();
    for (let i = 0; i < 50; i += 1) ids.add(createEditSessionId());
    assert.equal(ids.size, 50);
  });
});

// ── 3. 记录校验 ──────────────────────────────────────────────

describe("草稿记录校验", () => {
  test("完整记录通过", () => {
    assert.equal(isValidDraftRecord(makeDraft()), true);
  });

  test("缺字段或类型错误不通过", () => {
    const bad = [
      null,
      "string",
      [],
      makeDraft({ user_id: "" }),
      makeDraft({ base_version: 0 }),
      makeDraft({ base_version: 1.5 }),
      makeDraft({ content: 123 }),
      makeDraft({ title: null }),
      makeDraft({ local_revision: -1 }),
      makeDraft({ recorded_at: "not-a-date" }),
    ];
    for (const r of bad) {
      assert.equal(isValidDraftRecord(r), false, `应判为无效: ${JSON.stringify(r)}`);
    }
  });
});

// ── 4. 存取 ─────────────────────────────────────────────────

describe("草稿读写", () => {
  test("保存后可读回且 recorded_at 由模块盖戳", () => {
    const { storage } = createFakeStorage();
    const record = makeDraft();
    delete record.recorded_at;

    const saved = saveDraft(record, { storage, now: () => new Date("2026-10-20T08:00:00Z") });
    assert.equal(saved.recorded_at, "2026-10-20T08:00:00.000Z");

    const key = buildDraftKey({ userId: "user-a", docId: "doc-1", sessionId: "sess-1" });
    const read = readDraft(key, { storage });
    assert.equal(read.status, "ok");
    assert.equal(read.record.content, "# 正文");
    assert.equal(read.record.local_revision, 7);
  });

  test("不存在的键返回 missing", () => {
    const { storage } = createFakeStorage();
    assert.equal(readDraft(buildDraftKey({ userId: "u", docId: "d", sessionId: "s" }), { storage }).status, "missing");
  });

  test("损坏的 JSON 返回 corrupt", () => {
    const { storage, map } = createFakeStorage();
    const key = buildDraftKey({ userId: "u", docId: "d", sessionId: "s" });
    map.set(key, "{{{");
    assert.equal(readDraft(key, { storage }).status, "corrupt");
  });

  test("合法 JSON 但结构不符返回 corrupt", () => {
    const { storage, map } = createFakeStorage();
    const key = buildDraftKey({ userId: "u", docId: "d", sessionId: "s" });
    for (const bad of ["null", "123", '{"content":"x"}', '{"user_id":"u"}', "[]"]) {
      map.set(key, bad);
      const r = readDraft(key, { storage });
      assert.equal(r.status, "corrupt", `应判为损坏: ${bad}`);
      assert.equal(r.error.reason, "corrupt");
    }
  });

  test("超出正文上限即抛 invalid", () => {
    const { storage } = createFakeStorage();
    const big = "x".repeat(262145);
    assert.throws(
      () => saveDraft(makeDraft({ content: big }), { storage }),
      (e) => e instanceof DraftStorageError && e.reason === "invalid"
    );
  });

  test("正文字节数按 UTF-8 计算，中文占三字节", () => {
    assert.equal(byteLength("abc"), 3);
    assert.equal(byteLength("中"), 3);
    assert.equal(byteLength("🚀"), 4);
  });
});

// ── 5. 隔离与枚举 ────────────────────────────────────────────

describe("草稿隔离与枚举", () => {
  test("不同账号的草稿互相不可见", () => {
    const { storage } = createFakeStorage();
    saveDraft(makeDraft({ user_id: "user-a", doc_id: "doc-1" }), { storage });
    saveDraft(makeDraft({ user_id: "user-b", doc_id: "doc-1", edit_session_id: "sess-2" }), { storage });

    const a = listDrafts({ userId: "user-a" }, { storage });
    const b = listDrafts({ userId: "user-b" }, { storage });

    assert.equal(a.records.length, 1);
    assert.equal(b.records.length, 1);
    assert.equal(a.records[0].user_id, "user-a");
    assert.equal(b.records[0].user_id, "user-b");
  });

  test("不同文档的草稿互相不可见", () => {
    const { storage } = createFakeStorage();
    saveDraft(makeDraft({ doc_id: "doc-1" }), { storage });
    saveDraft(makeDraft({ doc_id: "doc-2", edit_session_id: "sess-2" }), { storage });

    assert.equal(listDrafts({ userId: "user-a", docId: "doc-1" }, { storage }).records.length, 1);
    assert.equal(listDrafts({ userId: "user-a", docId: "doc-2" }, { storage }).records.length, 1);
    assert.equal(listDrafts({ userId: "user-a" }, { storage }).records.length, 2);
  });

  test("多编辑会话草稿并存并可枚举", () => {
    const { storage } = createFakeStorage();
    saveDraft(makeDraft({ edit_session_id: "sess-1", local_revision: 1 }), { storage });
    saveDraft(makeDraft({ edit_session_id: "sess-2", local_revision: 2 }), { storage });
    saveDraft(makeDraft({ edit_session_id: "sess-3", local_revision: 3 }), { storage });

    const { records } = listDrafts({ userId: "user-a", docId: "doc-1" }, { storage });
    assert.equal(records.length, 3);
    assert.deepEqual(
      records.map((r) => r.edit_session_id).sort(),
      ["sess-1", "sess-2", "sess-3"]
    );
  });

  test("枚举结果按记录时间倒序", () => {
    const { storage } = createFakeStorage();
    saveDraft(makeDraft({ edit_session_id: "old", recorded_at: "2026-10-01T00:00:00.000Z" }), { storage });
    saveDraft(makeDraft({ edit_session_id: "new", recorded_at: "2026-10-20T00:00:00.000Z" }), { storage });

    const { records } = listDrafts({ userId: "user-a" }, { storage });
    assert.equal(records[0].edit_session_id, "new");
  });

  test("损坏的草稿被计入 corrupt 而不抛出", () => {
    const { storage, map } = createFakeStorage();
    const key = buildDraftKey({ userId: "user-a", docId: "doc-1", sessionId: "bad" });
    map.set(key, "{{{");
    saveDraft(makeDraft({ edit_session_id: "good" }), { storage });

    const { records, corrupt } = listDrafts({ userId: "user-a" }, { storage });
    assert.equal(records.length, 1);
    assert.equal(corrupt, 1);
  });

  test("非草稿键不参与枚举", () => {
    const { storage, map } = createFakeStorage();
    map.set("some-other-key", "value");
    saveDraft(makeDraft(), { storage });
    assert.equal(listDrafts({ userId: "user-a" }, { storage }).records.length, 1);
  });
});

// ── 6. 清理的三重核对 ────────────────────────────────────────

describe("草稿清理", () => {
  test("会话不匹配时拒绝删除", () => {
    const { storage } = createFakeStorage();
    const key = buildDraftKey({ userId: "user-a", docId: "doc-1", sessionId: "sess-1" });
    saveDraft(makeDraft(), { storage });

    const r = discardDraft(key, { sessionId: "sess-other" }, { storage });
    assert.equal(r.status, "mismatch");
    assert.equal(r.reason, "session");
    assert.equal(readDraft(key, { storage }).status, "ok");
  });

  test("修订号不匹配时拒绝删除", () => {
    const { storage } = createFakeStorage();
    const key = buildDraftKey({ userId: "user-a", docId: "doc-1", sessionId: "sess-1" });
    saveDraft(makeDraft({ local_revision: 7 }), { storage });

    const r = discardDraft(key, { sessionId: "sess-1", localRevision: 8 }, { storage });
    assert.equal(r.status, "mismatch");
    assert.equal(r.reason, "revision");
    assert.equal(readDraft(key, { storage }).status, "ok");
  });

  test("内容不匹配时拒绝删除", () => {
    const { storage } = createFakeStorage();
    const key = buildDraftKey({ userId: "user-a", docId: "doc-1", sessionId: "sess-1" });
    saveDraft(makeDraft({ content: "原内容" }), { storage });

    const r = discardDraft(key, { content: "新内容" }, { storage });
    assert.equal(r.status, "mismatch");
    assert.equal(r.reason, "content");
    assert.equal(readDraft(key, { storage }).status, "ok");
  });

  test("三项全部匹配才删除", () => {
    const { storage } = createFakeStorage();
    const key = buildDraftKey({ userId: "user-a", docId: "doc-1", sessionId: "sess-1" });
    saveDraft(makeDraft({ content: "原内容", local_revision: 7 }), { storage });

    const r = discardDraft(key, { sessionId: "sess-1", localRevision: 7, content: "原内容" }, { storage });
    assert.equal(r.status, "discarded");
    assert.equal(readDraft(key, { storage }).status, "missing");
  });

  test("按会话清理不影响其他会话", () => {
    const { storage } = createFakeStorage();
    saveDraft(makeDraft({ edit_session_id: "sess-1" }), { storage });
    saveDraft(makeDraft({ edit_session_id: "sess-2" }), { storage });
    saveDraft(makeDraft({ edit_session_id: "sess-2", doc_id: "doc-2" }), { storage });

    const cleared = clearSessionDrafts("sess-1", { userId: "user-a" }, { storage });
    assert.equal(cleared, 1);
    assert.equal(listDrafts({ userId: "user-a" }, { storage }).records.length, 2);
  });

  test("按会话清理不跨账号", () => {
    const { storage } = createFakeStorage();
    saveDraft(makeDraft({ user_id: "user-a", edit_session_id: "sess-1" }), { storage });
    saveDraft(makeDraft({ user_id: "user-b", edit_session_id: "sess-1" }), { storage });

    clearSessionDrafts("sess-1", { userId: "user-a" }, { storage });
    assert.equal(listDrafts({ userId: "user-b" }, { storage }).records.length, 1);
  });
});

// ── 7. 三类存储错误 ─────────────────────────────────────────

describe("存储错误分类", () => {
  test("配额耗尽 → reason='quota'", () => {
    const { storage } = createFakeStorage({ failOn: "setItem" });
    assert.throws(
      () => saveDraft(makeDraft(), { storage }),
      (e) => e instanceof DraftStorageError && e.reason === "quota" && !/denied|quota/.test(e.userMessage)
    );
  });

  test("存储不可用 → reason='unavailable'", () => {
    const { storage } = createFakeStorage({ failOn: "getItem" });
    const r = readDraft(buildDraftKey({ userId: "u", docId: "d", sessionId: "s" }), { storage });
    assert.equal(r.status, "corrupt");
    assert.equal(r.error.reason, "unavailable");
  });

  test("存储不可用时写入也归为 unavailable", () => {
    const { storage } = createFakeStorage({ failOn: "setItem" });
    storage.setItem = () => {
      const e = new Error("denied");
      e.name = "SecurityError";
      throw e;
    };
    assert.throws(
      () => saveDraft(makeDraft(), { storage }),
      (e) => e.reason === "unavailable"
    );
  });

  test("错误不携带原始英文给用户", () => {
    const { storage } = createFakeStorage({ failOn: "setItem" });
    try {
      saveDraft(makeDraft(), { storage });
      assert.fail("应当抛出");
    } catch (e) {
      assert.ok(!e.userMessage.includes("Quota"));
      assert.ok(!e.userMessage.includes("denied"));
      assert.ok(e.userMessage.startsWith("本地备份失败"));
    }
  });
});

// ── 8. 合并写入 ─────────────────────────────────────────────

describe("合并写入调度", () => {
  /** 可控时钟：手动推进，测试不依赖真实等待。 */
  function createFakeClock() {
    let now = 0;
    const timers = new Map();
    let nextId = 1;

    return {
      setTimeout: (fn, delay) => {
        const id = nextId++;
        timers.set(id, { fn, at: now + delay });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
      advance(ms) {
        now += ms;
        for (const [id, t] of [...timers]) {
          if (t.at <= now) {
            timers.delete(id);
            t.fn();
          }
        }
      },
    };
  }

  test("连续三次 schedule 只落盘一次", () => {
    const { storage, map } = createFakeStorage();
    const clock = createFakeClock();
    const writer = createDraftWriter({ storage, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    writer.schedule(makeDraft({ content: "v1" }));
    writer.schedule(makeDraft({ content: "v2" }));
    writer.schedule(makeDraft({ content: "v3" }));

    assert.equal(map.size, 0, "计时器未到不应落盘");

    clock.advance(250);

    assert.equal(map.size, 1, "计时器到点应只落盘一条");
    const stored = JSON.parse([...map.values()][0]);
    assert.equal(stored.content, "v3", "应保留最新内容");
  });

  test("未满 250ms 不落盘，超过则落盘", () => {
    const { storage, map } = createFakeStorage();
    const clock = createFakeClock();
    const writer = createDraftWriter({ storage, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    writer.schedule(makeDraft());
    clock.advance(249);
    assert.equal(map.size, 0);

    clock.advance(1);
    assert.equal(map.size, 1);
  });

  test("flush 立即落盘待写内容", () => {
    const { storage, map } = createFakeStorage();
    const clock = createFakeClock();
    const writer = createDraftWriter({ storage, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    writer.schedule(makeDraft({ content: "待落盘" }));
    assert.equal(map.size, 0);

    const key = writer.pending()[0];
    assert.equal(writer.flush(key), true);
    assert.equal(map.size, 1);
  });

  test("flushAll 落盘全部待写内容", () => {
    const { storage, map } = createFakeStorage();
    const clock = createFakeClock();
    const writer = createDraftWriter({ storage, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    writer.schedule(makeDraft({ edit_session_id: "s1" }));
    writer.schedule(makeDraft({ edit_session_id: "s2" }));
    assert.equal(map.size, 0);

    writer.flushAll();
    assert.equal(map.size, 2);
  });

  test("cancel 丢弃待写内容且不落盘", () => {
    const { storage, map } = createFakeStorage();
    const clock = createFakeClock();
    const writer = createDraftWriter({ storage, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

    writer.schedule(makeDraft());
    const key = writer.pending()[0];
    assert.equal(writer.cancel(key), true);

    clock.advance(250);
    assert.equal(map.size, 0);
  });
});

// ── 9. 恢复三分支判定 ───────────────────────────────────────

describe("恢复判定", () => {
  test("内容与云端相同 → identical", () => {
    const draft = makeDraft({ content: "同内容", base_version: 3 });
    assert.equal(classifyRestore(draft, { version: 5, content: "同内容" }), "identical");
  });

  test("云端版本等于 base_version → confirm", () => {
    const draft = makeDraft({ content: "本地内容", base_version: 3 });
    assert.equal(classifyRestore(draft, { version: 3, content: "云端内容" }), "confirm");
  });

  test("云端版本不同且内容不同 → conflict", () => {
    const draft = makeDraft({ content: "本地内容", base_version: 3 });
    assert.equal(classifyRestore(draft, { version: 9, content: "云端内容" }), "conflict");
  });

  test("云端不可用 → unavailable", () => {
    const draft = makeDraft();
    assert.equal(classifyRestore(draft, null), "unavailable");
    assert.equal(classifyRestore(draft, { version: 1 }), "unavailable");
  });

  test("无效草稿一律判为 conflict，不做自动提交", () => {
    assert.equal(classifyRestore({ content: "x" }, { version: 1, content: "x" }), "conflict");
    assert.equal(classifyRestore(null, { version: 1, content: "x" }), "conflict");
  });
});
