import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../js/habit-core.mjs';
import * as T from '../js/todo-core.mjs';

const TODAY = '2026-10-18';
const empty = () => T.normalizeTodo(null, TODAY);

test('normalize: broken or old data becomes a safe empty state', () => {
  assert.deepEqual(empty(), { routines: [], rlog: {}, tasks: [] });
  const s = T.normalizeTodo({ routines: [{ name: '  歯みがき ', slot: 'zzz' }], rlog: { bad: { a: 1 }, '2026-10-18': { a: 0, b: 1 } },
    tasks: [{ name: '', due: 'tomorrow', steps: [{ name: '図1', doneOn: '2026-10-17' }, null] }] }, TODAY);
  assert.equal(s.routines[0].name, '歯みがき');
  assert.equal(s.routines[0].slot, 'any');
  assert.equal(s.routines[0].createdOn, TODAY);
  assert.deepEqual(s.rlog, { '2026-10-18': { b: 1 } });
  assert.equal(s.tasks[0].name, 'タスク');
  assert.equal(s.tasks[0].due, null);
  assert.equal(s.tasks[0].steps.length, 2);
  assert.equal(s.tasks[0].steps[0].doneOn, '2026-10-17');
});

test('routines: toggle per day, shown from creation until archived, gold capped', () => {
  let s = empty();
  for (let i = 0; i < 7; i++) s = T.saveRoutine(s, { id: 'r' + i, name: '日課' + i, createdOn: '2026-10-10' }, TODAY);
  assert.equal(T.routinesOn(s, '2026-10-09').length, 0);
  s = T.toggleRoutine(s, TODAY, 'r0');
  assert.ok(T.isRoutineDone(s, TODAY, 'r0'));
  assert.deepEqual(T.dayGoldItems(s, TODAY), { 'todo:routines': { g: 2, n: 1 } });
  for (let i = 1; i < 7; i++) s = T.toggleRoutine(s, TODAY, 'r' + i);
  assert.equal(T.dayGoldItems(s, TODAY)['todo:routines'].g, T.GOLD_T.routineCap, 'routine gold is capped per day');
  assert.deepEqual(T.routineCount(s, TODAY), { done: 7, total: 7 });
  s = T.toggleRoutine(s, TODAY, 'r0');
  assert.equal(T.isRoutineDone(s, TODAY, 'r0'), false);
  // 消すと明日から出ない。過去の記録は残る
  s = T.archiveRoutine(s, 'r1', TODAY);
  assert.ok(T.routinesOn(s, TODAY).some(r => r.id === 'r1'));
  assert.ok(!T.routinesOn(s, H.addDays(TODAY, 1)).some(r => r.id === 'r1'));
  assert.ok(T.isRoutineDone(s, TODAY, 'r1'));
  // 今日まだやっていない日課は今日から消える
  s = T.archiveRoutine(s, 'r0', TODAY);
  assert.ok(!T.routinesOn(s, TODAY).some(r => r.id === 'r0'));
  assert.ok(T.routinesOn(s, H.addDays(TODAY, -1)).some(r => r.id === 'r0'));
  // 今日作って一度も使っていない日課は丸ごと消える
  s = T.saveRoutine(s, { id: 'new', name: 'new' }, TODAY);
  s = T.archiveRoutine(s, 'new', TODAY);
  assert.ok(!s.routines.some(r => r.id === 'new'));
});

test('tasks: steps, completion, ordering by due date and due labels', () => {
  let s = empty();
  s = T.saveTask(s, { id: 'a', name: '論文たたき台', due: '2026-10-25' }, TODAY);
  s = T.saveTask(s, { id: 'b', name: '確定申告', due: '2026-10-15' }, TODAY);
  s = T.saveTask(s, { id: 'c', name: '本棚', due: null }, TODAY);
  assert.deepEqual(T.openTasks(s).map(t => t.id), ['b', 'a', 'c']);
  assert.deepEqual(T.dueInfo(s.tasks[0], TODAY), { days: 7, label: 'あと7日', level: 'ok' });
  assert.equal(T.dueInfo(s.tasks[1], TODAY).label, '3日過ぎ');
  assert.equal(T.dueInfo({ due: TODAY }, TODAY).label, '今日まで');
  assert.equal(T.dueInfo(s.tasks[2], TODAY), null);
  s = T.addStep(s, 'a', '図1を作る');
  s = T.addStep(s, 'a', '  ');
  s = T.addStep(s, 'a', '考察を書く');
  assert.equal(s.tasks[0].steps.length, 2);
  const [s1, s2] = s.tasks[0].steps;
  s = T.moveStep(s, 'a', s2.id, -1);
  assert.equal(s.tasks[0].steps[0].id, s2.id);
  s = T.toggleStep(s, 'a', s1.id, '2026-10-17');
  assert.deepEqual(T.taskProgress(s.tasks[0]), { done: 1, total: 2 });
  assert.deepEqual(T.dayGoldItems(s, '2026-10-17'), { 'todo:a': { g: T.GOLD_T.step } });
  s = T.setTaskDone(s, 'a', TODAY);
  assert.deepEqual(T.dayGoldItems(s, TODAY), { 'todo:a': { g: T.GOLD_T.task } });
  assert.deepEqual(T.openTasks(s).map(t => t.id), ['b', 'c']);
  assert.deepEqual(T.doneTasks(s).map(t => t.id), ['a']);
  s = T.setTaskDone(s, 'a', null);
  assert.deepEqual(T.dayGoldItems(s, TODAY), {});
  s = T.deleteStep(s, 'a', s1.id);
  assert.deepEqual(T.dayGoldItems(s, '2026-10-17'), {});
  s = T.deleteTask(s, 'b');
  assert.deepEqual(s.tasks.map(t => t.id), ['a', 'c']);
});

test('settle: todo gold is recalculated like habit gold and settles after 7 days', () => {
  let s = empty();
  s = T.saveRoutine(s, { id: 'r', name: '薬', createdOn: '2026-10-01' }, TODAY);
  s = T.toggleRoutine(s, TODAY, 'r');
  s = T.saveTask(s, { id: 't', name: 'x', steps: [{ id: 's', name: 'y', doneOn: '2026-10-05' }] }, TODAY);
  const ctx = { log: {}, records: {}, freezes: {}, floorKey: null, today: TODAY, extraGold: k => T.dayGoldItems(s, k) };
  const r0 = H.normalizeReward({ startedOn: '2026-10-01', grants: [] }, TODAY);
  const r1 = H.settle(r0, [], ctx, TODAY);
  assert.equal(H.goldOn(r1, TODAY), 2);
  assert.equal(r1.bank, T.GOLD_T.step, 'a step done 13 days ago is already settled into the bank');
  assert.equal(H.balance(r1), 2 + T.GOLD_T.step);
  // 今日の日課を外すとゴールドも戻る
  s = T.toggleRoutine(s, TODAY, 'r');
  const r2 = H.settle(r1, [], { ...ctx, extraGold: k => T.dayGoldItems(s, k) }, TODAY);
  assert.equal(H.balance(r2), T.GOLD_T.step);
  assert.deepEqual(H.medals(r2), []);
});
