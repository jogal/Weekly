// 宅トレ(サイドクエスト)の画面。gym.html の きろく タブと履歴から呼ばれる。
// gym.html のグローバル(el, esc, numField, sheetHeader, openSheet, showToast, render)を使う。
import * as HW from "./home-workout-core.mjs";

let selEx = null, value = null, weight = null, showWeight = false;
const UI_KEY = "gym_home_ui_v1";   // {open: bool}。カードを開いたままにするか

function load() {
  try { return HW.normalize(JSON.parse(localStorage.getItem(HW.KEY) || "null")); }
  catch { return HW.normalize(null); }
}
function save(state) { localStorage.setItem(HW.KEY, JSON.stringify(state)); }
const today = () => HW.dayKeyOf(new Date());
function isOpen(state) {
  try { const v = JSON.parse(localStorage.getItem(UI_KEY) || "null"); if (typeof v?.open === "boolean") return v.open; } catch {}
  return HW.logsOn(state, today()).length > 0;   // 未設定なら、今日やっていれば開く
}
function setOpen(open) { try { localStorage.setItem(UI_KEY, JSON.stringify({ open })); } catch {} }

function current(state) {
  const list = HW.exercises(state);
  const ex = list.find(e => e.name === selEx) || HW.exercisesByRecent(state)[0];
  selEx = ex.name;
  if (value == null) value = HW.lastValue(state, ex.name) ?? (ex.unit === "sec" ? 30 : 10);
  if (weight == null) weight = HW.lastWeight(state, ex.name);
  return ex;
}
function pick(state, name) {
  selEx = name;
  value = weight = null;
  showWeight = false;
  current(state);
}
// ダンベル種目・重量を使ったことがある種目だけ重量を出す
function usesWeight(state, ex) {
  return !!ex.db || state.logs.some(l => l.ex === ex.name && l.kg) || showWeight || !!weight?.kg;
}

function renderCard(root) {
  const state = load(), open = isOpen(state);
  const todays = HW.logsOn(state, today());
  const cleared = todays.length > 0;
  const card = el("section", "card home-card" + (open ? " open" : ""));
  card.id = "home-quest";
  card.setAttribute("aria-label", "サイドクエスト 宅トレ");
  // 見出しタップで開閉(状態は覚えておく)
  const head = el("button", "home-head",
    `<span class="card-title">SIDE QUEST / 宅トレ</span><span class="home-status${cleared ? " cleared" : ""}">${cleared ? `HOME CLEAR +${HW.DAY_GOLD}G` : `1回で +${HW.DAY_GOLD}G`}<i aria-hidden="true">${open ? "▾" : "▸"}</i></span>`);
  head.type = "button";
  head.setAttribute("aria-expanded", String(open));
  head.onclick = () => { setOpen(!open); render(); };
  card.appendChild(head);
  if (!open) { root.appendChild(card); return; }

  // 種目は折り返して全部見せる(最近やった順)。タップで記録シート
  const chips = el("div", "home-chips");
  HW.exercisesByRecent(state).forEach(e => {
    const done = todays.some(l => l.ex === e.name);
    const b = el("button", "home-chip" + (done ? " done" : ""), `${done ? "✓ " : ""}${esc(e.name)}`);
    b.type = "button";
    b.setAttribute("aria-label", `宅トレ ${e.name}${done ? "（今日済み）" : ""}`);
    b.onclick = () => { pick(load(), e.name); openSheet("home"); };
    chips.appendChild(b);
  });
  const add = el("button", "home-chip add", "＋");
  add.type = "button";
  add.setAttribute("aria-label", "宅トレの種目を追加");
  add.onclick = () => {
    const name = prompt("宅トレの種目名");
    if (!name || !name.trim()) return;
    if (HW.exercises(state).some(e => e.name === name.trim())) { showToast("もうあるよ"); return; }
    const sec = confirm("秒で数える種目？\n（OK＝秒 / キャンセル＝回数）");
    const next = HW.addExercise(state, name, sec ? "sec" : "reps");
    save(next); pick(next, name.trim()); openSheet("home");
  };
  chips.appendChild(add);
  card.appendChild(chips);

  // 今日の記録(表示だけ。取り消しはシートから)
  if (todays.length) {
    const list = el("div", "home-list");
    HW.groupLogs(todays).forEach(r => {
      const line = el("div", "home-sum");
      line.appendChild(el("span", "home-sum-name", `${esc(r.ex)}${r.w ? `<span class="home-sum-w">${esc(r.w)}</span>` : ""}`));
      line.appendChild(el("span", "home-sum-sets", `${r.sets.map(x => x.n).join(" · ")}<small>${HW.UNITS[r.unit]}</small>`));
      list.appendChild(line);
    });
    card.appendChild(list);
  }
  root.appendChild(card);
}

// 宅トレの記録シート(gym.html の記録シートの中身)
function renderSheet(box) {
  const state = load(), ex = current(state);
  const list = HW.exercises(state), idx = list.findIndex(e => e.name === ex.name);
  const go = d => { pick(state, list[(idx + d + list.length) % list.length].name); render(); };
  sheetHeader(box, { title: esc(ex.name), sub: "宅トレ", prev: () => go(-1), next: () => go(1) });
  const card = el("div", "sheet-card home-sheet");
  const unit = HW.UNITS[ex.unit];

  if (usesWeight(state, ex)) {
    const seg = el("div", "home-weights");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "重量");
    HW.WEIGHTS.forEach(w => {
      const on = (weight.kg || 0) === w.kg && (weight.x || 0) === w.x;
      const b = el("button", "home-weight" + (on ? " on" : ""), w.x ? `${w.kg}kg<small>×${w.x}</small>` : w.label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", `重量 ${w.label}`);
      b.onclick = () => { weight = { kg: w.kg, x: w.x }; render(); };
      seg.appendChild(b);
    });
    card.appendChild(seg);
  } else {
    const w = el("button", "home-add-weight", "＋ 重量（ダンベル）");
    w.type = "button";
    w.onclick = () => { showWeight = true; render(); };
    card.appendChild(w);
  }

  const field = numField({ label: unit === "秒" ? "秒数" : "回数", aria: `${unit}数を入力`, unit, get: () => value,
    set: v => { value = v; }, step: ex.unit === "sec" ? 5 : 1, min: 1, max: 9999 });
  field.el.classList.add("reps");
  card.appendChild(field.el);

  const log = el("button", "home-log-btn", "🏠 記録する");
  log.type = "button";
  log.setAttribute("aria-label", "宅トレを記録");
  log.onclick = () => {
    const first = !HW.logsOn(load(), today()).length;
    const w = weight.kg ? weight : null, t = new Date().toISOString();
    save(HW.addLog(load(), ex.name, value, ex.unit, t, w));
    const wl = HW.weightLabel(w);
    const undo = { label: "取り消す", fn: () => { save(HW.removeLog(load(), t)); render(); } };
    showToast(first ? `🏠 HOME CLEAR　+${HW.DAY_GOLD}G` : `🏠 ${ex.name}${wl ? " " + wl : ""} ${value}${unit}`, undo);
    render();
  };
  card.appendChild(log);

  // この種目の今日のセット(タップで取り消し)
  const sets = el("div", "sheet-sets");
  const mine = HW.logsOn(state, today()).filter(l => l.ex === ex.name);
  if (mine.length) mine.forEach((l, i) => {
    const b = el("button", "sheet-set home", `<i>${i + 1}</i>${esc(HW.formatLog(l))}`);
    b.type = "button";
    b.setAttribute("aria-label", `${ex.name} ${HW.formatLog(l)}の記録を取り消す`);
    b.onclick = () => { if (confirm(`${ex.name} ${HW.formatLog(l)} を取り消す?`)) { save(HW.removeLog(load(), l.t)); render(); } };
    sets.appendChild(b);
  });
  else sets.appendChild(el("span", "sheet-empty", "まだ記録なし"));
  card.appendChild(sets);
  box.appendChild(card);
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
  renderSheet,
  historyByDay,
  homeDays: () => HW.homeDays(load()),
  exportData: () => { const v = localStorage.getItem(HW.KEY); return v === null ? {} : { [HW.KEY]: load() }; },
  importData: d => { if (d && d[HW.KEY] && typeof d[HW.KEY] === "object") save(HW.normalize(d[HW.KEY])); },
};
if (typeof tab !== "undefined" && (tab === "today" || tab === "history")) render();
