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

test("program: MAIN先頭編集→reset→完全に標準へ戻る", () => {
  localStorage.clear();
  const p = TD.loadProgram();
  Object.assign(p.templates[0].exercises[0], { ex: "編集後", sets: 9, repMin: 1, repMax: 2 });
  TD.saveProgram(p);
  assert.equal(TD.loadProgram().templates[0].exercises[0].ex, "編集後");
  // reset(editorのデフォルトに戻す)
  TD.saveProgram(TD.defaultProgram());
  const after = TD.loadProgram().templates[0].exercises[0];
  assert.deepEqual(after, TD.DEFAULT_TEMPLATES[0].exercises[0]);
  // resetで保存されたのもcloneであり、後続mutationがconstantへ波及しない
  const p3 = TD.loadProgram();
  p3.templates[0].exercises[0].ex = "再改変";
  TD.saveProgram(p3);
  assert.equal(TD.DEFAULT_TEMPLATES[0].exercises[0].ex, after.ex);
});

test("program: 旧ABCDデフォルトは新しい胸＋背中Main Questへ自動移行", () => {
  localStorage.clear();
  localStorage.setItem("gym_program_v2", JSON.stringify({
    templates: [
      { id:"A", exercises:[
        {ex:"ベンチプレス",sets:4,repMin:6,repMax:10},{ex:"インクラインダンベルプレス",sets:3,repMin:8,repMax:12},{ex:"ケーブルフライ",sets:3,repMin:10,repMax:15},{ex:"サイドレイズ",sets:4,repMin:12,repMax:20},{ex:"トライセプスプレスダウン",sets:3,repMin:8,repMax:15}]},
      { id:"B", exercises:[
        {ex:"ラットプルダウン",sets:4,repMin:6,repMax:12},{ex:"チェストサポーテッドロウ",sets:3,repMin:8,repMax:12},{ex:"ケーブルロウ",sets:3,repMin:8,repMax:12},{ex:"リアレイズ",sets:3,repMin:12,repMax:20},{ex:"アームカール",sets:3,repMin:8,repMax:12},{ex:"ハンマーカール",sets:2,repMin:10,repMax:15}]},
      { id:"C", exercises:[
        {ex:"スクワット",sets:4,repMin:6,repMax:10},{ex:"ルーマニアンデッドリフト",sets:3,repMin:6,repMax:10},{ex:"ブルガリアンスクワット",sets:3,repMin:8,repMax:12},{ex:"レッグカール",sets:3,repMin:10,repMax:15},{ex:"カーフレイズ",sets:4,repMin:10,repMax:20},{ex:"ケーブルクランチ",sets:3,repMin:8,repMax:15}]},
      { id:"D", exercises:[
        {ex:"インクラインダンベルプレス",sets:3,repMin:6,repMax:10},{ex:"マシンチェストプレス",sets:3,repMin:8,repMax:12},{ex:"ローハイケーブルフライ",sets:2,repMin:10,repMax:15},{ex:"サイドレイズ",sets:4,repMin:12,repMax:20},{ex:"リアレイズ",sets:3,repMin:12,repMax:20},{ex:"オーバーヘッドエクステンション",sets:3,repMin:10,repMax:15},{ex:"アームカール",sets:3,repMin:8,repMax:12}]},
    ],
    cycle:["A","B","C","D"],
  }));
  const p=TD.loadProgram();
  assert.equal(p.mode, "repeat");
  assert.deepEqual(p.cycle, ["MAIN"]);
  assert.equal(p.templates[0].id, "MAIN");
  assert.equal(p.templates[0].minExercises, 3);
  assert.deepEqual(p.templates[0].exercises.map(e=>e.ex),
    ["懸垂","ベンチプレス","リアデルト","インクラインダンベルプレス","ラットプルダウン"]);
});

test("program: v3の未編集Main Questは3-of-5へ自動移行", () => {
  localStorage.clear();
  localStorage.setItem("gym_program_v2", JSON.stringify({
    programVersion:3, mode:"repeat", cycle:["MAIN"],
    templates:[{id:"MAIN",exercises:[
      {ex:"ベンチプレス"},{ex:"懸垂"},{ex:"インクラインダンベルプレス"},
      {ex:"チェストサポーテッドロウ"},{ex:"ケーブルフライ"},{ex:"サイドレイズ"},{ex:"レッグプレス"}
    ]}]
  }));
  const p=TD.loadProgram();
  assert.equal(p.programVersion,4);
  assert.equal(p.templates[0].minExercises,3);
  assert.deepEqual(p.templates[0].exercises.map(e=>e.ex),
    ["懸垂","ベンチプレス","リアデルト","インクラインダンベルプレス","ラットプルダウン"]);
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

test('exercise feedback is optional, reversible and preserves logs and other daily fields',()=>{
  localStorage.clear();localStorage.setItem('gym_logs','[{"kg":50,"reps":8}]');
  TD.saveDailyEntry('2026-09-27',{weightKg:54,pain:{'ベンチプレス':true}});
  TD.saveExerciseFeedback('2026-09-27','ベンチプレス','last','easy');
  TD.saveExerciseFeedback('2026-09-27','懸垂','other','hard');
  const day=TD.loadDaily()['2026-09-27'];assert.equal(day.weightKg,54);assert.equal(day.pain['ベンチプレス'],true);
  assert.deepEqual(day.exerciseFeedback['ベンチプレス'],{lastSetAt:'last',effort:'easy'});
  TD.saveExerciseFeedback('2026-09-27','ベンチプレス','last',null);
  assert.equal(TD.loadDaily()['2026-09-27'].exerciseFeedback['懸垂'].effort,'hard');
  assert.equal(localStorage.getItem('gym_logs'),'[{"kg":50,"reps":8}]');
});
