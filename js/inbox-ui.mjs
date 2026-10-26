// inbox-ui.mjs — AI受け取り箱の取り込み(設定画面・起動時の自動取り込み)。ロジックは js/inbox-core.mjs。
// Neuro Learn の自動同期と同じく、起動時とアプリに戻ってきた時に Apps Script へ取りに行く。
// 英語は既存の「英語学習」(wt_records の english)に、タスクは今日タブの「大きなタスク」に入れる。
// tracker.html の通常スクリプトにある records / getWeekKey / persist / render などを使う。
import * as I from "./inbox-core.mjs";
import * as T from "./todo-core.mjs";
import { keyOfDate } from "./habit-core.mjs";

const $ = id => document.getElementById(id);
const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => {
  localStorage.setItem(k, JSON.stringify(v));
  window.dispatchEvent(new CustomEvent("weekly:local-saved", { detail: { key: k } }));
};
const loadInbox = () => I.normalize(read(I.KEY));
const saveInbox = s => localStorage.setItem(I.KEY, JSON.stringify(s));

async function call(conf, params) {
  const q = new URLSearchParams({ key: conf.key, ...params });
  const res = await fetch(`${conf.url}?${q}`, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function dateObj(key) { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); }

// 届いた行を記録する。戻り値: {english, tasks}(記録した件数)
function apply(p, today) {
  const before = snapshotLevels();
  let gained = 0;
  p.english.forEach(e => {
    const d = dateObj(e.date), wk = getWeekKey(d), dk = DAY_KEYS[(d.getDay() + 6) % 7];
    records[wk] = records[wk] || {}; records[wk][dk] = records[wk][dk] || {};
    const prev = records[wk][dk].english;
    const next = I.mergeEnglish(prev, e);
    gained += xpForRecord(next) - xpForRecord(prev);
    records[wk][dk].english = next;
  });
  if (p.english.length) persist();
  if (p.tasks.length) {
    let todo = T.normalizeTodo(read(T.KEY), today);
    p.tasks.forEach(t => { todo = T.saveTask(todo, t.task, today); });
    write(T.KEY, todo);
  }
  if (p.english.length || p.tasks.length) {
    render();
    const msg = [p.english.length ? `英語学習 ${p.english.length}件` : "", p.tasks.length ? `タスク ${p.tasks.length}件` : ""].filter(Boolean).join("・");
    showToast(`🤖 AI受け取り箱から ${msg} を記録しました`);
    if (gained > 0) checkLevelUp(before, gained);
  }
  return { english: p.english.length, tasks: p.tasks.length };
}

let busy = false, last = 0;
// 戻り値: {english, tasks, skipped} / 未設定・1分以内なら null / 失敗・取り込み中なら throw
export async function syncInbox(force) {
  const st = loadInbox();
  if (!st.url || !st.key) return null;
  if (busy) throw new Error("取り込み中です。少し待ってからもう一度");
  if (!force && Date.now() - last < 60000) return null; // 1分以内の再実行はスキップ
  busy = true;
  try {
    const data = await call(st, {});
    last = Date.now();
    const today = keyOfDate(new Date());
    const p = I.plan(data.items, st, today);
    const done = apply(p, today);
    // 記録してから覚える。取り込み済みの印が付けられなくても、次回は二重に入らない
    saveInbox(I.remember(loadInbox(), [...p.english, ...p.tasks].map(x => x.id), today));
    if (p.ack.length) await call(st, { ack: p.ack.join(",") }).catch(() => {});
    return { ...done, skipped: p.skipped.length };
  } finally {
    busy = false;
  }
}

const quiet = () => syncInbox().catch(() => {});
quiet();
document.addEventListener("visibilitychange", () => { if (!document.hidden) quiet(); });
window.addEventListener("pageshow", e => { if (e.persisted) quiet(); });

// ── 設定(接続コード = /exec のURL|合い言葉) ──
const status = msg => { $("inbox-status").textContent = msg; };
const modal = $("inbox-modal");
$("inbox-open").onclick = () => {
  $("menu-modal").style.display = "none";
  const st = loadInbox();
  $("inbox-code").value = st.url && st.key ? `${st.url}|${st.key}` : "";
  status(st.url && st.key ? "✅ 接続中：開くたびにAI受け取り箱から取り込みます" : "");
  modal.style.display = "flex";
};
$("inbox-close").onclick = () => { modal.style.display = "none"; };
modal.addEventListener("click", e => { if (e.target === e.currentTarget) modal.style.display = "none"; });
$("inbox-save").onclick = async () => {
  const raw = $("inbox-code").value.trim();
  if (!raw) {
    saveInbox({ ...loadInbox(), url: "", key: "" });
    status("接続を解除しました");
    return;
  }
  const conf = I.parseConnection(raw);
  if (!conf) { status("❌ 形式が違います。Apps Scriptの /exec のURLと合い言葉を「|」でつないで貼ってください"); return; }
  status("接続中…");
  try {
    await call(conf, {});
    saveInbox({ ...loadInbox(), ...conf });
    const r = await syncInbox(true);
    status(`✅ 接続できました（いま記録したもの: 英語 ${r.english}件・タスク ${r.tasks}件${r.skipped ? `・読めない行 ${r.skipped}件はNotionに残しました` : ""}）`);
  } catch (err) {
    status("❌ 接続失敗: " + (err.message || "") + "（URL・合い言葉・Apps Scriptのデプロイ設定を確認してください）");
  }
};
$("inbox-now").onclick = async () => {
  try {
    const r = await syncInbox(true);
    if (!r) status("先に接続コードを保存してください");
    else if (!r.english && !r.tasks) status(`新しい記録はありませんでした${r.skipped ? `（読めない行 ${r.skipped}件はNotionに残っています）` : ""}`);
    else status(`✅ 英語 ${r.english}件・タスク ${r.tasks}件を記録しました`);
  } catch (err) {
    status("❌ 取り込めませんでした: " + (err.message || ""));
  }
};
