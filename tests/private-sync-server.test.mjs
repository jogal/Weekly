// Synthetic, mocked network only: node --test tests/private-sync-server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createHandler } from '../server/private-sync/handler.mjs';
import { readConfig, seal, unseal, SyncError } from '../server/private-sync/security.mjs';
import { createStore } from '../server/private-sync/store.mjs';
import { createGoogle, DRIVE_SCOPE } from '../server/private-sync/google.mjs';

const ORIGIN = 'https://weekly.example.test';
const DEVICE = 'test-device-0123456789';
const OP = 'test-operation-0123456789';
const ENV = {
  PRIVATE_SYNC_ENABLED: '1', PRIVATE_SYNC_APP_ORIGIN: ORIGIN,
  PRIVATE_SYNC_GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  PRIVATE_SYNC_GOOGLE_CLIENT_SECRET: 'synthetic-client-secret',
  PRIVATE_SYNC_OWNER_SUB: '123456789012345678901', PRIVATE_SYNC_OWNER_EMAIL: 'owner@example.test',
  PRIVATE_SYNC_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'),
  UPSTASH_REDIS_REST_URL: 'https://synthetic.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'synthetic-redis-token',
};
const CONFIG = readConfig(ENV);
const PAYLOAD = { schemaVersion: 1, habits: [{ id: 'habit1', name: 'Synthetic habit', unit: 'check',
  entries: [{ date: '2026-10-18', value: 1, completed: true }] }], reading: [], tasks: [] };
const clone = value => structuredClone(value);
function fakeRedis() {
  const values = new Map(); const commands = [];
  const fetcher = async (url, options) => {
    assert.equal(url, CONFIG.redisUrl); assert.equal(options.redirect, 'error');
    const command = JSON.parse(options.body); commands.push(command);
    if (command[0] === 'GET') return Response.json({ result: values.get(command[1]) ?? null });
    assert.equal(command[0], 'EVAL');
    const [, , , key, expected, next] = command;
    if ((values.get(key) ?? '') !== expected) return Response.json({ result: 0 });
    if (next === '') values.delete(key); else values.set(key, next);
    return Response.json({ result: 1 });
  };
  return { values, commands, store: createStore(CONFIG, fetcher) };
}
function fakeGoogle(clock) {
  const files = new Map(); let reserved = 0; let writes = 0; let exchanges = 0;
  const flags = { timeoutAfterWrite: false, wrongOwner: false, refreshFails: false };
  return {
    files, flags, get writes() { return writes; }, get exchanges() { return exchanges; },
    authorizationURL(state, challenge, nonce) { return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ state, challenge, nonce })}`; },
    async exchange(code, verifier, nonce) {
      exchanges++; assert.ok(code && verifier && nonce);
      if (flags.wrongOwner) throw new SyncError('owner_forbidden', 403);
      return { accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', expiresAt: clock() + 3600000 };
    },
    async refresh() {
      if (flags.refreshFails) throw new SyncError('auth_required', 401);
      return { accessToken: 'synthetic-refreshed-token', refreshToken: 'synthetic-refresh-token', expiresAt: clock() + 3600000 };
    },
    async reserveId() { return `reserved_${++reserved}`; },
    async inspect(accessToken, id) { assert.ok(accessToken); return clone(files.get(id) || null); },
    async write(accessToken, id, envelope, etag) {
      assert.ok(accessToken);
      const old = files.get(id);
      if (etag ? old?.etag !== etag : Boolean(old)) return false;
      files.set(id, { etag: `"etag-${++writes}"`, content: clone(envelope) });
      if (flags.timeoutAfterWrite) { flags.timeoutAfterWrite = false; throw new SyncError('provider_unavailable', 503); }
      return true;
    },
  };
}
function harness() {
  let time = Date.parse('2026-10-18T12:00:00Z');
  const clock = () => time;
  const redis = fakeRedis(); const google = fakeGoogle(clock);
  let handler = createHandler({ config: CONFIG, store: redis.store, google, now: clock });
  const makeBrowser = () => {
    let cookies = ''; let csrf = null;
    return {
      get cookies() { return cookies; }, get csrf() { return csrf; },
      async call(action, data, extras = {}) {
        const req = { url: `/api/private-sync?action=${action}`, method: data === undefined ? 'GET' : 'POST',
          body: data, headers: { cookie: cookies, origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': csrf, ...extras.headers }, ...extras };
        if (extras.headers) req.headers = { cookie: cookies, origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': csrf, ...extras.headers };
        const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
          status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() { return this; } };
        await handler(req, res);
        if (res.headers['set-cookie']) cookies = res.headers['set-cookie'].split(';')[0];
        if (res.body && Object.hasOwn(res.body, 'csrfToken')) csrf = res.body.csrfToken;
        return res;
      },
      async login(deviceId = DEVICE) {
        await this.call('status');
        const connected = await this.call('connect', { deviceId });
        assert.equal(connected.statusCode, 200);
        const state = new URL(connected.body.authorizationUrl).searchParams.get('state');
        const callback = await this.call(`callback&state=${state}&code=synthetic-code`);
        assert.equal(callback.statusCode, 303);
        assert.equal(callback.headers.location, `${ORIGIN}/tracker.html`);
        return this.call('status');
      },
    };
  };
  return { redis, google, browser: makeBrowser(), makeBrowser,
    advance(ms) { time += ms; }, restart() { handler = createHandler({ config: CONFIG, store: redis.store, google, now: clock }); } };
}
const initial = (overrides = {}) => ({ deviceId: DEVICE, operationId: OP, baseRevision: 0, payload: clone(PAYLOAD), ...overrides });

// Configuration / crypto / real Redis transport wrapper

test('missing or invalid activation config fails closed', async () => {
  for (const name of Object.keys(ENV)) assert.equal(readConfig({ ...ENV, [name]: '' }), null, name);
  assert.equal(readConfig({ ...ENV, PRIVATE_SYNC_APP_ORIGIN: 'http://example.test' }), null);
  assert.equal(readConfig({ ...ENV, UPSTASH_REDIS_REST_URL: 'https://untrusted.example.test' }), null);
  let body; const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(v) { body = v; } };
  await createHandler({ config: null })({ url: '/api/private-sync?action=status', method: 'GET' }, res);
  assert.equal(body.configured, false); assert.equal(body.connected, false);
});
test('AES-GCM authenticates each encrypted record and Redis CAS rejects stale state', async () => {
  const raw = seal({ refreshToken: 'secret' }, CONFIG.key, 'record-a');
  assert.ok(!raw.includes('secret'));
  assert.deepEqual(unseal(raw, CONFIG.key, 'record-a'), { refreshToken: 'secret' });
  assert.throws(() => unseal(raw, CONFIG.key, 'record-b'), /store_unavailable/);
  assert.throws(() => unseal(raw.slice(0, -4) + 'aaaa', CONFIG.key, 'record-a'), /store_unavailable/);
  const { store } = fakeRedis();
  assert.equal(await store.cas('a', null, { a: 1 }), true);
  assert.equal(await store.cas('a', null, { a: 2 }), false);
  const first = await store.get('a');
  assert.equal(await store.cas('a', first.raw, { a: 3 }), true);
  assert.equal(await store.cas('a', first.raw, { a: 4 }), false);
});
test('status uses secure cookies; mutation requires exact origin, JSON, and session CSRF', async () => {
  const h = harness(); const res = await h.browser.call('status');
  assert.equal(res.body.connected, false);
  assert.match(res.headers['set-cookie'], /HttpOnly; Secure; SameSite=Lax/);
  assert.match(res.headers['set-cookie'], /^__Host-weekly-sync=/);
  for (const headers of [{ origin: 'https://attacker.test' }, { origin: '' }, { 'x-csrf-token': 'wrong' }, { 'content-type': 'text/plain' }]) {
    assert.ok((await h.browser.call('connect', { deviceId: DEVICE }, { headers })).statusCode >= 400);
  }
  assert.equal(h.google.exchanges, 0);
});
test('OAuth state is browser-bound and one-use; callback URL is clean', async () => {
  const h = harness(); await h.browser.call('status');
  const connect = await h.browser.call('connect', { deviceId: DEVICE });
  const state = new URL(connect.body.authorizationUrl).searchParams.get('state');
  const other = h.makeBrowser(); await other.call('status');
  await other.call(`callback&state=${state}&code=synthetic-code`);
  assert.equal(h.google.exchanges, 0);
  await h.browser.call(`callback&state=${state}&code=synthetic-code`);
  assert.equal(h.google.exchanges, 1);
  await h.browser.call(`callback&state=${state}&code=synthetic-code`);
  assert.equal(h.google.exchanges, 1);
  assert.equal((await h.browser.call('status')).body.connected, true);
  assert.equal((await h.browser.call('status')).body.enabled, false);
});
test('wrong Google owner and second device never acquire owner access', async () => {
  const h = harness(); h.google.flags.wrongOwner = true;
  assert.equal((await h.browser.login()).body.connected, false);
  h.google.flags.wrongOwner = false;
  assert.equal((await h.browser.login()).body.connected, true);
  const second = h.makeBrowser();
  assert.equal((await second.login('another-device-01234567')).body.connected, false);
  assert.equal((await h.browser.call('status')).body.connected, true);
});
test('expired OAuth/session state is refused before exchanging a code', async () => {
  const h = harness(); await h.browser.call('status');
  const connect = await h.browser.call('connect', { deviceId: DEVICE });
  const state = new URL(connect.body.authorizationUrl).searchParams.get('state');
  h.advance(11 * 60000);
  await h.browser.call(`callback&state=${state}&code=synthetic-code`);
  assert.equal(h.google.exchanges, 0);
});
test('strict payload rejects extra private fields and empty feeds before any Drive call', async () => {
  const h = harness(); await h.browser.login();
  for (const payload of [{ ...PAYLOAD, notes: 'private' }, { schemaVersion: 1, habits: [], reading: [], tasks: [] },
    { ...PAYLOAD, habits: [{ ...PAYLOAD.habits[0], secret: 'private' }] }]) {
    const res = await h.browser.call('enable', initial({ payload }));
    assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'invalid_payload');
  }
  assert.equal(h.google.writes, 0);
});
test('enable/upload persist revisions; exact repeats do not rewrite and stale writes fail', async () => {
  const h = harness(); await h.browser.login();
  assert.equal((await h.browser.call('upload', initial())).body.error, 'sync_disabled');
  const first = await h.browser.call('enable', initial());
  assert.equal(first.statusCode, 200); assert.equal(first.body.revision, 1); assert.equal(first.body.enabled, true);
  assert.equal((await h.browser.call('enable', initial())).body.revision, 1); assert.equal(h.google.writes, 1);
  h.restart();
  const second = initial({ operationId: 'second-operation-0123456', baseRevision: 1 });
  assert.equal((await h.browser.call('upload', second)).body.revision, 2);
  assert.equal((await h.browser.call('upload', initial())).body.error, 'revision_conflict');
  assert.equal(h.google.writes, 2);
  const serialized = [...h.redis.values.values()].join('');
  for (const secret of ['synthetic-access-token', 'synthetic-refresh-token', 'Synthetic habit', h.browser.csrf]) assert.ok(!serialized.includes(secret));
  const file = [...h.google.files.values()][0].content;
  assert.deepEqual(Object.keys(file), ['schemaVersion', 'deviceId', 'revision', 'operationId', 'syncedAt', 'payload']);
  assert.ok(!JSON.stringify(file).includes('token'));
});
test('lost initial upload response reconciles reserved ID across server restart, without duplicates', async () => {
  const h = harness(); await h.browser.login(); h.google.flags.timeoutAfterWrite = true;
  assert.equal((await h.browser.call('enable', initial())).statusCode, 503);
  assert.equal((await h.browser.call('status')).body.revision, 0);
  assert.equal((await h.browser.call('status')).body.enabled, false);
  h.restart();
  assert.equal((await h.browser.call('enable', initial({ operationId: 'different-operation-01234' }))).body.error, 'pending_operation');
  const changed = clone(PAYLOAD); changed.habits[0].name = 'Changed synthetic';
  assert.equal((await h.browser.call('enable', initial({ payload: changed }))).body.error, 'operation_conflict');
  const retry = await h.browser.call('enable', initial());
  assert.equal(retry.statusCode, 200); assert.equal(retry.body.revision, 1);
  assert.equal(h.google.files.size, 1); assert.equal(h.google.writes, 1);
});
test('lost update response reconciles exact operation rather than stale overwrite', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  const update = initial({ operationId: 'second-operation-0123456', baseRevision: 1 });
  h.google.flags.timeoutAfterWrite = true;
  assert.equal((await h.browser.call('upload', update)).statusCode, 503);
  const retry = await h.browser.call('upload', update);
  assert.equal(retry.body.revision, 2); assert.equal(h.google.writes, 2);
});
test('external edits/deletion are never overwritten or recreated', async () => {
  for (const removed of [false, true]) {
    const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
    const id = [...h.google.files.keys()][0];
    if (removed) h.google.files.delete(id);
    else h.google.files.set(id, { etag: '"externally-edited"', content: { external: 'do not overwrite' } });
    const res = await h.browser.call('upload', initial({ operationId: 'second-operation-0123456', baseRevision: 1 }));
    assert.equal(res.body.error, 'external_change'); assert.equal(h.google.writes, 1);
  }
});
test('concurrent uploads serialize by durable CAS; duplicate same operation stays idempotent', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  const input = initial({ operationId: 'second-operation-0123456', baseRevision: 1 });
  const duplicate = await Promise.all([h.browser.call('upload', input), h.browser.call('upload', input)]);
  assert.ok(duplicate.every(res => res.statusCode === 200)); assert.equal(h.google.writes, 2);
  const competing = await Promise.all(['third-operation-01234567', 'fourth-operation-0123456'].map(operationId =>
    h.browser.call('upload', initial({ operationId, baseRevision: 2 }))));
  assert.equal(competing.filter(res => res.statusCode === 200).length, 1);
  assert.equal(competing.filter(res => res.statusCode === 409).length, 1);
  assert.equal(h.google.writes, 3);
});
test('disconnect deletes credentials/session, keeps file, and reconnect needs explicit enable', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  const oldCookie = h.browser.cookies; const oldCSRF = h.browser.csrf;
  const res = await h.browser.call('disconnect', {});
  assert.equal(res.statusCode, 200); assert.match(res.headers['set-cookie'], /Max-Age=0/);
  const owner = (await h.redis.store.get('owner')).value;
  assert.equal(owner.credentials, null); assert.equal(owner.enabled, false); assert.equal(h.google.files.size, 1);
  assert.ok((await h.browser.call('upload', initial(), { headers: { cookie: oldCookie, 'x-csrf-token': oldCSRF } })).statusCode >= 400);
  const connected = await h.browser.login(); assert.equal(connected.body.connected, true); assert.equal(connected.body.enabled, false);
  assert.equal(connected.body.revision, 1);
  assert.equal((await h.browser.call('enable', initial({ operationId: 'reenable-operation-01234', baseRevision: 1 }))).body.revision, 2);
});
test('expired/revoked refresh grant fails closed and does not upload', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  h.advance(3600000); h.google.flags.refreshFails = true;
  assert.equal((await h.browser.call('upload', initial({ operationId: 'second-operation-0123456', baseRevision: 1 }))).body.error, 'auth_required');
  assert.equal((await h.browser.call('status')).body.connected, false); assert.equal(h.google.writes, 1);
});

// Real Google adapter: synthetic RS256 identity + HTTP request inspection.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', use: 'sig', alg: 'RS256' };
const JWT_TIME = Date.parse('2026-10-18T12:00:00Z');
function signedToken(changes = {}, secret = keys.privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const claims = { iss: 'https://accounts.google.com', aud: CONFIG.clientId, sub: CONFIG.ownerSub,
    email: CONFIG.ownerEmail, email_verified: true, exp: JWT_TIME / 1000 + 3600, iat: JWT_TIME / 1000,
    nonce: 'synthetic-nonce', ...changes };
  const content = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), secret).toString('base64url')}`;
}
function googleIdentity(changes = {}, userChanges = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.ok(!url.includes('access-token')); assert.ok(!url.includes('refresh-token'));
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token', token_type: 'Bearer', expires_in: 3600,
      id_token: signedToken(changes), scope: `openid email ${DRIVE_SCOPE}` });
    if (url.endsWith('/certs')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/userinfo')) return Response.json({ sub: CONFIG.ownerSub, email: CONFIG.ownerEmail, email_verified: true, ...userChanges });
    throw new Error('unexpected network target');
  };
  return { calls, google: createGoogle(CONFIG, fetcher, () => JWT_TIME) };
}
test('real Google adapter validates signature, issuer, audience, nonce, owner and userinfo', async () => {
  const valid = googleIdentity(); const credentials = await valid.google.exchange('synthetic-code', 'synthetic-verifier', 'synthetic-nonce');
  assert.equal(credentials.refreshToken, 'synthetic-refresh-token');
  const params = new URLSearchParams(valid.calls[0].options.body);
  assert.equal(params.get('code_verifier'), 'synthetic-verifier'); assert.equal(params.get('redirect_uri'), CONFIG.callback);
  for (const bad of [{ sub: 'other' }, { email: 'other@example.test' }, { email_verified: false }, { nonce: 'wrong' },
    { iss: 'https://evil.test' }, { aud: 'other-client' }, { exp: JWT_TIME / 1000 - 1 }, { azp: 'other-client' }]) {
    await assert.rejects(googleIdentity(bad).google.exchange('synthetic-code', 'synthetic-verifier', 'synthetic-nonce'), /owner_forbidden/);
  }
  await assert.rejects(googleIdentity({}, { sub: 'other' }).google.exchange('synthetic-code', 'synthetic-verifier', 'synthetic-nonce'), /owner_forbidden/);
  const url = new URL(valid.google.authorizationURL('state', 'challenge', 'nonce'));
  assert.equal(url.searchParams.get('access_type'), 'offline'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), `openid email ${DRIVE_SCOPE}`);
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
});
function meta(etag = '"etag-a"', extra = {}) { return { id: 'file1', etag, mimeType: 'application/json', labels: { trashed: false }, shared: false, ownedByMe: true, ...extra }; }
test('real Drive adapter uses private My Drive and If-Match, never permissions/appData', async () => {
  const calls = [];
  const google = createGoogle(CONFIG, async (url, options) => { calls.push({ url, options }); return Response.json(meta()); });
  const envelope = { schemaVersion: 1, deviceId: DEVICE, revision: 1, operationId: OP, syncedAt: new Date(JWT_TIME).toISOString(), payload: PAYLOAD };
  await google.write('synthetic-access-token', 'file1', envelope, null);
  await google.write('synthetic-access-token', 'file1', envelope, '"etag-a"');
  assert.equal(calls[0].options.method, 'POST'); assert.match(calls[0].url, /visibility=PRIVATE/);
  assert.match(calls[0].options.body, /"parents":\[\{"id":"root"\}\]/);
  assert.equal(calls[1].options.method, 'PUT'); assert.equal(calls[1].options.headers['If-Match'], '"etag-a"');
  assert.ok(calls.every(call => !/permissions|appDataFolder/.test(call.url + call.options.body)));
  for (const extra of [{ shared: true }, { driveId: 'shared-drive' }, { ownedByMe: false }, { labels: { trashed: true } }, { etag: undefined }]) {
    const unsafe = createGoogle(CONFIG, async () => Response.json(meta('"etag-a"', extra)));
    await assert.rejects(unsafe.inspect('synthetic-access-token', 'file1'), /external_change/);
  }
});
test('Drive reads reject files changing between metadata and media reads', async () => {
  let count = 0;
  const google = createGoogle(CONFIG, async url => {
    if (url.includes('alt=media')) return Response.json({ synthetic: true });
    return Response.json(meta(++count === 1 ? '"before"' : '"after"'));
  });
  await assert.rejects(google.inspect('synthetic-access-token', 'file1'), /external_change/);
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('a delayed duplicate cannot overwrite a later committed Drive operation', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  const delayed = initial({ operationId: 'delayed-operation-012345', baseRevision: 1 });
  const entered = deferred(); const release = deferred();
  const write = h.google.write.bind(h.google); let intercept = true;
  h.google.write = async (...args) => {
    if (intercept && args[2].operationId === delayed.operationId) {
      intercept = false; entered.resolve(); await release.promise;
    }
    return write(...args);
  };
  const stale = h.browser.call('upload', delayed);
  await entered.promise;
  assert.equal((await h.browser.call('upload', delayed)).body.revision, 2);
  const newer = initial({ operationId: 'newer-operation-01234567', baseRevision: 2 });
  assert.equal((await h.browser.call('upload', newer)).body.revision, 3);
  release.resolve();
  assert.equal((await stale).body.error, 'external_change');
  assert.equal((await h.browser.call('status')).body.revision, 3);
  assert.equal([...h.google.files.values()][0].content.operationId, newer.operationId);
  assert.equal(h.google.writes, 3);
});
test('disconnect during token refresh cannot resurrect credentials or complete an upload', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial()); h.advance(3600000);
  const entered = deferred(); const release = deferred(); const refresh = h.google.refresh.bind(h.google);
  h.google.refresh = async (...args) => { entered.resolve(); await release.promise; return refresh(...args); };
  const waiting = h.browser.call('upload', initial({ operationId: 'waiting-operation-012345', baseRevision: 1 }));
  await entered.promise;
  assert.equal((await h.browser.call('disconnect', {})).statusCode, 200);
  release.resolve();
  assert.equal((await waiting).body.error, 'auth_required');
  const owner = (await h.redis.store.get('owner')).value;
  assert.equal(owner.credentials, null); assert.equal(owner.enabled, false); assert.equal(h.google.writes, 1);
});
test('in-flight write may finish after disconnect but cannot restore session; reconnect reconciles while disabled', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  const queued = initial({ operationId: 'inflight-operation-01234', baseRevision: 1 });
  const entered = deferred(); const release = deferred(); const write = h.google.write.bind(h.google);
  h.google.write = async (...args) => { entered.resolve(); await release.promise; return write(...args); };
  const waiting = h.browser.call('upload', queued);
  await entered.promise; await h.browser.call('disconnect', {}); release.resolve();
  assert.equal((await waiting).body.error, 'auth_required');
  assert.equal((await h.redis.store.get('owner')).value.credentials, null);
  await h.browser.login();
  const reconciled = await h.browser.call('upload', queued);
  assert.equal(reconciled.statusCode, 200); assert.equal(reconciled.body.revision, 2); assert.equal(reconciled.body.enabled, false);
  assert.equal(h.google.writes, 2);
});
test('pending-disabled differs from definitive sync-disabled; explicit same-operation enable resumes', async () => {
  const h = harness(); await h.browser.login();
  const write = h.google.write.bind(h.google);
  h.google.write = async () => { throw new SyncError('provider_unavailable', 503); };
  assert.equal((await h.browser.call('enable', initial())).statusCode, 503);
  await h.browser.call('disconnect', {}); await h.browser.login();
  assert.equal((await h.browser.call('upload', initial())).body.error, 'pending_disabled');
  h.google.write = write;
  assert.equal((await h.browser.call('enable', initial())).body.revision, 1);
  await h.browser.call('disconnect', {}); await h.browser.login();
  const acknowledged = await h.browser.call('upload', initial());
  assert.equal(acknowledged.statusCode, 200); assert.equal(acknowledged.body.enabled, false);
  assert.equal((await h.browser.call('upload', initial({ operationId: 'different-operation-0123' }))).body.error, 'revision_conflict');
  assert.equal((await h.browser.call('upload', initial({ operationId: 'different-operation-0123', baseRevision: 1 }))).body.error, 'sync_disabled');
});
test('callback failures expose only a safe status code after clean redirect', async () => {
  const h = harness(); h.google.flags.wrongOwner = true;
  const result = await h.browser.login();
  assert.equal(result.body.authError, 'owner_forbidden');
  assert.ok(!JSON.stringify(result.body).includes('owner@example.test'));
  assert.ok(!JSON.stringify(result.body).includes('synthetic-code'));
});
test('Google ID token signature and access-token hash are mandatory when present', async () => {
  const badSignature = signedToken().split('.'); badSignature[2] = Buffer.alloc(256).toString('base64url');
  const fake = createGoogle(CONFIG, async url => {
    if (url.endsWith('/token')) return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token',
      token_type: 'Bearer', expires_in: 3600, id_token: badSignature.join('.'), scope: `openid email ${DRIVE_SCOPE}` });
    if (url.endsWith('/certs')) return Response.json({ keys: [jwk] });
    throw new Error('userinfo must not be reached');
  }, () => JWT_TIME);
  await assert.rejects(fake.exchange('code', 'verifier', 'synthetic-nonce'), /owner_forbidden/);
  await assert.rejects(googleIdentity({ at_hash: 'wrong' }).google.exchange('code', 'verifier', 'synthetic-nonce'), /owner_forbidden/);
  const at_hash = createHash('sha256').update('synthetic-access-token').digest().subarray(0, 16).toString('base64url');
  assert.ok((await googleIdentity({ at_hash }).google.exchange('code', 'verifier', 'synthetic-nonce')).accessToken);
});

test('a delayed pre-write fence reports a revision conflict, never definite non-application', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  const queued = initial({ operationId: 'fenced-operation-0123456', baseRevision: 1 });
  const entered = deferred(); const release = deferred(); const inspect = h.google.inspect.bind(h.google);
  let first = true;
  h.google.inspect = async (...args) => {
    const snapshot = await inspect(...args);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return snapshot;
  };
  const delayed = h.browser.call('upload', queued);
  await entered.promise;
  assert.equal((await h.browser.call('upload', queued)).body.revision, 2);
  assert.equal((await h.browser.call('upload', initial({ operationId: 'later-operation-01234567', baseRevision: 2 }))).body.revision, 3);
  release.resolve();
  assert.equal((await delayed).body.error, 'revision_conflict');
  assert.equal(h.google.writes, 3);
});
