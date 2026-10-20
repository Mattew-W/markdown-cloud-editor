/**
 * drafts.js —— 本地草稿层（正式模块草案）
 *
 * 项目：Web-based Markdown Editor with Cloud Sync
 * 位置：frontend/js/drafts.js
 * 规范：GPT_WORKSPACE/specs/Markdown云同步编辑器项目规范.md §08「自动保存与草稿恢复」
 * 契约：GPT_WORKSPACE/proposals/M6-drafts-interface.md（C1–C6）
 *
 * ── 设计原则 ──────────────────────────────────────────────
 * 1. 零 DOM。本模块不引用 document / window / textarea，
 *    全部通过参数接收外部输入，便于 Node 内置测试直接验证（规范 §05:217、§11:435）。
 * 2. 存储可注入。所有存储访问经注入的 storage 对象（默认 window.localStorage），
 *    使测试能可靠模拟「存储禁用 / 配额耗尽 / 值损坏」三种情形（契约 C5）。
 * 3. 身份不内置。userId 一律由调用方传入，本模块不读 token、
 *    不持有全局身份副本，避免与 auth.js 产生第二份来源（规范 §05:217）。
 * 4. 错误不外泄。统一抛 DraftStorageError，用 reason 区分原因，
 *    禁止把 e.message 直接透给用户（契约 C6）。
 * 5. 草稿是兜底，不是主路径。本模块的任何成功返回都不代表云端已保存，
 *    调用方不得据此改变 synced / dirty 状态判定（规范 §08:349）。
 *
 * ── 与 W1 练习稿的差异 ────────────────────────────────────
 * W1 稿：单键 markdown-editor-demo:M6:W1、只存 {content, savedAt}、直接操作 DOM。
 * 本模块：三元组键、五字段记录、零 DOM、可注入存储、统一错误类型。
 *
 * @module js/drafts
 */

// ── 常量 ────────────────────────────────────────────────────

/** 草稿键前缀。正式项目统一使用此前缀，禁止沿用 demo 键。 */
export const DRAFT_KEY_PREFIX = "markdown-editor:draft";

/** 草稿合并写入间隔（毫秒）。规范 §08:376 要求约 250ms 合并写入。 */
export const MERGE_WRITE_DELAY_MS = 250;

/** 单条草稿正文的存储上限，与后端正文上限保持一致（规范 §06:229，262144 字节）。 */
export const MAX_CONTENT_BYTES = 262144;

/** 草稿记录字段名。规范 §08:376。 */
const FIELDS = Object.freeze({
  USER_ID: "user_id",
  DOC_ID: "doc_id",
  EDIT_SESSION_ID: "edit_session_id",
  BASE_VERSION: "base_version",
  TITLE: "title",
  CONTENT: "content",
  LOCAL_REVISION: "local_revision",
  RECORDED_AT: "recorded_at",
});

// ── 错误类型 ────────────────────────────────────────────────

/**
 * 草稿存储错误。
 * reason 取值：
 *   'quota'      存储空间不足
 *   'unavailable' 存储不可用（隐私模式、file 协议、策略禁用）
 *   'corrupt'    已存值结构损坏
 *   'serialize'  序列化失败
 *   'invalid'    输入不符合草稿记录约定
 */
export class DraftStorageError extends Error {
  /**
   * @param {'quota'|'unavailable'|'corrupt'|'serialize'|'invalid'} reason 机器可读原因
   * @param {string} userMessage 面向用户的中文提示，可直接显示
   * @param {unknown} [cause] 原始异常，仅供日志，不透给用户
   */
  constructor(reason, userMessage, cause) {
    super(userMessage);
    this.name = "DraftStorageError";
    this.reason = reason;
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

/** 把浏览器原生存储异常归类为 DraftStorageError。 */
function classifyStorageError(error) {
  const name = error && error.name;

  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return new DraftStorageError("quota", "本地备份失败：浏览器存储空间不足", error);
  }
  if (name === "SecurityError" || name === "NotAllowedError") {
    return new DraftStorageError("unavailable", "本地备份失败：浏览器本地存储不可用", error);
  }
  return new DraftStorageError("unavailable", "本地备份失败：本地存储访问出错", error);
}

/** 把未知异常包装为 DraftStorageError，保证对外错误形态统一。 */
function toDraftError(error, fallbackReason = "unavailable") {
  if (error instanceof DraftStorageError) return error;
  return new DraftStorageError(
    fallbackReason,
    fallbackReason === "serialize" ? "本地备份失败：内容无法序列化" : "本地备份失败：本地存储访问出错",
    error
  );
}

// ── 内部工具 ────────────────────────────────────────────────

/**
 * 取得默认存储对象。
 * @returns {Storage|null} window.localStorage；不可用时返回 null
 */
function defaultStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    // 某些隐私模式下访问 window.localStorage 本身就抛 SecurityError
    return null;
  }
}

/**
 * 对键的分段做转义，避免分隔符歧义。
 * UUID 本身不含 ':'，但转义是廉价的保险。
 */
function escapeSegment(value) {
  return encodeURIComponent(String(value));
}

/** 反解键分段。 */
function unescapeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 计算 UTF-8 字节数。 */
export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * 校验一条草稿记录是否结构完整。
 * @param {unknown} record
 * @returns {boolean}
 */
export function isValidDraftRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (typeof record[FIELDS.USER_ID] !== "string" || !record[FIELDS.USER_ID]) return false;
  if (typeof record[FIELDS.DOC_ID] !== "string" || !record[FIELDS.DOC_ID]) return false;
  if (typeof record[FIELDS.EDIT_SESSION_ID] !== "string" || !record[FIELDS.EDIT_SESSION_ID]) return false;
  if (!Number.isInteger(record[FIELDS.BASE_VERSION]) || record[FIELDS.BASE_VERSION] < 1) return false;
  if (typeof record[FIELDS.TITLE] !== "string") return false;
  if (typeof record[FIELDS.CONTENT] !== "string") return false;
  if (!Number.isInteger(record[FIELDS.LOCAL_REVISION]) || record[FIELDS.LOCAL_REVISION] < 0) return false;
  if (typeof record[FIELDS.RECORDED_AT] !== "string" || Number.isNaN(Date.parse(record[FIELDS.RECORDED_AT]))) {
    return false;
  }
  return true;
}

// ── 会话与键 ────────────────────────────────────────────────

/**
 * 生成编辑会话 ID。
 *
 * 作用域＝一次文档打开会话。切换文档必须重新生成。
 * 不得跨用户或跨标签页复用。仅存于草稿键与内存会话状态，不落库。
 *
 * @returns {string}
 */
export function createEditSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 兜底：极端环境没有 randomUUID
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 构造草稿存储键。
 *
 * 格式：markdown-editor:draft:{userId}:{docId}:{sessionId}
 *
 * @param {{userId: string, docId: string, sessionId: string}} parts
 * @returns {string}
 * @throws {DraftStorageError} reason='invalid' 当任一段缺失
 */
export function buildDraftKey({ userId, docId, sessionId } = {}) {
  if (!userId || !docId || !sessionId) {
    throw new DraftStorageError("invalid", "草稿标识不完整，无法生成存储键");
  }
  return [DRAFT_KEY_PREFIX, escapeSegment(userId), escapeSegment(docId), escapeSegment(sessionId)].join(":");
}

/**
 * 解析草稿键。
 * @param {string} key
 * @returns {{userId: string, docId: string, sessionId: string}|null} 非草稿键返回 null
 */
export function parseDraftKey(key) {
  if (typeof key !== "string" || !key.startsWith(`${DRAFT_KEY_PREFIX}:`)) return null;
  const rest = key.slice(DRAFT_KEY_PREFIX.length + 1);
  const parts = rest.split(":");
  if (parts.length !== 3) return null;
  const [userId, docId, sessionId] = parts.map(unescapeSegment);
  if (!userId || !docId || !sessionId) return null;
  return { userId, docId, sessionId };
}

/**
 * 判断某个键是否属于草稿。
 * @param {string} key
 * @returns {boolean}
 */
export function isDraftKey(key) {
  return parseDraftKey(key) !== null;
}

// ── 草稿存取 ────────────────────────────────────────────────

/**
 * 读取单条草稿。
 *
 * @param {string} key 草稿键
 * @param {{storage?: Storage}} [options]
 * @returns {{status: 'ok', record: object} | {status: 'missing'} | {status: 'corrupt', error: DraftStorageError}}
 */
export function readDraft(key, { storage = defaultStorage() } = {}) {
  if (!storage) {
    return {
      status: "corrupt",
      error: new DraftStorageError("unavailable", "本地备份失败：浏览器本地存储不可用"),
    };
  }

  let raw;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    return { status: "corrupt", error: classifyStorageError(error) };
  }

  if (raw === null || raw === undefined) {
    return { status: "missing" };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "corrupt", error: new DraftStorageError("corrupt", "草稿内容格式损坏，无法读取", error) };
  }

  if (!isValidDraftRecord(parsed)) {
    return {
      status: "corrupt",
      error: new DraftStorageError("corrupt", "草稿内容格式损坏，无法读取"),
    };
  }

  return { status: "ok", record: parsed };
}

/**
 * 写入一条草稿。
 *
 * 注意：写入成功只代表本地已备份，不代表云端已保存（规范 §08:349）。
 *
 * @param {object} record 草稿记录，须含全部八个字段
 * @param {{storage?: Storage, now?: () => Date}} [options]
 * @returns {object} 实际写入的记录
 * @throws {DraftStorageError}
 */
export function saveDraft(record, { storage = defaultStorage(), now = () => new Date() } = {}) {
  if (!storage) {
    throw new DraftStorageError("unavailable", "本地备份失败：浏览器本地存储不可用");
  }

  const stamped = {
    ...record,
    [FIELDS.RECORDED_AT]: now().toISOString(),
  };

  if (!isValidDraftRecord(stamped)) {
    throw new DraftStorageError("invalid", "草稿记录不完整，无法保存");
  }

  if (byteLength(stamped[FIELDS.CONTENT]) > MAX_CONTENT_BYTES) {
    throw new DraftStorageError("invalid", "草稿内容超出单篇上限，无法保存");
  }

  const key = buildDraftKey({
    userId: stamped[FIELDS.USER_ID],
    docId: stamped[FIELDS.DOC_ID],
    sessionId: stamped[FIELDS.EDIT_SESSION_ID],
  });

  let serialized;
  try {
    serialized = JSON.stringify(stamped);
  } catch (error) {
    throw toDraftError(error, "serialize");
  }

  try {
    storage.setItem(key, serialized);
  } catch (error) {
    throw classifyStorageError(error);
  }

  return stamped;
}

/**
 * 列出某账号某文档的全部遗留草稿。
 *
 * 规范 §08:374 要求重新打开文档时枚举遗留草稿供用户选择恢复。
 * 不同账号、不同文档的草稿互相不可见。
 *
 * @param {{userId: string, docId?: string}} query
 * @param {{storage?: Storage}} [options]
 * @returns {{records: object[], corrupt: number}} corrupt 为损坏项数量
 */
export function listDrafts({ userId, docId } = {}, { storage = defaultStorage() } = {}) {
  const result = { records: [], corrupt: 0 };
  if (!userId) return result;
  if (!storage) {
    throw new DraftStorageError("unavailable", "本地备份失败：浏览器本地存储不可用");
  }

  let keys;
  try {
    keys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k !== null && k !== undefined) keys.push(k);
    }
  } catch (error) {
    throw classifyStorageError(error);
  }

  for (const key of keys) {
    const parsed = parseDraftKey(key);
    if (!parsed) continue;
    if (parsed.userId !== userId) continue;
    if (docId !== undefined && parsed.docId !== docId) continue;

    const read = readDraft(key, { storage });
    if (read.status === "ok") {
      result.records.push(read.record);
    } else if (read.status === "corrupt") {
      if (read.error?.reason === "unavailable") throw read.error;
      result.corrupt += 1;
    }
  }

  // 按记录时间倒序，最近的在前；同时间按会话 ID 排序保证稳定
  result.records.sort((a, b) => {
    const diff = Date.parse(b[FIELDS.RECORDED_AT]) - Date.parse(a[FIELDS.RECORDED_AT]);
    if (diff !== 0) return diff;
    return a[FIELDS.EDIT_SESSION_ID].localeCompare(b[FIELDS.EDIT_SESSION_ID]);
  });

  return result;
}

/**
 * 丢弃一条草稿。
 *
 * 规范 §08:376 要求清理前核对会话、修订号和内容，
 * 防止删除保存期间刚产生的新修改。
 *
 * @param {string} key
 * @param {{sessionId?: string, localRevision?: number, content?: string}} guard 核对条件
 * @param {{storage?: Storage}} [options]
 * @returns {{status: 'discarded'|'missing'|'mismatch', reason?: string}}
 */
export function discardDraft(key, guard = {}, { storage = defaultStorage() } = {}) {
  const read = readDraft(key, { storage });
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "corrupt") {
    if (read.error?.reason === "unavailable") throw read.error;
    return { status: "mismatch", reason: "corrupt" };
  }

  const record = read.record;

  // Three values are required: partial guards must never authorize deletion.
  if (
    !guard ||
    typeof guard !== "object" ||
    typeof guard.sessionId !== "string" ||
    guard.sessionId.length === 0 ||
    !Number.isInteger(guard.localRevision) ||
    typeof guard.content !== "string"
  ) {
    return { status: "mismatch", reason: "guard" };
  }

  if (record[FIELDS.EDIT_SESSION_ID] !== guard.sessionId) {
    return { status: "mismatch", reason: "session" };
  }
  if (record[FIELDS.LOCAL_REVISION] !== guard.localRevision) {
    return { status: "mismatch", reason: "revision" };
  }
  if (record[FIELDS.CONTENT] !== guard.content) {
    return { status: "mismatch", reason: "content" };
  }

  try {
    storage.removeItem(key);
  } catch (error) {
    throw classifyStorageError(error);
  }
  return { status: "discarded" };
}

/**
 * 清除调用方明确确认安全删除的会话草稿。
 *
 * 规范 §08:380：首版退出只清理当前标签页 token，
 * 并清理当前会话已同步或被用户明确丢弃的草稿，
 * 不能自动删除其他窗口未同步内容。
 * 调用方只应把已同步或被用户明确丢弃的草稿传入 safeDrafts，
 * 并提供每条记录当前的修订号和内容；本函数逐条执行三重核对。
 *
 * @param {string} sessionId
 * @param {{userId: string, safeDrafts?: Array<{docId: string, localRevision: number, content: string}>}} query
 * @param {{storage?: Storage}} [options]
 * @returns {number} 实际清除的条数
 */
export function clearSessionDrafts(sessionId, { userId, safeDrafts = [] } = {}, { storage = defaultStorage() } = {}) {
  if (!storage || !sessionId || !userId || !Array.isArray(safeDrafts)) return 0;
  let cleared = 0;
  for (const safeDraft of safeDrafts) {
    if (!safeDraft || typeof safeDraft.docId !== "string" || !safeDraft.docId) continue;
    const key = buildDraftKey({ userId, docId: safeDraft.docId, sessionId });
    const result = discardDraft(
      key,
      { sessionId, localRevision: safeDraft.localRevision, content: safeDraft.content },
      { storage }
    );
    if (result.status === "discarded") cleared += 1;
  }
  return cleared;
}

// ── 合并写入调度 ────────────────────────────────────────────

/**
 * 创建一个草稿写入调度器。
 *
 * 规范 §08:376：按约 250 毫秒合并写入，切换文档前同步尝试刷新。
 * 连续编辑时只有最后一次内容落盘，避免高频写存储。
 *
 * 调度器不直接操作 DOM，flush 由调用方在切换文档前显式触发。
 *
 * @param {{storage?: Storage, now?: () => Date, delay?: number, setTimeout?: Function, clearTimeout?: Function, onError?: (error: DraftStorageError, record: object) => void}} [options]
 * @returns {{schedule: Function, flush: Function, flushAll: Function, cancel: Function, pending: Function}}
 */
export function createDraftWriter({
  storage = defaultStorage(),
  now = () => new Date(),
  delay = MERGE_WRITE_DELAY_MS,
  setTimeout: setTimer = typeof setTimeout === "function" ? setTimeout : undefined,
  clearTimeout: clearTimer = typeof clearTimeout === "function" ? clearTimeout : undefined,
  onError,
} = {}) {
  /** @type {Map<string, {record: object, timer: any}>} */
  const pending = new Map();

  function writeNow(record) {
    return saveDraft(record, { storage, now });
  }

  function schedule(record) {
    const key = buildDraftKey({
      userId: record[FIELDS.USER_ID],
      docId: record[FIELDS.DOC_ID],
      sessionId: record[FIELDS.EDIT_SESSION_ID],
    });

    const existing = pending.get(key);
    if (existing && clearTimer) clearTimer(existing.timer);

    // 合并：只保留最新记录，计时器重置
    pending.set(key, { record, timer: null });

    if (setTimer) {
      const timer = setTimer(() => {
        const entry = pending.get(key);
        if (!entry) return;
        entry.timer = null;
        try {
          writeNow(entry.record);
          pending.delete(key);
        } catch (error) {
          // 保留失败项供调用方检查或重试；异步错误通过回调报告。
          if (onError) onError(error, entry.record);
          else throw error;
        }
      }, delay);
      pending.get(key).timer = timer;
    }

    return key;
  }

  /** 立即落盘某键的待写内容。 */
  function flush(key) {
    const entry = pending.get(key);
    if (!entry) return false;
    if (entry.timer && clearTimer) clearTimer(entry.timer);
    entry.timer = null;
    writeNow(entry.record);
    pending.delete(key);
    return true;
  }

  /** 立即落盘全部待写内容。切换文档前调用。 */
  function flushAll() {
    const keys = [...pending.keys()];
    const written = [];
    for (const key of keys) {
      if (flush(key)) written.push(key);
    }
    return written;
  }

  /** 取消待写内容，不落盘。 */
  function cancel(key) {
    const entry = pending.get(key);
    if (!entry) return false;
    if (entry.timer && clearTimer) clearTimer(entry.timer);
    pending.delete(key);
    return true;
  }

  function pendingKeys() {
    return [...pending.keys()];
  }

  return { schedule, flush, flushAll, cancel, pending: pendingKeys };
}

// ── 恢复判定 ────────────────────────────────────────────────

/**
 * 判定草稿与云端内容的关系。
 *
 * 规范 §08:378：
 *   1. 标题和内容均与云端相同则无需恢复；
 *   2. 云端版本等于草稿 base_version 则在用户确认后继续保存；
 *   3. 云端版本不同且内容不同则进入 conflict。
 *
 * 禁止为旧草稿直接替换成最新 base_version 后自动提交。
 *
 * @param {object} draft 草稿记录
 * @param {{version: number, title: string, content: string}|null} cloud 云端状态；null 表示读取失败或不可用
 * @returns {'identical'|'confirm'|'conflict'|'unavailable'}
 */
export function classifyRestore(draft, cloud) {
  if (!isValidDraftRecord(draft)) return "conflict";
  if (
    !cloud ||
    typeof cloud.version !== "number" ||
    typeof cloud.title !== "string" ||
    typeof cloud.content !== "string"
  ) {
    return "unavailable";
  }
  if (cloud.title === draft[FIELDS.TITLE] && cloud.content === draft[FIELDS.CONTENT]) return "identical";
  if (cloud.version === draft[FIELDS.BASE_VERSION]) return "confirm";
  return "conflict";
}
