/**
 * Gemini 3.8 Flash Markdown Studio - 自动保存状态机 (严格对齐 SYNC.md)
 * 调度参数：防抖 1.5s / 最大等待 5s / 超时 10s (AbortController) / 在途请求上限 1
 * 状态枚举：synced, dirty, saving, retry_wait, auth_required, conflict, invalid
 */

import { ApiClient } from './api.js';
import * as drafts from './drafts.js';

export const SyncState = {
    SYNCED: 'synced',
    DIRTY: 'dirty',
    SAVING: 'saving',
    RETRY_WAIT: 'retry_wait',
    AUTH_REQUIRED: 'auth_required',
    CONFLICT: 'conflict',
    INVALID: 'invalid'
};

export class SyncEngine {
    constructor(callbacks = {}) {
        this.state = SyncState.SYNCED;

        // 会话核心字段 (SYNC.md §1)
        this.userId = null;
        this.docId = null;
        this.editSessionId = null;
        this.baseVersion = 1;
        this.localRevision = 0;
        this.ackedRevision = 0;

        // 当前草稿内存缓冲
        this.currentTitle = '';
        this.currentContent = '';

        // 调度计时器与在途控制 (SYNC.md §2)
        this.debounceDelay = 1500; // 防抖 1.5 秒
        this.maxWaitDelay = 5000;  // 持续打字最大等待 5 秒
        this.requestTimeout = 10000; // 超时 10 秒

        this.debounceTimer = null;
        this.maxWaitTimer = null;
        this.retryTimer = null;
        this.retryAttempt = 0;

        this.inFlight = false;
        this.flightSeq = 0; // 单调递增的在途请求序号，隔离旧请求响应 (Issue 3)
        this.pendingSnapshot = null;

        this.callbacks = {
            onStateChange: callbacks.onStateChange || (() => {}),
            onConflict: callbacks.onConflict || (() => {}),
            onError: callbacks.onError || (() => {}),
            onSaveSuccess: callbacks.onSaveSuccess || (() => {})
        };
    }

    setState(newState, payload = {}) {
        this.state = newState;
        this.callbacks.onStateChange(newState, payload);
    }

    /**
     * 打开或重设编辑文档 (建立新编辑会话，重新生成 editSessionId)
     */
    initSession(userId, doc) {
        this.clearTimers();
        this.flightSeq += 1; // 递增请求序列，废弃所有先前发出的异步请求响应
        this.inFlight = false;
        this.pendingSnapshot = null;
        this.retryAttempt = 0;

        this.userId = userId;
        this.docId = doc.id;
        this.editSessionId = drafts.createEditSessionId();
        this.baseVersion = doc.version;
        this.localRevision = 0;
        this.ackedRevision = 0;
        this.currentTitle = doc.title;
        this.currentContent = doc.content;

        this.setState(SyncState.SYNCED, {
            version: this.baseVersion,
            localRevision: this.localRevision,
            ackedRevision: this.ackedRevision
        });
    }

    /**
     * 内容输入触发 (正文或标题变动均严格 localRevision + 1)
     */
    onInput(title, content) {
        if (!this.docId || !this.userId) return;

        const isChanged = this.currentTitle !== title || this.currentContent !== content;
        if (!isChanged) return;

        this.currentTitle = title;
        this.currentContent = content;
        this.localRevision += 1;

        // 1. 尝试保存本地草稿，检查存储返回值 (Issue 7)
        const backupRes = drafts.saveDraft({
            userId: this.userId,
            docId: this.docId,
            sessionId: this.editSessionId,
            baseVersion: this.baseVersion,
            title: this.currentTitle,
            content: this.currentContent,
            localRevision: this.localRevision
        });

        const isBackedUp = backupRes && backupRes.success;
        this.setState(SyncState.DIRTY, {
            localRevision: this.localRevision,
            backedUpLocally: isBackedUp,
            message: isBackedUp ? '已在本地备份' : '本地备份失败 (存储受限/配额已满)'
        });

        // 2. 防抖 1.5 秒
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.triggerSave();
        }, this.debounceDelay);

        // 3. 最大等待 5 秒 (持续输入时确保定期尝试保存)
        if (!this.maxWaitTimer) {
            this.maxWaitTimer = setTimeout(() => {
                this.triggerSave();
            }, this.maxWaitDelay);
        }
    }

    clearTimers() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.debounceTimer = null;
        this.maxWaitTimer = null;
        this.retryTimer = null;
    }

    /**
     * 解决冲突：以本地最新内容强制覆盖云端 (Issue 5)
     */
    async resolveOverwrite(serverVersion) {
        if (!this.docId || !this.userId) return;
        this.clearTimers();
        this.baseVersion = serverVersion;
        this.localRevision += 1;
        this.state = SyncState.DIRTY;
        this.setState(SyncState.DIRTY, {
            localRevision: this.localRevision,
            message: '准备覆盖保存...'
        });
        await this.triggerSave();
    }

    /**
     * 解决冲突：放弃本地修改，重新拉取云端版本 (Issue 5)
     */
    async resolveReload(serverDoc) {
        if (!this.docId || !this.userId) return;
        this.clearTimers();
        try {
            const key = drafts.buildDraftKey({
                userId: this.userId,
                docId: this.docId,
                sessionId: this.editSessionId
            });
            drafts.discardDraft(key, {
                sessionId: this.editSessionId,
                localRevision: this.localRevision,
                content: this.currentContent
            });
        } catch (_) {}
        this.initSession(this.userId, serverDoc);
    }

    /**
     * 指数退避调度重试 (Issue 6)
     */
    scheduleRetry(reasonMessage, customDelayMs = null) {
        this.clearTimers();
        this.retryAttempt += 1;

        // 指数退避：1s, 2s, 4s, 8s, 16s，封顶 30s + 少量随机抖动
        const backoffMs = customDelayMs !== null
            ? customDelayMs
            : Math.min(1000 * Math.pow(2, this.retryAttempt - 1), 30000) + Math.floor(Math.random() * 500);

        const waitSec = Math.max(1, Math.round(backoffMs / 1000));
        this.setState(SyncState.RETRY_WAIT, {
            message: `${reasonMessage} (${waitSec}秒后重试)`,
            attempt: this.retryAttempt,
            delayMs: backoffMs
        });

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.state === SyncState.RETRY_WAIT) {
                this.triggerSave();
            }
        }, backoffMs);
    }

    /**
     * 触发云端保存 (严格在途请求上限 = 1，合并后续修改)
     */
    async triggerSave() {
        this.clearTimers();

        if (!this.docId || !this.userId) return;
        if (this.state === SyncState.CONFLICT || this.state === SyncState.INVALID) return;

        // 检查是否有在途请求
        if (this.inFlight) {
            // 合并为等待下一次发出的最新快照 (SYNC.md §2.2)
            this.pendingSnapshot = {
                flightSeq: this.flightSeq,
                docId: this.docId,
                sessionId: this.editSessionId,
                title: this.currentTitle,
                content: this.currentContent,
                revision: this.localRevision
            };
            return;
        }

        // 检查是否已有未确认修订
        if (this.ackedRevision >= this.localRevision) {
            this.setState(SyncState.SYNCED, { version: this.baseVersion });
            return;
        }

        const currentFlight = ++this.flightSeq;
        const snapshot = {
            flightSeq: currentFlight,
            userId: this.userId,
            docId: this.docId,
            sessionId: this.editSessionId,
            title: this.currentTitle,
            content: this.currentContent,
            revision: this.localRevision,
            expectedVersion: this.baseVersion
        };

        this.inFlight = true;
        this.setState(SyncState.SAVING);

        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), this.requestTimeout);

        try {
            const resp = await ApiClient.documents.update(
                snapshot.docId,
                snapshot.title,
                snapshot.content,
                snapshot.expectedVersion,
                { signal: abortController.signal }
            );

            clearTimeout(timeoutId);

            // 跨会话隔离检查 (Issue 3)：若在此期间会话已切换或文档已更换，旧响应严禁污染新会话
            if (this.flightSeq !== currentFlight || this.docId !== snapshot.docId || this.editSessionId !== snapshot.sessionId) {
                // 后台清理旧文档已确认的草稿，但不触碰当前会话的状态与版本
                try {
                    const oldKey = drafts.buildDraftKey({
                        userId: snapshot.userId,
                        docId: snapshot.docId,
                        sessionId: snapshot.sessionId
                    });
                    drafts.discardDraft(oldKey, {
                        sessionId: snapshot.sessionId,
                        localRevision: snapshot.revision,
                        content: snapshot.content
                    });
                } catch (_) {}
                return;
            }

            this.inFlight = false;
            this.retryAttempt = 0;

            // 成功：采纳服务端新版本
            this.baseVersion = resp.version;
            this.ackedRevision = snapshot.revision;

            // 依据 SYNC.md §4.2 严格三重条件判定是否可显示“已同步”
            if (this.ackedRevision >= this.localRevision) {
                // 删除已被云端确认的该会话草稿 (三重核对)
                const key = drafts.buildDraftKey({
                    userId: this.userId,
                    docId: this.docId,
                    sessionId: this.editSessionId
                });
                drafts.discardDraft(key, {
                    sessionId: this.editSessionId,
                    localRevision: this.ackedRevision,
                    content: snapshot.content
                });

                this.setState(SyncState.SYNCED, { version: this.baseVersion });
            } else {
                // 在途期间用户又输入，仍为 dirty，立即发出最新快照
                this.setState(SyncState.DIRTY, {
                    localRevision: this.localRevision,
                    message: '已在本地备份'
                });
            }

            this.callbacks.onSaveSuccess({
                id: this.docId,
                title: snapshot.title,
                version: this.baseVersion,
                updated_at: resp.updated_at
            });

            // 如果有合并的在途新输入，紧接着发起保存
            if (this.pendingSnapshot) {
                const pending = this.pendingSnapshot;
                this.pendingSnapshot = null;
                if (pending.docId === this.docId && pending.sessionId === this.editSessionId) {
                    this.triggerSave();
                }
            }
        } catch (err) {
            clearTimeout(timeoutId);

            // 跨会话隔离检查 (Issue 3)：旧请求的异常同样不能污染新文档
            if (this.flightSeq !== currentFlight || this.docId !== snapshot.docId || this.editSessionId !== snapshot.sessionId) {
                return;
            }

            this.inFlight = false;

            if (err.name === 'AbortError') {
                this.scheduleRetry('请求超时 (10s)');
                this.callbacks.onError(err);
            } else if (err.code === 'VERSION_CONFLICT' || err.status === 409) {
                this.clearTimers();
                this.setState(SyncState.CONFLICT, { serverVersion: err.details?.server_version });
                this.callbacks.onConflict(err.details?.server_version);
            } else if (err.code === 'UNAUTHORIZED' || err.status === 401) {
                this.clearTimers();
                this.setState(SyncState.AUTH_REQUIRED);
            } else if (err.code === 'BAD_REQUEST' || err.status === 400 || err.code === 'PAYLOAD_TOO_LARGE' || err.status === 413) {
                this.clearTimers();
                this.setState(SyncState.INVALID, { message: err.message });
            } else if (err.code === 'RATE_LIMITED' || err.status === 429) {
                const waitSec = err.retryAfter ? parseInt(err.retryAfter, 10) : 60;
                this.scheduleRetry(`请求过于频繁`, waitSec * 1000);
            } else {
                this.scheduleRetry(err.message || '网络连接异常');
                this.callbacks.onError(err);
            }
        }
    }
}
