/**
 * Gemini 3.8 Flash Markdown Studio - 前端协调器 (对齐 ARCHITECTURE.md §3.1 与 SYNC.md)
 * 职责：只做各模块装配，状态机归 sync.js，草稿归 drafts.js，网络归 api.js，安全渲染归 editor.js
 */

import { ApiClient } from './api.js';
import { SyncEngine, SyncState } from './sync.js';
import * as drafts from './drafts.js';
import { SafeMarkdownRenderer } from './editor.js';
import { GeminiCopilot } from './copilot.js';

class App {
    constructor() {
        this.currentDoc = null;
        this.documents = [];

        // DOM 引用
        this.titleInput = document.getElementById('current-title');
        this.editor = document.getElementById('markdown-editor');
        this.preview = document.getElementById('preview-container');
        this.syncBadge = document.getElementById('sync-status-badge');
        this.docList = document.getElementById('doc-list-container');
        this.wordCountLabel = document.getElementById('stat-word-count');
        this.charCountLabel = document.getElementById('stat-char-count');

        // 初始化同步引擎 (调度 1.5s / 5s)
        this.sync = new SyncEngine({
            onStateChange: (state, payload) => this.renderSyncBadge(state, payload),
            onConflict: (serverVersion) => this.showConflictModal(serverVersion),
            onError: (err) => console.error('Sync error:', err),
            onSaveSuccess: (doc) => this.updateDocInList(doc)
        });

        // 初始化 Gemini 3.8 Flash 扩展协同抽屉
        this.copilot = new GeminiCopilot(this.editor);

        this.initEventListeners();
        this.checkAuth();
    }

    /**
     * 状态栏文案渲染 (严格遵循 SYNC.md §4.4 文案禁令)
     */
    renderSyncBadge(state, payload = {}) {
        if (!this.syncBadge) return;
        this.syncBadge.className = 'sync-badge';

        switch (state) {
            case SyncState.SYNCED:
                this.syncBadge.classList.add('badge-saved');
                this.syncBadge.textContent = `✓ 已同步 (v${payload.version ?? this.sync.baseVersion})`;
                break;
            case SyncState.DIRTY:
                this.syncBadge.classList.add('badge-dirty');
                // 文案禁令：本地草稿写入绝对不得显示“已保存”或“已同步”，必须注明“已在本地备份”
                this.syncBadge.textContent = payload.message ? `● ${payload.message}` : '● 已在本地备份 (待同步)';
                break;
            case SyncState.SAVING:
                this.syncBadge.classList.add('badge-saving');
                this.syncBadge.textContent = '⏳ 正在提交云端...';
                break;
            case SyncState.RETRY_WAIT:
                this.syncBadge.classList.add('badge-offline');
                this.syncBadge.textContent = `☁ 等待重试 ${payload.message ? '(' + payload.message + ')' : ''}`;
                break;
            case SyncState.AUTH_REQUIRED:
                this.syncBadge.classList.add('badge-conflict');
                this.syncBadge.textContent = '🔒 登录失效，请重新登录';
                this.showAuthModal();
                break;
            case SyncState.CONFLICT:
                this.syncBadge.classList.add('badge-conflict');
                this.syncBadge.textContent = `⚠ 版本冲突 (服务端 v${payload.serverVersion})`;
                break;
            case SyncState.INVALID:
                this.syncBadge.classList.add('badge-conflict');
                this.syncBadge.textContent = `✕ 输入限制: ${payload.message || '格式错误'}`;
                break;
        }
    }

    async checkAuth() {
        const user = ApiClient.getCurrentUser();
        const token = ApiClient.getToken();

        if (!token || !user) {
            this.showAuthModal();
        } else {
            this.updateUserUI(user);
            await this.loadDocuments();
        }
    }

    updateUserUI(user) {
        const el = document.getElementById('current-username');
        if (el) el.textContent = user.username;
    }

    async loadDocuments() {
        try {
            const resp = await ApiClient.documents.list(100, 0);
            this.documents = resp.documents || [];
            this.renderDocumentList();

            if (this.documents.length > 0) {
                await this.selectDocument(this.documents[0].id);
            } else {
                await this.createNewDocument();
            }
        } catch (e) {
            console.error('Failed to load documents:', e);
            if (e.status === 401) {
                ApiClient.clearToken();
                this.showAuthModal();
            }
        }
    }

    renderDocumentList() {
        if (!this.docList) return;
        this.docList.innerHTML = '';

        this.documents.forEach(doc => {
            const li = document.createElement('li');
            li.className = `doc-item ${this.currentDoc?.id === doc.id ? 'active' : ''}`;
            li.dataset.id = doc.id;

            const timeStr = new Date(doc.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const titleDiv = document.createElement('div');
            titleDiv.className = 'doc-item-title';
            titleDiv.textContent = doc.title || '未命名文档';

            const metaDiv = document.createElement('div');
            metaDiv.className = 'doc-item-meta';
            metaDiv.innerHTML = `<span>v${doc.version}</span><span>${timeStr}</span>`;

            li.appendChild(titleDiv);
            li.appendChild(metaDiv);

            li.addEventListener('click', () => this.selectDocument(doc.id));
            this.docList.appendChild(li);
        });
    }

    async selectDocument(id) {
        const user = ApiClient.getCurrentUser();
        if (!user) return;

        // 如果当前会话有未同步内容，触发一次保存
        if (this.currentDoc && this.sync.state === SyncState.DIRTY) {
            await this.sync.triggerSave();
        }

        try {
            const doc = await ApiClient.documents.get(id);
            this.currentDoc = doc;

            this.titleInput.value = doc.title;
            this.editor.value = doc.content;

            // 检查该用户该文档是否存在遗留草稿 (SYNC.md §9.5 枚举草稿)
            const legacyDrafts = drafts.listDrafts({ userId: user.id, docId: id });
            let draftToApply = null;

            if (legacyDrafts.length > 0) {
                const latest = legacyDrafts[0];
                const decision = drafts.classifyRestore(latest, doc);

                if (decision === 'confirm' || decision === 'conflict') {
                    const promptMsg = decision === 'conflict'
                        ? `检测到本地草稿（保存于 ${new Date(latest.recorded_at).toLocaleString()}，基于版本 v${latest.base_version}），但云端已被更新至版本 v${doc.version}。\n\n点击“确定”恢复本地草稿并准备覆盖；点击“取消”丢弃草稿采用云端最新版本。`
                        : `检测到本机存在保存于 ${new Date(latest.recorded_at).toLocaleString()} 的未同步草稿，是否恢复？\n\n点击“确定”恢复草稿；点击“取消”丢弃草稿。`;

                    const confirmRestore = confirm(promptMsg);
                    if (confirmRestore) {
                        draftToApply = latest;
                    } else {
                        const draftKey = drafts.buildDraftKey({
                            userId: user.id,
                            docId: id,
                            sessionId: latest.edit_session_id
                        });
                        drafts.discardDraft(draftKey, {
                            sessionId: latest.edit_session_id,
                            localRevision: latest.local_revision,
                            content: latest.content
                        });
                    }
                }
            }

            // 先以云端为基准初始化编辑会话 (SYNC.md §1.1)
            this.sync.initSession(user.id, doc);

            // 若用户选择恢复草稿，将草稿内容填入编辑框并触发 onInput 登记未确认修改
            if (draftToApply) {
                this.titleInput.value = draftToApply.title;
                this.editor.value = draftToApply.content;
                this.sync.onInput(draftToApply.title, draftToApply.content);
            }

            this.renderPreview();
            this.renderDocumentList();
        } catch (e) {
            alert('读取文档失败: ' + e.message);
        }
    }

    async createNewDocument() {
        try {
            const doc = await ApiClient.documents.create('未命名文档', '# 新建文档\n\n开始编写内容...');
            this.documents.unshift({
                id: doc.id,
                title: doc.title,
                version: doc.version,
                created_at: doc.created_at,
                updated_at: doc.updated_at
            });
            await this.selectDocument(doc.id);
        } catch (e) {
            alert('创建文档失败: ' + e.message);
        }
    }

    async deleteCurrentDocument() {
        if (!this.currentDoc) return;
        if (!confirm(`确定要删除文档《${this.currentDoc.title}》吗？`)) return;

        try {
            await ApiClient.documents.delete(this.currentDoc.id, this.sync.baseVersion);
            this.documents = this.documents.filter(d => d.id !== this.currentDoc.id);
            this.currentDoc = null;
            if (this.documents.length > 0) {
                await this.selectDocument(this.documents[0].id);
            } else {
                await this.createNewDocument();
            }
        } catch (e) {
            alert('删除文档失败: ' + e.message);
        }
    }

    updateDocInList(doc) {
        const item = this.documents.find(d => d.id === doc.id);
        if (item) {
            item.title = doc.title;
            item.version = doc.version;
            item.updated_at = doc.updated_at;
            this.renderDocumentList();
        }
    }

    renderPreview() {
        const text = this.editor.value;
        this.preview.innerHTML = SafeMarkdownRenderer.render(text);

        const chars = text.length;
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        if (this.wordCountLabel) this.wordCountLabel.textContent = `${words} 词`;
        if (this.charCountLabel) this.charCountLabel.textContent = `${chars} 字符`;
    }

    initEventListeners() {
        // 编辑器实时输入
        this.editor.addEventListener('input', () => {
            this.renderPreview();
            this.sync.onInput(this.titleInput.value, this.editor.value);
        });

        // 标题输入
        this.titleInput.addEventListener('input', () => {
            this.sync.onInput(this.titleInput.value, this.editor.value);
        });

        // 快捷键 Ctrl+S / Cmd+S 立即触发保存 (SYNC.md §2)
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                this.sync.triggerSave();
            }
        });

        // 按钮监听
        document.getElementById('btn-new-doc')?.addEventListener('click', () => this.createNewDocument());
        document.getElementById('btn-delete-doc')?.addEventListener('click', () => this.deleteCurrentDocument());
        document.getElementById('btn-save-now')?.addEventListener('click', () => this.sync.triggerSave());
        document.getElementById('btn-toggle-gemini')?.addEventListener('click', () => this.copilot.toggle());

        // 登出
        document.getElementById('btn-logout')?.addEventListener('click', () => {
            ApiClient.clearToken();
            location.reload();
        });

        // 认证弹窗
        document.getElementById('auth-submit')?.addEventListener('click', () => this.handleAuthSubmit());
        document.getElementById('auth-tab-login')?.addEventListener('click', () => this.switchAuthTab(true));
        document.getElementById('auth-tab-register')?.addEventListener('click', () => this.switchAuthTab(false));
    }

    showAuthModal() {
        document.getElementById('auth-modal')?.classList.remove('hidden');
    }

    switchAuthTab(isLogin) {
        document.getElementById('auth-tab-login')?.classList.toggle('primary', isLogin);
        document.getElementById('auth-tab-register')?.classList.toggle('primary', !isLogin);
        document.getElementById('auth-title').textContent = isLogin ? '用户登录' : '用户注册';
        document.getElementById('auth-submit').textContent = isLogin ? '立即登录' : '立即注册';
    }

    async handleAuthSubmit() {
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value;
        const isLogin = document.getElementById('auth-title').textContent === '用户登录';
        const errBox = document.getElementById('auth-error');

        errBox.textContent = '';
        try {
            let resp;
            if (isLogin) {
                resp = await ApiClient.auth.login(username, password);
            } else {
                resp = await ApiClient.auth.register(username, password);
            }

            ApiClient.setToken(resp.token, resp.user);
            document.getElementById('auth-modal')?.classList.add('hidden');
            this.updateUserUI(resp.user);
            await this.loadDocuments();
        } catch (e) {
            errBox.textContent = e.message;
        }
    }

    showConflictModal(serverVersion) {
        const modal = document.getElementById('conflict-modal');
        if (!modal) return;
        modal.classList.remove('hidden');

        const btnOverwrite = document.getElementById('btn-conflict-overwrite');
        if (btnOverwrite) {
            btnOverwrite.onclick = async () => {
                modal.classList.add('hidden');
                await this.sync.resolveOverwrite(serverVersion);
            };
        }

        const btnReload = document.getElementById('btn-conflict-reload');
        if (btnReload) {
            btnReload.onclick = async () => {
                modal.classList.add('hidden');
                if (this.currentDoc) {
                    await this.selectDocument(this.currentDoc.id);
                }
            };
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
