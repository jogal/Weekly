// Optional, one-device, write-only feed. Local record stores are always authoritative.
// Tokens/CSRF stay in memory; the durable outbox contains only the approved projection.
export const SYNC_KEY = "wt_private_sync_v1";
export const STOP_KEY = "wt_private_sync_stop_v1";
export const SOURCE_KEYS = new Set(["wt_records", "wt_habits_v1", "wt_habit_log_v1", "wt_todo_v1", "wt_reading_v1"]);
const EMPTY_SELECTION = () => ({ habitIds: [], readingIds: [], taskIds: [] });
const clone = value => JSON.parse(JSON.stringify(value));
const err = code => Object.assign(new Error(code), { code });
const BLOCKING = new Set(["CONFLICT", "DEVICE_MISMATCH", "RECONNECT_REQUIRED", "UNAUTHENTICATED", "REVIEW_REQUIRED", "INVALID_LOCAL_DATA", "NOT_CONFIGURED", "SYNC_DISABLED", "PENDING_DISABLED"]);
const ERROR_CODES = { not_configured: "NOT_CONFIGURED", auth_required: "UNAUTHENTICATED", reconnect_required: "RECONNECT_REQUIRED",
  device_conflict: "DEVICE_MISMATCH", revision_conflict: "CONFLICT", operation_conflict: "CONFLICT", pending_operation: "CONFLICT",
  external_change: "CONFLICT", sync_disabled: "SYNC_DISABLED", pending_disabled: "PENDING_DISABLED", csrf_failed: "UNAUTHENTICATED", owner_forbidden: "OWNER_FORBIDDEN",
  invalid_payload: "INVALID_LOCAL_DATA", invalid_request: "INVALID_REQUEST", store_unavailable: "SERVER_ERROR",
  provider_unavailable: "SERVER_ERROR", retry_later: "SERVER_ERROR", origin_forbidden: "ORIGIN_FORBIDDEN" };
const codeOf = e => ERROR_CODES[e?.code] || e?.code || (e?.name === "AbortError" ? "PAUSED" : "NETWORK_ERROR");

// During rollout an old worker may still cache every GET, ignoring no-store.
// Verify both this page's controller and active page/API registrations before
// sending a session request or starting OAuth (whose callback is a navigation).
const safeWorkers = new WeakSet();
export async function ensurePrivateSyncTransport({ serviceWorker = globalThis.navigator?.serviceWorker,
  Channel = globalThis.MessageChannel, timeoutMs = 1500, pageUrl = globalThis.location?.href } = {}) {
  if (!serviceWorker) return; // This browser cannot install a service worker.
  if (!Channel || !pageUrl || typeof serviceWorker.getRegistration !== "function") throw err("UPDATE_REQUIRED");
  const bounded = work => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(err("UPDATE_REQUIRED")), timeoutMs);
    Promise.resolve(work).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(err("UPDATE_REQUIRED")); });
  });
  const urls = [pageUrl, new URL("/api/private-sync", pageUrl).href];
  const controller = serviceWorker.controller;
  const registrations = await bounded(Promise.all(urls.map(url => serviceWorker.getRegistration(url))));
  // A registration can install while OAuth is open. Require a proven safe active
  // worker rather than treating a temporarily uncontrolled page as a safe bypass.
  if (registrations.some(registration => !registration?.active)) throw err("UPDATE_REQUIRED");
  const active = registrations.map(registration => registration.active);
  const workers = [...new Set([controller, ...active].filter(Boolean))];
  for (const worker of workers) {
    if (safeWorkers.has(worker)) continue;
    await new Promise((resolve, reject) => {
      const channel = new Channel();
      let timer;
      const finish = error => {
        clearTimeout(timer); channel.port1.close(); channel.port2.close();
        if (error) reject(error); else { safeWorkers.add(worker); resolve(); }
      };
      timer = setTimeout(() => finish(err("UPDATE_REQUIRED")), timeoutMs);
      channel.port1.onmessage = event => {
        if (event.data?.type === "weekly-private-sync-cache-safe" && event.data.version === 1) finish();
        else finish(err("UPDATE_REQUIRED"));
      };
      try { worker.postMessage({ type: "weekly-private-sync-cache-check", version: 1 }, [channel.port2]); }
      catch { finish(err("UPDATE_REQUIRED")); }
    });
  }
  const latest = await bounded(Promise.all(urls.map(url => serviceWorker.getRegistration(url))));
  if (serviceWorker.controller !== controller || latest.some((registration, i) => registration?.active !== active[i])) throw err("UPDATE_REQUIRED");
}

export function createPrivateSyncClient({ storage, fetch: request, buildPayload, listSelectableItems,
  validatePayload = () => {}, online = () => navigator.onLine, visible = () => !document.hidden,
  uuid = () => crypto.randomUUID(), now = () => new Date().toISOString(), onChange = () => {},
  endpoint = "/api/private-sync", ensureTransport = ensurePrivateSyncTransport, withLock = run => {
    if (!globalThis.navigator?.locks?.request) throw err("LOCK_UNAVAILABLE");
    return navigator.locks.request("weekly-private-sync-v1", { mode: "exclusive" }, run);
  } }) {
  const defaults = () => ({ version: 1, deviceId: null, enabled: false, selection: EMPTY_SELECTION(),
    approvedNames: null, consentToken: null, revision: 0, lastSyncedAt: null, lastPayload: null, queue: null, blocked: null });
  function decode(saved) {
    if (!saved) return defaults();
    const m = JSON.parse(saved);
    if (m?.version !== 1 || typeof m.enabled !== "boolean" || !m.selection ||
      !["habitIds", "readingIds", "taskIds"].every(k => Array.isArray(m.selection[k]) && m.selection[k].every(id => typeof id === "string")) ||
      !Number.isInteger(m.revision) || m.revision < 0 || (m.enabled && (!m.deviceId || !m.approvedNames)) ||
      (m.queue && (!["upload", "enable"].includes(m.queue.action) || typeof m.queue.operationId !== "string" ||
        !Number.isInteger(m.queue.baseRevision) || m.queue.baseRevision < 0 || !m.queue.payload))) throw err("LOCAL_STATE_INVALID");
    if (m.queue) validatePayload(m.queue.payload);
    return Object.fromEntries(Object.entries(defaults()).map(([key, fallback]) => [key, m[key] ?? fallback]));
  }
  let meta = defaults(), localError = null, storedRaw = null, epoch = 0, observedStop = null;
  try {
    storedRaw = storage.getItem(SYNC_KEY); meta = decode(storedRaw); observedStop = storage.getItem(STOP_KEY);
    if (!meta.consentToken || meta.consentToken !== observedStop) meta.enabled = false;
  }
  catch { localError = "LOCAL_STATE_INVALID"; }
  let session = null, busy = false, flight = null, controller = null, localSavedAt = null, lastError = localError;
  const emit = () => onChange(getState());
  function syncExternal() {
    let raw;
    try { raw = storage.getItem(SYNC_KEY); }
    catch { throw err("LOCAL_QUEUE_FAILED"); }
    const stop = storage.getItem(STOP_KEY);
    const stopped = stop !== observedStop;
    if (raw === storedRaw && !stopped) return false;
    epoch++; controller?.abort(); storedRaw = raw; observedStop = stop;
    try { meta = decode(raw); if (!meta.consentToken || meta.consentToken !== stop) meta.enabled = false; lastError = null; }
    catch { meta = defaults(); lastError = "LOCAL_STATE_INVALID"; }
    emit(); return true;
  }
  const persist = next => {
    // Detect another tab's opt-out or queue change before overwriting shared metadata.
    if (syncExternal()) throw err("STATE_CHANGED");
    // Never send a snapshot that was not durably queued. Keep the old state on quota/error.
    const raw = JSON.stringify(next);
    try { storage.setItem(SYNC_KEY, raw); }
    catch { lastError = "LOCAL_QUEUE_FAILED"; emit(); throw err("LOCAL_QUEUE_FAILED"); }
    storedRaw = raw; meta = next; emit();
  };
  function getState() {
    return clone({ ...meta, busy, localSavedAt, error: lastError, online: online(),
      configured: session?.configured ?? null, connected: session?.connected ?? false,
      serverDeviceId: session?.deviceId ?? null, serverRevision: session?.revision ?? null });
  }
  const available = () => online() && visible();
  const namesFor = selection => {
    const items = listSelectableItems(storage);
    return Object.fromEntries([["habitIds", "habits"], ["readingIds", "reading"], ["taskIds", "tasks"]].map(([key, group]) => [key,
      selection[key].map(id => { const item = items[group].find(item => item.id === id); if (!item) throw err("REVIEW_REQUIRED"); return { id, name: item.name }; })]));
  };
  function review(selection) {
    const chosen = Object.fromEntries(Object.keys(EMPTY_SELECTION()).map(k => [k, [...new Set(selection[k] || [])].sort()]));
    try {
      const payload = buildPayload(storage, chosen);
      validatePayload(payload);
      return { selection: chosen, payload, json: JSON.stringify(payload, null, 2), names: namesFor(chosen) };
    } catch (e) { throw err(["SELECTION_CHANGED", "REVIEW_REQUIRED"].includes(e?.code) ? "REVIEW_REQUIRED" : "INVALID_LOCAL_DATA"); }
  }
  function pendingReview() {
    if (!meta.queue) throw err("NO_PENDING_OPERATION");
    validatePayload(meta.queue.payload);
    return { kind: "pending", operationId: meta.queue.operationId, payload: clone(meta.queue.payload),
      json: JSON.stringify(meta.queue.payload, null, 2) };
  }
  function assertPending(approved) {
    const current = pendingReview();
    if (!approved?.confirmed || approved.operationId !== current.operationId || approved.json !== current.json) throw err("REVIEW_REQUIRED");
    return current;
  }
  function assertReview(approved) {
    if (!approved || approved.confirmed !== true) throw err("REVIEW_REQUIRED");
    const current = review(approved.selection);
    if (current.json !== approved.json || JSON.stringify(current.names) !== JSON.stringify(approved.names)) throw err("REVIEW_REQUIRED");
    return current;
  }
  async function api(action, body) {
    if (syncExternal()) throw err("STATE_CHANGED");
    const requestEpoch = epoch;
    await ensureTransport();
    if (syncExternal() || epoch !== requestEpoch) throw err("STATE_CHANGED");
    if (!available()) throw err(online() ? "PAUSED" : "OFFLINE");
    controller = new AbortController();
    const headers = body ? { "Content-Type": "application/json", "x-csrf-token": session?.csrfToken || "" } : {};
    const response = await request(`${endpoint}?action=${action}`, { method: body ? "POST" : "GET", headers,
      credentials: "same-origin", cache: "no-store", signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
    let data;
    try { data = await response.json(); } catch { throw err("INVALID_RESPONSE"); }
    if (syncExternal() || epoch !== requestEpoch) throw err("STATE_CHANGED");
    if (!response.ok) throw Object.assign(err(ERROR_CODES[data?.error] || data?.error || "SERVER_ERROR"), { reason: data?.error });
    return data;
  }
  async function refreshStatus() {
    try { session = await api("status"); lastError = session.authError ? (ERROR_CODES[session.authError] || "UNAUTHENTICATED") : null; emit(); return clone({ ...session, csrfToken: undefined }); }
    catch (e) { lastError = codeOf(e); emit(); throw e; }
  }
  async function authenticate() {
    await refreshStatus();
    if (!session.configured) throw err("NOT_CONFIGURED");
    if (!session.connected) throw err("UNAUTHENTICATED");
    if (session.deviceId && session.deviceId !== meta.deviceId) throw err("DEVICE_MISMATCH");
  }
  function recordError(e) {
    lastError = codeOf(e);
    if (BLOCKING.has(lastError)) {
      try { persist({ ...meta, blocked: lastError }); } catch { /* original outbox remains intact */ }
    }
    emit();
  }
  function queueCurrent() {
    if (!meta.enabled || meta.blocked || meta.queue) return;
    let current;
    try {
      current = review(meta.selection);
      if (JSON.stringify(current.names) !== JSON.stringify(meta.approvedNames)) throw err("REVIEW_REQUIRED");
    } catch (e) { recordError(e); return; }
    if (JSON.stringify(current.payload) === meta.lastPayload) return;
    persist({ ...meta, queue: { action: "upload", operationId: uuid(), baseRevision: meta.revision, payload: current.payload } });
  }
  async function sendQueue() {
    const queued = meta.queue;
    const response = await api(queued.action, { deviceId: meta.deviceId, baseRevision: queued.baseRevision,
      operationId: queued.operationId, payload: queued.payload });
    if (response.deviceId !== meta.deviceId || !Number.isInteger(response.revision) || response.revision <= queued.baseRevision ||
      typeof response.lastSyncedAt !== "string" || typeof response.enabled !== "boolean") throw err("INVALID_RESPONSE");
    // Only the exact acknowledged operation can leave the outbox.
    if (meta.queue?.operationId !== queued.operationId) throw err("REVIEW_REQUIRED");
    persist({ ...meta, revision: response.revision, lastSyncedAt: response.lastSyncedAt,
      lastPayload: JSON.stringify(queued.payload), queue: null, blocked: null, enabled: meta.enabled && response.enabled });
    lastError = null;
    return response;
  }
  function attempt() {
    try { syncExternal(); } catch (e) { recordError(e); return Promise.resolve(); }
    if (flight) return flight;
    if (!meta.enabled || meta.blocked || !available()) { emit(); return Promise.resolve(); }
    flight = Promise.resolve().then(async () => {
      busy = true; emit();
      try {
        queueCurrent();
        if (!meta.queue || meta.blocked) return;
        await authenticate();
        while (meta.enabled && !meta.blocked && available()) {
          if (!meta.queue) queueCurrent();
          if (!meta.queue || meta.blocked) break;
          // Initial activation is always an explicit owner action, never a launch/resume side effect.
          if (meta.queue.action !== "upload") break;
          // Renames/deletions require a fresh preview, even if another snapshot is already queued.
          if (JSON.stringify(namesFor(meta.selection)) !== JSON.stringify(meta.approvedNames)) throw err("REVIEW_REQUIRED");
          await sendQueue();
        }
      } catch (e) { recordError(e); }
      finally { busy = false; controller = null; flight = null; emit(); }
    });
    return flight;
  }
  async function connect(approved) {
    if (busy) throw err("BUSY");
    syncExternal();
    const actionEpoch = ++epoch;
    const current = approved?.kind === "pending"
      ? (assertPending(approved), { selection: meta.selection, names: meta.approvedNames }) : assertReview(approved);
    // Returning from OAuth must not automatically enable uploads.
    persist({ ...meta, deviceId: meta.deviceId || uuid(), enabled: false, selection: current.selection, approvedNames: current.names });
    busy = true; emit();
    try {
      await refreshStatus();
      if (epoch !== actionEpoch) throw err("STATE_CHANGED");
      if (!session.configured) throw err("NOT_CONFIGURED");
      const result = await api("connect", { deviceId: meta.deviceId });
      const url = new URL(result.authorizationUrl);
      if (url.protocol !== "https:" || url.hostname !== "accounts.google.com") throw err("INVALID_RESPONSE");
      if (epoch !== actionEpoch) throw err("STATE_CHANGED");
      return url.href;
    } catch (e) { recordError(e); throw e; }
    finally { busy = false; controller = null; emit(); }
  }
  function ensureStopMarker() {
    if (observedStop) return;
    // Allocate before activating: subsequent Stop writes replace a same-size UUID,
    // so a full quota cannot turn the first opt-out into a new-key allocation.
    const token = uuid();
    try { storage.setItem(STOP_KEY, token); }
    catch { throw err("LOCAL_QUEUE_FAILED"); }
    observedStop = token;
  }
  async function enable(approved) {
    if (busy) throw err("BUSY");
    syncExternal(); ensureStopMarker();
    const actionEpoch = ++epoch, actionStop = observedStop;
    const current = assertReview(approved);
    busy = true; emit();
    try {
      if (!meta.deviceId) persist({ ...meta, deviceId: uuid() });
      await authenticate();
      if (epoch !== actionEpoch) throw err("STATE_CHANGED");
      if (!Number.isInteger(session.revision) || session.revision < 0) throw err("INVALID_RESPONSE");
      // An uncertain operation must be resolved using its exact durable identity.
      // The dedicated previous-send review can recover it even if local data changed.
      if (meta.queue) throw err("PENDING_REVIEW_REQUIRED");
      const queue = { action: "enable", operationId: uuid(), baseRevision: session.revision, payload: current.payload };
      persist({ ...meta, enabled: false, selection: current.selection, approvedNames: current.names, blocked: null, queue });
      const activation = await sendQueue();
      if (epoch !== actionEpoch) throw err("STATE_CHANGED");
      if (!activation.enabled) throw err("REVIEW_REQUIRED");
      persist({ ...meta, enabled: true, consentToken: actionStop });
      syncExternal();
    } catch (e) { recordError(e); throw e; }
    finally { busy = false; controller = null; emit(); }
    // A record saved during activation is queued only after the activation ACK.
    queueCurrent();
    return attempt();
  }
  async function retryPending(approved) {
    if (busy) throw err("BUSY");
    syncExternal(); const actionEpoch = ++epoch;
    assertPending(approved);
    busy = true; emit();
    try {
      // Confirming an old operation never resumes ongoing automatic uploads.
      persist({ ...meta, enabled: false });
      await authenticate();
      if (epoch !== actionEpoch) throw err("STATE_CHANGED");
      try { await sendQueue(); }
      catch (e) {
        if (!["SYNC_DISABLED", "PENDING_DISABLED"].includes(codeOf(e)) || meta.queue?.action !== "upload") throw e;
        // This explicit review permits renewing the same write after reconnect.
        // Preserve every identity field, including original base revision.
        persist({ ...meta, queue: { ...meta.queue, action: "enable" } });
        await sendQueue();
      }
      lastError = null;
    } catch (e) { recordError(e); throw e; }
    finally { busy = false; controller = null; emit(); }
  }
  function disable() {
    // A separate atomic stop marker is never rewritten by queue/ACK writes.
    // It wins even if another tab is between its metadata read and write.
    const token = uuid();
    let stoppedToken = token;
    try { storage.setItem(STOP_KEY, token); }
    catch {
      // Removing only the preallocated consent marker also revokes consent and
      // normally remains possible when quota is full. Never delete the outbox.
      try {
        storage.removeItem(STOP_KEY);
        if (storage.getItem(STOP_KEY) !== null || !meta.consentToken) throw err("STOP_NOT_SAVED");
        stoppedToken = null;
      } catch {
        lastError = "STOP_NOT_SAVED"; epoch++; controller?.abort(); meta.enabled = false; emit(); throw err("STOP_NOT_SAVED");
      }
    }
    observedStop = stoppedToken; epoch++; controller?.abort(); meta.enabled = false; emit();
  }
  function flushDisabled() {
    syncExternal();
    if (meta.consentToken !== observedStop) {
      try { persist({ ...meta, enabled: false }); }
      catch (e) {
        // The marker has already durably revoked consent. Updating the larger
        // informational blob is optional and may need one extra quota byte.
        if (codeOf(e) !== "LOCAL_QUEUE_FAILED" || storage.getItem(STOP_KEY) === meta.consentToken) throw e;
        lastError = null; emit();
      }
    }
  }
  async function disconnect() {
    disable();
    if (flight) await flight;
    if (busy) throw err("BUSY");
    busy = true; emit();
    try {
      await refreshStatus();
      await api("disconnect", {});
      session = null;
      persist({ ...meta, enabled: false, blocked: null });
      lastError = null;
    } catch (e) { recordError(e); throw e; }
    finally { busy = false; controller = null; emit(); }
  }
  function localSaved(key) {
    if (!SOURCE_KEYS.has(key)) return Promise.resolve();
    try { syncExternal(); } catch (e) { recordError(e); return Promise.resolve(); }
    localSavedAt = now(); emit();
    if (!meta.enabled) return Promise.resolve();
    try { queueCurrent(); } catch { return Promise.resolve(); }
    return attempt();
  }
  function resume() {
    try { syncExternal(); } catch (e) { recordError(e); return Promise.resolve(); }
    if (!meta.enabled) return Promise.resolve();
    try { queueCurrent(); } catch { return Promise.resolve(); }
    return attempt();
  }
  function pause() { epoch++; controller?.abort(); emit(); }
  const exclusive = action => async (...args) => {
    try { return await withLock(() => action(...args)); }
    catch (e) { lastError = codeOf(e); emit(); throw e; }
  };
  const passive = action => async (...args) => {
    // No lock or backend work while off, including unsupported/older browsers.
    try {
      syncExternal();
      if (!meta.enabled) {
        if (action === localSaved && SOURCE_KEYS.has(args[0])) { localSavedAt = now(); emit(); }
        return;
      }
      return await withLock(() => action(...args));
    } catch (e) { lastError = codeOf(e); emit(); }
  };
  return { getState, review, pendingReview, retryPending: exclusive(retryPending), refreshStatus: exclusive(refreshStatus), connect: exclusive(connect), enable: exclusive(enable),
    disable: () => { disable(); return exclusive(flushDisabled)(); }, disconnect: exclusive(disconnect),
    localSaved: passive(localSaved), resume: passive(resume), pause, attempt: passive(attempt), syncExternal };
}
