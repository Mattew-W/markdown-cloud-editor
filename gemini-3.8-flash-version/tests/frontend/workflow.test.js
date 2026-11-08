// tests/frontend/workflow.test.js
import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../../static/js/api.js';
import { SyncEngine, SyncState } from '../../static/js/sync.js';
import * as drafts from '../../static/js/drafts.js';

test('【端到端流程】认证、文档创建、编辑自动保存、读取与删除完整链路', async () => {
    // 1. Mock fetch 以模拟完整的后端 REST 交互
    const serverDb = new Map();
    let currentUserId = 'user_001';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        const path = url.replace('/api/v1', '');
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : {};

        // 认证：登录
        if (path === '/auth/login' && method === 'POST') {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    token: 'mock_jwt_token_123',
                    user: { id: currentUserId, username: body.username }
                })
            };
        }

        // 文档创建
        if (path === '/documents' && method === 'POST') {
            const docId = `doc_${serverDb.size + 1}`;
            const doc = {
                id: docId,
                title: body.title,
                content: body.content,
                version: 1,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            serverDb.set(docId, doc);
            return {
                ok: true,
                status: 201,
                json: async () => doc
            };
        }

        // 单篇文档读取
        if (path.startsWith('/documents/') && method === 'GET') {
            const docId = path.split('/')[2];
            const doc = serverDb.get(docId);
            if (!doc) {
                return {
                    ok: false,
                    status: 404,
                    json: async () => ({ error: { code: 'NOT_FOUND', message: 'Document not found' } })
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => doc
            };
        }

        // 文档更新 (CAS 乐观锁)
        if (path.startsWith('/documents/') && method === 'PUT') {
            const docId = path.split('/')[2];
            const doc = serverDb.get(docId);
            if (!doc) {
                return {
                    ok: false,
                    status: 404,
                    json: async () => ({ error: { code: 'NOT_FOUND', message: 'Document not found' } })
                };
            }
            if (body.expected_version !== doc.version) {
                return {
                    ok: false,
                    status: 409,
                    json: async () => ({
                        error: {
                            code: 'VERSION_CONFLICT',
                            message: 'Document was modified by another session',
                            details: { server_version: doc.version }
                        }
                    })
                };
            }
            doc.title = body.title;
            doc.content = body.content;
            doc.version += 1;
            doc.updated_at = new Date().toISOString();
            return {
                ok: true,
                status: 200,
                json: async () => doc
            };
        }

        // 文档删除
        if (path.startsWith('/documents/') && method === 'DELETE') {
            const docId = path.split('?')[0].split('/')[2];
            if (!serverDb.has(docId)) {
                return {
                    ok: false,
                    status: 404,
                    json: async () => ({ error: { code: 'NOT_FOUND', message: 'Document not found' } })
                };
            }
            serverDb.delete(docId);
            return {
                ok: true,
                status: 204,
                json: async () => ({})
            };
        }

        return {
            ok: false,
            status: 404,
            json: async () => ({ error: { message: 'Not Found' } })
        };
    };

    try {
        // Step 1: 登录并设置 Token
        const loginRes = await ApiClient.auth.login('alice', 'Password123');
        ApiClient.setToken(loginRes.token, loginRes.user);
        assert.equal(ApiClient.getToken(), 'mock_jwt_token_123');
        assert.equal(ApiClient.getCurrentUser().username, 'alice');

        // Step 2: 创建文档
        const createdDoc = await ApiClient.documents.create('端到端测试文档', '# 初始内容');
        assert.equal(createdDoc.id, 'doc_1');
        assert.equal(createdDoc.version, 1);

        // Step 3: 初始化 SyncEngine 会话
        const sync = new SyncEngine();
        sync.initSession(loginRes.user.id, createdDoc);
        assert.equal(sync.state, SyncState.SYNCED);
        assert.equal(sync.baseVersion, 1);

        // Step 4: 模拟用户打字编辑
        sync.onInput('端到端测试文档 (已编辑)', '# 初始内容\n\n新增测试段落');
        assert.equal(sync.state, SyncState.DIRTY);
        assert.equal(sync.localRevision, 1);

        // Step 5: 触发自动保存
        await sync.triggerSave();
        assert.equal(sync.state, SyncState.SYNCED);
        assert.equal(sync.baseVersion, 2);
        assert.equal(sync.ackedRevision, 1);

        // Step 6: 刷新读取验证
        const refreshedDoc = await ApiClient.documents.get(createdDoc.id);
        assert.equal(refreshedDoc.version, 2);
        assert.equal(refreshedDoc.title, '端到端测试文档 (已编辑)');
        assert.equal(refreshedDoc.content, '# 初始内容\n\n新增测试段落');

        // Step 7: 删除文档
        await ApiClient.documents.delete(createdDoc.id, 2);
        await assert.rejects(
            async () => await ApiClient.documents.get(createdDoc.id),
            (err) => err.status === 404
        );

        sync.clearTimers();
    } finally {
        globalThis.fetch = originalFetch;
        ApiClient.clearToken();
    }
});

test('【冲突处理分支】验证“用本地覆盖”与“拉取云端”双分支行为', async () => {
    const sync = new SyncEngine();
    sync.initSession('u1', { id: 'doc_c1', title: '云端原标题', content: '云端原内容', version: 1 });

    // 用户在本地编辑
    sync.onInput('本地最新标题', '本地最新内容');
    assert.equal(sync.state, SyncState.DIRTY);

    // 模拟服务端返回冲突：云端版本已变为 3
    sync.state = SyncState.CONFLICT;

    // --- 分支 A：用本地覆盖 (resolveOverwrite) ---
    let savedDoc = null;
    const originalUpdate = ApiClient.documents.update;
    ApiClient.documents.update = async (id, title, content, expectedVersion) => {
        savedDoc = { id, title, content, version: expectedVersion + 1 };
        return savedDoc;
    };

    try {
        await sync.resolveOverwrite(3);
        assert.equal(sync.state, SyncState.SYNCED);
        assert.equal(sync.baseVersion, 4); // 3 + 1
        assert.equal(sync.currentTitle, '本地最新标题');
        assert.equal(sync.currentContent, '本地最新内容');
        assert.equal(savedDoc.version, 4);
    } finally {
        ApiClient.documents.update = originalUpdate;
    }

    // --- 分支 B：拉取云端覆盖本地 (resolveReload) ---
    // 再次产生本地修改进入冲突
    sync.onInput('本地二次修改', '本地二次内容');
    sync.state = SyncState.CONFLICT;

    const cloudDoc = {
        id: 'doc_c1',
        title: '云端其他会话修改的标题',
        content: '云端其他会话修改的内容',
        version: 5
    };

    sync.resolveReload(cloudDoc);
    assert.equal(sync.state, SyncState.SYNCED);
    assert.equal(sync.baseVersion, 5);
    assert.equal(sync.currentTitle, '云端其他会话修改的标题');
    assert.equal(sync.currentContent, '云端其他会话修改的内容');
    assert.equal(sync.localRevision, 0);

    sync.clearTimers();
});

test('【草稿恢复分支】验证“恢复草稿”与“放弃草稿”双分支行为', () => {
    const cloudDoc = {
        id: 'doc_d1',
        title: '云端正本标题',
        content: '云端正本内容',
        version: 2
    };

    // 本地留存基于该版本的离线草稿
    const draftData = {
        userId: 'u_test',
        docId: 'doc_d1',
        sessionId: 'sess_prev',
        baseVersion: 2,
        title: '本地离线新标题',
        content: '本地离线新正文',
        localRevision: 3
    };
    drafts.saveDraft(draftData);
    const draftKey = drafts.buildDraftKey(draftData);

    const check = drafts.classifyRestore(drafts.readDraft(draftKey), cloudDoc);
    assert.equal(check, 'confirm');

    // --- 分支 A：用户选择“恢复” ---
    // 以云端版本为基准初始化 session，随后将草稿内容通过 onInput 注入，形成未提交脏数据
    const syncRecover = new SyncEngine();
    syncRecover.initSession('u_test', cloudDoc);
    assert.equal(syncRecover.state, SyncState.SYNCED);

    // 注入草稿
    syncRecover.onInput(draftData.title, draftData.content);
    assert.equal(syncRecover.state, SyncState.DIRTY);
    assert.equal(syncRecover.localRevision, 1);
    assert.equal(syncRecover.baseVersion, 2);
    assert.equal(syncRecover.currentTitle, '本地离线新标题');
    syncRecover.clearTimers();

    // --- 分支 B：用户选择“放弃” ---
    // 删除草稿，编辑器保留云端原样
    const syncDiscard = new SyncEngine();
    syncDiscard.initSession('u_test', cloudDoc);
    assert.equal(syncDiscard.state, SyncState.SYNCED);

    const discarded = drafts.discardDraft(draftKey, {
        sessionId: 'sess_prev',
        localRevision: 3,
        content: '本地离线新正文'
    });
    assert.equal(discarded, true);
    assert.equal(drafts.readDraft(draftKey), null);
    assert.equal(syncDiscard.currentTitle, '云端正本标题');
});

test('【异常重试与状态指示】网络失败、500、429、401、409 差异化处理', async () => {
    const sync = new SyncEngine();
    sync.initSession('u1', { id: 'doc_e1', title: 'T', content: 'C', version: 1 });
    sync.onInput('T2', 'C2');

    const originalUpdate = ApiClient.documents.update;

    // 1. 模拟网络错误 (fetch 抛异常) -> 进入 RETRY_WAIT，启动指数退避计时器
    ApiClient.documents.update = async () => {
        throw new TypeError('Failed to fetch (Network connection lost)');
    };
    await sync.triggerSave();
    assert.equal(sync.state, SyncState.RETRY_WAIT);
    assert.equal(sync.retryAttempt, 1);
    assert.ok(sync.retryTimer !== null);
    sync.clearTimers();

    // 2. 模拟 429 请求过多 (限流) -> 读取 Retry-After 调度退避
    ApiClient.documents.update = async () => {
        const err = new Error('Too Many Requests');
        err.status = 429;
        throw err;
    };
    await sync.triggerSave();
    assert.equal(sync.state, SyncState.RETRY_WAIT);
    assert.equal(sync.retryAttempt, 2);
    sync.clearTimers();

    // 3. 模拟 401 令牌过期 -> 进入 AUTH_REQUIRED，且不触发盲目重试
    ApiClient.documents.update = async () => {
        const err = new Error('Unauthorized');
        err.status = 401;
        throw err;
    };
    await sync.triggerSave();
    assert.equal(sync.state, SyncState.AUTH_REQUIRED);
    assert.equal(sync.retryTimer, null); // 绝不重试

    // 4. 模拟 409 版本冲突 -> 进入 CONFLICT，不触发盲目重试
    ApiClient.documents.update = async () => {
        const err = new Error('Version conflict');
        err.status = 409;
        err.details = { server_version: 5 };
        throw err;
    };
    await sync.triggerSave();
    assert.equal(sync.state, SyncState.CONFLICT);
    assert.equal(sync.retryTimer, null); // 绝不重试

    ApiClient.documents.update = originalUpdate;
});
