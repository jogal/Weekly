// Synthetic, mocked network only: node --test tests/private-sync-server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createHandler } from '../server/private-sync/handler.mjs';
import { readConfig, seal, unseal, SyncError } from '../server/private-sync/security.mjs';
import { createStore } from '../server/private-sync/store.mjs';
import { createNotion } from '../server/private-sync/notion.mjs';
import { createGoogle } from '../server/private-sync/google.mjs';
import { buildPayload, MAX_PAYLOAD_BYTES } from '../js/private-sync-protocol.mjs';
import { addDays } from '../js/habit-core.mjs';

const ORIGIN = 'https://weekly.example.test';
const DEVICE = 'test-device-0123456789';
const OP = 'test-operation-0123456789';
const ENV = {
  PRIVATE_SYNC_NOTION_TOKEN: 'synthetic-notion-token', PRIVATE_SYNC_NOTION_PAGE_ID: '00000000-0000-0000-0000-000000000001',
  PRIVATE_SYNC_NOTION_PRIVATE_CONFIRMED: '1', PRIVATE_SYNC_ENABLED: '1', PRIVATE_SYNC_APP_ORIGIN: ORIGIN,
  PRIVATE_SYNC_GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com',
  PRIVATE_SYNC_GOOGLE_CLIENT_SECRET: 'synthetic-client-secret',
  PRIVATE_SYNC_OWNER_SUB: '123456789012345678901', PRIVATE_SYNC_OWNER_EMAIL: 'owner@example.test',
  PRIVATE_SYNC_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'),
  UPSTASH_REDIS_REST_URL: 'https://synthetic.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'synthetic-redis-token',
};
const CONFIG = readConfig(ENV);
const SOURCES = {
  wt_habits_v1: { habits: [{ id: 'habit1', name: 'Synthetic habit', link: null,
    goal: { type: 'check', target: 1 }, freq: { type: 'daily', days: [], times: 1 },
    createdOn: '2026-10-18', archived: false }] },
  wt_habit_log_v1: { '2026-10-18': { habit1: { n: 1 } } },
};
const PAYLOAD = buildPayload({ getItem: key => key in SOURCES ? JSON.stringify(SOURCES[key]) : null },
  { asOf: '2026-10-18', timeZone: 'Asia/Tokyo' });
const clone = value => structuredClone(value);
let largeFixture;
function largePayload() {
  if (largeFixture) return largeFixture;
  const habits = Array.from({ length: 12 }, (_, n) => ({ ...SOURCES.wt_habits_v1.habits[0],
    id: 'large_' + n, name: 'Synthetic long history ' + n, createdOn: '2024-01-01' }));
  const log = Object.fromEntries(Array.from({ length: 1000 }, (_, day) => [addDays('2024-01-01', day),
    Object.fromEntries(habits.map(h => [h.id, { n: 1 }]))]));
  const values = { wt_habits_v1: { habits }, wt_habit_log_v1: log };
  largeFixture = buildPayload({ getItem: key => key in values ? JSON.stringify(values[key]) : null },
    { asOf: '2026-10-18', timeZone: 'Asia/Tokyo' });
  return largeFixture;
}
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
function fakeGoogle() {
  let exchanges = 0; const flags = { wrongOwner: false };
  return {
    flags, get exchanges() { return exchanges; },
    authorizationURL(state, challenge, nonce) { return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ state, challenge, nonce })}`; },
    async exchange() { exchanges++; if(flags.wrongOwner) throw new SyncError('owner_forbidden',403); return {identityVerified:true}; },
  };
}
function fakeNotion() {
  const files = new Map(); let writes = 0; const flags = { timeoutAfterWrite: false };
  return {files, flags, get writes() {return writes;}, async publish(envelope, {authorize, state, checkpoint}) {
    if (files.has(envelope.operationId)) return {snapshotId:envelope.operationId};
    await authorize();
    if (!await checkpoint(state, {phase:'creating'})) throw new SyncError('retry_later',503);
    await authorize();
    files.set(envelope.operationId,{content:clone(envelope)}); writes++;
    if(flags.timeoutAfterWrite) {flags.timeoutAfterWrite=false;throw new SyncError('provider_unavailable',503);}
    return {snapshotId:envelope.operationId};
  }};
}
function harness() {
  let time = Date.parse('2026-10-18T12:00:00Z');
  const clock = () => time;
  const redis = fakeRedis(); const google = fakeGoogle(clock); const notion = fakeNotion();
  let handler = createHandler({ config: CONFIG, store: redis.store, google, notion, now: clock });
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
  return { redis, google, notion, browser: makeBrowser(), makeBrowser,
    advance(ms) { time += ms; }, restart() { handler = createHandler({ config: CONFIG, store: redis.store, google, notion, now: clock }); } };
}
const initial = (overrides = {}) => ({ deviceId: DEVICE, operationId: OP, baseRevision: 0, consentVersion: 3, payload: clone(PAYLOAD), ...overrides });

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
test('strict payload rejects extra private fields and empty feeds before any Notion call', async () => {
  const h = harness(); await h.browser.login();
  for (const payload of [{ ...PAYLOAD, notes: 'private' }, { schemaVersion: 1, habits: [], reading: [], tasks: [] },
    { ...PAYLOAD, habits: [{ ...PAYLOAD.habits[0], secret: 'private' }] }]) {
    const res = await h.browser.call('enable', initial({ payload }));
    assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'invalid_payload');
  }
  assert.equal(h.notion.writes, 0);
});
test('legacy server consent cannot authorize category-wide v2 uploads', async () => {
  const h = harness(); await h.browser.login();
  assert.equal((await h.browser.call('enable', initial())).statusCode, 200);
  const before = await h.redis.store.get('owner');
  assert.equal(before.value.consentVersion, 3);
  const old = clone(before.value); delete old.consentVersion;
  await h.redis.store.cas('owner', before.raw, old);
  const update = initial({ operationId: 'new-scope-operation-012345', baseRevision: 1 });
  const blocked = await h.browser.call('upload', update);
  assert.equal(blocked.statusCode, 409); assert.equal(blocked.body.error, 'scope_review_required');
  assert.equal(h.notion.writes, 1);
  assert.equal((await h.browser.call('enable', update)).statusCode, 200);
  assert.equal((await h.redis.store.get('owner')).value.consentVersion, 3);
  assert.equal(h.notion.writes, 2);
});
test('v1 uploads and arbitrary routine/statistics objects are rejected before Notion writes', async () => {
  const h = harness(); await h.browser.login();
  for (const payload of [
    { schemaVersion: 1, habits: [{ id: 'h', name: 'Old scope', unit: 'check', entries: [{ date: '2026-10-18', value: 1, completed: true }] }], reading: [], tasks: [] },
    { ...PAYLOAD, routines: [{ name: 'Synthetic', notes: 'PRIVATE_CANARY' }] },
    { ...PAYLOAD, statistics: { secret: 'PRIVATE_CANARY' } },
    { ...PAYLOAD, statistics: { ...PAYLOAD.statistics, tasks: { ...PAYLOAD.statistics.tasks, total: 99 } } },
    { ...PAYLOAD, health: { pain: 'PRIVATE_CANARY' } },
  ]) {
    const res = await h.browser.call('enable', initial({ payload }));
    assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'invalid_payload');
  }
  assert.equal(h.notion.writes, 0);
});
test('authenticated v2 enable writes all four approved projections without free-text canaries', async () => {
  const sources = { ...SOURCES,
    wt_reading_v1: { books: [{ id: 'b_one', title: 'Synthetic book', pages: 200, status: 'reading',
      notes: 'PRIVATE_CANARY', review: 'PRIVATE_CANARY', log: { '2026-10-18': { page: 12, note: 'PRIVATE_CANARY' } } }] },
    wt_todo_v1: { tasks: [{ id: 't_one', name: 'Synthetic task', createdOn: '2026-10-17', due: '2026-10-20',
      description: 'PRIVATE_CANARY', steps: [{ name: 'PRIVATE_CANARY', doneOn: '2026-10-18' }] }],
      routines: [{ id: 'r_one', name: 'Synthetic routine', createdOn: '2026-10-17', avoid: false, notes: 'PRIVATE_CANARY' }],
      rlog: { '2026-10-18': { r_one: 1 } } },
  };
  const payload = buildPayload({ getItem: key => key in sources ? JSON.stringify(sources[key]) : null },
    { asOf: '2026-10-18', timeZone: 'Asia/Tokyo' });
  const h = harness(); await h.browser.login();
  assert.equal((await h.browser.call('enable', initial({ payload }))).statusCode, 200);
  const file = [...h.notion.files.values()][0].content;
  for (const category of ['habits', 'routines', 'reading', 'tasks']) assert.equal(file.payload[category].length, 1);
  assert.equal(file.payload.statistics.tasks.completedSteps, 1);
  assert.equal(file.payload.statistics.reading.recent.pages, 12);
  assert.ok(!JSON.stringify(file).includes('PRIVATE_CANARY'));
});
test('large automatic history survives encrypted durable reservation and lost-ACK recovery intact', async () => {
  const h = harness(); await h.browser.login();
  const payload = largePayload();
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 600_000);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < MAX_PAYLOAD_BYTES);
  h.notion.flags.timeoutAfterWrite = true;
  const request = initial({ payload });
  assert.equal((await h.browser.call('enable', request)).statusCode, 503);
  const pending = await h.redis.store.get('owner');
  assert.ok(Buffer.byteLength(pending.raw) > 600_000);
  assert.deepEqual(pending.value.pending.payload, payload);
  h.restart();
  const recovered = await h.browser.call('enable', request);
  assert.equal(recovered.statusCode, 200); assert.equal(recovered.body.revision, 1);
  assert.equal(h.notion.writes, 1);
  assert.deepEqual([...h.notion.files.values()][0].content.payload, payload);
  const commands = h.redis.commands.filter(command => command[0] === 'EVAL');
  assert.ok(commands.every(command => Buffer.byteLength(JSON.stringify(command)) < 4.1 * 1024 * 1024));
});
test('request and encrypted-record size bounds still reject excessive data before external writes', async () => {
  const h = harness(); await h.browser.login();
  const result = await h.browser.call('enable', initial({ payload: 'x'.repeat(MAX_PAYLOAD_BYTES + 4096) }));
  assert.equal(result.statusCode, 400); assert.equal(result.body.error, 'invalid_request');
  assert.equal(h.notion.writes, 0);
  const redis = fakeRedis();
  await assert.rejects(redis.store.cas('oversize', null, { data: 'x'.repeat(2 * 1024 * 1024) }), /store_unavailable/);
  assert.equal(redis.commands.length, 0);
  redis.values.set(CONFIG.prefix + 'oversize', 'x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(redis.store.get('oversize'), /store_unavailable/);
});
test('enable/upload persist revisions; exact repeats do not rewrite and stale writes fail', async () => {
  const h = harness(); await h.browser.login();
  assert.equal((await h.browser.call('upload', initial())).body.error, 'scope_review_required');
  const first = await h.browser.call('enable', initial());
  assert.equal(first.statusCode, 200); assert.equal(first.body.revision, 1); assert.equal(first.body.enabled, true);
  assert.equal((await h.browser.call('enable', initial())).body.revision, 1); assert.equal(h.notion.writes, 1);
  h.restart();
  const second = initial({ operationId: 'second-operation-0123456', baseRevision: 1 });
  assert.equal((await h.browser.call('upload', second)).body.revision, 2);
  assert.equal((await h.browser.call('upload', initial())).body.error, 'revision_conflict');
  assert.equal(h.notion.writes, 2);
  const serialized = [...h.redis.values.values()].join('');
  for (const secret of ['synthetic-access-token', 'synthetic-refresh-token', 'Synthetic habit', h.browser.csrf]) assert.ok(!serialized.includes(secret));
  const file = [...h.notion.files.values()][0].content;
  assert.deepEqual(Object.keys(file), ['schemaVersion', 'deviceId', 'revision', 'operationId', 'syncedAt', 'payload']);
  assert.ok(!JSON.stringify(file).includes('token'));
});
test('lost initial upload response reconciles reserved ID across server restart, without duplicates', async () => {
  const h = harness(); await h.browser.login(); h.notion.flags.timeoutAfterWrite = true;
  assert.equal((await h.browser.call('enable', initial())).statusCode, 503);
  assert.equal((await h.browser.call('status')).body.revision, 0);
  assert.equal((await h.browser.call('status')).body.enabled, false);
  h.restart();
  assert.equal((await h.browser.call('enable', initial({ operationId: 'different-operation-01234' }))).body.error, 'pending_operation');
  const changed = clone(PAYLOAD); changed.habits[0].name = 'Changed synthetic';
  assert.equal((await h.browser.call('enable', initial({ payload: changed }))).body.error, 'operation_conflict');
  const retry = await h.browser.call('enable', initial());
  assert.equal(retry.statusCode, 200); assert.equal(retry.body.revision, 1);
  assert.equal(h.notion.files.size, 1); assert.equal(h.notion.writes, 1);
});
test('lost update response reconciles exact operation rather than stale overwrite', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  const update = initial({ operationId: 'second-operation-0123456', baseRevision: 1 });
  h.notion.flags.timeoutAfterWrite = true;
  assert.equal((await h.browser.call('upload', update)).statusCode, 503);
  const retry = await h.browser.call('upload', update);
  assert.equal(retry.body.revision, 2); assert.equal(h.notion.writes, 2);
});

test('concurrent uploads serialize by durable CAS; duplicate same operation stays idempotent', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  const input = initial({ operationId: 'second-operation-0123456', baseRevision: 1 });
  const duplicate = await Promise.all([h.browser.call('upload', input), h.browser.call('upload', input)]);
  assert.ok(duplicate.some(res => res.statusCode === 200)); assert.ok(duplicate.every(res => [200,503].includes(res.statusCode))); assert.equal(h.notion.writes, 2);
  const competing = await Promise.all(['third-operation-01234567', 'fourth-operation-0123456'].map(operationId =>
    h.browser.call('upload', initial({ operationId, baseRevision: 2 }))));
  assert.equal(competing.filter(res => res.statusCode === 200).length, 1);
  assert.equal(competing.filter(res => res.statusCode === 409).length, 1);
  assert.equal(h.notion.writes, 3);
});
test('disconnect deletes credentials/session, keeps file, and reconnect needs explicit enable', async () => {
  const h = harness(); await h.browser.login(); await h.browser.call('enable', initial());
  const oldCookie = h.browser.cookies; const oldCSRF = h.browser.csrf;
  const res = await h.browser.call('disconnect', {});
  assert.equal(res.statusCode, 200); assert.match(res.headers['set-cookie'], /Max-Age=0/);
  const owner = (await h.redis.store.get('owner')).value;
  assert.equal(owner.credentials, null); assert.equal(owner.enabled, false); assert.equal(h.notion.files.size, 1);
  assert.ok((await h.browser.call('upload', initial(), { headers: { cookie: oldCookie, 'x-csrf-token': oldCSRF } })).statusCode >= 400);
  const connected = await h.browser.login(); assert.equal(connected.body.connected, true); assert.equal(connected.body.enabled, false);
  assert.equal(connected.body.revision, 1);
  assert.equal((await h.browser.call('enable', initial({ operationId: 'reenable-operation-01234', baseRevision: 1 }))).body.revision, 2);
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
      id_token: signedToken(changes), scope: 'openid email' });
    if (url.endsWith('/certs')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/userinfo')) return Response.json({ sub: CONFIG.ownerSub, email: CONFIG.ownerEmail, email_verified: true, ...userChanges });
    throw new Error('unexpected network target');
  };
  return { calls, google: createGoogle(CONFIG, fetcher, () => JWT_TIME) };
}
test('real Google adapter validates signature, issuer, audience, nonce, owner and userinfo', async () => {
  const valid = googleIdentity(); const credentials = await valid.google.exchange('synthetic-code', 'synthetic-verifier', 'synthetic-nonce');
  assert.deepEqual(credentials, {identityVerified:true});
  const params = new URLSearchParams(valid.calls[0].options.body);
  assert.equal(params.get('code_verifier'), 'synthetic-verifier'); assert.equal(params.get('redirect_uri'), CONFIG.callback);
  for (const bad of [{ sub: 'other' }, { email: 'other@example.test' }, { email_verified: false }, { nonce: 'wrong' },
    { iss: 'https://evil.test' }, { aud: 'other-client' }, { exp: JWT_TIME / 1000 - 1 }, { azp: 'other-client' }]) {
    await assert.rejects(googleIdentity(bad).google.exchange('synthetic-code', 'synthetic-verifier', 'synthetic-nonce'), /owner_forbidden/);
  }
  await assert.rejects(googleIdentity({}, { sub: 'other' }).google.exchange('synthetic-code', 'synthetic-verifier', 'synthetic-nonce'), /owner_forbidden/);
  const url = new URL(valid.google.authorizationURL('state', 'challenge', 'nonce'));
  assert.equal(url.searchParams.get('access_type'), 'online'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
});
function meta(etag = '"etag-a"', extra = {}) { return { id: 'file1', etag, mimeType: 'application/json', labels: { trashed: false }, shared: false, ownedByMe: true, ...extra }; }







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
      token_type: 'Bearer', expires_in: 3600, id_token: badSignature.join('.'), scope: 'openid email' });
    if (url.endsWith('/certs')) return Response.json({ keys: [jwk] });
    throw new Error('userinfo must not be reached');
  }, () => JWT_TIME);
  await assert.rejects(fake.exchange('code', 'verifier', 'synthetic-nonce'), /owner_forbidden/);
  await assert.rejects(googleIdentity({ at_hash: 'wrong' }).google.exchange('code', 'verifier', 'synthetic-nonce'), /owner_forbidden/);
  const at_hash = createHash('sha256').update('synthetic-access-token').digest().subarray(0, 16).toString('base64url');
  assert.ok((await googleIdentity({ at_hash }).google.exchange('code', 'verifier', 'synthetic-nonce')).identityVerified);
});


test('old Drive API requests cannot authorize a new destination even with a valid owner session', async () => {
  const h = harness(); await h.browser.login();
  const missing = initial(); delete missing.consentVersion;
  assert.equal((await h.browser.call('enable', missing)).body.error, 'invalid_request');
  assert.equal((await h.browser.call('enable', initial({consentVersion:2}))).body.error, 'scope_review_required');
  assert.equal(h.notion.writes, 0);
});
test('destination config binds storage to Notion page and requires explicit privacy attestation', () => {
  assert.equal(readConfig({...ENV, PRIVATE_SYNC_NOTION_PRIVATE_CONFIRMED:'0'}), null);
  assert.equal(readConfig({...ENV, PRIVATE_SYNC_NOTION_PAGE_ID:'https://attacker.test'}), null);
  assert.notEqual(readConfig({...ENV, PRIVATE_SYNC_NOTION_PAGE_ID:'00000000-0000-0000-0000-000000000002'}).prefix, CONFIG.prefix);
});
test('identity-only owner credentials contain no Google bearer or refresh token', async () => {
  const h = harness(); await h.browser.login();
  assert.deepEqual((await h.redis.store.get('owner')).value.credentials,{identityVerified:true});
  h.advance(31 * 86400000);
  assert.equal((await h.browser.call('upload', initial())).body.error,'csrf_failed');
  assert.equal(h.notion.writes,0);
});
function deferred() { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; }
test('disconnect before a provider mutation fences all later writes and cannot restore session', async () => {
  const h = harness(); await h.browser.login();
  const entered=deferred(), release=deferred(); const publish=h.notion.publish.bind(h.notion);
  h.notion.publish=async (...args)=> {entered.resolve(); await release.promise; return publish(...args);};
  const pending=h.browser.call('enable',initial()); await entered.promise;
  assert.equal((await h.browser.call('disconnect',{})).statusCode,200); release.resolve();
  assert.equal((await pending).body.error,'auth_required');
  assert.equal(h.notion.writes,0); assert.equal((await h.redis.store.get('owner')).value.credentials,null);
});
test('a delayed duplicate cannot publish after its operation was committed and superseded', async () => {
  const h=harness(); await h.browser.login();
  const entered=deferred(),release=deferred();const publish=h.notion.publish.bind(h.notion);let delay=true;
  h.notion.publish=async (envelope, options)=> { if(delay) {delay=false;entered.resolve(); await release.promise;await options.authorize();} return publish(envelope,options);};
  const stale=h.browser.call('enable',initial());await entered.promise;
  assert.equal((await h.browser.call('enable',initial())).body.revision,1);
  assert.equal((await h.browser.call('upload',initial({operationId:'second-operation-012345',baseRevision:1}))).body.revision,2);
  release.resolve(); assert.equal((await stale).body.error,'revision_conflict'); assert.equal(h.notion.writes,2);
});

test('handler and real Notion adapter durably persist preflight throttling through encrypted CAS', async () => {
  const h=harness();await h.browser.login();let requests=0, now=1000;
  const notion=createNotion(CONFIG,async()=>{requests++;return new Response('',{status:429,headers:{'retry-after':'30'}});}, {now:()=>now,sleep:async()=>{},paceMs:0});
  h.notion.publish=notion.publish;
  assert.equal((await h.browser.call('enable',initial())).body.error,'provider_rate_limited');
  const owner=(await h.redis.store.get('owner')).value;
  assert.equal(owner.pending.notion.phase,'retry_create');assert.equal(owner.pending.notion.retryAt,31000);
  assert.equal(owner.revision,0);assert.equal(owner.enabled,false);
  assert.equal((await h.browser.call('enable',initial())).body.error,'provider_rate_limited');
  assert.equal(requests,1);
  now=32000;assert.equal((await h.browser.call('enable',initial())).body.error,'provider_rate_limited');
  assert.equal(requests,2);assert.equal((await h.redis.store.get('owner')).value.pending.notion.retryAt,62000);
});

test('store CAS failure keeps the client retryable and never exposes exception details',async()=>{
  const h=harness();await h.browser.login();const cas=h.redis.store.cas.bind(h.redis.store);
  h.redis.store.cas=async(name,...args)=>{if(name==='owner')throw new SyncError('store_unavailable',503);return cas(name,...args);};
  const result=await h.browser.call('enable',initial());assert.equal(result.statusCode,503);
  assert.deepEqual(result.body,{error:'store_unavailable'});assert.equal(h.notion.writes,0);
  h.redis.store.cas=cas;assert.equal((await h.browser.call('enable',initial())).body.revision,1);
});
