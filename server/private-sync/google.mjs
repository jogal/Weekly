import { createHash, createPublicKey, verify } from 'node:crypto';
import { SyncError, equals } from './security.mjs';
import { MAX_PAYLOAD_BYTES } from '../../js/private-sync-protocol.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIELDS = 'id,etag,mimeType,labels/trashed,shared,ownedByMe,driveId,appDataContents,md5Checksum';
const API = 'https://www.googleapis.com/drive/v2/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v2/files';
const MAX_MEDIA_BYTES = MAX_PAYLOAD_BYTES + 4 * 1024;

async function readJSON(res, max = 65536) {
  if (Number(res.headers.get('content-length')) > max) throw new SyncError('provider_unavailable', 503);
  let bytes = 0; const chunks = [];
  for await (const chunk of res.body) {
    bytes += chunk.byteLength;
    if (bytes > max) throw new SyncError('provider_unavailable', 503);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SyncError('provider_unavailable', 503); }
}
function privateMetadata(data, fileId) {
  if (data.id !== fileId || data.mimeType !== 'application/json' || data.shared !== false ||
      data.ownedByMe !== true || data.labels?.trashed !== false || data.driveId || data.appDataContents === true ||
      typeof data.etag !== 'string' || !/^"[^\r\n"]{1,300}"$/.test(data.etag)) {
    throw new SyncError('external_change', 409);
  }
  return data;
}

export function createGoogle(config, fetcher = globalThis.fetch, now = Date.now) {
  async function request(url, options = {}) {
    try {
      return await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) });
    } catch { throw new SyncError('provider_unavailable', 503); }
  }
  async function tokenRequest(params) {
    const res = await request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }).toString() });
    if (!res.ok) {
      // Never copy upstream bodies, URLs, code, or token values into errors/logs.
      if (res.status === 400 || res.status === 401) throw new SyncError('auth_required', 401);
      throw new SyncError('provider_unavailable', 503);
    }
    const value = await readJSON(res);
    if (typeof value.access_token !== 'string' || value.access_token.length > 8192 ||
      value.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 || value.expires_in > 86400) throw new SyncError('auth_required', 401);
    return value;
  }
  async function verifyIdentity(idToken, accessToken, nonce) {
    try {
      if (typeof idToken !== 'string' || idToken.length > 16384) throw new Error();
      const parts = idToken.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error();
      const certs = await request('https://www.googleapis.com/oauth2/v3/certs');
      if (!certs.ok) throw new SyncError('provider_unavailable', 503);
      const keys = (await readJSON(certs)).keys;
      const jwk = Array.isArray(keys) && keys.find(key => key.kid === header.kid && key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig');
      if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error();
      const seconds = Math.floor(now() / 1000);
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) ||
        claims.aud !== config.clientId || (claims.azp && claims.azp !== config.clientId) ||
        !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 ||
        !equals(claims.nonce, nonce) || claims.sub !== config.ownerSub ||
        claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.toLowerCase() !== config.ownerEmail) throw new Error();
      if (claims.at_hash && !equals(claims.at_hash,
        createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url'))) throw new Error();
      const user = await request('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!user.ok) throw new Error();
      const info = await readJSON(user);
      if (info.sub !== claims.sub || info.email_verified !== true || typeof info.email !== 'string' ||
        info.email.toLowerCase() !== config.ownerEmail) throw new Error();
    } catch (error) {
      if (error instanceof SyncError && error.code === 'provider_unavailable') throw error;
      throw new SyncError('owner_forbidden', 403);
    }
  }
  async function metadata(accessToken, fileId) {
    const res = await request(`${API}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FIELDS)}`, {
      headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 404) return null;
    if (res.status === 401) throw new SyncError('auth_required', 401);
    if (!res.ok) throw new SyncError('provider_unavailable', 503);
    return privateMetadata(await readJSON(res), fileId);
  }
  return {
    authorizationURL(state, challenge, nonce) {
      const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback,
        response_type: 'code', scope: `openid email ${DRIVE_SCOPE}`, access_type: 'offline',
        prompt: 'consent select_account', include_granted_scopes: 'false', state,
        code_challenge: challenge, code_challenge_method: 'S256', nonce });
      return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
    },
    async exchange(code, verifier, nonce) {
      const result = await tokenRequest({ grant_type: 'authorization_code', redirect_uri: config.callback, code, code_verifier: verifier });
      const scopes = new Set(String(result.scope || '').split(' '));
      const allowed = new Set([DRIVE_SCOPE, 'openid', 'email', 'https://www.googleapis.com/auth/userinfo.email']);
      if (!scopes.has(DRIVE_SCOPE) || !scopes.has('openid') ||
          !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email')) ||
          [...scopes].some(scope => !allowed.has(scope)) || typeof result.refresh_token !== 'string' ||
          result.refresh_token.length < 1 || result.refresh_token.length > 8192) throw new SyncError('auth_required', 401);
      await verifyIdentity(result.id_token, result.access_token, nonce);
      return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: now() + result.expires_in * 1000 };
    },
    async refresh(credentials) {
      const result = await tokenRequest({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
      return { accessToken: result.access_token, refreshToken: result.refresh_token || credentials.refreshToken,
        expiresAt: now() + result.expires_in * 1000 };
    },
    async reserveId(accessToken) {
      const res = await request(`${API}/generateIds?maxResults=1&space=drive`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 401) throw new SyncError('auth_required', 401);
      if (!res.ok) throw new SyncError('provider_unavailable', 503);
      const value = await readJSON(res);
      if (!Array.isArray(value.ids) || !/^[A-Za-z0-9_-]{1,200}$/.test(value.ids[0] || '')) throw new SyncError('provider_unavailable', 503);
      return value.ids[0];
    },
    async inspect(accessToken, fileId) {
      const before = await metadata(accessToken, fileId);
      if (!before) return null;
      // v3 media retrieval is used with the stable v2 File resource ETag for writes.
      const res = await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 401) throw new SyncError('auth_required', 401);
      if (!res.ok) throw new SyncError('provider_unavailable', 503);
      const content = await readJSON(res, MAX_MEDIA_BYTES);
      const after = await metadata(accessToken, fileId);
      if (!after || before.etag !== after.etag) throw new SyncError('external_change', 409);
      return { etag: after.etag, content };
    },
    async write(accessToken, fileId, envelope, etag) {
      const media = JSON.stringify(envelope);
      let url; let body; let contentType; let method;
      if (etag) {
        url = `${UPLOAD}/${encodeURIComponent(fileId)}?uploadType=media&fields=${encodeURIComponent(FIELDS)}`;
        method = 'PUT'; body = media; contentType = 'application/json; charset=UTF-8';
      } else {
        // A generated ID makes even a timed-out insert safe to retry: Drive rejects
        // the second insert with 409 instead of creating a duplicate.
        url = `${UPLOAD}?uploadType=multipart&visibility=PRIVATE&convert=false&fields=${encodeURIComponent(FIELDS)}`;
        const boundary = `weekly_${createHash('sha256').update(media).digest('hex')}`;
        const meta = JSON.stringify({ id: fileId, title: 'Weekly private progress.json', mimeType: 'application/json', parents: [{ id: 'root' }] });
        body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${media}\r\n--${boundary}--\r\n`;
        method = 'POST'; contentType = `multipart/related; boundary=${boundary}`;
      }
      const res = await request(url, { method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': contentType,
        ...(etag ? { 'If-Match': etag } : {}) }, body });
      if ([409, 412].includes(res.status)) return false; // caller reconciles this exact pending operation
      if (res.status === 401) throw new SyncError('auth_required', 401);
      if (!res.ok) throw new SyncError('provider_unavailable', 503);
      privateMetadata(await readJSON(res), fileId);
      return true;
    },
  };
}
