// training-data.mjs — v2データ層。既存キー(gym_logs等)には一切書かない。
// 新キーはすべてversion付き。読み込みは常にdefaultへフォールバックし、
// 旧データが無くても壊れない(additive / 後方互換最優先)。

import { nextTemplateId, lastCompletedTemplateIdFrom, localDayKey } from "./training-core.mjs";

export const K = {
  profile:   "gym_profile_v2",
  sessions:  "gym_sessions_v2",
  program:   "gym_program_v2",
  daily:     "gym_daily_v2",
  weeklyPlan:"gym_weekly_plan_v2",
  overrides: "gym_schedule_overrides_v2",
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
  weeklyWorkoutTarget: 4,
  defaultWednesdayBlocked: true,
};
export function loadProfile() { return { ...DEFAULT_PROFILE, ...rd(K.profile, {}) }; }
export function saveProfile(p) { wr(K.profile, p); }

// ── Program (A/B/C/D templates) ──────────────────────────────────────────────
// 種目名は既存gym.htmlの種目と同名にして gym_last / gym_logs の履歴と接続する。
// part は既存の部位ID(chest/back/shoulder/arm/leg/core) = wt_records の workout_<part>。
export const DEFAULT_TEMPLATES = [
  { id: "A", name: "Workout A", focus: "胸・肩・三頭", exercises: [
    { ex: "ベンチプレス",             slot: "A1", part: "chest",    sets: 4, repMin: 6,  repMax: 10 },
    { ex: "インクラインダンベルプレス", slot: "A2", part: "chest",    sets: 3, repMin: 8,  repMax: 12 },
    { ex: "ケーブルフライ",           slot: "A3", part: "chest",    sets: 3, repMin: 10, repMax: 15 },
    { ex: "サイドレイズ",             slot: "A4", part: "shoulder", sets: 4, repMin: 12, repMax: 20 },
    { ex: "トライセプスプレスダウン",   slot: "A5", part: "arm",      sets: 3, repMin: 8,  repMax: 15 },
  ]},
  { id: "B", name: "Workout B", focus: "背中・二頭", exercises: [
    { ex: "ラットプルダウン",         slot: "B1", part: "back",     sets: 4, repMin: 6,  repMax: 12 },
    { ex: "チェストサポーテッドロウ",   slot: "B2", part: "back",     sets: 3, repMin: 8,  repMax: 12 },
    { ex: "ケーブルロウ",             slot: "B3", part: "back",     sets: 3, repMin: 8,  repMax: 12 },
    { ex: "リアレイズ",               slot: "B4", part: "shoulder", sets: 3, repMin: 12, repMax: 20 },
    { ex: "アームカール",             slot: "B5", part: "arm",      sets: 3, repMin: 8,  repMax: 12 },
    { ex: "ハンマーカール",           slot: "B6", part: "arm",      sets: 2, repMin: 10, repMax: 15 },
  ]},
  { id: "C", name: "Workout C", focus: "脚・腹", exercises: [
    { ex: "スクワット",               slot: "C1", part: "leg",      sets: 4, repMin: 6,  repMax: 10 },
    { ex: "ルーマニアンデッドリフト",   slot: "C2", part: "leg",      sets: 3, repMin: 6,  repMax: 10 },
    { ex: "ブルガリアンスクワット",     slot: "C3", part: "leg",      sets: 3, repMin: 8,  repMax: 12 },
    { ex: "レッグカール",             slot: "C4", part: "leg",      sets: 3, repMin: 10, repMax: 15 },
    { ex: "カーフレイズ",             slot: "C5", part: "leg",      sets: 4, repMin: 10, repMax: 20 },
    { ex: "ケーブルクランチ",         slot: "C6", part: "core",     sets: 3, repMin: 8,  repMax: 15 },
  ]},
  { id: "D", name: "Workout D", focus: "上胸・肩・腕", exercises: [
    { ex: "インクラインダンベルプレス", slot: "D1", part: "chest",    sets: 3, repMin: 6,  repMax: 10 },
    { ex: "マシンチェストプレス",       slot: "D2", part: "chest",    sets: 3, repMin: 8,  repMax: 12 },
    { ex: "ローハイケーブルフライ",     slot: "D3", part: "chest",    sets: 2, repMin: 10, repMax: 15 },
    { ex: "サイドレイズ",             slot: "D4", part: "shoulder", sets: 4, repMin: 12, repMax: 20 },
    { ex: "リアレイズ",               slot: "D5", part: "shoulder", sets: 3, repMin: 12, repMax: 20 },
    { ex: "オーバーヘッドエクステンション", slot: "D6", part: "arm",  sets: 3, repMin: 10, repMax: 15 },
    { ex: "アームカール",             slot: "D7", part: "arm",      sets: 3, repMin: 8,  repMax: 12 },
  ]},
];

export function loadProgram() {
  const p = rd(K.program, null);
  if (p && Array.isArray(p.templates) && p.templates.length) return p;
  return { templates: DEFAULT_TEMPLATES, cycle: ["A", "B", "C", "D"] };
}
export function saveProgram(p) { wr(K.program, p); }
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
  const s = {
    id: "ws_" + now.getTime(),
    date: localDayKey(now),
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

// ── Daily check-in(体重・タンパク質のみ) ─────────────────────────────────────
export function loadDaily() { return rd(K.daily, {}); }
export function saveDailyEntry(dateKey, patch) {
  const d = rd(K.daily, {});
  d[dateKey] = { ...(d[dateKey] || {}), ...patch };
  wr(K.daily, d);
  return d;
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

// ── Export/Import 用 ─────────────────────────────────────────────────────────
export function exportV2() {
  const out = {};
  Object.values(K).forEach(k => {
    const v = localStorage.getItem(k);
    if (v !== null) { try { out[k] = JSON.parse(v); } catch { /* skip broken */ } }
  });
  return out;
}
export function importV2(data) {
  Object.values(K).forEach(k => {
    if (data && data[k] !== undefined) wr(k, data[k]);
  });
}
