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
    if(Object.keys(seed).length)await p.addInitScript(data=>{for(const [k,v]of Object.entries(data))localStorage.setItem(k,JSON.stringify(v));},seed);
    await p.goto(base+'/gym.html');await p.waitForSelector('#quest-hero');await p.evaluate(()=>document.fonts.ready);
    return p;
  }
  const p=await pageAt();
  const label=()=>p.locator('#today-quest .quest-count').innerText();
  const names=['懸垂','ベンチプレス','リアデルト','インクラインダンベルプレス','ラットプルダウン'];
  async function log(ex){await p.locator(`[data-exercise="${ex}"]`).click();await p.locator('#log-btn').click();}
  assert.equal(await label(),'0 / 3 CLEAR');
  assert.equal(await p.locator('.quest-exercise').count(),5);
  // Non-standard order, repeat sets, and 0..5 transitions.
  await log(names[2]); assert.equal(await label(),'1 / 3 CLEAR');
  await log(names[2]); assert.equal(await label(),'1 / 3 CLEAR');
  await log(names[4]); assert.equal(await label(),'2 / 3 CLEAR');
  await p.getByRole('button',{name:'今日はここまで・記録を確認'}).click();
  assert.match(await p.locator('#toast').innerText(),/今日は2\/5。記録は残っています/);
  await log(names[0]); assert.equal(await label(),'MAIN QUEST CLEAR');
  assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2')).filter(s=>s.status==='completed').length),1);
  await log(names[1]);assert.equal(await label(),'BONUS CLEAR');
  await log(names[3]);assert.equal(await label(),'FULL CLEAR');
  assert.match(await p.locator('#adventure-route').innerText(),/CLEAR/);
  const stored=await p.evaluate(()=>localStorage.getItem('gym_logs'));
  await p.reload();assert.equal(await label(),'FULL CLEAR');
  assert.equal(await p.evaluate(()=>localStorage.getItem('gym_logs')),stored);
  if(process.env.QA_SCREENSHOTS){
    fs.mkdirSync(process.env.QA_SCREENSHOTS,{recursive:true});
    await p.screenshot({path:path.join(process.env.QA_SCREENSHOTS,'gym-quest-clear.png')});
  }
  // Delete recorded sets back through all milestones; auto session is reversible.
  p.on('dialog',d=>d.accept());
  for(const expect of ['BONUS CLEAR','MAIN QUEST CLEAR','2 / 3 CLEAR']){
    await p.locator('.set-del').first().click();assert.equal(await label(),expect);
  }
  assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2')).filter(s=>s.status==='completed').length),0);
  assert.match(await p.locator('#adventure-route').innerText(),/LOGGED/);
  await log(names[0]);assert.equal(await label(),'MAIN QUEST CLEAR');
  assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2')).length),1);
  // Screens and routing at iPhone widths + desktop.
  for(const width of [320,375,390,430,1024]){
    const q=await pageAt(width);
    assert.equal(await q.evaluate(()=>document.body.scrollWidth),width,`body overflow ${width}`);
    assert.ok(await q.evaluate(()=>document.querySelector('#content').scrollWidth<=innerWidth),`content overflow ${width}`);
    assert.equal(await q.locator('.monk-sprite').evaluate(img=>img.naturalWidth>0),true);
    if(width===390&&process.env.QA_SCREENSHOTS)await q.screenshot({path:path.join(process.env.QA_SCREENSHOTS,'gym-quest-mobile.png')});
    await q.locator('[data-tab="plan"]').click();
    assert.equal(await q.locator('.route-stop').count(),7);
    assert.equal(await q.locator('.route-stop[data-state="blocked"]').count(),1);
    await q.context().close();
  }
  // Slot-based prior pain is respected by free logging; legacy logs/notes survive.
  const oldLogs=Array.from({length:4},(_,i)=>({t:`2026-09-26T10:0${i}:00+09:00`,ex:names[1],part:'chest',kg:50,reps:10,slot:'A1',sessionId:'old'}));
  const oldRecords={'2026-09-21':{sat:{medicine:{done:true,note:'手書きのメモ',duration:'30'}}}};
  const seed={gym_logs:oldLogs,gym_last:{[names[1]]:{kg:50,reps:10}},gym_sessions_v2:[{id:'old',date:'2026-09-26',templateId:'MAIN',status:'completed',pain:{A1:true}}],wt_records:oldRecords};
  const pain=await pageAt(390,seed);
  assert.match(await pain.locator('#input-card').innerText(),/増量を止め/);
  assert.equal(await pain.evaluate(()=>window.TrainingUI.quickTarget('ベンチプレス').target.weight),50);
  await pain.locator('#log-btn').click();
  assert.deepEqual(await pain.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).slice(0,4)),oldLogs);
  assert.deepEqual(await pain.evaluate(()=>JSON.parse(localStorage.getItem('wt_records'))['2026-09-21']),oldRecords['2026-09-21']);
  // Workout mode retains direct exercise choice, numeric inputs and partial finish.
  const w=await pageAt();
  await w.locator('[data-tab="workout"]').click();
  await w.getByRole('button',{name:'ワークアウトを始める'}).click();
  for(const ex of [names[4],names[1]]){
    await w.locator(`[data-exercise="${ex}"]`).click();
    await w.getByLabel('重量 kg',{exact:true}).fill('42.5');
    await w.getByLabel('回数',{exact:true}).fill('8');
    await w.getByRole('button',{name:/^⚡ セット記録/}).click();
  }
  await w.getByRole('button',{name:'ワークアウト終了',exact:true}).click();
  assert.match(await w.getByRole('dialog').innerText(),/今日は2\/5/);
  await w.getByRole('button',{name:'記録を残して終了'}).click();
  assert.equal(await w.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2'))[0].status),'aborted');
  assert.deepEqual(await w.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).map(l=>[l.kg,l.reps])),[[42.5,8],[42.5,8]]);
  // Mix free logging and Workout on the same day: third exercise clears immediately.
  const mixed=await pageAt();
  await mixed.locator('[data-exercise="懸垂"]').click();await mixed.locator('#log-btn').click();
  await mixed.locator('[data-exercise="リアデルト"]').click();await mixed.locator('#log-btn').click();
  await mixed.locator('[data-tab="workout"]').click();
  await mixed.getByRole('button',{name:'ワークアウトを始める'}).click();
  await mixed.locator('[data-exercise="ベンチプレス"]').click();
  await mixed.getByRole('button',{name:/^⚡ セット記録/}).click();
  assert.equal(await mixed.locator('#today-quest .quest-count').innerText(),'MAIN QUEST CLEAR');
  await mixed.getByRole('button',{name:'ワークアウト終了',exact:true}).click();
  await mixed.getByRole('button',{name:'記録を残して終了'}).click();
  assert.equal(await mixed.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2'))[0].status),'completed');
  await mixed.locator('[data-tab="today"]').click();mixed.on('dialog',d=>d.accept());
  await mixed.locator('.set-del').first().click();
  assert.equal(await mixed.locator('#today-quest .quest-count').innerText(),'2 / 3 CLEAR');
  assert.match(await mixed.locator('#adventure-route').innerText(),/LOGGED/);
  // Exercise picker remains usable after switching parts and rerendering.
  await mixed.locator('.extra-exercises summary').click();
  await mixed.getByRole('button',{name:'脚',exact:true}).click();
  assert.equal(await mixed.locator('.extra-exercises').getAttribute('open'),'');
  await mixed.getByRole('button',{name:'スクワット',exact:true}).click();
  assert.match(await mixed.locator('#sel-ex-name').innerText(),/スクワット/);
  // Reduced motion turns off idle animation.
  await w.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await w.locator('.monk-sprite').evaluate(el=>getComputedStyle(el).animationName),'none');
  // PWA assets (including all sprites) install and the page reloads offline.
  const offline=await pageAt();
  await offline.locator('#log-btn').click();
  const offlineLogs=await offline.evaluate(()=>localStorage.getItem('gym_logs'));
  await offline.evaluate(async()=>{
    const old=await caches.open('weekly-quest-v44');await old.put('./gym.html',new Response('old page'));
    await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;
  });
  await offline.reload();
  await offline.context().setOffline(true);await offline.reload();
  assert.equal(await offline.locator('.quest-exercise').count(),5);
  assert.equal(await offline.evaluate(()=>localStorage.getItem('gym_logs')),offlineLogs);
  assert.equal(await offline.evaluate(async()=>(await caches.keys()).includes('weekly-quest-v44')),false);
  const cachedAssets=await offline.evaluate(async()=>Promise.all([1,10,20,30,40].map(async tier=>(await fetch(`sprites/monk_lv${tier}x2.png`)).ok)));
  assert.ok(cachedAssets.every(Boolean));
  assert.equal(await offline.locator('.monk-sprite').evaluate(el=>el.naturalWidth>0),true);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Browser regression checks passed: 0–5, undo, reload, 5 viewport widths, pain, legacy data, workout, reduced motion, offline PWA.');
  await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1);});
