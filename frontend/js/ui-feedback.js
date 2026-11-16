/**
 * ui-feedback.js —— M5 W4 纯 UI 反馈层（状态徽标 / 存储失败条 / 错误提示 / 冲突选择弹窗）
 *
 * 职责边界（docs/ARCHITECTURE.md §3、docs/SYNC.md §11.3）：
 *  - 只接收上层（M1 同步控制器）传入的状态与错误，把结果渲染到现有 DOM；
 *  - 只把用户在弹窗里做出的选择上抛给上层，自身不持有第二份文档版本、token 或草稿状态；
 *  - 不读取编辑器内容、不发网络请求、不自增 expected_version、不清空草稿、不替换编辑器文本；
 *  - 所有面向用户的文本一律通过 textContent 写入，禁止用 innerHTML 拼接用户或服务端文本。
 *
 * 真实保存、版本推进、草稿清理、冲突后的提交仍由 M1（sync.js / api.js / drafts.js）持有。
 */

/** 与 sync.js SyncState 对齐的七状态字面量（此处仅作 UI 文案映射，不复制状态机）。 */
export const SyncState = {
  SYNCED: 'synced',
  DIRTY: 'dirty',
  SAVING: 'saving',
  RETRY_WAIT: 'retry_wait',
  AUTH_REQUIRED: 'auth_required',
  CONFLICT: 'conflict',
  INVALID: 'invalid',
};

/** 冲突选择上抛的取值（docs/SYNC.md §11.1 四选项 + 取消）。 */
export const ConflictChoice = {
  VIEW_CLOUD: 'view_cloud',
  ADOPT_CLOUD: 'adopt_cloud',
  SAVE_COPY: 'save_copy',
  MANUAL_MERGE: 'manual_merge',
  CANCEL: 'cancel',
};

/** 本地备份失败分类（docs/INTERFACES.md §2.5）。 */
export const StorageFailureReason = {
  QUOTA: 'quota',
  UNAVAILABLE: 'unavailable',
  CORRUPT: 'corrupt',
  SERIALIZE: 'serialize',
};

/**
 * 四种 reason 对应的冻结中文文案，逐字对齐 INTERFACES §2.5 / drafts.js messageFor。
 * 禁止把浏览器原始 e.message（如 "The operation is insecure."）透出到界面。
 */
export const STORAGE_FAILURE_TEXT = {
  [StorageFailureReason.QUOTA]: '本地备份失败：存储空间不足',
  [StorageFailureReason.UNAVAILABLE]: '本地备份失败：浏览器禁止本地存储',
  [StorageFailureReason.CORRUPT]: '本地备份已损坏，已忽略',
  [StorageFailureReason.SERIALIZE]: '本地备份失败：内容无法序列化',
};

/**
 * 七状态 → 徽标样式类 / 徽标文案 / 状态栏文案。
 * 文案口径（docs/SYNC.md §4.4 禁令）：
 *  - dirty 只说“已在本地备份”，不得出现“已同步 / 保存成功 / 已保存”；
 *  - saving 只表达进行中，不得说已同步；
 *  - synced 仅由上层在 §4.2 三条件全部成立时驱动，本层不做成功判定。
 */
const SYNC_STATE_META = {
  [SyncState.SYNCED]: {
    badgeClass: 'badge-synced',
    badgeText: '✓ 已同步',
    statusText: '所有更改已同步至云端',
  },
  [SyncState.DIRTY]: {
    badgeClass: 'badge-dirty',
    badgeText: '• 本地已备份',
    statusText: '已在本地备份',
  },
  [SyncState.SAVING]: {
    badgeClass: 'badge-saving',
    badgeText: '⏳ 保存中…',
    statusText: '正在与云端同步…',
  },
  [SyncState.RETRY_WAIT]: {
    badgeClass: 'badge-retry',
    badgeText: '⚠️ 等待重试',
    statusText: '网络异常，已在本地备份，稍后重试',
  },
  [SyncState.AUTH_REQUIRED]: {
    badgeClass: 'badge-auth',
    badgeText: '🔒 需要登录',
    statusText: '登录已失效，草稿已在本地备份，请重新登录',
  },
  [SyncState.CONFLICT]: {
    badgeClass: 'badge-conflict',
    badgeText: '✕ 版本冲突',
    statusText: '云端存在不同版本，请选择处理方式',
  },
  [SyncState.INVALID]: {
    badgeClass: 'badge-invalid',
    badgeText: '✕ 校验错误',
    statusText: '标题或正文不符合要求，请检查后再提交',
  },
};

/**
 * 计算某个状态的展示元数据（纯函数，便于单测）。
 * @param {string} state 七状态之一
 * @param {{message?: string, error?: string}} [payload] 上层回调载荷
 * @returns {{badgeClass: string, badgeText: string, statusText: string}}
 */
export function stateMeta(state, payload = {}) {
  const meta = SYNC_STATE_META[state];
  if (!meta) {
    return {
      badgeClass: 'badge-invalid',
      badgeText: '✕ 状态未知',
      statusText: '当前同步状态未知',
    };
  }

  let statusText = meta.statusText;
  if (state === SyncState.DIRTY && typeof payload.message === 'string' && payload.message) {
    statusText = payload.message;
  } else if (state === SyncState.RETRY_WAIT && typeof payload.message === 'string' && payload.message) {
    statusText = payload.message;
  } else if (state === SyncState.INVALID && typeof payload.error === 'string' && payload.error) {
    // invalid 仅展示上层给出的结构化错误说明；原始异常英文不由此层拼接。
    statusText = payload.error;
  }

  return { badgeClass: meta.badgeClass, badgeText: meta.badgeText, statusText };
}

/**
 * 返回存储失败 reason 对应的冻结文案（纯函数）。
 * 未知 reason 回落通用兜底文案，绝不透出原始异常 message。
 * @param {string} reason
 * @returns {string}
 */
export function storageFailureText(reason) {
  return STORAGE_FAILURE_TEXT[reason] ?? '本地备份失败，请下载当前内容以避免丢失';
}

/**
 * 把 API 错误归类为面向用户的中文提示（纯函数）。
 * 按 error.code / error.status 分支，不按 error.message 分支（对齐 api.js 契约）。
 * @param {{code?: string|null, status?: number|null, retryAfter?: string|null, message?: string}} [error]
 * @returns {{kind: string, text: string}}
 */
export function errorNotice(error = {}) {
  const code = error && typeof error.code === 'string' ? error.code : null;
  const status = typeof error.status === 'number' ? error.status : null;

  if (code === 'UNAUTHORIZED' || status === 401) {
    return { kind: 'auth', text: '登录已失效，请重新登录' };
  }
  if (code === 'BAD_REQUEST' || status === 400) {
    return { kind: 'invalid', text: '标题或正文不符合要求，请检查后再提交' };
  }
  if (code === 'PAYLOAD_TOO_LARGE' || status === 413) {
    return { kind: 'invalid', text: '正文超出大小限制，请精简后再提交' };
  }
  if (code === 'RATE_LIMITED' || status === 429) {
    const retryAfter = normalizeRetryAfter(error && error.retryAfter);
    if (retryAfter !== null) {
      return { kind: 'retry', text: `请求过于频繁，请 ${retryAfter} 秒后重试` };
    }
    return { kind: 'retry', text: '请求过于频繁，请稍后重试' };
  }
  if (code === 'NOT_FOUND' || status === 404) {
    return { kind: 'not_found', text: '云端文档已不可用，可将本地内容另存为新文档' };
  }
  if (
    code === 'SERVICE_UNAVAILABLE' ||
    code === 'INTERNAL_ERROR' ||
    code === 'TIMEOUT' ||
    code === 'NETWORK' ||
    (status !== null && status >= 500) ||
    status === 0
  ) {
    return { kind: 'retry', text: '网络异常或服务暂不可用，稍后将自动重试' };
  }
  return { kind: 'unknown', text: '操作未成功，请稍后重试' };
}

/** 解析 Retry-After：仅接受非负整数秒；非法值返回 null，文案不带秒数。 */
function normalizeRetryAfter(retryAfter) {
  if (retryAfter === null || retryAfter === undefined) return null;
  const n = Number(retryAfter);
  if (Number.isFinite(n) && n >= 0) return String(Math.floor(n));
  return null;
}

/**
 * 创建 UI 反馈控制器。
 *
 * @param {object} elements 已存在的 DOM 元素引用（缺失的元素对应功能静默跳过，不抛空引用）。
 * @param {object} [elements.syncBadge] 同步状态徽标
 * @param {object} [elements.statusText] 底部状态栏
 * @param {object} [elements.storageBanner] 存储失败提示条容器
 * @param {object} [elements.storageMessage] 存储失败文案节点
 * @param {object} [elements.storageDownloadBtn] 下载当前 Markdown 按钮
 * @param {object} [elements.conflictModal] 冲突弹窗遮罩
 * @param {object} [elements.serverVersionText] 云端版本号节点
 * @param {object} [elements.localVersionText] 本地基准版本号节点
 * @param {object} [elements.cloudVersionText] 云端只读内容节点
 * @param {object} [elements.btnViewCloud] 查看云端版本按钮
 * @param {object} [elements.btnAdoptCloud] 采用云端版本按钮
 * @param {object} [elements.btnSaveCopy] 另存为副本按钮
 * @param {object} [elements.btnManualMerge] 手动合并按钮
 * @param {object} [elements.btnConflictCancel] 取消按钮
 * @param {object} [callbacks] 上抛回调（由 M1 接线）
 * @param {(choice: string, meta: object) => void} [callbacks.onConflictChoice] 用户做出冲突选择
 * @param {() => void} [callbacks.onDownloadDraft] 用户点击下载当前内容
 */
export function createUiFeedback(elements = {}, callbacks = {}) {
  const onConflictChoice =
    typeof callbacks.onConflictChoice === 'function' ? callbacks.onConflictChoice : () => {};
  const onDownloadDraft =
    typeof callbacks.onDownloadDraft === 'function' ? callbacks.onDownloadDraft : () => {};

  // 缓存冲突上下文，仅用于回传给上层；本层不据此改写编辑器或版本。
  let conflictContext = null;
  // 缓存待下载快照，仅用于下载回调读取；本层不读取、不清空编辑器。
  let downloadSnapshot = null;

  const listeners = [];

  function bindClick(el, handler) {
    if (!el || typeof el.addEventListener !== 'function') return;
    const listener = () => handler();
    el.addEventListener('click', listener);
    listeners.push({ el, listener });
  }

  /** 渲染七状态徽标与状态栏。 */
  function renderSyncState(state, payload = {}) {
    const meta = stateMeta(state, payload);
    if (elements.syncBadge) {
      elements.syncBadge.className = `sync-badge ${meta.badgeClass}`;
      elements.syncBadge.textContent = meta.badgeText;
    }
    if (elements.statusText) {
      elements.statusText.textContent = meta.statusText;
    }
  }

  /**
   * 展示本地备份失败条：冻结文案 + 下载入口；内存内容保留，不清空编辑器。
   * @param {string} reason 存储失败分类
   * @param {{title?: string, content?: string}} [snapshot] 当前内存内容快照（供下载回调使用）
   */
  function showStorageFailure(reason, snapshot = {}) {
    const hasSnapshot =
      typeof snapshot.title === "string" || typeof snapshot.content === "string";
    downloadSnapshot = hasSnapshot
      ? {
          title: typeof snapshot.title === "string" ? snapshot.title : "",
          content: typeof snapshot.content === "string" ? snapshot.content : "",
        }
      : null;
    if (elements.storageMessage) {
      elements.storageMessage.textContent = storageFailureText(reason);
    }
    if (elements.storageBanner) {
      elements.storageBanner.classList.remove("hidden");
    }
  }

  function hideStorageFailure() {
    downloadSnapshot = null;
    if (elements.storageBanner) {
      elements.storageBanner.classList.add('hidden');
    }
  }

  /**
   * 打开冲突弹窗：只读展示云端版本与本地基准版本，不替换本地编辑区。
   * @param {{serverVersion?: number|string, localVersion?: number|string, cloudContent?: string}} data
   */
  function showConflict(data = {}) {
    conflictContext = {
      serverVersion: data.serverVersion ?? null,
      localVersion: data.localVersion ?? null,
      cloudContent: typeof data.cloudContent === 'string' ? data.cloudContent : '',
      localTitle: typeof data.localTitle === 'string' ? data.localTitle : '',
      localContent: typeof data.localContent === 'string' ? data.localContent : '',
    };

    if (elements.serverVersionText) {
      elements.serverVersionText.textContent =
        conflictContext.serverVersion === null ? '-' : `v${conflictContext.serverVersion}`;
    }
    if (elements.localVersionText) {
      elements.localVersionText.textContent =
        conflictContext.localVersion === null ? '-' : `v${conflictContext.localVersion}`;
    }
    if (elements.cloudVersionText) {
      elements.cloudVersionText.textContent = conflictContext.cloudContent;
    }
    if (elements.conflictModal) {
      elements.conflictModal.classList.remove('hidden');
    }
  }

  function hideConflict() {
    if (elements.conflictModal) {
      elements.conflictModal.classList.add('hidden');
    }
  }

  function choose(choice) {
    // 只上抛选择与上下文；是否重载、覆盖、另存、清理草稿由上层决策执行。
    onConflictChoice(choice, conflictContext ? { ...conflictContext } : {});
  }

  bindClick(elements.btnViewCloud, () => choose(ConflictChoice.VIEW_CLOUD));
  bindClick(elements.btnAdoptCloud, () => choose(ConflictChoice.ADOPT_CLOUD));
  bindClick(elements.btnSaveCopy, () => choose(ConflictChoice.SAVE_COPY));
  bindClick(elements.btnManualMerge, () => choose(ConflictChoice.MANUAL_MERGE));
  bindClick(elements.btnConflictCancel, () => {
    // 取消：保持当前内容，仅关闭弹窗，不发出覆盖/重载/清理草稿动作。
    choose(ConflictChoice.CANCEL);
    hideConflict();
  });
  bindClick(elements.storageDownloadBtn, () => {
    onDownloadDraft(downloadSnapshot ? { ...downloadSnapshot } : null);
  });

  /** 取当前缓存的待下载快照（供上层生成 Markdown 文件，本层不触碰编辑器）。 */
  function getDownloadSnapshot() {
    return downloadSnapshot ? { ...downloadSnapshot } : null;
  }

  /** 移除本控制器绑定的全部按钮监听。 */
  function destroy() {
    for (const { el, listener } of listeners) {
      if (el && typeof el.removeEventListener === 'function') {
        el.removeEventListener('click', listener);
      }
    }
    listeners.length = 0;
    conflictContext = null;
    downloadSnapshot = null;
  }

  return {
    renderSyncState,
    showStorageFailure,
    hideStorageFailure,
    showConflict,
    hideConflict,
    getDownloadSnapshot,
    destroy,
  };
}
