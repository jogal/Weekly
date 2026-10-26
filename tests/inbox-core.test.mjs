import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../js/inbox-core.mjs';
import * as T from '../js/todo-core.mjs';

const TODAY = '2026-10-26';
const st = (seen = {}) => I.normalize({ url: 'https://script.google.com/macros/s/x/exec', key: 'k', seen });

test('connection code: Apps Script URL and passphrase only', () => {
  assert.deepEqual(I.parseConnection(' https://script.google.com/macros/s/AKf/exec | abcdefgh12 '),
    { url: 'https://script.google.com/macros/s/AKf/exec', key: 'abcdefgh12' });
  assert.equal(I.parseConnection('https://example.com/exec|abcdefgh12'), null);
  assert.equal(I.parseConnection('https://script.google.com/macros/s/AKf/exec|short'), null);
  assert.equal(I.parseConnection(''), null);
});

test('english: score line, clamps, date window', () => {
  const e = I.englishEntry({ title: 'TOEIC Part5', date: '2026-10-25', minutes: 25.4, questions: 20, correct: 18, note: '前置詞' }, TODAY);
  assert.deepEqual(e, { date: '2026-10-25', minutes: 25, line: '🤖 TOEIC Part5 20問中18問正解（90%） 前置詞' });
  assert.equal(I.englishEntry({ date: '2026-11-03', minutes: 10 }, TODAY).date, TODAY, 'future → today');
  assert.equal(I.englishEntry({ minutes: 10 }, TODAY).date, TODAY, 'no date → today');
  assert.equal(I.englishEntry({ date: '2026-09-26', minutes: 10 }, TODAY).date, '2026-09-26');
  assert.equal(I.englishEntry({ date: '2026-09-25', minutes: 10 }, TODAY), null, 'older than 30 days');
  assert.equal(I.englishEntry({ title: 'x' }, TODAY), null, 'no minutes and no questions');
  assert.equal(I.englishEntry({ questions: 5, correct: 9 }, TODAY).line, '🤖 5問中5問正解（100%）', 'correct ≤ questions');
  assert.equal(I.englishEntry({ minutes: 9999 }, TODAY).minutes, 600);
});

test('english: minutes add up, hand-written note kept', () => {
  let r = I.mergeEnglish(undefined, { minutes: 20, line: '🤖 A' });
  assert.deepEqual(r, { done: true, note: '🤖 A', duration: '20', rating: 0 });
  r = I.mergeEnglish({ done: true, note: '音読', duration: '15', rating: 2 }, { minutes: 20, line: '🤖 B' });
  assert.deepEqual(r, { done: true, note: '音読 / 🤖 B', duration: '35', rating: 2 });
  assert.equal(I.mergeEnglish({ duration: '' }, { minutes: 0, line: '🤖 C' }).duration, '');
});

test('task: name, due, steps, reward clamp; fits todo-core', () => {
  const t = I.taskFrom({ title: '学会スライド', date: '2026-11-20', steps: '- 構成を決める\n2. 図を作る\n\n・発表練習', gold: 999 }, TODAY);
  assert.deepEqual(t.steps.map(s => s.name), ['構成を決める', '図を作る', '発表練習']);
  assert.equal(t.reward, I.TASK_GOLD_MAX);
  assert.equal(t.due, '2026-11-20');
  const todo = T.saveTask(T.normalizeTodo(null, TODAY), t, TODAY);
  assert.equal(todo.tasks[0].name, '学会スライド');
  assert.equal(todo.tasks[0].reward, 200);
  assert.equal(todo.tasks[0].doneOn, null);
  assert.equal(T.normalizeTask(I.taskFrom({ title: 'x' }, TODAY), TODAY).reward, T.GOLD_T.task, 'empty gold → default');
  assert.equal(I.taskFrom({ title: 'x', gold: -5 }, TODAY).reward, 0);
  assert.equal(I.taskFrom({ title: '  ' }, TODAY), null);
});

test('plan: sorts rows, skips unreadable, re-acks seen rows', () => {
  const items = [
    { id: 'a', kind: '英語', minutes: 10 },
    { id: 'b', kind: 'タスク', title: '書類' },
    { id: 'c', kind: '', title: '?' },
    { id: 'd', kind: '英語', title: 'no numbers' },
    { id: 'e', kind: '英語', minutes: 30 },
    { kind: '英語', minutes: 5 },
  ];
  const p = I.plan(items, st({ e: '2026-10-25' }), TODAY);
  assert.deepEqual(p.english.map(x => x.id), ['a']);
  assert.deepEqual(p.tasks.map(x => x.id), ['b']);
  assert.deepEqual(p.ack, ['a', 'b', 'e']);
  assert.deepEqual(p.skipped, ['c', 'd']);
  assert.deepEqual(I.plan(null, st(), TODAY), { english: [], tasks: [], ack: [], skipped: [] });
});

test('remember: keeps first import day, bounded', () => {
  let s = I.remember(st({ a: '2026-10-01' }), ['a', 'b'], TODAY);
  assert.deepEqual(s.seen, { a: '2026-10-01', b: TODAY });
  const many = {}; for (let i = 0; i < 600; i++) many['x' + i] = '2026-01-01';
  s = I.remember(st(many), ['new'], TODAY);
  assert.equal(Object.keys(s.seen).length, 500);
  assert.equal(s.seen.new, TODAY);
  assert.deepEqual(I.normalize({ seen: { a: 'bad', b: '2026-10-01' } }).seen, { b: '2026-10-01' });
});
