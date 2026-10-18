// Optional browser regression checks for reward tickets (ごほうびチケット).
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/ticket-ui.cjs
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
  const errors = [], dialogs = [];
  const shots = process.env.QA_SCREENSHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo' });
  await ctx.route(/fonts\.googleapis\.com|accounts\.google\.com/, r => r.abort());
  const p = await ctx.newPage(); p.setDefaultTimeout(10000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await p.clock.install({ time: new Date('2026-10-18T10:00:00+09:00') });
  await p.goto(base + '/tracker.html');
  await p.waitForSelector('#today-view .hb-card');
  const reward = () => p.evaluate(() => JSON.parse(localStorage.getItem('wt_reward_v1')));
  const balance = async () => p.$eval('#today-view .hb-pill.gold', e => Number(e.textContent.replace(/[^\d]/g, '')));
  // 直近7日に1日100Gずつ稼いだ状態＋手持ち2,000Gにする
  await p.evaluate(() => {
    const r = JSON.parse(localStorage.getItem('wt_reward_v1'));
    for (let i = 11; i <= 17; i++) r.days[`2026-10-${i}`] = { items: { h_medicine: { g: 100, streak: 1, unit: 'd', ms: 0 } }, perfect: 0 };
    r.grants.push({ g: 1200, reason: 'qa', on: '2026-10-18' });
    localStorage.setItem('wt_reward_v1', JSON.stringify(r));
  });
  await p.locator('[data-tab="today"]').click();
  assert.equal(await balance(), 2000);
  assert.equal(await p.locator('.hb-pill.tk').count(), 0, 'no ticket pill without tickets');

  // 1) ゴールドを押すとショップの「ごほうび」が開く。初期の3つと日数の目安
  await p.locator('.hb-pill.gold').click();
  await p.waitForSelector('#hb-sheet .shop-row');
  assert.equal(await p.locator('#hb-sheet .hb-seg button.on').innerText(), 'ごほうび');
  const sauna = p.locator('#hb-sheet .shop-row', { hasText: 'サウナに行く' });
  assert.match(await sauna.innerText(), /頑張り約7日分/);
  assert.equal(await p.locator('#hb-sheet .shop-row').count(), 3);
  if (shots) await p.screenshot({ path: path.join(shots, 'ticket-shop.png') });

  // 2) サウナのチケットを買う(確認あり) → 1,300G、所持1枚
  await sauna.locator('.shop-btn').click();
  assert.match(dialogs.at(-1), /サウナに行く.*700G/);
  assert.match(await p.locator('#hb-sheet .hb-pill').innerText(), /1,300/);
  assert.match(await p.locator('#hb-sheet .shop-row', { hasText: 'サウナに行く' }).innerText(), /所持 1枚/);
  assert.ok(await p.locator('#hb-sheet .shop-row', { hasText: '買い物チケット' }).locator('.shop-btn').isDisabled(), 'not enough gold');

  // 3) ごほうびを追加: 映画 500G → 買う → 値段を800Gに変えても、買ったチケットは500Gのまま
  await p.locator('#hb-sheet .wish-add').click();
  await p.locator('#hb-sheet input.field-input').first().fill('映画を観る');
  await p.locator('#hb-sheet .hb-chip', { hasText: '🎬' }).click();
  await p.locator('#hb-sheet .hb-step input').fill('500');
  await p.locator('#hb-sheet .hb-step input').dispatchEvent('change');
  assert.match(await p.locator('#hb-sheet').innerText(), /頑張り約5日分/);
  if (shots) await p.screenshot({ path: path.join(shots, 'ticket-editor.png') });
  await p.locator('#hb-sheet .btn-primary', { hasText: '保存' }).click();
  const movie = p.locator('#hb-sheet .shop-row', { hasText: '映画を観る' });
  await movie.locator('.shop-btn').click();
  await movie.locator('.wish-edit').click();
  await p.locator('#hb-sheet .hb-step input').fill('800');
  await p.locator('#hb-sheet .hb-step input').dispatchEvent('change');
  await p.locator('#hb-sheet .btn-primary', { hasText: '保存' }).click();
  assert.match(await p.locator('#hb-sheet .shop-row', { hasText: '映画を観る' }).locator('.shop-btn').innerText(), /800G/);
  await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();
  assert.equal(await balance(), 800);

  // 4) 今日タブにチケット表示 → チケット画面で使う(1回だけ)
  assert.equal(await p.locator('.hb-pill.tk').innerText(), '🎟️ 2');
  await p.locator('.hb-pill.tk').click();
  await p.waitForSelector('#hb-sheet .tk-row');
  assert.match(await p.locator('#hb-sheet .tk-row', { hasText: '映画を観る' }).innerText(), /500G/);
  if (shots) await p.screenshot({ path: path.join(shots, 'ticket-list.png') });
  await p.locator('#hb-sheet .tk-row', { hasText: 'サウナに行く' }).locator('.tk-use').click();
  assert.match(dialogs.at(-1), /使ったチケットは戻せません/);
  await p.waitForSelector('.hb-celebrate');
  assert.match(await p.locator('.hb-celebrate').innerText(), /REWARD TIME[\s\S]*サウナに行く/);
  assert.doesNotMatch(await p.locator('.hb-celebrate').innerText(), /\+.*G/);
  if (shots) await p.screenshot({ path: path.join(shots, 'ticket-used.png') });
  await p.locator('.hb-celebrate').click();
  assert.equal(await p.locator('#hb-sheet .tk-row').count(), 1);
  await p.locator('#hb-sheet .hb-seg button', { hasText: '使用済み' }).click();
  const usedRow = p.locator('#hb-sheet .tk-row.used', { hasText: 'サウナに行く' });
  assert.match(await usedRow.innerText(), /使用 10\/18/);
  assert.equal(await usedRow.locator('.tk-use').count(), 0, 'a used ticket cannot be used again');
  await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();
  assert.equal(await balance(), 800, 'using a ticket does not cost gold');

  // 5) ごほうびを消しても、買ったチケットは残る
  await p.locator('.hb-pill.gold').click();
  await p.locator('#hb-sheet .shop-row', { hasText: '映画を観る' }).locator('.wish-edit').click();
  await p.locator('#hb-sheet .btn-secondary', { hasText: '削除' }).click();
  assert.equal(await p.locator('#hb-sheet .shop-row', { hasText: '映画を観る' }).count(), 0);
  assert.match(await p.locator('#hb-sheet .tk-link').innerText(), /1枚/);
  await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();

  // 6) 育成タブからもチケットを開ける
  await p.locator('[data-tab="status"]').click();
  await p.locator('#status-view .rw-tk').click();
  assert.match(await p.locator('#hb-sheet .tk-row').innerText(), /映画を観る/);
  await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();

  // 7) 再読み込みしても状態はそのまま
  await p.locator('[data-tab="today"]').click();
  const before = await reward();
  await p.reload(); await p.waitForSelector('#today-view .hb-card');
  const after = await reward();
  assert.deepEqual(after.tickets, before.tickets);
  assert.deepEqual(after.tickets.map(t => [t.name, t.price, !!t.usedOn]), [['サウナに行く', 700, true], ['映画を観る', 500, false]]);
  assert.equal(await balance(), 800);

  // 8) チケット表示があっても狭い画面ではみ出さない
  for (const width of [320, 375]) {
    await p.setViewportSize({ width, height: 700 });
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `today ${width} overflow`);
    await p.locator('.hb-pill.gold').click();
    assert.equal(await p.locator('#hb-sheet .modal-box').evaluate(e => e.scrollWidth > e.clientWidth), false, `shop ${width} overflow`);
    if (shots && width === 320) await p.screenshot({ path: path.join(shots, 'ticket-shop-320.png') });
    await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();
  }
  if (shots) { await p.setViewportSize({ width: 320, height: 700 }); await p.screenshot({ path: path.join(shots, 'ticket-today-320.png') }); }

  assert.deepEqual(errors, []);
  console.log('Reward tickets: default list, estimate, buy, add/edit/delete wish, ticket snapshot, use once, history, reload, narrow widths passed.');
  await browser.close(); server.close();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
