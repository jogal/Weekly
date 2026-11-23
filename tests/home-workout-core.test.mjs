import test from "node:test";
import assert from "node:assert/strict";
import * as HW from "../js/home-workout-core.mjs";
import { routeDay } from "../js/gym-quest.mjs";

const at = (day, time = "08:00") => new Date(`${day}T${time}:00`).toISOString();

test("normalize drops broken logs and duplicate exercises", () => {
  const s = HW.normalize({ logs: [{ t: "x", ex: "a", n: 1 }, { t: at("2026-11-10"), ex: "腕立て伏せ", n: 12.4, unit: "reps" }, { t: at("2026-11-10"), ex: "", n: 3 }],
    custom: [{ name: "スクワット", unit: "reps" }, { name: "バーピー", unit: "reps" }, { name: "バーピー", unit: "sec" }] });
  assert.equal(s.logs.length, 1);
  assert.equal(s.logs[0].n, 12);
  assert.deepEqual(s.custom, [{ name: "バーピー", unit: "reps" }]);
  assert.deepEqual(HW.normalize(null), { v: 1, logs: [], custom: [] });
});

test("gold is once per day no matter how many sets", () => {
  let s = HW.normalize(null);
  assert.deepEqual(HW.dayGoldItems(s, "2026-11-10"), {});
  s = HW.addLog(s, "腕立て伏せ", 15, "reps", at("2026-11-10", "07:00"));
  s = HW.addLog(s, "プランク", 60, "sec", at("2026-11-10", "07:05"));
  s = HW.addLog(s, "スクワット", 20, "reps", at("2026-11-11", "07:00"));
  assert.deepEqual(HW.dayGoldItems(s, "2026-11-10"), { "home:workout": { g: HW.DAY_GOLD, sets: 2 } });
  assert.equal(HW.dayGoldItems(s, "2026-11-11")["home:workout"].g, 5);
  s = HW.removeLog(s, at("2026-11-11", "07:00"));
  assert.deepEqual(HW.dayGoldItems(s, "2026-11-11"), {});
});

test("last value, custom exercises and formatting", () => {
  let s = HW.addExercise(HW.normalize(null), " 壁倒立 ", "sec");
  assert.ok(HW.exercises(s).some(e => e.name === "壁倒立" && e.unit === "sec"));
  assert.equal(HW.addExercise(s, "腕立て伏せ", "reps"), s);
  s = HW.addLog(s, "壁倒立", 20, "sec", at("2026-11-09"));
  s = HW.addLog(s, "壁倒立", 30, "sec", at("2026-11-10"));
  assert.equal(HW.lastValue(s, "壁倒立"), 30);
  assert.equal(HW.lastValue(s, "腹筋"), null);
  assert.equal(HW.formatLog(s.logs[1]), "30秒");
  assert.deepEqual([...HW.homeDays(s)], ["2026-11-09", "2026-11-10"]);
});

test("route shows HOME only when there is no gym record", () => {
  assert.equal(routeDay({ status: "open" }, false, true).state, "home");
  assert.equal(routeDay({ status: "open" }, true, true).state, "logged");
  assert.equal(routeDay({ status: "done" }, false, true).state, "done");
  assert.equal(routeDay({ status: "open", recommended: true }, false, false).state, "quest");
});

test("dumbbell weight: stored per set, remembered per exercise, old logs stay bodyweight", () => {
  let s = HW.normalize({ logs: [{ t: at("2026-11-10"), ex: "腕立て伏せ", n: 10, unit: "reps" }], custom: [] });
  assert.deepEqual(s.logs[0], { t: at("2026-11-10"), ex: "腕立て伏せ", n: 10, unit: "reps" });
  assert.deepEqual(HW.lastWeight(s, "腕立て伏せ"), { kg: 0, x: 0 });
  // dumbbell exercises start with the home dumbbells
  assert.deepEqual(HW.lastWeight(s, "ダンベルカール"), { kg: 5, x: 2 });
  assert.deepEqual(HW.lastWeight(s, "ゴブレットスクワット"), { kg: 5, x: 1 });
  s = HW.addLog(s, "スクワット", 15, "reps", at("2026-11-11"), { kg: 5, x: 2 });
  s = HW.addLog(s, "ダンベルカール", 12, "reps", at("2026-11-11", "08:01"), { kg: 0, x: 0 });
  assert.deepEqual(HW.lastWeight(s, "スクワット"), { kg: 5, x: 2 });
  assert.deepEqual(HW.lastWeight(s, "ダンベルカール"), { kg: 0, x: 0 });
  assert.equal(HW.formatLog(s.logs[1]), "5kg×2 15回");
  assert.equal(HW.formatLog(s.logs[2]), "12回");
  // broken weights are dropped, valid ones survive a round trip
  const n = HW.normalize({ logs: [{ t: at("2026-11-12"), ex: "a", n: 1, kg: 5, x: 3 }, { t: at("2026-11-12", "09:00"), ex: "b", n: 1, kg: -1, x: 1 }, { t: at("2026-11-12", "10:00"), ex: "c", n: 1, kg: "5", x: 1 }] });
  assert.deepEqual(n.logs.map(l => l.kg ?? null), [null, null, 5]);
  assert.deepEqual(HW.normalize(JSON.parse(JSON.stringify(s))), s);
});

test("today summary groups by exercise and weight; chips put recent first", () => {
  let s = HW.normalize(null);
  s = HW.addLog(s, "腕立て伏せ", 10, "reps", at("2026-11-10", "07:00"));
  s = HW.addLog(s, "ダンベルカール", 12, "reps", at("2026-11-10", "07:01"), { kg: 5, x: 2 });
  s = HW.addLog(s, "腕立て伏せ", 12, "reps", at("2026-11-10", "07:02"));
  s = HW.addLog(s, "ダンベルカール", 15, "reps", at("2026-11-10", "07:03"), { kg: 5, x: 1 });
  const rows = HW.groupLogs(HW.logsOn(s, "2026-11-10"));
  assert.deepEqual(rows.map(r => [r.ex, r.w, r.sets.map(x => x.n)]),
    [["腕立て伏せ", "", [10, 12]], ["ダンベルカール", "5kg×2", [12]], ["ダンベルカール", "5kg×1", [15]]]);
  const order = HW.exercisesByRecent(s).map(e => e.name);
  assert.deepEqual(order.slice(0, 3), ["ダンベルカール", "腕立て伏せ", "スクワット"]);
  assert.equal(order.length, HW.exercises(s).length);
  // a custom exercise with a new default's name is not duplicated
  assert.equal(HW.normalize({ custom: [{ name: "ダンベルカール", unit: "reps" }] }).custom.length, 0);
});
