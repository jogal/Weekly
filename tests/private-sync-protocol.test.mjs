import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, validatePayload, validateLegacyPayload, validDate, MAX_ENTRIES, MAX_PAYLOAD_BYTES } from '../js/private-sync-protocol.mjs';
import { deriveStatistics, readingDailyTotals } from '../js/private-sync-stats.mjs';
import * as H from '../js/habit-core.mjs';
import * as T from '../js/todo-core.mjs';
import * as R from '../js/reading-core.mjs';

const OPTIONS = { asOf: '2026-10-18', timeZone: 'Asia/Tokyo' };
const habit = (id, extra = {}) => ({ id, name: id, link: null, goal: { type: 'check', target: 1 },
  freq: { type: 'daily', days: [], times: 1 }, createdOn: '2026-10-01', ...extra });
const fixture = () => ({
  wt_habits_v1: { habits: [
    habit('h_medicine', { name: '専門医勉強', link: 'medicine', goal: { type: 'minutes', target: 30 } }),
    habit('h_check', { name: '練習', goal: { type: 'count', target: 2 } }),
    habit('h_workout', { name: '運動', link: 'workout', goal: { type: 'check', target: 1 }, freq: { type: 'weekly', days: [], times: 4 } }),
    habit('h_reading', { name: '読書', link: 'reading', goal: { type: 'count', target: 10 } }),
    habit('h_archived', { name: 'ARCHIVED_SECRET', archived: true }),
    habit('h_deleted', { name: 'DELETED_SECRET', deletedOn: '2026-10-17' }),
  ] },
  wt_records: { '2026-10-12': { sat: { medicine: { done: false, duration: '60', note: 'ZERO_NOTE_SECRET' } }, sun: {
    medicine: { done: true, duration: '20', note: 'NOTE_SECRET', rating: 5 },
    workout_chest: { done: true, duration: '40', note: 'HEALTH_SECRET', weight: 72 },
    workout_back: { done: true, note: 'BODYWEIGHT_SECRET', sets: [30] },
    english: { done: true, note: 'UNUSED_SECRET' },
    pain: { done: true, note: 'PAIN_SECRET' },
  } } },
  wt_habit_log_v1: { '2026-10-16': { h_check: { n: 0, rest: true, note: 'REST_SECRET' } },
    '2026-10-18': { h_check: { n: 2, rest: false, note: 'CUSTOM_SECRET' }, h_archived: { n: 1 }, h_missing: { n: 999 } } },
  wt_reading_v1: { books: [{ id: 'b_1', title: '読む本', pages: 217, status: 'reading', finishedOn: null,
    author: 'AUTHOR_SECRET', review: 'REVIEW_SECRET', log: { '2026-10-17': { page: 52 }, '2026-10-18': { page: 63 } } },
    { id: 'b_archived', title: 'ARCHIVED_BOOK_SECRET', pages: 10, archived: true, status: 'done', finishedOn: '2026-10-18', log: { '2026-10-18': { page: 10 } } }] },
  wt_todo_v1: { tasks: [{ id: 't_1', name: '原稿を仕上げる', createdOn: '2026-10-01', due: '2026-10-26', doneOn: null,
    reward: 9000, description: 'DESCRIPTION_SECRET', steps: [{ id: 's_1', name: 'STEP_SECRET', doneOn: '2026-10-18' }, { id: 's_2', name: 'STEP2_SECRET', doneOn: null }] },
    { id: 't_deleted', name: 'DELETED_TASK_SECRET', deleted: true }],
    routines: [{ id: 'r_do', name: '日課', createdOn: '2026-10-15' }, { id: 'r_avoid', name: 'やめたいこと', createdOn: '2026-10-15', avoid: true },
      { id: 'r_archived', name: 'ARCHIVED_ROUTINE_SECRET', archivedOn: '2026-10-19' }],
    rlog: { '2026-10-17': { r_do: 1, r_avoid: 1, r_archived: 1 }, '2026-10-18': { r_do: true }, '2026-10-16': { r_do: false } } },
  gym_sessions: { data: 'GYM_SECRET' }, wt_reward_v1: { gold: 200, freezes: { '2026-10-17': ['h_check'] } },
  wt_token: 'TOKEN_SECRET', archivedData: 'ARCHIVE_SECRET',
});
const storage = (data = fixture(), reads = []) => ({ getItem(key) { reads.push(key); return Object.hasOwn(data, key) ? JSON.stringify(data[key]) : null; } });
const payload = () => buildPayload(storage(), OPTIONS);
const byId = (out, group, id) => out[group].find(x => x.id === id);
const recompute = p => { p.statistics = deriveStatistics(p); return p; };

test('v2 automatically includes every active category, retaining only explicit safe fields', () => {
  const data = fixture(), before = structuredClone(data), reads = [];
  const out = buildPayload(storage(data, reads), OPTIONS);
  assert.equal(out.schemaVersion, 2);
  assert.equal(out.asOf, OPTIONS.asOf); assert.equal(out.timeZone, OPTIONS.timeZone);
  assert.equal(out.habits.length, 4); assert.equal(out.routines.length, 2); assert.equal(out.tasks.length, 1); assert.equal(out.reading.length, 1);
  assert.deepEqual(byId(out, 'habits', 'h_medicine').entries, [
    { date: '2026-10-17', value: 0, completed: false, rest: false },
    { date: '2026-10-18', value: 20, completed: false, rest: false },
  ]);
  assert.deepEqual(byId(out, 'habits', 'h_check').entries, [
    { date: '2026-10-16', value: 0, completed: false, rest: true },
    { date: '2026-10-18', value: 2, completed: true, rest: false },
  ]);
  assert.equal(out.reading[0].currentPage, 63);
  assert.deepEqual(out.tasks[0], { id: 't_1', name: '原稿を仕上げる', createdOn: '2026-10-01', due: '2026-10-26', completedOn: null,
    completedSteps: 1, totalSteps: 2, stepEntries: [{ date: '2026-10-18', completedSteps: 1 }] });
  assert.doesNotMatch(JSON.stringify(out), /SECRET|workout_chest|workout_back|duration|rating|weight|sets|gold|freezes/);
  assert.deepEqual(data, before);
  assert.deepEqual(new Set(reads), new Set(['wt_habits_v1', 'wt_records', 'wt_habit_log_v1', 'wt_reading_v1', 'wt_todo_v1']));
});

test('future additions and renamed items are automatically projected; archived/deleted items and orphan history never return', () => {
  const data = fixture();
  const before = buildPayload(storage(data), OPTIONS);
  data.wt_habits_v1.habits.push(habit('h_new'));
  data.wt_todo_v1.tasks[0].name = '新しい名前';
  data.wt_todo_v1.routines.push({ id: 'r_new', name: '新しい日課', createdOn: '2026-10-18' });
  data.wt_reading_v1.books.push({ id: 'b_new', title: '次の本', pages: 0, status: 'want', log: {} });
  const after = buildPayload(storage(data), OPTIONS);
  assert.equal(after.habits.length, before.habits.length + 1);
  assert.equal(after.routines.length, before.routines.length + 1);
  assert.equal(after.reading.length, before.reading.length + 1);
  assert.equal(after.tasks[0].name, '新しい名前');
  assert.doesNotMatch(JSON.stringify(after), /h_archived|h_missing|h_deleted|b_archived|t_deleted|r_archived/);
});

test('workout progress is only an aggregate check/count; no gym key or detailed workout field is accessed', () => {
  const data = fixture(); data.wt_habits_v1.habits = [habit('h_workout', { link: 'workout', goal: { type: 'count', target: 2 } })];
  const reads = [], out = buildPayload(storage(data, reads), OPTIONS);
  assert.deepEqual(out.habits[0].entries, [{ date: '2026-10-18', value: 2, completed: true, rest: false }]);
  assert.ok(!reads.some(k => k.startsWith('gym_') || /reward|token|archive/i.test(k)));
  assert.doesNotMatch(JSON.stringify(out), /workout_chest|workout_back|HEALTH|BODYWEIGHT|weight|sets/);
});

test('do and avoid routines preserve occurrence semantics and explicit false records', () => {
  const out = payload(), avoid = byId(out, 'routines', 'r_avoid'), routine = byId(out, 'routines', 'r_do');
  assert.deepEqual(avoid.entries, [{ date: '2026-10-17', occurred: true, completed: false }]);
  assert.deepEqual(routine.entries, [{ date: '2026-10-16', occurred: false, completed: false },
    { date: '2026-10-17', occurred: true, completed: true }, { date: '2026-10-18', occurred: true, completed: true }]);
  const stats = byId(out.statistics, 'routines', 'r_avoid');
  assert.deepEqual(stats.achievement30, { achieved: 3, due: 4, rate: 0.75 });
  assert.equal(stats.currentStreak.count, 1);
  assert.equal(out.statistics.missingDayMeaning, 'unrecorded-except-avoidance');
  assert.equal(routine.entries.some(e => e.date === '2026-10-15'), false);
});

test('all active history is retained, including old, zero, rest-only and nonmonotonic reading rows', () => {
  const data = fixture();
  data.wt_habit_log_v1['2020-01-01'] = { h_check: { n: 0, rest: true } };
  data.wt_reading_v1.books[0].log['2021-01-01'] = { page: 70 };
  const out = buildPayload(storage(data), OPTIONS);
  assert.equal(byId(out, 'habits', 'h_check').entries[0].date, '2020-01-01');
  assert.equal(out.reading[0].entries[0].date, '2021-01-01');
  assert.equal(out.reading[0].currentPage, 70);
  assert.equal(out.statistics.reading.recent.pages, 0);
});

test('reading habit matches pagesOnDay: excludes record-only and archived books, but reading period statistics include active record-only logs', () => {
  const data = fixture();
  data.wt_reading_v1.books.push({ id: 'b_record', title: '既読本', pages: 100, status: 'done', finishedOn: '2026-10-18', recordOnly: true,
    log: { '2026-10-18': { page: 100 } } });
  const out = buildPayload(storage(data), OPTIONS);
  assert.deepEqual(byId(out, 'habits', 'h_reading').entries, [
    { date: '2026-10-17', value: 52, completed: true, rest: false },
    { date: '2026-10-18', value: 11, completed: true, rest: false },
  ]);
  assert.deepEqual(out.statistics.reading.recent, { pages: 163, readingDays: 2, finishedBooks: 1 });
});

test('record-based daily/weekday/weekly statistics agree with core helpers without shields', () => {
  const data = fixture();
  data.wt_habits_v1.habits.push(habit('h_weekdays', { freq: { type: 'days', days: [0, 2, 4], times: 1 } }));
  data.wt_habit_log_v1['2026-10-14'] = { h_weekdays: { n: 1 } };
  data.wt_habit_log_v1['2026-10-16'].h_weekdays = { n: 1 };
  const out = buildPayload(storage(data), OPTIONS);
  for (const h of out.habits) {
    const model = { id: h.id, link: null, goal: { type: h.unit, target: h.target }, freq: h.frequency, createdOn: h.startsOn };
    const ctx = { today: out.asOf, log: Object.fromEntries(h.entries.map(e => [e.date, { [h.id]: { n: e.value, rest: e.rest } }])) };
    const expectedRate = H.habitRate(model, '2026-09-19', out.asOf, out.asOf, ctx);
    const stats = byId(out.statistics, 'habits', h.id), current = H.currentStreak(model, out.asOf, ctx);
    assert.deepEqual(stats.achievement30, { achieved: expectedRate.ok, due: expectedRate.due, rate: expectedRate.rate });
    assert.deepEqual(stats.currentStreak, { count: current.n, unit: current.unit === 'w' ? 'weeks' : 'days' });
    assert.equal(stats.bestStreak365.count, H.bestStreak(model, '2025-10-19', out.asOf, ctx).n);
  }
  assert.equal(out.statistics.rewardShieldsIncluded, false);
  assert.equal(out.statistics.basis, 'recorded-progress');
});

test('routine and reading statistics agree with existing helpers for active records', () => {
  const data = fixture(), out = payload();
  const state = { routines: data.wt_todo_v1.routines.filter(r => !r.archivedOn), rlog: data.wt_todo_v1.rlog };
  for (const r of out.routines) {
    const stats = byId(out.statistics, 'routines', r.id), expected = T.routineRate(state, r.id, out.asOf, 30);
    assert.deepEqual(stats.achievement30, { achieved: expected.done, due: expected.total, rate: expected.done / expected.total });
    assert.equal(stats.currentStreak.count, T.routineStreak(state, r.id, out.asOf));
    assert.equal(stats.bestStreak1200.count, T.routineBestStreak(state, r.id, out.asOf));
  }
  const read = R.periodStats(data.wt_reading_v1.books.filter(b => !b.archived), '2026-09-19', out.asOf);
  assert.deepEqual(out.statistics.reading.recent, { pages: read.pages, readingDays: read.days, finishedBooks: read.finished.length });
});

test('task summary is derived from approved step counts, completion dates and deadlines', () => {
  const data = fixture();
  data.wt_todo_v1.tasks.push({ id: 't_overdue', name: '期限超過', due: '2026-10-17', doneOn: null, steps: [] },
    { id: 't_done', name: '完了', due: '2026-10-01', doneOn: '2026-10-17', steps: [{ doneOn: '2026-10-16' }, { doneOn: '2026-10-16' }] },
    { id: 't_today', name: '今日まで', due: '2026-10-18', steps: [] });
  const out = buildPayload(storage(data), OPTIONS);
  assert.deepEqual(byId(out, 'tasks', 't_done').stepEntries, [{ date: '2026-10-16', completedSteps: 2 }]);
  assert.deepEqual(out.statistics.tasks, { total: 4, open: 3, completed: 1, overdue: 1, dueToday: 1, completed30: 1, completedSteps: 3, totalSteps: 4 });
});

test('optional absent stores do not block legitimate task, habit, routine, or reading data', () => {
  const data = fixture();
  for (const only of [
    { wt_todo_v1: { tasks: data.wt_todo_v1.tasks.slice(0, 1) } },
    { wt_todo_v1: { routines: data.wt_todo_v1.routines.slice(0, 1) } },
    { wt_habits_v1: { habits: [habit('h_new')] } },
    { wt_reading_v1: { books: data.wt_reading_v1.books.slice(0, 1) } },
  ]) assert.equal(buildPayload(storage(only), OPTIONS).schemaVersion, 2);
});

test('uninitialized, corrupt and genuinely empty sources fail closed, with no synthesized defaults', () => {
  assert.throws(() => buildPayload(storage({}), OPTIONS), /SOURCE_UNINITIALIZED/);
  assert.throws(() => buildPayload(storage({ wt_records: fixture().wt_records }), OPTIONS), /SOURCE_UNINITIALIZED/);
  assert.throws(() => buildPayload(storage({ wt_todo_v1: { tasks: [], routines: [], rlog: {} } }), OPTIONS), /EMPTY_PAYLOAD/);
  assert.throws(() => buildPayload({ getItem() { return '{'; } }, OPTIONS), /SOURCE_INVALID/);
  assert.throws(() => buildPayload(storage({ wt_todo_v1: { tasks: 'bad' } }), OPTIONS), /SOURCE_INVALID/);
  const empty = payload(); empty.habits = []; empty.routines = []; empty.tasks = []; empty.reading = [];
  assert.throws(() => validatePayload(empty), /EMPTY_PAYLOAD/);
});

test('strict schema rejects unknown fields everywhere, including nested statistics/settings', () => {
  const changes = [
    p => p.refreshToken = 'fake', p => p.habits[0].note = 'fake', p => p.habits[0].entries[0].note = 'fake',
    p => p.habits[0].frequency.freeze = true, p => p.reading[0].review = 'fake', p => p.reading[0].entries[0].bodyweight = 80,
    p => p.tasks[0].steps = ['secret'], p => p.tasks[0].stepEntries[0].name = 'secret',
    p => p.routines[0].description = 'secret', p => p.routines[0].entries[0].health = true,
    p => p.statistics.extra = {}, p => p.statistics.tasks.gold = 100, p => p.statistics.habits[0].currentStreak.extra = true,
    p => p.statistics.recent.note = 'secret', p => delete p.habits[0].name,
  ];
  for (const change of changes) { const p = payload(); change(p); assert.throws(() => validatePayload(p), /INVALID_PAYLOAD/); }
});

test('server recomputes every statistic and rejects invented counts, dates, rates and streaks', () => {
  for (const change of [
    p => p.statistics.tasks.completed++, p => p.statistics.reading.recent.pages++,
    p => p.statistics.habits[0].recentValue++, p => p.statistics.habits[0].currentStreak.count++,
    p => p.statistics.routines[0].achievement30.rate = 1, p => p.statistics.recent.from = '2020-01-01',
    p => p.statistics.rewardShieldsIncluded = true, p => p.statistics.habits.reverse(),
  ]) { const p = payload(); change(p); assert.throws(() => validatePayload(p), /INVALID_PAYLOAD/); }
});

test('strict types, semantic consistency, identifiers, canonical dates, duplicates and bounds', () => {
  const changes = [
    p => p.schemaVersion = 1, p => p.habits[0].entries[0].completed = 1,
    p => p.habits[0].entries[0].value = Infinity, p => p.habits[0].entries[0].value = -1,
    p => p.habits[0].entries[0].value = 0.5, p => p.habits[0].name = 'a'.repeat(41),
    p => p.habits[0].target = 0, p => p.habits[0].id = '../../secret', p => p.tasks[0].name = 'hello\nworld',
    p => p.tasks[0].due = '2026-02-30', p => p.reading[0].currentPage = 62,
    p => p.reading[0].entries.reverse(), p => p.habits[0].entries.push(p.habits[0].entries[0]),
    p => p.tasks[0].completedSteps = 3, p => p.tasks[0].stepEntries[0].completedSteps = 2,
    p => p.habits.push(p.habits[0]), p => p.habits[0].frequency.days = [0],
    p => p.routines[0].entries[0].completed = !p.routines[0].entries[0].completed,
    p => p.timeZone = 'Not/A_Zone', p => p.asOf = '2026-02-29',
  ];
  for (const change of changes) { const p = payload(); change(p); assert.throws(() => validatePayload(p), /INVALID_PAYLOAD/); }
  assert.ok(validDate('2024-02-29')); assert.equal(validDate('2026-02-29'), false);
});

test('oversized records fail rather than truncating active history', () => {
  const d = fixture();
  d.wt_habits_v1.habits = [habit('h_check')]; d.wt_habit_log_v1 = {};
  for (let i = 0; i <= MAX_ENTRIES; i++) d.wt_habit_log_v1[H.addDays('2020-01-01', i)] = { h_check: { n: 1 } };
  assert.throws(() => buildPayload(storage(d), OPTIONS), /INVALID_PAYLOAD/);
  const p = payload();
  p.habits = Array.from({ length: 100 }, (_, i) => ({ ...p.habits[0], id: 'h_' + i, name: 'あ'.repeat(40),
    entries: Array.from({ length: 200 }, (_, n) => ({ date: H.addDays('2026-01-01', n), value: 1, completed: false, rest: false })) }));
  assert.throws(() => validatePayload(p), /PAYLOAD_TOO_LARGE/);
});

test('deterministic canonical order ignores source category, log, and source-property insertion order', () => {
  const first = fixture(), second = fixture();
  second.wt_habits_v1.habits.reverse(); second.wt_reading_v1.books.reverse(); second.wt_todo_v1.routines.reverse();
  second.wt_habit_log_v1 = Object.fromEntries(Object.entries(second.wt_habit_log_v1).reverse());
  assert.deepEqual(buildPayload(storage(first), OPTIONS), buildPayload(storage(second), OPTIONS));
  const p = payload(); p.habits.reverse(); p.routines.reverse();
  assert.deepEqual(validatePayload(p), payload());
});

test('explicit timezone converts instants correctly across a date boundary and DST', () => {
  assert.equal(buildPayload(storage(), { asOf: '2026-10-18T23:30:00Z', timeZone: 'Asia/Tokyo' }).asOf, '2026-10-19');
  assert.equal(buildPayload(storage(), { asOf: new Date('2026-03-08T07:30:00Z'), timeZone: 'America/New_York' }).asOf, '2026-03-08');
  assert.equal(buildPayload(storage(), { asOf: '2026-01-01T00:30:00Z', timeZone: 'America/Los_Angeles' }).asOf, '2025-12-31');
  assert.ok(validDate(buildPayload(storage()).asOf));
});

test('avoidance scans are bounded for old creation dates, and future dates are not counted as actual completion', () => {
  const data = { wt_todo_v1: { routines: [{ id: 'r_avoid', name: 'やめる', createdOn: '1900-01-01', avoid: true },
    { id: 'r_future', name: '未来', createdOn: '2027-01-01', avoid: true }], rlog: { '2027-01-01': { r_avoid: 1 } } } };
  const out = buildPayload(storage(data), OPTIONS), stats = byId(out.statistics, 'routines', 'r_avoid');
  assert.equal(stats.currentStreak.count, 1200); assert.equal(stats.bestStreak1200.count, 1200);
  assert.equal(stats.lastOccurredOn, null);
  assert.deepEqual(byId(out.statistics, 'routines', 'r_future').achievement30, { achieved: 0, due: 0, rate: null });
  assert.equal(out.statistics.streakWindows.days.maximumDays, 1200);
});

test('malformed relevant sources cannot silently erase history; old selection arguments are rejected', () => {
  const data = fixture(); data.wt_records['2026-10-13'] = data.wt_records['2026-10-12'];
  assert.throws(() => buildPayload(storage(data), OPTIONS), /SOURCE_INVALID/);
  const other = fixture(); other.wt_records['2026-10-12'].sun = [];
  assert.throws(() => buildPayload(storage(other), OPTIONS), /SOURCE_INVALID/);
  assert.throws(() => buildPayload(storage(), { habitIds: [], readingIds: [], taskIds: ['t_1'] }), /INVALID_PAYLOAD/);
});

test('legacy validator is inspection-only and the v2 validator never silently accepts v1', () => {
  const legacy = { schemaVersion: 1, habits: [], reading: [], tasks: [
    { id: 't_1', name: 'task', due: null, completedOn: null, completedSteps: 0, totalSteps: 0 },
  ] };
  assert.deepEqual(validateLegacyPayload(legacy), legacy);
  assert.throws(() => validatePayload(legacy), /INVALID_PAYLOAD/);
  legacy.tasks[0].note = 'private';
  assert.throws(() => validateLegacyPayload(legacy), /INVALID_PAYLOAD/);
  assert.throws(() => validateLegacyPayload(payload()), /INVALID_PAYLOAD/);
});


test('changing a custom numeric goal to check keeps historical actuals above one', () => {
  const data = { wt_habits_v1: { habits: [habit('h_custom')] }, wt_habit_log_v1: {
    '2026-10-17': { h_custom: { n: 5 } }, '2026-10-18': { h_custom: { n: 25 } },
  } };
  const out = buildPayload(storage(data), OPTIONS);
  assert.equal(out.habits[0].unit, 'check');
  assert.deepEqual(out.habits[0].entries.map(e => e.value), [5, 25]);
  assert.ok(out.habits[0].entries.every(e => e.completed));
  assert.equal(out.statistics.habits[0].recentValue, 30);
  assert.equal(out.statistics.habits[0].currentStreak.count, 2);
});


test('snapshot options reject impossible dates, ambiguous date strings and non-date values', () => {
  for (const asOf of ['2026-02-30', '2026-02-30T10:00:00Z', '10/18/2026', 'today', null, 0, {}, new Date(NaN)]) {
    assert.throws(() => buildPayload(storage(), { asOf, timeZone: 'UTC' }), /INVALID_PAYLOAD/);
  }
});


for (const days of [365, 1500]) test(`one-MiB v2 limit retains six habits × ${days} daily history records`, t => {
  const data = { wt_habits_v1: { habits: Array.from({ length: 6 }, (_, i) => habit('h_' + i, { createdOn: '2020-01-01' })) }, wt_habit_log_v1: {} };
  for (let i = 0; i < days; i++) data.wt_habit_log_v1[H.addDays(OPTIONS.asOf, i - days + 1)] = Object.fromEntries(data.wt_habits_v1.habits.map(h => [h.id, { n: 1, rest: false }]));
  const started = performance.now(), out = buildPayload(storage(data), OPTIONS), elapsed = performance.now() - started;
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  assert.equal(MAX_PAYLOAD_BYTES, 1024 * 1024);
  assert.ok(bytes > 128 * 1024 && bytes < MAX_PAYLOAD_BYTES);
  assert.ok(out.habits.every(h => h.entries.length === days));
  assert.equal(out.habits.reduce((n, h) => n + h.entries.length, 0), 6 * days);
  assert.equal(validatePayload(out).schemaVersion, 2);
  t.diagnostic(`${bytes} bytes; full build plus strict validation ${elapsed.toFixed(1)} ms`);
});

test('legacy v1 inspection preserves the original 128-KiB payload bound', () => {
  const legacy = { schemaVersion: 1, routines: [], habits: [], reading: [], tasks: [] };
  delete legacy.routines;
  legacy.habits = Array.from({ length: 6 }, (_, i) => ({ id: 'h_' + i, name: 'habit', unit: 'check',
    entries: Array.from({ length: 500 }, (_, day) => ({ date: H.addDays('2020-01-01', day), value: 1, completed: true })) }));
  const bytes = new TextEncoder().encode(JSON.stringify(legacy)).length;
  assert.ok(bytes > 128 * 1024 && bytes < MAX_PAYLOAD_BYTES);
  assert.throws(() => validateLegacyPayload(legacy), /PAYLOAD_TOO_LARGE/);
});

test('v2 payload cap is enforced before derived statistics are accessed', () => {
  const p = payload();
  p.habits[0].name = 'a'.repeat(MAX_PAYLOAD_BYTES);
  Object.defineProperty(p, 'statistics', { enumerable: false, get() { throw new Error('STATS_WERE_ACCESSED'); } });
  assert.throws(() => validatePayload(p), /PAYLOAD_TOO_LARGE/);
});


test('linear reading aggregation agrees with core helpers for page corrections, record-only and future entries', () => {
  const books = [
    { id: 'b_a', title: 'A', pages: 200, status: 'reading', finishedOn: null, log: {
      '2025-01-01': { page: 50 }, '2026-10-15': { page: 20 }, '2026-10-16': { page: 60 }, '2026-10-17': { page: 55 },
      '2026-10-18': { page: 90 }, '2027-01-01': { page: 100 },
    } },
    { id: 'b_b', title: 'B', pages: 200, status: 'done', recordOnly: true, finishedOn: '2026-10-17',
      log: { '2026-10-15': { page: 10 }, '2026-10-16': { page: 9 }, '2026-10-17': { page: 15 }, '2026-10-18': { page: 200 } } },
  ];
  const out = buildPayload(storage({ wt_reading_v1: { books }, wt_habits_v1: { habits: [habit('h_reading', { link: 'reading', goal: { type: 'count', target: 10 } })] } }), OPTIONS);
  const totals = readingDailyTotals(out.reading), linked = out.habits[0].entries;
  for (const [day, value] of totals) {
    assert.equal(value, books.reduce((sum, book) => sum + R.readOn(book, day), 0));
    const entry = linked.find(e => e.date === day);
    if (entry) assert.equal(entry.value, R.pagesOnDay(books, day));
  }
  for (const [key, window] of [['recent', out.statistics.recent], ['year', out.statistics.year]]) {
    const expected = R.periodStats(books, window.from, window.to);
    assert.deepEqual(out.statistics.reading[key], { pages: expected.pages, readingDays: expected.days, finishedBooks: expected.finished.length });
  }
});

test('six books × 1,500 records plus linked reading progress remain bounded and complete', t => {
  const books = Array.from({ length: 6 }, (_, b) => ({ id: 'b_' + b, title: 'Book ' + b, pages: 20000, status: 'reading', finishedOn: null,
    log: Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [H.addDays(OPTIONS.asOf, i - 1499), { page: i + 1 }])) }));
  const data = { wt_reading_v1: { books }, wt_habits_v1: { habits: [habit('h_reading', { createdOn: '2020-01-01', link: 'reading', goal: { type: 'count', target: 10 } })] } };
  const started = performance.now(), out = buildPayload(storage(data), OPTIONS), buildMs = performance.now() - started;
  const validateStarted = performance.now(); validatePayload(out); const validateMs = performance.now() - validateStarted;
  assert.ok(out.reading.every(book => book.entries.length === 1500));
  assert.equal(out.habits[0].entries.length, 1500);
  assert.ok(out.habits[0].entries.every(entry => entry.value === 6));
  assert.deepEqual(out.statistics.reading.recent, { pages: 180, readingDays: 30, finishedBooks: 0 });
  assert.deepEqual(out.statistics.reading.year, { pages: 2190, readingDays: 365, finishedBooks: 0 });
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  assert.ok(bytes < MAX_PAYLOAD_BYTES);
  t.diagnostic(`${bytes} bytes; build ${buildMs.toFixed(1)} ms; validation ${validateMs.toFixed(1)} ms`);
});
