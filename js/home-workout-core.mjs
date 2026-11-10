// 宅トレ(サイドクエスト)。ジムのMain Quest(gym_logs)とは別に記録し、クリア判定・部位・
// 「今週のトレーニング回数」には混ぜない。ゴールドは宅トレをした日に1回だけ(tracker の settle が日ごとに数え直す)。
export const KEY = "gym_home_v1";
export const DAY_GOLD = 5;
export const UNITS = { reps: "回", sec: "秒" };
export const DEFAULT_EXERCISES = [
  { name: "腕立て伏せ", unit: "reps" },
  { name: "スクワット", unit: "reps" },
  { name: "プランク", unit: "sec" },
  { name: "腹筋", unit: "reps" },
  { name: "ランジ", unit: "reps" },
  { name: "背筋", unit: "reps" },
];
const MAX_NAME = 30, MAX_VALUE = 9999;

const pad = n => String(n).padStart(2, "0");
export function dayKeyOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const cleanName = s => String(s ?? "").trim().slice(0, MAX_NAME);
const cleanUnit = u => (u === "sec" ? "sec" : "reps");
const cleanValue = v => Math.min(MAX_VALUE, Math.max(1, Math.round(Number(v) || 0)));

export function normalize(raw) {
  const custom = [];
  (Array.isArray(raw?.custom) ? raw.custom : []).forEach(e => {
    const name = cleanName(e?.name);
    if (name && !DEFAULT_EXERCISES.some(d => d.name === name) && !custom.some(c => c.name === name))
      custom.push({ name, unit: cleanUnit(e.unit) });
  });
  const logs = (Array.isArray(raw?.logs) ? raw.logs : [])
    .filter(l => l && typeof l.t === "string" && !isNaN(Date.parse(l.t)) && cleanName(l.ex) && Number(l.n) > 0)
    .map(l => ({ t: l.t, ex: cleanName(l.ex), n: cleanValue(l.n), unit: cleanUnit(l.unit) }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return { v: 1, logs, custom };
}

export function exercises(state) { return [...DEFAULT_EXERCISES, ...state.custom]; }

export function addExercise(state, name, unit) {
  const n = cleanName(name);
  if (!n || exercises(state).some(e => e.name === n)) return state;
  return { ...state, custom: [...state.custom, { name: n, unit: cleanUnit(unit) }] };
}

export function addLog(state, ex, n, unit, t = new Date().toISOString()) {
  const name = cleanName(ex);
  if (!name || !(Number(n) > 0)) return state;
  return normalize({ ...state, logs: [...state.logs, { t, ex: name, n, unit }] });
}

export function removeLog(state, t) {
  return { ...state, logs: state.logs.filter(l => l.t !== t) };
}

export function logsOn(state, day) { return state.logs.filter(l => dayKeyOf(l.t) === day); }

export function homeDays(state) { return new Set(state.logs.map(l => dayKeyOf(l.t))); }

// 前回の値(種目ごと)。なければ null
export function lastValue(state, ex) {
  for (let i = state.logs.length - 1; i >= 0; i--) if (state.logs[i].ex === ex) return state.logs[i].n;
  return null;
}

export function formatLog(l) { return `${l.n}${UNITS[l.unit] || "回"}`; }

// habit-core の settle に足す、その日の宅トレのゴールド。何種目・何セットやっても1日1回
export function dayGoldItems(state, day) {
  const sets = logsOn(state, day).length;
  return sets ? { "home:workout": { g: DAY_GOLD, sets } } : {};
}
