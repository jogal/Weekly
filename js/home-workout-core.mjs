// 宅トレ(サイドクエスト)。ジムのMain Quest(gym_logs)とは別に記録し、クリア判定・部位・
// 「今週のトレーニング回数」には混ぜない。ゴールドは宅トレをした日に1回だけ(tracker の settle が日ごとに数え直す)。
export const KEY = "gym_home_v1";
export const DAY_GOLD = 5;
export const UNITS = { reps: "回", sec: "秒" };
// 家のダンベル(5kg×2本)。重量は「自重 / 5kg×1 / 5kg×2」の3択
export const DUMBBELL_KG = 5;
export const WEIGHTS = [
  { id: "bw", kg: 0, x: 0, label: "自重" },
  { id: "d1", kg: DUMBBELL_KG, x: 1, label: `${DUMBBELL_KG}kg×1` },
  { id: "d2", kg: DUMBBELL_KG, x: 2, label: `${DUMBBELL_KG}kg×2` },
];
// db: ダンベルを使う種目の初期重量(1=1本, 2=2本)。記録したあとは前回の重量を使う
export const DEFAULT_EXERCISES = [
  { name: "腕立て伏せ", unit: "reps" },
  { name: "スクワット", unit: "reps" },
  { name: "プランク", unit: "sec" },
  { name: "腹筋", unit: "reps" },
  { name: "ランジ", unit: "reps" },
  { name: "背筋", unit: "reps" },
  { name: "ダンベルカール", unit: "reps", db: 2 },
  { name: "ダンベルショルダープレス", unit: "reps", db: 2 },
  { name: "ダンベルロウ", unit: "reps", db: 1 },
  { name: "サイドレイズ", unit: "reps", db: 2 },
  { name: "ゴブレットスクワット", unit: "reps", db: 1 },
];
const MAX_NAME = 30, MAX_VALUE = 9999, MAX_KG = 100;

const pad = n => String(n).padStart(2, "0");
export function dayKeyOf(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const cleanName = s => String(s ?? "").trim().slice(0, MAX_NAME);
const cleanUnit = u => (u === "sec" ? "sec" : "reps");
const cleanValue = v => Math.min(MAX_VALUE, Math.max(1, Math.round(Number(v) || 0)));

// 重量は1本あたりkg(kg)と本数(x)。自重(昔の記録も)はどちらも持たない
function cleanWeight(w) {
  const kg = Math.round(Number(w?.kg) * 10) / 10, x = Number(w?.x);
  return kg > 0 && kg <= MAX_KG && (x === 1 || x === 2) ? { kg, x } : {};
}

export function normalize(raw) {
  const custom = [];
  (Array.isArray(raw?.custom) ? raw.custom : []).forEach(e => {
    const name = cleanName(e?.name);
    if (name && !DEFAULT_EXERCISES.some(d => d.name === name) && !custom.some(c => c.name === name))
      custom.push({ name, unit: cleanUnit(e.unit) });
  });
  const logs = (Array.isArray(raw?.logs) ? raw.logs : [])
    .filter(l => l && typeof l.t === "string" && !isNaN(Date.parse(l.t)) && cleanName(l.ex) && Number(l.n) > 0)
    .map(l => ({ t: l.t, ex: cleanName(l.ex), n: cleanValue(l.n), unit: cleanUnit(l.unit), ...cleanWeight(l) }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return { v: 1, logs, custom };
}

export function exercises(state) { return [...DEFAULT_EXERCISES, ...state.custom]; }

// チップの並び: 最近やった種目が先、まだの種目は元の順
export function exercisesByRecent(state) {
  const last = {};
  state.logs.forEach(l => { last[l.ex] = l.t; });
  return exercises(state).map((e, i) => ({ e, i, t: last[e.name] || "" }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t < b.t ? 1 : -1)).map(r => r.e);
}

export function addExercise(state, name, unit) {
  const n = cleanName(name);
  if (!n || exercises(state).some(e => e.name === n)) return state;
  return { ...state, custom: [...state.custom, { name: n, unit: cleanUnit(unit) }] };
}

export function addLog(state, ex, n, unit, t = new Date().toISOString(), weight = null) {
  const name = cleanName(ex);
  if (!name || !(Number(n) > 0)) return state;
  return normalize({ ...state, logs: [...state.logs, { t, ex: name, n, unit, ...cleanWeight(weight) }] });
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

// 種目の重量: 前回の記録 → ダンベル種目の初期値 → 自重
export function lastWeight(state, ex) {
  for (let i = state.logs.length - 1; i >= 0; i--) {
    const l = state.logs[i];
    if (l.ex === ex) return l.kg ? { kg: l.kg, x: l.x } : { kg: 0, x: 0 };
  }
  const d = exercises(state).find(e => e.name === ex)?.db;
  return d ? { kg: DUMBBELL_KG, x: d } : { kg: 0, x: 0 };
}

export function weightLabel(l) { return l?.kg ? `${l.kg}kg×${l.x}` : ""; }

export function formatLog(l) { return `${weightLabel(l) ? weightLabel(l) + " " : ""}${l.n}${UNITS[l.unit] || "回"}`; }

// 今日のまとめ: 種目+重量ごとに1行(最初にやった順)。sets は {t, n}
export function groupLogs(logs) {
  const rows = [];
  logs.forEach(l => {
    const w = weightLabel(l);
    let r = rows.find(x => x.ex === l.ex && x.w === w);
    if (!r) rows.push(r = { ex: l.ex, w, unit: l.unit, sets: [] });
    r.sets.push({ t: l.t, n: l.n });
  });
  return rows;
}

// habit-core の settle に足す、その日の宅トレのゴールド。何種目・何セットやっても1日1回
export function dayGoldItems(state, day) {
  const sets = logsOn(state, day).length;
  return sets ? { "home:workout": { g: DAY_GOLD, sets } } : {};
}
