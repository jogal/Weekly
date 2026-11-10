// 宅トレ(サイドクエスト)の画面。gym.html の きろく タブと履歴から呼ばれる。
// gym.html のグローバル(el, esc, stepBtn, showToast, fmtTime, render)を使う。
import * as HW from "./home-workout-core.mjs";

let selEx = null, value = null;

function load() {
  try { return HW.normalize(JSON.parse(localStorage.getItem(HW.KEY) || "null")); }
  catch { return HW.normalize(null); }
}
function save(state) { localStorage.setItem(HW.KEY, JSON.stringify(state)); }
const today = () => HW.dayKeyOf(new Date());

function current(state) {
  const list = HW.exercises(state);
  const ex = list.find(e => e.name === selEx) || list[0];
  selEx = ex.name;
  if (value == null) value = HW.lastValue(state, ex.name) ?? (ex.unit === "sec" ? 30 : 10);
  return ex;
}
function pick(state, name) {
  selEx = name;
  value = null;
  current(state);
}

function renderCard(root) {
  const state = load(), ex = current(state);
  const todays = HW.logsOn(state, today());
  const card = el("section", "card home-card");
  card.id = "home-quest";
  card.setAttribute("aria-label", "サイドクエスト 宅トレ");
  const cleared = todays.length > 0;
  card.appendChild(el("div", "home-head",
    `<p class="card-title">SIDE QUEST / 宅トレ</p><span class="home-status${cleared ? " cleared" : ""}">${cleared ? `HOME CLEAR +${HW.DAY_GOLD}G` : `1回で +${HW.DAY_GOLD}G`}</span>`));
  card.appendChild(el("p", "home-note", "Main Questとは別。軽くやった日もここに残そう。"));

  const chips = el("div", "home-chips");
  HW.exercises(state).forEach(e => {
    const done = todays.some(l => l.ex === e.name);
    const b = el("button", "home-chip" + (e.name === ex.name ? " active" : "") + (done ? " done" : ""),
      `${done ? "✓ " : ""}${esc(e.name)}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(e.name === ex.name));
    b.setAttribute("aria-label", `宅トレ ${e.name}${done ? "（今日済み）" : ""}`);
    b.onclick = () => { pick(state, e.name); render(); };
    chips.appendChild(b);
  });
  const add = el("button", "home-chip add", "＋ 追加");
  add.type = "button";
  add.onclick = () => {
    const name = prompt("宅トレの種目名");
    if (!name || !name.trim()) return;
    if (HW.exercises(state).some(e => e.name === name.trim())) { showToast("もうあるよ"); return; }
    const sec = confirm("秒で数える種目？\n（OK＝秒 / キャンセル＝回数）");
    const next = HW.addExercise(state, name, sec ? "sec" : "reps");
    save(next); pick(next, name.trim()); render();
  };
  chips.appendChild(add);
  card.appendChild(chips);

  const unit = HW.UNITS[ex.unit];
  const step = ex.unit === "sec" ? 5 : 1;
  const row = el("div", "stepper-row");
  const val = el("button", "step-val");
  val.setAttribute("aria-label", `${unit}数を入力`);
  const upd = () => { val.innerHTML = `${value} <small>${unit}</small>`; };
  row.appendChild(stepBtn("-" + step, "", () => { value = Math.max(1, value - step); upd(); }));
  row.appendChild(val);
  row.appendChild(stepBtn("+" + step, "", () => { value = Math.min(9999, value + step); upd(); }));
  val.onclick = () => {
    const v = prompt(`${ex.name}（${unit}）`, String(value));
    if (v === null) return;
    const n = parseInt(v, 10);
    if (n >= 1) { value = Math.min(9999, n); upd(); }
  };
  upd();
  card.appendChild(row);

  const log = el("button", "home-log-btn", "🏠 宅トレを記録");
  log.type = "button";
  log.onclick = () => {
    const first = !HW.logsOn(load(), today()).length;
    save(HW.addLog(load(), ex.name, value, ex.unit));
    showToast(first ? `🏠 HOME CLEAR　+${HW.DAY_GOLD}G` : `🏠 ${ex.name} ${value}${unit}`);
    render();
  };
  card.appendChild(log);

  if (todays.length) {
    const list = el("div", "home-list");
    [...todays].reverse().forEach(l => {
      const r = el("div", "set-row");
      r.appendChild(el("span", "set-time", fmtTime(l.t)));
      r.appendChild(el("span", "set-main", `${esc(l.ex)} <span class="set-kg">${HW.formatLog(l)}</span>`));
      const del = el("button", "set-del", "✕");
      del.setAttribute("aria-label", `${l.ex}の記録を消す`);
      del.onclick = () => { if (confirm("この宅トレの記録を消す?")) { save(HW.removeLog(load(), l.t)); render(); } };
      r.appendChild(del);
      list.appendChild(r);
    });
    card.appendChild(list);
  }
  root.appendChild(card);
}

// 履歴(日別)に並べる宅トレ: { "YYYY-MM-DD": [{ex, sets:["10回", ...]}] }
function historyByDay() {
  const out = {};
  load().logs.forEach(l => {
    const d = HW.dayKeyOf(l.t), list = (out[d] = out[d] || []);
    let row = list.find(r => r.ex === l.ex);
    if (!row) list.push(row = { ex: l.ex, sets: [] });
    row.sets.push(HW.formatLog(l));
  });
  return out;
}

window.HomeWorkoutUI = {
  renderCard,
  historyByDay,
  homeDays: () => HW.homeDays(load()),
  exportData: () => { const v = localStorage.getItem(HW.KEY); return v === null ? {} : { [HW.KEY]: load() }; },
  importData: d => { if (d && d[HW.KEY] && typeof d[HW.KEY] === "object") save(HW.normalize(d[HW.KEY])); },
};
if (typeof tab !== "undefined" && (tab === "today" || tab === "history")) render();
