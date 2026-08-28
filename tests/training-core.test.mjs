// node --test tests/ で実行(依存なし・node:test使用)
import test from "node:test";
import assert from "node:assert/strict";
import { nextTemplateId, lastSessionSets, prefillFor, TEMPLATE_ORDER }
  from "../js/training-core.mjs";

// ── Workout cycle ─────────────────────────────────────────────────────────────
test("cycle: A→B→C→D→A", () => {
  assert.equal(nextTemplateId("A"), "B");
  assert.equal(nextTemplateId("B"), "C");
  assert.equal(nextTemplateId("C"), "D");
  assert.equal(nextTemplateId("D"), "A");
});

test("cycle: 履歴なしは先頭から", () => {
  assert.equal(nextTemplateId(null), "A");
  assert.equal(nextTemplateId(undefined), "A");
});

test("cycle: 未知IDでも先頭にフォールバック", () => {
  assert.equal(nextTemplateId("Z"), "A");
});

test("cycle: 週に3回しかできなくてもスキップしない(直近完了だけで決まる)", () => {
  // 先週 A,B,C で終わった → 今週最初は D。曜日・週は無関係。
  assert.equal(nextTemplateId("C", TEMPLATE_ORDER), "D");
});

test("cycle: カスタム順序", () => {
  assert.equal(nextTemplateId("B", ["A", "B"]), "A");
});

// ── 前回パフォーマンス ────────────────────────────────────────────────────────
const LOGS = [
  { t: "2026-08-20T10:00:00.000Z", ex: "ベンチプレス", part: "chest", kg: 47.5, reps: 10 },
  { t: "2026-08-24T10:00:00.000Z", ex: "ベンチプレス", part: "chest", kg: 50, reps: 8 },
  { t: "2026-08-24T10:05:00.000Z", ex: "ベンチプレス", part: "chest", kg: 50, reps: 8 },
  { t: "2026-08-24T10:10:00.000Z", ex: "ベンチプレス", part: "chest", kg: 50, reps: 6 },
  { t: "2026-08-24T10:15:00.000Z", ex: "ベンチプレス", part: "chest", kg: 50, reps: 5 },
  { t: "2026-08-24T10:20:00.000Z", ex: "サイドレイズ", part: "shoulder", kg: 8, reps: 15 },
];

test("lastSessionSets: 直近日のセットだけ集計する", () => {
  const p = lastSessionSets(LOGS, "ベンチプレス");
  assert.equal(p.day, "2026-08-24");
  assert.equal(p.kg, 50);
  assert.deepEqual(p.reps, [8, 8, 6, 5]);
  assert.equal(p.totalReps, 27);
  assert.equal(p.volume, 50 * 27);
  assert.equal(p.sets, 4);
});

test("lastSessionSets: beforeISOで進行中セッションを除外できる", () => {
  const p = lastSessionSets(LOGS, "ベンチプレス", "2026-08-24T00:00:00.000Z");
  assert.equal(p.day, "2026-08-20");
  assert.deepEqual(p.reps, [10]);
});

test("lastSessionSets: 記録がなければnull", () => {
  assert.equal(lastSessionSets(LOGS, "スクワット"), null);
});

test("lastSessionSets: 自重(kg=0)のvolumeは0扱いで壊れない", () => {
  const logs = [{ t: "2026-08-24T10:00:00.000Z", ex: "懸垂", part: "back", kg: 0, reps: 10 }];
  const p = lastSessionSets(logs, "懸垂");
  assert.equal(p.volume, 0);
  assert.equal(p.totalReps, 10);
});

// ── プリフィル ────────────────────────────────────────────────────────────────
test("prefill: セッション中は直前セットを優先", () => {
  const pre = prefillFor([{ kg: 50, reps: 8 }], { kg: 47.5, reps: [10] });
  assert.deepEqual(pre, { kg: 50, reps: 8 });
});

test("prefill: セッション最初は前回実績の1セット目", () => {
  const pre = prefillFor([], { kg: 50, reps: [8, 8, 6, 5] });
  assert.deepEqual(pre, { kg: 50, reps: 8 });
});

test("prefill: 初回種目はnull", () => {
  assert.equal(prefillFor([], null), null);
});
