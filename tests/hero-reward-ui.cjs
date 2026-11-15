// Optional browser regression check for the 達成度ごほうび (hero reward) layer.
// NODE_PATH=<path containing playwright> node tests/hero-reward-ui.cjs [screenshot-dir]
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const shots = process.argv[2];
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); res.end(data); });
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo', deviceScaleFactor: 2 });
  await ctx.route(/fonts\.googleapis\.com|accounts\.google\.com/, r => r.abort());
  const p = await ctx.newPage(); p.setDefaultTimeout(10000);
  p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept());
  await p.clock.install({ time: new Date('2026-11-15T10:00:00+09:00') });
  await p.goto(base + '/tracker.html');
  await p.waitForSelector('#today-view .hb-card');
  const shot = async n => { if (shots) await p.screenshot({ path: path.join(shots, n) }); };
  const status = async () => { await p.locator('.tab-btn[data-tab="status"]').click(); await p.waitForSelector('.hero-compact .hero-sprite-box'); await p.waitForTimeout(300); };
  const stage = () => p.$eval('.hero-compact .hero-sprite-box', b => [0, 1, 2, 3].find(i => b.classList.contains('hr-s' + i)));

  // 1) まだ何もしていない日は「だらっと」。拡大するとセリフが出て、キャラのタップでは閉じない
  await status();
  assert.equal(await stage(), 0);
  await shot('hero-s0.png');
  await p.locator('.hero-compact .hero-sprite-box').click();
  await p.waitForSelector('#hero-zoom .hr-bubble');
  const first = await p.locator('#hero-zoom .hr-bubble').innerText();
  await p.locator('#hero-zoom .hero-sprite-clip').click();
  assert.ok(await p.locator('#hero-zoom').isVisible(), 'tapping the hero keeps the viewer open');
  assert.notEqual(await p.locator('#hero-zoom .hr-bubble').innerText(), first, 'tapping changes the line');
  assert.equal(await p.locator('#hero-zoom .hr-cut-btn').count(), 0);
  await shot('hero-zoom-s0.png');
  await p.locator('#hero-zoom .hero-zoom-hint').click();
  assert.ok(!(await p.locator('#hero-zoom').isVisible()));

  // 2) 習慣を全部こなすと「仕上がった」、ごほうびカットが開ける
  await p.locator('.tab-btn[data-tab="today"]').click();
  const total = await p.locator('#today-view .hb-card').count();
  for (let i = 0; i < total; i++) {
    const card = p.locator('#today-view .hb-card').nth(i);
    if (await card.evaluate(c => c.classList.contains('done'))) continue;
    if (/読書/.test(await card.innerText())) continue; // 読書は本棚から記録するので、ここでは飛ばす
    await card.locator('.hb-ring').click();
    await p.waitForTimeout(150);
    if (await p.locator('.hb-celebrate').count()) await p.locator('.hb-celebrate').click();
    if (await p.locator('#hb-sheet').isVisible().catch(() => false)) {
      // 時間・回数の習慣はシートで記録する
      const plus = p.locator('#hb-sheet .hb-ctrl button').last();
      for (let k = 0; k < 8 && await plus.count(); k++) await plus.click();
      await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click().catch(() => {});
    }
    if (i === 1) { await status(); assert.ok([1, 2].includes(await stage())); await shot('hero-s1.png'); await p.locator('.tab-btn[data-tab="today"]').click(); }
  }
  const prog = await p.evaluate(() => window.HabitUI.todayProgress());
  console.log('progress', prog.done, '/', prog.due);
  await status();
  await shot('hero-after.png');
  assert.ok(prog.done >= 2 && prog.done < prog.due, 'reading is still open, so not all done');
  assert.equal(await stage(), 2);
  // 全部こなした日の見た目は、数え方だけ差し替えて確かめる
  await p.evaluate(() => { const f = window.HabitUI.todayProgress; window.HabitUI.todayProgress = () => { const r = f(); return { ...r, done: r.due }; }; });
  await p.locator('.tab-btn[data-tab="today"]').click();
  await status();
  {
    assert.equal(await stage(), 3);
    await shot('hero-s3.png');
    await p.locator('.hero-compact .hero-sprite-box').click();
    await p.locator('#hero-zoom .hero-sprite-clip').click();
    await p.waitForTimeout(250);
    await shot('hero-zoom-s3.png');
    await p.locator('#hero-zoom .hr-cut-btn').click();
    await p.waitForSelector('#hr-cut .hr-cut-title');
    await p.waitForTimeout(400);
    await shot('hero-cut.png');
    await p.locator('#hr-cut').click();
    await p.locator('#hero-zoom .hero-zoom-hint').click();
  }

  // 3) 設定で OFF にするとエフェクトが消える
  await p.locator('#menu-open').click();
  await p.locator('#hr-toggle').click();
  await status();
  assert.equal(await stage(), undefined);
  await p.locator('.hero-compact .hero-sprite-box').click();
  assert.equal(await p.locator('#hero-zoom .hr-bubble').count(), 0);

  assert.deepEqual(errors, []);
  console.log('hero-reward-ui: ok');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
