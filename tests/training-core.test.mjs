// TZ=Asia/Tokyo node --test tests/training-core.test.mjs で実行(依存なし・node:test)
// ※local日付テストのためTZは起動時にAsia/Tokyoへ固定する(下のsetenvはNode20+で有効)
process.env.TZ = "Asia/Tokyo";

import test from "node:test";
import assert from "node:assert/strict";
import {
  nextTemplateId, lastCompletedTemplateIdFrom, localDayKey, isStaleSession,
  lastSessionSets, prefillFor, TEMPLATE_ORDER,
} from "../js/training-core.mjs";

// ── Workout cycle ─────────────────────────────────────────────────────────────
test("cycle: A→B→C→D→A", () => {
  assert.equal(nextTemplateId("A"), "B");
  assert.equal(nextTemplateId("B"), "C");
  assert.equal(nextTemplateId("C"), "D");
  assert.equal(nextTemplateId("D"), "A");
});

test("cycle: 履歴なし/未知IDは先頭から", () => {
  assert.equal(nextTemplateId(null), "A");
  assert.equal(nextTemplateId("Z"), "A");
});

test("cycle: 週に3回しかできなくてもスキップしない", () => {
  assert.equal(nextTemplateId("C", TEMPLATE_ORDER), "D");
});

test("cycle: unfinished workout(active/aborted)はサイクルを進めない", () => {
  const sessions = [
    { id: "1", templateId: "A", status: "completed" },
    { id: "2", templateId: "B", status: "aborted" },    // 中断
    { id: "3", templateId: "B", status: "active" },     // 進行中
  ];
  assert.equal(lastCompletedTemplateIdFrom(sessions), "A");
  assert.equal(nextTemplateId(lastCompletedTemplateIdFrom(sessions)), "B");
});

// ── local日付 / stale session ────────────────────────────────────────────────
test("localDayKey: UTC日付とlocal日付が異なる時刻(JST早朝=UTC前日)", () => {
  // JST 2026-08-25 08:00 = UTC 2026-08-24 23:00 → localは25日
  const iso = new Date(2026, 7, 25, 8, 0).toISOString();
  assert.equal(iso.slice(0, 10), "2026-08-24"); // UTC sliceだと前日になる(旧バグ)
  assert.equal(localDayKey(iso), "2026-08-25");
});

test("isStaleSession: 前日のactive sessionだけstale", () => {
  assert.equal(isStaleSession({ status: "active", date: "2026-08-27" }, "2026-08-28"), true);
  assert.equal(isStaleSession({ status: "active", date: "2026-08-28" }, "2026-08-28"), false);
  assert.equal(isStaleSession({ status: "completed", date: "2026-08-27" }, "2026-08-28"), false);
  assert.equal(isStaleSession(null, "2026-08-28"), false);
});

// ── 前回パフォーマンス ────────────────────────────────────────────────────────
const T = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).toISOString();

test("lastSessionSets: ドロップセット(16kg→14kg)でも各setを失わない", () => {
  const logs = [
    { t: T(2026, 8, 24, 10, 0), ex: "サイドレイズ", part: "shoulder", kg: 16, reps: 12, sessionId: "s1" },
    { t: T(2026, 8, 24, 10, 4), ex: "サイドレイズ", part: "shoulder", kg: 16, reps: 10, sessionId: "s1" },
    { t: T(2026, 8, 24, 10, 8), ex: "サイドレイズ", part: "shoulder", kg: 14, reps: 10, sessionId: "s1" },
  ];
  const p = lastSessionSets(logs, "サイドレイズ");
  assert.deepEqual(p.sets, [{ kg: 16, reps: 12 }, { kg: 16, reps: 10 }, { kg: 14, reps: 10 }]);
  assert.equal(p.firstWorkingWeight, 16);
  assert.equal(p.maxWeight, 16);
  assert.equal(p.totalReps, 32);
  assert.equal(p.volume, 16 * 12 + 16 * 10 + 14 * 10);
});

test("lastSessionSets: sessionIdでグルーピング(深夜0時マタギでも1回扱い)", () => {
  const logs = [
    { t: T(2026, 8, 24, 23, 50), ex: "ベンチプレス", part: "chest", kg: 50, reps: 8, sessionId: "s9" },
    { t: T(2026, 8, 25, 0, 10),  ex: "ベンチプレス", part: "chest", kg: 50, reps: 6, sessionId: "s9" },
  ];
  const p = lastSessionSets(logs, "ベンチプレス");
  assert.equal(p.sets.length, 2);
  assert.equal(p.sessionId, "s9");
});

test("lastSessionSets: legacyログ(sessionIdなし)はlocal日付でまとめる", () => {
  // JST 8/24 20:00 と JST 8/25 08:00(=UTC 8/24)は別の日として扱う
  const logs = [
    { t: T(2026, 8, 24, 20, 0), ex: "ベンチプレス", part: "chest", kg: 47.5, reps: 10 },
    { t: T(2026, 8, 25, 8, 0),  ex: "ベンチプレス", part: "chest", kg: 50,   reps: 8 },
  ];
  const p = lastSessionSets(logs, "ベンチプレス");
  assert.equal(p.day, "2026-08-25");
  assert.deepEqual(p.sets, [{ kg: 50, reps: 8 }]);   // 25日の1セットだけ
});

test("lastSessionSets: legacy+session混在でも直近グループを正しく選ぶ", () => {
  const logs = [
    { t: T(2026, 8, 20, 10, 0), ex: "ベンチプレス", part: "chest", kg: 47.5, reps: 10 },              // legacy
    { t: T(2026, 8, 24, 10, 0), ex: "ベンチプレス", part: "chest", kg: 50, reps: 8, sessionId: "s1" },
    { t: T(2026, 8, 24, 10, 5), ex: "ベンチプレス", part: "chest", kg: 50, reps: 6, sessionId: "s1" },
  ];
  const p = lastSessionSets(logs, "ベンチプレス");
  assert.equal(p.sessionId, "s1");
  assert.equal(p.totalReps, 14);
  // beforeISOで進行中セッション以前を見るとlegacyに落ちる
  const p2 = lastSessionSets(logs, "ベンチプレス", { beforeISO: T(2026, 8, 24, 9, 0) });
  assert.equal(p2.sessionId, null);
  assert.deepEqual(p2.sets, [{ kg: 47.5, reps: 10 }]);
});

test("lastSessionSets: 同一種目がA/D双方にある場合slotで区別できる", () => {
  const logs = [
    { t: T(2026, 8, 22, 10, 0), ex: "インクラインダンベルプレス", part: "chest", kg: 16, reps: 12, sessionId: "sA", slot: "A2" },
    { t: T(2026, 8, 24, 10, 0), ex: "インクラインダンベルプレス", part: "chest", kg: 18, reps: 8,  sessionId: "sD", slot: "D1" },
  ];
  // slot指定→そのslotの直近だけ
  assert.equal(lastSessionSets(logs, "インクラインダンベルプレス", { slot: "A2" }).sets[0].kg, 16);
  assert.equal(lastSessionSets(logs, "インクラインダンベルプレス", { slot: "D1" }).sets[0].kg, 18);
  // slot未指定→種目全体の直近
  assert.equal(lastSessionSets(logs, "インクラインダンベルプレス").sets[0].kg, 18);
});

test("lastSessionSets: slot指定でもslotなしlegacyログは種目名で拾う(後方互換)", () => {
  const logs = [
    { t: T(2026, 8, 20, 10, 0), ex: "ベンチプレス", part: "chest", kg: 50, reps: 8 },  // legacy
  ];
  const p = lastSessionSets(logs, "ベンチプレス", { slot: "A1" });
  assert.deepEqual(p.sets, [{ kg: 50, reps: 8 }]);
});

test("lastSessionSets: 記録がなければnull / 自重kg=0でも壊れない", () => {
  assert.equal(lastSessionSets([], "スクワット"), null);
  const p = lastSessionSets(
    [{ t: T(2026, 8, 24, 10, 0), ex: "懸垂", part: "back", kg: 0, reps: 10 }], "懸垂");
  assert.equal(p.volume, 0);
  assert.equal(p.firstWorkingWeight, 0);
});

// ── プリフィル ────────────────────────────────────────────────────────────────
test("prefill: セッション中は直前セット優先/最初は前回1セット目/初回はnull", () => {
  const prev = { sets: [{ kg: 50, reps: 8 }, { kg: 50, reps: 6 }] };
  assert.deepEqual(prefillFor([{ kg: 52.5, reps: 6 }], prev), { kg: 52.5, reps: 6 });
  assert.deepEqual(prefillFor([], prev), { kg: 50, reps: 8 });
  assert.equal(prefillFor([], null), null);
});

// ── Progressive overload engine ───────────────────────────────────────────────
import { getNextExerciseTarget, sessionHistory } from "../js/training-core.mjs";

const sess = (kg, reps, extra = {}) => ({
  day: "2026-08-24", sessionId: null,
  sets: reps.map(r => ({ kg, reps: r })),
  firstWorkingWeight: kg, maxWeight: kg,
  totalReps: reps.reduce((a, b) => a + b, 0),
  volume: reps.reduce((a, b) => a + b, 0) * kg, ...extra,
});
const ARGS = { targetSets: 4, repMin: 6, repMax: 10, increment: 2.5 };

test("overload: 50kg 8/8/6/5 → 重量維持・計29回目標", () => {
  const t = getNextExerciseTarget({ ...ARGS, history: [sess(50, [8, 8, 6, 5])] });
  assert.equal(t.status, "progress_reps");
  assert.equal(t.weight, 50);
  assert.equal(t.targetTotalReps, 29);
  assert.equal(t.suggestedSetTargets.reduce((a, b) => a + b, 0), 29);
  assert.ok(t.suggestedSetTargets.every(r => r <= 10));
});

test("overload: 50kg 10/10/10/10 → 52.5kgへ増量・repMinから再構築", () => {
  const t = getNextExerciseTarget({ ...ARGS, history: [sess(50, [10, 10, 10, 10])] });
  assert.equal(t.status, "increase_weight");
  assert.equal(t.weight, 52.5);
  assert.equal(t.targetTotalReps, 24);
  assert.deepEqual(t.suggestedSetTargets, [6, 6, 6, 6]);
});

test("overload: 1回のperformance低下では重量を下げない", () => {
  const t = getNextExerciseTarget({ ...ARGS,
    history: [sess(50, [8, 8, 8, 8]), sess(50, [7, 7, 6, 6])] });
  assert.equal(t.weight, 50);                    // 下げない
  assert.equal(t.status, "progress_reps");       // plateau扱いにもしない
});

test("overload: 同一重量で2回連続低下 → plateau(重量維持・volume増やさない)", () => {
  const t = getNextExerciseTarget({ ...ARGS,
    history: [sess(50, [8, 8, 8, 8]), sess(50, [7, 7, 6, 6]), sess(50, [6, 6, 6, 5])] });
  assert.equal(t.status, "plateau");
  assert.equal(t.weight, 50);
  assert.equal(t.targetTotalReps, 23);           // 前回維持。増やさない
});

test("overload: pain=true では全セット上限到達でも増量しない", () => {
  const t = getNextExerciseTarget({ ...ARGS, pain: true,
    history: [sess(50, [10, 10, 10, 10])] });
  assert.equal(t.status, "hold_pain");
  assert.equal(t.weight, 50);
});

test("overload: 履歴なし → first_time(数値目標を出さない)", () => {
  const t = getNextExerciseTarget({ ...ARGS, history: [] });
  assert.equal(t.status, "first_time");
  assert.equal(t.weight, null);
});

// mixed-load summary生成ヘルパ(sessionHistoryが返す形)
const mixed = (pairs, extra = {}) => {
  const sets = pairs.map(([kg, reps]) => ({ kg, reps }));
  const primaryWeight = sets[0].kg;
  const primarySets = sets.filter(s => s.kg === primaryWeight);
  return {
    day: "2026-08-24", sessionId: null, sessionStatus: null, sets,
    firstWorkingWeight: primaryWeight, maxWeight: Math.max(...sets.map(s => s.kg)),
    totalReps: sets.reduce((a, s) => a + s.reps, 0),
    volume: sets.reduce((a, s) => a + s.kg * s.reps, 0),
    primaryWeight, primarySets,
    primaryTotalReps: primarySets.reduce((a, s) => a + s.reps, 0),
    backoffSets: sets.filter(s => s.kg !== primaryWeight), ...extra,
  };
};

test("overload: mixed load — backoff(14kg)のrepsをprimary(16kg)のprogressに数えない", () => {
  // primary 16kg×12,10 = 22回。backoff 14kg×10 は無視 → 目標は22+2=24(合計32ではない)
  const h = [mixed([[16, 12], [16, 10], [14, 10]])];
  const t = getNextExerciseTarget({ targetSets: 2, repMin: 8, repMax: 12, increment: 1, history: h });
  assert.equal(t.status, "progress_reps");
  assert.equal(t.weight, 16);
  assert.equal(t.targetTotalReps, 24);           // 22+2。32+2=34にならない
});

test("overload: mixed loadでprimaryセットが予定数未満なら増量もrep進行もしない", () => {
  const h = [mixed([[16, 12], [16, 10], [14, 10]])];
  const t = getNextExerciseTarget({ targetSets: 3, repMin: 8, repMax: 12, increment: 1, history: h });
  assert.equal(t.status, "incomplete_prev");
  assert.equal(t.weight, 16);
});

test("overload: incomplete 2/4セット → progressionを進めず4セットやり切る目標", () => {
  const t = getNextExerciseTarget({ ...ARGS, history: [sess(50, [8, 8])] });
  assert.equal(t.status, "incomplete_prev");
  assert.equal(t.weight, 50);
  assert.equal(t.suggestedSetTargets.length, 4);
  assert.equal(t.targetTotalReps,
    t.suggestedSetTargets.reduce((a, b) => a + b, 0));   // 合計不変条件
  assert.deepEqual(t.suggestedSetTargets, [8, 8, 6, 6]); // 不足はrepMin埋め・+2しない
});

test("overload: aborted sessionはprogression基準にしない", () => {
  const h = [
    sess(50, [8, 8, 8, 8], { sessionStatus: "completed" }),
    sess(50, [5], { sessionStatus: "aborted" }),          // 中断(1セットで終了)
  ];
  const t = getNextExerciseTarget({ ...ARGS, history: h });
  assert.equal(t.status, "progress_reps");                // abortedを無視して前回完了が基準
  assert.equal(t.targetTotalReps, 34);                    // 32+2
});

test("overload: increment 2kgのダンベル種目", () => {
  const t = getNextExerciseTarget({ targetSets: 3, repMin: 8, repMax: 12, increment: 2,
    history: [sess(16, [12, 12, 12])] });
  assert.equal(t.status, "increase_weight");
  assert.equal(t.weight, 18);
});

test("overload: 全ステータスで targetTotalReps === sum(suggestedSetTargets)", () => {
  const cases = [
    { ...ARGS, history: [sess(50, [8, 8, 6, 5])] },                      // progress
    { ...ARGS, history: [sess(50, [10, 10, 10, 10])] },                  // increase
    { ...ARGS, history: [sess(50, [8, 8])] },                            // incomplete
    { ...ARGS, pain: true, history: [sess(50, [10, 10, 10, 10])] },      // hold_pain
    { ...ARGS, history: [sess(50, [8,8,8,8]), sess(50, [7,7,6,6]), sess(50, [6,6,6,5])] }, // plateau
    { targetSets: 2, repMin: 8, repMax: 12, increment: 1,
      history: [mixed([[16, 12], [16, 10], [14, 10]])] },                // mixed
  ];
  cases.forEach(c => {
    const t = getNextExerciseTarget(c);
    assert.equal(t.targetTotalReps, t.suggestedSetTargets.reduce((a, b) => a + b, 0),
      "invariant broken for status " + t.status);
  });
});

test("sessionHistory: slotted logsが存在したらlegacyを混ぜない", () => {
  const logs = [
    { t: T(2026, 8, 20, 10, 0), ex: "ベンチプレス", part: "chest", kg: 47.5, reps: 10 },  // legacy
    { t: T(2026, 8, 24, 10, 0), ex: "ベンチプレス", part: "chest", kg: 50, reps: 8, sessionId: "s1", slot: "A1" },
  ];
  const h = sessionHistory(logs, "ベンチプレス", { slot: "A1", limit: 10 });
  assert.equal(h.length, 1);                     // legacy日は含まれない
  assert.equal(h[0].sets[0].kg, 50);
});

test("sessionHistory: sessions渡しでsessionStatusが付く", () => {
  const logs = [
    { t: T(2026, 8, 24, 10, 0), ex: "ベンチプレス", part: "chest", kg: 50, reps: 5, sessionId: "sX", slot: "A1" },
  ];
  const sessions = [{ id: "sX", templateId: "A", status: "aborted" }];
  const h = sessionHistory(logs, "ベンチプレス", { slot: "A1", sessions });
  assert.equal(h[0].sessionStatus, "aborted");
});

test("overload: 上限到達済みの合計はcapで頭打ち", () => {
  const t = getNextExerciseTarget({ ...ARGS, history: [sess(50, [10, 10, 10, 9])] });
  assert.equal(t.targetTotalReps, 40);           // min(39+2, 4×10)
});

test("sessionHistory: limitで直近n回・時系列昇順", () => {
  const logs = [];
  [[47.5, "2026-08-10"], [50, "2026-08-17"], [50, "2026-08-24"]].forEach(([kg, day], si) => {
    for (let i = 0; i < 2; i++) {
      logs.push({ t: new Date(day + "T10:0" + i + ":00").toISOString(),
        ex: "ベンチプレス", part: "chest", kg, reps: 8, sessionId: "h" + si });
    }
  });
  const h = sessionHistory(logs, "ベンチプレス", { limit: 2 });
  assert.equal(h.length, 2);
  assert.equal(h[0].day, "2026-08-17");
  assert.equal(h[1].day, "2026-08-24");
});
