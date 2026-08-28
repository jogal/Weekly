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

// ── Body condition(体重トレンド) ─────────────────────────────────────────────
import { movingAvgWeight, weightTrend } from "../js/training-core.mjs";

const dkey = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// startWeightから1日deltaずつdays日分の記録を作る(skipDaysは欠測)
function makeDaily(days, startWeight, deltaPerDay, skip = []) {
  const daily = {};
  for (let i = 0; i < days; i++) {
    if (skip.includes(i)) continue;
    const d = new Date(2026, 7, 1 + i);
    daily[dkey(d.getFullYear(), d.getMonth() + 1, d.getDate())] =
      { weightKg: Math.round((startWeight + deltaPerDay * i) * 100) / 100 };
  }
  return daily;
}

test("movingAvg: 欠測日があっても記録がある日だけで平均する", () => {
  const daily = { "2026-08-26": { weightKg: 54.0 }, "2026-08-28": { weightKg: 54.4 } };
  assert.equal(movingAvgWeight(daily, "2026-08-28"), 54.2);
  assert.equal(movingAvgWeight({}, "2026-08-28"), null);
});

test("weightTrend: 3週間フラット → stalled(食事+100〜150kcal提案)", () => {
  const daily = makeDaily(22, 54.0, 0);
  const t = weightTrend(daily, "2026-08-22");
  assert.equal(t.status, "stalled");
  assert.ok(t.message.includes("100〜150"));
});

test("weightTrend: +0.14kg/週 → ok", () => {
  const daily = makeDaily(22, 54.0, 0.02);
  const t = weightTrend(daily, "2026-08-22");
  assert.equal(t.status, "ok");
});

test("weightTrend: +0.42kg/週 → fast(速すぎ警告)", () => {
  const daily = makeDaily(22, 54.0, 0.06);
  const t = weightTrend(daily, "2026-08-22");
  assert.equal(t.status, "fast");
});

test("weightTrend: 記録5日ぶんでは判定しない(insufficient)", () => {
  const daily = makeDaily(5, 54.0, 0.02);
  const t = weightTrend(daily, "2026-08-05");
  assert.equal(t.status, "insufficient");
  assert.ok(t.avg7 != null);
});

test("weightTrend: 記録ゼロ → no_data", () => {
  assert.equal(weightTrend({}, "2026-08-22").status, "no_data");
});

// ── Phase 5 hardening: coverage・pct基準・最新体重・タンパク質summary ─────────
import { weightWindowStats, latestWeightKg, proteinSummary } from "../js/training-core.mjs";

test("coverage: current 1件 + 14日前1件 → insufficient", () => {
  const daily = { "2026-08-22": { weightKg: 54.5 }, "2026-08-08": { weightKg: 54.0 } };
  const t = weightTrend(daily, "2026-08-22");
  assert.equal(t.status, "insufficient");
});

test("coverage: current/refとも4件以上なら判定可能・欠測込みでもOK", () => {
  // 週4日測定(3日おきに欠測)を4週間 → cur/refとも4件以上
  const daily = makeDaily(28, 54.0, 0, [2, 5, 9, 12, 16, 19, 23, 26]);
  const stats = weightWindowStats(daily, "2026-08-28");
  assert.ok(stats.count >= 4, "count=" + stats.count);
  const t = weightTrend(daily, "2026-08-28");
  assert.equal(t.status, "stalled");             // フラットなので判定はstalled
});

test("pace: flat → stalled(+100〜150kcal提案はこの場合だけ)", () => {
  const t = weightTrend(makeDaily(22, 54.0, 0), "2026-08-22");
  assert.equal(t.status, "stalled");
  assert.ok(t.message.includes("100〜150"));
});

test("pace: わずかな増加(+0.04kg/週) → slow(カロリー追加を即提案しない)", () => {
  const daily = makeDaily(22, 54.0, 0.006);      // +0.042kg/週 ≈ 0.078%BW/週
  const t = weightTrend(daily, "2026-08-22");
  assert.equal(t.status, "slow");
  assert.ok(!t.message.includes("100〜150"));
});

test("pace: 0.1〜0.25%BW/週 → ok / >0.3% → fast", () => {
  assert.equal(weightTrend(makeDaily(22, 54.0, 0.015), "2026-08-22").status, "ok");   // +0.105kg/週≈0.19%
  assert.equal(weightTrend(makeDaily(22, 54.0, 0.06), "2026-08-22").status, "fast");  // +0.42kg/週≈0.78%
});

test("pace: 14日refと21日refで同じweekly paceなら同じstatus", () => {
  // 同じ+0.02kg/日ペース。片方はref14ウィンドウ(8〜14日前)を欠測させref21で判定させる
  const full = makeDaily(28, 54.0, 0.02);
  const skipRef14 = makeDaily(28, 54.0, 0.02, [7, 8, 9, 10]);  // ref14窓(8/8-8/14)を4日欠測させ3件に
  const t1 = weightTrend(full, "2026-08-28");
  const t2 = weightTrend(skipRef14, "2026-08-28");
  assert.equal(t2.refDays === 14, false);        // ref14が使えないケースになっている
  assert.equal(t1.status, t2.status);            // それでも同じstatus
});

test("latestWeightKg: dailyの最新を優先・なければfallback", () => {
  const daily = { "2026-08-20": { weightKg: 54.0 }, "2026-08-25": { weightKg: 54.6 },
                  "2026-08-26": { proteinG: 90 } };
  assert.equal(latestWeightKg(daily, 54), 54.6);
  assert.equal(latestWeightKg({}, 54), 54);
});

test("proteinSummary: 直近7日のavg/記録日数/90g以上日数/今日", () => {
  const daily = {
    "2026-08-22": { proteinG: 100 }, "2026-08-24": { proteinG: 80 },
    "2026-08-26": { proteinG: 95 },  "2026-08-28": { proteinG: 110 },
  };
  const s = proteinSummary(daily, "2026-08-28");
  assert.equal(s.recordedDays, 4);
  assert.equal(s.avg7, Math.round((100 + 80 + 95 + 110) / 4));
  assert.equal(s.daysAtLeast90, 3);
  assert.equal(s.todayG, 110);
  assert.equal(s.targetG, 105);
});

// ── Quest表示ミラー(Monkリワード) ────────────────────────────────────────────
import { xpForQuestRecord, questLevelFromXP, questXpToReach, questTierOf,
         monkStateFromRecords } from "../js/training-core.mjs";

test("quest-mirror: xpForQuestRecordはtrackerと同一式", () => {
  assert.equal(xpForQuestRecord(null), 0);
  assert.equal(xpForQuestRecord({ done: false }), 0);
  assert.equal(xpForQuestRecord({ done: true }), 10);
  assert.equal(xpForQuestRecord({ done: true, duration: "60", rating: 4 }), 10 + 12 + 8);
  assert.equal(xpForQuestRecord({ done: true, duration: "999", rating: 5 }), 10 + 20 + 10); // durationボーナス上限20
});

test("quest-mirror: レベル曲線50*(L-1)^1.6とtier境界", () => {
  assert.equal(questXpToReach(1), 0);
  assert.equal(questXpToReach(2), 50);
  assert.equal(questLevelFromXP(0), 1);
  assert.equal(questLevelFromXP(49), 1);
  assert.equal(questLevelFromXP(50), 2);
  assert.equal(questTierOf(9), 1);
  assert.equal(questTierOf(10), 10);
  assert.equal(questTierOf(39), 30);
  assert.equal(questTierOf(40), 40);
});

test("quest-mirror: monkStateFromRecordsはworkout_*だけ合算し減衰も反映", () => {
  const records = {
    "2026-08-24": { mon: {
      workout_chest: { done: true, duration: "60", rating: 0 },  // 10+12=22
      workout_leg:   { done: true },                              // 10
      medicine:      { done: true, duration: "60", rating: 5 },   // 筋トレ以外→無視
    }}};
  // 最終実施 8/24(月)。8/28なら猶予内で減衰なし
  const s1 = monkStateFromRecords(records, "2026-08-28");
  assert.equal(s1.rawXP, 32);
  assert.equal(s1.xp, 32);
  assert.equal(s1.lastDone, "2026-08-24");
  // 10日後(idle=10, 猶予7日超過3日×8=24減)
  const s2 = monkStateFromRecords(records, "2026-09-03");
  assert.equal(s2.xp, 32 - 24);
  // 減衰はrawを下回っても0未満にならない
  const s3 = monkStateFromRecords(records, "2026-10-01");
  assert.equal(s3.xp, 0);
});
