// Optional browser regression checks for the habit tracker (今日 tab, gold, shop, stats).
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/habit-ui.cjs
// QA_SCREENSHOTS=<dir> でスクリーンショットを保存
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/tracker.html' : url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); res.end(data);
  });
});
// 2026-10-12(月)〜10-17(土): 専門医を6日連続、英語は2日、筋トレは2部位
function seedRecords() {
  const wk = '2026-10-12', rec = { [wk]: {} };
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].forEach(d => { rec[wk][d] = { medicine: { done: true, note: '', duration: '30', rating: 0 } }; });
  rec[wk].mon.english = { done: true, duration: '20' };
  rec[wk].wed.english = { done: true, duration: '20' };
  rec[wk].tue.workout_chest = { done: true };
  rec[wk].thu.workout_leg = { done: true };
  return rec;
}
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const errors = [];
  const shots = process.env.QA_SCREENSHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo' });
  await ctx.route(/fonts\.googleapis\.com|accounts\.google\.com/, r => r.abort());
  const p = await ctx.newPage(); p.setDefaultTimeout(10000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.clock.install({ time: new Date('2026-10-18T10:00:00+09:00') });
  await p.addInitScript(rec => {
    if (sessionStorage.getItem('qa-seeded')) return;
    localStorage.setItem('wt_records', JSON.stringify(rec));
    sessionStorage.setItem('qa-seeded', '1');
  }, seedRecords());
  await p.goto(base + '/tracker.html');
  await p.waitForSelector('#today-view .hb-card');
  const gold = () => p.evaluate(() => { const r = JSON.parse(localStorage.getItem('wt_reward_v1')); return r; });
  const balance = async () => p.$eval('#today-view .hb-pill.gold', e => Number(e.textContent.replace(/[^\d]/g, '')));

  // 1) 起動すると今日タブ。5トラック連動の初期習慣・はじめてボーナス100G。予定・記録タブはない
  assert.equal(await p.locator('.tab-btn.active').getAttribute('data-tab'), 'today');
  assert.equal(await p.locator('#today-view .hb-card').count(), 5);
  assert.deepEqual(await p.locator('.tab-btn').evaluateAll(b => b.map(x => x.dataset.tab)), ['today', 'status', 'stats']);
  assert.equal(await p.locator('#gcal-open').count(), 0);
  assert.equal(await balance(), 100);
  assert.match(await p.locator('.hb-card', { hasText: '専門医勉強' }).innerText(), /🔥6日/);
  if (shots) await p.screenshot({ path: path.join(shots, 'habit-today-start.png') });

  // 2) 専門医リングをタップ → 7日連続のメダル演出、ゴールド 10+6+50
  await p.locator('.hb-card', { hasText: '専門医勉強' }).locator('.hb-ring').click();
  await p.waitForSelector('.hb-celebrate');
  assert.match(await p.locator('.hb-celebrate').innerText(), /7日連続達成/);
  if (shots) await p.screenshot({ path: path.join(shots, 'habit-medal.png') });
  await p.locator('.hb-celebrate').click();
  assert.equal(await balance(), 166);
  const recs = await p.evaluate(() => JSON.parse(localStorage.getItem('wt_records')));
  assert.equal(recs['2026-10-12'].sun.medicine.done, true, 'linked habit writes wt_records');

  // 3) 習慣を追加: ストレッチ・時間5分・毎日 → リング1タップで目標まで記録
  await p.locator('.hb-add').click();
  await p.locator('#hb-sheet .td-choice', { hasText: '習慣' }).click();
  await p.locator('#hb-sheet input.field-input').first().fill('ストレッチ');
  await p.locator('#hb-sheet .hb-chip', { hasText: '🧘' }).click();
  await p.locator('#hb-sheet .hb-seg button', { hasText: '時間' }).click();
  await p.locator('#hb-sheet .hb-step input').fill('5');
  await p.locator('#hb-sheet .hb-step input').dispatchEvent('change');
  if (shots) await p.screenshot({ path: path.join(shots, 'habit-editor.png') });
  await p.locator('#hb-sheet .btn-primary', { hasText: '保存' }).click();
  const stretch = p.locator('.hb-card', { hasText: 'ストレッチ' });
  assert.match(await stretch.innerText(), /0\/5分/);
  await stretch.locator('.hb-ring').click();
  assert.match(await stretch.innerText(), /5\/5分/);
  assert.equal(await balance(), 176);
  assert.ok(await stretch.evaluate(e => e.classList.contains('done')));

  // 4) 英語のリングを長押し → 休息日(ゴールドは変わらない)
  const eng = p.locator('.hb-card', { hasText: '英語学習' }).locator('.hb-ring');
  await eng.dispatchEvent('pointerdown');
  await p.clock.runFor(700);
  await eng.dispatchEvent('pointerup');
  await p.waitForSelector('.hb-card.rest');
  assert.match(await p.locator('.hb-card.rest').innerText(), /休息日/);
  const log = await p.evaluate(() => JSON.parse(localStorage.getItem('wt_habit_log_v1')));
  assert.equal(log['2026-10-18'].h_english.rest, true);

  // 5) 筋トレ: リング → 部位シート → 胸を記録(週4回の目標で今週3/4)
  await p.locator('.hb-card', { hasText: '筋トレ' }).locator('.hb-ring').click();
  await p.locator('#hb-sheet .hb-ctrl button', { hasText: '胸' }).click();
  assert.match(await p.locator('#hb-sheet .hb-ctrl').innerText(), /✓ 胸/);
  assert.equal(await balance(), 186, 'a workout day toward the weekly goal earns the base gold');
  if (shots) await p.screenshot({ path: path.join(shots, 'habit-detail.png') });
  await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();
  assert.match(await p.locator('.hb-card', { hasText: '筋トレ' }).innerText(), /今週 3\/4/);

  // 6) 日付ストリップで昨日を選ぶ → 昨日の記録が見える
  await p.locator('.hb-day[data-day="2026-10-17"]').click();
  assert.equal(await p.locator('.hb-top h1').innerText(), '昨日');
  assert.ok(await p.locator('.hb-card', { hasText: '専門医勉強' }).evaluate(e => e.classList.contains('done')));
  await p.locator('.hb-day[data-day="2026-10-18"]').click();

  // 6b) 日付の列を横にスクロールすると、どこまでもさかのぼれる(左端で4週間ずつ足される)
  const strip = p.locator('.hb-days');
  assert.equal(await p.locator('.hb-day').count(), 28);
  assert.ok(await strip.evaluate(e => e.scrollLeft + e.clientWidth >= e.scrollWidth - 2), 'starts at today');
  await strip.evaluate(e => { e.scrollLeft = 0; e.dispatchEvent(new Event('scroll')); });
  assert.equal(await p.locator('.hb-day').count(), 56);
  await p.locator('.hb-day[data-day="2026-09-27"]').click();
  assert.equal(await p.locator('.hb-top h1').innerText(), '9/27(日)');
  assert.equal(await p.locator('.hb-weeknav span').innerText(), '9月');
  assert.ok(await p.locator('.hb-day.sel').evaluate(b => { const s = b.parentElement; return b.offsetLeft >= s.scrollLeft && b.offsetLeft + b.offsetWidth <= s.scrollLeft + s.clientWidth; }), 'selected day stays in view');
  assert.match(await p.locator('.hb-sum').innerText(), /ゴールドには入りません/);
  const oldGold = await balance();
  await p.locator('.hb-card', { hasText: '自炊' }).locator('.hb-ring').click();
  assert.equal(await balance(), oldGold);
  assert.equal((await p.evaluate(() => JSON.parse(localStorage.getItem('wt_records'))))['2026-09-21'].sun.cooking.done, true);
  assert.ok(await p.locator('.hb-day.sel').evaluate(b => { const s = b.parentElement; return b.offsetLeft >= s.scrollLeft && b.offsetLeft + b.offsetWidth <= s.scrollLeft + s.clientWidth; }), 'strip keeps its place after recording');
  // 一覧を左右にスワイプすると1日ずつ動く
  const swipe = async dx => p.locator('#today-view').evaluate((v, dx) => {
    const at = x => [new Touch({ identifier: 1, target: v, clientX: x, clientY: 400 })];
    v.dispatchEvent(new TouchEvent('touchstart', { touches: at(200), changedTouches: at(200), bubbles: true }));
    v.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: at(200 + dx), bubbles: true }));
  }, dx);
  await swipe(120);
  assert.equal(await p.locator('.hb-top h1').innerText(), '9/26(土)');
  await swipe(-120);
  await swipe(-120);
  assert.equal(await p.locator('.hb-top h1').innerText(), '9/28(月)');
  await p.locator('.hb-weeknav .back').click();
  assert.equal(await p.locator('.hb-top h1').innerText(), '今日');
  await swipe(-120);
  assert.equal(await p.locator('.hb-top h1').innerText(), '今日', 'cannot swipe into the future');
  if (shots) await p.screenshot({ path: path.join(shots, 'habit-today-after.png') });

  // 7) 画面幅ごとのはみ出しなし
  for (const width of [320, 375, 430, 1024]) {
    await p.setViewportSize({ width, height: 844 });
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `today ${width} overflow`);
    assert.equal(await p.locator('#today-view').evaluate(e => e.scrollWidth > e.clientWidth), false, `today ${width} content overflow`);
  }
  await p.setViewportSize({ width: 390, height: 844 });

  // 8) 育成タブ: ゴールドカード → ショップで護符を購入
  await p.locator('[data-tab="status"]').click();
  await p.waitForSelector('.rw-gold');
  assert.match(await p.locator('.rw-gold').innerText(), /186/);
  await p.locator('#status-view .btn-primary', { hasText: 'ショップ' }).click();
  await p.locator('#hb-sheet .hb-seg button', { hasText: 'どうぐ' }).click();
  await p.locator('#hb-sheet .shop-row', { hasText: 'まもりの護符' }).locator('.shop-btn').click();
  assert.equal((await gold()).purchases.length, 1);
  assert.match(await p.locator('#hb-sheet .hb-pill').innerText(), /🪙 86$/);
  // ショップは「ごほうび」と「どうぐ」だけ。称号・おとも・背景は廃止
  assert.deepEqual(await p.locator('#hb-sheet .hb-seg button').allInnerTexts(), ['ごほうび', 'どうぐ']);
  if (shots) await p.screenshot({ path: path.join(shots, 'habit-shop.png') });
  await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();
  assert.equal(await p.locator('#status-view .hero-pet').count(), 0);
  assert.equal(await p.locator('#status-view .hero-title').count(), 0);
  assert.ok(await p.locator('#status-view .rw-medal', { hasText: '7日' }).count() >= 1);
  await p.waitForFunction(() => document.querySelector('#status-view .hero-sprite')?.naturalWidth > 0);
  if (shots) await p.screenshot({ path: path.join(shots, 'habit-growth.png') });

  // 9) 統計タブ: 習慣の達成度。予定に入れていない記録も達成回数に入る
  await p.locator('[data-tab="stats"]').click();
  await p.waitForSelector('.hs-row');
  assert.ok(await p.locator('.hs-row', { hasText: 'ストレッチ' }).count() === 1);
  const medicineCount = await p.locator('.stats-card').filter({ hasText: '専門医勉強' }).filter({ hasText: '合計' }).innerText();
  assert.match(medicineCount, /7回/);
  if (shots) { await p.locator('.hs-row').first().scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(shots, 'habit-stats.png') }); }

  assert.equal(await p.locator('#stats-view').innerText().then(t => t.includes('平均評価')), false);

  // 10) 統計: 週間=日ごと、月間=週ごとのまとめ。ヒートマップの日から今日タブのその日へ
  await p.locator('.mode-toggle button', { hasText: '週間' }).click();
  assert.equal(await p.locator('.period-label').innerText(), '10/12 〜 10/18');
  assert.equal(await p.locator('.tr-row').count(), 7);
  assert.match(await p.locator('.tr-row', { hasText: '10/13(火)' }).innerText(), /2件 · 30分/);
  assert.equal(await p.locator('.period-nav button').last().isDisabled(), true);
  await p.locator('.period-nav button').first().click();
  assert.equal(await p.locator('.period-label').innerText(), '10/5 〜 10/11');
  await p.locator('.mode-toggle button', { hasText: '月間' }).click();
  assert.match(await p.locator('.section-label', { hasText: 'まとめ' }).innerText(), /週ごと/);
  assert.match(await p.locator('.tr-row', { hasText: '10/12〜' }).innerText(), /7日/);
  if (shots) { await p.locator('.tr-row').first().scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(shots, 'habit-stats-trend.png') }); }
  await p.locator('.hm-cell', { hasText: /^14/ }).first().click();
  await p.locator('.hm-jump').click();
  assert.equal(await p.locator('.tab-btn.active').getAttribute('data-tab'), 'today');
  assert.equal(await p.locator('.hb-top h1').innerText(), '10/14(水)');

  // 11) 再読み込みしても状態が残り、ゴールドが二重に増えない
  await p.locator('[data-tab="today"]').click();
  const before = await balance();
  await p.reload(); await p.waitForSelector('#today-view .hb-card');
  assert.equal(await balance(), before);

  // 12) 以前に買った称号・おとも・背景は読み込み時に取り消され、ゴールドが戻る。画面も壊れない
  const g0 = await balance();
  await p.evaluate(() => {
    const r = JSON.parse(localStorage.getItem('wt_reward_v1'));
    r.purchases.push({ item: 'p_cat', price: 500, on: '2026-10-18' }, { item: 't_iron', price: 800, on: '2026-10-18' }, { item: 'bg_night', price: 1200, on: '2026-10-18' });
    r.owned = ['p_cat', 't_iron', 'bg_night', 't_linguist']; r.equipped = { title: 't_iron', pet: 'p_cat', bg: 'bg_night' };
    localStorage.setItem('wt_reward_v1', JSON.stringify(r));
  });
  await p.reload(); await p.waitForSelector('#today-view .hb-card');
  assert.equal(await balance(), g0, 'retired purchases refunded');
  const cleaned = await gold();
  assert.deepEqual(cleaned.purchases.map(x => x.item), ['shield']);
  assert.equal('owned' in cleaned, false);
  assert.equal('equipped' in cleaned, false);
  await p.locator('[data-tab="status"]').click();
  await p.waitForSelector('.rw-gold');
  assert.equal(await p.locator('#status-view .hero-title').count(), 0);

  assert.deepEqual(errors, []);
  console.log('Habit tracker: today tab, linked/custom habits, rest, workout parts, medals, shop, stats, reload passed.');
  await browser.close(); server.close();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
