// node --test tests/training-data.test.mjs
// training-data.mjsはlocalStorage前提なので、nodeではshimを先に用意する
process.env.TZ = "Asia/Tokyo";
globalThis.localStorage = {
  _s: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
  clear() { this._s = {}; },
};

import test from "node:test";
import assert from "node:assert/strict";
const TD = await import("../js/training-data.mjs");

test("program: DEFAULT_TEMPLATESはloadProgram経由のmutationから隔離される", () => {
  localStorage.clear();
  const p = TD.loadProgram();                       // 保存なし → cloneが返る
  const origName = TD.DEFAULT_TEMPLATES[0].exercises[0].ex;
  p.templates[0].exercises[0].ex = "改変テスト";
  p.templates[0].exercises.splice(1, 1);
  Object.assign(p.templates[0].exercises[0], { sets: 99 });
  // module constantは不変
  assert.equal(TD.DEFAULT_TEMPLATES[0].exercises[0].ex, origName);
  assert.equal(TD.DEFAULT_TEMPLATES[0].exercises.length, 5);
  assert.notEqual(TD.DEFAULT_TEMPLATES[0].exercises[0].sets, 99);
  // 保存していないので次のloadProgramも綺麗なdefault
  const p2 = TD.loadProgram();
  assert.equal(p2.templates[0].exercises[0].ex, origName);
});

test("program: A1編集→reset→完全に元のA1へ戻る", () => {
  localStorage.clear();
  const p = TD.loadProgram();
  Object.assign(p.templates[0].exercises[0], { ex: "編集後", sets: 9, repMin: 1, repMax: 2 });
  TD.saveProgram(p);
  assert.equal(TD.loadProgram().templates[0].exercises[0].ex, "編集後");
  // reset(editorのデフォルトに戻す)
  TD.saveProgram({ templates: TD.cloneDefaultTemplates(), cycle: ["A", "B", "C", "D"] });
  const after = TD.loadProgram().templates[0].exercises[0];
  assert.deepEqual(after, TD.DEFAULT_TEMPLATES[0].exercises[0]);
  // resetで保存されたのもcloneであり、後続mutationがconstantへ波及しない
  const p3 = TD.loadProgram();
  p3.templates[0].exercises[0].ex = "再改変";
  TD.saveProgram(p3);
  assert.equal(TD.DEFAULT_TEMPLATES[0].exercises[0].ex, after.ex);
});

test("program: 壊れたprogram(exercises=[])でもload/templateByIdがfatalにならない", () => {
  localStorage.clear();
  localStorage.setItem("gym_program_v2", JSON.stringify({
    templates: [{ id: "A", name: "Workout A", focus: "", exercises: [] }],
    cycle: ["A"] }));
  const p = TD.loadProgram();
  assert.equal(p.templates[0].exercises.length, 0); // そのまま返す(描画側でguard)
  assert.equal(TD.templateById(p, "A").id, "A");
  assert.equal(TD.templateById(p, "Z").id, "A");    // フォールバックも安全
});

test("backup: exportはaiTokenをredactしaiCacheを含めない/importはtokenを復元しない", () => {
  localStorage.clear();
  TD.saveProfile({ ...TD.DEFAULT_PROFILE, aiEndpoint: "https://x/api/coach", aiToken: "LOCAL" });
  TD.saveAiCache({ dayKey: "2026-08-28", fp: "f", advice: null });
  const out = TD.exportV2();
  assert.equal(out.gym_profile_v2.aiToken, undefined);
  assert.equal(out.gym_profile_v2.aiEndpoint, "https://x/api/coach");
  assert.equal(out.gym_ai_cache_v1, undefined);
  TD.importV2({ gym_profile_v2: { heightCm: 160, aiToken: "EVIL" } });
  const prof = TD.loadProfile();
  assert.equal(prof.heightCm, 160);
  assert.equal(prof.aiToken, "LOCAL");              // 既存credential維持・EVILは無視
});

test("free: ensureFreeSessionは1日1回だけcompleted sessionを作る", () => {
  localStorage.clear();
  assert.equal(TD.ensureFreeSession("A", "2026-08-28"), true);
  assert.equal(TD.ensureFreeSession("A", "2026-08-28"), false);   // 同日2回目は作らない
  assert.equal(TD.ensureFreeSession("B", "2026-08-28"), false);   // 別templateでも同日は不可
  const s = TD.loadSessions();
  assert.equal(s.length, 1);
  assert.equal(s[0].status, "completed");
  assert.equal(s[0].source, "free");
  assert.equal(TD.lastCompletedTemplateId(), "A");                 // サイクルが進む
  assert.equal(TD.ensureFreeSession("B", "2026-08-29"), true);     // 翌日はOK
});
