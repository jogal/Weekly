// Optional browser regression checks for the quest board.
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/quest-ui.cjs
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
// 今日(2026-10-18)からさかのぼって: 英語31日×60分、自炊12日、専門医は合計4.5時間
function seedRecords() {
  const DK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const pad = n => String(n).padStart(2, '0');
  const key = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const rec = {};
  const put = (back, cat, r) => {
    const d = new Date(Date.UTC(2026, 9, 18 - back));
    const wd = (d.getUTCDay() + 6) % 7;
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - wd);
    ((rec[key(mon)] ||= {})[DK[wd]] ||= {})[cat] = { done: true, note: '', duration: '', rating: 0, ...r };
  };
  for (let i = 1; i <= 31; i++) put(i, 'english', { duration: '60' });
  for (let i = 1; i <= 12; i++) put(i, 'cooking', {});
  put(1, 'medicine', { duration: '150' }); put(2, 'medicine', { duration: '120' });
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
  const reward = () => p.evaluate(() => JSON.parse(localStorage.getItem('wt_reward_v1')));
  const balance = async () => p.$eval('#today-view .hb-pill.gold', e => Number(e.textContent.replace(/[^\d]/g, '')));

  // 1) これまでの記録で達成済みのクエストがあると、今日タブと育成タブに出る
  const strip = p.locator('.hb-quest.ready');
  await strip.waitFor();
  const readyN = Number((await strip.innerText()).match(/(\d+)件/)[1]);
  assert.ok(readyN >= 3, `ready quests: ${readyN}`);
  assert.ok(await p.locator('.tab-btn[data-tab="status"]').evaluate(e => e.classList.contains('has-badge')));
  if (shots) await p.screenshot({ path: path.join(shots, 'quest-today-ready.png') });
  const gold0 = await balance();

  // 2) 掲示板を開く → 受け取れるものが先頭。台所の主 I を受け取る
  await strip.click();
  await p.waitForSelector('#hb-sheet .qb-row');
  assert.ok(await p.locator('#hb-sheet .qb-row').first().evaluate(e => e.classList.contains('ready')));
  assert.ok(await p.locator('#hb-sheet .qb-btn:disabled', { hasText: 'ロック中' }).count() > 0);
  if (shots) await p.screenshot({ path: path.join(shots, 'quest-board.png') });
  await p.locator('#hb-sheet .qb-row', { hasText: '台所の主 I' }).locator('.qb-btn').click();
  await p.waitForSelector('.hb-celebrate');
  assert.match(await p.locator('.hb-celebrate').innerText(), /QUEST CLEAR[\s\S]*台所の主 I[\s\S]*\+50G/);
  await p.locator('.hb-celebrate').click();
  const kitchen2 = p.locator('#hb-sheet .qb-row', { hasText: '台所の主 II' });
  assert.match(await kitchen2.innerText(), /12\/50日[\s\S]*200G ＋ 🍲灯りの台所/);
  assert.ok(await kitchen2.locator('.qb-btn').isDisabled());

  // 3) ことばの旅 I → II を続けて受け取ると、オウムが手に入り装備される
  await p.locator('#hb-sheet .qb-row', { hasText: 'ことばの旅 I' }).first().locator('.qb-btn').click();
  await p.locator('.hb-celebrate').click();
  await p.locator('#hb-sheet .qb-row', { hasText: 'ことばの旅 II' }).locator('.qb-btn').click();
  assert.match(await p.locator('.hb-celebrate').innerText(), /オウムを手に入れた（装備しました）/);
  if (shots) await p.screenshot({ path: path.join(shots, 'quest-clear.png') });
  await p.locator('.hb-celebrate').click();
  assert.match(await p.locator('#hb-sheet .qb-row', { hasText: 'ことばの旅 III' }).innerText(), /31\/100時間/);
  let r = await reward();
  assert.deepEqual(Object.keys(r.quests.claimed).sort(), ['cooking_days:0', 'english_hours:0', 'english_hours:1']);
  assert.equal(r.equipped.pet, 'p_parrot');

  // 4) 達成の記録
  await p.locator('#hb-sheet .hb-seg button', { hasText: '達成の記録' }).click();
  assert.equal(await p.locator('#hb-sheet .qb-log').count(), 3);
  await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();
  assert.equal(await balance(), gold0 + 50 + 60 + 150);

  // 5) 育成タブ: おともが表示され、クエストカードがある。ショップでは限定品は買えない
  await p.locator('[data-tab="status"]').click();
  await p.waitForSelector('#status-view .qb-row');
  assert.equal(await p.locator('#status-view .hero-pet').innerText(), '🦜');
  await p.locator('#status-view .btn-primary', { hasText: 'ショップ' }).click();
  await p.locator('#hb-sheet .hb-seg button', { hasText: 'おとも' }).click();
  assert.match(await p.locator('#hb-sheet .shop-row', { hasText: 'オウム' }).innerText(), /ことばの旅 II[\s\S]*はずす/);
  const roo = p.locator('#hb-sheet .shop-row', { hasText: 'カンガルー' });
  assert.match(await roo.innerText(), /脚の日 II/);
  assert.ok(await roo.locator('.shop-btn').isDisabled());
  await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();
  if (shots) await p.screenshot({ path: path.join(shots, 'quest-growth.png'), fullPage: false });

  // 6) 残りを受け取りきるとバッジが消え、今日タブは「あと少し」のクエストを出す
  for (let i = 0; i < 20; i++) {
    const btn = p.locator('#status-view .qb-btn.ready').first();
    if (!(await btn.count())) break;
    await btn.click();
    await p.locator('.hb-celebrate').click();
    if (await p.locator('#hb-sheet').evaluate(e => e.style.display === 'flex').catch(() => false))
      await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();
  }
  assert.equal(await p.locator('.tab-btn[data-tab="status"]').evaluate(e => e.classList.contains('has-badge')), false);
  await p.locator('[data-tab="today"]').click();
  const near = p.locator('.hb-quest:not(.ready)');
  await near.waitFor();
  assert.match(await near.innerText(), /\d+(\.\d)?\/\d+/);
  if (shots) await p.screenshot({ path: path.join(shots, 'quest-today-next.png') });

  // 7) 再読み込みしても受け取り状態とゴールドはそのまま
  const goldBefore = await balance();
  r = await reward();
  await p.reload(); await p.waitForSelector('#today-view .hb-card');
  assert.equal(await balance(), goldBefore);
  assert.deepEqual((await reward()).quests.claimed, r.quests.claimed);

  // 8) はみ出しなし(今日タブのクエスト表示・掲示板)
  for (const width of [320, 375, 430]) {
    await p.setViewportSize({ width, height: 844 });
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `today ${width} overflow`);
    await p.locator('.hb-quest').click();
    assert.equal(await p.locator('#hb-sheet .modal-box').evaluate(e => e.scrollWidth > e.clientWidth), false, `board ${width} overflow`);
    await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click();
  }

  assert.deepEqual(errors, []);
  console.log('Quest board: ready strip, badge, claim chain, item reward and equip, history, shop lock, badge clear, reload, widths passed.');
  await browser.close(); server.close();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
