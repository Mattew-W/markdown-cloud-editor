/**
 * Gemini 3.8 Flash Markdown Studio - AI 协同助理面板交互控制器
 */

import { ApiClient } from './api.js';

export class GeminiCopilot {
    constructor(editorTextarea, options = {}) {
        this.editor = editorTextarea;
        this.drawer = document.getElementById('gemini-drawer');
        this.outputBox = document.getElementById('ai-output');
        this.statusText = document.getElementById('ai-status');
        this.chatHistory = [];
        this.lastAiResult = '';

        this.initEventListeners();
    }

    toggle() {
        if (!this.drawer) return;
        this.drawer.classList.toggle('hidden');
    }

    setStatus(text, isError = false) {
        if (this.statusText) {
            this.statusText.textContent = text;
            this.statusText.style.color = isError ? 'var(--danger)' : 'var(--accent)';
        }
    }

    setOutput(text) {
        this.lastAiResult = text;
        if (this.outputBox) {
            this.outputBox.textContent = text;
        }
    }

    initEventListeners() {
        // 快捷指令按钮
        document.getElementById('btn-ai-complete')?.addEventListener('click', () => this.handleComplete());
        document.getElementById('btn-ai-polish')?.addEventListener('click', () => this.handlePolish());
        document.getElementById('btn-ai-summarize')?.addEventListener('click', () => this.handleSummarize());
        document.getElementById('btn-ai-diagram')?.addEventListener('click', () => this.handleDiagram());
        document.getElementById('btn-ai-math')?.addEventListener('click', () => this.handleMath());

        // 操作按钮
        document.getElementById('btn-insert-cursor')?.addEventListener('click', () => this.insertAtCursor(this.lastAiResult));
        document.getElementById('btn-replace-selection')?.addEventListener('click', () => this.replaceSelection(this.lastAiResult));
        document.getElementById('btn-copy-ai')?.addEventListener('click', () => {
            navigator.clipboard.writeText(this.lastAiResult);
            this.setStatus('已复制到剪贴板！');
        });

        // 聊天发送
        const chatInput = document.getElementById('ai-chat-input');
        const sendBtn = document.getElementById('btn-ai-send');
        const doSend = async () => {
            const msg = chatInput.value.trim();
            if (!msg) return;
            chatInput.value = '';
            await this.handleChat(msg);
        };

        sendBtn?.addEventListener('click', doSend);
        chatInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                doSend();
            }
        });
    }

    getSelectionOrAll() {
        const start = this.editor.selectionStart;
        const end = this.editor.selectionEnd;
        const text = this.editor.value;
        if (start !== end) {
            return text.substring(start, end);
        }
        return text;
    }

    insertAtCursor(text) {
        if (!text) return;
        const start = this.editor.selectionStart;
        const end = this.editor.selectionEnd;
        const val = this.editor.value;
        this.editor.value = val.substring(0, start) + text + val.substring(end);
        this.editor.selectionStart = this.editor.selectionEnd = start + text.length;
        this.editor.focus();
        this.editor.dispatchEvent(new Event('input'));
        this.setStatus('已插入至光标位置');
    }

    replaceSelection(text) {
        if (!text) return;
        const start = this.editor.selectionStart;
        const end = this.editor.selectionEnd;
        if (start !== end) {
            this.insertAtCursor(text);
        } else {
            this.editor.value = text;
            this.editor.dispatchEvent(new Event('input'));
        }
        this.setStatus('已替换目标文本');
    }

    async handleComplete() {
        const text = this.editor.value;
        const start = this.editor.selectionStart;
        const prompt = text.substring(0, start) || text;

        this.setStatus('Gemini 3.8 Flash 正在续写...');
        try {
            const resp = await ApiClient.ai.complete(prompt);
            this.setOutput(resp.result);
            this.setStatus(`生成完成 (${resp.model})`);
        } catch (e) {
            this.setStatus(`续写失败: ${e.message}`, true);
        }
    }

    async handlePolish() {
        const content = this.getSelectionOrAll();
        if (!content.trim()) {
            this.setStatus('请先选中或输入需要润色的 Markdown 内容', true);
            return;
        }

        this.setStatus('Gemini 3.8 Flash 正在润色排版...');
        try {
            const resp = await ApiClient.ai.polish(content);
            this.setOutput(resp.result);
            this.setStatus(`润色完成 (${resp.model})`);
        } catch (e) {
            this.setStatus(`润色失败: ${e.message}`, true);
        }
    }

    async handleSummarize() {
        const content = this.editor.value;
        if (!content.trim()) {
            this.setStatus('当前文档内容为空，无法提取摘要', true);
            return;
        }

        this.setStatus('Gemini 3.8 Flash 正在提炼核心要点...');
        try {
            const resp = await ApiClient.ai.summarize(content);
            this.setOutput(resp.result);
            this.setStatus(`摘要提取成功 (${resp.model})`);
        } catch (e) {
            this.setStatus(`摘要提取失败: ${e.message}`, true);
        }
    }

    async handleDiagram() {
        const desc = this.getSelectionOrAll();
        if (!desc.trim()) {
            this.setStatus('请选中或输入流程/结构描述', true);
            return;
        }

        this.setStatus('Gemini 3.8 Flash 正在生成 Mermaid 图表...');
        try {
            const resp = await ApiClient.ai.diagram(desc);
            this.setOutput(resp.result);
            this.setStatus(`图表生成完成 (${resp.model})`);
        } catch (e) {
            this.setStatus(`图表推导失败: ${e.message}`, true);
        }
    }

    async handleMath() {
        const desc = this.getSelectionOrAll();
        if (!desc.trim()) {
            this.setStatus('请选中或输入数学公式描述', true);
            return;
        }

        this.setStatus('Gemini 3.8 Flash 正在构建 LaTeX 公式...');
        try {
            const resp = await ApiClient.ai.math(desc);
            this.setOutput(resp.result);
            this.setStatus(`公式构建完成 (${resp.model})`);
        } catch (e) {
            this.setStatus(`公式构建失败: ${e.message}`, true);
        }
    }

    async handleChat(userMessage) {
        this.setStatus('Gemini 3.8 Flash 思考中...');
        try {
            const docContext = this.editor.value;
            this.chatHistory.push({ role: 'user', content: userMessage });

            const resp = await ApiClient.ai.chat(userMessage, docContext, this.chatHistory);
            this.chatHistory.push({ role: 'model', content: resp.result });

            this.setOutput(`Q: ${userMessage}\n\n🤖 Gemini 3.8 Flash:\n${resp.result}`);
            this.setStatus(`对话就绪 (${resp.model})`);
        } catch (e) {
            this.setStatus(`对话异常: ${e.message}`, true);
        }
    }
}
