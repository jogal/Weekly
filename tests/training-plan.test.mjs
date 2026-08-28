// node --test tests/training-plan.test.mjs (依存なし・node:test)
process.env.TZ = "Asia/Tokyo";

import test from "node:test";
import assert from "node:assert/strict";
import { generateWeeklyTrainingPlan, classifyEventTitle } from "../js/training-plan.mjs";

// 2026-08-24(月) 〜 2026-08-30(日)
const DATES = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27",
               "2026-08-28", "2026-08-29", "2026-08-30"];
const [MON, TUE, WED, THU, FRI, SAT, SUN] = DATES;
const base = { dates: DATES, nextWorkout: "A", targetSessions: 4 };

test("classify: hard/soft/medium/null", () => {
  assert.equal(classifyEventTitle("当直"), "hard");
  assert.equal(classifyEventTitle("on call"), "hard");
  assert.equal(classifyEventTitle("会食"), "soft");
  assert.equal(classifyEventTitle("学会"), "medium");
  assert.equal(classifyEventTitle("ジム"), null);         // 曖昧ならblockしない
});

test("planner: Wednesday on-call → 水曜を選ばない", () => {
  const p = generateWeeklyTrainingPlan({ ...base,
    events: { [WED]: [{ title: "当直" }] } });
  assert.ok(!p.recommendedDays.some(r => r.date === WED));
  assert.equal(p.dayInfo[WED].status, "blocked");
});

test("planner: 水曜はイベントなしでもdefault BLOCKED", () => {
  const p = generateWeeklyTrainingPlan({ ...base });
  assert.equal(p.dayInfo[WED].status, "blocked");
  assert.ok(!p.recommendedDays.some(r => r.date === WED));
});

test("planner: 4 free days → 4 sessions・cycle順", () => {
  // 月火のみ自由、木金も自由、他ブロック
  const p = generateWeeklyTrainingPlan({ ...base,
    manualOverrides: { [SAT]: "blocked", [SUN]: "blocked" } });
  assert.equal(p.recommendedDays.length, 4);
  assert.deepEqual(p.recommendedDays.map(r => r.templateId), ["A", "B", "C", "D"]);
});

test("planner: 3 free daysなら3 sessions・cycleを飛ばさない", () => {
  const p = generateWeeklyTrainingPlan({ ...base, nextWorkout: "C",
    manualOverrides: { [MON]: "blocked", [TUE]: "blocked", [SAT]: "blocked", [SUN]: "blocked" } });
  // 空きは木金のみ+…水曜default blockedなので木・金の2日 → 2 sessions
  assert.equal(p.recommendedDays.length, 2);
  assert.deepEqual(p.recommendedDays.map(r => r.templateId), ["C", "D"]);  // Cから継続
});

test("planner: 5日空いていても4回まで", () => {
  const p = generateWeeklyTrainingPlan({ ...base });
  assert.equal(p.recommendedDays.length, 4);
});

test("planner: manual BLOCKED は必ず除外", () => {
  const p = generateWeeklyTrainingPlan({ ...base,
    manualOverrides: { [MON]: "blocked", [TUE]: "blocked", [THU]: "blocked" } });
  [MON, TUE, THU].forEach(d =>
    assert.ok(!p.recommendedDays.some(r => r.date === d), d + " should be excluded"));
});

test("planner: manual AVAILABLE は自動ペナルティ(水曜default)より優先", () => {
  const p = generateWeeklyTrainingPlan({ ...base,
    manualOverrides: { [WED]: "available",
      [MON]: "blocked", [TUE]: "blocked", [FRI]: "blocked", [SAT]: "blocked", [SUN]: "blocked" } });
  // 空きは水・木のみ → 水曜が使われる
  assert.ok(p.recommendedDays.some(r => r.date === WED));
});

test("planner: D→Aの連日を可能なら避ける", () => {
  // nextWorkout=D、残り2回。金土日のみ空き → D(金)+A(土)よりD(金)+A(日)が高スコア
  const p = generateWeeklyTrainingPlan({ ...base, nextWorkout: "D", targetSessions: 2,
    manualOverrides: { [MON]: "blocked", [TUE]: "blocked", [THU]: "blocked" } });
  assert.equal(p.recommendedDays.length, 2);
  assert.equal(p.recommendedDays[0].templateId, "D");
  assert.equal(p.recommendedDays[1].templateId, "A");
  const [d1, d2] = p.recommendedDays.map(r => DATES.indexOf(r.date));
  assert.ok(d2 - d1 >= 2, "D→Aは48h空けるべき: " + JSON.stringify(p.recommendedDays));
});

test("planner: 完了済みセッションは残り回数から差し引く", () => {
  const p = generateWeeklyTrainingPlan({ ...base, nextWorkout: "C", todayKey: WED,
    completedSessions: [{ date: MON, templateId: "A" }, { date: TUE, templateId: "B" }] });
  assert.equal(p.remaining, 2);
  assert.equal(p.recommendedDays.length, 2);
  assert.deepEqual(p.recommendedDays.map(r => r.templateId), ["C", "D"]);
  assert.equal(p.dayInfo[MON].status, "done");
  // 過去日は候補にならない
  assert.ok(p.recommendedDays.every(r => r.date >= WED));
});

test("planner: 夜の飲み会は低優先(他に空きがあれば避ける)", () => {
  // 木曜夜に会食。残り1回、木・金が空き → 金を選ぶ
  const p = generateWeeklyTrainingPlan({ ...base, targetSessions: 1,
    events: { [THU]: [{ title: "会食", startMin: 19 * 60, endMin: 21 * 60 }] },
    manualOverrides: { [MON]: "blocked", [TUE]: "blocked", [SAT]: "blocked", [SUN]: "blocked" } });
  assert.equal(p.recommendedDays.length, 1);
  assert.equal(p.recommendedDays[0].date, FRI);
  // hard blockではないので、他に空きがなければ選ばれる
  const p2 = generateWeeklyTrainingPlan({ ...base, targetSessions: 1,
    events: { [THU]: [{ title: "会食", startMin: 19 * 60, endMin: 21 * 60 }] },
    manualOverrides: { [MON]: "blocked", [TUE]: "blocked", [FRI]: "blocked", [SAT]: "blocked", [SUN]: "blocked" } });
  assert.equal(p2.recommendedDays[0].date, THU);
});

test("planner: 3連続日を可能なら避ける", () => {
  // 月火木金土日空き(水block)、4回 → 月火木金 or 月火金土等。木金土の3連続を含む案より
  // 分散した案が選ばれる(3連続run無し)
  const p = generateWeeklyTrainingPlan({ ...base });
  const idx = p.recommendedDays.map(r => DATES.indexOf(r.date));
  let run = 1, maxRun = 1;
  for (let i = 1; i < idx.length; i++) {
    run = idx[i] === idx[i - 1] + 1 ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 2, "3連続を避ける: " + JSON.stringify(p.recommendedDays));
});

test("planner: 目標達成済みなら追加提案しない", () => {
  const p = generateWeeklyTrainingPlan({ ...base, targetSessions: 2,
    completedSessions: [{ date: MON, templateId: "A" }, { date: TUE, templateId: "B" }] });
  assert.equal(p.recommendedDays.length, 0);
  assert.ok(p.reasons.some(r => r.includes("達成済み")));
});

// ── Phase 3 hardening: 完了済み↔提案の境界に回復制約 ─────────────────────────
import { normalizeEvent } from "../js/training-plan.mjs";

test("recovery: completed D(木) → next A(金)を可能なら避ける", () => {
  // 木曜D完了、残り1回。金・土・日が空き → 金(D翌日)を避けて土以降にA
  const p = generateWeeklyTrainingPlan({ ...base, nextWorkout: "A", targetSessions: 4,
    todayKey: FRI,
    completedSessions: [
      { date: MON, templateId: "B" }, { date: TUE, templateId: "C" },
      { date: THU, templateId: "D" }],
  });
  assert.equal(p.recommendedDays.length, 1);
  assert.equal(p.recommendedDays[0].templateId, "A");
  assert.ok(p.recommendedDays[0].date >= SAT,
    "D(木)翌日の金Aを避ける: " + JSON.stringify(p.recommendedDays));
});

test("recovery: completed Mon/Tue → 水曜availableでも3連続を可能なら避ける", () => {
  // 月火完了、水は手動available、木金も空き → 3連続になる水を避けて木以降を選ぶ
  const p = generateWeeklyTrainingPlan({ ...base, nextWorkout: "C", targetSessions: 3,
    todayKey: WED,
    manualOverrides: { [WED]: "available" },
    completedSessions: [
      { date: MON, templateId: "A" }, { date: TUE, templateId: "B" }],
  });
  assert.equal(p.recommendedDays.length, 1);
  assert.ok(p.recommendedDays[0].date !== WED,
    "月火完了後の水は3連続: " + JSON.stringify(p.recommendedDays));
});

test("recovery: 他に候補がなければsoft penaltyとして許容する", () => {
  // 木曜D完了、金曜しか空きがない → 制約はsoftなので金曜Aを許容
  const p = generateWeeklyTrainingPlan({ ...base, nextWorkout: "A", targetSessions: 4,
    todayKey: FRI,
    manualOverrides: { [SAT]: "blocked", [SUN]: "blocked" },
    completedSessions: [
      { date: MON, templateId: "B" }, { date: TUE, templateId: "C" },
      { date: THU, templateId: "D" }],
  });
  assert.equal(p.recommendedDays.length, 1);
  assert.equal(p.recommendedDays[0].date, FRI);
  assert.equal(p.recommendedDays[0].templateId, "A");
});

// ── イベント正規化(overnight / ISO日時) ──────────────────────────────────────
test("normalizeEvent: overnight(22:00→06:00)のdurationが正しく8時間になる", () => {
  const e = normalizeEvent({ title: "当直", startMin: 22 * 60, endMin: 6 * 60 });
  assert.equal(e.durMin, 8 * 60);
});

test("normalizeEvent: ISO start/end形式(日マタギ)も扱える", () => {
  const e = normalizeEvent({ title: "夜勤",
    start: new Date(2026, 7, 27, 21, 0).toISOString(),
    end: new Date(2026, 7, 28, 7, 0).toISOString() });
  assert.equal(e.startMin, 21 * 60);
  assert.equal(e.durMin, 10 * 60);
});

test("normalizeEvent: 長時間overnightイベントが減点対象になる", () => {
  // 木曜21:00〜翌7:00の(hardに該当しない)予定 → 長時間減点で他の日が優先される
  const p = generateWeeklyTrainingPlan({ ...base, targetSessions: 1,
    events: { [THU]: [{ title: "録画作業",
      start: new Date(2026, 7, 27, 21, 0).toISOString(),
      end: new Date(2026, 7, 28, 7, 0).toISOString() }] },
    manualOverrides: { [MON]: "blocked", [TUE]: "blocked", [SAT]: "blocked", [SUN]: "blocked" } });
  assert.equal(p.recommendedDays[0].date, FRI);
});

// ── Phase 4: Google Calendar → 派生情報マッピング ────────────────────────────
import { mapGcalEvents, classOf } from "../js/training-plan.mjs";

test("mapGcalEvents: タイトルを出力に残さない(派生clsのみ)", () => {
  const out = mapGcalEvents([
    { summary: "当直", start: { dateTime: new Date(2026, 7, 26, 17, 0).toISOString() },
      end: { dateTime: new Date(2026, 7, 27, 9, 0).toISOString() } },
  ], DATES);
  const ev = out[WED][0];
  assert.equal(ev.cls, "hard");
  assert.ok(!("title" in ev) && !("summary" in ev), "タイトルを保持しない");
  assert.equal(ev.durMin, 16 * 60);              // overnight duration
});

test("mapGcalEvents: 全日イベントはclsのみ(長時間減点なし)・週外は捨てる", () => {
  const out = mapGcalEvents([
    { summary: "学会", start: { date: THU }, end: { date: FRI } },
    { summary: "学会", start: { date: "2026-09-10" } },          // 週外
    { summary: "メモ", start: { date: TUE } },                    // 分類なし全日→捨てる
    { summary: "会食", status: "cancelled",
      start: { dateTime: new Date(2026, 7, 25, 19, 0).toISOString() } }, // キャンセル
  ], DATES);
  assert.equal(out[THU].length, 1);
  assert.equal(out[THU][0].cls, "medium");
  assert.equal(out[THU][0].durMin, undefined);
  assert.equal(out["2026-09-10"], undefined);
  assert.equal(out[TUE], undefined);
  assert.equal(out[MON], undefined);
});

test("planner: 事前分類cls(hard)のイベントでその日がblockされる", () => {
  const p = generateWeeklyTrainingPlan({ ...base,
    events: { [THU]: [{ cls: "hard", startMin: 17 * 60, durMin: 16 * 60 }] } });
  assert.equal(p.dayInfo[THU].status, "blocked");
  assert.ok(!p.recommendedDays.some(r => r.date === THU));
});

test("planner: 事前分類cls(soft夜)は減点として効く", () => {
  const p = generateWeeklyTrainingPlan({ ...base, targetSessions: 1,
    events: { [THU]: [{ cls: "soft", startMin: 19 * 60, durMin: 120 }] },
    manualOverrides: { [MON]: "blocked", [TUE]: "blocked", [SAT]: "blocked", [SUN]: "blocked" } });
  assert.equal(p.recommendedDays[0].date, FRI);
});

test("classOf: clsがあればタイトル分類より優先", () => {
  assert.equal(classOf({ cls: "hard", title: "会食" }), "hard");
  assert.equal(classOf({ title: "会食" }), "soft");
});
