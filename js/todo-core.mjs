// todo-core.mjs — 今日タブの「日課」と「大きなタスク」の純粋ロジック。
// DOMにもlocalStorageにも触らない。保存先は wt_todo_v1 の1つで、中身は
//   routines … 日課(歯みがき・薬など毎日の小さなこと)。連続記録の対象外でゴールドは少なめ
//   rlog     … 日課をやった日 {"YYYY-MM-DD": {routineId: 1}}
//   tasks    … 大きなタスク(期限と小さなステップ付き)。ステップ・完了した日にゴールド
// ゴールドは習慣と同じく記録から日ごとに計算し直す(habit-core の settle に dayGoldItems を渡す)。
// だからチェックを外せばゴールドも戻り、直近7日より前は確定する。HPのような罰はない。
import { addDays, mondayOf } from "./habit-core.mjs";

export const KEY = "wt_todo_v1";
export const SLOTS = [
  { id: "am", label: "朝", icon: "🌅" },
  { id: "pm", label: "昼", icon: "☀️" },
  { id: "night", label: "夜", icon: "🌙" },
  { id: "any", label: "いつでも", icon: "⏱️" },
];
export const ROUTINE_ICONS = ["🪥", "💊", "🧴", "☕", "🍳", "🧹", "🗑️", "🧺", "💧", "🛏️", "🚿", "📮"];
export const TASK_ICONS = ["📝", "📄", "🧾", "📚", "🧪", "💻", "📦", "🏥", "🎤", "✈️", "🔧", "📅"];
export const GOLD_T = {
  routine: 2,      // 日課1つ
  routineCap: 10,  // 日課で1日にもらえる上限(毎日必ずやることでゴールドが余らないように)
  step: 5,         // タスクのステップ1つ
  task: 30,        // タスクを完了した日(タスクごとに変えられる。これは初期値)
  taskMax: 9999,
};
const NAME_MAX = 40, STEP_MAX = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = v => typeof v === "string" && DATE_RE.test(v);
const clone = o => JSON.parse(JSON.stringify(o));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── 正規化 ───────────────────────────────────────────────────────────────────
export function normalizeRoutine(r, today) {
  return {
    id: String(r?.id || uid("r_")),
    name: String(r?.name || "").trim().slice(0, NAME_MAX) || "日課",
    icon: String(r?.icon || "✅").slice(0, 8),
    slot: SLOTS.some(s => s.id === r?.slot) ? r.slot : "any",
    createdOn: isDate(r?.createdOn) ? r.createdOn : today,
    ...(isDate(r?.archivedOn) ? { archivedOn: r.archivedOn } : {}),
  };
}
export function normalizeStep(st) {
  return {
    id: String(st?.id || uid("s_")),
    name: String(st?.name || "").trim().slice(0, NAME_MAX) || "ステップ",
    doneOn: isDate(st?.doneOn) ? st.doneOn : null,
  };
}
export function normalizeTask(t, today) {
  const steps = Array.isArray(t?.steps) ? t.steps.slice(0, STEP_MAX).map(normalizeStep) : [];
  return {
    id: String(t?.id || uid("t_")),
    name: String(t?.name || "").trim().slice(0, NAME_MAX) || "タスク",
    icon: String(t?.icon || "📝").slice(0, 8),
    due: isDate(t?.due) ? t.due : null,
    steps,
    createdOn: isDate(t?.createdOn) ? t.createdOn : today,
    doneOn: isDate(t?.doneOn) ? t.doneOn : null,
    reward: taskReward(t),
  };
}
// 完了したときのゴールド。未設定(古いデータ)なら初期値
export function taskReward(t) {
  const n = Math.round(Number(t?.reward));
  return Number.isFinite(n) && t?.reward !== null && t?.reward !== undefined && t?.reward !== "" ? Math.max(0, Math.min(GOLD_T.taskMax, n)) : GOLD_T.task;
}
export function normalizeTodo(raw, today) {
  const rlog = {};
  if (raw?.rlog && typeof raw.rlog === "object") {
    Object.entries(raw.rlog).forEach(([k, ids]) => {
      if (!isDate(k) || !ids || typeof ids !== "object") return;
      const day = {};
      Object.keys(ids).forEach(id => { if (ids[id]) day[id] = 1; });
      if (Object.keys(day).length) rlog[k] = day;
    });
  }
  return {
    routines: Array.isArray(raw?.routines) ? raw.routines.map(r => normalizeRoutine(r, today)) : [],
    rlog,
    tasks: Array.isArray(raw?.tasks) ? raw.tasks.map(t => normalizeTask(t, today)) : [],
  };
}

// ── 日課 ─────────────────────────────────────────────────────────────────────
// 作った日から、消した(アーカイブした)日の前日まで表示する
export function routineActiveOn(r, key) {
  if (r.createdOn && key < r.createdOn) return false;
  if (r.archivedOn && key >= r.archivedOn) return false;
  return true;
}
export function routinesOn(state, key) { return state.routines.filter(r => routineActiveOn(r, key)); }
export function isRoutineDone(state, key, id) { return !!state.rlog[key]?.[id]; }
export function toggleRoutine(state, key, id) {
  const n = clone(state);
  const day = n.rlog[key] || {};
  if (day[id]) delete day[id]; else day[id] = 1;
  if (Object.keys(day).length) n.rlog[key] = day; else delete n.rlog[key];
  return n;
}
export function saveRoutine(state, routine, today) {
  const n = clone(state), r = normalizeRoutine(routine, today);
  const i = n.routines.findIndex(x => x.id === r.id);
  if (i >= 0) n.routines[i] = r; else n.routines.push(r);
  return n;
}
// 消しても過去の記録とゴールドは残す(今日やっていれば明日から、まだなら今日から表示しない)
export function archiveRoutine(state, id, today) {
  const n = clone(state);
  const r = n.routines.find(x => x.id === id);
  if (r) {
    // 今日作ったばかりなら記録ごと取り除く
    if (r.createdOn >= today && !Object.values(n.rlog).some(d => d[id])) n.routines = n.routines.filter(x => x.id !== id);
    else r.archivedOn = n.rlog[today]?.[id] ? addDays(today, 1) : today;
  }
  return n;
}
export function routineCount(state, key) {
  const list = routinesOn(state, key);
  return { done: list.filter(r => isRoutineDone(state, key, r.id)).length, total: list.length };
}

// 連続達成(見るだけ。ゴールドやメダルは付けない)。今日まだなら昨日までで数える
export function routineStreak(state, id, today) {
  const r = state.routines.find(x => x.id === id);
  if (!r) return 0;
  let k = isRoutineDone(state, today, id) ? today : addDays(today, -1), n = 0;
  while (routineActiveOn(r, k) && isRoutineDone(state, k, id)) { n++; k = addDays(k, -1); }
  return n;
}
export function routineBestStreak(state, id) {
  const r = state.routines.find(x => x.id === id);
  if (!r) return 0;
  const days = Object.keys(state.rlog).filter(k => state.rlog[k][id] && routineActiveOn(r, k)).sort();
  let best = 0, run = 0, prev = null;
  days.forEach(k => { run = prev && addDays(prev, 1) === k ? run + 1 : 1; best = Math.max(best, run); prev = k; });
  return best;
}
// 直近 n 日(表示していた日だけ)のうちやった割合
export function routineRate(state, id, today, n = 30) {
  const r = state.routines.find(x => x.id === id);
  if (!r) return { done: 0, total: 0 };
  let done = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const k = addDays(today, -i);
    if (!routineActiveOn(r, k)) continue;
    total++; if (isRoutineDone(state, k, id)) done++;
  }
  return { done, total };
}
// 週ごとのカレンダー: 新しい週が上。各日は done / miss / off(表示していない日) / future
export function routineWeeks(state, id, today, weeks = 8) {
  const r = state.routines.find(x => x.id === id);
  const mon = mondayOf(today);
  return Array.from({ length: weeks }, (_, w) => {
    const m = addDays(mon, -7 * w);
    return { monday: m, days: Array.from({ length: 7 }, (_, d) => {
      const k = addDays(m, d);
      const st = k > today ? "future" : !r || !routineActiveOn(r, k) ? "off" : isRoutineDone(state, k, id) ? "done" : "miss";
      return { key: k, state: st };
    }) };
  });
}

// ── タスク ───────────────────────────────────────────────────────────────────
export function openTasks(state) {
  return state.tasks.filter(t => !t.doneOn).sort((a, b) =>
    (a.due || "9999").localeCompare(b.due || "9999") || a.createdOn.localeCompare(b.createdOn));
}
export function doneTasks(state) {
  return state.tasks.filter(t => t.doneOn).sort((a, b) => b.doneOn.localeCompare(a.doneOn));
}
export function taskProgress(t) {
  return { done: t.steps.filter(s => s.doneOn).length, total: t.steps.length };
}
// 期限の表示: 残り日数(期限切れは過ぎた日数)
export function dueInfo(t, today) {
  if (!t.due) return null;
  const days = Math.round((Date.parse(t.due + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
  if (days < 0) return { days, label: `${-days}日過ぎ`, level: "over" };
  if (days === 0) return { days, label: "今日まで", level: "soon" };
  return { days, label: `あと${days}日`, level: days <= 3 ? "soon" : "ok" };
}
function updateTask(state, id, fn) {
  const n = clone(state);
  const t = n.tasks.find(x => x.id === id);
  if (t) fn(t);
  return n;
}
export function saveTask(state, task, today) {
  const n = clone(state), t = normalizeTask(task, today);
  const i = n.tasks.findIndex(x => x.id === t.id);
  if (i >= 0) n.tasks[i] = t; else n.tasks.push(t);
  return n;
}
export function deleteTask(state, id) {
  const n = clone(state);
  n.tasks = n.tasks.filter(t => t.id !== id);
  return n;
}
export function addStep(state, taskId, name) {
  const nm = String(name || "").trim();
  if (!nm) return state;
  return updateTask(state, taskId, t => { if (t.steps.length < STEP_MAX) t.steps.push(normalizeStep({ name: nm })); });
}
export function deleteStep(state, taskId, stepId) {
  return updateTask(state, taskId, t => { t.steps = t.steps.filter(s => s.id !== stepId); });
}
export function moveStep(state, taskId, stepId, dir) {
  return updateTask(state, taskId, t => {
    const i = t.steps.findIndex(s => s.id === stepId), j = i + dir;
    if (i < 0 || j < 0 || j >= t.steps.length) return;
    [t.steps[i], t.steps[j]] = [t.steps[j], t.steps[i]];
  });
}
// ステップのチェック。やった日(key)を記録する
export function toggleStep(state, taskId, stepId, key) {
  return updateTask(state, taskId, t => {
    const s = t.steps.find(x => x.id === stepId);
    if (s) s.doneOn = s.doneOn ? null : key;
  });
}
// タスクの完了/戻す。完了するときに残っているステップもその日に済ませたことにはしない
export function setTaskDone(state, taskId, key) {
  return updateTask(state, taskId, t => { t.doneOn = key || null; });
}

// ── ゴールド ─────────────────────────────────────────────────────────────────
// その日にもらえるゴールドを habit-core の day.items と同じ形 {id: {g}} で返す
export function dayGoldItems(state, key) {
  const items = {};
  const n = routinesOn(state, key).filter(r => isRoutineDone(state, key, r.id)).length;
  if (n) items["todo:routines"] = { g: Math.min(GOLD_T.routineCap, n * GOLD_T.routine), n };
  state.tasks.forEach(t => {
    const steps = t.steps.filter(s => s.doneOn === key).length;
    const g = steps * GOLD_T.step + (t.doneOn === key ? taskReward(t) : 0);
    if (g) items["todo:" + t.id] = { g };
  });
  return items;
}
