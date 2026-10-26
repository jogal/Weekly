// inbox-core.mjs — AI受け取り箱(Notion)から届いた行を、週クエの記録に変える純粋ロジック。
// DOMにもlocalStorageにも触らない。流れは
//   Claude/ChatGPT → Notion「Weekly 受け取り箱」→ Apps Script(中継) → 週クエ
// 届く1行の形(Apps Scriptの toItem と同じ):
//   {id, kind:"英語"|"タスク", title, date:"YYYY-MM-DD"|null, minutes, questions, correct, note, steps, gold}
// AI経由の記録は手入力と同じ扱いで、AIを使った分のおまけゴールドは付けない。
import { addDays } from "./habit-core.mjs";

export const KEY = "wt_inbox_v1";           // {url, key, seen:{行id: 取り込んだ日}}。接続コードを含むので書き出しには入れない
export const MARK = "🤖";                    // 英語学習のメモに足す1行の頭
export const ENGLISH_DAYS = 30;              // 英語は今日から30日前まで受け付ける
export const TASK_GOLD_MAX = 200;            // AIが書いたごほうびの上限
const MINUTES_MAX = 600, LINE_MAX = 80, NOTE_MAX = 300, STEPS_MAX = 10, SEEN_MAX = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = v => typeof v === "string" && DATE_RE.test(v);
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = v => String(v ?? "").replace(/\s+/g, " ").trim();

export function normalize(raw) {
  const seen = {};
  if (raw?.seen && typeof raw.seen === "object") {
    Object.entries(raw.seen).forEach(([id, d]) => { if (isDate(d)) seen[id] = d; });
  }
  return { url: typeof raw?.url === "string" ? raw.url : "", key: typeof raw?.key === "string" ? raw.key : "", seen };
}

// 設定に貼る接続コード「/exec のURL|合い言葉」
export function parseConnection(text) {
  const [url = "", key = ""] = String(text || "").split("|").map(s => s.trim());
  if (!/^https:\/\/script\.google(?:usercontent)?\.com\/\S+$/.test(url) || key.length < 8) return null;
  return { url, key };
}

// 英語の1行 → {date, minutes, line}。読めなければ null(Notionに残して直してもらう)
export function englishEntry(item, today) {
  let date = isDate(item?.date) ? item.date : today;
  if (date > today) date = today;
  if (date < addDays(today, -ENGLISH_DAYS)) return null;
  const minutes = Math.max(0, Math.min(MINUTES_MAX, Math.round(num(item?.minutes) ?? 0)));
  const q = Math.max(0, Math.round(num(item?.questions) ?? 0));
  const c = Math.max(0, Math.min(q, Math.round(num(item?.correct) ?? 0)));
  if (minutes <= 0 && q <= 0) return null;
  const parts = [str(item?.title)];
  if (q > 0) parts.push(`${q}問中${c}問正解（${Math.round((c / q) * 100)}%）`);
  const note = str(item?.note);
  if (note) parts.push(note);
  const line = `${MARK} ${parts.filter(Boolean).join(" ") || "英語学習"}`.slice(0, LINE_MAX);
  return { date, minutes, line };
}

// 英語学習の1日分の記録に足す。時間は足し算、メモは1行ずつ足す(手書きのメモは消さない)
export function mergeEnglish(prev, entry) {
  const p = prev || { done: false, note: "", duration: "", rating: 0 };
  const total = Math.min(MINUTES_MAX, (parseInt(p.duration, 10) || 0) + entry.minutes);
  const note = (p.note ? `${p.note} / ${entry.line}` : entry.line).slice(0, NOTE_MAX);
  return { ...p, done: true, duration: total > 0 ? String(total) : p.duration || "", note };
}

// タスクの1行 → 大きなタスク(todo-core の saveTask に渡す形)。名前がなければ null
export function taskFrom(item, today) {
  const name = str(item?.title);
  if (!name) return null;
  const steps = String(item?.steps || "").split(/\r?\n/)
    .map(s => s.replace(/^\s*(?:[-・*•]|\d+[.)．])\s*/, "").trim()).filter(Boolean)
    .slice(0, STEPS_MAX).map(n => ({ name: n }));
  const g = num(item?.gold);
  return {
    name, icon: "📝", due: isDate(item?.date) ? item.date : null, steps, createdOn: today,
    ...(g === null ? {} : { reward: Math.max(0, Math.min(TASK_GOLD_MAX, Math.round(g))) }),
  };
}

// 届いた行を仕分ける。seen にある行は記録済み(取り込み済みの印だけ付け直す)
export function plan(items, state, today) {
  const out = { english: [], tasks: [], ack: [], skipped: [] };
  (Array.isArray(items) ? items : []).forEach(it => {
    const id = typeof it?.id === "string" ? it.id : "";
    if (!id) return;
    if (state.seen[id]) { out.ack.push(id); return; }
    const kind = str(it.kind);
    if (kind === "英語") {
      const e = englishEntry(it, today);
      if (e) { out.english.push({ id, ...e }); out.ack.push(id); return; }
    } else if (kind === "タスク") {
      const t = taskFrom(it, today);
      if (t) { out.tasks.push({ id, task: t }); out.ack.push(id); return; }
    }
    out.skipped.push(id);
  });
  return out;
}

// 記録した行を覚える。古いものから捨てて上限を守る
export function remember(state, ids, today) {
  const seen = { ...state.seen };
  ids.forEach(id => { seen[id] = seen[id] || today; });
  const keep = Object.entries(seen).sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, SEEN_MAX);
  return { ...state, seen: Object.fromEntries(keep) };
}
