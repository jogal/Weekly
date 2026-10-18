import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotion, snapshotBlocks } from '../server/private-sync/notion.mjs';

const parent = '11111111-1111-1111-1111-111111111111';
const config = { notionToken: 'server-only-test-secret', notionPageId: parent };
const envelope = (revision = 1, extra = {}) => ({ schemaVersion: 1, deviceId: 'abcdefghijklmnop', revision,
  operationId: 'operationabcdefghijkl', syncedAt: '2026-10-18T00:00:00.000Z',
  payload: { schemaVersion: 2, asOf: '2026-10-18', habits: [{ name: 'Walk', target: 1, unit: 'check', entries: [] }], ...extra } });
function harness() {
  const pages = new Map(); const calls = []; let counter = 1; let state = null; let intercept; let time = 1000;
  const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer server-only-test-secret');
    assert.equal(options.redirect, 'error');
    const path = new URL(url).pathname.replace('/v1', '');
    const body = options.body && JSON.parse(options.body);
    calls.push({ path, method: options.method, body, url });
    const paginate = values => { const start = Number(new URL(url).searchParams.get('start_cursor') || 0); const end = start + 100; return { results: values.slice(start, end), has_more: end < values.length, next_cursor: end < values.length ? String(end) : null }; };
    const before = intercept?.({ path, method: options.method, body, pages });
    if (before instanceof Response) return before;
    if (before === 'fail-before') throw new Error('private upstream body');
    let result;
    if (path === '/pages' && options.method === 'POST') {
      const id = `22222222-2222-2222-2222-${String(counter++).padStart(12, '0')}`;
      result = { id, parent: body.parent, properties: body.properties, archived: false, blocks: [] }; pages.set(id, result);
    } else if (path.startsWith('/pages/')) {
      result = pages.get(path.split('/')[2]);
      if (options.method === 'PATCH') Object.assign(result, body);
    } else if (path === `/blocks/${parent}/children`) {
      result = paginate([...pages.values()].filter(p => !p.archived).map(p => ({ id: p.id, type: 'child_page', child_page: { title: p.properties.title.title[0].text.content } }))); 
    } else {
      const p = pages.get(path.split('/')[2]);
      if (options.method === 'PATCH') p.blocks.push(...structuredClone(body.children));
      result = paginate(p.blocks);
    }
    if (before === 'fail-after') throw new Error('private upstream body');
    return response(result);
  };
  const notion = createNotion(config, fetcher, { paceMs: 0, now: () => time });
  const publish = (data = envelope(), overrides = {}) => notion.publish(data, { state: structuredClone(state),
    checkpoint: async (old, next) => { if (JSON.stringify(old) !== JSON.stringify(state)) return false; state = structuredClone(next); return true; },
    authorize: async () => {}, ...overrides });
  return { pages, calls, publish, elapse(ms) { time += ms; }, get state() { return state; }, reset() { state = null; }, set intercept(fn) { intercept = fn; } };
}

test('publishes exact content and complete only after verified block reads', async () => {
  const h = harness(); const { snapshotId } = await h.publish();
  const p = h.pages.get(snapshotId);
  assert.deepEqual(p.blocks, snapshotBlocks(envelope()));
  assert.match(p.properties.title.title[0].text.content, / COMPLETE$/);
  const completion = h.calls.findIndex(c => c.method === 'PATCH' && c.path.startsWith('/pages/'));
  assert.equal(h.calls[completion - 1].method, 'GET');
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
  await h.publish();
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('lost create response recovers unique page without duplicate POST', async () => {
  const h = harness(); h.intercept = c => c.method === 'POST' ? 'fail-after' : undefined;
  await assert.rejects(h.publish(), { code: 'provider_unavailable' });
  assert.equal(h.state.phase, 'creating'); h.intercept = null;
  await h.publish(); assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('unobserved uncertain create stays blocked and never repeats', async () => {
  const h = harness(); h.intercept = c => c.method === 'POST' ? 'fail-before' : undefined;
  await assert.rejects(h.publish()); h.intercept = null;
  await assert.rejects(h.publish(), { code: 'pending_operation' });
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
});
test('lost append response reconciles exact batch without duplicate append', async () => {
  const h = harness(); h.intercept = c => c.method === 'PATCH' && c.path.includes('/blocks/') ? 'fail-after' : undefined;
  await assert.rejects(h.publish()); assert.equal(h.state.phase, 'appending'); h.intercept = null;
  await h.publish(); assert.equal(h.calls.filter(c => c.method === 'PATCH' && c.path.includes('/blocks/')).length, 1);
});
test('unobserved uncertain append is not repeated or marked complete', async () => {
  const h = harness(); h.intercept = c => c.method === 'PATCH' && c.path.includes('/blocks/') ? 'fail-before' : undefined;
  await assert.rejects(h.publish()); h.intercept = null;
  await assert.rejects(h.publish(), { code: 'pending_operation' });
  assert.equal(h.calls.filter(c => c.method === 'PATCH' && c.path.includes('/blocks/')).length, 1);
  assert.match([...h.pages.values()][0].properties.title.title[0].text.content, / STAGING$/);
});
test('checkpoint conflict prevents create', async () => {
  const h = harness(); await assert.rejects(h.publish(envelope(), { checkpoint: async () => false }), { code: 'retry_later' });
  assert.equal(h.pages.size, 0);
});
test('authorization fence prevents mutation', async () => {
  const h = harness(); await assert.rejects(h.publish(envelope(), { authorize: async () => { throw new Error('disabled'); } }));
  assert.equal(h.pages.size, 0);
});
test('external content changes fail closed', async () => {
  const h = harness(); const { snapshotId } = await h.publish();
  h.pages.get(snapshotId).blocks[0].paragraph.rich_text[0].text.content = 'changed';
  await assert.rejects(h.publish(), { code: 'external_change' });
});
test('operation payload change cannot reuse persisted state', async () => {
  const h = harness(); await h.publish();
  await assert.rejects(h.publish(envelope(1, { secret: 'other' })), { code: 'operation_conflict' });
});
test('large Unicode is split safely and request batches stay bounded', async () => {
  const h = harness(); await h.publish(envelope(1, { habits: [{ name: '🐢'.repeat(120000), entries: [] }] }));
  assert.ok(h.calls.some(c => c.url.includes('start_cursor=')));
  for (const c of h.calls.filter(c => c.body?.children)) {
    assert.ok(c.body.children.length <= 50); assert.ok(Buffer.byteLength(JSON.stringify(c.body)) < 450000);
    for (const b of c.body.children) assert.ok(b[b.type].rich_text[0].text.content.length <= 1800);
  }
});
test('retains latest three, never archives higher revisions during old invocation', async () => {
  const h = harness();
  for (let revision = 1; revision <= 5; revision++) { h.reset(); await h.publish(envelope(revision)); }
  assert.equal([...h.pages.values()].filter(p => !p.archived).length, 3);
  h.reset(); await h.publish(envelope(2));
  const active = [...h.pages.values()].filter(p => !p.archived).map(p => p.properties.title.title[0].text.content);
  assert.ok(active.some(t => t.includes(' r5 ')));
});
test('oversized snapshots fail before any network writes', async () => {
  const h = harness(); await assert.rejects(h.publish(envelope(1, { statistics: 'x'.repeat(1100000) })), { code: 'invalid_payload' });
  assert.equal(h.calls.length, 0);
});
test('concurrent same-operation invocations never duplicate create or append', async () => {
  const h = harness(); const results = await Promise.allSettled([h.publish(), h.publish()]);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(h.calls.filter(c => c.method === 'PATCH' && c.path.includes('/blocks/')).length, 1);
});
for (const target of ['create', 'append']) test(`definite 429 during ${target} waits Retry-After then safely retries`, async () => {
  const h = harness();
  h.intercept = c => (target === 'create' ? c.method === 'POST' : c.method === 'PATCH' && c.path.includes('/blocks/'))
    ? new Response('{}', { status: 429, headers: { 'retry-after': '120' } }) : undefined;
  await assert.rejects(h.publish(), { code: 'provider_rate_limited' });
  h.intercept = null; const count = h.calls.length;
  await assert.rejects(h.publish(), { code: 'provider_rate_limited' });
  assert.equal(h.calls.length, count);
  h.elapse(120000); await h.publish();
  assert.equal(h.pages.size, 1);
});
test('recent history is readable while older history is explicitly aggregated', () => {
  const blocks = snapshotBlocks(envelope(1, { habits: [{ name: 'Walk', target: 1, unit: 'check', entries: [
    { date: '2025-01-01', value: 4, completed: true }, { date: '2026-10-17', value: 2, completed: true },
  ] }] }));
  const content = blocks.map(b => b[b.type].rich_text[0].text.content).join('\n');
  assert.match(content, /全記録 2件 \/ 30日より前 1件/);
  assert.match(content, /全期間累計 6回/);
  assert.match(content, /2026-10-17: 2回 完了/);
  assert.doesNotMatch(content, /2025-01-01/);
});
test('retention refuses to archive an edited generated page', async () => {
  const h = harness();
  for (let revision = 1; revision <= 3; revision++) { h.reset(); await h.publish(envelope(revision)); }
  const first = [...h.pages.values()][0];
  first.blocks[1].heading_1.rich_text[0].text.content = 'user-added important content';
  h.reset(); await assert.rejects(h.publish(envelope(4)), { code: 'external_change' });
  assert.equal(first.archived, false);
});
test('disconnect during request pacing is fenced immediately before mutation', async () => {
  let disabled = false; const calls = [];
  const notion = createNotion(config, async (url, options) => {
    calls.push(options.method);
    return new Response(JSON.stringify({ results: [], has_more: false }));
  }, { now: () => 1000, sleep: async () => { disabled = true; }, paceMs: 350 });
  await assert.rejects(notion.publish(envelope(), { state: null, checkpoint: async () => true,
    authorize: async () => { if (disabled) throw new Error('disabled'); } }), /disabled/);
  assert.deepEqual(calls, ['GET']);
});
for (const target of ['parent-read', 'page-read', 'block-read', 'archive', 'complete']) test(`durable cooldown covers ${target} 429`, async () => {
  const h = harness();
  if (target === 'archive') for (let r = 1; r <= 3; r++) { h.reset(); await h.publish(envelope(r)); }
  h.reset(); const data = envelope(target === 'archive' ? 4 : 1);
  h.intercept = c => {
    const matches = target === 'parent-read' ? c.method === 'GET' && c.path === `/blocks/${parent}/children`
      : target === 'page-read' ? c.method === 'GET' && c.path.startsWith('/pages/')
      : target === 'block-read' ? c.method === 'GET' && c.path.includes('/blocks/') && !c.path.includes(parent)
      : target === 'archive' ? c.method === 'PATCH' && c.body?.archived
      : c.method === 'PATCH' && c.body?.properties;
    return matches ? new Response('{}', { status: 429, headers: { 'retry-after': '120' } }) : undefined;
  };
  await assert.rejects(h.publish(data), { code: 'provider_rate_limited' });
  h.intercept = null; const count = h.calls.length;
  await assert.rejects(h.publish(data), { code: 'provider_rate_limited' });
  assert.equal(h.calls.length, count);
  h.elapse(120000); await h.publish(data);
});
