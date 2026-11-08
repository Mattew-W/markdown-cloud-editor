/**
 * Gemini 3.8 Flash Markdown Studio - 核心 HTTP 客户端
 * 统一网络出口，自动注入 JWT 与统一处理状态码
 */

const API_BASE = '/api/v1';

export class ApiClient {
    static getToken() {
        return sessionStorage.getItem('gemini_auth_token') || localStorage.getItem('gemini_auth_token');
    }

    static setToken(token, user, remember = true) {
        if (remember) {
            localStorage.setItem('gemini_auth_token', token);
            localStorage.setItem('gemini_user', JSON.stringify(user));
        }
        sessionStorage.setItem('gemini_auth_token', token);
        sessionStorage.setItem('gemini_user', JSON.stringify(user));
    }

    static clearToken() {
        sessionStorage.removeItem('gemini_auth_token');
        sessionStorage.removeItem('gemini_user');
        localStorage.removeItem('gemini_auth_token');
        localStorage.removeItem('gemini_user');
    }

    static getCurrentUser() {
        const u = sessionStorage.getItem('gemini_user') || localStorage.getItem('gemini_user');
        return u ? JSON.parse(u) : null;
    }

    static async request(endpoint, options = {}) {
        const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };

        const token = this.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const config = {
            ...options,
            headers
        };

        const response = await fetch(url, config);

        if (response.status === 204) {
            return null;
        }

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const error = new Error(data.error?.message || `HTTP ${response.status}`);
            error.status = response.status;
            error.code = data.error?.code || 'UNKNOWN_ERROR';
            error.details = data.error?.details;
            throw error;
        }

        return data;
    }

    // 认证接口
    static auth = {
        register: (username, password) => ApiClient.request('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        }),
        login: (username, password) => ApiClient.request('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        })
    };

    // 文档管理接口
    static documents = {
        list: (limit = 50, offset = 0) => ApiClient.request(`/documents?limit=${limit}&offset=${offset}`),
        create: (title, content) => ApiClient.request('/documents', {
            method: 'POST',
            body: JSON.stringify({ title, content })
        }),
        get: (id) => ApiClient.request(`/documents/${id}`),
        update: (id, title, content, expected_version, options = {}) => ApiClient.request(`/documents/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ title, content, expected_version }),
            ...options
        }),
        delete: (id, expected_version, options = {}) => ApiClient.request(`/documents/${id}?expected_version=${expected_version}`, {
            method: 'DELETE',
            ...options
        })
    };

    // Gemini 3.8 Flash AI Copilot 接口
    static ai = {
        complete: (prompt, max_tokens = 512) => ApiClient.request('/ai/complete', {
            method: 'POST',
            body: JSON.stringify({ prompt, max_tokens })
        }),
        polish: (content, instruction) => ApiClient.request('/ai/polish', {
            method: 'POST',
            body: JSON.stringify({ content, instruction })
        }),
        summarize: (content, format = 'bullet_points') => ApiClient.request('/ai/summarize', {
            method: 'POST',
            body: JSON.stringify({ content, format })
        }),
        diagram: (description, diagram_type = 'flowchart') => ApiClient.request('/ai/diagram', {
            method: 'POST',
            body: JSON.stringify({ description, diagram_type })
        }),
        math: (description) => ApiClient.request('/ai/math', {
            method: 'POST',
            body: JSON.stringify({ description })
        }),
        chat: (message, document_context, history = []) => ApiClient.request('/ai/chat', {
            method: 'POST',
            body: JSON.stringify({ message, document_context, history })
        })
    };
}
