// Optional browser regression checks for 日課 (routines) and 大きなタスク (tasks) in the 今日 tab.
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/todo-ui.cjs
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
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo' });
  await ctx.route(/fonts\.googleapis\.com|accounts\.google\.com/, r => r.abort());
  const p = await ctx.newPage(); p.setDefaultTimeout(10000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.clock.install({ time: new Date('2026-10-18T10:00:00+09:00') });
  await p.goto(base + '/tracker.html');
  await p.waitForSelector('#today-view .hb-card');
  const balance = async () => p.$eval('#today-view .hb-pill.gold', e => Number(e.textContent.replace(/[^\d]/g, '')));
  const todo = () => p.evaluate(() => JSON.parse(localStorage.getItem('wt_todo_v1')));
  const g0 = await balance();

  // 1) ＋ で「習慣・日課・大きなタスク」を選べる。最初はどちらも空
  assert.match(await p.locator('#today-view').innerText(), /大きなタスク[\s\S]*習慣[\s\S]*日課/);
  await p.locator('.hb-add').click();
  assert.deepEqual(await p.locator('#hb-sheet .td-choice .hb-name').allInnerTexts(), ['習慣', '日課', 'やめたいこと', '大きなタスク']);
  if (shots) await p.screenshot({ path: path.join(shots, 'todo-chooser.png') });

  // 2) 日課を2つ追加(朝の歯みがき、夜の薬) → 時間帯ごとに並ぶ
  await p.locator('#hb-sheet .td-choice', { hasText: '日課' }).click();
  await p.locator('#hb-sheet input.field-input').first().fill('歯みがき');
  await p.locator('#hb-sheet .hb-seg button', { hasText: '朝' }).click();
  await p.locator('#hb-sheet .btn-primary', { hasText: '保存' }).click();
  await p.locator('.td-plus[aria-label="日課を追加"]').click();
  await p.locator('#hb-sheet input.field-input').first().fill('薬');
  await p.locator('#hb-sheet .hb-chip', { hasText: '💊' }).click();
  await p.locator('#hb-sheet .hb-seg button', { hasText: '夜' }).click();
  await p.locator('#hb-sheet .btn-primary', { hasText: '保存' }).click();
  assert.deepEqual(await p.locator('.td-slot').allInnerTexts(), ['🌅 朝', '🌙 夜']);
  assert.match(await p.locator('.td-head', { hasText: '日課' }).innerText(), /日課 0\/2/);

  // 3) タップで済み(+2G)、もう一度で戻る。習慣の連続記録やリングには影響しない
  // 1回タップはダブルタップでないと分かってから保存する(見た目はすぐ変わる)
  const tap = async name => { await p.locator('.td-routine', { hasText: name }).click(); await p.clock.runFor(400); };
  const brush = p.locator('.td-routine', { hasText: '歯みがき' });
  await brush.click();
  assert.equal(await brush.getAttribute('aria-pressed'), 'true', 'looks done right away');
  await p.clock.runFor(400);
  assert.equal(await p.locator('.td-routine', { hasText: '歯みがき' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await balance(), g0 + 2);
  assert.match(await p.locator('.td-head', { hasText: '日課' }).innerText(), /日課 1\/2/);
  await tap('歯みがき');
  assert.equal(await balance(), g0);
  await tap('歯みがき');
  // 別の日課を続けてタップしても、両方とも記録される
  await p.locator('.td-routine', { hasText: '薬' }).click();
  await p.locator('.td-routine', { hasText: '歯みがき' }).click();
  assert.equal(await p.locator('.td-routine', { hasText: '歯みがき' }).getAttribute('aria-pressed'), 'false', 'the second routine flips on screen right away');
  await p.clock.runFor(400);
  await tap('歯みがき');
  assert.equal(await balance(), g0 + 4);
  assert.deepEqual(Object.keys((await todo()).rlog['2026-10-18']).length, 2);

  // 3b) 統計タブで日課の連続達成カレンダー(週ごと、新しい週が上)。今日タブには出さない
  assert.equal(await p.locator('#today-view .td-rcal, .td-cal').count(), 0);
  await p.locator('[data-tab="stats"]').click();
  await p.waitForSelector('.td-rcal');
  assert.equal(await p.locator('.td-rcal[data-rid]').count(), 2);
  const cal = p.locator('.td-rcal', { hasText: '歯みがき' });
  assert.match(await cal.innerText(), /🔥1日連続[\s\S]*最長 1日/);
  assert.equal(await cal.locator('.td-rcal-day.today').evaluate(e => e.classList.contains('done')), true);
  assert.equal(await cal.locator('.td-rcal-wk').count(), 9, 'header + 8 weeks');
  await cal.scrollIntoViewIfNeeded();
  if (shots) await p.screenshot({ path: path.join(shots, 'todo-routine-cal.png') });
  // 年間表示では日課も1年ぶんのヒートマップ(2026年は木曜はじまり → 先頭に空き3つ)
  await p.locator('button', { hasText: '年間' }).click();
  await p.waitForSelector('.td-ryear');
  assert.equal(await p.locator('.td-ryear[data-rid]').count(), 2);
  assert.equal(await p.locator('.td-rcal[data-rid] .td-rcal-grid').count(), 0, 'no 8-week grid in year mode');
  const yr = p.locator('.td-ryear', { hasText: '歯みがき' });
  assert.equal(await yr.locator('.hm-ycell').count(), 3 + 365);
  assert.equal(await yr.locator('.hm-ycell.empty').count(), 3);
  assert.equal(await yr.locator('.hm-ycell.today').evaluate(e => e.classList.contains('done')), true);
  assert.match(await yr.innerText(), /この年 1\/1日/);
  assert.equal(await yr.locator('.hm-months div:has-text("12月")').count(), 1);
  if (shots) { await yr.scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(shots, 'todo-routine-year.png') }); }
  await p.locator('button', { hasText: '月間' }).click();
  await p.waitForSelector('.td-rcal-grid');
  await p.locator('[data-tab="today"]').click();
  await p.waitForSelector('#today-view .td-routine');

  // 3c) やめたいこと: やってしまった日だけタップ(✕)。ゴールドは動かず、日課の数にも入らない。統計で守れた日を数える
  const gA = await balance();
  await p.locator('.hb-add').click();
  await p.locator('#hb-sheet .td-choice', { hasText: 'やめたいこと' }).click();
  assert.equal(await p.locator('#hb-sheet .hb-seg').count(), 0, 'no time slot for avoid items');
  await p.locator('#hb-sheet input.field-input').first().fill('夜中のスマホ');
  await p.locator('#hb-sheet .btn-primary', { hasText: '保存' }).click();
  assert.match(await p.locator('.td-slot').last().innerText(), /やめたいこと/);
  const phone = () => p.locator('.td-routine.avoid', { hasText: '夜中のスマホ' });
  assert.match(await p.locator('.td-head', { hasText: '日課' }).innerText(), /日課 2\/2/);
  await phone().click(); await p.clock.runFor(400);
  assert.equal(await phone().getAttribute('aria-pressed'), 'true');
  assert.equal(await phone().locator('.td-check').innerText(), '✕');
  assert.equal(await balance(), gA, 'a slip costs no gold');
  assert.match(await p.locator('.td-head', { hasText: '日課' }).innerText(), /日課 2\/2/);
  await p.locator('[data-tab="stats"]').click();
  await p.waitForSelector('.td-rcal.avoid');
  assert.match(await p.locator('#stats-view').innerText(), /やめたいこと（守れた日）/);
  const av = p.locator('.td-rcal.avoid');
  assert.match(await av.innerText(), /連続なし[\s\S]*最長 0日 ・ 直近30日 守れた 0\/1日/);
  assert.equal(await av.locator('.td-rcal-day.today').evaluate(e => e.classList.contains('slip')), true);
  assert.equal(await p.locator('.td-rcal[data-rid]:not(.avoid)').count(), 2);
  await p.locator('[data-tab="today"]').click();
  await phone().click(); await p.clock.runFor(400); // 取り消すと今日は守れた日
  await p.locator('[data-tab="stats"]').click();
  assert.match(await p.locator('.td-rcal.avoid').innerText(), /🛡1日連続で守れた/);
  if (shots) { await p.locator('.td-rcal.avoid').scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(shots, 'todo-avoid-stats.png') }); }
  await p.locator('[data-tab="today"]').click();
  if (shots) await p.screenshot({ path: path.join(shots, 'todo-avoid-today.png') });

  // 4) ダブルタップで編集(済みの状態は変わらない) → 名前を変える。長押しでは何も起きない
  const med = p.locator('.td-routine', { hasText: '薬' });
  await med.dispatchEvent('pointerdown');
  await p.clock.runFor(700);
  await med.dispatchEvent('pointerup');
  assert.equal(await p.locator('#hb-sheet').evaluate(e => e.style.display === 'flex').catch(() => false), false, 'long press does nothing');
  await med.click();
  await med.click();
  await p.waitForSelector('#hb-sheet .modal-title:has-text("日課を編集")');
  await p.clock.runFor(400);
  assert.equal(await balance(), g0 + 4, 'double tap does not toggle');
  await p.locator('#hb-sheet input.field-input').first().fill('降圧薬');
  await p.locator('#hb-sheet .btn-primary', { hasText: '保存' }).click();
  assert.equal(await p.locator('.td-routine', { hasText: '降圧薬' }).count(), 1);

  // 5) 大きなタスクを追加(期限3日後、ステップ3つ) → 習慣より上に出て、開いた状態でステップが並ぶ
  await p.locator('.td-plus[aria-label="大きなタスクを追加"]').click();
  await p.locator('#hb-sheet input.field-input').first().fill('症例報告');
  await p.locator('#hb-sheet input[type="date"]').fill('2026-10-21');
  await p.locator('#hb-sheet textarea').fill('文献を読む\n図1を作る\n\n考察を書く');
  // 完了したときのゴールドはタスクごとに決める(初期値30G)
  assert.equal(await p.locator('#hb-sheet .hb-step input').inputValue(), '30');
  await p.locator('#hb-sheet .hb-step input').fill('80');
  await p.locator('#hb-sheet .hb-step input').dispatchEvent('change');
  await p.locator('#hb-sheet .btn-primary', { hasText: '追加' }).click();
  const box = p.locator('.td-tbox', { hasText: '症例報告' });
  assert.equal(await box.locator('.td-step').count(), 3);
  assert.ok(await p.evaluate(() => {
    const t = document.querySelector('.td-tbox'), h = [...document.querySelectorAll('#today-view .hb-card')].find(c => !c.classList.contains('td-task'));
    return t.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING;
  }), 'tasks come before habits');
  // その場でステップを足す(入力欄に戻る)。丸をタップして1つ済ませる(+5G)
  const stepInput = () => p.locator('.td-tbox', { hasText: '症例報告' }).locator('.td-addstep input');
  await stepInput().fill('指導医に見せる');
  await stepInput().press('Enter');
  assert.equal(await box.locator('.td-step').count(), 4);
  assert.ok(await stepInput().evaluate(e => document.activeElement === e), 'focus returns to the add-step input');
  await box.locator('.td-step', { hasText: '文献を読む' }).locator('.td-scheck').click();
  assert.equal(await balance(), g0 + 4 + 5);
  assert.equal(await box.locator('.td-step', { hasText: '文献を読む' }).locator('.td-scheck').getAttribute('aria-pressed'), 'true');
  if (shots) await p.screenshot({ path: path.join(shots, 'todo-today.png'), fullPage: true });
  // カードをタップすると閉じる/開く
  await box.locator('.td-task').click();
  assert.equal(await box.locator('.td-step').count(), 0);
  assert.match(await box.innerText(), /あと3日/);
  assert.match(await box.innerText(), /ステップ 1\/4/);
  assert.equal(await box.locator('.td-ticon').getAttribute('aria-label'), 'ステップ 1/4');
  assert.equal(await box.locator('.td-ticon svg circle').count(), 2, 'progress ring around the icon');
  await box.locator('.td-task').click();
  assert.equal(await box.locator('.td-step').count(), 4);

  // 5b) 編集は別画面: 名前・期限を変え、ステップを並べ替えて保存
  await box.locator('.td-tbtn', { hasText: '編集' }).click();
  await p.locator('#hb-sheet input.field-input').first().fill('症例報告を書く');
  await p.locator('#hb-sheet .td-step', { hasText: '指導医に見せる' }).locator('.td-mini', { hasText: '↑' }).click();
  if (shots) await p.screenshot({ path: path.join(shots, 'todo-task-edit.png') });
  await p.locator('#hb-sheet .btn-primary', { hasText: '保存' }).click();
  const card = p.locator('.td-tbox', { hasText: '症例報告を書く' });
  assert.deepEqual(await card.locator('.td-stname').evaluateAll(es => es.map(e => e.firstElementChild.textContent)), ['文献を読む', '図1を作る', '指導医に見せる', '考察を書く']);
  assert.equal((await todo()).tasks[0].steps[0].doneOn, '2026-10-18', 'saving the edit keeps step records');

  assert.match(await card.innerText(), /🪙80G/);

  // 6) 完了にする(+80G) → 演出が出る。今日の一覧に完了として残り、完了したタスクに入る
  await card.locator('.td-tbtn', { hasText: '完了にする' }).click();
  await p.waitForSelector('.td-celebrate');
  assert.match(await p.locator('.td-celebrate').innerText(), /タスク完了！[\s\S]*症例報告を書く[\s\S]*\+80G/);
  if (shots) await p.screenshot({ path: path.join(shots, 'todo-task-clear.png') });
  await p.locator('.td-celebrate').click();
  assert.equal(await balance(), g0 + 4 + 5 + 80);
  assert.ok(await p.locator('.td-task', { hasText: '症例報告' }).evaluate(e => e.classList.contains('done')));
  await p.locator('.td-donelink').click();
  assert.match(await p.locator('#hb-sheet').innerText(), /症例報告[\s\S]*今日に完了/);
  await p.locator('#hb-sheet .hb-chip', { hasText: '戻す' }).click();
  await p.locator('#hb-sheet .btn-secondary', { hasText: '閉じる' }).click().catch(() => {});
  assert.equal(await balance(), g0 + 4 + 5);
  assert.equal(await p.locator('.td-donelink').count(), 0);

  // 7) 昨日の画面でステップを済ませると、昨日の記録になる
  await p.locator('.hb-day[data-day="2026-10-17"]').click();
  const y = p.locator('.td-tbox', { hasText: '症例報告' });
  if (!(await y.locator('.td-step').count())) await y.locator('.td-task').click();
  assert.match(await y.innerText(), /昨日 に済ませたことになります/);
  await y.locator('.td-step', { hasText: '図1を作る' }).locator('.td-scheck').click();
  const fig = (await todo()).tasks[0].steps.find(x => x.name === '図1を作る');
  assert.equal(fig.doneOn, '2026-10-17');
  // 昨日には今日作った日課は出ない
  assert.match(await p.locator('#today-view').innerText(), /歯みがき・薬など/);
  await p.locator('.hb-day[data-day="2026-10-18"]').click();

  // 8) 日課を消す: 今日やっていれば今日は残り、明日から出ない。ゴールドは残る
  const before = await balance();
  const brush2 = p.locator('.td-routine', { hasText: '歯みがき' });
  await brush2.click();
  await brush2.click();
  await p.locator('#hb-sheet .btn-secondary', { hasText: '削除' }).click();
  assert.equal(await balance(), before);
  assert.equal((await todo()).routines.find(r => r.name === '歯みがき').archivedOn, '2026-10-19');
  // 消した日課は統計にも出さない(ほかの日課は出る)
  await p.locator('[data-tab="stats"]').click();
  await p.waitForSelector('.td-rcal');
  assert.equal(await p.locator('.td-rcal', { hasText: '歯みがき' }).count(), 0);
  assert.ok(await p.locator('.td-rcal', { hasText: '降圧薬' }).count() >= 1);
  await p.locator('[data-tab="today"]').click();
  await p.waitForSelector('#today-view .hb-card');

  // 9) 再読み込みしても残る。バックアップに含まれる
  await p.reload(); await p.waitForSelector('#today-view .hb-card');
  assert.equal(await p.locator('.td-task', { hasText: '症例報告' }).count(), 1);
  assert.equal(await balance(), before);

  assert.deepEqual(errors, []);
  console.log('Todo UI: add chooser, routines (slots, toggle gold, edit, delete), tasks (steps, order, done, back-dating), reload passed.');
  await browser.close(); server.close();
})().catch(e => { console.error(e); server.close(); process.exit(1); });
