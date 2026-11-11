/**
 * sync.js —— 自动保存状态机 (严格对齐 docs/SYNC.md §2.1)
 *
 * 调度参数：防抖 1.5s / 最大等待 5.0s / 10s 超时 / 在飞请求上限 1
 * 7 种标准状态枚举：
 *   - synced: 已同步
 *   - dirty: 本地编辑已触发草稿保存，等待防抖同步
 *   - saving: 正在向服务端提交
 *   - retry_wait: 遇到临时网络或 5xx 故障退避重试
 *   - auth_required: 401 认证失效需重新登录
 *   - conflict: 409 版本冲突
 *   - invalid: 400 校验错误或 413 正文超限
 *
 * 严守文案禁令：未获 200 确认前，严禁展示“已同步/保存成功”，本地保存时必须显示“已在本地备份”。
 */

import { apiFetch, VersionConflictError, AuthError, InvalidInputError, TooLargeError } from './api.js';
import * as drafts from './drafts.js';

export const SyncState = {
  SYNCED: 'synced',
  DIRTY: 'dirty',
  SAVING: 'saving',
  RETRY_WAIT: 'retry_wait',
  AUTH_REQUIRED: 'auth_required',
  CONFLICT: 'conflict',
  INVALID: 'invalid',
};

export class SyncEngine {
  constructor(callbacks = {}) {
    this.state = SyncState.SYNCED;

    // 会话标识 (docs/SYNC.md §1)
    this.userId = null;
    this.docId = null;
    this.editSessionId = null;
    this.baseVersion = 1;
    this.localRevision = 0;
    this.ackedRevision = 0;

    // 内存草稿缓冲
    this.currentTitle = '';
    this.currentContent = '';

    // 调度计时器与控制
    this.debounceDelay = 1500; // 防抖 1.5s
    this.maxWaitDelay = 5000;  // 持续输入最大等待 5.0s
    this.retryDelay = 3000;    // 退避重试等待 3.0s

    this.debounceTimer = null;
    this.maxWaitTimer = null;
    this.retryTimer = null;

    this.inFlight = false;
    this.token = null;

    this.callbacks = {
      onStateChange: callbacks.onStateChange || (() => {}),
      onConflict: callbacks.onConflict || (() => {}),
      onError: callbacks.onError || (() => {}),
      onSaveSuccess: callbacks.onSaveSuccess || (() => {}),
    };
  }

  setState(newState, payload = {}) {
    this.state = newState;
    this.callbacks.onStateChange(newState, payload);
  }

  /**
   * 初始化/切换编辑会话
   */
  initSession(userId, token, doc) {
    this.clearTimers();
    this.inFlight = false;

    this.userId = userId;
    this.token = token;
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
      ackedRevision: this.ackedRevision,
    });
  }

  setToken(token) {
    this.token = token;
    if (this.state === SyncState.AUTH_REQUIRED && token) {
      this.setState(SyncState.DIRTY);
      this.scheduleSave();
    }
  }

  /**
   * 用户键入事件处理
   */
  onInput(title, content) {
    if (!this.docId || !this.userId) return;

    const isChanged = this.currentTitle !== title || this.currentContent !== content;
    if (!isChanged) return;

    this.currentTitle = title;
    this.currentContent = content;
    this.localRevision += 1;

    // 1. 立即写入本地草稿，遵循文案禁令显示“已在本地备份”
    try {
      drafts.saveDraft({
        userId: this.userId,
        docId: this.docId,
        sessionId: this.editSessionId,
        baseVersion: this.baseVersion,
        localRevision: this.localRevision,
        title: this.currentTitle,
        content: this.currentContent,
        recordedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('本地草稿保存失败:', e);
    }

    this.setState(SyncState.DIRTY, {
      localRevision: this.localRevision,
      message: '已在本地备份',
    });

    // 2. 调度服务端自动保存
    this.scheduleSave();
  }

  scheduleSave() {
    if (this.state === SyncState.CONFLICT || this.state === SyncState.AUTH_REQUIRED || this.state === SyncState.INVALID) {
      return;
    }

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.clearTimers();
      this.flushSave();
    }, this.debounceDelay);

    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        this.clearTimers();
        this.flushSave();
      }, this.maxWaitDelay);
    }
  }

  /**
   * 立即触发保存 (并发控制：严格在飞上限 1)
   */
  async flushSave() {
    this.clearTimers();

    if (this.inFlight) {
      // 若已有请求在飞，等待其完成后再发最新快照
      return;
    }

    if (this.localRevision <= this.ackedRevision) {
      this.setState(SyncState.SYNCED, { version: this.baseVersion });
      return;
    }

    if (!this.token) {
      this.setState(SyncState.AUTH_REQUIRED);
      return;
    }

    this.inFlight = true;
    this.setState(SyncState.SAVING);

    const snapshot = {
      title: this.currentTitle,
      content: this.currentContent,
      expected_version: this.baseVersion,
      savingRevision: this.localRevision,
      sessionId: this.editSessionId,
    };

    try {
      const resp = await apiFetch(`/documents/${this.docId}`, {
        method: 'PUT',
        token: this.token,
        body: {
          title: snapshot.title,
          content: snapshot.content,
          expected_version: snapshot.expected_version,
        },
      });

      this.inFlight = false;
      this.baseVersion = resp.version;
      this.ackedRevision = snapshot.savingRevision;

      // 仅当会话、版本和内容完全匹配才安全清理草稿 (INTERFACES.md §C9)
      try {
        const draftKey = drafts.buildDraftKey({
          userId: this.userId,
          docId: this.docId,
          sessionId: snapshot.sessionId,
        });
        drafts.discardDraft(draftKey, {
          sessionId: snapshot.sessionId,
          localRevision: snapshot.savingRevision,
          content: snapshot.content,
        });
      } catch (e) {
        console.warn('草稿清理跳过:', e);
      }

      this.callbacks.onSaveSuccess(resp);

      // 若在保存期间有新输入，继续触发下一轮
      if (this.localRevision > this.ackedRevision) {
        this.setState(SyncState.DIRTY, { message: '已在本地备份' });
        this.scheduleSave();
      } else {
        this.setState(SyncState.SYNCED, {
          version: this.baseVersion,
          localRevision: this.localRevision,
          ackedRevision: this.ackedRevision,
        });
      }
    } catch (err) {
      this.inFlight = false;

      if (err instanceof VersionConflictError) {
        this.setState(SyncState.CONFLICT, {
          serverVersion: err.serverVersion,
          clientVersion: this.baseVersion,
        });
        this.callbacks.onConflict({
          serverVersion: err.serverVersion,
          localTitle: snapshot.title,
          localContent: snapshot.content,
        });
      } else if (err instanceof AuthError) {
        this.setState(SyncState.AUTH_REQUIRED);
      } else if (err instanceof InvalidInputError || err instanceof TooLargeError) {
        this.setState(SyncState.INVALID, { error: err.message });
      } else {
        // 网络中断或 5xx 服务端错误，进入退避等待重试
        this.setState(SyncState.RETRY_WAIT, {
          message: '网络中断，已在本地备份，稍后重试',
        });
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.flushSave();
        }, this.retryDelay);
      }

      this.callbacks.onError(err);
    }
  }

  /**
   * 冲突解决：覆盖服务端版本 (强制采用本地版本)
   */
  async resolveOverwrite(serverVersion) {
    this.baseVersion = serverVersion;
    this.setState(SyncState.DIRTY, { message: '已在本地备份' });
    await this.flushSave();
  }

  /**
   * 冲突解决：丢弃本地草稿，重新载入云端最新版本
   */
  resolveReload(serverDoc) {
    this.clearTimers();
    try {
      drafts.clearSessionDrafts({
        userId: this.userId,
        docId: this.docId,
        sessionId: this.editSessionId,
      }, { force: true });
    } catch (e) {
      console.warn('强制清理草稿失败:', e);
    }
    this.initSession(this.userId, this.token, serverDoc);
  }

  clearTimers() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    this.retryTimer = null;
  }

  destroy() {
    this.clearTimers();
  }
}
