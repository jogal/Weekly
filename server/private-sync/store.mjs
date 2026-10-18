import { seal, unseal, SyncError } from './security.mjs';

// One 1 MiB pending projection plus credentials/metadata and base64-GCM overhead.
// Both old and new ciphertext can be present in a single bounded CAS request.
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_BYTES = 2 * MAX_RECORD_BYTES + 16 * 1024;

// Compare the complete old ciphertext in Redis, atomically. No process-local state
// or expiring distributed lock is trusted for cross-instance write ordering.
const CAS = `local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1])
elseif tonumber(ARGV[3]) > 0 then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
else redis.call('SET', KEYS[1], ARGV[2]) end
return 1`;

export function createStore(config, fetcher = globalThis.fetch) {
  async function command(parts) {
    try {
      const body = JSON.stringify(parts);
      if (Buffer.byteLength(body) > MAX_COMMAND_BYTES) throw new Error();
      const res = await fetcher(config.redisUrl, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${config.redisToken}`, 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error();
      const response = await res.json();
      if (response.error || !Object.hasOwn(response, 'result')) throw new Error();
      return response.result;
    } catch { throw new SyncError('store_unavailable', 503); }
  }
  return {
    async get(name) {
      const key = config.prefix + name;
      const raw = await command(['GET', key]);
      if (raw === null) return { raw: null, value: null };
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw new SyncError('store_unavailable', 503);
      return { raw, value: unseal(raw, config.key, key) };
    },
    async cas(name, expected, value, ttl = 0) {
      const key = config.prefix + name;
      const raw = value === null ? '' : seal(value, config.key, key);
      if (Buffer.byteLength(raw) > MAX_RECORD_BYTES || (expected !== null && expected !== undefined &&
          (typeof expected !== 'string' || Buffer.byteLength(expected) > MAX_RECORD_BYTES))) throw new SyncError('store_unavailable', 503);
      return (await command(['EVAL', CAS, '1', key, expected ?? '', raw, String(ttl)])) === 1;
    },
  };
}
