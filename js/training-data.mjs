// training-data.mjs — v2データ層。既存キー(gym_logs等)には一切書かない。
// 新キーはすべてversion付き。読み込みは常にdefaultへフォールバックし、
// 旧データが無くても壊れない(additive / 後方互換最優先)。

import { nextTemplateId, lastCompletedTemplateIdFrom, localDayKey,
         monkStateFromRecords } from "./training-core.mjs";

export const K = {
  profile:   "gym_profile_v2",
  sessions:  "gym_sessions_v2",
  program:   "gym_program_v2",
  daily:     "gym_daily_v2",
  weeklyPlan:"gym_weekly_plan_v2",
  overrides: "gym_schedule_overrides_v2",
  aiCache:   "gym_ai_cache_v1",
};

const rd = (k, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; }
  catch { return fallback; }
};
const wr = (k, v) => localStorage.setItem(k, JSON.stringify(v));

// ── Profile ───────────────────────────────────────────────────────────────────
export const DEFAULT_PROFILE = {
  heightCm: 159,
  currentWeightKg: 54,
  targetWeightKg: 57,
  proteinTargetG: 105,
  // 「週4を必達」ではなく、1日休んで次へ進むのを基本にする。
  // 週の境界次第で3〜4回になるため、新規ユーザーの標準は3回。
  weeklyWorkoutTarget: 3,
  defaultWednesdayBlocked: true,
  aiEndpoint: "",     // 例 https://<proj>.vercel.app/api/coach (任意)
  aiToken: "",        // サーバのCOACH_TOKENに対応(任意)
};
export function loadProfile() { return { ...DEFAULT_PROFILE, ...rd(K.profile, {}) }; }
export function saveProfile(p) { wr(K.profile, p); }

// ── Program (repeatable Main Quest) ───────────────────────────────────────────
// A/B/C/Dを全部回す設計をやめ、今続いている「胸＋背中」を反復する。
// optional=true は余力がある日の追加クエスト。未実施でもWorkout完了を妨げない。
// 既存のユーザー編集済みprogramは勝手に上書きしない。
// 旧デフォルトA/B/C/Dのままの端末だけ、初回load時に新標準へ移行する。
export const PROGRAM_VERSION = 4;

const LEGACY_DEFAULT_SIGNATURE = [
  "A|ベンチプレス:4:6:10|インクラインダンベルプレス:3:8:12|ケーブルフライ:3:10:15|サイドレイズ:4:12:20|トライセプスプレスダウン:3:8:15",
  "B|ラットプルダウン:4:6:12|チェストサポーテッドロウ:3:8:12|ケーブルロウ:3:8:12|リアレイズ:3:12:20|アームカール:3:8:12|ハンマーカール:2:10:15",
  "C|スクワット:4:6:10|ルーマニアンデッドリフト:3:6:10|ブルガリアンスクワット:3:8:12|レッグカール:3:10:15|カーフレイズ:4:10:20|ケーブルクランチ:3:8:15",
  "D|インクラインダンベルプレス:3:6:10|マシンチェストプレス:3:8:12|ローハイケーブルフライ:2:10:15|サイドレイズ:4:12:20|リアレイズ:3:12:20|オーバーヘッドエクステンション:3:10:15|アームカール:3:8:12",
];

function programSignature(p) {
  if (!p || !Array.isArray(p.templates)) return [];
  return p.templates.map(t =>
    [t.id, ...(t.exercises || []).map(e => `${e.ex}:${e.sets}:${e.repMin}:${e.repMax}`)].join("|")
  );
}
function isUntouchedLegacyDefault(p) {
  return JSON.stringify(p?.cycle || []) === JSON.stringify(["A", "B", "C", "D"]) &&
    JSON.stringify(programSignature(p)) === JSON.stringify(LEGACY_DEFAULT_SIGNATURE);
}

function isV3RepeatDefault(p) {
  if (p?.programVersion !== 3 || p?.mode !== "repeat" || !Array.isArray(p.templates) || p.templates.length !== 1) return false;
  const t = p.templates[0];
  const names = (t.exercises || []).map(e => e.ex);
  return t.id === "MAIN" &&
    JSON.stringify(names) === JSON.stringify([
      "ベンチプレス", "懸垂", "インクラインダンベルプレス", "チェストサポーテッドロウ",
      "ケーブルフライ", "サイドレイズ", "レッグプレス"
    ]);
}

export const DEFAULT_TEMPLATES = [
  {
    id: "MAIN",
    name: "Main Quest",
    focus: "胸＋背中 / 3 of 5",
    minExercises: 3,
    exercises: [
      // 実際に続いている順番をそのまま標準化。5種目すべて必須にはしない。
      { ex: "懸垂",                       slot: "MAIN2", part: "back",     sets: 3, repMin: 5,  repMax: 10 },
      { ex: "ベンチプレス",               slot: "A1",    part: "chest",    sets: 4, repMin: 6,  repMax: 10 },
      { ex: "リアデルト",                 slot: "MAIN3", part: "shoulder", sets: 3, repMin: 10, repMax: 15 },
      { ex: "インクラインダンベルプレス", slot: "A2",    part: "chest",    sets: 3, repMin: 8,  repMax: 12 },
      { ex: "ラットプルダウン",           slot: "B1",    part: "back",     sets: 3, repMin: 8,  repMax: 12 },
    ],
  },
];

// DEFAULT_TEMPLATESは絶対にmutateさせない: fallback/resetは必ずdeep cloneを返す
const deepClone = o => (typeof structuredClone === "function"
  ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
export function cloneDefaultTemplates() { return deepClone(DEFAULT_TEMPLATES); }
export function defaultProgram() {
  return {
    programVersion: PROGRAM_VERSION,
    mode: "repeat",
    templates: cloneDefaultTemplates(),
    cycle: ["MAIN"],
  };
}

export function loadProgram() {
  const p = rd(K.program, null);
  if (p && Array.isArray(p.templates) && p.templates.length) {
    if ((!p.programVersion && isUntouchedLegacyDefault(p)) || isV3RepeatDefault(p)) {
      const migrated = defaultProgram();
      wr(K.program, migrated);
      return migrated;
    }
    return p;
  }
  return defaultProgram();
}
export function saveProgram(p) {
  wr(K.program, { ...p, programVersion: p?.programVersion || PROGRAM_VERSION });
}
export function templateById(program, id) {
  return program.templates.find(t => t.id === id) || program.templates[0];
}

// ── Sessions ─────────────────────────────────────────────────────────────────
// { id, date:"YYYY-MM-DD", templateId, startedAt, completedAt, status, difficulty, curEx }
// status: "active" | "completed" | "aborted"   difficulty: "easy"|"good"|"hard"|null
export function loadSessions() { return rd(K.sessions, []); }
export function saveSessions(s) { wr(K.sessions, s); }
export function activeSession() {
  return loadSessions().find(s => s.status === "active") || null;
}
export function lastCompletedTemplateId() {
  return lastCompletedTemplateIdFrom(loadSessions());
}
export function nextWorkoutTemplateId(program) {
  return nextTemplateId(lastCompletedTemplateId(), program.cycle);
}
export function startSession(templateId) {
  const sessions = loadSessions();
  // 二重開始防止: 既存activeがあればそれを返す
  const act = sessions.find(s => s.status === "active");
  if (act) return act;
  const now = new Date();
  // Monkリワードのdelta計算用snapshot(XPの二重管理ではない。source of truthは
  // wt_recordsのまま)。既存記録・同日2回目・decayがあっても正確な差分が出せる
  let rewardBaseline = null;
  try {
    const records = JSON.parse(localStorage.getItem("wt_records") || "{}");
    const st = monkStateFromRecords(records, localDayKey(now));
    rewardBaseline = { rawXP: st.rawXP, displayXP: st.xp, lvl: st.lvl };
  } catch (e) { /* baselineはoptional */ }
  const s = {
    id: "ws_" + now.getTime(),
    date: localDayKey(now),
    rewardBaseline,
    templateId,
    startedAt: now.toISOString(),
    completedAt: null,
    status: "active",
    difficulty: null,
    curEx: 0,
  };
  sessions.push(s); saveSessions(sessions);
  return s;
}
export function updateSession(id, patch) {
  const sessions = loadSessions();
  const s = sessions.find(x => x.id === id);
  if (!s) return null;
  Object.assign(s, patch); saveSessions(sessions);
  return s;
}
export function finishSession(id, difficulty) {
  return updateSession(id, {
    status: "completed", difficulty: difficulty || null,
    completedAt: new Date().toISOString(),
  });
}
export function abortSession(id) {
  return updateSession(id, { status: "aborted", completedAt: new Date().toISOString() });
}
// 自由記録からの達成: その日に完了sessionがまだ無ければ、source:"free" の
// completed sessionを1つだけ作る(サイクル・プランはこれで進む)。1日1回まで
export function ensureFreeSession(templateId, dateKey) {
  const sessions = loadSessions();
  if (sessions.some(s => s.date === dateKey && s.status === "completed")) return false;
  const now = new Date();
  sessions.push({
    id: "free_" + now.getTime(), date: dateKey, templateId,
    startedAt: now.toISOString(), completedAt: now.toISOString(),
    status: "completed", difficulty: null, curEx: 0, source: "free",
  });
  saveSessions(sessions);
  return true;
}

// ── Daily check-in(体重・タンパク質のみ) ─────────────────────────────────────
export function loadDaily() { return rd(K.daily, {}); }
// patchの値がnull/undefinedならそのフィールドを削除(誤記録の取り消し)。
// 全フィールドが消えたらその日のエントリ自体を消す
export function saveDailyEntry(dateKey, patch) {
  const d = rd(K.daily, {});
  const cur = { ...(d[dateKey] || {}) };
  Object.entries(patch).forEach(([k, v]) => {
    if (v === null || v === undefined) delete cur[k]; else cur[k] = v;
  });
  if (Object.keys(cur).length) d[dateKey] = cur; else delete d[dateKey];
  wr(K.daily, d);
  return d;
}

// Optional effort, attached to the exact last set. Other daily fields survive.
export function saveExerciseFeedback(day, exercise, lastSetAt, effort) {
  const feedback = { ...(loadDaily()[day]?.exerciseFeedback || {}) };
  if (["easy", "good", "hard"].includes(effort)) feedback[exercise] = { lastSetAt, effort };
  else delete feedback[exercise];
  return saveDailyEntry(day, { exerciseFeedback: Object.keys(feedback).length ? feedback : null });
}

// ── Weekly plan / manual overrides ───────────────────────────────────────────
// overrides: {dateKey: "available"|"maybe"|"blocked"}。保存時に2週間より古いkeyを整理
export function loadOverrides() { return rd(K.overrides, {}); }
export function saveOverrides(o) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14);
  const cut = localDayKey(cutoff);
  const pruned = {};
  Object.keys(o).forEach(k => { if (k >= cut) pruned[k] = o[k]; });
  wr(K.overrides, pruned);
}
export function loadWeeklyPlan() { return rd(K.weeklyPlan, null); }
export function saveWeeklyPlan(p) { wr(K.weeklyPlan, p); }

// ── AI Coach cache(応答のみ・入力payloadは保存しない) ────────────────────────
export function loadAiCache() { return rd(K.aiCache, null); }
export function saveAiCache(c) { wr(K.aiCache, c); }

// ── Export/Import 用 ─────────────────────────────────────────────────────────
export function exportV2() {
  const out = {};
  Object.values(K).forEach(k => {
    if (k === K.aiCache) return;                 // AI応答キャッシュはbackup対象外
    const v = localStorage.getItem(k);
    if (v !== null) { try { out[k] = JSON.parse(v); } catch { /* skip broken */ } }
  });
  // credentialはbackupへ出さない(aiEndpointは残す)
  if (out[K.profile] && typeof out[K.profile] === "object") {
    out[K.profile] = { ...out[K.profile] };
    delete out[K.profile].aiToken;
  }
  return out;
}
export function importV2(data) {
  Object.values(K).forEach(k => {
    if (!data || data[k] === undefined) return;
    if (k === K.aiCache) return;                 // キャッシュは復元しない
    if (k === K.profile && data[k] && typeof data[k] === "object") {
      // 旧backupにaiTokenが含まれていても自動的にcredentialを復元しない。
      // 現在の端末のaiTokenは維持する
      const incoming = { ...data[k] };
      delete incoming.aiToken;
      const current = rd(K.profile, {});
      wr(k, { ...incoming, ...(current.aiToken ? { aiToken: current.aiToken } : {}) });
      return;
    }
    wr(k, data[k]);
  });
}
