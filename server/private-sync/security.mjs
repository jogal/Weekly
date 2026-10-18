import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class SyncError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const equals = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);

export function readConfig(env = process.env) {
  try {
    if (env.PRIVATE_SYNC_ENABLED !== '1') return null;
    const origin = env.PRIVATE_SYNC_APP_ORIGIN;
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) return null;
    const redisUrl = new URL(env.UPSTASH_REDIS_REST_URL);
    if (redisUrl.protocol !== 'https:' || !redisUrl.hostname.endsWith('.upstash.io') ||
      redisUrl.username || redisUrl.password || redisUrl.search || redisUrl.hash || redisUrl.pathname !== '/') return null;
    const key = Buffer.from(env.PRIVATE_SYNC_ENCRYPTION_KEY || '', 'base64');
    if (key.length !== 32 || key.toString('base64') !== env.PRIVATE_SYNC_ENCRYPTION_KEY) return null;
    const clientId = env.PRIVATE_SYNC_GOOGLE_CLIENT_ID;
    const clientSecret = env.PRIVATE_SYNC_GOOGLE_CLIENT_SECRET;
    const ownerSub = env.PRIVATE_SYNC_OWNER_SUB;
    const ownerEmail = env.PRIVATE_SYNC_OWNER_EMAIL;
    if (!clientId?.endsWith('.apps.googleusercontent.com') || !clientSecret ||
      !/^[A-Za-z0-9_-]{1,255}$/.test(ownerSub || '') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail || '') ||
      !env.UPSTASH_REDIS_REST_TOKEN) return null;
    const namespace = env.PRIVATE_SYNC_REDIS_PREFIX || 'weekly:private-sync';
    if (!/^[A-Za-z0-9:_-]{1,80}$/.test(namespace)) return null;
    const binding = digest(JSON.stringify([origin, clientId, ownerSub, ownerEmail.toLowerCase()]));
    return { origin, callback: `${origin}/api/private-sync?action=callback`, clientId, clientSecret,
      ownerSub, ownerEmail: ownerEmail.toLowerCase(), key, binding,
      prefix: `${namespace}:${binding}:`, redisUrl: redisUrl.origin, redisToken: env.UPSTASH_REDIS_REST_TOKEN };
  } catch { return null; }
}

// Every record, including CSRF/OAuth state and pending payloads, is encrypted.
// The Redis key is authenticated to prevent ciphertext being moved to another record.
export function seal(value, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function unseal(raw, key, context) {
  try {
    const parts = raw.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8'));
  } catch { throw new SyncError('store_unavailable', 503); }
}
