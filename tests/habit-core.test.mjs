import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../js/habit-core.mjs';

const TODAY = '2026-10-18';            // 日曜
const custom = (over = {}) => H.normalizeHabit({ id: 'h_x', name: 'ストレッチ', createdOn: '2026-01-01',
  goal: { type: 'check' }, freq: { type: 'daily' }, ...over });
const ctxOf = (log = {}, records = {}, freezes = {}) =>
  ({ log, records, freezes, floorKey: H.dataFloor(records, log), today: TODAY });
// days: 今日からさかのぼって何日前に達成したか(0=今日)
const logFor = (id, daysAgo, n = 1) => {
  const log = {};
  daysAgo.forEach(d => { log[H.addDays(TODAY, -d)] = { [id]: { n } }; });
  return log;
};
const rec = (key, cat, r) => {
  const out = {};
  const wk = H.mondayOf(key), dk = H.DAY_KEYS[H.weekdayIdx(key)];
  out[wk] = { [dk]: { [cat]: { done: true, note: '', duration: '', rating: 0, ...r } } };
  return out;
};

test('date keys: Monday-based weekdays, week start and month boundaries', () => {
  assert.equal(H.weekdayIdx('2026-10-12'), 0);
  assert.equal(H.weekdayIdx(TODAY), 6);
  assert.equal(H.mondayOf(TODAY), '2026-10-12');
  assert.equal(H.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(H.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(H.daysBetween('2026-10-01', TODAY), 17);
});

test('defaults link the five Weekly tracks; normalize clamps and repairs input', () => {
  const d = H.defaultHabits(TODAY);
  assert.deepEqual(d.map(h => h.link), ['workout', 'medicine', 'english', 'instrument', 'cooking']);
  assert.equal(d[0].freq.type, 'weekly'); assert.equal(d[0].freq.times, 4);
  assert.deepEqual(H.ensureHabits(null, TODAY).habits.length, 5);
  const n = H.normalizeHabit({ link: 'medicine', goal: { type: 'count', target: 5 }, freq: { type: 'days', days: [] } });
  assert.equal(n.goal.type, 'check');
  assert.equal(n.freq.type, 'daily');
  const m = H.normalizeHabit({ goal: { type: 'minutes', target: 5000 }, freq: { type: 'weekly', times: 9 } });
  assert.equal(m.goal.target, 999); assert.equal(m.freq.times, 7);
  assert.deepEqual(H.allowedGoalTypes('workout'), ['check', 'count']);
  assert.deepEqual(H.allowedGoalTypes('english'), ['check', 'minutes']);
});

test('linked progress reads wt_records: workout counts parts, minutes sum done durations', () => {
  const records = rec(TODAY, 'workout_chest', {});
  records['2026-10-12'].sun.workout_back = { done: true };
  records['2026-10-12'].sun.workout_leg = { done: false };
  records['2026-10-12'].sun.english = { done: true, duration: '25' };
  const ctx = ctxOf({}, records);
  const w = H.normalizeHabit({ link: 'workout', goal: { type: 'count', target: 2 } });
  assert.equal(H.progressOf(w, TODAY, ctx), 2);
  assert.ok(H.isAchieved(w, TODAY, ctx));
  const e = H.normalizeHabit({ link: 'english', goal: { type: 'minutes', target: 30 } });
  assert.equal(H.progressOf(e, TODAY, ctx), 25);
  assert.equal(H.isAchieved(e, TODAY, ctx), false);
  assert.equal(H.progressLabel(e, TODAY, ctx), '25/30分');
});

test('daily streak: rest and frozen days keep it, a missed due day breaks it', () => {
  const h = custom();
  assert.equal(H.dailyStreakAt(h, TODAY, ctxOf(logFor('h_x', [0, 1, 2, 3, 4]))), 5);
  assert.equal(H.dailyStreakAt(h, TODAY, ctxOf(logFor('h_x', [0, 1, 3, 4]))), 2);
  const rest = logFor('h_x', [0, 1, 3, 4]);
  rest[H.addDays(TODAY, -2)] = { h_x: { rest: true } };
  assert.equal(H.dailyStreakAt(h, TODAY, ctxOf(rest)), 4);
  const frozen = ctxOf(logFor('h_x', [0, 1, 3, 4]), {}, { [H.addDays(TODAY, -2)]: ['h_x'] });
  assert.equal(H.dailyStreakAt(h, TODAY, frozen), 4);
});

test('day-of-week habits skip non-due days; current streak waits for today', () => {
  const mwf = custom({ freq: { type: 'days', days: [0, 2, 4] } });   // 月水金
  // 10/12(月) 10/14(水) 10/16(金) 達成, 今日(日)は予定外
  const log = { '2026-10-12': { h_x: { n: 1 } }, '2026-10-14': { h_x: { n: 1 } }, '2026-10-16': { h_x: { n: 1 } } };
  assert.equal(H.dailyStreakAt(mwf, TODAY, ctxOf(log)), 3);
  assert.equal(H.freqLabel(mwf), '月・水・金');
  const daily = custom();
  const s = H.currentStreak(daily, TODAY, ctxOf(logFor('h_x', [1, 2, 3])));
  assert.deepEqual(s, { n: 3, unit: 'd' });
  assert.equal(H.streakLabel(s), '3日');
});

test('weekly N-times streak counts met weeks and the current week once met', () => {
  const h = custom({ freq: { type: 'weekly', times: 2 } });
  const log = logFor('h_x', [7, 9, 14, 16]);   // 先週2回, 先々週2回
  assert.equal(H.weeklyStreakAt(h, TODAY, ctxOf(log)), 2);
  log[TODAY] = { h_x: { n: 1 } }; log[H.addDays(TODAY, -1)] = { h_x: { n: 1 } };
  assert.equal(H.weeklyStreakAt(h, TODAY, ctxOf(log)), 3);
  assert.equal(H.progressLabel(h, TODAY, ctxOf(log)), '今週 2/2');
});

test('gold: base, streak bonus with cap, milestone, weekly goal and perfect day', () => {
  const h = custom();
  assert.equal(H.habitDayGold(h, TODAY, ctxOf(logFor('h_x', [0]))).g, 10);
  assert.equal(H.habitDayGold(h, TODAY, ctxOf(logFor('h_x', [0, 1, 2]))).g, 12);
  const seven = H.habitDayGold(h, TODAY, ctxOf(logFor('h_x', [0, 1, 2, 3, 4, 5, 6])));
  assert.deepEqual(seven, { g: 10 + 6 + 50, streak: 7, unit: 'd', ms: 7 });
  const long = H.habitDayGold(h, TODAY, ctxOf(logFor('h_x', Array.from({ length: 40 }, (_, i) => i))));
  assert.equal(long.g, 30);
  assert.equal(H.habitDayGold(h, TODAY, ctxOf({})), null);
  const w = custom({ freq: { type: 'weekly', times: 2 } });
  assert.equal(H.habitDayGold(w, '2026-10-17', ctxOf(logFor('h_x', [1]))).g, 10);
  const met = H.habitDayGold(w, TODAY, ctxOf(logFor('h_x', [0, 1])));
  assert.equal(met.g, 10 + 20); assert.equal(met.streak, 1);
  const a = custom(), b = custom({ id: 'h_y' });
  const both = { [TODAY]: { h_x: { n: 1 }, h_y: { n: 1 } } };
  assert.equal(H.perfectGold([a, b], TODAY, ctxOf(both)), 20);
  assert.equal(H.perfectGold([a, b], TODAY, ctxOf({ [TODAY]: { h_x: { n: 1 } } })), 0);
  const restB = { [TODAY]: { h_x: { n: 1 }, h_y: { rest: true } } };
  assert.equal(H.perfectGold([a, b], TODAY, ctxOf(restB)), 0, 'needs two due habits');
});

test('settle is idempotent, follows edits inside the window and freezes older days', () => {
  const h = custom();
  let r = H.newRewardState('2026-10-01');
  assert.equal(H.balance(r), 100);
  const log = logFor('h_x', [0, 1, 2]);
  r = H.settle(r, [h], ctxOf(log), TODAY);
  const once = H.balance(r);
  assert.equal(once, 100 + 10 + 11 + 12);
  assert.equal(H.balance(H.settle(r, [h], ctxOf(log), TODAY)), once);
  // 今日を取り消すとゴールドも戻る
  const undo = H.setLogValue(log, TODAY, 'h_x', 0);
  assert.equal(H.balance(H.settle(r, [h], ctxOf(undo), TODAY)), once - 12);
  // 8日以上前は確定済み: 後から記録しても変わらない
  assert.equal(r.settledThrough, '2026-10-11');
  const late = { ...log, '2026-10-05': { h_x: { n: 1 } } };
  assert.equal(H.balance(H.settle(r, [h], ctxOf(late), TODAY)), once);
  // 確定した日はbankへ畳み込まれ、未確定日だけが残る
  const r2 = H.settle(H.newRewardState('2026-10-01'), [h], ctxOf(logFor('h_x', [10, 9, 0])), TODAY);
  assert.equal(r2.bank, 10 + 11);
  assert.deepEqual(Object.keys(r2.days), [TODAY]);
});

test('settle across a long absence still credits every unsettled day once', () => {
  const h = custom();
  const r0 = H.settle(H.newRewardState('2026-09-01'), [h], ctxOf({}), '2026-09-05');
  const log = logFor('h_x', [12, 11, 10]);
  const r1 = H.settle(r0, [h], ctxOf(log), TODAY);
  assert.equal(H.balance(r1), 100 + 10 + 11 + 12);
  assert.equal(H.balance(H.settle(r1, [h], ctxOf(log), TODAY)), H.balance(r1));
});

test('shields protect a missed day automatically and come back if the day is logged later', () => {
  const h = custom();
  let r = H.newRewardState('2026-10-10');
  r.grants.push({ g: 500, reason: 'test', on: '2026-10-10' });
  r = H.purchase(r, 'shield', '2026-10-10').state;
  assert.equal(H.shieldCount(r), 1);
  // 10/14〜10/16 達成、10/17(昨日)を忘れた、今日(10/18)達成
  const log = logFor('h_x', [4, 3, 2, 0]);
  r = H.settle(r, [h], ctxOf(log), TODAY);
  assert.deepEqual(r.freezes, { '2026-10-17': ['h_x'] });
  assert.equal(H.shieldCount(r), 0);
  assert.equal(H.currentStreak(h, TODAY, { ...ctxOf(log), freezes: r.freezes }).n, 4);
  // 昨日を後から記録したら護符は戻る
  const fixed = { ...log, '2026-10-17': { h_x: { n: 1 } } };
  r = H.settle(r, [h], ctxOf(fixed), TODAY);
  assert.deepEqual(r.freezes, {});
  assert.equal(H.shieldCount(r), 1);
});

test('shields are not spent when there is no streak to protect, or on rest days', () => {
  const h = custom();
  let r = H.newRewardState('2026-10-10');
  r.grants.push({ g: 500, reason: 'test', on: '2026-10-10' });
  r = H.purchase(r, 'shield', '2026-10-10').state;
  r = H.settle(r, [h], ctxOf({}), TODAY);
  assert.equal(H.shieldCount(r), 1);
  const rest = logFor('h_x', [3, 2]);
  rest['2026-10-17'] = { h_x: { rest: true } };
  r = H.settle(r, [h], ctxOf(rest), TODAY);
  assert.equal(H.shieldCount(r), 1);
});

test('weekly habits spend one shield for a missed week', () => {
  const h = custom({ freq: { type: 'weekly', times: 2 } });
  let r = H.newRewardState('2026-10-05');
  r.grants.push({ g: 500, reason: 'test', on: '2026-10-05' });
  r = H.purchase(r, 'shield', '2026-10-05').state;
  // 9/28週は2回達成、10/5週は1回だけ
  const log = { '2026-09-29': { h_x: { n: 1 } }, '2026-09-30': { h_x: { n: 1 } }, '2026-10-07': { h_x: { n: 1 } } };
  r = H.settle(r, [h], ctxOf(log), TODAY);
  assert.deepEqual(r.freezes, { '2026-10-05': ['h_x'] });
  const c = { ...ctxOf(log), freezes: r.freezes };
  assert.equal(H.weeklyStreakAt(h, '2026-10-11', c), 1);
});

test('shop: gold, ownership, shield cap and equipment', () => {
  let r = H.newRewardState(TODAY);
  assert.equal(H.purchase(r, 'p_cat', TODAY).reason, 'gold');
  assert.equal(H.purchase(r, 'nope', TODAY).reason, 'unknown');
  r.grants.push({ g: 2000, reason: 'test', on: TODAY });
  const bought = H.purchase(r, 'p_cat', TODAY);
  assert.ok(bought.ok);
  r = bought.state;
  assert.equal(r.equipped.pet, 'p_cat');
  assert.equal(H.balance(r), 2100 - 500);
  assert.equal(H.purchase(r, 'p_cat', TODAY).reason, 'owned');
  for (let i = 0; i < 3; i++) r = H.purchase(r, 'shield', TODAY).state;
  assert.equal(H.purchase(r, 'shield', TODAY).reason, 'max');
  r = H.equip(r, 'pet', null);
  assert.equal(r.equipped.pet, null);
  assert.equal(H.equip(r, 'pet', 'p_dragon').equipped.pet, null, 'cannot equip unowned');
});

test('medals: first time per habit and tier, kept after the day is folded into bank', () => {
  const h = custom();
  const log = logFor('h_x', [14, 13, 12, 11, 10, 9, 8]);   // 10/4〜10/10で7日
  let r = H.settle(H.newRewardState('2026-10-01'), [h], ctxOf(log), '2026-10-10');
  assert.deepEqual(H.medals(r).map(m => [m.habitId, m.unit, m.tier, m.on]), [['h_x', 'd', 7, '2026-10-10']]);
  r = H.settle(r, [h], ctxOf(log), TODAY);
  assert.equal(Object.keys(r.days).length, 0);
  assert.equal(r.medals.length, 1);
  assert.equal(H.medalIcon('d', 30), '🥈');
});

test('record writers keep notes, add minutes and toggle workout parts', () => {
  const e = H.normalizeHabit({ link: 'english', goal: { type: 'minutes', target: 30 } });
  let day = { english: { done: true, note: 'podcast', duration: '10', rating: 3 } };
  day = H.linkedDayPatch(day, e, { type: 'minutes', delta: 15 });
  assert.deepEqual(day.english, { done: true, note: 'podcast', duration: '25', rating: 3 });
  day = H.linkedDayPatch(day, e, { type: 'minutes', delta: -40 });
  assert.equal(day.english.done, false); assert.equal(day.english.note, 'podcast');
  const c = H.normalizeHabit({ link: 'cooking' });
  assert.equal(H.linkedDayPatch({}, c, { type: 'toggle' }).cooking.done, true);
  const w = H.normalizeHabit({ link: 'workout', goal: { type: 'count', target: 2 } });
  const wd = H.linkedDayPatch({ english: { done: true } }, w, { type: 'part', part: 'chest', on: true });
  assert.equal(wd.workout_chest.done, true); assert.equal(wd.english.done, true);
  let log = H.setLogValue({}, TODAY, 'h_x', 2);
  log = H.setRest(log, TODAY, 'h_x', true);
  assert.deepEqual(log, { [TODAY]: { h_x: { n: 2, rest: true } } });
  log = H.setLogValue(H.setRest(log, TODAY, 'h_x', false), TODAY, 'h_x', 0);
  assert.deepEqual(log, {});
});

test('rates leave out rest days, shielded days and an unfinished today', () => {
  const h = custom();
  const log = logFor('h_x', [6, 5, 3]);
  log[H.addDays(TODAY, -4)] = { h_x: { rest: true } };
  const r = H.habitRate(h, H.addDays(TODAY, -6), TODAY, TODAY, ctxOf(log));
  // 対象: 6,5,3(達成) 2,1(未達) / 4は休息, 今日は未確定
  assert.deepEqual(r, { due: 5, ok: 3, rate: 0.6 });
  assert.deepEqual(H.bestStreak(h, H.addDays(TODAY, -6), TODAY, ctxOf(log)), { n: 3, unit: 'd' });
  const later = custom({ createdOn: H.addDays(TODAY, -2) });
  assert.equal(H.habitRate(later, H.addDays(TODAY, -6), TODAY, TODAY, ctxOf(log)).due, 2);
  const dc = H.dayCompletion([h, custom({ id: 'h_y' })], H.addDays(TODAY, -3), ctxOf(log));
  assert.deepEqual(dc, { due: 2, done: 1 });
});
