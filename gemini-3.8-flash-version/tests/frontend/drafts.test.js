// tests/frontend/drafts.test.js
import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as drafts from '../../static/js/drafts.js';
import { createMockStorage } from './setup.js';

test('草稿 Key 构造、解析与唯一隔离', () => {
    const key = drafts.buildDraftKey({
        userId: 'u_100',
        docId: 'd_200',
        sessionId: 's_300'
    });
    assert.equal(key, 'markdown-editor:draft:u_100:d_200:s_300');

    const parsed = drafts.parseDraftKey(key);
    assert.deepEqual(parsed, {
        userId: 'u_100',
        docId: 'd_200',
        sessionId: 's_300'
    });

    assert.equal(drafts.parseDraftKey('other:key:format'), null);
});

test('草稿三重核对删除保护 (会话、修订号、内容)', () => {
    const store = createMockStorage();
    const parts = {
        userId: 'u1',
        docId: 'd1',
        sessionId: 's1',
        baseVersion: 1,
        title: 'Title 1',
        content: 'Content 1',
        localRevision: 5
    };

    drafts.saveDraft(parts, store);
    const key = drafts.buildDraftKey(parts);

    // 会话不符 -> 拒绝删除
    const del1 = drafts.discardDraft(key, { sessionId: 's_wrong', localRevision: 5, content: 'Content 1' }, store);
    assert.equal(del1, false);

    // 修订号不符 -> 拒绝删除 (防抹掉新输入)
    const del2 = drafts.discardDraft(key, { sessionId: 's1', localRevision: 4, content: 'Content 1' }, store);
    assert.equal(del2, false);

    // 内容不符 -> 拒绝删除
    const del3 = drafts.discardDraft(key, { sessionId: 's1', localRevision: 5, content: 'Different content' }, store);
    assert.equal(del3, false);

    // 三重全匹配 -> 允许删除
    const delOk = drafts.discardDraft(key, { sessionId: 's1', localRevision: 5, content: 'Content 1' }, store);
    assert.equal(delOk, true);
    assert.equal(drafts.readDraft(key, store), null);
});

test('【缺陷 4 判定】classifyRestore 正确区分采纳云端、恢复确认与版本冲突', () => {
    const cloud = {
        version: 2,
        title: '云端标题',
        content: '云端正文'
    };

    // 1. 内容与标题完全相同 -> 采纳云端 (不需要弹出恢复提示)
    const d1 = { base_version: 2, title: '云端标题', content: '云端正文' };
    assert.equal(drafts.classifyRestore(d1, cloud), 'adopt_cloud');

    // 2. 版本一致但内容或标题被修改 -> confirm (需要用户确认恢复)
    const d2 = { base_version: 2, title: '本地新标题', content: '云端正文' };
    assert.equal(drafts.classifyRestore(d2, cloud), 'confirm');

    // 3. 草稿基于旧版本 (base_version = 1)，但云端已经是 v2 -> conflict (版本冲突)
    const d3 = { base_version: 1, title: '旧草稿标题', content: '旧草稿内容' };
    assert.equal(drafts.classifyRestore(d3, cloud), 'conflict');
});
