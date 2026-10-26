// Optional browser regression checks for the AI受け取り箱 (Notion inbox via Apps Script, mocked here).
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/inbox-ui.cjs
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
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo' });
  await ctx.route(/fonts\.googleapis\.com|accounts\.google\.com/, r => r.abort());
  // Apps Script のモック。取り込み済みの印を付けた行は次から返さない
  const EXEC = 'https://script.google.com/macros/s/TEST/exec';
  const rows = [
    { id: 'row-en-1', kind: '英語', title: 'TOEIC Part5', date: '2026-10-26', minutes: 20, questions: 20, correct: 18, note: '', steps: '', gold: null },
    { id: 'row-en-2', kind: '英語', title: '音読', date: '2026-10-26', minutes: 15, questions: null, correct: null, note: '', steps: '', gold: null },
    { id: 'row-task', kind: 'タスク', title: '学会スライド', date: '2026-11-20', minutes: null, questions: null, correct: null, note: '', steps: '構成を決める\n図を作る', gold: null },
    { id: 'row-bad', kind: '', title: '?', date: null, minutes: null, questions: null, correct: null, note: '', steps: '', gold: null },
  ];
  const acked = new Set(); const calls = [];
  await ctx.route(/script\.google\.com/, r => {
    const u = new URL(r.request().url()); calls.push(u.search);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (u.searchParams.get('key') !== 'passphrase-123') return r.fulfill({ status: 200, headers: cors, body: JSON.stringify({ error: 'unauthorized' }) });
    if (u.searchParams.get('ack')) { u.searchParams.get('ack').split(',').forEach(id => acked.add(id)); return r.fulfill({ status: 200, headers: cors, body: JSON.stringify({ acked: 1 }) }); }
    return r.fulfill({ status: 200, headers: cors, body: JSON.stringify({ items: rows.filter(x => !acked.has(x.id)) }) });
  });
  const p = await ctx.newPage(); p.setDefaultTimeout(10000);
  p.on('pageerror', e => errors.push(e.message));
  await p.clock.install({ time: new Date('2026-10-26T21:00:00+09:00') });
  await p.goto(base + '/tracker.html');
  await p.waitForSelector('#today-view .hb-card');

  // 1) 形式違いの接続コードは保存しない
  await p.locator('#menu-open').click();
  await p.locator('#inbox-open').click();
  await p.locator('#inbox-code').fill('https://example.com/exec|passphrase-123');
  await p.locator('#inbox-save').click();
  assert.match(await p.locator('#inbox-status').innerText(), /形式が違います/);
  // 合い言葉違いはエラーを出して保存しない
  await p.locator('#inbox-code').fill(EXEC + '|wrong-pass');
  await p.locator('#inbox-save').click();
  await p.waitForFunction(() => /接続失敗/.test(document.getElementById('inbox-status').textContent));
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('wt_inbox_v1') || 'null')?.url || ''), '');

  // 2) 正しいコードで接続 → その場で取り込む
  await p.locator('#inbox-code').fill(EXEC + '|passphrase-123');
  await p.locator('#inbox-save').click();
  await p.waitForFunction(() => /接続できました/.test(document.getElementById('inbox-status').textContent));
  assert.match(await p.locator('#inbox-status').innerText(), /英語 2件・タスク 1件・読めない行 1件/);
  const rec = await p.evaluate(() => JSON.parse(localStorage.getItem('wt_records')));
  const en = rec['2026-10-26'].mon.english;
  assert.equal(en.done, true);
  assert.equal(en.duration, '35');
  assert.equal(en.note, '🤖 TOEIC Part5 20問中18問正解（90%） / 🤖 音読');
  const todo = await p.evaluate(() => JSON.parse(localStorage.getItem('wt_todo_v1')));
  assert.equal(todo.tasks.length, 1);
  assert.deepEqual(todo.tasks[0].steps.map(s => s.name), ['構成を決める', '図を作る']);
  assert.equal(todo.tasks[0].due, '2026-11-20');
  assert.deepEqual([...acked].sort(), ['row-en-1', 'row-en-2', 'row-task']);
  await p.locator('#inbox-close').click();
  assert.equal(await p.locator('.td-task', { hasText: '学会スライド' }).count(), 1);

  // 3) 印付けに失敗して同じ行がまた届いても、二重に記録しない
  acked.delete('row-en-1');
  const n0 = calls.length;
  await p.reload(); await p.waitForSelector('#today-view .hb-card');
  for (let i = 0; i < 100 && !acked.has('row-en-1'); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(calls.length > n0, 'pulls again on open');
  const rec2 = await p.evaluate(() => JSON.parse(localStorage.getItem('wt_records')));
  assert.equal(rec2['2026-10-26'].mon.english.duration, '35');
  assert.ok(acked.has('row-en-1'), 'seen row is acked again');
  assert.equal((await p.evaluate(() => JSON.parse(localStorage.getItem('wt_todo_v1')))).tasks.length, 1);

  assert.deepEqual(errors, []);
  console.log('Inbox UI: connection validation, import of English/tasks, unreadable rows left, ack + no double import on reload passed.');
  await browser.close(); server.close();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
