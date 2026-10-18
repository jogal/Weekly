// Optional browser regression checks for js/pwa-update.js (新しい版の自動反映).
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/pwa-update-ui.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
let swVersion = 1;   // テストの途中で sw.js の中身(キャッシュ名)を変えて「新しい版」を出す
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/tracker.html' : url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    if (url.pathname === '/sw.js') data = Buffer.from(String(data).replace(/const CACHE = "([^"]+)"/, `const CACHE = "$1-qa${swVersion}"`));
    res.end(data);
  });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const errors = [];

  // 4画面とも共通スクリプトで登録され、ステータスバーは不透明の black
  for (const page of ['tracker', 'gym', 'music', 'spots']) {
    const html = fs.readFileSync(path.join(root, page + '.html'), 'utf8');
    assert.match(html, /apple-mobile-web-app-status-bar-style" content="black"/, page);
    assert.match(html, /<script src="js\/pwa-update\.js"><\/script>/, page);
    assert.doesNotMatch(html, /serviceWorker\.register/, `${page} registers only via pwa-update.js`);
  }

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/fonts\.googleapis\.com|accounts\.google\.com/, r => r.abort());
  const p = await ctx.newPage(); p.setDefaultTimeout(15000);
  p.on('pageerror', e => errors.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('wq_sw_dev', '1');   // http の手元サーバーでも登録させる
    sessionStorage.setItem('qa-loads', String(Number(sessionStorage.getItem('qa-loads') || 0) + 1));
  });
  const loads = () => p.evaluate(() => Number(sessionStorage.getItem('qa-loads')));

  // 1) 初めて入れた時は、Service Worker が制御を始めても読み込み直さない
  await p.goto(base + '/tracker.html');
  await p.waitForFunction(() => !!navigator.serviceWorker.controller);
  await sleep(1500);
  assert.equal(await loads(), 1);

  // 2) 開き直すと制御下で起動する
  await p.reload(); await p.waitForSelector('#today-view');
  assert.ok(await p.evaluate(() => !!navigator.serviceWorker.controller));
  assert.equal(await loads(), 2);

  // 3) 新しい版が出た。設定シートを開いている間は読み込み直さない
  await p.locator('#menu-open').click();
  swVersion = 2;
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // 画面に戻ってきた
  await p.waitForFunction(async () => (await caches.keys()).some(k => k.endsWith('-qa2')));
  await sleep(2500);
  assert.equal(await loads(), 2, 'no reload while a sheet is open');

  // 4) シートを閉じると、新しい版で読み込み直す
  await p.locator('#menu-close').click();
  await p.waitForFunction(() => Number(sessionStorage.getItem('qa-loads')) === 3, null, { timeout: 10000 });
  await p.waitForSelector('#today-view');
  const keys = await p.evaluate(() => caches.keys());
  assert.ok(keys.some(k => k.endsWith('-qa2')) && !keys.some(k => k.endsWith('-qa1')), keys.join(','));

  // 5) 新しい版になった後は、それ以上読み込み直さない
  await sleep(5000);
  assert.equal(await loads(), 3);

  assert.deepEqual(errors, []);
  console.log('PWA update: solid status bar on four pages, no reload on first install, waits for open sheet, reloads once on new version.');
  await browser.close(); server.close();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
