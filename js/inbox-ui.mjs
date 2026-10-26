// inbox-ui.mjs — AI受け取り箱の取り込み(設定画面・起動時の自動取り込み)。ロジックは js/inbox-core.mjs。
// Neuro Learn の自動同期と同じく、起動時とアプリに戻ってきた時に Apps Script へ取りに行く。
// 英語は既存の「英語学習」(wt_records の english)に、タスクは今日タブの「大きなタスク」に入れる。
// tracker.html の通常スクリプトにある records / getWeekKey / persist / render などを使う。
import * as I from "./inbox-core.mjs";
import * as T from "./todo-core.mjs";
import * as C from "./task-consolidation.mjs";
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
    // Normalize only new imports, never strip fields from existing source tasks
    // before consolidation has checked the current raw data.
    let todo = read(T.KEY);
    if (todo === null) todo = T.normalizeTodo(null, today);
    if (!Array.isArray(todo.tasks) || !Array.isArray(todo.routines) || !todo.rlog || typeof todo.rlog !== "object") {
      throw new Error("端末のタスクデータを確認できません");
    }
    p.tasks.forEach(t => {
      // Stable inbox task IDs also survive a crash before saving the seen cache.
      // Never upsert a replay: user edits/progress must remain intact.
      if (!todo.tasks.some(existing => existing.id === t.task.id)) todo = { ...todo, tasks: [...todo.tasks, T.normalizeTask(t.task, today)] };
    });
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

// A stale task edit draft could otherwise recreate a removed source when saved.
function editingTasks() {
  return [...document.querySelectorAll(".overlay")].some(o => o.id !== "inbox-modal" && getComputedStyle(o).display !== "none")
    || (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") && !document.activeElement.closest("#inbox-modal"))
    || !!document.querySelector("input[data-backup-pick]");
}

// Old open tabs cannot answer a new-page handshake. The current service worker
// can see both controlled and uncontrolled clients, including old v84 pages.
function soleUpdatedClient() {
  return new Promise(resolve => {
    const controller = globalThis.navigator?.serviceWorker?.controller;
    if (!controller || typeof MessageChannel === "undefined") { resolve(false); return; }
    const channel = new MessageChannel();
    const finish = ok => { clearTimeout(timer); channel.port1.close(); resolve(ok); };
    const timer = setTimeout(() => finish(false), 2000);
    channel.port1.onmessage = event => finish(event.data?.type === "weekly:consolidation-preflight"
      && event.data.version === 1 && event.data.soleClient === true);
    try { controller.postMessage({ type: "weekly:consolidation-preflight", version: 1 }, [channel.port2]); }
    catch { finish(false); }
  });
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
    const p = I.plan(data.items, st, today, read(T.KEY));
    const done = apply(p, today);
    // 記録してから覚える。取り込み済みの印が付けられなくても、次回は二重に入らない
    saveInbox(I.remember(loadInbox(), [...p.english, ...p.tasks].map(x => x.id), today));
    let consolidated = 0;
    const blocked = [], mergedIds = [];
    const clientReady = p.consolidations.length ? await soleUpdatedClient() : true;
    for (const item of p.consolidations) {
      if (!clientReady) { blocked.push("ほかの週クエ画面を閉じ、最新版のアプリを1つだけ開いて再試行してください（更新確認できない場合も保留します）"); continue; }
      // Check after all awaits, against the current editor and current data.
      if (editingTasks()) { blocked.push("編集中の画面を閉じてから統合を取り込んでください"); continue; }
      try {
        const result = C.applyConsolidation(localStorage, item, today);
        if (result.status === "blocked") { blocked.push(result.reason); continue; }
        mergedIds.push(item.id);
        if (result.status === "applied") {
          consolidated++;
          window.dispatchEvent(new CustomEvent("weekly:local-saved", { detail: { key: T.KEY } }));
        }
      } catch (err) {
        blocked.push("統合を保存できませんでした: " + (err.message || ""));
      }
    }
    if (consolidated) {
      render();
      showToast("🤖 指定されたタスクを1つにまとめました（元データも保存済み）");
    }
    if (mergedIds.length) saveInbox(I.remember(loadInbox(), mergedIds, today));
    const ack = [...p.ack, ...mergedIds];
    if (ack.length) await call(st, { ack: ack.join(",") }).catch(() => {});
    if (blocked.length) showToast("🤖 タスク統合は保留しました。AI受け取り箱で理由を確認できます");
    return { ...done, consolidated, skipped: p.skipped.length + blocked.length, blocked };
  } finally {
    busy = false;
  }
}

const quiet = () => syncInbox().then(r => { if (r?.blocked.length) status("統合保留: " + r.blocked.join(" / ")); }).catch(() => {});
quiet();
document.addEventListener("visibilitychange", () => { if (!document.hidden) quiet(); });
window.addEventListener("pageshow", e => { if (e.persisted) quiet(); });

// ── 設定(接続コード = /exec のURL|合い言葉) ──
let lastStatus = "";
const status = msg => { lastStatus = msg; $("inbox-status").textContent = msg; };
const resultStatus = r => `英語 ${r.english}件・タスク ${r.tasks}件${r.consolidated ? `・統合 ${r.consolidated}件` : ""}`
  + (r.blocked.length ? `。統合保留: ${r.blocked.join(" / ")}` : r.skipped ? `・読めない行 ${r.skipped}件はNotionに残しました` : "");
const modal = $("inbox-modal");
$("inbox-open").onclick = () => {
  $("menu-modal").style.display = "none";
  const st = loadInbox();
  $("inbox-code").value = st.url && st.key ? `${st.url}|${st.key}` : "";
  status(lastStatus || (st.url && st.key ? "✅ 接続中：開くたびにAI受け取り箱から取り込みます" : ""));
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
    status(`✅ 接続できました（いま記録したもの: ${resultStatus(r)}）`);
  } catch (err) {
    status("❌ 接続失敗: " + (err.message || "") + "（URL・合い言葉・Apps Scriptのデプロイ設定を確認してください）");
  }
};
$("inbox-now").onclick = async () => {
  try {
    const r = await syncInbox(true);
    if (!r) status("先に接続コードを保存してください");
    else if (!r.english && !r.tasks && !r.consolidated && !r.skipped) status("新しい記録はありませんでした");
    else status(`✅ ${resultStatus(r)}`);
  } catch (err) {
    status("❌ 取り込めませんでした: " + (err.message || ""));
  }
};
