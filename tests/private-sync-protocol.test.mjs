import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, validatePayload, listSelectableItems, validDate } from '../js/private-sync-protocol.mjs';

const fixture = () => ({
  wt_habits_v1: { habits: [
    { id: 'h_medicine', name: '専門医勉強', link: 'medicine', goal: { type: 'minutes', target: 30 } },
    { id: 'h_check', name: '練習', link: null, goal: { type: 'count', target: 2 } },
    { id: 'h_workout', name: '運動', link: 'workout', goal: { type: 'check', target: 1 } },
    { id: 'h_deleted', name: 'ARCHIVED_SECRET', archived: true, goal: { type: 'check', target: 1 } },
  ] },
  wt_records: { '2026-10-12': { sun: {
    medicine: { done: true, duration: '20', note: 'NOTE_SECRET', rating: 5 },
    workout_chest: { done: true, duration: '40', note: 'HEALTH_SECRET' },
    workout_back: { done: true, note: 'BODYWEIGHT_SECRET' },
    english: { done: true, note: 'UNSELECTED_SECRET' },
  } } },
  wt_habit_log_v1: { '2026-10-18': { h_check: { n: 2, rest: false, note: 'CUSTOM_SECRET' } } },
  wt_reading_v1: { books: [{ id: 'b_1', title: '読む本', pages: 217, status: 'reading', finishedOn: null,
    author: 'AUTHOR_SECRET', review: 'REVIEW_SECRET', log: { '2026-10-17': { page: 52 }, '2026-10-18': { page: 63 } } }] },
  wt_todo_v1: { tasks: [{ id: 't_1', name: '原稿を仕上げる', due: '2026-10-26', doneOn: null,
    steps: [{ id: 's_1', name: 'STEP_SECRET', doneOn: '2026-10-18' }, { id: 's_2', name: 'STEP2_SECRET', doneOn: null }] }],
    routines: [{ name: 'MEDICATION_SECRET' }], rlog: {} },
  gym_sessions: { data: 'GYM_SECRET' }, wt_token: 'TOKEN_SECRET', archivedData: 'ARCHIVE_SECRET',
});
const selection = () => ({ habitIds: ['h_medicine', 'h_check', 'h_workout'], readingIds: ['b_1'], taskIds: ['t_1'] });
const storage = (data = fixture(), reads = []) => ({ getItem(key) { reads.push(key); return Object.hasOwn(data, key) ? JSON.stringify(data[key]) : null; } });
const payload = () => buildPayload(storage(), selection());

test('projects selected local records into explicit safe fields, no source mutation', () => {
  const data = fixture(), before = structuredClone(data), reads = [];
  const out = buildPayload(storage(data, reads), selection());
  assert.deepEqual(out.habits[0].entries, [{ date: '2026-10-18', value: 20, completed: false }]);
  assert.deepEqual(out.habits[1].entries, [{ date: '2026-10-18', value: 2, completed: true }]);
  assert.deepEqual(out.habits[2].entries, [{ date: '2026-10-18', value: 1, completed: true }]);
  assert.equal(out.reading[0].currentPage, 63);
  assert.deepEqual(out.tasks[0], { id: 't_1', name: '原稿を仕上げる', due: '2026-10-26', completedOn: null, completedSteps: 1, totalSteps: 2 });
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
  assert.deepEqual(data, before);
  assert.equal(new Set(reads).size, 5);
  assert.ok(reads.every(k => ['wt_habits_v1', 'wt_records', 'wt_habit_log_v1', 'wt_reading_v1', 'wt_todo_v1'].includes(k)));
});

test('task-only selection does not even read habits, reading, gym or credentials', () => {
  const reads = [], out = buildPayload(storage(fixture(), reads), { habitIds: [], readingIds: [], taskIds: ['t_1'] });
  assert.deepEqual(reads, ['wt_todo_v1']);
  assert.equal(out.tasks.length, 1);
  assert.deepEqual(out.habits, []);
});

test('selection list has no implicit selected/default items and hides archived habits', () => {
  const items = listSelectableItems(storage());
  assert.deepEqual(items.habits.map(x => x.id), ['h_medicine', 'h_check', 'h_workout']);
  assert.equal(items.reading[0].name, '読む本');
  assert.doesNotMatch(JSON.stringify(items), /SECRET/);
  assert.deepEqual(listSelectableItems(storage({})), { habits: [], reading: [], tasks: [] });
});

test('rejects missing, corrupt, deleted, unknown and duplicate selections', () => {
  assert.throws(() => buildPayload(storage(), { habitIds: [], readingIds: [], taskIds: [] }), /EMPTY_SELECTION/);
  assert.throws(() => buildPayload(storage({}), selection()), /SOURCE_UNINITIALIZED/);
  assert.throws(() => buildPayload({ getItem() { return '{'; } }, selection()), /SOURCE_INVALID/);
  assert.throws(() => buildPayload(storage(), { habitIds: ['h_deleted'], readingIds: [], taskIds: [] }), /SELECTION_CHANGED/);
  assert.throws(() => buildPayload(storage(), { habitIds: ['missing'], readingIds: [], taskIds: [] }), /SELECTION_CHANGED/);
  assert.throws(() => buildPayload(storage(), { ...selection(), taskIds: ['t_1', 't_1'] }), /INVALID_PAYLOAD/);
  assert.throws(() => buildPayload(storage(), { ...selection(), all: true }), /INVALID_PAYLOAD/);
});

test('rejects implicit empty uploads rather than wiping the server feed', () => {
  assert.throws(() => validatePayload({ schemaVersion: 1, habits: [], reading: [], tasks: [] }), /EMPTY_PAYLOAD/);
  const data = fixture(); data.wt_records = {};
  assert.throws(() => buildPayload(storage(data), { habitIds: ['h_medicine'], readingIds: [], taskIds: [] }), /EMPTY_PAYLOAD/);
});

test('strict validator rejects unknown fields at every level including credentials and notes', () => {
  for (const mutate of [
    p => p.refreshToken = 'fake', p => p.habits[0].note = 'fake', p => p.habits[0].entries[0].note = 'fake',
    p => p.reading[0].review = 'fake', p => p.reading[0].entries[0].bodyweight = 80,
    p => p.tasks[0].steps = ['secret'], p => p.tasks[0].email = 'fake',
  ]) { const p = payload(); mutate(p); assert.throws(() => validatePayload(p), /INVALID_PAYLOAD/); }
  const p = payload(); delete p.habits[0].name;
  assert.throws(() => validatePayload(p), /INVALID_PAYLOAD/);
});

test('strict bounds, types, duplicate dates, identifiers, and real calendar dates', () => {
  const bad = [
    p => p.schemaVersion = 2, p => p.habits[0].entries[0].completed = 1,
    p => p.habits[0].entries[0].value = Infinity, p => p.habits[0].entries[0].value = -1,
    p => p.habits[0].entries[0].value = 0.5, p => p.habits[0].name = 'a'.repeat(41),
    p => p.habits[0].id = '../../secret', p => p.tasks[0].name = 'hello\nworld',
    p => p.tasks[0].due = '2026-02-30', p => p.reading[0].currentPage = 100000,
    p => p.reading[0].entries.reverse(), p => p.habits[0].entries.push(p.habits[0].entries[0]),
    p => p.tasks[0].completedSteps = 3, p => p.habits.push(p.habits[0]),
    p => p.habits[0].entries = Array(1501).fill(p.habits[0].entries[0]),
  ];
  for (const mutate of bad) { const p = payload(); mutate(p); assert.throws(() => validatePayload(p), /INVALID_PAYLOAD/); }
  assert.ok(validDate('2024-02-29')); assert.equal(validDate('2026-02-29'), false);
});

test('128 KiB bound applies to UTF-8 and aggregate payload, never silent truncation', () => {
  const p = payload();
  p.habits = Array.from({ length: 100 }, (_, i) => ({ id: 'h_' + i, name: 'あ'.repeat(40), unit: 'count', entries: Array.from({ length: 35 }, (_, n) => ({ date: new Date(Date.UTC(2026, 0, n + 1)).toISOString().slice(0, 10), value: 1, completed: true })) }));
  assert.throws(() => validatePayload(p), /PAYLOAD_TOO_LARGE/);
});

test('reading habit aggregates page progress but excludes book notes and names unless selected', () => {
  const d = fixture(); d.wt_habits_v1.habits.push({ id: 'h_reading', name: '読書', link: 'reading', goal: { type: 'count', target: 10 } });
  const out = buildPayload(storage(d), { habitIds: ['h_reading'], readingIds: [], taskIds: [] });
  assert.deepEqual(out.habits[0].entries, [{ date: '2026-10-17', value: 52, completed: true }, { date: '2026-10-18', value: 11, completed: true }]);
  assert.deepEqual(out.reading, []); assert.doesNotMatch(JSON.stringify(out), /読む本|SECRET/);
});

test('malformed week/date source cannot silently erase selected habit history', () => {
  const d = fixture(); d.wt_records['2026-10-13'] = d.wt_records['2026-10-12'];
  assert.throws(() => buildPayload(storage(d), selection()), /SOURCE_INVALID/);
  const other = fixture(); other.wt_records['2026-10-12'].sun = [];
  assert.throws(() => buildPayload(storage(other), selection()), /SOURCE_INVALID/);
});
