// tests/frontend/setup.js
export function createMockStorage() {
    const store = new Map();
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        removeItem(key) {
            store.delete(key);
        },
        clear() {
            store.clear();
        },
        key(index) {
            return Array.from(store.keys())[index] || null;
        },
        get length() {
            return store.size;
        }
    };
}

if (!globalThis.localStorage) {
    globalThis.localStorage = createMockStorage();
}
if (!globalThis.sessionStorage) {
    globalThis.sessionStorage = createMockStorage();
}
