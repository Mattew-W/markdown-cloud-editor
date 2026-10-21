/**
 * drafts.js —— 本机草稿存储层（M6 W2 正式实现）
 *
 * 契约来源：`docs/INTERFACES.md` §2–§3（已冻结，2026-10-20）+ `docs/SYNC.md` §9。
 * 本文严格按冻结签名实现，冻结清单外的导出**一律不提供**。
 *
 * ## 六条硬约束（违反即返工，见 INTERFACES.md §2.2）
 *
 * 1. **零 DOM** —— 不读写任何 DOM 节点，不绑定任何事件；
 * 2. **`userId` 由调用方传入** —— 模块不自行推断当前用户；
 * 3. **不自行读 token** —— 模块连 `sessionStorage` 都不直接访问；
 * 4. **所有存储访问经注入的 `storage` 适配器**；
 * 5. **ES Module 且有具名 export**；
 * 6. **错误文案一律中文**，禁止透出 `e.message`。
 *
 * ## ⚠️ 文案禁令（SYNC.md §4.4，强约束）
 *
 * **本地备份成功不能显示成云端保存成功。**
 * 草稿写入成功后调用方**只能**显示"已在本地备份"，
 * **禁止**显示"已同步""保存成功""已保存"，
 * 且**不得**因此改变 `synced` / `dirty` 判定——草稿是兜底，自动保存才是主路径。
 *
 * 这不是措辞洁癖：用户对"我的内容安全吗"的判断完全依赖状态栏文案。
 * 把本地备份说成云端保存，会让用户在没真正上云的情况下关闭浏览器并丢失内容。
 *
 * ## 落盘形态（INTERFACES.md §3 C1）
 *
 * 落盘字段用 **snake_case**（与后端 API 一致），函数入参用 **camelCase**（JS 惯例）。
 * 转换在 {@link saveDraft} / {@link readDraft} 内部完成，调用方不需要关心。
 *
 * @module drafts
 */

/** 草稿键前缀。枚举时按此前缀扫描，避免遍历全部 localStorage。 */
export const DRAFT_KEY_PREFIX = 'markdown-editor:draft:';

/** 合并写入窗口（毫秒）。约 250 毫秒内的连续输入合并为一次写入。 */
export const MERGE_WINDOW_MS = 250;

/**
 * 草稿存储错误。
 *
 * `reason` 决定面向用户的中文文案。**禁止**把原始 `e.message` 放进 message——
 * 那会显示浏览器英文原文（如 "The operation is insecure."）。
 */
export class DraftStorageError extends Error {
  /**
   * @param {'quota'|'unavailable'|'corrupt'|'serialize'} reason 错误分类
   * @param {string} [detail] 内部细节，仅供日志，**不得展示给用户**
   */
  constructor(reason, detail) {
    super(DraftStorageError.messageFor(reason));
    this.name = 'DraftStorageError';
    /** @type {'quota'|'unavailable'|'corrupt'|'serialize'} */
    this.reason = reason;
    /** 内部诊断信息，不进用户界面。 */
    this.detail = detail ?? '';
  }

  /**
   * 取得该分类对应的中文文案（INTERFACES.md §2.5 规定）。
   *
   * @param {'quota'|'unavailable'|'corrupt'|'serialize'} reason
   * @returns {string}
   */
  static messageFor(reason) {
    switch (reason) {
      case 'quota':
        return '本地备份失败：存储空间不足';
      case 'unavailable':
        return '本地备份失败：浏览器禁止本地存储';
      case 'corrupt':
        return '本地备份已损坏，已忽略';
      case 'serialize':
        return '本地备份失败：内容无法序列化';
      default:
        return '本地备份失败：未知错误';
    }
  }
}

/**
 * 取默认存储适配器。
 *
 * 模块内**唯一**允许触碰 `window.localStorage` 的位置，且通过 default 参数使用，
 * 使 Node 测试可以完全注入替身而无需访问浏览器环境。
 *
 * @returns {StorageAdapter}
 */
function defaultStorage() {
  // 【重要】整个获取过程必须包在 try 内。
  //
  // 浏览器策略（禁用 Cookie / 隐私模式 / 沙箱 iframe）会让**访问
  // `window.localStorage` 属性本身**抛 `SecurityError`，而不是等到调用
  // `getItem` 才抛。早期实现把属性访问写在 try 之外，于是这类环境直接漏出
  // 原生 `DOMException`，而不是契约承诺的 `reason === 'unavailable'` 的
  // `DraftStorageError` —— 调用方因此无法选中文案与恢复行为。
  try {
    if (typeof window === 'undefined') {
      throw new DraftStorageError('unavailable', '当前环境没有 window');
    }
    // 再次显式取属性：'in' 判断不会触发 getter，Safari 私有模式下
    // `window.localStorage` 的存在性检查本身就可能抛错。
    const store = window.localStorage;
    if (!store) {
      throw new DraftStorageError('unavailable', '当前环境没有 localStorage');
    }
    return store;
  } catch (error) {
    // 已是本模块的错误则原样传递，避免二次包装丢失 reason。
    if (error instanceof DraftStorageError) throw error;
    throw classifyStorageError(error);
  }
}

/**
 * 归一化存储异常为 {@link DraftStorageError}。
 *
 * @param {unknown} error 捕获到的原始异常
 * @returns {DraftStorageError}
 */
function classifyStorageError(error) {
  const name = error && typeof error === 'object' ? /** @type {{name?: string}} */ (error).name : '';

  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new DraftStorageError('quota', String(error));
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return new DraftStorageError('unavailable', String(error));
  }
  // 已是本模块的错误则原样传递，避免二次包装丢失 reason。
  if (error instanceof DraftStorageError) {
    return error;
  }
  return new DraftStorageError('unavailable', String(error));
}

/**
 * 生成一次文档打开会话的 ID。
 *
 * 作用域＝**一次文档打开会话**。切换文档、切换账号、切换标签页都必须重新生成。
 * 会话 ID 进入草稿键，弱随机会让枚举与碰撞行为不可预测，
 * 因此**不允许**退回 `Math.random()`；环境无此 API 时直接抛错。
 *
 * @returns {string} UUID v4 字符串
 * @throws {Error} 环境缺少 `crypto.randomUUID()`
 */
export function createEditSessionId() {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('当前环境不支持 crypto.randomUUID()，无法安全生成编辑会话 ID');
  }
  return crypto.randomUUID();
}

/**
 * 构造草稿键。
 *
 * 格式：`markdown-editor:draft:{userId}:{docId}:{sessionId}`。
 * 各段经 `encodeURIComponent` 编码，保证段内含 `:` 也不会破坏解析——
 * UUID 本身不含 `:`，编码是防御性的，但 {@link parseDraftKey} 必须与之严格互逆。
 *
 * @param {{userId: string, docId: string, sessionId: string}} parts
 * @returns {string}
 * @throws {TypeError} 任一段缺失或非字符串
 */
export function buildDraftKey(parts) {
  const { userId, docId, sessionId } = parts ?? {};
  for (const [name, value] of Object.entries({ userId, docId, sessionId })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`buildDraftKey: ${name} 必须是非空字符串`);
    }
  }
  return `${DRAFT_KEY_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(docId)}:${encodeURIComponent(sessionId)}`;
}

/**
 * 解析草稿键为各段。
 *
 * **非本模块的键必须返回 `null`，不得抛异常**——本函数会被用于扫描时过滤。
 *
 * @param {string} key
 * @returns {{userId: string, docId: string, sessionId: string} | null}
 */
export function parseDraftKey(key) {
  if (typeof key !== 'string' || !key.startsWith(DRAFT_KEY_PREFIX)) {
    return null;
  }
  const rest = key.slice(DRAFT_KEY_PREFIX.length);
  const segments = rest.split(':');
  if (segments.length !== 3) {
    return null;
  }
  const [userId, docId, sessionId] = segments.map(decodeSegment);
  if (!userId || !docId || !sessionId) {
    return null;
  }
  return { userId, docId, sessionId };
}

/**
 * 解码单个键段。解码失败（非法百分号序列）返回空串以示无效。
 *
 * @param {string} segment
 * @returns {string}
 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/**
 * 校验草稿记录结构。
 *
 * 逐项对照 INTERFACES.md §2.6。任一项不过即视为损坏，
 * **不得静默接受**——W1 实测中 `123` 被静默转成 `"123"`、
 * `null` 转成 `""`、对象转成 `"[object Object]"`。
 *
 * @param {unknown} record 待校验对象
 * @param {{userId?: string, docId?: string, sessionId?: string}} [expectedKeyParts] 键中解析出的三段
 * @returns {boolean}
 */
function isValidDraftRecord(record, expectedKeyParts) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return false;
  }
  const r = /** @type {Record<string, unknown>} */ (record);

  if (typeof r.user_id !== 'string' || r.user_id.length === 0) return false;
  if (typeof r.doc_id !== 'string' || r.doc_id.length === 0) return false;
  if (typeof r.edit_session_id !== 'string' || r.edit_session_id.length === 0) return false;
  if (!Number.isInteger(r.base_version) || /** @type {number} */ (r.base_version) < 1) return false;
  if (typeof r.title !== 'string') return false;
  if (typeof r.content !== 'string') return false;
  if (!Number.isInteger(r.local_revision) || /** @type {number} */ (r.local_revision) < 0) return false;
  if (typeof r.recorded_at !== 'string' || Number.isNaN(Date.parse(r.recorded_at))) return false;

  // 键与记录必须一致，否则说明键被手工改过或记录串号。
  if (expectedKeyParts) {
    if (r.user_id !== expectedKeyParts.userId) return false;
    if (r.doc_id !== expectedKeyParts.docId) return false;
    if (r.edit_session_id !== expectedKeyParts.sessionId) return false;
  }
  return true;
}

/**
 * 生成 ISO 8601 UTC 时间戳字符串。
 *
 * 契约要求 `recorded_at` 用 ISO 字符串而非 `Date.now()` 数字：
 * 数字毫秒时间戳无时区信息，跨时区展示会错；字符串在 localStorage 里可直接阅读；
 * 且与后端 TIMESTAMPTZ 的序列化形式一致。
 *
 * @returns {string} 形如 `2026-10-20T08:45:12.345Z`
 */
function isoNow() {
  return new Date().toISOString();
}

/**
 * 写入/合并草稿。
 *
 * 约 {@link MERGE_WINDOW_MS} 毫秒内的连续输入合并为一次写入，
 * 避免每次按键都做同步 JSON 序列化造成主线程卡顿。
 * **切换文档前调用方应绕过合并窗口立即写一次**（用 `flush()`）。
 *
 * 写入成功**不改变** `synced` / `dirty` 判定，也不代表云端已保存。
 *
 * @param {{userId: string, docId: string, sessionId: string,
 *          baseVersion: number, title: string, content: string,
 *          localRevision: number}} draft 入参用 camelCase
 * @param {StorageAdapter} [storage] 省略时用 window.localStorage
 * @returns {{key: string, recordedAt: string}}
 * @throws {DraftStorageError} reason 为 quota / unavailable / serialize
 */
export function saveDraft(draft, storage) {
  const store = storage ?? defaultStorage();
  const key = buildDraftKey(draft);

  // 落盘形态：snake_case，转换在内部完成。
  const record = {
    user_id: draft.userId,
    doc_id: draft.docId,
    edit_session_id: draft.sessionId,
    base_version: draft.baseVersion,
    title: draft.title,
    content: draft.content,
    local_revision: draft.localRevision,
    recorded_at: isoNow(),
  };

  if (!isValidDraftRecord(record, draft)) {
    throw new DraftStorageError('serialize', '写入前校验未通过：字段类型或取值不合法');
  }

  let raw;
  try {
    raw = JSON.stringify(record);
  } catch (error) {
    // 循环引用等无法序列化的情形。
    throw new DraftStorageError('serialize', String(error));
  }

  try {
    store.setItem(key, raw);
  } catch (error) {
    throw classifyStorageError(error);
  }

  return { key, recordedAt: record.recorded_at };
}

/**
 * 读取单个草稿。
 *
 * 键不存在返回 `null`；值损坏（JSON 非法或结构不符）**抛出** `reason === 'corrupt'`，
 * 不得静默返回空对象。
 *
 * @param {string} key
 * @param {StorageAdapter} [storage]
 * @returns {import('./types.js').DraftRecord | null}
 * @throws {DraftStorageError} reason 为 corrupt / unavailable
 */
export function readDraft(key, storage) {
  const store = storage ?? defaultStorage();
  const parts = parseDraftKey(key);

  let raw;
  try {
    raw = store.getItem(key);
  } catch (error) {
    throw classifyStorageError(error);
  }
  if (raw === null || raw === undefined) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DraftStorageError('corrupt', `JSON 解析失败：${String(error)}`);
  }

  if (!isValidDraftRecord(parsed, parts ?? undefined)) {
    throw new DraftStorageError('corrupt', '草稿结构校验未通过');
  }

  return parsed;
}

/**
 * 枚举指定用户（可选指定文档）的遗留草稿。
 *
 * 按 `markdown-editor:draft:{userId}:` 前缀扫描，避免遍历全部 localStorage。
 * 这是防止**跨账号草稿互相可见**的关键。
 *
 * @param {{userId: string, docId?: string}} scope
 * @param {StorageAdapter} [storage]
 * @returns {import('./types.js').DraftRecord[]} 按 recordedAt DESC 排序
 * @throws {DraftStorageError} reason 为 unavailable
 */
export function listDrafts(scope, storage) {
  const store = storage ?? defaultStorage();
  const scopePrefix = `${DRAFT_KEY_PREFIX}${encodeURIComponent(scope.userId)}:`;

  const keys = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (typeof key === 'string' && key.startsWith(scopePrefix)) {
        keys.push(key);
      }
    }
  } catch (error) {
    throw classifyStorageError(error);
  }

  const records = [];
  for (const key of keys) {
    try {
      const record = readDraft(key, store);
      if (record === null) continue;
      if (scope.docId !== undefined && record.doc_id !== scope.docId) continue;
      records.push(record);
    } catch (error) {
      if (error instanceof DraftStorageError && error.reason === 'corrupt') {
        // 损坏项计入结果但不静默丢弃：附带 corrupt 标记由调用方决定是否提示。
        const parts = parseDraftKey(key);
        if (parts !== null) {
          records.push({ corrupt: true, key, user_id: parts.userId, doc_id: parts.docId, edit_session_id: parts.sessionId });
        }
        continue;
      }
      throw error;
    }
  }

  // 可解析的按 recordedAt 降序；损坏项排到最后。
  records.sort((a, b) => {
    if (a.corrupt) return 1;
    if (b.corrupt) return -1;
    return Date.parse(b.recorded_at) - Date.parse(a.recorded_at);
  });
  return records;
}

/**
 * 丢弃草稿——**必须先通过三重核对**。
 *
 * 三项全部相等才允许删除：会话、修订号、内容。
 * 任一不等即**拒绝删除并返回 false**，绝不触碰存储。
 *
 * 这条最容易被漏掉：直接 `removeItem` 会在保存进行中点击"清除草稿"时，
 * 抹掉刚产生的新修改（规范 §08:376 明令禁止）。
 *
 * @param {string} key
 * @param {{sessionId: string, localRevision: number, content: string}} expected
 * @param {StorageAdapter} [storage]
 * @returns {boolean} true=已删除；false=核对未通过拒绝删除；草稿本不存在时返回 true（无可删）
 * @throws {DraftStorageError} reason 为 corrupt / unavailable
 */
export function discardDraft(key, expected, storage) {
  const store = storage ?? defaultStorage();

  let raw;
  try {
    raw = store.getItem(key);
  } catch (error) {
    throw classifyStorageError(error);
  }
  if (raw === null || raw === undefined) {
    // 目标不存在，视为已达成"没有草稿"的状态。
    return true;
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    throw new DraftStorageError('corrupt', `JSON 解析失败：${String(error)}`);
  }

  // 三重核对：会话 → 修订号 → 内容。
  const sameSession = record?.edit_session_id === expected.sessionId;
  const sameRevision = record?.local_revision === expected.localRevision;
  const sameContent = record?.content === expected.content;

  if (!(sameSession && sameRevision && sameContent)) {
    return false;
  }

  try {
    store.removeItem(key);
  } catch (error) {
    throw classifyStorageError(error);
  }
  return true;
}

/**
 * 清理当前会话已**显式确认**可弃用的历史草稿。
 *
 * ## 为什么不能按「sessionId 不同」就删（这是本模块曾经的真实缺陷）
 *
 * 早期实现枚举同一文档下的所有草稿，凡 `sessionId` 与当前不同的一律删除。
 * 但 `edit_session_id` 只是「一次文档打开会话」的标识：
 *
 * - 同一文档在**另一个标签页**打开时，会生成新的 `edit_session_id`；
 *     此时 A 标签页调用本函数，会把 B 标签页**尚未同步**的备份一起删掉。
 * - `docs/SYNC.md` §9.6 与 §9.8 明确要求：**除非用户明确确认，
 *     否则必须保留其他活动窗口的草稿**。会话 ID 不同并不等于记录已过时。
 *
 * 会话 ID 不同只说明「可能是残留」，不足以证明「可以删」。
 *
 * ## 现在的判定规则
 *
 * 仅当一条历史草稿满足下列**全部**条件时才删除：
 * 1. `cloudVersion` 已给出，且该草稿的 `base_version <= cloudVersion`
 *    —— 说明云端版本已经推进到足以覆盖这份草稿；
 * 2. 且该草稿的 `content` 与 `title` **都**等于 `cloudContent` / `cloudTitle`
 *    —— 内容相同才谈得上"已包含在云端"；
 * 3. 或调用方通过 `confirmedKeys` 显式点名（用户手动确认后丢弃）。
 *
 * 其余一律保留，宁可残留也不误删。
 *
 * @param {{userId: string, docId: string, sessionId: string}} parts
 * @param {object} [options]
 * @param {{version: number, title?: string, content?: string}} [options.cloud]
 *   云端当前状态。**不提供则不删除任何记录**（保守默认）。
 * @param {string[]} [options.confirmedKeys] 用户已明确确认可丢弃的键。
 * @param {StorageAdapter} [storage]
 * @returns {{removed: string[], kept: string[]}} 删除与保留的键
 * @throws {DraftStorageError}
 */
export function clearSessionDrafts(parts, options, storage) {
  // 兼容旧调用方式：clearSessionDrafts(parts, storage)
  let opts = options;
  let store = storage;
  if (options && typeof options.length === 'number' && typeof options.getItem === 'function') {
    store = options;
    opts = undefined;
  }

  const { cloud, confirmedKeys } = opts ?? {};
  const confirmed = new Set(Array.isArray(confirmedKeys) ? confirmedKeys : []);
  const useStore = store ?? defaultStorage();
  const prefix = `${DRAFT_KEY_PREFIX}${encodeURIComponent(parts.userId)}:${encodeURIComponent(parts.docId)}:`;

  const keys = [];
  try {
    for (let i = 0; i < useStore.length; i += 1) {
      const key = useStore.key(i);
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
      const parsed = parseDraftKey(key);
      if (parsed === null || parsed.sessionId === parts.sessionId) continue;
      // 会话不同只是「可能残留」，需再按下述条件证明其确实可弃。
      if (confirmed.has(key) || isCoveredByCloud(useStore, key, cloud)) {
        keys.push(key);
      }
    }
  } catch (error) {
    throw classifyStorageError(error);
  }

  const removed = [];
  for (const key of keys) {
    try {
      useStore.removeItem(key);
      removed.push(key);
    } catch (error) {
      throw classifyStorageError(error);
    }
  }

  const kept = [];
  try {
    for (let i = 0; i < useStore.length; i += 1) {
      const key = useStore.key(i);
      if (typeof key === 'string' && key.startsWith(prefix)) kept.push(key);
    }
  } catch (error) {
    throw classifyStorageError(error);
  }

  return { removed, kept };
}

/**
 * 判定一份历史草稿是否已被云端状态覆盖、因而可以安全删除。
 *
 * 三个条件必须同时满足，缺一即视为「不可删」：
 * 1. 调用方提供了云端状态（没有基准就无法判断）；
 * 2. 云端版本已推进到 `>=` 草稿的 `base_version`
 *    —— 云端至少不落后于草稿产生时的版本；
 * 3. 草稿的 `content` **与 `title`** 都与云端一致。
 *
 * 第 3 条必须同时比标题：只比正文会把「仅改标题未保存」的草稿误删，
 * 那正是 SYNC.md 要求草稿保护的场景之一。
 *
 * @param {StorageAdapter} store
 * @param {string} key
 * @param {{version: number, title?: string, content?: string}} [cloud]
 * @returns {boolean}
 */
function isCoveredByCloud(store, key, cloud) {
  if (!cloud || typeof cloud.version !== 'number') return false;

  let record;
  try {
    const raw = store.getItem(key);
    if (raw === null || raw === undefined) return false;
    record = JSON.parse(raw);
  } catch {
    // 损坏记录不在此处删除：留给 discardDraft 或用户显式处理。
    return false;
  }
  if (!isValidDraftRecord(record)) return false;

  if (!(record.base_version <= cloud.version)) return false;

  const titleMatches =
    typeof cloud.title !== 'string' || record.title === cloud.title;
  const contentMatches =
    typeof cloud.content !== 'string' || record.content === cloud.content;

  return titleMatches && contentMatches;
}

/**
 * 纯函数：判定草稿恢复分支。
 *
 * 依据 SYNC.md §9.7：
 *
 * | 分支 | 条件 | 返回 |
 * |---|---|---|
 * | 标题与正文都与云端相同 | `draft.title === cloud.title && draft.content === cloud.content` | `'adopt_cloud'` |
 * | 云端版本等于草稿 base_version | `cloud.version === draft.base_version` | `'confirm'` |
 * | 版本不同且内容不同 | 两者都不满足 | `'conflict'` |
 *
 * **严禁**为旧草稿直接替换成最新 `base_version` 后自动提交——
 * 那等于用客户端的乐观假设覆盖服务端状态，是静默丢数据的典型实现（规范 §08:378）。
 *
 * 本函数只做判定，不弹窗、不改状态、不触碰存储。
 *
 * @param {import('./types.js').DraftRecord} draft
 * @param {{title: string, content: string, version: number}} cloud
 * @returns {'confirm'|'adopt_cloud'|'conflict'}
 */
export function classifyRestore(draft, cloud) {
  // 必须同时比较标题与正文（这是本模块曾经的真实缺陷）。
  //
  // 早期实现只比 `content`。但 SYNC.md 明确规定标题修改同样获得草稿保护，
  // 于是「只改了标题、正文没动」的草稿会被判成 `adopt_cloud`：
  // 客户端采纳云端并清掉草稿 —— **用户的标题改动就这么丢了**。
  //
  // 两条记录本来都带 `title`，比较成本为零，没有任何理由不比。
  const titleMatches =
    typeof draft.title === 'string' && draft.title === cloud.title;
  const contentMatches = draft.content === cloud.content;

  if (titleMatches && contentMatches) {
    return 'adopt_cloud';
  }
  if (cloud.version === draft.base_version) {
    return 'confirm';
  }
  return 'conflict';
}

/**
 * 创建合并写入器。
 *
 * 契约**未规定**本工厂的签名（冻结清单里没有它），
 * 但 SYNC.md §9.4 要求"约 250 毫秒合并写入，切换文档前同步刷新"，
 * 且 §13 要求"单元测试须用可控时钟"。
 * 因此把 `now` 与 `delay` 做成注入参数——这正是为满足可控时钟测试而设。
 *
 * 这不是新增能力，而是满足冻结契约行为要求的必要机制。
 *
 * @param {{storage?: StorageAdapter, now?: () => string, delay?: (fn: () => void, ms: number) => unknown}} [options]
 * @returns {{schedule: (draft: object) => void, flush: () => void, flushAll: () => void,
 *            cancel: () => void, pending: () => boolean}}
 */
export function createDraftWriter(options = {}) {
  const store = options.storage ?? defaultStorage();
  const now = options.now ?? isoNow;
  const delay = options.delay ?? ((fn, ms) => setTimeout(fn, ms));

  /** @type {object | null} 待写入的最新草稿 */
  let pendingDraft = null;
  /** @type {unknown} */
  let timer = null;

  function writeNow() {
    if (pendingDraft === null) return;
    const draft = pendingDraft;
    pendingDraft = null;
    saveDraft(draft, store);
  }

  return {
    /**
     * 排入一次写入。窗口内的连续调用只保留最后一次。
     *
     * @param {object} draft
     */
    schedule(draft) {
      pendingDraft = draft;
      if (timer !== null) return;
      timer = delay(() => {
        timer = null;
        writeNow();
      }, MERGE_WINDOW_MS);
    },

    /** 切换文档前同步刷新，绕过合并窗口立即写一次。 */
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      writeNow();
    },

    /** 立即落盘并清空待写状态。 */
    flushAll() {
      // 【重要】必须先 writeNow() 再清空待写状态。
      //
      // 早期实现只 clearTimeout + pendingDraft = null，于是
      // 「schedule(draft) 之后立刻 flushAll()」会把定时器取消掉、
      // 却什么都不写 —— 存储为空且报告"无待办"，
      // 这份快照被**静默丢失**，与方法名承诺的"flush"完全相反。
      //
      // 「取消且不落盘」的语义已由 cancel() 提供，两者不该混同。
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // writeNow() 内部已把 pendingDraft 置空并写入存储，
      // 末尾的置空只覆盖"本来就无待写"的情况。
      writeNow();
      pendingDraft = null;
    },

    /** 取消待写入的草稿，不落盘。 */
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingDraft = null;
    },

    /** 是否有待写入的草稿。 */
    pending() {
      return pendingDraft !== null;
    },
  };
}
