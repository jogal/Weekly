// Optional browser checks for the gym record sheet (Main Quest input from the bottom).
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/record-sheet-ui.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname,'..');
const mime = {'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.json':'application/json'};
const server = http.createServer((req,res)=>{
  const url = new URL(req.url,'http://localhost');
  const file = path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/gym.html':url.pathname));
  if(!file.startsWith(root+path.sep)) {res.writeHead(403).end();return;}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  const errors=[];
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Tokyo'});
  await ctx.route(/fonts\.googleapis\.com/,route=>route.abort());
  const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.clock.install({time:new Date('2026-11-23T10:00:00+09:00')});
  await p.goto(base+'/gym.html');await p.waitForSelector('#quest-hero');
  const sheet=p.locator('#rec-sheet');
  const logs=()=>p.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')||'[]'));
  const scroll=()=>p.evaluate(()=>document.getElementById('content').scrollTop);
  // Tapping a row opens the sheet without scrolling the page.
  const before=await scroll();
  await p.locator('[data-exercise="ベンチプレス"]').click();
  assert.equal(await scroll(),before);
  assert.match(await sheet.locator('#sheet-title').innerText(),/ベンチプレス/);
  // Quick weight buttons and instant ± (pointerdown).
  await sheet.getByRole('button',{name:'重量 +20kg'}).click();
  await sheet.getByRole('button',{name:'重量 +20kg'}).click();
  await sheet.getByRole('button',{name:'重量 −5kg'}).click();
  await sheet.getByRole('button',{name:'重量を2.5kg増やす'}).dispatchEvent('pointerdown');
  await sheet.getByRole('button',{name:'重量を2.5kg増やす'}).dispatchEvent('pointerup');
  assert.match(await sheet.getByLabel('重量を入力').innerText(),/37\.5/);
  // Keypad replaces the browser prompt; 自重 sets 0.
  await sheet.getByLabel('重量を入力').click();
  for(const k of ['6','2','.','5']) await sheet.getByRole('button',{name:k,exact:true}).click();
  assert.match(await sheet.getByLabel('重量を入力').innerText(),/62\.5/);
  await sheet.getByRole('button',{name:'決定'}).click();
  await sheet.getByRole('button',{name:'回数を1回減らす'}).click();
  assert.match(await sheet.locator('#log-btn').innerText(),/1セット目/);
  await sheet.locator('#log-btn').click();
  assert.deepEqual((await logs()).map(l=>[l.ex,l.kg,l.reps]),[['ベンチプレス',62.5,9]]);
  assert.match(await sheet.locator('#log-btn').innerText(),/2セット目/);
  assert.equal(await sheet.locator('.sheet-set').count(),1);
  // Toast undo removes the set; the sheet stays open.
  assert.match(await p.locator('#toast').innerText(),/ベンチプレス 62\.5kg×9/);
  await p.locator('#toast .toast-action').click();
  assert.equal((await logs()).length,0);
  assert.equal(await sheet.count(),1);
  await sheet.locator('#log-btn').click();
  // Row shows today's content; next-exercise jumps inside the sheet.
  const next=await sheet.locator('.sheet-next b').innerText();
  await sheet.locator('.sheet-next').click();
  assert.equal(await sheet.locator('#sheet-title').innerText(),next);
  await sheet.getByRole('button',{name:'前の種目'}).click();
  assert.match(await sheet.locator('#sheet-title').innerText(),/ベンチプレス/);
  // … menu holds pain / step / warmup; picking pain shows a badge.
  await sheet.locator('.sheet-menu summary').click();
  await sheet.getByRole('button',{name:'痛みあり',exact:true}).click();
  assert.equal(await sheet.locator('.pain-badge').count(),1);
  // Escape (or ✕) closes; backdrop tap closes too.
  await p.keyboard.press('Escape');
  assert.equal(await sheet.count(),0);
  assert.match(await p.locator('[data-exercise="ベンチプレス"] .quest-ex-meta').innerText(),/62\.5kg×9・1セット/);
  assert.match(await p.locator('.quest-next').innerText(),/あと2種目でクリア/);
  assert.match(await p.locator('.quest-part-tab[data-part="chest"]').innerText(),/1\/2/);
  await p.locator('[data-exercise="インクラインダンベルプレス"]').click();
  await sheet.locator('.sheet-back').click({position:{x:20,y:20}});
  assert.equal(await sheet.count(),0);
  // Main Quest以外 opens a picker in the same sheet.
  await p.locator('.quest-more summary').click();
  await p.getByRole('button',{name:'Main Quest以外の種目'}).click();
  await sheet.getByRole('button',{name:'腕',exact:true}).click();
  await sheet.locator('.ex-btn').first().click();
  assert.equal(await sheet.locator('#log-btn').count(),1);
  for(const width of [320,430]){
    await p.setViewportSize({width,height:700});
    assert.ok(await p.evaluate(()=>document.querySelector('.sheet-box').scrollWidth<=innerWidth),`sheet overflow ${width}`);
  }
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Record sheet passed: no scroll jump, quick weights, instant ±, keypad, set count, toast undo, next/prev, menu+pain, close, picker, widths.');
  await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1);});
