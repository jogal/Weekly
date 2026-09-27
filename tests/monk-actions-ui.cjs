// Optional browser regression checks: requires Playwright and an installed Chromium.
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/monk-actions-ui.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname,'..');
const mime = {'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.webp':'image/webp'};
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
  async function pageAt(width=390,seed={},missingActions=false){
    const ctx=await browser.newContext({viewport:{width,height:844},isMobile:width<600,hasTouch:width<600,timezoneId:'Asia/Tokyo'});
    // Optional locally installed fontsource fonts for offline screenshot QA.
    await ctx.route(/fonts\.googleapis\.com/,async route=>{
      if(!process.env.QA_FONTS)return route.abort();
      let css='';
      for(const family of ['noto-sans-jp','barlow-condensed']){
        css+=fs.readFileSync(path.join(process.env.QA_FONTS,family,'400.css'),'utf8')
          .replaceAll('./files/',`https://qa-fonts.test/${family}/`);
      }
      await route.fulfill({contentType:'text/css',body:css});
    });
    await ctx.route('https://qa-fonts.test/**',async route=>{
      const u=new URL(route.request().url());const [family,file]=u.pathname.slice(1).split('/');
      await route.fulfill({contentType:'font/woff2',body:fs.readFileSync(path.join(process.env.QA_FONTS,family,'files',file))});
    });
    if(missingActions)await ctx.route('**/sprites/monk-actions/**',r=>r.abort());
    const p=await ctx.newPage();p.setDefaultTimeout(10000);await p.addInitScript(()=>{Math.random=()=>0;});p.on('pageerror',e=>errors.push(e.message));
    await p.clock.install({time:new Date('2026-09-28T10:00:00+09:00')});
    if(Object.keys(seed).length)await p.addInitScript(data=>{for(const [k,v]of Object.entries(data))localStorage.setItem(k,JSON.stringify(v));},seed);
    await p.goto(base+'/gym.html');await p.waitForSelector('#quest-hero');await p.evaluate(()=>document.fonts.ready);
    await p.waitForFunction(missing=>{const a=document.querySelector('.monk-actor');return a?.dataset.paused==='false'&&(missing||!a.disabled);},missingActions);
    await p.clock.pauseAt(await p.evaluate(()=>Date.now()+100));
    return p;
  }
  const p=await pageAt();
  const actor=p.locator('.monk-actor');
  const pose=()=>actor.getAttribute('data-pose');
  const snapshot=()=>p.evaluate(()=>JSON.stringify({...localStorage}));
  const before=await snapshot();
  const shots=process.env.QA_SCREENSHOTS;
  if(shots)fs.mkdirSync(shots,{recursive:true});
  async function shot(name){if(shots)await p.locator('#quest-hero').screenshot({path:path.join(shots,name+'.png')});}
  await shot('idle');
  await actor.click();await p.clock.runFor(250);
  assert.equal(await pose(),'punch');await shot('punch');
  await actor.click(); // spam cannot interrupt or overlap an action
  await p.clock.runFor(600);assert.equal(await pose(),'idle');
  await p.clock.runFor(2200);await actor.click();await p.clock.runFor(300);
  assert.equal(await pose(),'flex');await shot('flex');
  await p.clock.runFor(1600);assert.equal(await pose(),'idle');
  assert.equal(await snapshot(),before,'actions must not write any storage');
  await p.clock.runFor(18000);assert.notEqual(await pose(),'idle','occasional action');
  await p.emulateMedia({reducedMotion:'reduce'});await new Promise(r=>setTimeout(r,100));
  assert.equal(await pose(),'idle');assert.equal(await actor.isDisabled(),true);
  await p.clock.runFor(45000);assert.equal(await pose(),'idle');
  await p.emulateMedia({reducedMotion:'no-preference'});await new Promise(r=>setTimeout(r,100));
  // Hide like a PWA background/foreground transition; no replay of missed timers.
  await p.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await p.clock.runFor(45000);assert.equal(await pose(),'idle');
  assert.equal(await actor.getAttribute('data-paused'),'true');
  await p.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow')));
  await p.clock.runFor(100);assert.equal(await pose(),'idle');
  await p.locator('#input-card').scrollIntoViewIfNeeded();
  await new Promise(r=>setTimeout(r,100));await p.clock.runFor(45000);
  assert.equal(await actor.getAttribute('data-paused'),'true');assert.equal(await pose(),'idle');
  // A detached hero never keeps animating when another tab is open.
  await p.locator('[data-tab="history"]').click();await p.clock.runFor(45000);
  assert.equal(await p.locator('.monk-actor').count(),0);
  await p.locator('[data-tab="today"]').click();
  await p.clock.resume();
  await p.waitForFunction(()=>document.querySelector('.monk-actor')?.dataset.paused==='false');
  // Recording milestones can celebrate without changing existing clear semantics.
  for(const name of ['懸垂','ベンチプレス','リアデルト']) {
    await p.locator(`[data-exercise="${name}"]`).click();await p.locator('#log-btn').click();
  }
  await p.locator('#quest-hero').scrollIntoViewIfNeeded();
  await p.waitForFunction(()=>document.querySelector('.monk-actor')?.dataset.pose==='flex');
  assert.equal(await p.locator('.quest-count').innerText(),'MAIN QUEST CLEAR');
  // Responsive action hit area / image at every tier; tiers are seeded through real XP rules.
  const {questXpToReach}=await import('../js/training-core.mjs');
  for(const [i,tier] of [1,10,20,30,40].entries()) {
    const records={'2026-09-28':{mon:{}}};
    for(let n=0;n<Math.ceil(questXpToReach(tier)/40);n++)records['2026-09-28'].mon['workout_qa_'+n]={done:true,duration:100,rating:5};
    const q=await pageAt([320,375,390,430,1024][i],{wt_records:records});
    assert.match(await q.locator('.monk-actor').getAttribute('style'),new RegExp('lv'+tier+'\\.webp'));
    await q.locator('.monk-actor').click();await q.clock.runFor(250);
    assert.equal(await q.locator('.monk-actor').getAttribute('data-pose'),'punch');
    assert.ok(await q.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await q.context().close();
  }
  // Install once, then all five action assets and the controller work offline.
  await p.evaluate(async()=>{await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;});
  await p.reload();await p.context().setOffline(true);await p.reload();
  await p.waitForFunction(()=>document.querySelector('.monk-actor')?.dataset.paused==='false');
  for(const tier of [1,10,20,30,40])assert.ok(await p.evaluate(async t=>(await fetch(`sprites/monk-actions/lv${t}.webp`)).ok,tier));
  await p.locator('.monk-actor').click();
  await p.waitForFunction(()=>document.querySelector('.monk-actor')?.dataset.pose==='punch');
  const missing=await pageAt(390,{},true);
  assert.equal(await missing.locator('.monk-actor').isDisabled(),true);
  assert.equal(await missing.locator('.monk-sprite').evaluate(e=>getComputedStyle(e).animationPlayState),'running');
  assert.equal(await missing.locator('.monk-sprite').evaluate(e=>e.naturalWidth>0),true);
  await missing.locator('#log-btn').click();assert.equal(await missing.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).length),1);
  await missing.context().close();
  assert.deepEqual(errors,[]);
  await browser.close();server.close();
  console.log('Monk actions: punch/flex, idle timer, spam, reduced motion, background, offscreen, detach, milestone, all tiers, storage and offline passed.');
})().catch(e=>{console.error(e);server.close();process.exit(1);});
