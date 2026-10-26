import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/task-consolidation.mjs';
import * as I from '../js/inbox-core.mjs';
import * as T from '../js/todo-core.mjs';

import { TODAY, OPERATION_ID, TARGET_ID, TARGET_NAME, SOURCES, command } from './fixtures/consolidation.mjs';
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const sources = SOURCES.map(source => T.normalizeTask({
    id: `legacy-no${source.name.replace(/ /g, "_")}`, name: source.name, createdOn: TODAY,
    steps: source.steps.map((name, i) => ({ id: `s${source.name.replace(/ /g, "_")}-${i}`, name })),
  }, TODAY));
  const poster = { ...T.normalizeTask({ id: 'poster', name: 'Unrelated poster task', steps: [{ id: 'p1', name: '構成', doneOn: TODAY }] }, TODAY), custom: 'keep raw' };
  return { routines: [{ id: 'routine', name: '日課', custom: 42 }], rlog: { [TODAY]: { routine: 1 } }, tasks: [poster, ...sources], customRoot: { unchanged: true } };
}
function storage(todo = fixture()) {
  const data = new Map([[T.KEY, JSON.stringify(todo)], ['wt_reading_v1', '{"keep":"books"}'], ['wt_records', '{"keep":"english"}'], ['wt_reward_v1', '{"keep":"gold"}']]);
  return { data, writes: [], getItem: k => data.get(k) ?? null, setItem(k, v) { this.writes.push(k); data.set(k, v); } };
}

test('only strict scoped manifest accepted, never arbitrary patch/delete', () => {
  assert.equal(C.isConsolidationCommand(command()), true);
  for (const change of [{ note: 'merge-all' }, { title: '' }, { steps: 'x' }, { date: TODAY }, { gold: 0 }, { kind: 'タスク' }, { id: '' }]) {
    assert.equal(C.planConsolidation(fixture(), { ...command(), ...change }, TODAY).status, 'blocked');
  }
});

test('one atomic write replaces only exact 16 sources, preserves raw data and complete recoverable backup', () => {
  const old = fixture(), s = storage(old), result = C.applyConsolidation(s, command(), TODAY);
  assert.equal(result.status, 'applied');
  assert.deepEqual(s.writes, [C.BACKUP_KEY, T.KEY]);
  const next = JSON.parse(s.getItem(T.KEY));
  assert.equal(next.tasks.length, 2);
  assert.deepEqual(next.tasks[0], old.tasks[0]);
  assert.deepEqual(next.routines, old.routines);
  assert.deepEqual(next.rlog, old.rlog);
  assert.deepEqual(next.customRoot, old.customRoot);
  const target = next.tasks[1], receipt = next.taskConsolidations[OPERATION_ID];
  assert.equal(target.name, TARGET_NAME);
  assert.equal(target.due, null);
  assert.equal(target.steps.length, 16);
  assert.deepEqual(target.steps.map(x => x.name), SOURCES.map(x => x.label));
  assert.deepEqual(receipt.sources.map(x => x.task), old.tasks.slice(1));
  assert.deepEqual(receipt.sources.map(x => x.index), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.deepEqual(receipt.targetInitial, target);
  assert.deepEqual(T.dayGoldItems(T.normalizeTodo(next, TODAY), TODAY), T.dayGoldItems(T.normalizeTodo(old, TODAY), TODAY));
  assert.equal(s.getItem('wt_reading_v1'), '{"keep":"books"}');
  assert.equal(s.getItem('wt_records'), '{"keep":"english"}');
  assert.equal(s.getItem('wt_reward_v1'), '{"keep":"gold"}');
});

test('missing/partial import, ambiguous, edited and progressed sources never mutate anything', () => {
  const mutations = [
    t => t.tasks.pop(),
    t => t.tasks.push({ ...clone(t.tasks[1]), id: 'duplicate-name' }),
    t => { t.tasks[1].createdOn = '2000-12-31'; },
    t => { t.tasks[1].name += ' edited'; },
    t => { t.tasks[1].doneOn = TODAY; },
    t => { t.tasks[1].steps[1].doneOn = TODAY; },
    t => { t.tasks[1].steps.reverse(); },
    t => { t.tasks[1].steps[0].name += ' edited'; },
    t => { t.tasks[1].steps.push({ id: 'extra', name: 'extra', doneOn: null }); },
    t => { t.tasks[1].steps[0].custom = true; },
    t => { t.tasks[1].steps[0].id = t.tasks[1].steps[1].id; },
    t => { t.tasks[1].reward = 60; },
    t => { t.tasks[1].due = '2001-12-01'; },
    t => { t.tasks[1].icon = '🏥'; },
    t => { t.tasks[1].custom = true; },
    t => { t.tasks[0].id = t.tasks[1].id; },
    t => { t.tasks[0].id = TARGET_ID; },
    t => { t.tasks[0].name = TARGET_NAME; },
    t => { t.taskConsolidations = { [OPERATION_ID]: {} }; },
  ];
  for (const mutate of mutations) {
    const todo = fixture(); mutate(todo);
    const s = storage(todo), before = s.getItem(T.KEY);
    assert.equal(C.applyConsolidation(s, command(), TODAY).status, 'blocked', mutate.toString());
    assert.equal(s.getItem(T.KEY), before);
    assert.deepEqual(s.writes, []);
  }
});

test('repeat, different command row and edited/deleted target remain no-ops after receipt', () => {
  const s = storage(); C.applyConsolidation(s, command(), TODAY);
  assert.equal(C.applyConsolidation(s, command(), TODAY).status, 'already-applied');
  let todo = JSON.parse(s.getItem(T.KEY));
  todo.tasks[1].name = 'user edited target'; todo.tasks[1].steps[0].doneOn = TODAY;
  s.data.set(T.KEY, JSON.stringify(todo));
  const edited = s.getItem(T.KEY);
  assert.equal(C.applyConsolidation(s, command('10000000-0000-4000-8000-000000000002'), TODAY).status, 'already-applied');
  assert.equal(s.getItem(T.KEY), edited);
  todo.tasks.pop(); s.data.set(T.KEY, JSON.stringify(todo));
  assert.equal(C.applyConsolidation(s, command(), TODAY).status, 'already-applied');
  assert.equal(JSON.parse(s.getItem(T.KEY)).tasks.length, 1);
  assert.deepEqual(s.writes, [C.BACKUP_KEY, T.KEY]);
});

test('quota failure leaves original tasks; crash after todo commit is retry safe without seen or ACK', () => {
  const s = storage(), before = s.getItem(T.KEY), set = s.setItem;
  s.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => C.applyConsolidation(s, command(), TODAY), /QuotaExceededError/);
  assert.equal(s.getItem(T.KEY), before);
  s.setItem = set; C.applyConsolidation(s, command(), TODAY);
  assert.equal(C.applyConsolidation(s, command(), TODAY).status, 'already-applied');
  assert.deepEqual(s.writes, [C.BACKUP_KEY, T.KEY]);
});

test('storage changed since read: defer without overwriting the newer data', () => {
  const s = storage(), before = s.getItem(T.KEY), latest = fixture(); latest.tasks[0].name = 'changed elsewhere';
  let reads = 0; const originalGet = s.getItem; s.getItem = key => key === T.KEY ? (++reads === 1 ? before : JSON.stringify(latest)) : originalGet(key);
  assert.equal(C.applyConsolidation(s, command(), TODAY).status, 'blocked');
  assert.deepEqual(s.writes, [C.BACKUP_KEY]);
});

test('receipt and backup survive normalize, ordinary edits, backup export/import shape and seen-cache expiry', () => {
  let todo = C.planConsolidation(fixture(), command(), TODAY).todo;
  const originalReceipt = clone(todo.taskConsolidations);
  todo = T.normalizeTodo(todo, TODAY);
  todo = T.saveRoutine(todo, { id: 'new', name: 'new routine' }, TODAY);
  todo = T.toggleStep(todo, TARGET_ID, todo.tasks[1].steps[0].id, TODAY);
  todo = T.saveTask(todo, { ...todo.tasks[1], name: 'edited' }, TODAY);
  const exported = JSON.stringify({ habitData: { [T.KEY]: todo } });
  todo = T.normalizeTodo(JSON.parse(exported).habitData[T.KEY], TODAY);
  assert.deepEqual(todo.taskConsolidations, originalReceipt);
  const rows = SOURCES.map(x => ({ id: x.inboxId, title: x.name, kind: 'タスク', steps: x.steps.join('\n') }));
  const p = I.plan(rows, I.normalize({}), TODAY, todo);
  assert.equal(p.tasks.length, 0);
  assert.deepEqual(p.ack, SOURCES.map(x => x.inboxId));
  assert.equal(C.planConsolidation(todo, command(), TODAY).status, 'already-applied');
});

test('inbox plans merge without premature ACK and deduplicates rows in same response', () => {
  const p = I.plan([command(), command(), { id: 'task', kind: 'タスク', title: 'new' }, { id: 'task', kind: 'タスク', title: 'new' }], I.normalize({}), TODAY);
  assert.equal(p.consolidations.length, 1);
  assert.deepEqual(p.ack, ['task']);
  assert.equal(p.tasks.length, 1);
  assert.equal(p.tasks[0].task.id, 'inbox_task');
});

test('16 and 30 inbox steps preserved; over limit stays pending instead of truncating', () => {
  for (const n of [16, 30]) {
    const steps = Array.from({ length: n }, (_, i) => `case ${i}`).join('\n');
    const task = I.taskFrom({ title: 'cases', steps }, TODAY);
    assert.equal(T.normalizeTask(task, TODAY).steps.length, n);
  }
  assert.equal(I.taskFrom({ title: 'cases', steps: Array.from({ length: 31 }, () => 'case').join('\n') }, TODAY), null);
});


test('stale editor cannot resurrect retired source; independent backup remains after old normalization', () => {
  const old = fixture(), s = storage(old); C.applyConsolidation(s, command(), TODAY);
  const merged = JSON.parse(s.getItem(T.KEY));
  assert.deepEqual(T.saveTask(merged, old.tasks[1], TODAY), merged);
  const backup = s.getItem(C.BACKUP_KEY);
  assert.deepEqual(JSON.parse(backup).operations[OPERATION_ID].todoBefore, old);
  // Simulate an old version stripping only the new top-level field.
  delete merged.taskConsolidations; s.data.set(T.KEY, JSON.stringify(merged));
  assert.equal(s.getItem(C.BACKUP_KEY), backup);
  assert.equal(C.applyConsolidation(s, command(), TODAY).status, 'blocked');
});

test('independent backup failure aborts; existing backup is immutable on retries', () => {
  const s = storage(), before = s.getItem(T.KEY);
  const set = s.setItem; s.setItem = (key, value) => { if (key === C.BACKUP_KEY) throw new Error('backup quota'); set.call(s, key, value); };
  assert.throws(() => C.applyConsolidation(s, command(), TODAY), /backup quota/);
  assert.equal(s.getItem(T.KEY), before);
  s.setItem = (key, value) => { if (key === T.KEY) throw new Error('todo quota'); set.call(s, key, value); };
  assert.throws(() => C.applyConsolidation(s, command(), TODAY), /todo quota/);
  const backup = s.getItem(C.BACKUP_KEY);
  s.setItem = set; C.applyConsolidation(s, command(), TODAY);
  assert.equal(s.getItem(C.BACKUP_KEY), backup);
});


test('new inbox task IDs remain valid for the existing private mirror protocol', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const p = I.plan([{ id, kind: 'タスク', title: 'synthetic task' }], I.normalize({}), TODAY);
  assert.match(p.tasks[0].task.id, /^[A-Za-z0-9_-]{1,100}$/);
  const bad = I.plan([{ id: 'bad:id', kind: 'タスク', title: 'bad' }], I.normalize({}), TODAY);
  assert.equal(bad.tasks.length, 0); assert.deepEqual(bad.ack, []);
});


test('private manifest schema rejects unknown keys, malformed/truncated values and wildcard scope', () => {
  const base = JSON.parse(command().note);
  const mutations = [
    x => { x.extra = true; }, x => { x.operation = 'delete'; }, x => { x.version = '1'; },
    x => { x.operationId = '__proto__'; }, x => { x.operationId = 'constructor'; },
    x => { x.operationId = 'x'.repeat(65); }, x => { x.sources = []; }, x => { x.sources = '*'; },
    x => { x.sources = [x.sources[0]]; }, x => { x.sources[0].extra = true; },
    x => { x.sources[0].inboxId = 'not-a-uuid'; }, x => { x.sources[0].name = '*'.repeat(41); },
    x => { x.sources[0].createdOn = '2001-02-30'; }, x => { x.sources[0].createdOn = 1; },
    x => { x.sources[0].steps = ['x'.repeat(41)]; }, x => { x.sources[0].steps = [null]; },
    x => { x.sources[0].steps = Array(31).fill('x'); }, x => { x.sources[0].label = ''; },
    x => { x.sources[1].inboxId = x.sources[0].inboxId; }, x => { x.sources[1].name = x.sources[0].name; },
    x => { x.sources[1].label = x.sources[0].label; }, x => { x.sources[0].name = TARGET_NAME; },
  ];
  for (const mutate of mutations) {
    const payload = clone(base); mutate(payload);
    assert.equal(C.commandManifest({ ...command(), note: JSON.stringify(payload) }), null, mutate.toString());
  }
  assert.equal(C.commandManifest({ ...command(), note: command().note.slice(0, -1) }), null);
  assert.equal(C.commandManifest({ ...command(), note: ' '.repeat(30001) }), null);
});

test('bounds allow exactly 2 through 30 explicitly named sources, never silently truncate', () => {
  for (const n of [2, 30]) {
    const sources = Array.from({ length: n }, (_, i) => ({ ...SOURCES[0], name: `Synthetic item ${i}`, label: `Synthetic part ${i}`,
      inboxId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` }));
    assert.equal(C.commandManifest(command(undefined, sources)).sources.length, n);
  }
  assert.equal(C.commandManifest(command(undefined, Array(31).fill(SOURCES[0]))), null);
});

test('conflicting operation content cannot overwrite receipt, and new operation cannot consume retired rows', () => {
  const s = storage(); C.applyConsolidation(s, command(), TODAY);
  const current = JSON.parse(s.getItem(T.KEY));
  const conflicting = command(); conflicting.title = 'Different target';
  assert.equal(C.planConsolidation(current, conflicting, TODAY).status, 'blocked');
  const resurrected = clone(current); resurrected.tasks.push(...fixture().tasks.slice(1));
  const next = command(undefined, SOURCES, 'synthetic-group-02'); next.title = 'Another target';
  assert.equal(C.planConsolidation(resurrected, next, TODAY).status, 'blocked');
});


test('operation IDs resembling inherited object methods are handled as own map keys', () => {
  for (const id of ['toString', 'toLocaleString', 'hasOwnProperty']) {
    const s = storage();
    assert.equal(C.applyConsolidation(s, command(undefined, SOURCES, id), TODAY).status, 'applied');
    assert.equal(C.applyConsolidation(s, command(undefined, SOURCES, id), TODAY).status, 'already-applied');
  }
});

test('new inbox task identity must agree with the private source row, not just title', () => {
  const todo = fixture(); todo.tasks[1].id = 'inbox_' + SOURCES[0].inboxId;
  assert.equal(C.planConsolidation(todo, command(), TODAY).status, 'applied');
  todo.tasks[1].id = 'inbox_' + SOURCES[1].inboxId;
  assert.equal(C.planConsolidation(todo, command(), TODAY).status, 'blocked');
});
