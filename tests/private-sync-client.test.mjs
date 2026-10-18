import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPrivateSyncClient, ensurePrivateSyncTransport, SYNC_KEY, STOP_KEY, CONSENT_VERSION } from '../js/private-sync-client.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function fixture(existing) {
  const map = existing || new Map(); let serial = 0;
  const store = { getItem: k => map.get(k) ?? null, setItem: (k,v) => {
    if (f.failSave || (f.quotaFull && (!map.has(k) || v.length > map.get(k).length))) throw new Error('quota'); map.set(k,v);
  }, removeItem: k => { if(f.failRemove) throw new Error('denied'); map.delete(k); } };
  const source = { value: 1, name: '英語', extraItems: [] };
  const calls = [], receipts = new Map();
  const server = { configured: true, connected: true, deviceId: null, revision: 0, enabled: false, lastSyncedAt: null, csrfToken: 'memory-csrf-secret' };
  const f = { map, store, source, calls, server, receipts, failSave: false, online: true, visible: true, hook: null, now: '2026-10-18T12:00:00Z', zone: 'UTC' };
  const response = (data,status=200) => ({ ok: status < 400, status, json: async () => data });
  f.respond = response;
  let lock = Promise.resolve();
  const withLock = run => { const result = lock.then(run); lock = result.catch(() => {}); return result; };
  f.make = (options = {}) => createPrivateSyncClient({ uiConsentVersion: CONSENT_VERSION, withLock, ensureTransport:()=>f.transport ? f.transport() : Promise.resolve(), storage: store, fetch: async (url, options) => {
    const action = new URL(url, 'https://example.test').searchParams.get('action'), body = options.body && JSON.parse(options.body);
    const call = { action, body, options }; calls.push(call);
    if (f.hook) { const result = await f.hook(call); if (result) return result; }
    if (action === 'status') return response({ ...server });
    assert.equal(options.headers['x-csrf-token'], server.csrfToken);
    if (action === 'connect') return response({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?synthetic=true' });
    if (action === 'disconnect') { server.connected = false; return response({ ok: true }); }
    assert.equal(body.consentVersion, 3, 'every snapshot write binds Notion consent');
    const saved = JSON.parse(map.get(SYNC_KEY));
    assert.equal(saved.queue.operationId, body.operationId, 'operation is persisted before network request');
    assert.deepEqual(saved.queue.payload, body.payload);
    if (receipts.has(body.operationId)) return response(receipts.get(body.operationId));
    if (body.baseRevision !== server.revision) return response({ error: 'revision_conflict' }, 409);
    server.deviceId = body.deviceId; server.revision++; server.enabled = true;
    server.lastSyncedAt = `2026-10-18T12:00:${String(server.revision).padStart(2,'0')}Z`;
    const result = { ...server }; receipts.set(body.operationId, result);
    if (f.loseResponse) { f.loseResponse = false; throw new TypeError('lost response'); }
    return response(result);
  }, buildPayload: (_store, { asOf, timeZone }) => {
    if (source.value === null) throw Object.assign(new Error('empty'), { code: 'EMPTY_PAYLOAD' });
    return { schemaVersion: 2, asOf, timeZone, value: source.value, name: source.name,
      habits: [{ id: 'h_english', name: source.name }, ...source.extraItems], reading: [], tasks: [], routines: [] };
  }, validatePayload: payload => { assert.equal(payload.schemaVersion, 2); },
  validateLegacyPayload: payload => { assert.equal(payload.schemaVersion, 1); },
  online: () => f.online, visible: () => f.visible, uuid: () => `operation-${String(++serial).padStart(26,"0")}`,
  now: () => f.now, timeZone: () => f.zone, ...options });
  f.client = f.make();
  f.approval = () => ({ ...f.client.review(), confirmed: true });
  f.enable = () => f.client.enable(f.approval());
  return f;
}

test('off by default: no network on launch, resume, or local changes; category consent is not implied', async () => {
  const f=fixture(); await f.client.resume(); await f.client.localSaved('wt_habit_log_v1');
  assert.equal(f.calls.length,0); assert.equal(f.client.getState().enabled,false);
  assert.equal(f.client.getState().consentVersion,null); assert.equal(f.client.getState().version,2);
  assert.equal(f.client.getState().selection,undefined);
});
test('connection requires reviewed consent; connects without enabling or uploading', async () => {
  const f=fixture();
  await assert.rejects(f.client.connect({ ...f.approval(), confirmed:false }),{code:'REVIEW_REQUIRED'});
  const url=await f.client.connect(f.approval());
  assert.match(url,/accounts.google.com/); assert.deepEqual(f.calls.map(c=>c.action),['status','connect']);
  assert.equal(f.client.getState().enabled,false); assert.equal(f.client.getState().queue,null);
  assert.ok(!f.map.get(SYNC_KEY).includes('memory-csrf-secret'));
});
test('explicit enable durably queues, keeps credentials out of local storage, and deduplicates unchanged snapshots', async () => {
  const f=fixture(); await f.enable();
  assert.equal(f.client.getState().enabled,true); assert.equal(f.client.getState().revision,1);
  const count=f.calls.length; await f.client.resume(); await f.client.localSaved('wt_records'); await f.client.resume();
  assert.equal(f.calls.length,count); assert.ok(!f.map.get(SYNC_KEY).includes('memory-csrf-secret'));
  for(const call of f.calls) { assert.equal(call.options.credentials,'same-origin'); assert.equal(call.options.cache,'no-store'); }
});
test('offline save persists queue, then online reload replays the same operation', async () => {
  const f=fixture(); await f.enable(); f.online=false; f.source.value=2;
  await f.client.localSaved('wt_habit_log_v1'); const pending=f.client.getState().queue; const count=f.calls.length;
  assert.equal(pending.payload.value,2); assert.equal(f.calls.length,count);
  f.client=f.make(); f.online=true; await f.client.resume();
  assert.equal(f.calls.at(-1).body.operationId,pending.operationId); assert.equal(f.client.getState().queue,null);
});
test('lost response retains exact operation and coalesces new data only after prior ACK', async () => {
  const f=fixture(); await f.enable(); f.source.value=2; f.loseResponse=true;
  await f.client.localSaved('wt_habit_log_v1'); const pending=f.client.getState().queue;
  assert.equal(f.client.getState().revision,1); assert.equal(f.server.revision,2);
  f.source.value=3; await f.client.localSaved('wt_habit_log_v1');
  const uploads=f.calls.filter(c=>c.action==='upload');
  assert.deepEqual(uploads.map(c=>c.body.payload.value),[2,2,3]);
  assert.equal(uploads[0].body.operationId,uploads[1].body.operationId);
  assert.equal(uploads[0].body.baseRevision,uploads[1].body.baseRevision);
  assert.equal(f.server.revision,3); assert.equal(f.client.getState().revision,3);
});
test('record changed in flight is sent only after original acknowledgment', async () => {
  const f=fixture(); await f.enable(); const hold=deferred(); let waiting=true;
  f.hook=async c=>{if(c.action==='upload' && waiting){ waiting=false; await hold.promise; }};
  f.source.value=2; const flight=f.client.localSaved('wt_habit_log_v1'); await tick();
  const pending=f.client.getState().queue; f.source.value=4;
  const second=f.client.localSaved('wt_habit_log_v1'); assert.deepEqual(f.client.getState().queue,pending);
  hold.resolve(); await Promise.all([flight,second]);
  assert.deepEqual(f.calls.filter(c=>c.action==='upload').map(c=>c.body.payload.value),[2,4]);
});
test('session loss keeps queue and does not upload until explicit reconnection/review', async () => {
  const f=fixture(); await f.enable(); f.server.connected=false; f.source.value=2;
  await f.client.localSaved('wt_habit_log_v1');
  assert.equal(f.client.getState().blocked,'UNAUTHENTICATED'); assert.equal(f.client.getState().queue.payload.value,2);
  const count=f.calls.length; await f.client.resume(); assert.equal(f.calls.length,count);
});
test('conflict never silently adopts server revision or retries automatically', async () => {
  const f=fixture(); await f.enable(); f.server.revision=8; f.source.value=2;
  await f.client.localSaved('wt_habit_log_v1');
  assert.equal(f.client.getState().blocked,'CONFLICT'); assert.equal(f.client.getState().revision,1);
  assert.equal(f.client.getState().queue.baseRevision,1);
  await f.client.refreshStatus(); const count=f.calls.length; await f.client.resume();
  assert.equal(f.calls.length,count); assert.equal(f.client.getState().revision,1);
});
test('failed outbox persistence never starts network and preserves local-save indication', async () => {
  const f=fixture(); await f.enable(); const count=f.calls.length;
  f.source.value=2; f.failSave=true; await f.client.localSaved('wt_habit_log_v1');
  assert.equal(f.calls.length,count); assert.equal(f.client.getState().error,'LOCAL_QUEUE_FAILED');
  assert.equal(f.client.getState().localSavedAt,'2026-10-18T12:00:00Z'); assert.equal(f.client.getState().queue,null);
});
test('post-success save hooks never fire when the local source write fails', () => {
  const tracker=fs.readFileSync(new URL('../tracker.html',import.meta.url),'utf8');
  const reading=fs.readFileSync(new URL('../js/reading-ui.mjs',import.meta.url),'utf8');
  const snippets=[tracker.match(/function persist\(\)\{[\s\S]*?\n\}/)[0]+';persist();',
    tracker.match(/const write = \(k, v\) => \{[\s\S]*?\n\};/)[0]+';write("wt_habit_log_v1",{});',
    reading.match(/function save\(data\) \{[\s\S]*?\n\}/)[0]+';save({});'];
  for(const script of snippets) {
    let events=0;
    const ctx={localStorage:{setItem:()=>{throw new Error('disk full')}},window:{dispatchEvent:()=>events++},CustomEvent:class{},records:{},R:{KEY:'wt_reading_v1'}};
    assert.throws(()=>vm.runInNewContext(script,ctx),/disk full/); assert.equal(events,0);
  }
});
test('category-wide consent includes renamed items automatically without per-name approval', async () => {
  const f=fixture(); await f.enable(); f.source.name='名前の変更'; f.source.value=2;
  await f.client.localSaved('wt_habits_v1');
  assert.equal(f.client.getState().blocked,null); assert.equal(f.calls.at(-1).body.payload.name,'名前の変更');
  assert.equal(f.client.getState().consentVersion,CONSENT_VERSION);
});
test('hidden app does not attempt, and foreground resume retries persisted data', async () => {
  const f=fixture(); await f.enable(); f.visible=false; f.source.value=2;
  const count=f.calls.length; await f.client.localSaved('wt_habit_log_v1'); assert.equal(f.calls.length,count);
  f.visible=true; await f.client.resume(); assert.equal(f.client.getState().revision,2);
});
test('disable while enable response is delayed cannot be undone by a late success', async () => {
  const f=fixture(); const hold=deferred(); f.hook=async c=>{if(c.action==='enable') await hold.promise;};
  const flight=f.enable(); await tick(); const stopped=f.client.disable(); hold.resolve();
  await assert.rejects(flight,{code:'STATE_CHANGED'}); await stopped;
  assert.equal(f.client.getState().enabled,false); assert.equal(JSON.parse(f.map.get(SYNC_KEY)).enabled,false);
  assert.ok(f.client.getState().queue,'uncertain operation is retained');
});
test('another tab stopping sync propagates before a stale tab can save/send', async () => {
  const f=fixture(); await f.enable(); const second=f.make(); await second.disable();
  const count=f.calls.length; f.source.value=2; await f.client.localSaved('wt_habit_log_v1');
  assert.equal(f.calls.length,count); assert.equal(f.client.getState().enabled,false);
});
test('another tab stopping during in-flight upload cannot be overwritten by acknowledgment', async () => {
  const f=fixture(); await f.enable(); const hold=deferred(); f.hook=async c=>{if(c.action==='upload') await hold.promise;};
  f.source.value=2; const flight=f.client.localSaved('wt_habit_log_v1'); await tick();
  const second=f.make(); const stopped=second.disable(); hold.resolve(); await flight; await stopped;
  assert.equal(JSON.parse(f.map.get(SYNC_KEY)).enabled,false); assert.equal(f.client.getState().enabled,false);
  assert.ok(f.client.getState().queue);
});
test('corrupt persisted sync state starts disabled and leaves source records alone', async () => {
  const map=new Map([[SYNC_KEY,'{broken'],['wt_records','{"sentinel":true}']]); const f=fixture(map);
  await f.client.resume(); assert.equal(f.client.getState().enabled,false); assert.equal(f.calls.length,0);
  assert.equal(map.get('wt_records'),'{"sentinel":true}');
});

test('lost enable acknowledgment cannot be replaced by a new snapshot; exact pending review recovers first', async () => {
  const f=fixture(); f.loseResponse=true;
  await assert.rejects(f.enable()); const original=f.client.getState().queue;
  f.source.value=3;
  await assert.rejects(f.enable(),{code:'PENDING_REVIEW_REQUIRED'});
  assert.deepEqual(f.client.getState().queue,original);
  await f.client.retryPending({...f.client.pendingReview(),confirmed:true});
  assert.equal(f.client.getState().enabled,false); assert.equal(f.client.getState().queue,null);
  assert.equal(f.calls.filter(c=>c.action==='enable').at(-1).body.operationId,original.operationId);
  await f.enable(); assert.equal(f.client.getState().enabled,true);
  assert.equal(f.calls.filter(c=>c.action==='enable').at(-1).body.payload.value,3);
});
test('current-format pending snapshot can be explicitly reviewed after a source is renamed', async () => {
  const f=fixture(); await f.enable(); f.source.value=2; f.loseResponse=true;
  await f.client.localSaved('wt_habit_log_v1'); const original=f.client.getState().queue;
  await f.client.disable(); f.source.name='new private label';
  const approved={...f.client.pendingReview(),confirmed:true};
  assert.equal(approved.payload.name,'英語'); await f.client.retryPending(approved);
  assert.equal(f.calls.filter(c=>c.action==='upload').at(-1).body.operationId,original.operationId);
  assert.equal(f.calls.filter(c=>c.action==='upload').at(-1).body.payload.name,'英語');
  assert.equal(f.client.getState().enabled,false);
});
test('reconnection recovery renews only the exact disabled pending operation', async () => {
  const f=fixture(); await f.enable(); f.online=false; f.source.value=2;
  await f.client.localSaved('wt_habit_log_v1'); const old=f.client.getState().queue;
  await f.client.disable(); f.online=true;
  f.hook=async c=>c.action==='upload'? f.respond({error:'pending_disabled'},409):undefined;
  await f.client.retryPending({...f.client.pendingReview(),confirmed:true});
  const retry=f.calls.at(-1);
  assert.equal(retry.action,'enable'); assert.equal(retry.body.operationId,old.operationId);
  assert.equal(retry.body.baseRevision,old.baseRevision); assert.deepEqual(retry.body.payload,old.payload);
  assert.equal(f.client.getState().enabled,false);
});
test('disconnect preserves uncertain queue and never touches source stores', async () => {
  const f=fixture(); await f.enable(); f.online=false; f.source.value=2;
  await f.client.localSaved('wt_habit_log_v1'); const queue=f.client.getState().queue;
  f.map.set('wt_records','source sentinel'); f.online=true;
  await f.client.disconnect();
  assert.deepEqual(f.client.getState().queue,queue); assert.equal(f.client.getState().enabled,false);
  assert.equal(f.map.get('wt_records'),'source sentinel');
});
test('background pause retains an uncertain successful operation for later idempotent acknowledgment', async () => {
  const f=fixture(); await f.enable(); const hold=deferred();
  f.hook=async c=>{if(c.action==='upload') await hold.promise;};
  f.source.value=2; const flight=f.client.localSaved('wt_habit_log_v1'); await tick();
  f.visible=false; f.client.pause(); hold.resolve(); await flight;
  assert.ok(f.client.getState().queue); assert.equal(f.client.getState().revision,1);
  f.visible=true; f.hook=null; await f.client.resume();
  assert.equal(f.client.getState().revision,2); assert.equal(f.client.getState().queue,null);
});
test('simultaneous tabs serialize their outbox and never lose an operation identity', async () => {
  const f=fixture(); await f.enable(); const second=f.make(); const hold=deferred(); let first=true;
  f.hook=async c=>{if(c.action==='upload' && first){first=false;await hold.promise;}};
  f.source.value=2; const a=f.client.localSaved('wt_habit_log_v1'); await tick();
  const original=JSON.parse(f.map.get(SYNC_KEY)).queue; f.source.value=3;
  const b=second.localSaved('wt_habit_log_v1'); await tick();
  assert.equal(JSON.parse(f.map.get(SYNC_KEY)).queue.operationId,original.operationId);
  hold.resolve(); await Promise.all([a,b]);
  const posts=f.calls.filter(c=>c.action==='upload');
  assert.deepEqual(posts.map(c=>c.body.payload.value),[2,3]);
  assert.equal(posts[0].body.operationId,original.operationId);
});
test('stop marker wins even if another tab stops exactly between metadata read and write', async () => {
  const f=fixture(); await f.enable(); const second=f.make(); const originalGet=f.store.getItem;
  let reads=0, stopping=null;
  f.store.getItem=key=>{
    const raw=originalGet(key);
    // Main-blob reads: passive preflight, localSaved preflight, persist preflight.
    if(key===SYNC_KEY && ++reads===3) stopping=second.disable();
    return raw;
  };
  const count=f.calls.length; f.source.value=2; await f.client.localSaved('wt_habit_log_v1');
  await stopping; f.store.getItem=originalGet;
  assert.equal(f.client.getState().enabled,false); assert.equal(f.calls.length,count);
  const reloaded=f.make(); assert.equal(reloaded.getState().enabled,false);
});
test('missing browser lock support fails closed without writing an outbox or sending network', async () => {
  const f=fixture(); const c=createPrivateSyncClient({uiConsentVersion:CONSENT_VERSION,storage:f.store,withLock:()=>{throw Object.assign(new Error('missing lock'),{code:'LOCK_UNAVAILABLE'});},fetch:()=>{throw new Error('must not send')},
    buildPayload:()=>({schemaVersion:2,value:1}),
    online:()=>true,visible:()=>true,uuid:()=> 'safe-device'});
  const approved={...c.review(),confirmed:true};
  await assert.rejects(c.enable(approved),{code:'LOCK_UNAVAILABLE'});
  assert.equal(c.getState().enabled,false); assert.equal(f.map.get(SYNC_KEY),undefined);
});

test('acknowledgment that leaves the server disabled never enables local auto sync', async () => {
  const f=fixture();
  f.hook=async c=>c.action==='enable'?f.respond({enabled:false,deviceId:c.body.deviceId,revision:1,lastSyncedAt:'2026-10-18T12:00:01Z'}):undefined;
  await assert.rejects(f.enable(),{code:'REVIEW_REQUIRED'});
  assert.equal(f.client.getState().enabled,false); assert.equal(f.client.getState().queue,null);
});
test('cancel during connect status fetch prevents OAuth navigation and connect POST', async () => {
  const f=fixture(); const hold=deferred();
  f.hook=async c=>{if(c.action==='status') await hold.promise;};
  const flight=f.client.connect(f.approval()); await tick();
  const stop=f.client.disable(); hold.resolve();
  await assert.rejects(flight,{code:'STATE_CHANGED'}); await stop;
  assert.ok(!f.calls.some(c=>c.action==='connect'));
});
test('safe callback error is surfaced without tokens or untrusted provider details', async () => {
  const f=fixture(); f.server.connected=false; f.server.authError='owner_forbidden';
  await f.client.refreshStatus(); assert.equal(f.client.getState().error,'OWNER_FORBIDDEN');
  assert.ok(!JSON.stringify(f.client.getState()).includes('memory-csrf-secret'));
});

test('stop is durable on reload when quota is full because its fixed-length marker was preallocated', async () => {
  const f=fixture(); await f.enable();
  assert.ok(f.map.has(STOP_KEY)); const marker=f.map.get(STOP_KEY);
  f.quotaFull=true; await f.client.disable();
  assert.notEqual(f.map.get(STOP_KEY),marker); assert.equal(f.map.get(STOP_KEY).length,marker.length);
  assert.equal(f.make().getState().enabled,false);
});
test('quota failure can revoke consent by removing only the marker while retaining the outbox', async () => {
  const f=fixture(); await f.enable(); f.online=false; f.source.value=2;
  await f.client.localSaved('wt_habit_log_v1'); const savedQueue=f.client.getState().queue;
  f.failSave=true; await f.client.disable();
  assert.equal(f.map.has(STOP_KEY),false); const reload=f.make();
  assert.equal(reload.getState().enabled,false); assert.deepEqual(reload.getState().queue,savedQueue);
});
test('if every storage mutation fails, Stop warns explicitly that opt-out is not durable', async () => {
  const f=fixture(); await f.enable(); f.failSave=true; f.failRemove=true;
  assert.throws(()=>f.client.disable(),{code:'STOP_NOT_SAVED'});
  assert.equal(f.client.getState().enabled,false); assert.equal(f.client.getState().error,'STOP_NOT_SAVED');
  assert.equal(f.make().getState().enabled,true,'persisted consent cannot be changed when storage denies every mutation');
});
test('failed stop-marker preallocation cannot activate sync or send any request', async () => {
  const f=fixture(); f.failSave=true;
  await assert.rejects(f.enable(),{code:'LOCAL_QUEUE_FAILED'});
  assert.equal(f.calls.length,0); assert.equal(f.client.getState().enabled,false);
});

test('legacy worker timeout blocks private status and connection before any network', async () => {
  const f=fixture(); const old={postMessage(){}}; f.transport=()=>ensurePrivateSyncTransport({serviceWorker:{controller:old,getRegistration:async()=>({active:old})},pageUrl:'https://weekly.test/tracker.html',timeoutMs:5});
  await assert.rejects(f.client.connect(f.approval()),{code:'UPDATE_REQUIRED'});
  assert.equal(f.calls.length,0); assert.equal(f.client.getState().enabled,false);
});
test('new cache-safe worker handshake permits traffic and is scoped to that controller', async () => {
  let requests=0;
  const worker={postMessage(message,ports){requests++;assert.equal(message.type,'weekly-private-sync-cache-check');ports[0].postMessage({type:'weekly-private-sync-cache-safe',version:1});}};
  const serviceWorker={controller:worker,getRegistration:async()=>({active:serviceWorker.controller})};
  await ensurePrivateSyncTransport({serviceWorker,pageUrl:"https://weekly.test/tracker.html"}); await ensurePrivateSyncTransport({serviceWorker,pageUrl:"https://weekly.test/tracker.html"});
  assert.equal(requests,1);
  serviceWorker.controller={postMessage(){}};
  await assert.rejects(ensurePrivateSyncTransport({serviceWorker,pageUrl:"https://weekly.test/tracker.html",timeoutMs:5}),{code:'UPDATE_REQUIRED'});
});
test('SW-unsupported browsers need no handshake and cancellation during handshake prevents API request', async () => {
  await ensurePrivateSyncTransport({serviceWorker:null,Channel:null});
  const f=fixture(), hold=deferred(); f.transport=()=>hold.promise;
  const flight=f.client.connect(f.approval()); await tick();
  const stopped=f.client.disable(); hold.resolve();
  await assert.rejects(flight,{code:'STATE_CHANGED'}); await stopped;
  assert.equal(f.calls.length,0);
});

test('uncontrolled page with legacy active registration cannot start OAuth callback navigation', async () => {
  const old={postMessage(){}};
  await assert.rejects(ensurePrivateSyncTransport({serviceWorker:{controller:null,getRegistration:async()=>({active:old})},
    pageUrl:'https://weekly.test/tracker.html',timeoutMs:5}),{code:'UPDATE_REQUIRED'});
});
test('temporarily missing active worker is not treated as an uncached OAuth bypass', async () => {
  await assert.rejects(ensurePrivateSyncTransport({serviceWorker:{controller:null,getRegistration:async()=>undefined},
    pageUrl:'https://weekly.test/tracker.html',timeoutMs:5}),{code:'UPDATE_REQUIRED'});
});
test('safe page controller cannot mask a legacy active worker for the OAuth callback scope', async () => {
  const safe={postMessage(_message,ports){ports[0].postMessage({type:'weekly-private-sync-cache-safe',version:1});}}, old={postMessage(){}};
  await assert.rejects(ensurePrivateSyncTransport({serviceWorker:{controller:safe,getRegistration:async url=>({active:url.includes('/api/')?old:safe})},
    pageUrl:'https://weekly.test/tracker.html',timeoutMs:5}),{code:'UPDATE_REQUIRED'});
});

test('newly added items automatically join the next snapshot under category consent', async () => {
  const f=fixture(); await f.enable(); f.source.extraItems.push({id:'h_new',name:'新しい習慣'});
  await f.client.localSaved('wt_habits_v1');
  assert.deepEqual(f.calls.at(-1).body.payload.habits.map(h=>h.id),['h_english','h_new']);
  assert.equal(f.client.getState().blocked,null);
});
test('initial approval must be fresh, exact, and explicitly versioned for category-wide scope', async () => {
  const f=fixture(), approved=f.approval();
  await assert.rejects(f.client.enable({...approved,consentVersion:1}),{code:'REVIEW_REQUIRED'});
  f.source.name='変更後'; await assert.rejects(f.client.enable(approved),{code:'REVIEW_REQUIRED'});
  assert.equal(f.calls.length,0); assert.equal(f.client.getState().queue,null);
  await f.enable(); assert.equal(f.client.getState().consentVersion,3);
});
function legacyState(queue=null) {
  return { version:1,deviceId:'legacy-device',enabled:true,selection:{habitIds:['old'],readingIds:[],taskIds:[]},
    approvedNames:{habitIds:[{id:'old',name:'旧名'}],readingIds:[],taskIds:[]},consentToken:'legacy-consent',
    revision:3,lastSyncedAt:'2026-10-17T12:00:00Z',lastPayload:null,queue,blocked:null };
}
test('v1 opt-in without pending data stays off until a fresh v3 Notion review', async () => {
  const raw=JSON.stringify(legacyState()), map=new Map([[SYNC_KEY,raw],[STOP_KEY,'legacy-consent']]), f=fixture(map);
  assert.equal(f.client.getState().blocked,'SCOPE_REVIEW_REQUIRED');
  await f.client.resume(); await f.client.localSaved('wt_habits_v1');
  assert.equal(f.calls.length,0); assert.equal(map.get(SYNC_KEY),raw);
  const approval=f.approval(); await f.client.connect(approval);
  assert.equal(f.client.getState().enabled,false);
  f.client=f.make(); await f.client.resume();
  assert.equal(f.calls.filter(c=>c.action==='enable'||c.action==='upload').length,0,'OAuth return does not grant consent');
  await f.enable(); assert.equal(f.client.getState().version,2); assert.equal(f.client.getState().consentVersion,3);
  assert.equal(f.client.getState().deviceId,'legacy-device');
  assert.equal('selection' in JSON.parse(map.get(SYNC_KEY)),false);
});
test('legacy pending remains byte-for-byte intact across review, stop, reload, reconnect, and rejected activation', async () => {
  const pending={action:'upload',operationId:'legacy-uncertain',baseRevision:3,payload:{schemaVersion:1,value:7,name:'旧名'}},
    raw=JSON.stringify(legacyState(pending),null,3), map=new Map([[SYNC_KEY,raw],[STOP_KEY,'legacy-consent']]), f=fixture(map);
  const approved={...f.client.pendingReview(),confirmed:true};
  assert.equal(approved.incompatible,true); assert.deepEqual(JSON.parse(approved.json),pending.payload);
  await f.client.resume(); await f.client.localSaved('wt_habits_v1');
  await assert.rejects(f.client.retryPending(approved),{code:'LEGACY_PENDING_REVIEW_REQUIRED'});
  await assert.rejects(f.client.connect(approved),{code:'LEGACY_PENDING_REVIEW_REQUIRED'});
  await assert.rejects(f.enable(),{code:'LEGACY_PENDING_REVIEW_REQUIRED'});
  await f.client.disable(); f.client=f.make(); await f.client.resume();
  assert.equal(map.get(SYNC_KEY),raw); assert.deepEqual(f.client.getState().queue,pending);
  assert.equal(f.calls.length,0); assert.equal(f.client.getState().enabled,false);
});
test('corrupt saved metadata cannot be replaced by enabling a new snapshot', async () => {
  const raw='{broken', f=fixture(new Map([[SYNC_KEY,raw]]));
  await assert.rejects(f.enable(),{code:'LOCAL_STATE_INVALID'});
  await assert.rejects(f.client.connect(f.approval()),{code:'LOCAL_STATE_INVALID'});
  assert.equal(f.map.get(SYNC_KEY),raw); assert.equal(f.calls.length,0);
});
test('server scope rejection retains uncertain queue and waits for explicit review', async () => {
  const f=fixture(); await f.enable(); f.hook=async c=>c.action==='upload'?f.respond({error:'scope_review_required'},409):undefined;
  f.source.value=2; await f.client.localSaved('wt_habit_log_v1'); const pending=f.client.getState().queue;
  assert.equal(f.client.getState().blocked,'SCOPE_REVIEW_REQUIRED');
  const calls=f.calls.length; await f.client.resume(); assert.equal(f.calls.length,calls);
  assert.deepEqual(f.client.getState().queue,pending);
});
test('date and timezone changes refresh snapshots without new per-item consent', async () => {
  const f=fixture(); f.now='2026-10-18T23:30:00Z'; await f.enable();
  f.zone='Asia/Tokyo'; await f.client.resume();
  assert.equal(f.calls.at(-1).body.payload.asOf,'2026-10-19'); assert.equal(f.calls.at(-1).body.payload.timeZone,'Asia/Tokyo');
  f.now='2026-10-19T23:30:00Z'; f.client=f.make(); await f.client.resume();
  assert.equal(f.calls.at(-1).body.payload.asOf,'2026-10-20');
});
test('approval for yesterday cannot activate today without a refreshed preview', async () => {
  const f=fixture(), approved=f.approval(); f.now='2026-10-19T12:00:00Z';
  await assert.rejects(f.client.enable(approved),{code:'REVIEW_REQUIRED'}); assert.equal(f.calls.length,0);
});
test('renames, additions, and date rollovers never rewrite an already queued snapshot', async () => {
  const f=fixture(); await f.enable(); f.online=false; f.source.value=2;
  await f.client.localSaved('wt_habit_log_v1'); const pending=f.client.getState().queue;
  f.source.name='新しい名前'; f.source.extraItems.push({id:'h_added',name:'追加'}); f.now='2026-10-19T12:00:00Z';
  await f.client.localSaved('wt_habits_v1'); assert.deepEqual(f.client.getState().queue,pending);
  f.online=true; await f.client.resume();
  const posts=f.calls.filter(c=>c.action==='upload');
  assert.deepEqual(posts[0].body.payload,pending.payload); assert.equal(posts[0].body.operationId,pending.operationId);
  assert.equal(posts[1].body.payload.name,'新しい名前'); assert.equal(posts[1].body.payload.asOf,'2026-10-19');
  assert.equal(posts[1].body.payload.habits.length,2);
});
test('mixed-cache UI without v3 handshake cannot review, connect, enable, resume, or recover a pending send', async () => {
  const f=fixture(); await f.enable(); f.online=false; f.source.value=2; await f.client.localSaved('wt_habit_log_v1');
  const approved=f.approval(), pending={...f.client.pendingReview(),confirmed:true}, raw=f.map.get(SYNC_KEY), count=f.calls.length;
  f.online=true; const stale=f.make({uiConsentVersion:undefined});
  assert.throws(()=>stale.review({habitIds:['h_english']}),{code:'UPDATE_REQUIRED'});
  await assert.rejects(stale.connect(approved),{code:'UPDATE_REQUIRED'});
  await assert.rejects(stale.enable(approved),{code:'UPDATE_REQUIRED'});
  await assert.rejects(stale.retryPending(pending),{code:'UPDATE_REQUIRED'});
  await stale.resume(); await stale.localSaved('wt_records');
  assert.equal(stale.getState().enabled,false); assert.equal(f.calls.length,count); assert.equal(f.map.get(SYNC_KEY),raw);
  await stale.disable(); assert.equal(f.make().getState().enabled,false,'Stop remains usable with stale UI');
});
test('oversize projection has a specific error and never truncates or sends a partial snapshot', async () => {
  const f=fixture(), raw=f.map.get(SYNC_KEY); f.client=f.make({buildPayload:()=>{throw Object.assign(new Error('large'),{code:'PAYLOAD_TOO_LARGE'});}});
  assert.throws(()=>f.client.review(),{code:'PAYLOAD_TOO_LARGE'});
  assert.equal(f.map.get(SYNC_KEY),raw); assert.equal(f.calls.length,0);
});
test('dismissing setup during connect cancels the late result without navigating or uploading', async () => {
  const f=fixture(), hold=deferred(); f.hook=async c=>{if(c.action==='connect') await hold.promise;};
  const flight=f.client.connect(f.approval()); await tick(); f.client.pause(); hold.resolve();
  await assert.rejects(flight,{code:'STATE_CHANGED'});
  assert.equal(f.client.getState().enabled,false); assert.equal(f.client.getState().queue,null);
});
test('dismissing setup before its Web Lock is acquired cancels the queued activation', async () => {
  const f=fixture(), hold=deferred(); f.client=f.make({withLock:async run=>{await hold.promise;return run();}});
  const flight=f.enable(); f.client.pause(); hold.resolve();
  await assert.rejects(flight,{code:'STATE_CHANGED'}); assert.equal(f.calls.length,0); assert.equal(f.map.has(SYNC_KEY),false);
});

// Small DOM adapter executes the real UI module without browser dependencies.
// This covers interaction wiring, not layout, accessibility rendering, or CUA.
function uiFixture() {
  const nodes=new Map(), listeners=new Map(), navigations=[], timers=new Map(), savedKeys=[]; let timerId=0, resumes=0;
  function element(tag) {
    const e={tagName:tag,children:[],listeners:new Map(),hidden:false,disabled:false,checked:false,textContent:'',
      append(...children){this.children.push(...children);},appendChild(child){this.append(child);},replaceChildren(...children){this.children=children;},
      addEventListener(type,handler){this.listeners.set(type,handler);},dispatch(type,event={}){return this.listeners.get(type)?.(event);},
      querySelectorAll(){return [];},getClientRects(){return [1];},focus(){document.activeElement=this;}};
    Object.defineProperty(e,'innerHTML',{set(markup){this.markup=markup;
      for(const match of markup.matchAll(/<([a-z0-9-]+)([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g)) {
        const node=element(match[1]);node.id=match[3];node.hidden=/\bhidden\b/.test(match[2]);node.disabled=/\bdisabled\b/.test(match[2]);node.textContent=match[4];nodes.set(node.id,node);
      }
    },get(){return this.markup||'';}});
    return e;
  }
  const document={hidden:false,body:element('body'),activeElement:null,createElement:element,getElementById:id=>nodes.get(id),
    addEventListener:(type,handler)=>listeners.set(`document:${type}`,handler)};
  nodes.set('private-sync-open',element('button'));document.activeElement=nodes.get('private-sync-open');
  const payload={schemaVersion:2,habits:[{name:'<img src=x onerror=unsafe>'}],tasks:[{},{}],routines:[{}],reading:[{},{},{}]},
    review={consentVersion:3,payload,json:JSON.stringify(payload,null,2)};
  const state={enabled:false,busy:false,queue:null,online:true,configured:true,connected:false,lastSyncedAt:null,blocked:null,error:null};
  const hold=deferred();let pauses=0,clientOptions;
  const client={getState:()=>state,review:()=>review,refreshStatus:async()=>{},resume:async()=>{resumes++;},pause:()=>{pauses++;},
    connect:()=>hold.promise,syncExternal:()=>{},localSaved:async key=>{savedKeys.push(key);}};
  const source=fs.readFileSync(new URL('../js/private-sync-ui.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  vm.runInNewContext(source,{document,window:{addEventListener:(type,handler)=>listeners.set(type,handler)},localStorage:{},
    fetch:()=>{throw new Error('No network allowed');},location:{assign:url=>navigations.push(url)},
    createPrivateSyncClient:options=>{clientOptions=options;return client;},buildPayload:()=>payload,validatePayload:()=>{},validateLegacyPayload:()=>{},
    SOURCE_KEYS:new Set(['wt_habits_v1','wt_records']),SYNC_KEY,STOP_KEY,
    setTimeout:(fn,delay)=>{assert.equal(delay,1500);timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
  return {nodes,document,payload,review,hold,navigations,clientOptions,listeners,timers,savedKeys,resumes:()=>resumes,flush:()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());},pauses:()=>pauses,overlay:document.body.children[0]};
}
test('UI renders four category counts, a single scope consent checkbox, and exact text-only JSON preview', async () => {
  const f=uiFixture(); await f.nodes.get('private-sync-open').dispatch('click');
  assert.equal(f.clientOptions.uiConsentVersion,3,'UI pins the consent wording version independently of imported client constants');
  assert.deepEqual(f.nodes.get('ps-categories').children.map(row=>row.children.map(node=>node.textContent)),
    [['タスク','2 件'],['習慣','1 件'],['日課','1 件'],['本','3 件']]);
  assert.equal((f.overlay.innerHTML.match(/type="checkbox"/g)||[]).length,1);
  assert.equal(f.nodes.get('ps-connect').disabled,true);
  f.nodes.get('ps-preview-button').dispatch('click');
  assert.equal(f.nodes.get('ps-preview').textContent,f.review.json);assert.equal(f.nodes.get('ps-preview').innerHTML,'');
  f.nodes.get('ps-consent').checked=true;f.nodes.get('ps-consent').dispatch('change');
  assert.equal(f.nodes.get('ps-connect').disabled,false);
});
test('UI Close and Escape invalidate setup and prevent late OAuth navigation, even after reopen', async () => {
  for(const method of ['close','escape']) {
    const f=uiFixture();await f.nodes.get('private-sync-open').dispatch('click');f.nodes.get('ps-preview-button').dispatch('click');
    f.nodes.get('ps-consent').checked=true;f.nodes.get('ps-consent').dispatch('change');
    const flight=f.nodes.get('ps-connect').dispatch('click');
    if(method==='close')f.nodes.get('ps-close').dispatch('click');else f.overlay.dispatch('keydown',{key:'Escape',preventDefault(){}});
    assert.equal(f.overlay.hidden,true);assert.equal(f.pauses(),1);assert.equal(f.nodes.get('ps-consent').checked,false);
    await f.nodes.get('private-sync-open').dispatch('click');
    f.hold.resolve('https://accounts.google.com/o/oauth2/v2/auth?synthetic=true');await flight;
    assert.deepEqual(f.navigations,[]);
  }
});

// Schema 2 was already used by Drive; a schema check alone cannot identify consent.
test('Drive schema-2 pending operations never replay to Notion and retain original bytes', async () => {
  for (const action of ['upload', 'enable']) {
    const source=fixture(); await source.enable();
    const state=source.client.getState(); state.consentVersion=2;
    state.queue={action,operationId:'drive-uncertain',baseRevision:state.revision,payload:source.approval().payload};
    const raw=JSON.stringify(state,null,3), map=new Map([[SYNC_KEY,raw],[STOP_KEY,state.consentToken]]), f=fixture(map);
    assert.equal(f.client.getState().enabled,false);
    assert.equal(f.client.getState().blocked,'LEGACY_PENDING_REVIEW_REQUIRED');
    const approved={...f.client.pendingReview(),confirmed:true};
    assert.equal(approved.incompatible,true); assert.deepEqual(approved.payload,state.queue.payload);
    await f.client.resume(); await f.client.localSaved('wt_records'); await f.client.attempt();
    await assert.rejects(f.client.retryPending(approved),{code:'LEGACY_PENDING_REVIEW_REQUIRED'});
    await assert.rejects(f.client.connect(approved),{code:'LEGACY_PENDING_REVIEW_REQUIRED'});
    await assert.rejects(f.enable(),{code:'LEGACY_PENDING_REVIEW_REQUIRED'});
    await f.client.disable(); f.client=f.make(); await f.client.resume();
    assert.equal(f.calls.length,0); assert.equal(map.get(SYNC_KEY),raw);
    assert.deepEqual(f.client.getState().queue,state.queue);
  }
});
test('Drive consent without a queue requires a fresh Notion review and uses new destination revision', async () => {
  const source=fixture(); await source.enable();
  const state=source.client.getState(); state.consentVersion=2; state.revision=45;
  const raw=JSON.stringify(state), f=fixture(new Map([[SYNC_KEY,raw],[STOP_KEY,state.consentToken]]));
  await f.client.resume(); await f.client.localSaved('wt_records');
  assert.equal(f.calls.length,0); assert.equal(f.client.getState().blocked,'SCOPE_REVIEW_REQUIRED');
  await assert.rejects(f.client.enable({...f.approval(),consentVersion:2}),{code:'REVIEW_REQUIRED'});
  assert.equal(f.calls.length,0);
  await f.enable();
  const sent=f.calls.find(c=>c.action==='enable');
  assert.equal(sent.body.baseRevision,0); assert.equal(sent.body.consentVersion,3);
  assert.equal(f.client.getState().revision,1); assert.equal(f.client.getState().consentVersion,3);
  assert.equal(f.client.getState().version,2); assert.equal(sent.body.payload.schemaVersion,2);
});
test('old Drive UI consent version cannot trigger Notion transport', async () => {
  const f=fixture(), stale=f.make({uiConsentVersion:2});
  assert.throws(()=>stale.review(),{code:'UPDATE_REQUIRED'});
  await assert.rejects(stale.connect(f.approval()),{code:'UPDATE_REQUIRED'});
  await assert.rejects(stale.enable(f.approval()),{code:'UPDATE_REQUIRED'});
  await stale.resume(); assert.equal(f.calls.length,0);
});
test('UI describes readable Notion snapshots, owner privacy verification, identity-only Google login, and staged completion', () => {
  const f=uiFixture(), copy=f.overlay.innerHTML;
  assert.match(copy,/Notion に進捗/); assert.match(copy,/見出しと項目ごとの記録/);
  assert.match(copy,/Notion API だけでは非公開を確認できません/);
  assert.match(copy,/所有者自身が Notion の保存先ページと親ページの共有設定を確認/);
  assert.match(copy,/Google ログインは所有者の本人確認だけ/);
  assert.match(copy,/直近 30 日分の日付別の記録/); assert.match(copy,/それ以前の履歴も含む集計・件数/);
  assert.match(copy,/Notion の表示内容そのものではなく/);
  assert.match(copy,/STAGING（未完了）/); assert.match(copy,/COMPLETE（完了）/);
  assert.match(copy,/ページ全体を一度に置き換える方式ではありません/);
  assert.match(f.nodes.get('ps-consent-label').textContent,/Notion の保存先と親ページが非公開/);
  assert.match(fs.readFileSync(new URL('../tracker.html',import.meta.url),'utf8'),/☁ Notion に進捗を同期/);
});

test('Notion snapshot limit blocks auto replay while rate limiting remains transient', async () => {
  for(const [code,expected,blocking] of [['snapshot_limit','SNAPSHOT_LIMIT',true],['provider_rate_limited','RATE_LIMITED',false]]) {
    const f=fixture(); await f.enable(); f.hook=async c=>c.action==='upload'?f.respond({error:code},429):undefined;
    f.source.value=2; await f.client.localSaved('wt_records');
    const state=f.client.getState(), pending=state.queue, count=f.calls.length;
    assert.equal(state.error,expected); assert.equal(state.blocked,blocking?expected:null);
    await f.client.resume(); assert.equal(f.calls.length===count,blocking);
    assert.deepEqual(f.client.getState().queue,pending);
    f.hook=null;
    if(blocking) await f.client.retryPending({...f.client.pendingReview(),confirmed:true}); else await f.client.resume();
    assert.equal(f.client.getState().queue,null);
  }
});
test('UI coalesces rapid saved events and cross-tab changes into one foreground send', () => {
  const f=uiFixture(), emit=key=>f.listeners.get('weekly:local-saved')({detail:{key}});
  emit('wt_habits_v1'); emit('wt_records');
  f.listeners.get('storage')({key:'wt_habits_v1'});
  assert.equal(f.timers.size,1); assert.deepEqual(f.savedKeys,[]);
  f.flush(); assert.deepEqual(f.savedKeys,['wt_habits_v1']);
  emit('unrelated'); assert.equal(f.timers.size,0);
});
test('UI cancels debounce on hide/pagehide and refreshes persisted sources on next resume', () => {
  for(const hide of ['hidden','pagehide']) {
    const f=uiFixture(); f.listeners.get('weekly:local-saved')({detail:{key:'wt_records'}});
    if(hide==='hidden'){f.document.hidden=true;f.listeners.get('document:visibilitychange')();}
    else f.listeners.get('pagehide')();
    assert.equal(f.timers.size,0); f.flush(); assert.deepEqual(f.savedKeys,[]);
    const resumes=f.resumes();
    f.document.hidden=false;
    if(hide==='hidden') f.listeners.get('document:visibilitychange')(); else f.listeners.get('pageshow')();
    assert.equal(f.resumes(),resumes+1);
  }
});
test('UI suppresses hidden-save timers and cancels a pending debounce before online resume', () => {
  const f=uiFixture(); f.document.hidden=true;
  f.listeners.get('weekly:local-saved')({detail:{key:'wt_records'}}); assert.equal(f.timers.size,0);
  f.document.hidden=false;f.listeners.get('weekly:local-saved')({detail:{key:'wt_records'}});
  const count=f.resumes(); f.listeners.get('online')();
  assert.equal(f.timers.size,0);assert.equal(f.resumes(),count+1);
});

test('same-day wallclock advances do not produce duplicate snapshots', async () => {
  const f=fixture(); await f.enable(); const count=f.calls.length;
  f.now='2026-10-18T19:59:59Z'; await f.client.resume(); await f.client.localSaved('wt_records');
  assert.equal(f.calls.length,count); assert.equal(f.client.getState().queue,null);
});
