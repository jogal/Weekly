// Optional browser regression checks: requires Playwright and an installed Chromium.
// NODE_PATH=<path containing playwright> BROWSER_PATH=<chromium> node tests/gym-ui.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname,'..');
const mime = {'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2'};
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
  async function pageAt(width=390,seed={}){
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
    const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
    await p.clock.install({time:new Date('2026-09-28T10:00:00+09:00')});
    if(Object.keys(seed).length)await p.addInitScript(data=>{if(sessionStorage.getItem("seeded"))return;for(const [k,v]of Object.entries(data))localStorage.setItem(k,JSON.stringify(v));sessionStorage.setItem("seeded","yes");},seed);
    await p.goto(base+'/gym.html');await p.waitForSelector('#quest-hero');await p.evaluate(()=>document.fonts.ready);
    return p;
  }
  const bench='ベンチプレス';
  const oldLogs=[50,60,50].map((kg,i)=>({t:`2026-09-26T10:0${i}:00+09:00`,ex:bench,part:'chest',kg,reps:[10,8,8][i]}));
  const seed={gym_logs:oldLogs,gym_last:{[bench]:{kg:50,reps:8}}};
  for(const width of [320,375,390,430]){
    const p=await pageAt(width,seed);
    await p.locator(`[data-exercise="${bench}"]`).click();
    assert.equal(await p.locator('.target-set').count(),3);
    assert.match(await p.locator('.training-target').innerText(),/60kg×8回/);
    assert.equal(await p.locator('.target-challenge').count(),0);
    for(const kg of [50,60,50]){
      assert.match(await p.getByLabel('重量を入力',{exact:true}).innerText(),new RegExp(String(kg)));
      await p.clock.runFor(1000);await p.locator('#log-btn').click();
    }
    const stored=await p.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')));
    assert.deepEqual(stored.slice(0,3),oldLogs);
    assert.deepEqual(stored.slice(3).map(s=>[s.kg,s.reps]),[[50,10],[60,8],[50,8]]);
    assert.equal(await p.locator('#today-quest .quest-count').innerText(),'1 / 3 CLEAR');
    await p.getByRole('button',{name:'余裕あり',exact:true}).click();
    assert.equal(await p.locator('.target-challenge').count(),1);
    await p.locator('.target-challenge summary').click();
    assert.match(await p.locator('.target-challenge').innerText(),/60kg×9回/);
    // Feedback is reversible and bound to the recorded exercise; reload persists it.
    await p.reload();await p.waitForSelector('#quest-hero');
    assert.equal(await p.getByRole('button',{name:'余裕あり',exact:true}).getAttribute('aria-pressed'),'true');
    await p.getByRole('button',{name:'きつい',exact:true}).click();
    assert.equal(await p.locator('.target-challenge').count(),0);
    await p.getByRole('button',{name:'痛みあり',exact:true}).click();
    assert.equal(await p.locator('.target-set').count(),0);
    assert.match(await p.locator('.training-target').innerText(),/目標提案を休止/);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await p.getByRole('button',{name:'痛みあり',exact:true}).click();
    assert.equal(await p.locator('.target-set').count(),3);
    await p.context().close();
  }
  // Workout input follows mixed loads too, and doesn't add the configured fourth set.
  const w=await pageAt(390,seed);
  await w.locator('[data-tab="workout"]').click();
  await w.getByRole('button',{name:'ワークアウトを始める',exact:true}).click();
  await w.locator(`[data-exercise="${bench}"]`).click();
  for(const kg of [50,60,50]){
    assert.equal(await w.getByLabel('重量 kg',{exact:true}).inputValue(),String(kg));
    await w.clock.runFor(1000);await w.getByRole('button',{name:/^⚡ セット記録/}).click();
  }
  assert.equal(await w.locator('.target-set').count(),3);
  await w.getByRole('button',{name:'きつい',exact:true}).click();
  assert.equal(await w.locator('.target-challenge').count(),0);
  await w.getByRole('button',{name:'痛みあり',exact:true}).click();
  assert.equal(await w.locator('.target-set').count(),0);
  assert.equal(await w.getByRole('button',{name:/挑戦を入力/}).count(),0);
  await w.context().close();
  const opt=await pageAt(390,{...seed,gym_daily_v2:{'2026-09-26':{exerciseFeedback:{[bench]:{effort:'easy',lastSetAt:oldLogs[2].t}}}}});
  await opt.locator('[data-tab="workout"]').click();
  await opt.getByRole('button',{name:'ワークアウトを始める',exact:true}).click();
  await opt.locator(`[data-exercise="${bench}"]`).click();
  assert.equal(await opt.getByRole('button',{name:/挑戦を入力/}).count(),0);
  await opt.getByRole('button',{name:/^⚡ セット記録/}).click();
  assert.equal(await opt.getByLabel('回数',{exact:true}).inputValue(),'8');
  await opt.getByRole('button',{name:/挑戦を入力/}).click();
  assert.equal(await opt.getByLabel('回数',{exact:true}).inputValue(),'9');
  await opt.clock.runFor(1000);await opt.getByRole('button',{name:/^⚡ セット記録/}).click();
  assert.deepEqual(await opt.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).slice(-2).map(l=>[l.kg,l.reps])),[[50,10],[60,9]]);
  await opt.context().close();
  // Warm-up stays in logs but doesn't consume the next working-set preset.
  const warm=await pageAt(390,seed);
  await warm.locator(`[data-exercise="${bench}"]`).click();
  await warm.locator('.recording-options summary').click();
  await warm.getByRole('button',{name:'このセットはウォームアップ',exact:true}).click();
  await warm.locator('#log-btn').click();
  assert.equal(await warm.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).at(-1).kind),'warmup');
  assert.match(await warm.getByLabel('重量を入力',{exact:true}).innerText(),/50/);
  await warm.clock.runFor(1000);await warm.locator('#log-btn').click();
  assert.equal(await warm.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).at(-1).kind),'working');
  assert.match(await warm.getByLabel('重量を入力',{exact:true}).innerText(),/60/);
  await warm.context().close();
  // Assistance must be explicit and survive into both history and future targets.
  const pull=await pageAt();
  await pull.locator('[data-exercise="懸垂"]').click();
  await pull.locator('.recording-options summary').click();
  await pull.getByLabel('懸垂の重量方式').selectOption('assisted');
  await pull.getByRole('button',{name:'+10',exact:true}).click();
  await pull.locator('#log-btn').click();
  const assisted=await pull.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).at(-1));
  assert.equal(assisted.loadMode,'assisted');assert.equal(assisted.kg,10);
  assert.match(await pull.locator('.set-main').first().innerText(),/補助10kg/);
  await pull.context().close();
  // Cache upgrade replaces the old target engine without touching existing logs.
  const offline=await pageAt(390,seed);
  await offline.locator(`[data-exercise="${bench}"]`).click();
  const before=await offline.evaluate(()=>localStorage.getItem('gym_logs'));
  await offline.evaluate(async()=>{
    const old=await caches.open('weekly-quest-v48');await old.put('./gym.html',new Response('old'));
    await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;
  });
  await offline.reload();await offline.context().setOffline(true);await offline.reload();
  assert.equal(await offline.locator('.target-set').count(),3);
  assert.equal(await offline.evaluate(()=>localStorage.getItem('gym_logs')),before);
  assert.equal(await offline.evaluate(async()=>(await caches.keys()).includes('weekly-quest-v48')),false);
  assert.equal(await offline.evaluate(async()=>(await fetch('./js/training-targets.mjs')).ok),true);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Target UI passed: mixed inputs, effort/reload, pain, optional sets, warmup, assistance, 320–430px, offline cache upgrade, preserved logs.');
  await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1);});
