// Optional browser checks for the 宅トレ card on the gym きろく tab.
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/home-workout-ui.cjs
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
  // An old (pre-weight) log must keep working and stay bodyweight.
  await p.addInitScript(()=>{ if(!localStorage.getItem('gym_home_v1')) localStorage.setItem('gym_home_v1',JSON.stringify({v:1,custom:[],
    logs:[{t:'2026-11-20T07:00:00+09:00',ex:'腕立て伏せ',n:15,unit:'reps'}]})); });
  await p.goto(base+'/gym.html');await p.waitForSelector('#quest-hero');
  const card=p.locator('#home-quest');
  const sheet=p.locator('#rec-sheet');
  const store=()=>p.evaluate(()=>JSON.parse(localStorage.getItem('gym_home_v1')));
  // No record today and never opened: collapsed to one line.
  assert.equal(await card.locator('.home-chip').count(),0);
  await card.locator('.home-head').click();
  assert.equal(await card.locator('.home-head').getAttribute('aria-expanded'),'true');
  // Recently used first; every exercise is visible (chips wrap, no horizontal scroll).
  assert.match(await card.locator('.home-chip').first().innerText(),/腕立て伏せ/);
  assert.ok(await card.locator('.home-chips').evaluate(e=>e.scrollWidth<=e.clientWidth));
  // Tapping a chip opens the shared record sheet. Bodyweight-only exercise: no weight row.
  await card.getByRole('button',{name:/宅トレ 腕立て伏せ/}).click();
  assert.match(await sheet.locator('#sheet-title').innerText(),/腕立て伏せ/);
  assert.equal(await sheet.getByRole('button',{name:'重量 自重'}).count(),0);
  await sheet.getByRole('button',{name:'宅トレを記録'}).click();
  assert.equal((await store()).logs.at(-1).kg,undefined);
  assert.match(await p.locator('#toast').innerText(),/HOME CLEAR/);
  // Undo from the toast.
  await p.locator('#toast .toast-action').click();
  assert.equal((await store()).logs.length,1);
  await sheet.getByRole('button',{name:'宅トレを記録'}).click();
  // ‹ › switches exercises inside the sheet; dumbbell exercise defaults to 5kg×2.
  for(let i=0;i<12&&!/ダンベルカール/.test(await sheet.locator('#sheet-title').innerText());i++)
    await sheet.getByRole('button',{name:'次の種目'}).click();
  assert.equal(await sheet.getByRole('button',{name:'重量 5kg×2'}).getAttribute('aria-pressed'),'true');
  await sheet.getByRole('button',{name:'回数を1回増やす'}).click();
  await sheet.getByRole('button',{name:'宅トレを記録'}).click();
  await p.clock.runFor(60000);
  await sheet.getByRole('button',{name:'重量 5kg×1'}).click();
  // Keypad entry instead of a browser prompt.
  await sheet.getByLabel('回数を入力').click();
  await sheet.getByRole('button',{name:'1',exact:true}).click();
  await sheet.getByRole('button',{name:'5',exact:true}).click();
  await sheet.getByRole('button',{name:'決定'}).click();
  await sheet.getByRole('button',{name:'宅トレを記録'}).click();
  const logs=(await store()).logs.filter(l=>l.ex==='ダンベルカール');
  assert.deepEqual(logs.map(l=>[l.kg,l.x,l.n]),[[5,2,11],[5,1,15]]);
  assert.equal(await sheet.locator('.sheet-set').count(),2);
  // Swipe-free close; the card remembers it was open, and the last weight is remembered.
  await sheet.locator('.sheet-close').click();
  assert.equal(await p.locator('#rec-sheet').count(),0);
  await p.reload();await p.waitForSelector('#quest-hero');
  assert.equal(await card.locator('.home-head').getAttribute('aria-expanded'),'true');
  const rows=card.locator('.home-sum');
  assert.equal(await rows.count(),3);
  assert.match(await rows.first().innerText(),/腕立て伏せ\s*15/);
  assert.match(await rows.nth(1).innerText(),/ダンベルカール\s*5kg×2\s*11/);
  await card.getByRole('button',{name:/宅トレ ダンベルカール/}).click();
  assert.equal(await sheet.getByRole('button',{name:'重量 5kg×1'}).getAttribute('aria-pressed'),'true');
  // Undo a set from the sheet.
  p.once('dialog',d=>d.accept());
  await sheet.getByRole('button',{name:'ダンベルカール 5kg×1 15回の記録を取り消す'}).click();
  assert.equal((await store()).logs.length,3);
  await sheet.locator('.sheet-close').click();
  // History lists the weight.
  await p.locator('[data-tab="history"]').click();
  assert.match(await p.locator('.h-home',{hasText:'ダンベルカール'}).innerText(),/5kg×2 11回/);
  for(const width of [320,430]){
    await p.setViewportSize({width,height:844});
    assert.ok(await p.evaluate(()=>document.body.scrollWidth<=innerWidth),`overflow ${width}`);
  }
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Home workout UI passed: collapse memory, wrapped chips, record sheet, toast undo, sheet nav, dumbbell weights, keypad, set undo, history.');
  await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1);});
