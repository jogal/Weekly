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
  const store=()=>p.evaluate(()=>JSON.parse(localStorage.getItem('gym_home_v1')));
  // Collapsed to one line until opened.
  assert.equal(await card.locator('.home-chip').count(),0);
  await card.locator('.home-head').click();
  assert.equal(await card.locator('.home-head').getAttribute('aria-expanded'),'true');
  // Recently used first; the old bodyweight exercise stays 自重.
  assert.match(await card.locator('.home-chip').first().innerText(),/腕立て伏せ/);
  assert.equal(await card.getByRole('button',{name:'重量 自重'}).getAttribute('aria-pressed'),'true');
  await card.getByRole('button',{name:'宅トレを記録'}).click();
  assert.deepEqual((await store()).logs.at(-1).kg,undefined);
  // Dumbbell exercise defaults to 5kg×2 and stores the weight.
  await card.getByRole('button',{name:/宅トレ ダンベルカール/}).click();
  assert.equal(await card.getByRole('button',{name:'重量 5kg×2'}).getAttribute('aria-pressed'),'true');
  await card.getByRole('button',{name:'1回増やす'}).click();
  await card.getByRole('button',{name:'宅トレを記録'}).click();
  await p.clock.runFor(60000);
  await card.getByRole('button',{name:'重量 5kg×1'}).click();
  await card.getByRole('button',{name:'宅トレを記録'}).click();
  const logs=(await store()).logs.filter(l=>l.ex==='ダンベルカール');
  assert.deepEqual(logs.map(l=>[l.kg,l.x,l.n]),[[5,2,11],[5,1,11]]);
  // After a reload the exercise and its last weight (5kg×1) are remembered.
  await p.reload();await p.waitForSelector('#quest-hero');
  await card.locator('.home-head').click();
  assert.match(await card.locator('.home-chip.active').innerText(),/ダンベルカール/);
  assert.equal(await card.getByRole('button',{name:'重量 5kg×1'}).getAttribute('aria-pressed'),'true');
  // Today's sets: one line per exercise + weight; tap a number to undo.
  const rows=card.locator('.home-sum');
  assert.equal(await rows.count(),3);
  assert.match(await rows.nth(1).innerText(),/ダンベルカール\s*5kg×2\s*11/);
  p.once('dialog',d=>d.accept());
  await card.getByRole('button',{name:'腕立て伏せ 15回の記録を取り消す'}).click();
  assert.equal(await rows.count(),2);
  assert.equal((await store()).logs.length,3);
  // History lists the weight.
  await p.locator('[data-tab="history"]').click();
  assert.match(await p.locator('.h-home').first().innerText(),/5kg×2 11回/);
  for(const width of [320,430]){
    await p.setViewportSize({width,height:844});
    assert.ok(await p.evaluate(()=>document.body.scrollWidth<=innerWidth),`overflow ${width}`);
  }
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Home workout UI passed: collapse, recency, bodyweight legacy, dumbbell weights, memory, grouped undo, history.');
  await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1);});
