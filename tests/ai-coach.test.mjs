// node --test tests/ai-coach.test.mjs (依存なし・node:test)
process.env.TZ = "Asia/Tokyo";

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildCoachPayload, validateCoachResponse, coachFingerprint, requestCoach }
  from "../js/ai-coach.mjs";

const require = createRequire(import.meta.url);
const handler = require("../api/coach.js");

const VALID_ADVICE = {
  headline: "ベンチは順調",
  workoutAdvice: "次回も50kgで計29回以上を狙う。",
  exerciseAdvice: [{ exercise: "ベンチプレス", advice: "前回+2repを目標に。" }],
  nutritionAdvice: null,
  caution: null,
};

// ── クライアント側validate ────────────────────────────────────────────────────
test("validate: 正しいschemaを受理", () => {
  assert.equal(validateCoachResponse(VALID_ADVICE), true);
  assert.equal(validateCoachResponse({ ...VALID_ADVICE, nutritionAdvice: "タンパク質は良好" }), true);
});

test("validate: 欠落・型違いを拒否", () => {
  assert.equal(validateCoachResponse(null), false);
  assert.equal(validateCoachResponse({}), false);
  assert.equal(validateCoachResponse({ ...VALID_ADVICE, headline: 42 }), false);
  assert.equal(validateCoachResponse({ ...VALID_ADVICE, exerciseAdvice: "str" }), false);
  assert.equal(validateCoachResponse({ ...VALID_ADVICE,
    exerciseAdvice: [{ exercise: "x" }] }), false);          // advice欠落
  assert.equal(validateCoachResponse({ ...VALID_ADVICE, caution: 1 }), false);
});

// ── payload組み立て(タイトル非包含・派生情報のみ) ────────────────────────────
test("payload: dayConstraintsは派生文字列のみでGCal生タイトルは構造上入らない", () => {
  const p = buildCoachPayload({
    profile: { heightCm: 159, targetWeightKg: 57 },
    latestWeight: 54.4,
    weightTrend: { status: "ok", avg7: 54.3, perWeek: 0.11 },
    protein: { avg7: 98, recordedDays: 5, daysAtLeast90: 4, todayG: 93, targetG: 105 },
    recentSessions: [{ date: "2026-08-24", templateId: "A", difficulty: "good",
      exercises: [{ ex: "ベンチプレス", sets: [{ kg: 50, reps: 8 }] }] }],
    nextWorkout: { templateId: "B", name: "Workout B", focus: "背中・二頭" },
    nextTargets: [{ exercise: "ラットプルダウン", status: "progress_reps",
      weightKg: 40, targetTotalReps: 30 }],
    weeklyPlan: { recommendedDays: [], reasons: ["水曜: 当直/勤務ブロック"] },
    dayConstraints: ["2026-08-26: blocked(当直/勤務ブロック)"],
    painFlags: ["A1"],
  });
  const s = JSON.stringify(p);
  assert.ok(s.includes("blocked(当直/勤務ブロック)"));       // 派生ラベルはOK
  assert.equal(p.goal.currentWeightKg, 54.4);                // latestWeightKgが使われる
  assert.deepEqual(p.goal.priorityMuscles.slice(0, 3),
    ["三角筋側部", "上胸", "上腕三頭筋"]);
  // fingerprintは決定論的
  assert.equal(coachFingerprint(p), coachFingerprint(JSON.parse(s)));
});

// ── サーバhandler(モックres/fetch) ───────────────────────────────────────────
function mockRes() {
  const r = { headers: {}, statusCode: null, body: null, ended: false };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.statusCode = c; return r; };
  r.json = o => { r.body = o; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}

test("api: POST以外は405 / OPTIONSは204", async () => {
  const r1 = mockRes();
  await handler({ method: "GET", headers: {} }, r1);
  assert.equal(r1.statusCode, 405);
  const r2 = mockRes();
  await handler({ method: "OPTIONS", headers: {} }, r2);
  assert.equal(r2.statusCode, 204);
});

test("api: OPENAI_API_KEY未設定は500", async () => {
  delete process.env.OPENAI_API_KEY;
  const r = mockRes();
  await handler({ method: "POST", headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 500);
});

test("api: COACH_TOKEN設定時はBearer必須(不一致は401)", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.COACH_TOKEN = "secret";
  const r = mockRes();
  await handler({ method: "POST", headers: { authorization: "Bearer wrong" }, body: {} }, r);
  assert.equal(r.statusCode, 401);
  delete process.env.COACH_TOKEN;
});

test("api: 正常系はvalidateして{advice}を返す", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    // Structured Outputsのschema指定が入っていること
    const body = JSON.parse(opts.body);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    return { ok: true, json: async () => ({ output_text: JSON.stringify(VALID_ADVICE) }) };
  };
  const r = mockRes();
  await handler({ method: "POST", headers: {}, body: { goal: {} } }, r);
  global.fetch = origFetch;
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.advice, VALID_ADVICE);
});

test("api: モデル出力がschema不一致なら502(そのまま返さない)", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true,
    json: async () => ({ output_text: JSON.stringify({ headline: "だけ" }) }) });
  const r = mockRes();
  await handler({ method: "POST", headers: {}, body: { goal: {} } }, r);
  global.fetch = origFetch;
  assert.equal(r.statusCode, 502);
});

test("api: message形式のoutputからも抽出できる", () => {
  const t = handler.extractOutputText({ output: [
    { type: "reasoning" },
    { type: "message", content: [{ type: "output_text", text: "{\"a\":1}" }] },
  ]});
  assert.equal(t, "{\"a\":1}");
});

// ── requestCoach(クライアント・モックfetch) ──────────────────────────────────
test("client: requestCoachは不正応答をthrowする", async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ advice: { headline: "x" } }) });
  await assert.rejects(() => requestCoach("https://x/api/coach", {}, null), /invalid/);
  global.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => requestCoach("https://x/api/coach", {}, null), /401/);
  global.fetch = origFetch;
});
