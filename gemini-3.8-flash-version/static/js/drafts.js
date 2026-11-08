/**
 * 本地草稿管理层 (严格实现 INTERFACES.md §2 M6 冻结契约)
 * 约束：纯逻辑 ES Module，零 DOM 操作，支持外部 storage 适配器注入
 */

const KEY_PREFIX = 'markdown-editor:draft:';

/**
 * 生成一次文档打开会话的 ID (UUID v4 格式)
 * @returns {string}
 */
export function createEditSessionId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // 回退简易 UUID v4 生成
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * 构造草稿键
 * @param {{userId: string, docId: string, sessionId: string}} parts
 * @returns {string} markdown-editor:draft:{userId}:{docId}:{sessionId}
 */
export function buildDraftKey(parts) {
    if (!parts || !parts.userId || !parts.docId || !parts.sessionId) {
        throw new Error('Draft key requires userId, docId, and sessionId');
    }
    return `${KEY_PREFIX}${parts.userId}:${parts.docId}:${parts.sessionId}`;
}

/**
 * 解析草稿键为各段
 * @param {string} key
 * @returns {{userId: string, docId: string, sessionId: string} | null}
 */
export function parseDraftKey(key) {
    if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) {
        return null;
    }
    const rest = key.slice(KEY_PREFIX.length);
    const segments = rest.split(':');
    if (segments.length !== 3) {
        return null;
    }
    const [userId, docId, sessionId] = segments;
    if (!userId || !docId || !sessionId) {
        return null;
    }
    return { userId, docId, sessionId };
}

/**
 * 写入/更新草稿 (对齐 SYNC.md §9.3 规范结构)
 * @param {{
 *   userId: string,
 *   docId: string,
 *   sessionId: string,
 *   baseVersion: number,
 *   title: string,
 *   content: string,
 *   localRevision: number
 * }} draft
 * @param {Storage} [storage=localStorage]
 * @returns {{key: string, recordedAt: string}}
 */
export function saveDraft(draft, storage = localStorage) {
    const key = buildDraftKey({
        userId: draft.userId,
        docId: draft.docId,
        sessionId: draft.sessionId
    });

    const recordedAt = new Date().toISOString();
    const record = {
        user_id: draft.userId,
        doc_id: draft.docId,
        edit_session_id: draft.sessionId,
        base_version: draft.baseVersion,
        title: draft.title,
        content: draft.content,
        local_revision: draft.localRevision,
        recorded_at: recordedAt
    };

    try {
        storage.setItem(key, JSON.stringify(record));
        return { success: true, key, recordedAt };
    } catch (e) {
        console.warn('LocalStorage saveDraft error:', e);
        return { success: false, key, recordedAt, error: e };
    }
}

/**
 * 读取单条草稿
 * @param {string} key
 * @param {Storage} [storage=localStorage]
 * @returns {object | null}
 */
export function readDraft(key, storage = localStorage) {
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * 枚举指定用户 (与可选指定文档) 的遗留草稿
 * @param {{userId: string, docId?: string}} scope
 * @param {Storage} [storage=localStorage]
 * @returns {Array<object>} 按 recorded_at DESC 排序
 */
export function listDrafts(scope, storage = localStorage) {
    if (!scope || !scope.userId) return [];
    const results = [];
    const targetUserId = scope.userId;
    const targetDocId = scope.docId;

    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        const parsed = parseDraftKey(key);
        if (!parsed) continue;

        if (parsed.userId === targetUserId) {
            if (!targetDocId || parsed.docId === targetDocId) {
                const item = readDraft(key, storage);
                if (item) {
                    results.push(item);
                }
            }
        }
    }

    results.sort((a, b) => {
        const timeA = new Date(a.recorded_at).getTime() || 0;
        const timeB = new Date(b.recorded_at).getTime() || 0;
        return timeB - timeA;
    });

    return results;
}

/**
 * 丢弃草稿 (严格执行会话、修订号、内容三重核对，未通过则拒绝删除)
 * @param {string} key
 * @param {{sessionId: string, localRevision: number, content: string}} expected
 * @param {Storage} [storage=localStorage]
 * @returns {boolean}
 */
export function discardDraft(key, expected, storage = localStorage) {
    const current = readDraft(key, storage);
    if (!current) {
        return true;
    }

    // 三重核对
    const sessionMatches = current.edit_session_id === expected.sessionId;
    const revisionMatches = current.local_revision === expected.localRevision;
    const contentMatches = current.content === expected.content;

    if (sessionMatches && revisionMatches && contentMatches) {
        storage.removeItem(key);
        return true;
    }

    // 期间产生了新编辑或会话不匹配，严禁误删
    return false;
}

/**
 * 清理指定文档当前会话以外的过期旧草稿
 * @param {{userId: string, docId: string, sessionId: string}} parts
 * @param {Storage} [storage=localStorage]
 * @returns {{removed: string[]}}
 */
export function clearSessionDrafts(parts, storage = localStorage) {
    const removed = [];
    const all = listDrafts({ userId: parts.userId, docId: parts.docId }, storage);
    for (const draft of all) {
        if (draft.edit_session_id !== parts.sessionId) {
            const key = buildDraftKey({
                userId: draft.user_id,
                docId: draft.doc_id,
                sessionId: draft.edit_session_id
            });
            storage.removeItem(key);
            removed.push(key);
        }
    }
    return { removed };
}

/**
 * 判定草稿恢复分支 (纯函数，对齐 INTERFACES.md §2.3)
 * @param {object} draft
 * @param {{title: string, content: string, version: number}} cloud
 * @returns {'confirm' | 'adopt_cloud' | 'conflict'}
 */
export function classifyRestore(draft, cloud) {
    if (!draft || !cloud) return 'adopt_cloud';

    if (draft.base_version === cloud.version &&
        draft.content === cloud.content &&
        draft.title === cloud.title) {
        return 'adopt_cloud';
    }

    if (draft.base_version === cloud.version) {
        return 'confirm';
    }

    return 'conflict';
}
