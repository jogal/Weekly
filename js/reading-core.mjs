// 読書記録のロジック(画面なし)。保存先は wt_reading_v1 だけで、習慣の記録とは別に残る。
// { books: [{ id, title, author, pages, status, addedOn, startedOn, finishedOn, review, log: { "YYYY-MM-DD": { page } } }] }
// log はその日に「何ページまで進んだか」。その日に読んだページ数は前の記録との差で数える。
// recordOnly: 最初から読了で登録した本(記録だけでゴールドなし)。bonusOn: 読了ボーナスを付けた日(1冊1回)。
// fill: 読了にしたとき最後のページまで埋めた日と、その日にもともとあった記録({ on, prev })。取り消し・読了日の変更で戻す。
import { SETTLE_WINDOW, addDays } from "./habit-core.mjs";
export const KEY = "wt_reading_v1";
export const STATUSES = ["reading", "want", "done"];
export const STATUS_LABEL = { want: "読みたい", reading: "読書中", done: "読了" };
export const GOLD_PER_PAGE = 1;   // 進んだ1ページごと
export const FINISH_BONUS_RATE = 0.5; // 読了した日に1回、全ページ数×1/2(端数切り捨て)
export const finishBonus = book => Math.floor(book.pages * FINISH_BONUS_RATE);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const int = (v, lo = 0, hi = 20000) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const str = (v, max) => (typeof v === "string" ? v : "").trim().slice(0, max);
const dateOr = v => (typeof v === "string" && DATE_RE.test(v) ? v : null);

export function keyOfDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function normalizeBook(b, today) {
  const pages = int(b?.pages, 0, 20000);
  const log = {};
  Object.entries(b?.log && typeof b.log === "object" ? b.log : {}).forEach(([k, e]) => {
    if (!DATE_RE.test(k)) return;
    const page = int(e?.page, 0, pages || 20000);
    if (page) log[k] = { page };
  });
  const status = STATUSES.includes(b?.status) ? b.status : "want";
  return {
    id: typeof b?.id === "string" && b.id ? b.id : "b_" + Math.random().toString(36).slice(2, 10),
    title: str(b?.title, 120) || "無題の本",
    author: str(b?.author, 80),
    pages,
    status,
    addedOn: dateOr(b?.addedOn) || today,
    startedOn: status === "want" ? dateOr(b?.startedOn) : (dateOr(b?.startedOn) || Object.keys(log).sort()[0] || today),
    finishedOn: status === "done" ? (dateOr(b?.finishedOn) || today) : null,
    review: str(b?.review, 2000),
    log,
    recordOnly: status === "done" && b?.recordOnly === true,
    bonusOn: dateOr(b?.bonusOn),
    fill: status === "done" && dateOr(b?.fill?.on) ? { on: b.fill.on, prev: b.fill.prev > 0 ? int(b.fill.prev, 0, pages || 20000) : null } : null,
  };
}
// ゴールドが確定済み(直近7日より前)の日か
const banked = (day, today) => day <= addDays(today, -SETTLE_WINDOW);

export function normalize(data, today) {
  const books = Array.isArray(data?.books) ? data.books.map(b => normalizeBook(b, today)) : [];
  return { books };
}

// その日より前に進んでいたページ(なければ 0)
export function pageBefore(book, day) {
  let p = 0;
  Object.entries(book.log).forEach(([k, e]) => { if (k < day && e.page > p) p = e.page; });
  return p;
}
// その日までに進んだページ
export function pageAt(book, day) {
  const e = book.log[day];
  return Math.max(pageBefore(book, day), e ? e.page : 0);
}
// その日に進んだページ数(前より戻した日は 0)
export function readOn(book, day) {
  const e = book.log[day];
  return e ? Math.max(0, e.page - pageBefore(book, day)) : 0;
}
export function currentPage(book) {
  return Object.values(book.log).reduce((a, e) => Math.max(a, e.page), 0);
}
export function totals(book) {
  const days = Object.keys(book.log).filter(k => readOn(book, k) > 0).sort();
  return { page: currentPage(book), days: days.length, last: days[days.length - 1] || null };
}
// 全ページ数がわかっていれば 0〜1、わからなければ null
export function progress(book) {
  if (book.status === "done") return 1;
  if (!book.pages) return null;
  return Math.min(1, currentPage(book) / book.pages);
}

// その日に何ページまで進んだかを記録する。0 で消す。読みたい本は読書中になる
export function setPage(book, day, page) {
  const log = { ...book.log };
  const p = int(page, 0, book.pages || 20000);
  if (p) log[day] = { page: p }; else delete log[day];
  const b = { ...book, log };
  if (p && b.status === "want") b.status = "reading";
  if (p && b.status !== "want" && (!b.startedOn || day < b.startedOn)) b.startedOn = day;
  return b;
}
export function removeLog(book, day) {
  const log = { ...book.log };
  delete log[day];
  return { ...book, log };
}

// 読了で埋めたページを元に戻す
function unfill(b) {
  if (!b.fill) return b;
  const log = { ...b.log };
  if (b.fill.prev) log[b.fill.on] = { page: b.fill.prev }; else delete log[b.fill.on];
  return { ...b, log, fill: null };
}
// 読了日に最後のページまで進んだことにする(その日の分のゴールドが入る)
function fillTo(b, day) {
  if (!b.pages || currentPage(b) >= b.pages) return b;
  return { ...b, log: { ...b.log, [day]: { page: b.pages } }, fill: { on: day, prev: b.log[day]?.page || null } };
}
// day: 読了にする日、today: 今日(ボーナスが確定済みかの判定に使う)
export function setStatus(book, status, day, today = day) {
  if (!STATUSES.includes(status) || status === book.status) return book;
  let b = { ...book, status };
  if (status !== "want" && !b.startedOn) b.startedOn = Object.keys(book.log).sort()[0] || day;
  if (status === "done") {
    b.finishedOn = day;
    // 一度も記録していない本の読了は「もう読んだ本の登録」: 記録だけでゴールドなし
    b.recordOnly = !Object.keys(book.log).length;
    if (!b.recordOnly) {
      b = fillTo(b, day);
      if (!b.bonusOn || !banked(b.bonusOn, today)) b.bonusOn = day; // ボーナスは1冊1回。確定済みならもう付けない
    }
    return b;
  }
  b = unfill(b);
  b.finishedOn = null;
  b.recordOnly = false;
  if (b.bonusOn && !banked(b.bonusOn, today)) b.bonusOn = null; // まだ確定していないボーナスは取り消す
  return b;
}
// 読了日を変える。埋めたページとまだ確定していないボーナスも一緒に動かす
export function setFinishedOn(book, day, today) {
  if (book.status !== "done" || !DATE_RE.test(day) || day === book.finishedOn) return book;
  let b = { ...book, finishedOn: day > today ? today : day };
  if (b.fill) b = fillTo(unfill(b), b.finishedOn);
  if (b.bonusOn && !banked(b.bonusOn, today)) b.bonusOn = b.finishedOn;
  return b;
}

// 本の並び: 読書中は最近読んだ順、読みたいは追加の新しい順、読了は読了日の新しい順
export function sortBooks(books, status) {
  const keyOf = b => status === "done" ? b.finishedOn || "" : status === "reading" ? totals(b).last || b.startedOn || b.addedOn : b.addedOn;
  return books.filter(b => b.status === status).sort((a, b) => (keyOf(b) > keyOf(a) ? 1 : keyOf(b) < keyOf(a) ? -1 : 0));
}
// 今日タブに出す本: 読書中の本(どの日にも出して、さかのぼって記録できる)と、その日が読書期間に入る読了本
export function booksOn(books, day) {
  return books.filter(b => b.status === "reading"
    || (b.status === "done" && b.finishedOn >= day && (b.startedOn || b.finishedOn) <= day))
    .sort((a, b) => (a.startedOn || a.addedOn).localeCompare(b.startedOn || b.addedOn));
}

// ── ゴールド ─────────────────────────────────────────────────────────────────
export function bookDayGold(book, day) {
  if (book.recordOnly) return null;
  const pages = readOn(book, day), bonus = book.status === "done" && book.bonusOn === day ? finishBonus(book) : 0;
  const g = pages * GOLD_PER_PAGE + bonus;
  return g ? { g, streak: 0, unit: "d", ms: 0, pages, bonus } : null;
}
// 習慣のゴールド精算(habit-core の settle)に足す、その日の読書の分。キーは "book:<id>"
export function dayGoldItems(books, day) {
  const out = {};
  books.forEach(b => { const e = bookDayGold(b, day); if (e) out["book:" + b.id] = e; });
  return out;
}

// クエスト掲示板(quest-core)に渡す読書の集計。読了で登録しただけの本は数えない
export function questStats(books, today) {
  let booksDone = 0, pagesRead = 0;
  books.forEach(b => {
    if (b.recordOnly) return;
    if (b.status === "done" && b.finishedOn <= today) booksDone++;
    Object.keys(b.log).forEach(k => { if (k <= today) pagesRead += readOn(b, k); });
  });
  return { booksDone, pagesRead };
}

// ── 統計 ─────────────────────────────────────────────────────────────────────
// from〜to(どちらも YYYY-MM-DD、両端を含む)の読書のまとめ
export function periodStats(books, from, to) {
  let pages = 0;
  const days = new Set();
  books.forEach(b => Object.keys(b.log).forEach(k => {
    if (k < from || k > to) return;
    const n = readOn(b, k);
    if (n) { pages += n; days.add(k); }
  }));
  const finished = books.filter(b => b.status === "done" && b.finishedOn >= from && b.finishedOn <= to)
    .sort((a, b) => (a.finishedOn < b.finishedOn ? -1 : 1));
  return { finished, pages, days: days.size };
}
// その年の月ごとの読了冊数(12個)
export function finishedByMonth(books, year) {
  const out = Array(12).fill(0);
  books.forEach(b => {
    if (b.status !== "done" || !b.finishedOn || +b.finishedOn.slice(0, 4) !== year) return;
    out[+b.finishedOn.slice(5, 7) - 1]++;
  });
  return out;
}
