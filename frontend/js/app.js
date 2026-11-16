/**
 * app.js —— 前端应用总控模块 (M1 协调装配)
 *
 * 职责：
 * 1. 认证管理与会话状态维护 (JWT 存储与更新)
 * 2. 协调 editor.js (编辑器 UI)、api.js (网络出口)、sync.js (7 状态同步状态机)、drafts.js (离线草稿)
 * 3. 冲突解决弹窗与草稿恢复引导
 */

import { apiFetch, ApiError, AuthError, VersionConflictError } from './api.js';
import { createEditor } from './editor.js';
import { SyncEngine, SyncState } from './sync.js';
import * as drafts from './drafts.js';

// DOM 元素引用
const el = {
  titleInput: document.getElementById('docTitle'),
  contentInput: document.getElementById('docContent'),
  previewContainer: document.getElementById('preview'),
  syncBadge: document.getElementById('syncBadge'),
  statusText: document.getElementById('statusText'),
  docInfo: document.getElementById('docInfo'),
  statChars: document.getElementById('statChars'),
  docList: document.getElementById('docList'),
  docCount: document.getElementById('docCount'),
  btnNewDoc: document.getElementById('btnNewDoc'),
  btnSaveNow: document.getElementById('btnSaveNow'),
  btnDeleteDoc: document.getElementById('btnDeleteDoc'),
  btnDownloadMarkdown: document.getElementById('btnDownloadMarkdown'),
  userInfo: document.getElementById('userInfo'),
  btnAuthToggle: document.getElementById('btnAuthToggle'),

  // 存储失败横幅（SYNC.md §9.8）
  storageBanner: document.getElementById('storageBanner'),
  storageMessage: document.getElementById('storageMessage'),
  btnDownloadFromBanner: document.getElementById('btnDownloadFromBanner'),

  // 认证弹窗
  authModal: document.getElementById('authModal'),
  authModalTitle: document.getElementById('authModalTitle'),
  authForm: document.getElementById('authForm'),
  authUsername: document.getElementById('authUsername'),
  authPassword: document.getElementById('authPassword'),
  authError: document.getElementById('authError'),
  btnAuthSubmit: document.getElementById('btnAuthSubmit'),
  btnAuthSwitch: document.getElementById('btnAuthSwitch'),
  btnAuthClose: document.getElementById('btnAuthClose'),

  // 冲突解决弹窗
  conflictModal: document.getElementById('conflictModal'),
  serverVersionText: document.getElementById('serverVersionText'),
  localVersionText: document.getElementById('localVersionText'),
  btnConflictReload: document.getElementById('btnConflictReload'),
  btnConflictOverwrite: document.getElementById('btnConflictOverwrite'),

  // 草稿恢复条
  draftBanner: document.getElementById('draftBanner'),
  draftTimestamp: document.getElementById('draftTimestamp'),
  btnRestoreDraft: document.getElementById('btnRestoreDraft'),
  btnDiscardDraft: document.getElementById('btnDiscardDraft'),
};

// 全局应用状态
const state = {
  user: null,       // { id, username }
  token: null,      // JWT string
  currentDoc: null, // { id, title, content, version }
  documents: [],    // Document summaries
  isRegisterMode: false,
  pendingConflict: null,
  pendingDraft: null,
};

// 1. 初始化编辑器组件
const editor = createEditor({
  titleInput: el.titleInput,
  contentInput: el.contentInput,
  previewElement: el.previewContainer,
  parseMarkdown: (text) => (window.marked ? window.marked.parse(text) : text),
  sanitizeHtml: (html) => (window.DOMPurify ? window.DOMPurify.sanitize(html) : html),
});

// 2. 初始化同步引擎
const syncEngine = new SyncEngine({
  onStateChange: (syncState, payload) => {
    updateSyncBadge(syncState, payload);
  },
  onConflict: (conflictData) => {
    state.pendingConflict = conflictData;
    el.serverVersionText.textContent = `v${conflictData.serverVersion}`;
    el.localVersionText.textContent = `v${syncEngine.baseVersion}`;
    el.conflictModal.classList.remove('hidden');
  },
  onError: (err) => {
    el.statusText.textContent = `错误: ${err.message || '操作失败'}`;
    if (err instanceof AuthError) {
      showAuthModal(false);
    }
  },
  onSaveSuccess: (resp) => {
    el.statusText.textContent = `云端保存成功 (v${resp.version})`;
    if (state.currentDoc) {
      state.currentDoc.version = resp.version;
      el.docInfo.textContent = `版本: v${resp.version}`;
    }
    loadDocumentList();
  },
  // 【新增】本地备份失败（SYNC.md §9.8 / 验收项 T10）。
  //
  // 原实现里存储失败只被 console.warn 吞掉，界面照常显示"已在本地备份"，
  // 用户据此判断"内容安全了"并关闭浏览器 → **内容丢失**。
  // 现在必须显式告知，并提供 Markdown 下载兜底。
  onStorageFailure: (info) => {
    el.storageMessage.textContent =
      `本地备份失败（${info.reason}），内容仅存在于内存中，请立即下载。`;
    el.storageBanner.classList.remove('hidden');
    el.statusText.textContent = '本地备份失败，内容尚未存入本机';
  },
  // 【新增】云端文档已不可用（SYNC.md §6 分支 ④）。
  onCloudUnavailable: (info) => {
    el.statusText.textContent = '云端文档已不可用，可另存为新文档';
    el.storageBanner.classList.remove('hidden');
    el.storageMessage.textContent = '云端文档已不可用，本地内容仍保留，可下载后另存为新文档。';
  },
});

/**
 * 下载当前内容为 Markdown 文件（SYNC.md §9.8 的兜底手段）。
 *
 * 存储失败时内存内容是最后一道防线，必须提供一条把它取出来的路。
 */
function downloadMarkdown() {
  const title = state.currentDoc?.title || editor.getValue()?.title || '未命名文档';
  const content = editor.getValue()?.content ?? '';
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立即释放会让部分浏览器来不及开始下载，延后一拍。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 监听编辑器输入，通知同步引擎
editor.onInput(({ title, content }) => {
  el.statChars.textContent = `${content.length} 字符`;
  syncEngine.onInput(title, content);
});

// 3. 状态徽章渲染
function updateSyncBadge(syncState, payload = {}) {
  el.syncBadge.className = 'sync-badge';

  switch (syncState) {
    case SyncState.SYNCED:
      el.syncBadge.classList.add('badge-synced');
      el.syncBadge.textContent = '✓ 已同步';
      el.statusText.textContent = '所有更改已同步至云端';
      break;
    case SyncState.DIRTY:
      el.syncBadge.classList.add('badge-dirty');
      el.syncBadge.textContent = '• 本地已备份';
      el.statusText.textContent = payload.message || '已在本地备份';
      break;
    case SyncState.SAVING:
      el.syncBadge.classList.add('badge-saving');
      el.syncBadge.textContent = '⏳ 保存中…';
      el.statusText.textContent = '正在与云端同步…';
      break;
    case SyncState.RETRY_WAIT:
      el.syncBadge.classList.add('badge-retry');
      el.syncBadge.textContent = '⚠️ 等待重试';
      el.statusText.textContent = payload.message || '网络中断，已在本地备份，稍后重试';
      break;
    case SyncState.AUTH_REQUIRED:
      el.syncBadge.classList.add('badge-dirty');
      el.syncBadge.textContent = '🔒 需要登录';
      el.statusText.textContent = '登录已失效，草稿已在本地备份，请重新登录';
      break;
    case SyncState.CONFLICT:
      el.syncBadge.classList.add('badge-conflict');
      el.syncBadge.textContent = '✕ 版本冲突';
      el.statusText.textContent = '检测到并发编辑冲突';
      break;
    case SyncState.INVALID:
      el.syncBadge.classList.add('badge-invalid');
      el.syncBadge.textContent = '✕ 校验错误';
      el.statusText.textContent = payload.error || '文档内容不合规';
      break;
  }
}

// 4. 文档管理逻辑
async function loadDocumentList() {
  if (!state.token) return;

  try {
    const data = await apiFetch('/documents?limit=100&offset=0', {
      method: 'GET',
      token: state.token,
    });

    state.documents = data.documents || [];
    el.docCount.textContent = `${data.total || state.documents.length} 篇`;
    renderDocumentList();
  } catch (err) {
    console.error('加载文档列表失败:', err);
  }
}

function renderDocumentList() {
  el.docList.innerHTML = '';
  if (state.documents.length === 0) {
    el.docList.innerHTML = '<li class="doc-item placeholder">暂无文档，点击“新建文档”开始编写</li>';
    return;
  }

  state.documents.forEach((doc) => {
    const li = document.createElement('li');
    li.className = 'doc-item';
    if (state.currentDoc && state.currentDoc.id === doc.id) {
      li.classList.add('active');
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'doc-item-title';
    titleSpan.textContent = doc.title || '未命名文档';

    const metaSpan = document.createElement('span');
    metaSpan.className = 'doc-item-meta';
    metaSpan.textContent = `v${doc.version} · ${new Date(doc.updated_at).toLocaleTimeString()}`;

    li.appendChild(titleSpan);
    li.appendChild(metaSpan);
    li.addEventListener('click', () => openDocument(doc.id));
    el.docList.appendChild(li);
  });
}

async function openDocument(docId) {
  if (!state.token) return;

  try {
    // Persist buffered edits before leaving the current document.
    syncEngine.flushDraft();
    el.statusText.textContent = '正在载入文档…';

    // §8.4：若该文档还有在途或结果未知的请求，**先等待核对完成**，
    // 再建立当前编辑会话的云端写入基准。
    // 跳过这一步会用旧 base_version 发起写入，等于放弃冲突检测。
    if (syncEngine.hasPending(docId)) {
      el.statusText.textContent = '正在核对未完成的保存…';
      await syncEngine.reconcilePending(docId);
    }

    const doc = await apiFetch(`/documents/${docId}`, {
      method: 'GET',
      token: state.token,
    });

    state.currentDoc = doc;
    editor.setValues({ title: doc.title, content: doc.content });
    el.docInfo.textContent = `版本: v${doc.version}`;
    el.statChars.textContent = `${doc.content.length} 字符`;

    // 检查是否有未提交本地草稿 (docs/SYNC.md §4)
    checkLocalDraft(doc);

    syncEngine.initSession(state.user.id, state.token, doc);
    renderDocumentList();
  } catch (err) {
    el.statusText.textContent = `打开文档失败: ${err.message}`;
  }
}

/**
 * 检查当前文档是否有未同步的本地草稿，并按 SYNC.md §9.7 三分支处置。
 *
 * 【修过的缺陷】
 * 原实现比较 `decision === 'prompt_user'`，但 `drafts.classifyRestore`
 * 的返回值域是 `'adopt_cloud' | 'confirm' | 'conflict'` —— **'prompt_user' 根本不存在**，
 * 于是条件恒为 false，草稿横幅**永远隐藏**，用户永远看不到草稿提示，
 * 草稿"保留"但等于丢失。
 *
 * 另外原实现按 camelCase 读草稿字段（`recordedAt` / `sessionId` / `localRevision`），
 * 而 `drafts.js` 落盘用的是 **snake_case**（`recorded_at` / `edit_session_id` /
 * `local_revision`），导致取到 `undefined`。
 *
 * @param {{id: string, title: string, content: string, version: number}} serverDoc
 */
function checkLocalDraft(serverDoc) {
  if (!state.user) return;

  const draftList = drafts.listDrafts({ userId: state.user.id, docId: serverDoc.id });
  if (draftList.length === 0) {
    el.draftBanner.classList.add('hidden');
    state.pendingDraft = null;
    return;
  }

  const latestDraft = draftList[0];
  const decision = drafts.classifyRestore(latestDraft, serverDoc);

  // 分支 ①（adopt_cloud）：草稿与云端完全相同 —— 草稿冗余，直接采用云端。
  // 分支 ②（confirm）/ ③（conflict）：需要用户确认，**不得**自动覆盖任一方。
  if (decision === 'adopt_cloud') {
    state.pendingDraft = null;
    el.draftBanner.classList.add('hidden');
    return;
  }

  state.pendingDraft = latestDraft;
  // 字段名对齐 drafts.js 的 snake_case 落盘格式。
  const recordedAt = latestDraft.recorded_at;
  el.draftTimestamp.textContent = recordedAt
    ? new Date(recordedAt).toLocaleString()
    : '未知时间';
  el.draftBanner.classList.remove('hidden');
}

async function createNewDocument() {
  if (!state.token) {
    showAuthModal(false);
    return;
  }

  try {
    const doc = await apiFetch('/documents', {
      method: 'POST',
      token: state.token,
      body: {
        title: '未命名文档',
        content: '',
      },
    });

    state.currentDoc = doc;
    editor.setValues({ title: doc.title, content: doc.content });
    el.docInfo.textContent = `版本: v${doc.version}`;
    el.statChars.textContent = '0 字符';
    syncEngine.initSession(state.user.id, state.token, doc);
    await loadDocumentList();
  } catch (err) {
    el.statusText.textContent = `新建文档失败: ${err.message}`;
  }
}

async function deleteCurrentDocument() {
  if (!state.currentDoc || !state.token) return;

  const confirmed = confirm(`确定要永久删除文档《${state.currentDoc.title}》吗？`);
  if (!confirmed) return;

  try {
    await apiFetch(`/documents/${state.currentDoc.id}?expected_version=${state.currentDoc.version}`, {
      method: 'DELETE',
      token: state.token,
    });

    // 清理草稿。
    //
    // 【修过的缺陷】原实现用 `clearSessionDrafts(..., { force: true })`。
    // force 会跳过 `isCoveredByCloud` 的三重判定，
    // 直接删掉该文档下**所有会话**的草稿 —— 包括**其他标签页尚未同步**的备份。
    // 这与 SYNC.md §9.6 / §9.8 直接冲突。
    //
    // 现改为：先刷新待写缓冲，再**显式列出**该文档的草稿键逐个删除
    // （confirmedKeys 是显式确认，不跨文档、不跨账号）。
    syncEngine.flushDraft();
    try {
      const ownKeys = drafts.listDrafts({
        userId: state.user.id,
        docId: state.currentDoc.id,
      }).map((d) =>
        drafts.buildDraftKey({
          userId: state.user.id,
          docId: state.currentDoc.id,
          sessionId: d.edit_session_id,
        }),
      );
      if (ownKeys.length > 0) {
        drafts.clearSessionDrafts(
          {
            userId: state.user.id,
            docId: state.currentDoc.id,
            sessionId: syncEngine.editSessionId,
          },
          { confirmedKeys: ownKeys },
        );
      }
    } catch (error) {
      console.warn('删除文档后清理草稿失败:', error);
    }

    state.currentDoc = null;
    editor.setValues({ title: '', content: '' });
    el.docInfo.textContent = '版本: -';
    el.statusText.textContent = '文档已删除';
    await loadDocumentList();
  } catch (err) {
    if (err instanceof VersionConflictError) {
      alert(`删除失败：云端已被他人更新至版本 v${err.serverVersion}，请刷新后再试。`);
    } else {
      alert(`删除失败: ${err.message}`);
    }
  }
}

// 5. 冲突与草稿弹窗事件绑定
el.btnConflictReload.addEventListener('click', async () => {
  el.conflictModal.classList.add('hidden');
  if (state.currentDoc) {
    // 【修过的缺陷】原实现直接 `openDocument(state.currentDoc.id)` 重拉，
    // 绕开了 `syncEngine.resolveReload()` —— 后者才是为此设计的，
    // 它会**先刷新待写缓冲、再按三重核对丢弃本地草稿**（INTERFACES §3）。
    //
    // 绕路的后果：待写缓冲没刷新可能被稍后的清理"复活"，
    // 且本地草稿与冲突上下文不一致。
    const doc = await apiFetch(`/documents/${state.currentDoc.id}`, {
      method: 'GET',
      token: state.token,
    });
    syncEngine.resolveReload(doc);
    state.currentDoc = doc;
    editor.setValues({ title: doc.title, content: doc.content });
    el.docInfo.textContent = `版本: v${doc.version}`;
    el.statusText.textContent = '已采用云端版本';
  }
});

el.btnConflictOverwrite.addEventListener('click', async () => {
  el.conflictModal.classList.add('hidden');
  if (state.pendingConflict) {
    await syncEngine.resolveOverwrite(state.pendingConflict.serverVersion);
  }
});

el.btnRestoreDraft.addEventListener('click', () => {
  if (state.pendingDraft) {
    editor.setValues({
      title: state.pendingDraft.title,
      content: state.pendingDraft.content,
    });
    syncEngine.onInput(state.pendingDraft.title, state.pendingDraft.content);
    el.draftBanner.classList.add('hidden');
    el.statusText.textContent = '已恢复本地草稿';
  }
});

el.btnDiscardDraft.addEventListener('click', () => {
  if (state.pendingDraft && state.user && state.currentDoc) {
    // 字段名对齐 drafts.js 的 snake_case 落盘格式。
    const sessionId = state.pendingDraft.edit_session_id;
    const localRevision = state.pendingDraft.local_revision;
    const content = state.pendingDraft.content;

    const draftKey = drafts.buildDraftKey({
      userId: state.user.id,
      docId: state.currentDoc.id,
      sessionId,
    });
    // 三重核对：会话 / 修订号 / 内容全部相等才删除（SYNC.md §9.6）。
    drafts.discardDraft(draftKey, { sessionId, localRevision, content });
    el.draftBanner.classList.add('hidden');
    el.statusText.textContent = '已丢弃旧草稿';
  }
});

// 6. 认证流程
function showAuthModal(isRegister = false) {
  state.isRegisterMode = isRegister;
  el.authModalTitle.textContent = isRegister ? '注册新账号' : '用户登录';
  el.btnAuthSubmit.textContent = isRegister ? '注 册' : '登 录';
  el.btnAuthSwitch.textContent = isRegister ? '已有账号？去登录' : '没有账号？去注册';
  el.authError.classList.add('hidden');
  el.authUsername.value = '';
  el.authPassword.value = '';
  el.authModal.classList.remove('hidden');
}

function hideAuthModal() {
  el.authModal.classList.add('hidden');
}

el.btnAuthToggle.addEventListener('click', () => {
  if (state.token) {
    // 退出登录。
    //
    // 【重要】必须先销毁同步引擎。
    // 原实现只清了 state 上的字段，**没有**销毁 SyncEngine，
    // 于是引擎仍持有旧账号的 token / userId / docId，
    // 已排入的防抖定时器照常触发 → **用户已退出登录，旧账号的文档仍被写入**。
    //
    // destroy() 会让世代号自增，此后到达的旧响应一律被丢弃（SYNC.md §8.2）。
    syncEngine.destroy();

    state.user = null;
    state.token = null;
    state.currentDoc = null;
    state.pendingConflict = null;
    state.pendingDraft = null;
    state.documents = [];

    // 令牌存 sessionStorage 而非 localStorage（docs/API.md §7）：
    // localStorage 跨标签页持久化，放大 XSS 暴露面与令牌寿命。
    sessionStorage.removeItem('mce_token');
    sessionStorage.removeItem('mce_user');

    el.userInfo.textContent = '未登录';
    el.btnAuthToggle.textContent = '登录';
    el.docInfo.textContent = '版本: -';
    el.draftBanner.classList.add('hidden');
    el.conflictModal.classList.add('hidden');
    renderDocumentList();
    editor.setValues({ title: '', content: '' });
  } else {
    showAuthModal(false);
  }
});

el.btnAuthClose.addEventListener('click', hideAuthModal);

el.btnAuthSwitch.addEventListener('click', () => {
  showAuthModal(!state.isRegisterMode);
});

el.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = el.authUsername.value.trim();
  const password = el.authPassword.value;

  el.authError.classList.add('hidden');
  el.btnAuthSubmit.disabled = true;

  const endpoint = state.isRegisterMode ? '/auth/register' : '/auth/login';

  try {
    const data = await apiFetch(endpoint, {
      method: 'POST',
      body: { username, password },
    });

    state.token = data.token;
    state.user = data.user;
    // 令牌存 sessionStorage（docs/API.md §7）
    sessionStorage.setItem('mce_token', data.token);
    sessionStorage.setItem('mce_user', JSON.stringify(data.user));

    el.userInfo.textContent = state.user.username;
    el.btnAuthToggle.textContent = '退出';
    syncEngine.setToken(state.token);

    hideAuthModal();
    await loadDocumentList();

    if (state.documents.length > 0) {
      await openDocument(state.documents[0].id);
    } else {
      await createNewDocument();
    }
  } catch (err) {
    el.authError.textContent = err.message || '认证失败，请重试';
    el.authError.classList.remove('hidden');
  } finally {
    el.btnAuthSubmit.disabled = false;
  }
});

// 7. 工具栏动作绑定
el.btnNewDoc.addEventListener('click', createNewDocument);
el.btnSaveNow.addEventListener('click', () => syncEngine.flushSave());
el.btnDeleteDoc.addEventListener('click', deleteCurrentDocument);
el.btnDownloadMarkdown.addEventListener('click', downloadMarkdown);
el.btnDownloadFromBanner.addEventListener('click', downloadMarkdown);

// 手动保存快捷键（docs/SYNC.md §2.1：手动保存由 Ctrl+S / Cmd+S 触发）。
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void syncEngine.flushSave();
  }
});

// 8. 启动引导
(async function initApp() {
  const savedToken = sessionStorage.getItem('mce_token');
  const savedUser = sessionStorage.getItem('mce_user');

  if (savedToken && savedUser) {
    try {
      state.token = savedToken;
      state.user = JSON.parse(savedUser);
      el.userInfo.textContent = state.user.username;
      el.btnAuthToggle.textContent = '退出';
      syncEngine.setToken(state.token);
      await loadDocumentList();
      if (state.documents.length > 0) {
        await openDocument(state.documents[0].id);
      }
    } catch {
      sessionStorage.removeItem('mce_token');
      sessionStorage.removeItem('mce_user');
      showAuthModal(false);
    }
  } else {
    showAuthModal(false);
  }
})();
