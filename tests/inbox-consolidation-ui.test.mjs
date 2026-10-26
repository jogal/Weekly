// DOM/storage/network harness for inbox-ui; no real account data or browser required.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as I from '../js/inbox-core.mjs';
import * as T from '../js/todo-core.mjs';
import * as C from '../js/task-consolidation.mjs';

import { TODAY, TARGET_NAME, SOURCES, command as makeCommand } from './fixtures/consolidation.mjs';
const code = (await readFile(new URL('../js/inbox-ui.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace('export async function syncInbox', 'async function syncInbox')
  + '\nglobalThis.syncInbox = syncInbox;';
const command = makeCommand();
function fixture() {
  return T.normalizeTodo({ tasks: [
    { id: 'poster', name: 'Unrelated poster task', steps: [{ id: 'poster-step', name: '構成', doneOn: TODAY }] },
    ...SOURCES.map(source => ({ id: `original-${source.name.replace(/ /g, "_")}`, name: source.name, createdOn: TODAY, steps: source.steps.map((name, i) => ({ id: `${source.name.replace(/ /g, "_")}-${i}`, name })) })),
  ] }, TODAY);
}
async function harness(todo = fixture()) {
  const values = new Map([[T.KEY, JSON.stringify(todo)], ['wt_reading_v1', '{"books":[]}']]);
  const elements = new Map(), acked = [], toasts = [], events = [], writes = [];
  const control = { rows: [command], failKey: null, failCountdown: 0, editing: false, soleClient: true, workerVersion: 1, renders: 0 };
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      if (key === control.failKey && --control.failCountdown === 0) throw new Error('simulated quota/crash');
      writes.push(key); values.set(key, value);
    },
  };
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, { id, style: { display: 'none' }, textContent: '', value: '', addEventListener() {} });
    return elements.get(id);
  };
  const document = {
    getElementById, activeElement: null, hidden: false, addEventListener() {}, querySelector: () => null,
    querySelectorAll: () => control.editing ? [{ id: 'hb-sheet', style: { display: 'flex' } }] : [],
  };
  const context = {
    setTimeout, clearTimeout,
    MessageChannel: class {
      constructor() { this.port1 = { close() {} }; this.port2 = { target: this.port1 }; }
    },
    navigator: { serviceWorker: { controller: { postMessage(message, ports) {
      queueMicrotask(() => ports[0].target.onmessage({ data: { type: message.type, version: control.workerVersion, soleClient: control.soleClient } }));
    } } } },
    I, T, C, keyOfDate: () => TODAY, localStorage: storage, document,
    window: { dispatchEvent(e) { events.push(e); }, addEventListener() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    getComputedStyle: el => el.style, URLSearchParams, Date, console,
    records: {}, DAY_KEYS: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    getWeekKey: () => TODAY, snapshotLevels: () => ({}), xpForRecord: () => 0,
    persist() { storage.setItem('wt_records', JSON.stringify(context.records)); },
    render() { control.renders++; }, showToast: msg => toasts.push(msg), checkLevelUp() {},
    async fetch(url) {
      const query = new URL(url).searchParams;
      if (query.has('ack')) acked.push(...query.get('ack').split(','));
      return { ok: true, async json() { return query.has('ack') ? { acked: 1 } : { items: control.rows }; } };
    },
  };
  vm.runInNewContext(code, context);
  await Promise.resolve(); // startup without connection is a no-op
  values.set(I.KEY, JSON.stringify({ url: 'https://script.google.com/macros/s/mock/exec', key: 'mock-passphrase', seen: {} }));
  return { context, control, storage, values, acked, writes, events, toasts, elements, sync: () => context.syncInbox(true) };
}

test('inbox integration applies one 16-step task, ACKs after commit, renders and preserves other stores', async () => {
  const h = await harness(), before = JSON.parse(h.storage.getItem(T.KEY));
  const result = await h.sync();
  assert.equal(result.consolidated, 1);
  const todo = JSON.parse(h.storage.getItem(T.KEY));
  assert.equal(todo.tasks.length, 2);
  assert.equal(todo.tasks[1].steps.length, 16);
  assert.deepEqual(todo.tasks[0], before.tasks[0]);
  assert.equal(h.storage.getItem('wt_reading_v1'), '{"books":[]}');
  assert.deepEqual(h.acked, [command.id]);
  assert.ok(h.events.some(e => e.detail.key === T.KEY));
  await h.sync();
  assert.equal(h.writes.filter(k => k === T.KEY).length, 1);
});

test('open editor defers the merge, then succeeds after dismissal', async () => {
  const h = await harness(), original = h.storage.getItem(T.KEY);
  h.control.editing = true;
  const result = await h.sync();
  assert.equal(result.consolidated, 0);
  assert.match(result.blocked[0], /編集中/);
  assert.equal(h.storage.getItem(T.KEY), original);
  assert.deepEqual(h.acked, []);
  assert.equal(JSON.parse(h.storage.getItem(I.KEY)).seen[command.id], undefined);
  h.control.editing = false;
  assert.equal((await h.sync()).consolidated, 1);
});

test('missing/modified sources remain pending, mixed English records exactly once across retry', async () => {
  const todo = fixture(); todo.tasks[1].steps[0].doneOn = TODAY;
  const h = await harness(todo), original = h.storage.getItem(T.KEY);
  h.control.rows = [{ id: 'english', kind: '英語', title: 'study', minutes: 15, date: TODAY }, command];
  const result = await h.sync();
  assert.equal(result.english, 1);
  assert.equal(result.consolidated, 0);
  assert.equal(result.blocked.length, 1);
  assert.equal(h.storage.getItem(T.KEY), original);
  assert.deepEqual(h.acked, ['english']);
  await h.sync();
  assert.equal(h.context.records[TODAY].mon.english.duration, '15');
  assert.equal(JSON.parse(h.storage.getItem(I.KEY)).seen[command.id], undefined);
});

test('quota failure does not ACK; receipt survives failure between todo write and seen write', async () => {
  const h = await harness(), original = h.storage.getItem(T.KEY);
  h.control.failKey = T.KEY; h.control.failCountdown = 1;
  const failed = await h.sync();
  assert.equal(failed.consolidated, 0);
  assert.match(failed.blocked[0], /保存できません/);
  assert.equal(h.storage.getItem(T.KEY), original);
  assert.deepEqual(h.acked, []);
  h.control.failKey = I.KEY; h.control.failCountdown = 2; // ordinary seen succeeds, post-merge seen fails
  await assert.rejects(h.sync(), /simulated/);
  assert.equal(h.control.renders, 1, 'committed merge rendered before seen failure');
  assert.equal(JSON.parse(h.storage.getItem(T.KEY)).tasks.length, 2);
  assert.deepEqual(h.acked, []);
  h.control.failKey = null;
  const retried = await h.sync();
  assert.equal(retried.consolidated, 0);
  assert.equal(h.writes.filter(k => k === T.KEY).length, 1);
  assert.deepEqual(h.acked, [command.id]);
});

test('pruned seen cache and reissued command cannot resurrect removed sources or edited target', async () => {
  const h = await harness(); await h.sync();
  const todo = JSON.parse(h.storage.getItem(T.KEY));
  todo.tasks[1].name = 'my edited target'; todo.tasks[1].steps[0].doneOn = TODAY;
  h.values.set(T.KEY, JSON.stringify(todo));
  h.values.set(I.KEY, JSON.stringify({ url: 'https://script.google.com/mock/exec', key: 'mock', seen: {} }));
  h.control.rows = [...SOURCES.map(source => ({ id: source.inboxId, kind: 'タスク', title: source.name, steps: source.steps.join('\n') })), { ...command, id: '10000000-0000-4000-8000-000000000002' }];
  const result = await h.sync();
  assert.equal(result.tasks, 0);
  assert.equal(result.consolidated, 0);
  assert.deepEqual(JSON.parse(h.storage.getItem(T.KEY)), todo);
  assert.ok(h.acked.includes('10000000-0000-4000-8000-000000000002'));
  assert.ok(h.acked.includes(SOURCES[0].inboxId));
});

test('ordinary task replay after failed seen save never overwrites progress or creates another task', async () => {
  const h = await harness();
  h.control.rows = [{ id: 'ordinary', kind: 'タスク', title: 'task', steps: 'one\ntwo' }];
  h.control.failKey = I.KEY; h.control.failCountdown = 1;
  await assert.rejects(h.sync(), /simulated/);
  const todo = JSON.parse(h.storage.getItem(T.KEY)), task = todo.tasks.at(-1);
  task.name = 'edited'; task.steps[0].doneOn = TODAY;
  h.values.set(T.KEY, JSON.stringify(todo)); h.control.failKey = null;
  await h.sync();
  const after = JSON.parse(h.storage.getItem(T.KEY));
  assert.equal(after.tasks.length, todo.tasks.length);
  assert.deepEqual(after.tasks.at(-1), task);
});


test('mixed ordinary import preserves unknown source data so consolidation still fails closed', async () => {
  const todo = fixture(); todo.tasks[1].custom = 'user data'; todo.customRoot = { keep: true };
  const h = await harness(todo);
  h.control.rows = [{ id: 'new-task', kind: 'タスク', title: 'unrelated new task' }, command];
  const result = await h.sync();
  assert.equal(result.tasks, 1); assert.equal(result.consolidated, 0);
  const after = JSON.parse(h.storage.getItem(T.KEY));
  assert.equal(after.tasks[1].custom, 'user data');
  assert.deepEqual(after.customRoot, todo.customRoot);
  assert.equal(after.tasks.length, todo.tasks.length + 1);
  assert.deepEqual(h.acked, ['new-task']);
});

test('multiple windows, old or unavailable service worker all defer without any todo write', async () => {
  for (const configure of [h => { h.control.soleClient = false; }, h => { h.control.workerVersion = 0; }, h => { delete h.context.navigator.serviceWorker.controller; }]) {
    const h = await harness(), before = h.storage.getItem(T.KEY); configure(h);
    const result = await h.sync();
    assert.equal(result.consolidated, 0); assert.match(result.blocked[0], /最新版/);
    assert.equal(h.storage.getItem(T.KEY), before); assert.deepEqual(h.acked, []);
  }
});


test('split text transport reaches durable commit/ACK; partial text stays unread and unchanged', async () => {
  const original = command, at = Math.floor(original.note.length / 2);
  const h = await harness(), before = h.storage.getItem(T.KEY);
  h.control.rows = [{ ...original, note: original.note.slice(0, at), steps: '' }];
  const partial = await h.sync();
  assert.equal(partial.consolidated, 0); assert.equal(partial.skipped, 1);
  assert.equal(h.storage.getItem(T.KEY), before); assert.deepEqual(h.acked, []);
  h.control.rows = [{ ...original, note: original.note.slice(0, at), steps: original.note.slice(at) }];
  assert.equal((await h.sync()).consolidated, 1);
  assert.deepEqual(h.acked, [original.id]);
  assert.equal(JSON.parse(h.storage.getItem(T.KEY)).tasks[1].steps.length, 16);
});
