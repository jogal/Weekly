import { createHash } from 'node:crypto';
import { validatePayload, MAX_PAYLOAD_BYTES } from '../../js/private-sync-protocol.mjs';
import { readConfig, token, digest, equals, identifier, SyncError } from './security.mjs';
import { createStore } from './store.mjs';
import { createGoogle } from './google.mjs';

const COOKIE = '__Host-weekly-sync';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const ANON_SECONDS = 10 * 60;
const MAX_BODY_BYTES = MAX_PAYLOAD_BYTES + 4 * 1024;
// Category-wide v2 sharing is a new consent boundary. An old selective opt-in
// must never authorize automatic uploads under the expanded schema.
const CONSENT_VERSION = 2;
const emptyStatus = { configured: false, connected: false, csrfToken: null, enabled: false, deviceId: null, revision: 0, lastSyncedAt: null, authError: null };

function json(res, status, value) { return res.status(status).json(value); }
function cookie(res, sid, seconds) {
  res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`);
}
function cookieId(req) {
  const matches = String(req.headers?.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function body(req, fields) {
  let value = req.body;
  try {
    if (Buffer.isBuffer(value)) value = value.toString('utf8');
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > MAX_BODY_BYTES) throw new Error();
      value = JSON.parse(value);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_BODY_BYTES ||
      Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) throw new Error();
    return value;
  } catch { throw new SyncError('invalid_request', 400); }
}
function status(session, owner) {
  const valid = session?.authenticated && owner && session.generation === owner.generation;
  return { configured: true, connected: Boolean(valid && owner.credentials), csrfToken: session?.csrf || null,
    enabled: Boolean(valid && owner.credentials && owner.enabled), deviceId: valid ? owner.deviceId : null,
    revision: valid ? owner.revision : 0, lastSyncedAt: valid ? owner.lastSyncedAt : null, authError: session?.authError || null };
}
function authenticate(session, owner) {
  if (!session?.authenticated || !owner?.credentials || session.generation !== owner.generation) throw new SyncError('auth_required', 401);
}
function envelopeFor(owner) {
  const p = owner.pending;
  return { schemaVersion: 1, deviceId: owner.deviceId, revision: p.revision, operationId: p.operationId, syncedAt: p.syncedAt, payload: p.payload };
}
function sameContent(a, b) { return digest(JSON.stringify(a)) === digest(JSON.stringify(b)); }

// Dependencies are injected only by local tests. The production entry point below
// always uses validated server environment variables and the encrypted Redis store.
export function createHandler({ config, store, google, now = Date.now }) {
  async function getSession(req) {
    const id = cookieId(req);
    if (!id) return { name: null, raw: null, value: null };
    const name = `session:${digest(id)}`;
    const record = await store.get(name);
    if (!record.value || record.value.expiresAt <= now()) return { name, raw: record.raw, value: null };
    return { name, ...record };
  }
  async function newSession(res, values = {}) {
    const sid = token(); const authenticated = Boolean(values.authenticated);
    const seconds = authenticated ? SESSION_SECONDS : ANON_SECONDS;
    const value = { csrf: token(), authenticated, expiresAt: now() + seconds * 1000, ...values };
    const name = `session:${digest(sid)}`;
    if (!(await store.cas(name, null, value, seconds))) throw new SyncError('retry_later', 503);
    cookie(res, sid, seconds);
    return { name, value };
  }
  async function ownerWithToken(session) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const record = await store.get('owner');
      authenticate(session, record.value);
      if (record.value.credentials.expiresAt > now() + 60000) return record;
      let refreshed;
      try { refreshed = await google.refresh(record.value.credentials); }
      catch (error) {
        if (error.code === 'auth_required') {
          await store.cas('owner', record.raw, { ...record.value, credentials: null, enabled: false });
        }
        throw error;
      }
      if (await store.cas('owner', record.raw, { ...record.value, credentials: refreshed })) continue;
    }
    throw new SyncError('retry_later', 503);
  }
  async function synchronize(session, data, enabling) {
    if (!identifier(data.deviceId) || !identifier(data.operationId) || !Number.isSafeInteger(data.baseRevision) || data.baseRevision < 0) {
      throw new SyncError('invalid_request', 400);
    }
    let payload;
    try { payload = validatePayload(data.payload); }
    catch { throw new SyncError('invalid_payload', 400); }
    const hash = digest(JSON.stringify(payload));
    let reserved = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const record = await ownerWithToken(session); const owner = record.value;
      if (owner.deviceId !== data.deviceId) throw new SyncError('device_conflict', 409);
      if (owner.lastOperation?.operationId === data.operationId) {
        if (owner.lastOperation.hash !== hash || owner.lastOperation.baseRevision !== data.baseRevision) throw new SyncError('operation_conflict', 409);
        if (enabling && (!owner.enabled || owner.consentVersion !== CONSENT_VERSION)) {
          if (owner.pending) throw new SyncError('pending_operation', 409);
          if (!(await store.cas('owner', record.raw, { ...owner, enabled: true, consentVersion: CONSENT_VERSION }))) continue;
          owner.enabled = true;
          owner.consentVersion = CONSENT_VERSION;
        }
        return status(session, owner);
      }
      if (owner.pending) {
        if (owner.pending.operationId !== data.operationId) throw new SyncError('pending_operation', 409);
        if (owner.pending.hash !== hash || owner.pending.baseRevision !== data.baseRevision) throw new SyncError('operation_conflict', 409);
        reserved = owner; break;
      }
      // Exact pending/applied operations above remain reconcilable without
      // silently authorizing a new snapshot under the expanded scope.
      if (!enabling && owner.consentVersion !== CONSENT_VERSION) throw new SyncError('scope_review_required', 409);
      if (data.baseRevision !== owner.revision) throw new SyncError('revision_conflict', 409);
      // With no pending/applied match and an exact current base, this error is a
      // definite non-application for this operation. Uncertain pending writes use
      // pending_disabled below instead.
      if (!enabling && !owner.enabled) throw new SyncError('sync_disabled', 409);
      const fileId = owner.fileId || await google.reserveId(owner.credentials.accessToken);
      const next = { ...owner, fileId, pending: { operationId: data.operationId, hash, payload,
        baseRevision: owner.revision, revision: owner.revision + 1, expectedETag: owner.fileETag,
        syncedAt: new Date(now()).toISOString() } };
      if (await store.cas('owner', record.raw, next)) { reserved = next; break; }
    }
    if (!reserved) throw new SyncError('retry_later', 503);
    const expected = envelopeFor(reserved);
    const accessToken = reserved.credentials.accessToken;
    let remote = await google.inspect(accessToken, reserved.fileId);
    if (!remote || !sameContent(remote.content, expected)) {
      if ((!remote && reserved.revision !== 0) || (remote && remote.etag !== reserved.pending.expectedETag)) {
        throw new SyncError('external_change', 409);
      }
      if (!enabling && !reserved.enabled) throw new SyncError('pending_disabled', 409);
      // Verify the durable authorization fence immediately before the only Drive
      // write. Disconnect invalidates the generation; a request already on the
      // wire can still finish, which cannot be undone atomically across services.
      const fence = (await store.get('owner')).value;
      authenticate(session, fence);
      if (fence.pending?.operationId !== data.operationId || fence.pending?.hash !== hash) throw new SyncError('revision_conflict', 409);
      if (!enabling && !fence.enabled) throw new SyncError('pending_disabled', 409);
      await google.write(accessToken, reserved.fileId, expected, remote?.etag || null);
      // Includes successful responses, 409 duplicate creates and 412 races. A
      // timeout throws while keeping the pending operation durably retryable.
      remote = await google.inspect(accessToken, reserved.fileId);
      if (!remote || !sameContent(remote.content, expected)) throw new SyncError('external_change', 409);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const record = await store.get('owner'); const owner = record.value;
      authenticate(session, owner);
      if (owner.lastOperation?.operationId === data.operationId && owner.lastOperation.hash === hash) return status(session, owner);
      if (owner.pending?.operationId !== data.operationId || owner.pending?.hash !== hash || owner.revision !== data.baseRevision) {
        throw new SyncError('revision_conflict', 409);
      }
      const next = { ...owner, pending: null, revision: expected.revision, fileETag: remote.etag,
        lastSyncedAt: expected.syncedAt, enabled: enabling || owner.enabled,
        consentVersion: enabling ? CONSENT_VERSION : owner.consentVersion,
        lastOperation: { operationId: data.operationId, hash, baseRevision: data.baseRevision } };
      if (await store.cas('owner', record.raw, next)) return status(session, next);
    }
    throw new SyncError('retry_later', 503);
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const url = new URL(req.url || '/', config?.origin || 'https://unconfigured.invalid');
    const action = url.searchParams.get('action');
    const redirect = () => { res.setHeader('Location', `${config.origin}/tracker.html`); return res.status(303).end(); };
    try {
      if (!config) return action === 'status' && req.method === 'GET'
        ? json(res, 200, emptyStatus) : json(res, 503, { error: 'not_configured' });
      if (!['status', 'connect', 'callback', 'enable', 'upload', 'disconnect'].includes(action)) throw new SyncError('invalid_request', 400);
      if ((['status', 'callback'].includes(action) ? 'GET' : 'POST') !== req.method) throw new SyncError('method_not_allowed', 405);
      if (action !== 'callback' && ((req.headers.origin && req.headers.origin !== config.origin) || req.headers['sec-fetch-site'] === 'cross-site')) {
        throw new SyncError('origin_forbidden', 403);
      }
      let session = await getSession(req);
      if (action === 'status') {
        const owner = (await store.get('owner')).value;
        if (!session.value || (session.value.authenticated && session.value.generation !== owner?.generation)) session = await newSession(res);
        return json(res, 200, status(session.value, owner));
      }
      if (action === 'callback') {
        const state = url.searchParams.get('state'); const code = url.searchParams.get('code');
        if (!session.value || !/^[A-Za-z0-9_-]{43}$/.test(state || '') ||
          !equals(session.value.oauthStateHash, digest(state)) || !code || code.length > 8192 || url.searchParams.has('error')) {
          throw new SyncError('auth_required', 401);
        }
        const oauthName = `oauth:${digest(state)}`; const oauth = await store.get(oauthName);
        if (!oauth.value || oauth.value.session !== session.name || oauth.value.expiresAt <= now() ||
          !(await store.cas(oauthName, oauth.raw, null))) throw new SyncError('auth_required', 401);
        const credentials = await google.exchange(code, oauth.value.verifier, oauth.value.nonce);
        let connected = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          const record = await store.get('owner'); const owner = record.value;
          if (owner && owner.deviceId !== oauth.value.deviceId) throw new SyncError('device_conflict', 409);
          const next = { ...(owner || { fileId: null, fileETag: null, revision: 0, lastSyncedAt: null, lastOperation: null, pending: null }),
            deviceId: oauth.value.deviceId, generation: token(), credentials, enabled: false };
          if (await store.cas('owner', record.raw, next)) { connected = next; break; }
        }
        if (!connected) throw new SyncError('retry_later', 503);
        await newSession(res, { authenticated: true, generation: connected.generation });
        await store.cas(session.name, session.raw, null);
        return redirect();
      }
      if (req.headers.origin !== config.origin) throw new SyncError('origin_forbidden', 403);
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new SyncError('invalid_request', 400);
      if (!session.value || !equals(session.value.csrf, req.headers['x-csrf-token'])) throw new SyncError('csrf_failed', 403);
      if (action === 'connect') {
        const data = body(req, ['deviceId']);
        if (!identifier(data.deviceId)) throw new SyncError('invalid_request', 400);
        const state = token(); const verifier = token(); const nonce = token();
        const oauth = { deviceId: data.deviceId, verifier, nonce, session: session.name, expiresAt: now() + ANON_SECONDS * 1000 };
        if (!(await store.cas(`oauth:${digest(state)}`, null, oauth, ANON_SECONDS)) ||
          !(await store.cas(session.name, session.raw, { ...session.value, authError: null, oauthStateHash: digest(state) },
            Math.max(1, Math.ceil((session.value.expiresAt - now()) / 1000))))) throw new SyncError('retry_later', 503);
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        return json(res, 200, { authorizationUrl: google.authorizationURL(state, challenge, nonce) });
      }
      if (action === 'disconnect') {
        body(req, []);
        for (let attempt = 0; attempt < 5; attempt++) {
          const record = await store.get('owner');
          // A revoked Google grant can still be disconnected locally.
          if (!session.value.authenticated || !record.value || session.value.generation !== record.value.generation) throw new SyncError('auth_required', 401);
          const next = { ...record.value, enabled: false, credentials: null, generation: token() };
          if (await store.cas('owner', record.raw, next)) {
            await store.cas(session.name, session.raw, null);
            cookie(res, '', 0);
            return json(res, 200, { ...emptyStatus, configured: true });
          }
        }
        throw new SyncError('retry_later', 503);
      }
      const data = body(req, ['deviceId', 'baseRevision', 'operationId', 'payload']);
      return json(res, 200, await synchronize(session.value, data, action === 'enable'));
    } catch (error) {
      // No upstream response, request URL, token, payload, or exception is logged.
      // Always remove the authorization code from browser history on callback.
      if (action === 'callback' && config) {
        try {
          const session = await getSession(req);
          if (session.value) await store.cas(session.name, session.raw, { ...session.value,
            authError: error instanceof SyncError ? error.code : 'retry_later' },
            Math.max(1, Math.ceil((session.value.expiresAt - now()) / 1000)));
        } catch { /* A failed store stays fail-closed; never expose upstream errors. */ }
        return redirect();
      }
      return json(res, error instanceof SyncError ? error.status : 503,
        { error: error instanceof SyncError ? error.code : 'retry_later' });
    }
  };
}

export default async function handler(req, res) {
  const config = readConfig();
  return createHandler({ config, store: config && createStore(config), google: config && createGoogle(config) })(req, res);
}
