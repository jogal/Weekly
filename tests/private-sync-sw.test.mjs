import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
function worker() {
  const events = {}, cacheNames = new Map(), reads = [], writes = [], fetches = [];
  let response = { ok: true, redirected: false, headers: new Headers(), clone() { return this; } };
  const makeCache = name => {
    if (!cacheNames.has(name)) cacheNames.set(name, new Map());
    const cache = cacheNames.get(name);
    return {
      addAll: async () => {}, keys: async () => [...cache.keys()].map(url => ({ url })),
      delete: async req => cache.delete(req.url), put: async (req, res) => { writes.push(req.url); cache.set(req.url, res); },
    };
  };
  const caches = {
    keys: async () => [...cacheNames.keys()], delete: async name => cacheNames.delete(name), open: async name => makeCache(name),
    match: async req => { reads.push(req.url); for (const c of cacheNames.values()) if (c.has(req.url)) return c.get(req.url); },
  };
  vm.runInNewContext(code, { URL, caches, fetch: async req => { fetches.push(req.url); return response; },
    self: { location: { origin: 'https://weekly.test' }, clients: { claim: async () => {} }, skipWaiting: async () => {}, addEventListener: (name, fn) => events[name] = fn } });
  return { events, cacheNames, reads, writes, fetches, setResponse: r => { response = r; } };
}
async function dispatch(w, url, method = 'GET') {
  let result;
  w.events.fetch({ request: { url, method }, respondWith: p => { result = p; } });
  if (result) await result;
  await new Promise(resolve => setImmediate(resolve));
  return result;
}

test('all private API/auth GET routes bypass cache lookup even with old cached data', async () => {
  const w = worker();
  w.cacheNames.set('legacy', new Map([['https://weekly.test/api/private-sync?action=status', { csrfToken: 'old' }]]));
  for (const path of ['/api/private-sync?action=status', '/api/private-sync?action=callback&code=synthetic', '/api/coach', '/api', '/auth/start', '/auth']) {
    assert.equal(await dispatch(w, 'https://weekly.test' + path), undefined);
  }
  assert.deepEqual(w.reads, []); assert.deepEqual(w.writes, []); assert.deepEqual(w.fetches, []);
});

test('activation deletes old caches and scrubs private entries from current cache', async () => {
  const w = worker(), name = code.match(/const CACHE = "([^"]+)"/)[1];
  w.cacheNames.set('legacy', new Map([['https://weekly.test/api/old', {}]]));
  w.cacheNames.set(name, new Map([['https://weekly.test/api/private-sync?action=status', {}], ['https://weekly.test/auth/callback', {}], ['https://weekly.test/tracker.html', {}]]));
  let done; w.events.activate({ waitUntil: p => { done = p; } }); await done;
  assert.deepEqual([...w.cacheNames.keys()], [name]);
  assert.deepEqual([...w.cacheNames.get(name).keys()], ['https://weekly.test/tracker.html']);
});

test('ordinary static GET remains cacheable while POST never touches cache', async () => {
  const w = worker();
  await dispatch(w, 'https://weekly.test/js/habit-core.mjs');
  assert.deepEqual(w.writes, ['https://weekly.test/js/habit-core.mjs']);
  w.reads.length = 0; w.writes.length = 0;
  assert.equal(await dispatch(w, 'https://weekly.test/other', 'POST'), undefined);
  assert.deepEqual(w.reads, []); assert.deepEqual(w.writes, []);
});

test('private/no-store and redirected responses never enter runtime cache', async () => {
  for (const cacheControl of ['private', 'max-age=0, no-store', 'PRIVATE, max-age=30']) {
    const w = worker(); w.setResponse({ ok: true, redirected: false, headers: new Headers({ 'cache-control': cacheControl }), clone() { return this; } });
    await dispatch(w, 'https://weekly.test/safe-looking'); assert.deepEqual(w.writes, []);
  }
  const w = worker(); w.setResponse({ ok: true, redirected: true, headers: new Headers(), clone() { return this; } });
  await dispatch(w, 'https://weekly.test/safe-looking'); assert.deepEqual(w.writes, []);
});

test('new worker proves private-route cache safety through a dedicated message channel', () => {
  const w = worker(), replies = [];
  w.events.message({ data: { type: 'weekly-private-sync-cache-check', version: 1 }, ports: [{ postMessage: value => replies.push(JSON.parse(JSON.stringify(value))) }] });
  assert.deepEqual(replies, [{ type: 'weekly-private-sync-cache-safe', version: 1 }]);
  w.events.message({ data: { type: 'weekly-private-sync-cache-check', version: 2 }, ports: [{ postMessage: value => replies.push(value) }] });
  assert.equal(replies.length, 1);
});
