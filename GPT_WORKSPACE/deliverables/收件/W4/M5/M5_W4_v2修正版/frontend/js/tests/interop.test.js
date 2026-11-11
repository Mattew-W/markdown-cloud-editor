// frontend/js/tests/interop.test.js
/**
 * 跨模块交互与兼容性回归测试
 *
 * 验证：
 * 1. editor.setValue 与 editor.setValues 双向兼容性
 * 2. drafts.listDrafts 双签名兼容性 (对象传参 vs 位置传参)
 * 3. drafts.discardDraft 双签名兼容性 (key+expected vs 单对象)
 * 4. drafts.clearSessionDrafts 双签名与 force 强制清理标志
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditor } from '../editor.js';
import * as drafts from '../drafts.js';

function createMockStorage() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    key(i) {
      return Array.from(map.keys())[i] ?? null;
    },
    get length() {
      return map.size;
    },
  };
}

test('editor 实例同时支持 setValue 和 setValues', () => {
  const titleInput = { value: '', addEventListener() {}, removeEventListener() {} };
  const contentInput = { value: '', addEventListener() {}, removeEventListener() {} };
  const preview = { innerHTML: '', textContent: '' };

  const editor = createEditor({
    titleInput,
    contentInput,
    previewElement: preview,
    parseMarkdown: (text) => `<p>${text}</p>`,
    sanitizeHtml: (html) => html,
  });

  // 测试 setValue
  editor.setValue({ title: '测试1', content: '内容1' });
  assert.equal(titleInput.value, '测试1');
  assert.equal(contentInput.value, '内容1');
  assert.equal(preview.innerHTML, '<p>内容1</p>');

  // 测试 setValues (别名)
  editor.setValues({ title: '测试2', content: '内容2' });
  assert.equal(titleInput.value, '测试2');
  assert.equal(contentInput.value, '内容2');
  assert.equal(preview.innerHTML, '<p>内容2</p>');

  editor.destroy();
});

test('drafts.listDrafts 支持对象传参和位置传参', () => {
  const store = createMockStorage();
  const userId = 'user_001';
  const docId = 'doc_001';
  const sessionId = 'session_001';

  drafts.saveDraft({
    userId,
    docId,
    sessionId,
    baseVersion: 1,
    title: '草稿标题',
    content: '草稿内容',
    localRevision: 1,
  }, store);

  // 1. 标准对象传参
  const list1 = drafts.listDrafts({ userId, docId }, store);
  assert.equal(list1.length, 1);
  assert.equal(list1[0].title, '草稿标题');

  // 2. 位置传参
  const list2 = drafts.listDrafts(userId, docId, store);
  assert.equal(list2.length, 1);
  assert.equal(list2[0].title, '草稿标题');
});

test('drafts.discardDraft 支持双参数和单对象传参', () => {
  const store = createMockStorage();
  const userId = 'user_002';
  const docId = 'doc_002';
  const sessionId = 'session_002';

  drafts.saveDraft({
    userId,
    docId,
    sessionId,
    baseVersion: 1,
    title: '草稿标题',
    content: '草稿内容',
    localRevision: 2,
  }, store);

  // 单对象传参丢弃
  const deleted = drafts.discardDraft({
    userId,
    docId,
    sessionId,
    expectedRevision: 2,
    expectedContent: '草稿内容',
  }, undefined, store);

  assert.equal(deleted, true);
  const remaining = drafts.listDrafts({ userId, docId }, store);
  assert.equal(remaining.length, 0);
});

test('drafts.clearSessionDrafts force 模式可清除包括当前会话在内的所有草稿', () => {
  const store = createMockStorage();
  const userId = 'user_003';
  const docId = 'doc_003';
  const session1 = 'session_003_a';
  const session2 = 'session_003_b';

  drafts.saveDraft({
    userId,
    docId,
    sessionId: session1,
    baseVersion: 1,
    title: '草稿1',
    content: '内容1',
    localRevision: 1,
  }, store);

  drafts.saveDraft({
    userId,
    docId,
    sessionId: session2,
    baseVersion: 1,
    title: '草稿2',
    content: '内容2',
    localRevision: 1,
  }, store);

  // force=true 强制清空此文档的所有草稿
  const res = drafts.clearSessionDrafts({
    userId,
    docId,
    sessionId: session1,
  }, { force: true }, store);

  assert.equal(res.removed.length, 2);
  const remaining = drafts.listDrafts({ userId, docId }, store);
  assert.equal(remaining.length, 0);
});
