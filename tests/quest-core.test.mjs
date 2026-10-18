import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../js/habit-core.mjs';
import * as Q from '../js/quest-core.mjs';

const TODAY = '2026-10-18';
// n日分(今日からさかのぼる)の記録を作る
function recordsFor(entries) {
  const rec = {};
  for (const [key, cat, r] of entries) {
    const wk = H.mondayOf(key), dk = H.DAY_KEYS[H.weekdayIdx(key)];
    ((rec[wk] ||= {})[dk] ||= {})[cat] = { done: true, note: '', duration: '', rating: 0, ...r };
  }
  return rec;
}
const daysBack = n => Array.from({ length: n }, (_, i) => H.addDays(TODAY, -i));
const habits = H.defaultHabits('2026-01-01');
const board = (records, opts = {}) => {
  const reward = opts.reward || H.newRewardState(TODAY);
  const hs = opts.habits || habits;
  const m = Q.questMetrics({ records, log: opts.log || {}, habits: hs, reward, today: TODAY });
  return { m, reward, b: Q.questBoard(m, reward, hs) };
};
const line = (b, id) => b.find(q => q.line.id === id);

test('metrics count days per track, workout parts, minutes and active days from wt_records', () => {
  const rec = recordsFor([
    ...daysBack(12).map(k => [k, 'cooking', {}]),
    [TODAY, 'workout_leg', {}], [TODAY, 'workout_chest', {}],
    [H.addDays(TODAY, -1), 'workout_leg', {}],
    [TODAY, 'english', { duration: '45' }], [H.addDays(TODAY, -1), 'english', { duration: '30' }],
    [H.addDays(TODAY, -2), 'english', { done: false, duration: '90' }],
    [H.addDays(TODAY, 3), 'cooking', {}],                        // 未来の日は数えない
  ]);
  const { m } = board(rec);
  assert.equal(m.track.cooking, 12);
  assert.equal(m.track.workout, 2, 'two parts on one day count as one workout day');
  assert.equal(m.part.leg, 2);
  assert.equal(m.minutes.english, 75, 'only completed records add minutes');
  assert.equal(m.activeDays, 12);
});

test('board: locked until the target, claim pays gold once and reveals the next tier', () => {
  const rec = recordsFor(daysBack(12).map(k => [k, 'cooking', {}]));
  let { reward, b } = board(rec);
  const q = line(b, 'cooking_days');
  assert.equal(q.title, '台所の主 I');
  assert.equal(q.claimable, true);
  assert.equal(Q.progressText(q), '12/10日');
  assert.equal(Q.questDesc(q), '自炊を10日');
  assert.equal(line(b, 'workout_days').claimable, false);
  const before = H.balance(reward);
  const res = Q.claimQuest(reward, b, q.id, TODAY);
  assert.ok(res.ok); assert.equal(res.gold, 50);
  assert.equal(H.balance(res.state), before + 50);
  assert.equal(Q.claimQuest(res.state, b, q.id, TODAY).reason, 'claimed');
  ({ b } = board(rec, { reward: res.state }));
  const next = line(b, 'cooking_days');
  assert.equal(next.title, '台所の主 II');
  assert.equal(next.claimable, false);
  assert.equal(Q.rewardText(next), '200G');
  assert.equal(Q.claimQuest(res.state, b, next.id, TODAY).reason, 'locked');
});

test('quest rewards are gold only: no items are handed out', () => {
  for (const l of Q.QUEST_LINES) for (const t of l.tiers) assert.equal('item' in t, false, l.id);
  const rec = recordsFor(daysBack(31).map(k => [k, 'english', { duration: '60' }]));
  let { reward, b } = board(rec);
  reward = Q.claimQuest(reward, b, line(b, 'english_hours').id, TODAY).state;
  ({ b } = board(rec, { reward }));
  const q2 = line(b, 'english_hours');
  assert.equal(Q.rewardText(q2), '150G');
  const res = Q.claimQuest(reward, b, q2.id, TODAY);
  assert.equal(res.gold, 150);
  assert.equal('item' in res, false);
  assert.equal('owned' in res.state, false);
});

test('hours are shown with one decimal under ten hours', () => {
  const rec = recordsFor([[TODAY, 'medicine', { duration: '275' }]]);
  const q = line(board(rec).b, 'medicine_hours');
  assert.equal(Q.progressText(q), '4.5/10時間');
  assert.equal(Q.questDesc(q), '専門医勉強を累計10時間');
});

test('custom habits get their own quest line; archived ones leave the board but keep history', () => {
  const stretch = H.normalizeHabit({ id: 'h_s', name: 'ストレッチ', icon: '🧘', createdOn: '2026-10-01', goal: { type: 'minutes', target: 5 } });
  const log = {};
  daysBack(8).forEach(k => { log[k] = { h_s: { n: 5 } }; });
  log[H.addDays(TODAY, -9)] = { h_s: { n: 3 } };              // 目標未満は数えない
  const hs = [...habits, stretch];
  let { m, reward, b } = board({}, { habits: hs, log });
  assert.equal(m.habit.h_s, 8);
  assert.equal(m.habitTotal, 8);
  const q = line(b, 'habit_h_s');
  assert.equal(Q.questDesc(q), '「ストレッチ」を7日達成');
  assert.ok(q.claimable);
  reward = Q.claimQuest(reward, b, q.id, TODAY).state;
  const archived = hs.map(h => h.id === 'h_s' ? { ...h, archived: true, archivedOn: H.addDays(TODAY, 1) } : h);
  assert.equal(Q.questBoard(m, reward, archived).some(x => x.line.id === 'habit_h_s'), false);
  assert.equal(Q.claimedHistory(reward, archived)[0].title, 'ストレッチ I');
});

test('perfect days and medals feed their quest lines; finishing every tier marks the line done', () => {
  const rec = recordsFor(daysBack(3).flatMap(k => ['medicine', 'english', 'instrument', 'cooking'].map(c => [k, c, {}])));
  const { m } = board(rec);
  assert.equal(m.perfectDays, 3);
  const reward = H.newRewardState(TODAY);
  reward.medals = [{ habitId: 'h_medicine', unit: 'd', tier: 7, on: TODAY }];
  reward.quests.claimed = { 'medals:0': TODAY, 'medals:1': TODAY, 'medals:2': TODAY };
  const b = Q.questBoard(Q.questMetrics({ records: rec, habits, reward, today: TODAY }), reward, habits);
  const md = line(b, 'medals');
  assert.equal(md.done, true); assert.equal(md.id, null); assert.equal(md.claimable, false);
  assert.ok(line(b, 'perfect_days').claimable);
});

test('nearest quest is the most advanced one that is not ready yet', () => {
  const rec = recordsFor([...daysBack(8).map(k => [k, 'cooking', {}]), ...daysBack(3).map(k => [k, 'instrument', {}])]);
  const { b } = board(rec);
  assert.equal(Q.nearestQuest(b).line.id, 'cooking_days');
  assert.equal(Q.claimableQuests(b).length, 0);
});

test('reward state keeps claimed quests through normalize and settle', () => {
  const r = H.newRewardState(TODAY);
  r.quests.claimed['cooking_days:0'] = TODAY;
  const n = H.normalizeReward(JSON.parse(JSON.stringify(r)), TODAY);
  assert.deepEqual(n.quests.claimed, { 'cooking_days:0': TODAY });
  const s = H.settle(n, habits, { records: {}, log: {}, freezes: {}, today: TODAY }, TODAY);
  assert.deepEqual(s.quests.claimed, { 'cooking_days:0': TODAY });
  assert.deepEqual(H.normalizeReward({ startedOn: TODAY }, TODAY).quests, { claimed: {} });
});
