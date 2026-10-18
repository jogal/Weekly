import { createHash, createPublicKey, verify } from 'node:crypto';
import { SyncError, equals } from './security.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

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
  return {
    authorizationURL(state, challenge, nonce) {
      const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback,
        response_type: 'code', scope: 'openid email', access_type: 'online',
        prompt: 'select_account', include_granted_scopes: 'false', state,
        code_challenge: challenge, code_challenge_method: 'S256', nonce });
      return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
    },
    async exchange(code, verifier, nonce) {
      const result = await tokenRequest({ grant_type: 'authorization_code', redirect_uri: config.callback, code, code_verifier: verifier });
      const scopes = new Set(String(result.scope || '').split(' '));
      const allowed = new Set(['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email']);
      if (!scopes.has('openid') ||
          !(scopes.has('email') || scopes.has('https://www.googleapis.com/auth/userinfo.email')) ||
          [...scopes].some(scope => !allowed.has(scope))) throw new SyncError('auth_required', 401);
      await verifyIdentity(result.id_token, result.access_token, nonce);
      // Identity-only sign-in: never persist Google access or refresh tokens.
      return { identityVerified: true };
    },
  };
}
