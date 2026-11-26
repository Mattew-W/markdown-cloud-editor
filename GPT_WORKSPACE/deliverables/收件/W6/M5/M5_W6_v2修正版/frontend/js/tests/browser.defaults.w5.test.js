import assert from 'node:assert/strict';
import test from 'node:test';

import { apiFetch } from '../api.js';
import { SyncEngine, SyncState } from '../sync.js';

test('默认网络与定时器按浏览器要求使用全局对象', async () => {
  const storage = new Map();
  const engine = new SyncEngine({}, {
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  });
  const native = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    fetch: globalThis.fetch,
  };
  let nextTimer = 0;
  globalThis.setTimeout = function () {
    assert.equal(this, globalThis);
    return ++nextTimer;
  };
  globalThis.clearTimeout = function () {
    assert.equal(this, globalThis);
  };
  globalThis.fetch = function () {
    assert.equal(this, globalThis);
    return Promise.resolve(Response.json({ id: 'a', version: 2 }));
  };

  try {
    assert.equal((await apiFetch('/documents/a')).version, 2);
    engine.initSession('u1', 'token', { id: 'a', title: 'A', content: '', version: 1 });
    engine.onInput('A', 'edited');
    await engine.flushSave();
    assert.equal(engine.state, SyncState.SYNCED);
    assert.equal(engine.baseVersion, 2);
  } finally {
    engine.destroy();
    Object.assign(globalThis, native);
  }
});
