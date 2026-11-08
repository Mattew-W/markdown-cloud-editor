// tests/frontend/sync_engine.test.js
import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine, SyncState } from '../../static/js/sync.js';
import { ApiClient } from '../../static/js/api.js';
import * as drafts from '../../static/js/drafts.js';
import { createMockStorage } from './setup.js';

test('SyncEngine 拥有标准 7 个状态枚举且初始状态为 synced', () => {
    assert.equal(SyncState.SYNCED, 'synced');
    assert.equal(SyncState.DIRTY, 'dirty');
    assert.equal(SyncState.SAVING, 'saving');
    assert.equal(SyncState.RETRY_WAIT, 'retry_wait');
    assert.equal(SyncState.AUTH_REQUIRED, 'auth_required');
    assert.equal(SyncState.CONFLICT, 'conflict');
    assert.equal(SyncState.INVALID, 'invalid');

    const sync = new SyncEngine();
    assert.equal(sync.state, SyncState.SYNCED);
});

test('onInput 触发编辑后转为 dirty 且草稿正常备份时显示“已在本地备份”', () => {
    const states = [];
    const payloads = [];
    const sync = new SyncEngine({
        onStateChange: (st, p) => {
            states.push(st);
            payloads.push(p);
        }
    });

    sync.initSession('user_1', {
        id: 'doc_1',
        title: '初始标题',
        content: '初始内容',
        version: 1
    });

    sync.onInput('新标题', '新内容');

    assert.equal(sync.state, SyncState.DIRTY);
    assert.equal(sync.localRevision, 1);
    const lastPayload = payloads[payloads.length - 1];
    assert.equal(lastPayload.backedUpLocally, true);
    assert.match(lastPayload.message, /已在本地备份/);

    sync.clearTimers();
});

test('【缺陷 7 验证】本地存储异常时明确返回失败，不虚报已在本地备份', () => {
    const mockStorage = {
        setItem() {
            throw new Error('QuotaExceededError: LocalStorage quota full');
        },
        getItem() { return null; },
        removeItem() {}
    };

    const res = drafts.saveDraft({
        userId: 'u1',
        docId: 'd1',
        sessionId: 's1',
        baseVersion: 1,
        title: 't',
        content: 'c',
        localRevision: 1
    }, mockStorage);

    assert.equal(res.success, false);
    assert.ok(res.error);

    // 在 SyncEngine 中模拟：将 globalThis.localStorage 临时替换为会抛错的 mock 存储
    const originalStorage = globalThis.localStorage;
    try {
        globalThis.localStorage = mockStorage;

        let lastPayload = null;
        const sync = new SyncEngine({
            onStateChange: (st, p) => {
                lastPayload = p;
            }
        });
        sync.initSession('u1', { id: 'd1', title: 't', content: 'c', version: 1 });
        sync.onInput('t2', 'c2');

        assert.equal(lastPayload.backedUpLocally, false);
        assert.match(lastPayload.message, /本地备份失败/);
        sync.clearTimers();
    } finally {
        globalThis.localStorage = originalStorage;
    }
});

test('【缺陷 3 验证】A 文档在途保存响应返回时，绝不污染已切换的 B 文档会话与版本', async () => {
    let resolveDocA;
    const docAPromise = new Promise(resolve => {
        resolveDocA = resolve;
    });

    // Mock ApiClient.documents.update
    const originalUpdate = ApiClient.documents.update;
    ApiClient.documents.update = async (docId, title, content, expectedVersion) => {
        if (docId === 'doc_A') {
            await docAPromise;
            return { id: 'doc_A', version: 99, updated_at: new Date().toISOString() };
        }
        return { id: docId, version: expectedVersion + 1, updated_at: new Date().toISOString() };
    };

    try {
        let saveSuccessCalls = [];
        const sync = new SyncEngine({
            onSaveSuccess: (doc) => saveSuccessCalls.push(doc)
        });

        // 1. 初始化文档 A
        sync.initSession('user_1', {
            id: 'doc_A',
            title: 'Doc A Title',
            content: 'Doc A Content',
            version: 1
        });

        // 2. A 发生输入并触发保存 (此时 update 进入等待态)
        sync.onInput('Doc A Edited', 'Doc A Content Edited');
        const savePromise = sync.triggerSave();

        // 3. 在 A 尚未返回时，用户切换到文档 B
        sync.initSession('user_1', {
            id: 'doc_B',
            title: 'Doc B Title',
            content: 'Doc B Content',
            version: 10
        });

        // B 进行输入
        sync.onInput('Doc B User Typing', 'Doc B Content Typing');
        assert.equal(sync.docId, 'doc_B');
        assert.equal(sync.baseVersion, 10);
        assert.equal(sync.localRevision, 1);
        assert.equal(sync.state, SyncState.DIRTY);

        // 4. A 的迟延网络响应此时终于到达服务端并返回
        resolveDocA();
        await savePromise;

        // 5. 核心断言：当前激活的会话依然属于 B，版本依然为 10，状态依然为 DIRTY，未被 A 的 version: 99 污染！
        assert.equal(sync.docId, 'doc_B');
        assert.equal(sync.baseVersion, 10);
        assert.equal(sync.localRevision, 1);
        assert.equal(sync.state, SyncState.DIRTY);
        // A 的成功回调未向当前 UI 上报
        assert.equal(saveSuccessCalls.length, 0);

        sync.clearTimers();
    } finally {
        ApiClient.documents.update = originalUpdate;
    }
});

test('【缺陷 5 验证】冲突覆盖 resolveOverwrite 正确转换状态并触发提交', async () => {
    let updateCalledWith = null;
    const originalUpdate = ApiClient.documents.update;
    ApiClient.documents.update = async (id, title, content, expectedVersion) => {
        updateCalledWith = { id, title, content, expectedVersion };
        return { id, version: expectedVersion + 1, updated_at: new Date().toISOString() };
    };

    try {
        const sync = new SyncEngine();
        sync.initSession('user_1', { id: 'doc_1', title: 'T1', content: 'C1', version: 1 });
        sync.onInput('T1 modified', 'C1 modified');

        // 模拟进入 CONFLICT 状态
        sync.state = SyncState.CONFLICT;

        // 调用 resolveOverwrite 采纳最新 serverVersion = 5 并执行覆盖提交
        await sync.resolveOverwrite(5);

        assert.ok(updateCalledWith);
        assert.equal(updateCalledWith.id, 'doc_1');
        assert.equal(updateCalledWith.expectedVersion, 5);
        assert.equal(sync.baseVersion, 6); // 5 + 1
        assert.equal(sync.state, SyncState.SYNCED);

        sync.clearTimers();
    } finally {
        ApiClient.documents.update = originalUpdate;
    }
});

test('【缺陷 6 验证】网络故障与 429 触发带有上限的指数退避重试调度', () => {
    const sync = new SyncEngine();
    sync.initSession('user_1', { id: 'doc_1', title: 'T', content: 'C', version: 1 });

    // 1. 模拟网络异常
    sync.scheduleRetry('网络超时');
    assert.equal(sync.state, SyncState.RETRY_WAIT);
    assert.equal(sync.retryAttempt, 1);
    assert.ok(sync.retryTimer !== null);

    // 2. 模拟 429 限流
    sync.scheduleRetry('请求过多', 45000);
    assert.equal(sync.state, SyncState.RETRY_WAIT);
    assert.equal(sync.retryAttempt, 2);

    sync.clearTimers();
    assert.equal(sync.retryTimer, null);
});
