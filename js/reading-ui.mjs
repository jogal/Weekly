// 読書記録の画面。ヘッダーの「本棚」から開く本棚、今日タブの読書カード、統計タブの読書まとめ。
// tracker.html とは window.ReadingUI だけでつながる(ロジックは reading-core.mjs)。
import * as R from "./reading-core.mjs";
import { SETTLE_WINDOW, addDays } from "./habit-core.mjs";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const today = () => R.keyOfDate(new Date());
const slash = k => k.replaceAll("-", "/");
const shortDate = k => { const [, m, d] = k.split("-").map(Number); return `${m}/${d}`; };
const dayName = (k, t) => (k === t ? "今日" : k === addDays(t, -1) ? "昨日" : shortDate(k));
const inGoldWindow = (k, t) => k > addDays(t, -SETTLE_WINDOW);

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(R.KEY)); } catch { raw = null; }
  return R.normalize(raw, today());
}
function save(data) { localStorage.setItem(R.KEY, JSON.stringify(data)); }
function updateBook(id, fn) {
  const data = load();
  data.books = data.books.map(b => (b.id === id ? fn(b) : b));
  save(data);
  return data.books.find(b => b.id === id);
}
// 開いているタブを描き直す(今日タブならゴールドも精算し直される)
function refresh() { if (typeof render === "function") render(); }

// ── sheet ──────────────────────────────────────────────────────────────────
let seg = "reading", logDay = null;
function sheet(build) {
  let o = document.getElementById("rd-sheet");
  if (!o) {
    o = h("div", "overlay"); o.id = "rd-sheet"; o.style.display = "none";
    o.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true"></div>';
    o.addEventListener("click", e => { if (e.target === o) closeSheet(); });
    document.body.appendChild(o);
  }
  const box = o.querySelector(".modal-box");
  const keep = o.style.display === "flex" ? box.scrollTop : 0;
  box.innerHTML = "";
  build(box);
  o.style.display = "flex";
  box.scrollTop = keep;
}
function closeSheet() {
  const o = document.getElementById("rd-sheet");
  if (o && o.style.display !== "none") { o.style.display = "none"; refresh(); }
}
function button(label, cls, onClick, attrs = {}) {
  const b = h("button", cls || "", label); b.type = "button";
  Object.entries(attrs).forEach(([k, v]) => b.setAttribute(k, v));
  b.onclick = onClick; return b;
}
function btnRow(list) { const row = h("div", "btn-row"); list.forEach(b => row.appendChild(b)); return row; }
const closeBtn = () => button("閉じる", "btn btn-secondary", closeSheet);
function bar(ratio) { return `<div class="rd-bar"><div style="width:${(ratio * 100).toFixed(1)}%"></div></div>`; }
function pageText(b, page) { return b.pages ? `p.${page} / ${b.pages}` : `p.${page}`; }
function bookSub(b) {
  const t = R.totals(b);
  if (b.status === "done") return `読了 ${esc(slash(b.finishedOn))}`;
  if (b.status === "want") return `追加 ${esc(shortDate(b.addedOn))}` + (b.pages ? ` ・ ${b.pages}ページ` : "");
  return [pageText(b, t.page), t.last ? `最後に読んだ日 ${shortDate(t.last)}` : "まだ記録がありません"].join(" ・ ");
}
function gainToast(before, after, day) {
  const g = (after?.g || 0) - (before?.g || 0);
  if (typeof showToast !== "function") return;
  if (!inGoldWindow(day, today())) showToast("📖 記録しました");
  else showToast(g > 0 ? `📖 +${g}G` : "📖 記録しました");
}

// ── 本棚(一覧) ─────────────────────────────────────────────────────────────
export function openShelf(s = seg) {
  seg = s;
  sheet(box => {
    const data = load();
    box.appendChild(h("h3", "modal-title", "📚 本棚"));
    const yr = today().slice(0, 4), yd = data.books.filter(b => b.status === "done" && b.finishedOn.startsWith(yr)).length;
    box.appendChild(h("p", "modal-sub", `これまで読了 ${data.books.filter(b => b.status === "done").length}冊 ・ ${yr}年は ${yd}冊`));
    const sg = h("div", "hb-seg");
    R.STATUSES.forEach(st => {
      const n = data.books.filter(b => b.status === st).length;
      sg.appendChild(button(`${R.STATUS_LABEL[st]} ${n}`, seg === st ? "on" : "", () => openShelf(st)));
    });
    box.appendChild(sg);
    const list = R.sortBooks(data.books, seg);
    if (!list.length) {
      box.appendChild(h("p", "hb-empty", seg === "reading" ? "読んでいる本を追加すると、今日タブで何ページまで進んだかを記録できます。"
        : seg === "want" ? "読みたい本をメモしておけます。" : "読み終えた本がここに残ります。"));
    }
    list.forEach(b => {
      const row = button("", "rd-row", () => openBook(b.id));
      const p = R.progress(b);
      row.innerHTML = `<div class="rd-main"><div class="rd-title">${esc(b.title)}</div>
        ${b.author ? `<div class="rd-author">${esc(b.author)}</div>` : ""}
        <div class="rd-sub">${bookSub(b)}</div>${p != null && b.status === "reading" ? bar(p) : ""}
        ${b.status === "done" && b.review ? `<div class="rd-review">${esc(b.review)}</div>` : ""}</div>
        <span class="rd-chev" aria-hidden="true">›</span>`;
      box.appendChild(row);
    });
    box.appendChild(btnRow([button("＋ 本を追加", "btn btn-primary", () => openEditor(null)), closeBtn()]));
  });
}

// ── 本ごとの画面: 状態・記録・感想 ──────────────────────────────────────────
export function openBook(id) {
  const t0 = today();
  if (!logDay || logDay > t0) logDay = t0;
  const draw = () => sheet(box => {
    const b = load().books.find(x => x.id === id);
    if (!b) { openShelf(); return; }
    const t = R.totals(b), p = R.progress(b);
    box.appendChild(h("div", "rd-head", `<div class="rd-title big">${esc(b.title)}</div>${b.author ? `<div class="rd-author">${esc(b.author)}</div>` : ""}`));

    const sg = h("div", "hb-seg");
    ["want", "reading", "done"].forEach(st => sg.appendChild(button(R.STATUS_LABEL[st], b.status === st ? "on" : "", () => {
      updateBook(id, x => R.setStatus(x, st, t0, t0)); draw();
    })));
    box.appendChild(sg);

    const st3 = h("div", "hb-stats3");
    st3.innerHTML = `<div><b>${t.page}${b.pages ? `<small>/${b.pages}</small>` : ""}</b><span>ページ</span></div>
      <div><b>${t.days}</b><span>読んだ日</span></div><div><b>${b.startedOn ? shortDate(b.startedOn) : "—"}</b><span>読みはじめ</span></div>`;
    box.appendChild(st3);
    if (p != null && b.status !== "done") box.insertAdjacentHTML("beforeend", bar(p));
    if (b.recordOnly) box.appendChild(h("p", "hb-note", "読了で登録した本なので、記録だけでゴールドは付きません。"));

    if (b.status !== "want") {
      box.appendChild(h("span", "field-label", "何ページまで進んだか"));
      const row = h("div", "rd-add");
      const date = h("input", "field-input rd-date"); date.type = "date"; date.max = t0; date.value = logDay;
      date.setAttribute("aria-label", "記録する日");
      date.onchange = () => { if (/^\d{4}-\d{2}-\d{2}$/.test(date.value)) logDay = date.value > t0 ? t0 : date.value; draw(); };
      row.appendChild(date);
      row.appendChild(button("この日を記録", "btn btn-secondary rd-add-btn", () => openPage(id, logDay)));
      box.appendChild(row);
    }
    if (b.status === "done") {
      box.appendChild(h("span", "field-label", "読了日"));
      const fin = h("input", "field-input rd-date"); fin.type = "date"; fin.max = t0; fin.value = b.finishedOn;
      fin.setAttribute("aria-label", "読了日");
      fin.onchange = () => { if (/^\d{4}-\d{2}-\d{2}$/.test(fin.value)) updateBook(id, x => R.setFinishedOn(x, fin.value, t0)); };
      box.appendChild(fin);
    }
    box.appendChild(h("span", "field-label", b.status === "done" ? "感想" : "メモ"));
    const rv = h("textarea", "field-input"); rv.maxLength = 2000; rv.value = b.review;
    rv.placeholder = b.status === "done" ? "ひとことで残しておく" : "気になったところなど";
    rv.setAttribute("aria-label", b.status === "done" ? "感想" : "メモ");
    rv.onchange = () => updateBook(id, x => ({ ...x, review: rv.value.trim().slice(0, 2000) }));
    box.appendChild(rv);

    const days = Object.keys(b.log).sort().reverse();
    if (days.length) {
      box.appendChild(h("span", "field-label", "これまでの記録"));
      const lst = h("div", "rd-log");
      days.slice(0, 30).forEach(k => {
        const n = R.readOn(b, k), r = h("div", "rd-log-row");
        r.innerHTML = `<span>${slash(k)}</span><span>p.${b.log[k].page}${n ? `（+${n}）` : ""}</span>`;
        r.appendChild(button("×", "hb-chip", () => {
          if (!confirm(`${slash(k)} の記録を消しますか？`)) return;
          updateBook(id, x => R.removeLog(x, k)); draw();
        }, { "aria-label": `${k} の記録を消す` }));
        lst.appendChild(r);
      });
      if (days.length > 30) lst.appendChild(h("p", "hb-note", `ほか ${days.length - 30}日分`));
      box.appendChild(lst);
    }
    box.appendChild(btnRow([button("‹ 本棚", "btn btn-secondary", () => openShelf(b.status)), button("編集", "btn btn-secondary", () => openEditor(id)), closeBtn()]));
  });
  draw();
}

// ── その日に何ページまで進んだか ─────────────────────────────────────────────
export function openPage(id, day) {
  const t0 = today();
  const b0 = load().books.find(x => x.id === id);
  if (!b0) return;
  let page = R.pageAt(b0, day);
  const draw = () => sheet(box => {
    const b = load().books.find(x => x.id === id);
    const before = R.pageBefore(b, day), max = b.pages || 20000;
    box.appendChild(h("div", "rd-head", `<div class="rd-title big">${esc(b.title)}</div><div class="rd-sub">${dayName(day, t0)}は何ページまで進みましたか？</div>`));
    const big = h("div", "hb-big", `p.${page}${b.pages ? `<small>/ ${b.pages}</small>` : ""}`);
    box.appendChild(big);
    const n = Math.max(0, page - before);
    const willGold = inGoldWindow(day, t0);
    box.appendChild(h("p", "hb-note rd-center", n ? `この日 +${n}ページ${willGold ? ` ・ +${R.pagesGold(before, page)}G` : ""}` : before ? `前回は p.${before} まで` : "最初のページから数えます"));
    const ctrl = h("div", "hb-ctrl");
    [-10, -1, 1, 10].forEach(d => ctrl.appendChild(button(d > 0 ? `+${d}` : String(d), "", () => { page = Math.min(max, Math.max(0, page + d)); draw(); })));
    box.appendChild(ctrl);
    const inp = h("input", "field-input rd-page"); inp.type = "number"; inp.inputMode = "numeric"; inp.min = 0; inp.max = max; inp.value = page;
    inp.setAttribute("aria-label", "進んだページ");
    inp.onchange = () => { page = Math.min(max, Math.max(0, parseInt(inp.value, 10) || 0)); draw(); };
    box.appendChild(inp);
    if (!willGold) box.appendChild(h("p", "hb-note", `${SETTLE_WINDOW}日以上前の記録はゴールドには入りません（本棚と統計には残ります）。`));
    const saveBtn = button("記録する", "btn btn-primary", () => {
      const pg = Math.min(max, Math.max(0, parseInt(inp.value, 10) || 0));
      const g0 = R.bookDayGold(b, day);
      const nb = updateBook(id, x => R.setPage(x, day, pg));
      gainToast(g0, R.bookDayGold(nb, day), day);
      closeSheet();
    });
    const list = [saveBtn];
    if (b.status === "reading") list.push(button("読了にする", "btn btn-secondary", () => {
      const g0 = R.bookDayGold(b, day);
      const nb = updateBook(id, x => R.setStatus(x, "done", day, t0));
      const g1 = R.bookDayGold(nb, day);
      if (typeof showToast === "function") showToast(inGoldWindow(day, t0) ? `🎉 読了！ +${(g1?.g || 0) - (g0?.g || 0)}G` : "🎉 読了！");
      openBook(id);
    }));
    box.appendChild(btnRow(list));
    box.appendChild(btnRow([button("本の詳細", "btn btn-secondary", () => openBook(id)), closeBtn()]));
  });
  draw();
}

// ── 本の追加・編集 ───────────────────────────────────────────────────────────
export function openEditor(id, opts = {}) {
  const data = load(), orig = id ? data.books.find(b => b.id === id) : null;
  const draft = orig ? { ...orig } : { title: "", author: "", pages: 0, status: opts.status || seg };
  let msg = "";
  const draw = () => sheet(box => {
    box.appendChild(h("h3", "modal-title", orig ? "本を編集" : "本を追加"));
    const field = (label, val, attrs, set) => {
      box.appendChild(h("span", "field-label", label));
      const i = h("input", "field-input"); Object.assign(i, attrs); i.value = val; i.setAttribute("aria-label", label);
      i.oninput = () => set(i.value); box.appendChild(i);
    };
    field("書名", draft.title, { maxLength: 120, placeholder: "例：神経診断学を学ぶ人のために" }, v => { draft.title = v; });
    field("著者（任意）", draft.author, { maxLength: 80 }, v => { draft.author = v; });
    field("全ページ数", draft.pages || "", { type: "number", inputMode: "numeric", min: 1 }, v => { draft.pages = parseInt(v, 10) || 0; });
    if (!orig) {
      box.appendChild(h("span", "field-label", "状態"));
      const sg = h("div", "hb-seg");
      ["want", "reading", "done"].forEach(st => sg.appendChild(button(R.STATUS_LABEL[st], draft.status === st ? "on" : "", () => { draft.status = st; draw(); })));
      box.appendChild(sg);
    }
    if (msg) box.appendChild(h("p", "hb-note rd-warn", esc(msg)));
    if (!orig && draft.status === "done") box.appendChild(h("p", "hb-note", "読了で登録した本は記録として残り、ゴールドは付きません。"));
    box.appendChild(h("p", "hb-note", `読み進めた${R.PAGES_PER_GOLD}ページごとに1G、読了した日に全ページ数×1/4のボーナス${draft.pages > 0 ? `（${R.finishBonus(draft)}G）` : ""}。`));
    const list = [];
    if (orig) list.push(button("削除", "btn btn-secondary", () => {
      if (!confirm(`「${orig.title}」と、その読書記録を消しますか？`)) return;
      const d = load(); d.books = d.books.filter(b => b.id !== id); save(d); openShelf(orig.status);
    }));
    list.push(button("保存", "btn btn-primary", () => {
      if (!draft.title.trim()) { msg = "書名を入れてください。"; draw(); return; }
      if (!(draft.pages > 0)) { msg = "全ページ数を入れてください。"; draw(); return; }
      const t0 = today(), d = load();
      if (orig) {
        d.books = d.books.map(b => (b.id === id ? R.normalizeBook({ ...b, title: draft.title, author: draft.author, pages: draft.pages }, t0) : b));
        save(d); openBook(id);
      } else {
        const nb = R.normalizeBook({ id: "b_" + Date.now().toString(36), title: draft.title, author: draft.author, pages: draft.pages,
          status: draft.status, addedOn: t0, startedOn: draft.status === "want" ? null : (opts.day || t0), finishedOn: t0,
          recordOnly: draft.status === "done" }, t0);
        d.books.push(nb); save(d); seg = nb.status;
        if (opts.day) closeSheet(); else openBook(nb.id);
      }
    }));
    box.appendChild(btnRow(list));
    box.appendChild(btnRow([button("戻る", "btn btn-secondary", () => (orig ? openBook(id) : opts.day ? closeSheet() : openShelf())), closeBtn()]));
  });
  draw();
}

// ── 今日タブの読書カード ─────────────────────────────────────────────────────
export function renderTodayBooks(v, day) {
  const t0 = today(), books = R.booksOn(load().books, day);
  const sec = h("div", "rd-today"); sec.id = "rd-today";
  // 見出しは今日タブの日課・タスク・習慣と同じ形(td-head)
  const head = h("div", "td-head", `<p class="hb-group">読書</p>`);
  head.appendChild(button("＋", "td-plus rd-today-add", () => openEditor(null, { status: "reading", day }), { "aria-label": "読書中の本を追加" }));
  sec.appendChild(head);
  if (!books.length) sec.appendChild(h("p", "hb-note", "読んでいる本を追加すると、何ページまで進んだかを記録できます（2ページで1G・読了でボーナス）。"));
  books.forEach(b => {
    const page = R.pageAt(b, day), n = R.readOn(b, day), ratio = b.pages ? Math.min(1, page / b.pages) : 0;
    const card = button("", "hb-card rd-book" + (n ? " done" : ""), () => (b.status === "done" ? openBook(b.id) : openPage(b.id, day)));
    card.style.setProperty("--c", "#8fb3d9");
    const e = R.bookDayGold(b, day);
    card.innerHTML = `<div class="hb-icon" aria-hidden="true">${b.status === "done" ? "🎉" : "📖"}</div>
      <div class="hb-main"><div class="hb-name">${esc(b.title)}</div>
        <div class="hb-sub">${pageText(b, page)}${n ? ` ・ この日 +${n}ページ` : ""}${b.status === "done" ? " ・ 読了" : ""}${e && inGoldWindow(day, t0) ? ` ・ +${e.g}G` : ""}</div>
        ${bar(ratio)}</div>
      <span class="rd-pct">${Math.round(ratio * 100)}%</span>`;
    card.setAttribute("aria-label", `${b.title} ${pageText(b, page)}。何ページまで進んだか記録する`);
    sec.appendChild(card);
  });
  v.appendChild(sec);
}

// ── 統計タブの読書まとめ ─────────────────────────────────────────────────────
// range: {from: Date, to: Date}、mode: "week" | "month" | "year"
export function renderReadingStats(wrap, range, mode) {
  const data = load();
  if (!data.books.length) return;
  const from = R.keyOfDate(range.from), to = R.keyOfDate(range.to);
  const s = R.periodStats(data.books, from, to);
  wrap.appendChild(h("p", "section-label", "読書"));
  const card = h("div", "stats-card"); card.id = "rd-stats";
  const st3 = h("div", "hb-stats3");
  st3.innerHTML = `<div><b>${s.finished.length}</b><span>読了</span></div><div><b>${s.pages}</b><span>ページ</span></div><div><b>${s.days}</b><span>読んだ日</span></div>`;
  card.appendChild(st3);
  if (mode === "year") {
    const months = R.finishedByMonth(data.books, range.from.getFullYear()), max = Math.max(1, ...months);
    const bars = h("div", "rd-months");
    months.forEach((n, i) => {
      bars.insertAdjacentHTML("beforeend", `<div class="rd-month" title="${i + 1}月 ${n}冊"><span class="rd-month-n">${n || ""}</span>
        <div class="rd-month-bar" style="height:${Math.round(n / max * 100)}%"></div><span class="rd-month-l">${i + 1}</span></div>`);
    });
    card.appendChild(bars);
  }
  if (s.finished.length) {
    const lst = h("div", "rd-log");
    s.finished.forEach(b => {
      const r = button("", "rd-log-row rd-fin", () => openBook(b.id));
      r.innerHTML = `<span>${esc(shortDate(b.finishedOn))}</span><span class="rd-fin-title">${esc(b.title)}${b.author ? ` <small>${esc(b.author)}</small>` : ""}</span>`;
      lst.appendChild(r);
    });
    card.appendChild(lst);
  }
  card.appendChild(h("p", "hb-note", "冊数は読了日で、ページは記録した日に進んだ分で数えています。"));
  wrap.appendChild(card);
}

window.ReadingUI = { renderTodayBooks, renderReadingStats, openShelf, openBook, openPage, openEditor };
document.getElementById("rd-open")?.addEventListener("click", () => openShelf());
window.addEventListener("storage", e => { if (e.key === R.KEY) refresh(); });
