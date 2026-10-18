import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPrivateSyncClient, ensurePrivateSyncTransport, SYNC_KEY, STOP_KEY } from '../js/private-sync-client.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function fixture(existing) {
  const map = existing || new Map(); let serial = 0;
  const store = { getItem: k => map.get(k) ?? null, setItem: (k,v) => {
    if (f.failSave || (f.quotaFull && (!map.has(k) || v.length > map.get(k).length))) throw new Error('quota'); map.set(k,v);
  }, removeItem: k => { if(f.failRemove) throw new Error('denied'); map.delete(k); } };
  const source = { value: 1, name: '英語' };
  const calls = [], receipts = new Map();
  const server = { configured: true, connected: true, deviceId: null, revision: 0, enabled: false, lastSyncedAt: null, csrfToken: 'memory-csrf-secret' };
  const f = { map, store, source, calls, server, receipts, failSave: false, online: true, visible: true, hook: null };
  const response = (data,status=200) => ({ ok: status < 400, status, json: async () => data });
  f.respond = response;
  let lock = Promise.resolve();
  const withLock = run => { const result = lock.then(run); lock = result.catch(() => {}); return result; };
  f.make = () => createPrivateSyncClient({ withLock, ensureTransport:()=>f.transport ? f.transport() : Promise.resolve(), storage: store, fetch: async (url, options) => {
    const action = new URL(url, 'https://example.test').searchParams.get('action'), body = options.body && JSON.parse(options.body);
    const call = { action, body, options }; calls.push(call);
    if (f.hook) { const result = await f.hook(call); if (result) return result; }
    if (action === 'status') return response({ ...server });
    assert.equal(options.headers['x-csrf-token'], server.csrfToken);
    if (action === 'connect') return response({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?synthetic=true' });
    if (action === 'disconnect') { server.connected = false; return response({ ok: true }); }
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
  }, buildPayload: (_store, selection) => {
    if (!selection.habitIds.length || source.value === null) throw Object.assign(new Error('empty'), { code: 'EMPTY_PAYLOAD' });
    return { schemaVersion: 1, value: source.value, name: source.name };
  }, listSelectableItems: () => ({ habits: [{ id: 'h_english', name: source.name }], reading: [], tasks: [] }),
  validatePayload: payload => { assert.equal(payload.schemaVersion, 1); },
  online: () => f.online, visible: () => f.visible, uuid: () => `operation-${String(++serial).padStart(26,"0")}`, now: () => '2026-10-18T12:00:00Z' });
  f.client = f.make();
  f.approval = () => ({ ...f.client.review({ habitIds: ['h_english'], readingIds: [], taskIds: [] }), confirmed: true });
  f.enable = () => f.client.enable(f.approval());
  return f;
}

test('off by default: no network on launch, resume, or local changes; no automatic selection', async () => {
  const f=fixture(); await f.client.resume(); await f.client.localSaved('wt_habit_log_v1');
  assert.equal(f.calls.length,0); assert.equal(f.client.getState().enabled,false);
  assert.deepEqual(f.client.getState().selection,{habitIds:[],readingIds:[],taskIds:[]});
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
test('names changed after consent block pending upload rather than transmit newly sensitive text', async () => {
  const f=fixture(); await f.enable(); f.source.name='changed private name'; f.source.value=2;
  const count=f.calls.length; await f.client.localSaved('wt_habits_v1');
  assert.equal(f.calls.length,count); assert.equal(f.client.getState().blocked,'REVIEW_REQUIRED');
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
test('old pending snapshot can be explicitly reviewed after a selected source is renamed', async () => {
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
  const f=fixture(); const c=createPrivateSyncClient({storage:f.store,withLock:()=>{throw Object.assign(new Error('missing lock'),{code:'LOCK_UNAVAILABLE'});},fetch:()=>{throw new Error('must not send')},
    buildPayload:()=>({value:1}),listSelectableItems:()=>({habits:[{id:'h',name:'safe'}],reading:[],tasks:[]}),
    online:()=>true,visible:()=>true,uuid:()=> 'safe-device'});
  const approved={...c.review({habitIds:['h'],readingIds:[],taskIds:[]}),confirmed:true};
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
