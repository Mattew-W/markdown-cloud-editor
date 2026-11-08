/**
 * Gemini 3.8 Flash Markdown Studio - 安全渲染引擎 (严格对齐 ARCHITECTURE.md §3.4)
 * 核心规范：DOMPurify.sanitize(marked.parse(text))
 * 绝不使用脆弱的无清洗正则，彻底杜绝 XSS 攻击
 */

export class SafeMarkdownRenderer {
    /**
     * 安全渲染入口 (ARCHITECTURE.md §3.4)
     * @param {string} text Markdown 原文
     * @returns {string} 净化后的安全 HTML
     */
    static render(text) {
        if (!text) return '';

        // 1. 如果全局环境具备 marked 与 DOMPurify
        if (typeof window !== 'undefined' && window.marked && window.DOMPurify) {
            const rawHtml = window.marked.parse(text, {
                gfm: true,
                breaks: true
            });
            return window.DOMPurify.sanitize(rawHtml, {
                ADD_TAGS: ['iframe', 'input'],
                ADD_ATTR: ['target', 'disabled', 'checked', 'type']
            });
        }

        // 2. 备用安全转义渲染器 (若未加载到 vendor 库)
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        const escaped = text.replace(/[&<>"']/g, m => map[m]);

        return `<pre><code>${escaped}</code></pre>`;
    }
}
