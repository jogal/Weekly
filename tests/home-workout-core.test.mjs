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
