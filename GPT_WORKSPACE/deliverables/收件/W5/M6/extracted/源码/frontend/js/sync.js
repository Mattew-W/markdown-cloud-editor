/**
 * sync.js —— 自动保存状态机（严格对齐 docs/SYNC.md §2.1）
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
 * 严守文案禁令（SYNC.md §4.4）：未获 200 确认前，严禁展示“已同步/保存成功”，
 * 本地保存时必须显示“已在本地备份”；**本地写入失败时必须显示“本地备份失败”，
 * 不得虚报成功**（§9.8 验收项 T10）。
 *
 * ---------------------------------------------------------------------------
 * 本模块修过的缺陷（均为 W4 审计实测复现，非推测）
 * ---------------------------------------------------------------------------
 *
 * 1. **旧响应污染新会话**（P0）
 *    原实现的响应处理直接写 `this.baseVersion` / `this.ackedRevision`，
 *    而快照只捕获了 `sessionId`、没有捕获 `userId` / `docId`。
 *    切到 B 文档后，A 的迟到响应会把 A 的版本号写进 B，
 *    甚至出现「B 的内容一个字都没上传，界面却显示已同步」的静默丢数据。
 *    → 现引入**会话世代号** `generation`：响应回来先校验世代，
 *      不匹配即**只更新所属协调器的内部状态，不触碰当前 UI**（SYNC.md §8.2）。
 *
 * 2. **切换会话后并发写**（P0）
 *    原 `initSession` 会把 `inFlight` 重置为 `false`，
 *    于是 A 的请求还在飞时切到 B，B 立刻又发一个 PUT，同一文档出现两个在飞请求。
 *    → 在途状态改为**按 docId 追踪**（`inFlightByDoc`），
 *      切会话不再清空它，"同一文档最多一个 PUT"（§2.2）得以保持。
 *
 * 3. **阻塞态被悄悄解除**（P0）
 *    原 `onInput` 先 `setState(DIRTY)` 再 `scheduleSave()`，
 *    而 `scheduleSave()` 里的阻塞态守卫读的是**已被改写**的 `this.state`，
 *    于是守卫永不生效；`flushSave()` 则根本没有守卫。
 *    → 冲突 / 认证失效 / 输入非法时，新输入与手动保存**都不得**发起写请求（§5、§11.3）。
 *
 * 4. **存储失败虚报成功**（P0）
 *    原实现在 `saveDraft` 抛错后只 `console.warn`，
 *    随后无条件 `setState(DIRTY, { message: '已在本地备份' })`。
 *    → 现按 `DraftStorageError.reason` 分类，失败时消息改为「本地备份失败」，
 *      **保留内存内容**并提供 Markdown 下载（§9.8）。
 *
 * 5. **盲重发 PUT**（P0）
 *    原实现在网络错误后固定 3 秒重发同一个 PUT，从不读取云端核对。
 *    服务端已提交但响应丢失时，重发必然得到 409，
 *    用户看到的是「版本冲突」，而内容其实早在云端。
 *    → 现按 SYNC.md §6 四分支：**先 GET 核对，再决定**。
 *
 * 6. **429 无视 Retry-After**（P1）
 *    原实现未导入 `RateLimitedError`，429 落入通用分支走固定 3 秒重试。
 *    → 现按 §7.2 遵循响应头 `Retry-After`。
 *
 * 7. **退避表缺失**（P1）
 *    原实现固定 3 秒重试，无指数递增、无抖动。
 *    → 现按 §7.1 的 1/2/4/8/16/30 秒退避表 + 随机扰动。
 *
 * 8. **force:true 绕开草稿核对**（P1）
 *    原 `resolveReload` 用 `clearSessionDrafts(..., { force: true })`，
 *    会删掉**其他标签页尚未同步**的草稿。
 *    → 现改为只对**当前会话自己的草稿**做三重核对删除。
 *
 * 9. **草稿未走 250ms 合并窗口**（P2）
 *    原实现每次按键直接 `saveDraft`，实测 10 次输入产生 10 次存储写入。
 *    → 现走 `createDraftWriter`（§9.4）。
 *
 * 10. **无可控时钟**（P2，SYNC.md §7.3 要求）
 *    → 构造器支持注入 `timers` / `fetchImpl` / `random`，测试无需真实等待。
 */

import {
  apiFetch,
  VersionConflictError,
  AuthError,
  InvalidInputError,
  TooLargeError,
  NotFoundError,
  RateLimitedError,
} from './api.js';
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

/**
 * 退避表（SYNC.md §7.1，单位毫秒）。
 * 第 6 次及以后固定 30 秒（上限）。
 */
export const BACKOFF_LADDER = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);

/**
 * 随机扰动幅度（相对基数）。用于避免多标签页同时失败后的惊群效应。
 */
export const JITTER_RATIO = 0.2;

/**
 * 会话被阻塞的状态：这些状态下**不得**发起任何写请求，
 * 也**不得**被新输入或手动保存悄悄解除（SYNC.md §5、§11.3）。
 */
const BLOCKED_STATES = Object.freeze([
  SyncState.CONFLICT,
  SyncState.AUTH_REQUIRED,
  SyncState.INVALID,
]);

export class SyncEngine {
  /**
   * @param {object} [callbacks]
   * @param {(state: string, payload: object) => void} [callbacks.onStateChange]
   * @param {(info: object) => void} [callbacks.onConflict]
   * @param {(error: Error) => void} [callbacks.onError]
   * @param {(resp: object) => void} [callbacks.onSaveSuccess]
   * @param {() => void} [callbacks.onCloudUnavailable] 云端文档已不可用（§6 分支 ④）
   * @param {(info: object) => void} [callbacks.onStorageFailure] 本地备份失败
   * @param {object} [options]
   * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] 注入时钟
   * @param {typeof fetch} [options.fetchImpl] 注入 fetch 实现
   * @param {() => number} [options.random] 注入随机源（退避抖动用）
   * @param {StorageAdapter} [options.storage] 注入存储适配器
   */
  constructor(callbacks = {}, options = {}) {
    this.state = SyncState.SYNCED;

    // 会话标识（docs/SYNC.md §1）
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
    this.debounceDelay = 1500; // 防抖 1.5s（§2.1）
    this.maxWaitDelay = 5000;  // 持续输入最大等待 5.0s（§2.1）

    this.debounceTimer = null;
    this.maxWaitTimer = null;
    this.retryTimer = null;

    /**
     * 会话世代号。每次 `initSession` / `destroy` 自增。
     * 响应回来时世代不匹配即说明会话已切换，该响应**不得**影响当前会话。
     */
    this.generation = 0;

    /**
     * 在途请求按 docId 追踪。
     *
     * 不用单个布尔值的原因：切会话时不得清空它，
     * 否则新会话会误以为"没有在途请求"而发出第二个 PUT（§2.2）。
     *
     * @type {Map<string, object>}
     */
    this.inFlightByDoc = new Map();

    /**
     * 结果未知、需要核对的请求（按 docId）。
     * 切回该文档时必须先核对再建立写入基准（§8.4）。
     *
     * @type {Map<string, object>}
     */
    this.pendingReconcile = new Map();

    this.token = null;

    /** 连续失败次数，用于退避表（§7.1）。 */
    this.retryAttempt = 0;

    /**
     * 本地备份失败信息。
     * 与云端同步状态**正交**：云端可能已 synced，但本地备份失败仍需提示。
     *
     * @type {{reason: string, message: string} | null}
     */
    this.storageFailure = null;

    this.timers = options.timers ?? {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.random = options.random ?? Math.random;
    this.storage = options.storage;

    this.callbacks = {
      onStateChange: callbacks.onStateChange || (() => {}),
      onConflict: callbacks.onConflict || (() => {}),
      onError: callbacks.onError || (() => {}),
      onSaveSuccess: callbacks.onSaveSuccess || (() => {}),
      onCloudUnavailable: callbacks.onCloudUnavailable || (() => {}),
      onStorageFailure: callbacks.onStorageFailure || (() => {}),
    };

    /**
     * 草稿写入器（250 毫秒合并窗口，§9.4）。
     * @type {ReturnType<typeof drafts.createDraftWriter> | null}
     */
    this.draftWriter = null;
  }

  setState(newState, payload = {}) {
    this.state = newState;
    this.callbacks.onStateChange(newState, payload);
  }

  /**
   * 当前是否处于阻塞态。
   *
   * 阻塞态下**不得**发起任何写请求，也不得被新输入或手动保存解除。
   *
   * @returns {boolean}
   */
  isBlocked() {
    return BLOCKED_STATES.includes(this.state);
  }

  /**
   * 初始化/切换编辑会话。
   *
   * **注意**：本方法**不再**清空 `inFlightByDoc`。
   * 旧会话的请求可能仍在途，其响应回来时会因世代号不匹配而被丢弃，
   * 但在途事实必须保留，否则同一文档会出现两个并发 PUT（§2.2）。
   *
   * @param {string} userId
   * @param {string} token
   * @param {{id: string, title?: string, content?: string, version?: number}} doc
   */
  initSession(userId, token, doc) {
    // ⚠ 顺序约束（SYNC §8.1、M6 W5 缺口 F-03）：
    //   切换文档/会话前**必须先 flush 待写缓冲**，再清定时器、最后换
    //   docId / editSessionId。否则 250ms 合并窗口里的最后一批编辑会：
    //     a) 被新文档的 schedule() 直接覆盖 pendingDraft → 从未落盘；
    //     b) 或在定时器到点时以**新会话**的键写出 → 写错位置。
    //   flush 必须发生在本方法改写 docId / editSessionId **之前**，
    //   否则 draftWriter 会用新会话的键去写旧内容。
    this.flushDraft();
    this.clearTimers();

    // 世代号自增：所有在途的旧响应自此失效。
    this.generation += 1;

    this.userId = userId;
    this.token = token;
    this.docId = doc.id;
    this.editSessionId = drafts.createEditSessionId();
    this.baseVersion = doc.version ?? 1;
    this.localRevision = 0;
    this.ackedRevision = 0;
    this.currentTitle = doc.title ?? '';
    this.currentContent = doc.content ?? '';
    this.retryAttempt = 0;

    this.setState(SyncState.SYNCED, {
      version: this.baseVersion,
      localRevision: this.localRevision,
      ackedRevision: this.ackedRevision,
      storageOk: true,
    });
  }

  /**
   * 更新访问令牌。
   *
   * 认证失效（auth_required）时拿到新令牌可恢复调度。
   */
  setToken(token) {
    this.token = token;
    if (this.state === SyncState.AUTH_REQUIRED && token) {
      this.setState(SyncState.DIRTY, { storageOk: this.storageFailure === null });
      this.scheduleSave();
    }
  }

  /**
   * 用户键入事件处理。
   *
   * @param {string} title
   * @param {string} content
   */
  onInput(title, content) {
    if (!this.docId || !this.userId) return;

    const isChanged = this.currentTitle !== title || this.currentContent !== content;
    if (!isChanged) return;

    // 内存副本**先于**任何可能失败的存储写入更新。
    // 存储失败时这份内存内容是最后一道防线（§9.8「禁止清空编辑器内容」）。
    this.currentTitle = title;
    this.currentContent = content;
    this.localRevision += 1;

    // 1. 排入本地草稿（250 毫秒合并写入，§9.4）
    this.writeDraft();

    // 2. 阻塞态：**保持阻塞状态**，不调度任何写请求（§5、§11.3）。
    //    但用户的输入仍留在内存与草稿里，不丢失。
    if (this.isBlocked()) {
      return;
    }

    this.setState(SyncState.DIRTY, {
      localRevision: this.localRevision,
      message: this.storageFailure ? '本地备份失败' : '已在本地备份',
      storageOk: this.storageFailure === null,
    });

    // 3. 调度服务端自动保存
    this.scheduleSave();
  }

  /**
   * 排入一次草稿写入。
   *
   * 写入失败**不得**虚报成功：失败信息记入 `this.storageFailure`，
   * 由下一次状态载荷透出 `storageOk: false` 与「本地备份失败」文案。
   */
  writeDraft() {
    if (!this.draftWriter) {
      try {
        this.draftWriter = drafts.createDraftWriter({
          storage: this.storage,
          // 注入同一套时钟，保证测试可取消（§7.3）。
          delay: (fn, ms) =>
            this.timers.setTimeout(() => {
              try {
                fn();
              } catch (error) {
                this.onDraftWriteFailed(error);
              }
            }, ms),
          clearDelay: (handle) => this.timers.clearTimeout(handle),
        });
      } catch (error) {
        // 【重要】创建写入器本身也可能失败（例如浏览器禁用了 localStorage，
        // `defaultStorage()` 会直接抛错）。
        //
        // 原实现把 `createDraftWriter` 写在 try 之外，于是这类失败会
        // **中断整个 onInput** —— 用户连字都打不进去。
        // 正确处置：记录存储失败，继续走云端同步（§9.8：保留内存内容）。
        this.onDraftWriteFailed(error);
        return;
      }
    }

    try {
      this.draftWriter.schedule({
        userId: this.userId,
        docId: this.docId,
        sessionId: this.editSessionId,
        baseVersion: this.baseVersion,
        localRevision: this.localRevision,
        title: this.currentTitle,
        content: this.currentContent,
      });
      this.storageFailure = null;
    } catch (error) {
      this.onDraftWriteFailed(error);
    }
  }

  /**
   * 处理一次草稿写入失败。
   *
   * @param {unknown} error
   */
  onDraftWriteFailed(error) {
    const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : 'unknown';
    const message = '本地备份失败';
    this.storageFailure = { reason: String(reason), message };

    this.callbacks.onStorageFailure({
      reason: String(reason),
      message,
      // 内存内容仍在，下载兜底必须可用。
      title: this.currentTitle,
      content: this.currentContent,
    });
  }

  /**
   * 切换文档 / 退出前同步刷新草稿。
   *
   * 顺序约束（INTERFACES §3）：必须**先** flush 待写缓冲，**再**清理草稿，
   * 否则待写缓冲会在清理之后复活旧草稿。
   *
   * @returns {boolean} 是否成功刷新
   */
  flushDraft() {
    if (!this.draftWriter) return true;
    try {
      this.draftWriter.flush();
      return true;
    } catch (error) {
      this.onDraftWriteFailed(error);
      return false;
    }
  }

  /**
   * 调度一次服务端自动保存。
   */
  scheduleSave() {
    if (this.isBlocked()) {
      return;
    }

    if (this.debounceTimer) this.timers.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = null;
      // max-wait 计时器必须**真正取消**，不能只置 null ——
      // 只置 null 会让句柄留在时钟里，到点照样触发一次多余的 flushSave。
      if (this.maxWaitTimer) {
        this.timers.clearTimeout(this.maxWaitTimer);
        this.maxWaitTimer = null;
      }
      this.flushSave();
    }, this.debounceDelay);

    if (!this.maxWaitTimer) {
      this.maxWaitTimer = this.timers.setTimeout(() => {
        this.maxWaitTimer = null;
        if (this.debounceTimer) {
          this.timers.clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
        this.flushSave();
      }, this.maxWaitDelay);
    }
  }

  /**
   * 立即触发保存。
   *
   * 并发控制：同一文档同时最多一个 PUT 在途（§2.2）。
   * 阻塞态下**不发起**任何写请求（§11.3）。
   *
   * @returns {Promise<void>}
   */
  async flushSave() {
    this.clearTimers();

    // 阻塞态：冲突未决 / 认证失效 / 输入非法时不得写（§5、§11.3）。
    if (this.isBlocked()) {
      return;
    }

    // 同一文档已有请求在途：等待其完成后再发最新快照（§2.2）。
    if (this.inFlightByDoc.has(this.docId)) {
      return;
    }

    if (this.localRevision <= this.ackedRevision) {
      this.setState(SyncState.SYNCED, {
        version: this.baseVersion,
        storageOk: this.storageFailure === null,
      });
      return;
    }

    if (!this.token) {
      this.setState(SyncState.AUTH_REQUIRED);
      return;
    }

    const snapshot = this.captureSnapshot();
    this.inFlightByDoc.set(snapshot.docId, snapshot);
    this.setState(SyncState.SAVING, { storageOk: this.storageFailure === null });

    try {
      const resp = await apiFetch(`/documents/${snapshot.docId}`, {
        method: 'PUT',
        token: snapshot.token,
        body: {
          title: snapshot.title,
          content: snapshot.content,
          expected_version: snapshot.expected_version,
        },
        fetchImpl: this.fetchImpl,
        timers: this.timers,
      });

      this.inFlightByDoc.delete(snapshot.docId);

      // §8.2：响应处理前必须先校验它属于当前会话。
      // 世代不匹配说明会话已切换 —— 该响应**只更新所属协调器的内部状态，
      // 不触碰当前 UI**（不得改 baseVersion / ackedRevision / 状态栏 / 编辑器）。
      if (snapshot.generation !== this.generation) {
        this.pendingReconcile.set(snapshot.docId, {
          snapshot,
          reason: 'stale',
          response: resp,
        });
        return;
      }

      // base_version 取服务端响应值，**不得**自行 +1（§4.3）。
      this.baseVersion = resp.version;
      this.ackedRevision = snapshot.savingRevision;
      this.retryAttempt = 0;

      // 仅当会话、版本和内容完全匹配才安全清理草稿（INTERFACES §C9）。
      this.discardOwnDraft(snapshot);

      this.callbacks.onSaveSuccess(resp);

      // §4.2：只有「确认版本覆盖当前修订」且「不存在 conflict/invalid 状态」
      // 才显示"已同步"。否则保持 dirty。
      if (this.localRevision > this.ackedRevision) {
        this.setState(SyncState.DIRTY, {
          localRevision: this.localRevision,
          message: this.storageFailure ? '本地备份失败' : '已在本地备份',
          storageOk: this.storageFailure === null,
        });
        this.scheduleSave();
      } else {
        this.setState(SyncState.SYNCED, {
          version: this.baseVersion,
          localRevision: this.localRevision,
          ackedRevision: this.ackedRevision,
          storageOk: this.storageFailure === null,
        });
      }
    } catch (err) {
      this.inFlightByDoc.delete(snapshot.docId);

      // 旧会话的失败同样不得影响当前会话。
      if (snapshot.generation !== this.generation) {
        this.pendingReconcile.set(snapshot.docId, { snapshot, reason: 'stale-error', error: err });
        return;
      }

      await this.handleSaveError(snapshot, err);
    }
  }

  /**
   * 捕获一次发送快照。
   *
   * **必须**把 `userId` / `docId` / `sessionId` / `generation` 一并快照，
   * 否则响应回来后会用**当前**（可能已切换的）身份去解释旧响应。
   *
   * @returns {object}
   */
  captureSnapshot() {
    return {
      generation: this.generation,
      userId: this.userId,
      docId: this.docId,
      sessionId: this.editSessionId,
      token: this.token,
      title: this.currentTitle,
      content: this.currentContent,
      expected_version: this.baseVersion,
      savingRevision: this.localRevision,
    };
  }

  /**
   * 删除**本会话自己的**草稿（三重核对，见 INTERFACES §C9）。
   *
   * 只删当前会话的键，**不碰**其他会话或其他标签页的草稿。
   *
   * @param {object} snapshot
   */
  discardOwnDraft(snapshot) {
    try {
      const draftKey = drafts.buildDraftKey({
        userId: snapshot.userId,
        docId: snapshot.docId,
        sessionId: snapshot.sessionId,
      });
      // 必须传同一个 storage 适配器 —— 否则注入的存储与实际写入处不是同一个，
      // 会去读默认存储（浏览器里是 localStorage，测试里是内存实现）。
      drafts.discardDraft(
        draftKey,
        {
          sessionId: snapshot.sessionId,
          localRevision: snapshot.savingRevision,
          content: snapshot.content,
        },
        this.storage,
      );
    } catch (error) {
      // 草稿清理失败**不得**影响保存结果，只记录。
      console.warn('草稿清理跳过:', error);
    }
  }

  /**
   * 处理一次保存失败。
   *
   * 分派规则见 SYNC.md §5 与 §6。
   *
   * @param {object} snapshot
   * @param {Error} err
   */
  async handleSaveError(snapshot, err) {
    if (err instanceof VersionConflictError) {
      this.enterConflict(snapshot, err.serverVersion);
    } else if (err instanceof AuthError) {
      // §7.2：401 暂停重试，等用户重新认证。
      this.setState(SyncState.AUTH_REQUIRED, { storageOk: this.storageFailure === null });
    } else if (err instanceof InvalidInputError || err instanceof TooLargeError) {
      // §7.2：400/413 暂停自动重试，等用户修正。
      this.setState(SyncState.INVALID, { error: err.message });
    } else if (err instanceof NotFoundError) {
      // §6 分支 ④：云端文档已不可用。
      this.enterCloudUnavailable(snapshot);
    } else if (err instanceof RateLimitedError) {
      // §7.2：429 遵循响应头 Retry-After，不用退避表。
      //
      // 注意：`api.js` 刻意**保留原始头字符串**（"45"），
      // 解析责任在本层。若直接用 `Number.isFinite(err.retryAfter)` 判断，
      // 字符串会被判为非有限值而退回退避表 —— 于是 1 秒后就重试，
      // **持续违反服务端的限流窗口**。故必须先转成数字。
      const seconds =
        typeof err.retryAfter === 'string'
          ? Number.parseInt(err.retryAfter, 10)
          : Number(err.retryAfter);
      const waitMs =
        Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000
          : this.nextBackoffDelay();
      this.setState(SyncState.RETRY_WAIT, {
        message: '请求过于频繁，稍后重试',
        storageOk: this.storageFailure === null,
      });
      this.scheduleRetry(async () => {
        await this.retryWithSnapshot(snapshot);
      }, waitMs);
    } else {
      // 网络错误 / 超时 / 5xx：**结果未知**，按 §6 四分支先核对云端再处置。
      this.setState(SyncState.RETRY_WAIT, {
        message: '网络中断，已在本地备份，稍后重试',
        storageOk: this.storageFailure === null,
      });
      this.scheduleRetry(async () => {
        await this.reconcile(snapshot);
      }, this.nextBackoffDelay());
    }

    this.callbacks.onError(err);
  }

  /**
   * 进入冲突态（§5、§11）。
   *
   * @param {object} snapshot
   * @param {number} serverVersion
   */
  enterConflict(snapshot, serverVersion) {
    this.setState(SyncState.CONFLICT, {
      serverVersion,
      clientVersion: snapshot.expected_version,
      storageOk: this.storageFailure === null,
    });
    this.callbacks.onConflict({
      serverVersion,
      localTitle: snapshot.title,
      localContent: snapshot.content,
    });
  }

  /**
   * 进入"云端文档不可用"（§6 分支 ④）。
   *
   * @param {object} snapshot
   */
  enterCloudUnavailable(snapshot) {
    this.setState(SyncState.INVALID, {
      error: '云端文档已不可用，可另存为新文档',
      cloudUnavailable: true,
      storageOk: this.storageFailure === null,
    });
    this.callbacks.onCloudUnavailable({
      docId: snapshot.docId,
      localTitle: snapshot.title,
      localContent: snapshot.content,
    });
  }

  /**
   * 计算下一次退避等待时长（§7.1）。
   *
   * 基数取自退避表，另加随机扰动以避免多标签页同步重连形成浪峰。
   *
   * @returns {number} 毫秒
   */
  nextBackoffDelay() {
    const index = Math.min(this.retryAttempt, BACKOFF_LADDER.length - 1);
    const base = BACKOFF_LADDER[index];
    this.retryAttempt += 1;
    const jitter = base * JITTER_RATIO * this.random();
    return Math.round(base + jitter);
  }

  /**
   * 安排一次重试。
   *
   * @param {() => void | Promise<void>} task
   * @param {number} delayMs
   */
  scheduleRetry(task, delayMs) {
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void task();
    }, delayMs);
  }

  /**
   * §6 四分支核对：读取云端记录，判断本次写入到底有没有落库。
   *
   * 这是「结果未知」场景的唯一正确处置 —— 盲重发 PUT 会在
   * 「服务端已提交、响应丢失」时必然产生假冲突（§6.1、§6.3）。
   *
   * @param {object} snapshot
   * @returns {Promise<void>}
   */
  async reconcile(snapshot) {
    // 世代已变：这份核对属于旧会话，不再影响当前会话。
    if (snapshot.generation !== this.generation) {
      this.pendingReconcile.set(snapshot.docId, { snapshot, reason: 'stale-pending' });
      return;
    }

    try {
      const cloud = await apiFetch(`/documents/${snapshot.docId}`, {
        method: 'GET',
        token: snapshot.token,
        fetchImpl: this.fetchImpl,
        timers: this.timers,
      });

      // 分支 ①：云端与快照完全相同 —— 该快照已持久化，采纳读取到的版本。
      if (cloud.title === snapshot.title && cloud.content === snapshot.content) {
        this.baseVersion = cloud.version;
        this.ackedRevision = snapshot.savingRevision;
        this.retryAttempt = 0;
        this.discardOwnDraft(snapshot);

        if (this.localRevision > this.ackedRevision) {
          // 本地又有新编辑 —— 继续保持 dirty（§6.2 分支 ①）。
          this.setState(SyncState.DIRTY, {
            localRevision: this.localRevision,
            message: this.storageFailure ? '本地备份失败' : '已在本地备份',
            storageOk: this.storageFailure === null,
          });
          this.scheduleSave();
        } else {
          this.setState(SyncState.SYNCED, {
            version: this.baseVersion,
            storageOk: this.storageFailure === null,
          });
        }
        return;
      }

      // 分支 ②：云端版本仍等于快照的 base_version —— 用**原** expected_version 重试。
      if (cloud.version === snapshot.expected_version) {
        await this.retryWithSnapshot(snapshot);
        return;
      }

      // 分支 ③：版本已变且内容不同 —— 进入冲突，禁止自动套用新版本覆盖云端。
      this.enterConflict(snapshot, cloud.version);
    } catch (readError) {
      if (readError instanceof NotFoundError) {
        // 分支 ④：云端文档已不可用。
        this.enterCloudUnavailable(snapshot);
        return;
      }
      // §6.5：读取也失败 —— 继续保持未确认状态，按退避表重试读取。
      this.setState(SyncState.RETRY_WAIT, {
        message: '网络中断，已在本地备份，稍后重试',
        storageOk: this.storageFailure === null,
      });
      this.scheduleRetry(async () => {
        await this.reconcile(snapshot);
      }, this.nextBackoffDelay());
    }
  }

  /**
   * 用**原** `expected_version` 重试一次保存（§6.2 分支 ②）。
   *
   * @param {object} snapshot
   * @returns {Promise<void>}
   */
  async retryWithSnapshot(snapshot) {
    if (snapshot.generation !== this.generation) {
      this.pendingReconcile.set(snapshot.docId, { snapshot, reason: 'stale-pending' });
      return;
    }
    if (this.inFlightByDoc.has(snapshot.docId)) {
      return;
    }

    this.inFlightByDoc.set(snapshot.docId, snapshot);
    try {
      const resp = await apiFetch(`/documents/${snapshot.docId}`, {
        method: 'PUT',
        token: snapshot.token,
        body: {
          title: snapshot.title,
          content: snapshot.content,
          expected_version: snapshot.expected_version,
        },
        fetchImpl: this.fetchImpl,
        timers: this.timers,
      });

      this.inFlightByDoc.delete(snapshot.docId);

      if (snapshot.generation !== this.generation) {
        this.pendingReconcile.set(snapshot.docId, { snapshot, reason: 'stale', response: resp });
        return;
      }

      this.baseVersion = resp.version;
      this.ackedRevision = snapshot.savingRevision;
      this.retryAttempt = 0;
      this.discardOwnDraft(snapshot);
      this.callbacks.onSaveSuccess(resp);

      if (this.localRevision > this.ackedRevision) {
        this.setState(SyncState.DIRTY, {
          localRevision: this.localRevision,
          message: this.storageFailure ? '本地备份失败' : '已在本地备份',
          storageOk: this.storageFailure === null,
        });
        this.scheduleSave();
      } else {
        this.setState(SyncState.SYNCED, {
          version: this.baseVersion,
          storageOk: this.storageFailure === null,
        });
      }
    } catch (err) {
      this.inFlightByDoc.delete(snapshot.docId);
      if (snapshot.generation !== this.generation) {
        this.pendingReconcile.set(snapshot.docId, { snapshot, reason: 'stale-error', error: err });
        return;
      }
      await this.handleSaveError(snapshot, err);
    }
  }

  /**
   * 该文档是否还有"结果未知"的请求需要核对。
   *
   * 切回该文档前必须先核对，再建立写入基准（§8.4）。
   *
   * @param {string} docId
   * @returns {boolean}
   */
  hasPending(docId) {
    return this.pendingReconcile.has(docId) || this.inFlightByDoc.has(docId);
  }

  /**
   * 核对该文档所有"结果未知"的请求。
   *
   * @param {string} docId
   * @returns {Promise<void>}
   */
  async reconcilePending(docId) {
    const pending = this.pendingReconcile.get(docId);
    if (pending) {
      this.pendingReconcile.delete(docId);
      await this.reconcile(pending.snapshot);
    }
  }

  /**
   * 冲突解决：覆盖服务端版本（强制采用本地版本）。
   *
   * 这是**用户显式决策**后的动作，因此允许发起写请求（§11.2）。
   *
   * @param {number} serverVersion
   * @returns {Promise<void>}
   */
  async resolveOverwrite(serverVersion) {
    this.baseVersion = serverVersion;
    // 用户已明确选择覆盖，阻塞态解除。
    this.setState(SyncState.DIRTY, {
      message: this.storageFailure ? '本地备份失败' : '已在本地备份',
      storageOk: this.storageFailure === null,
    });
    await this.flushSave();
  }

  /**
   * 冲突解决：丢弃本地草稿，重新载入云端最新版本。
   *
   * **只**删除当前会话自己的草稿（经三重核对），
   * 其他标签页 / 其他会话的草稿一律保留（§9.6、§9.8）。
   *
   * @param {{id: string, title?: string, content?: string, version?: number}} serverDoc
   */
  resolveReload(serverDoc) {
    this.clearTimers();

    // 顺序约束：先刷新待写缓冲，再删除草稿（INTERFACES §3）。
    this.flushDraft();

    try {
      if (this.editSessionId) {
        const draftKey = drafts.buildDraftKey({
          userId: this.userId,
          docId: this.docId,
          sessionId: this.editSessionId,
        });
        // 必须传同一个 storage 适配器 —— 否则注入的存储与实际写入处不是同一个，
        // 会去读默认存储（浏览器里是 localStorage，测试里是内存实现），
        // 清理会落到别处，草稿留在原地（缺口 F-01，由 M6 W5 探针取证）。
        drafts.discardDraft(
          draftKey,
          {
            sessionId: this.editSessionId,
            localRevision: this.localRevision,
            content: this.currentContent,
          },
          this.storage,
        );
      }
    } catch (error) {
      console.warn('丢弃本地草稿失败:', error);
    }

    this.initSession(this.userId, this.token, serverDoc);
  }

  clearTimers() {
    if (this.debounceTimer) this.timers.clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) this.timers.clearTimeout(this.maxWaitTimer);
    if (this.retryTimer) this.timers.clearTimeout(this.retryTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
    this.retryTimer = null;
  }

  /**
   * 销毁引擎：使所有在途响应失效，并清空身份。
   *
   * 退出登录 / 卸载页面时必须调用。世代号自增保证此后到达的旧响应
   * 一律被丢弃，不会修改任何状态（§8.2、M1-03 要求 3）。
   */
  destroy() {
    this.clearTimers();
    // 世代号自增：所有在途响应自此失效。
    this.generation += 1;
    this.inFlightByDoc.clear();
    this.pendingReconcile.clear();

    if (this.draftWriter) {
      try {
        this.draftWriter.cancel();
      } catch {
        // 取消失败不影响销毁。
      }
    }

    this.userId = null;
    this.docId = null;
    this.editSessionId = null;
    this.token = null;
    this.baseVersion = 1;
    this.localRevision = 0;
    this.ackedRevision = 0;
    this.currentTitle = '';
    this.currentContent = '';
    this.retryAttempt = 0;
    this.storageFailure = null;
  }
}
