// Optional browser checks for the reading log (ヘッダーの本棚、今日タブの読書カードとゴールド、統計、書き出し・復元).
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/reading-ui.cjs
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
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const errors = [];
  const shots = process.env.QA_SCREENSHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
  const shot = async n => { if (shots) await p.screenshot({ path: path.join(shots, n) }); };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo' });
  await ctx.route(/fonts\.googleapis\.com|accounts\.google\.com/, r => r.abort());
  const p = await ctx.newPage(); p.setDefaultTimeout(10000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.clock.install({ time: new Date('2026-10-18T10:00:00+09:00') });
  await p.goto(base + '/tracker.html');
  await p.waitForSelector('#today-view .hb-card');
  const saved = () => p.evaluate(() => JSON.parse(localStorage.getItem('wt_reading_v1')));

  const balance = async () => p.$eval('#today-view .hb-pill.gold', e => Number(e.textContent.replace(/[^\d]/g, '')));

  // 1) タブは増えない。ヘッダーの GYM の隣に本棚。今日タブに読書の欄
  assert.deepEqual(await p.locator('.tab-btn').evaluateAll(b => b.map(x => x.dataset.tab)), ['today', 'status', 'stats']);
  assert.deepEqual(await p.locator('#app-title .mini-btn').evaluateAll(b => b.map(x => x.textContent.trim())), ['GYM', '本棚', '🧠', '設定']);
  // 1週間前から使っている状態にする(ゴールドは使いはじめた日から数える)
  await p.evaluate(() => { const r = JSON.parse(localStorage.getItem('wt_reward_v1')); r.startedOn = '2026-10-11'; localStorage.setItem('wt_reward_v1', JSON.stringify(r)); });
  await p.reload(); await p.waitForSelector('#rd-today');
  assert.equal(await p.locator('#today-view .hb-card').count(), 5);
  const g0 = await balance();

  // 2) 今日タブから本を追加(全ページ数は必須)
  await p.locator('#rd-today .rd-today-add').click();
  await p.getByLabel('書名').fill('神経診断学を学ぶ人のために');
  await p.getByLabel('著者（任意）').fill('柴﨑浩');
  await p.locator('#rd-sheet button', { hasText: /^保存$/ }).click();
  assert.match(await p.locator('#rd-sheet').innerText(), /全ページ数を入れてください/);
  await p.getByLabel('全ページ数').fill('400');
  await p.locator('#rd-sheet button', { hasText: /^保存$/ }).click();
  await p.waitForSelector('#rd-today .rd-book');
  assert.match(await p.locator('#rd-today .rd-book').innerText(), /p\.0 \/ 400/);
  await shot('reading-today-new.png');

  // 3) 何ページまで進んだか → 2ページで1G
  await p.locator('#rd-today .rd-book').click();
  await p.getByLabel('進んだページ').fill('35');
  await p.getByLabel('進んだページ').blur();
  assert.match(await p.locator('#rd-sheet').innerText(), /\+35ページ ・ \+17G/);
  await shot('reading-page.png');
  await p.locator('#rd-sheet button', { hasText: '記録する' }).click();
  await p.waitForSelector('#rd-sheet', { state: 'hidden' });
  assert.equal(await balance(), g0 + 17);
  assert.match(await p.locator('#rd-today .rd-book').innerText(), /p\.35 \/ 400 ・ この日 \+35ページ ・ \+17G/);
  let d = await saved();
  assert.deepEqual(d.books[0].log, { '2026-10-18': { page: 35 } });

  // 4) 昨日に戻ると昨日は p.0、昨日に20ページまで記録 → 今日の分は +15 に変わり、合計は同じ17G
  await p.locator('.hb-day[data-day="2026-10-17"]').click();
  await p.locator('#rd-today .rd-book').click();
  await p.locator('#rd-sheet .hb-ctrl button', { hasText: '+10' }).click();
  await p.locator('#rd-sheet .hb-ctrl button', { hasText: '+10' }).click();
  await p.locator('#rd-sheet button', { hasText: '記録する' }).click();
  await p.waitForSelector('#rd-sheet', { state: 'hidden' });
  assert.equal(await balance(), g0 + 17);
  await p.locator('.hb-day[data-day="2026-10-18"]').click();
  assert.match(await p.locator('#rd-today .rd-book').innerText(), /この日 \+15ページ/);

  // 5) 読了 → 残りのページ + ボーナス。感想を残す
  await p.locator('#rd-today .rd-book').click();
  await p.locator('#rd-sheet button', { hasText: '読了にする' }).click();
  await p.getByLabel('感想').fill('局在診断の考え方が整理できた');
  await p.getByLabel('感想').blur();
  await p.locator('#rd-sheet button', { hasText: '閉じる' }).click();
  assert.equal(await balance(), g0 + 200 + 100);
  assert.match(await p.locator('#rd-today .rd-book').innerText(), /読了/);
  d = await saved();
  assert.equal(d.books[0].status, 'done');
  assert.equal(d.books[0].finishedOn, '2026-10-18');
  assert.equal(d.books[0].review, '局在診断の考え方が整理できた');
  await shot('reading-today-done.png');

  // 6) 本棚(ヘッダー)に読了の本と感想が残る
  await p.locator('#rd-open').click();
  assert.match(await p.locator('#rd-sheet').innerText(), /これまで読了 1冊/);
  await p.locator('#rd-sheet .hb-seg button', { hasText: '読了' }).click();
  assert.match(await p.locator('#rd-sheet .rd-row').innerText(), /神経診断学を学ぶ人のために[\s\S]*局在診断/);
  await shot('reading-shelf.png');
  await p.locator('#rd-sheet button', { hasText: '閉じる' }).click();
  // 翌日以降の今日タブには出ない
  await p.reload(); await p.waitForSelector('#rd-today');
  assert.equal(await balance(), g0 + 300, 'gold survives reload');
  // 読書のクエスト「本の虫 I」(1冊読了)が受け取れる
  assert.ok(await p.locator('.tab-btn[data-tab="status"]').evaluate(e => e.classList.contains('has-badge')), 'quest badge');

  // 7) 統計: 月・年の読書まとめ
  await p.locator('[data-tab="stats"]').click();
  await p.waitForSelector('#rd-stats');
  assert.match(await p.locator('#rd-stats').innerText(), /1\s*読了[\s\S]*400\s*ページ[\s\S]*2\s*読んだ日/);
  assert.match(await p.locator('#rd-stats').innerText(), /神経診断学を学ぶ人のために/);
  await p.locator('.mode-toggle button', { hasText: '年間' }).click();
  await p.waitForSelector('#rd-stats .rd-months');
  assert.equal(await p.locator('#rd-stats .rd-month-n').nth(9).innerText(), '1');
  await p.locator('#rd-stats').scrollIntoViewIfNeeded(); await shot('reading-stats-year.png');
  await p.locator('.mode-toggle button', { hasText: '週間' }).click();
  await p.locator('.period-nav button').first().click();
  assert.match(await p.locator('#rd-stats').innerText(), /0\s*読了[\s\S]*0\s*ページ/, 'previous week has nothing');

  // 8) 書き出しに入り、復元で戻る。読書データのない古いバックアップでは今の記録を残す
  const exported = await p.evaluate(() => new Promise(res => { BackupFile.save = (n, t) => res(JSON.parse(t)); document.getElementById('export-btn').click(); }));
  assert.equal(exported.readingData.books[0].title, '神経診断学を学ぶ人のために');
  const restore = obj => p.evaluate(t => { BackupFile.pick = cb => cb(t); document.getElementById('import-btn').click(); }, JSON.stringify(obj));
  await restore({ records: {}, habitData: {} });
  assert.equal((await saved()).books.length, 1, 'old backup keeps reading log');
  await restore({ ...exported, readingData: { books: [] } });
  assert.equal((await saved()).books.length, 0);
  await restore(exported);
  assert.equal((await saved()).books[0].review, '局在診断の考え方が整理できた');

  // 9) 本棚から削除
  await p.locator('#rd-open').click();
  await p.locator('#rd-sheet .hb-seg button', { hasText: '読了' }).click();
  await p.locator('#rd-sheet .rd-row').first().click();
  await p.locator('#rd-sheet button', { hasText: '編集' }).click();
  await p.locator('#rd-sheet button', { hasText: '削除' }).click();
  assert.equal((await saved()).books.length, 0);

  assert.deepEqual(errors, []);
  console.log('Reading log: today cards, page gold, finish bonus, shelf, stats, export/restore, delete passed.');
  await browser.close(); server.close();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
