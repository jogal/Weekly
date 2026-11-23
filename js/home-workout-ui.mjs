// 宅トレ(サイドクエスト)の画面。gym.html の きろく タブと履歴から呼ばれる。
// gym.html のグローバル(el, esc, stepBtn, showToast, fmtTime, render)を使う。
import * as HW from "./home-workout-core.mjs";

let selEx = null, value = null, weight = null, open = false;

function load() {
  try { return HW.normalize(JSON.parse(localStorage.getItem(HW.KEY) || "null")); }
  catch { return HW.normalize(null); }
}
function save(state) { localStorage.setItem(HW.KEY, JSON.stringify(state)); }
const today = () => HW.dayKeyOf(new Date());

function current(state) {
  const list = HW.exercisesByRecent(state);
  const ex = list.find(e => e.name === selEx) || list[0];
  selEx = ex.name;
  if (value == null) value = HW.lastValue(state, ex.name) ?? (ex.unit === "sec" ? 30 : 10);
  if (weight == null) weight = HW.lastWeight(state, ex.name);
  return ex;
}
function pick(state, name) {
  selEx = name;
  value = weight = null;
  current(state);
}

function renderCard(root) {
  const state = load(), ex = current(state);
  const todays = HW.logsOn(state, today());
  const cleared = todays.length > 0;
  const card = el("section", "card home-card" + (open ? " open" : ""));
  card.id = "home-quest";
  card.setAttribute("aria-label", "サイドクエスト 宅トレ");
  // 見出しをタップで開閉。閉じているときは1行だけ
  const head = el("button", "home-head",
    `<span class="card-title">SIDE QUEST / 宅トレ</span><span class="home-status${cleared ? " cleared" : ""}">${cleared ? `HOME CLEAR +${HW.DAY_GOLD}G` : `1回で +${HW.DAY_GOLD}G`}<i aria-hidden="true">${open ? "▾" : "▸"}</i></span>`);
  head.type = "button";
  head.setAttribute("aria-expanded", String(open));
  head.onclick = () => { open = !open; render(); };
  card.appendChild(head);
  if (!open) { root.appendChild(card); return; }

  const chips = el("div", "home-chips");
  HW.exercisesByRecent(state).forEach(e => {
    const done = todays.some(l => l.ex === e.name);
    const b = el("button", "home-chip" + (e.name === ex.name ? " active" : "") + (done ? " done" : ""),
      `${done ? "✓ " : ""}${esc(e.name)}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(e.name === ex.name));
    b.setAttribute("aria-label", `宅トレ ${e.name}${done ? "（今日済み）" : ""}`);
    b.onclick = () => { pick(state, e.name); render(); };
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
    save(next); pick(next, name.trim()); render();
  };
  chips.appendChild(add);
  card.appendChild(chips);
  // 選んだチップが見える位置へ(横スクロール)
  requestAnimationFrame(() => {
    const a = chips.querySelector(".home-chip.active");
    if (a) chips.scrollLeft = Math.max(0, a.offsetLeft - chips.offsetLeft - 8);
  });

  // 重量: 自重 / 5kg×1 / 5kg×2
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

  const unit = HW.UNITS[ex.unit];
  const step = ex.unit === "sec" ? 5 : 1;
  const row = el("div", "stepper-row");
  const val = el("button", "step-val");
  val.setAttribute("aria-label", `${unit}数を入力`);
  const upd = () => { val.innerHTML = `${value} <small>${unit}</small>`; };
  const minus = stepBtn("−", "", () => { value = Math.max(1, value - step); upd(); });
  const plus = stepBtn("＋", "", () => { value = Math.min(9999, value + step); upd(); });
  minus.setAttribute("aria-label", `${step}${unit}減らす`);
  plus.setAttribute("aria-label", `${step}${unit}増やす`);
  row.appendChild(minus);
  row.appendChild(val);
  row.appendChild(plus);
  val.onclick = () => {
    const v = prompt(`${ex.name}（${unit}）`, String(value));
    if (v === null) return;
    const n = parseInt(v, 10);
    if (n >= 1) { value = Math.min(9999, n); upd(); }
  };
  upd();
  card.appendChild(row);

  const log = el("button", "home-log-btn", "🏠 記録");
  log.type = "button";
  log.setAttribute("aria-label", "宅トレを記録");
  log.onclick = () => {
    const first = !HW.logsOn(load(), today()).length;
    const w = weight.kg ? weight : null;
    save(HW.addLog(load(), ex.name, value, ex.unit, new Date().toISOString(), w));
    const wl = HW.weightLabel(w);
    showToast(first ? `🏠 HOME CLEAR　+${HW.DAY_GOLD}G` : `🏠 ${ex.name}${wl ? " " + wl : ""} ${value}${unit}`);
    render();
  };
  card.appendChild(log);

  // 今日の記録: 種目ごとに1行。数字をタップで取り消し
  if (todays.length) {
    const list = el("div", "home-list");
    HW.groupLogs(todays).forEach(r => {
      const line = el("div", "home-sum");
      line.appendChild(el("span", "home-sum-name", `${esc(r.ex)}${r.w ? `<span class="home-sum-w">${esc(r.w)}</span>` : ""}`));
      const nums = el("span", "home-sum-sets");
      r.sets.forEach((s, i) => {
        if (i) nums.appendChild(el("i", "", "·"));
        const b = el("button", "home-sum-n", String(s.n));
        b.type = "button";
        b.setAttribute("aria-label", `${r.ex} ${s.n}${HW.UNITS[r.unit]}の記録を取り消す`);
        b.onclick = () => {
          if (confirm(`${r.ex} ${s.n}${HW.UNITS[r.unit]} の記録を取り消す?`)) { save(HW.removeLog(load(), s.t)); render(); }
        };
        nums.appendChild(b);
      });
      nums.appendChild(el("small", "", HW.UNITS[r.unit]));
      line.appendChild(nums);
      list.appendChild(line);
    });
    list.appendChild(el("p", "home-hint", "数字をタップで取り消し"));
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
