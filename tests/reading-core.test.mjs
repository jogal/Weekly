import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/reading-core.mjs';
import * as H from '../js/habit-core.mjs';

const TODAY = '2026-10-18';
const book = (over = {}) => R.normalizeBook({ id: 'b1', title: '神経診断学', pages: 300, status: 'reading', addedOn: '2026-10-01', ...over }, TODAY);

test('normalize: empty or broken data becomes an empty shelf, bad fields are cleaned', () => {
  assert.deepEqual(R.normalize(null, TODAY), { books: [] });
  assert.deepEqual(R.normalize({ books: 'x' }, TODAY), { books: [] });
  const b = R.normalizeBook({ title: '  ', status: 'zzz', pages: 100, log: { bad: { page: 3 }, '2026-10-01': { page: '12' }, '2026-10-02': { page: 0 }, '2026-10-03': { page: 999 } } }, TODAY);
  assert.equal(b.title, '無題の本');
  assert.equal(b.status, 'want');
  assert.equal(b.finishedOn, null);
  assert.deepEqual(b.log, { '2026-10-01': { page: 12 }, '2026-10-03': { page: 100 } });
});

test('setPage records the page reached; pages read are the gain over the previous record', () => {
  let b = book({ status: 'want', startedOn: null });
  b = R.setPage(b, '2026-10-10', 30);
  assert.equal(b.status, 'reading');
  assert.equal(b.startedOn, '2026-10-10');
  b = R.setPage(b, '2026-10-12', 55);
  b = R.setPage(b, '2026-10-13', 40);   // 戻した日は 0
  assert.equal(R.readOn(b, '2026-10-10'), 30);
  assert.equal(R.readOn(b, '2026-10-12'), 25);
  assert.equal(R.readOn(b, '2026-10-13'), 0);
  assert.equal(R.pageAt(b, '2026-10-11'), 30);
  assert.equal(R.pageAt(b, '2026-10-13'), 55);
  assert.equal(R.currentPage(b), 55);
  assert.deepEqual(R.totals(b), { page: 55, days: 2, last: '2026-10-12' });
  b = R.setPage(b, '2026-10-12', 0);
  assert.equal('2026-10-12' in b.log, false);
  assert.equal(R.readOn(b, '2026-10-13'), 10);
  assert.equal(R.setPage(b, TODAY, 5000).log[TODAY].page, 300, 'capped at the total pages');
});

test('gold: 1G per 2 pages read (remainder carries over), quarter-pages bonus on the finish day', () => {
  let b = R.setPage(book(), '2026-10-16', 280);
  assert.deepEqual(R.bookDayGold(b, '2026-10-16'), { g: 140, streak: 0, unit: 'd', ms: 0, pages: 280, bonus: 0 });
  b = R.setStatus(b, 'done', TODAY);
  assert.equal(b.finishedOn, TODAY);
  assert.equal(b.log[TODAY].page, 300, 'finishing fills the rest of the pages');
  assert.equal(R.bookDayGold(b, TODAY).g, 10 + 75, 'bonus is a quarter of the total pages');
  assert.equal(R.finishBonus({ pages: 303 }), 75, 'rounded down');
  let odd = R.setPage(book({ id: 'o' }), '2026-10-16', 21);
  odd = R.setPage(odd, '2026-10-17', 42);
  assert.equal(R.bookDayGold(odd, '2026-10-16').g, 10);
  assert.equal(R.bookDayGold(odd, '2026-10-17').g, 11, 'the odd page carries over');
  assert.deepEqual(Object.keys(R.dayGoldItems([b], TODAY)), ['book:b1']);
  b = R.setStatus(b, 'reading', TODAY);
  assert.equal(b.finishedOn, null);
  assert.equal(R.bookDayGold(b, TODAY), null, 'undo removes the filled pages and the bonus');
});

test('settle adds reading gold to the day and it counts in the balance', () => {
  const b = R.setPage(book(), TODAY, 40);
  const ctx = { log: {}, records: {}, freezes: {}, floorKey: null, today: TODAY, extraGold: k => R.dayGoldItems([b], k) };
  const r0 = H.newRewardState('2026-10-15');
  const r = H.settle(r0, [], ctx, TODAY);
  assert.equal(H.goldOn(r, TODAY), 20);
  assert.equal(H.balance(r), H.balance(H.settle(r0, [], { ...ctx, extraGold: undefined }, TODAY)) + 20);
});

test('periodStats, finishedByMonth and booksOn', () => {
  const a = R.setStatus(R.setPage(R.setPage(book({ id: 'a' }), '2026-09-30', 50), '2026-10-12', 80), 'done', '2026-10-12');
  const c = R.setPage(R.setPage(book({ id: 'c', startedOn: '2026-10-12' }), '2026-10-12', 5), '2026-10-13', 15);
  const books = [a, book({ id: 'b', status: 'done', finishedOn: '2026-09-02' }), c, book({ id: 'w', status: 'want' })];
  const s = R.periodStats(books, '2026-10-01', '2026-10-31');
  assert.deepEqual(s.finished.map(b => b.id), ['a']);
  assert.equal(s.pages, 250 + 15);
  assert.equal(s.days, 2);
  assert.deepEqual(R.finishedByMonth(books, 2026), [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]);
  assert.deepEqual(R.sortBooks(books, 'done').map(b => b.id), ['a', 'b']);
  assert.deepEqual(R.booksOn(books, '2026-10-12').map(b => b.id), ['a', 'c']);
  assert.deepEqual(R.booksOn(books, '2026-10-01').map(b => b.id), ['a', 'c'], 'a was being read then');
  assert.deepEqual(R.booksOn(books, '2026-09-01').map(b => b.id), ['c']);
  assert.deepEqual(R.booksOn(books, TODAY).map(b => b.id), ['c']);
});

test('loopholes: record-only finish, one bonus per book, undo and finish-date moves', () => {
  // 最初から読了で登録した本・一度も記録せずに読了にした本はゴールドなし
  const added = R.normalizeBook({ id: 'r', title: 'x', pages: 400, status: 'done', finishedOn: TODAY, recordOnly: true }, TODAY);
  assert.equal(R.bookDayGold(added, TODAY), null);
  const wantDone = R.setStatus(book({ status: 'want', startedOn: null }), 'done', TODAY, TODAY);
  assert.equal(wantDone.recordOnly, true);
  assert.deepEqual(wantDone.log, {}, 'no pages filled');
  assert.equal(R.bookDayGold(wantDone, TODAY), null);
  assert.equal(R.setStatus(wantDone, 'reading', TODAY, TODAY).recordOnly, false);

  // 読了の取り消しで、埋めたページとボーナスが戻る
  let b = R.setPage(book(), '2026-10-16', 100);
  b = R.setPage(b, TODAY, 120);
  b = R.setStatus(b, 'done', TODAY, TODAY);
  assert.deepEqual(b.fill, { on: TODAY, prev: 120 });
  assert.equal(R.bookDayGold(b, TODAY).g, 100 + 75);
  b = R.setStatus(b, 'reading', TODAY, TODAY);
  assert.deepEqual(b.log[TODAY], { page: 120 });
  assert.equal(b.bonusOn, null);
  assert.equal(R.bookDayGold(b, TODAY).g, 10);

  // 読了日を前に動かすと、埋めたページとボーナスも動く
  b = R.setStatus(b, 'done', TODAY, TODAY);
  b = R.setFinishedOn(b, '2026-10-16', TODAY);
  assert.deepEqual(b.log, { '2026-10-16': { page: 300 }, [TODAY]: { page: 120 } });
  assert.equal(R.bookDayGold(b, '2026-10-16').g, 150 + 75);
  assert.equal(R.bookDayGold(b, TODAY), null);

  // 確定済み(8日以上前)のボーナスは、取り消して読了し直しても2回目は付かない
  let c = R.setStatus(R.setPage(book({ id: 'c' }), '2026-10-01', 10), 'done', '2026-10-01', '2026-10-01');
  assert.equal(c.bonusOn, '2026-10-01');
  c = R.setStatus(c, 'reading', TODAY, TODAY);
  assert.equal(c.bonusOn, '2026-10-01', 'banked bonus stays');
  c = R.setStatus(c, 'done', TODAY, TODAY);
  assert.equal(R.bookDayGold(c, TODAY).bonus, 0);
});

test('questStats feeds the reading quests (record-only books do not count)', async () => {
  const Q = await import('../js/quest-core.mjs');
  const a = R.setStatus(R.setPage(book({ id: 'a' }), '2026-10-10', 100), 'done', '2026-10-12', TODAY);
  const c = R.setPage(book({ id: 'c' }), TODAY, 40);
  const r = R.normalizeBook({ id: 'r', title: 'x', pages: 500, status: 'done', recordOnly: true }, TODAY);
  const st = R.questStats([a, c, r], TODAY);
  assert.deepEqual(st, { booksDone: 1, pagesRead: 340 });
  const board = Q.questBoard(Q.questMetrics({ reading: st, today: TODAY }), null, []);
  const books = board.find(q => q.line.id === 'books_done'), pages = board.find(q => q.line.id === 'pages_read');
  assert.equal(books.claimable, true);
  assert.equal(Q.progressText(pages), '340/500ページ');
  assert.equal(Q.questDesc(books), '本を1冊読み終える');
});

test('reading habit: added once, counts pages read that day, streak and completion, no habit gold', () => {
  const saved = { habits: H.defaultHabits('2026-01-01') };
  const hs = H.ensureHabits(saved, TODAY, '2026-10-10').habits;
  const rh = hs.find(h => h.link === 'reading');
  assert.equal(rh.createdOn, '2026-10-10', 'starts at the first reading log');
  assert.equal(H.ensureHabits({ habits: hs }, TODAY).habits.filter(h => h.link === 'reading').length, 1);
  let b = R.setPage(book(), '2026-10-16', 10);
  b = R.setPage(b, '2026-10-17', 30);
  b = R.setPage(b, TODAY, 45);
  const ctx = { log: {}, records: {}, freezes: {}, floorKey: '2026-10-16', today: TODAY, readPages: k => R.pagesOnDay([b], k) };
  assert.equal(H.progressOf(rh, TODAY, ctx), 1);
  assert.equal(H.currentStreak(rh, TODAY, ctx).n, 3);
  assert.deepEqual(H.dayCompletion([rh], TODAY, ctx), { due: 1, done: 1 });
  assert.equal(H.habitDayGold(rh, TODAY, ctx), null, 'gold comes from pages only');
  const pages = H.normalizeHabit({ ...rh, goal: { type: 'count', target: 20 } });
  assert.equal(H.progressOf(pages, TODAY, ctx), 15);
  assert.equal(H.isAchieved(pages, '2026-10-17', ctx), true);
  assert.equal(H.unitLabel(pages), 'ページ');
  assert.equal(H.isActiveOn(rh, '2026-10-09'), false);
  assert.equal(R.firstLogDay([b]), '2026-10-16');
});
