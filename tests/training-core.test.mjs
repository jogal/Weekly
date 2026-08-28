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
