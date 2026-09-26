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
  async function pageAt(page,width=390,seed={}){
    const ctx=await browser.newContext({viewport:{width,height:844},isMobile:width<600,hasTouch:width<600,timezoneId:'Asia/Tokyo'});
    // Optional locally installed fontsource fonts for offline screenshot QA.
    await ctx.route(/fonts\.googleapis\.com/,async route=>{
      if(!process.env.QA_FONTS)return route.abort();
      let css='';
      for(const family of ['noto-sans-jp','barlow-condensed','noto-emoji']){
        css+=fs.readFileSync(path.join(process.env.QA_FONTS,family,'400.css'),'utf8')
          .replaceAll('./files/',`https://qa-fonts.test/${family}/`);
      }
      css+='body,button,input,textarea { font-family: \"Noto Sans JP\", \"Noto Emoji\", sans-serif !important; }';
      await route.fulfill({contentType:'text/css',body:css});
    });
    await ctx.route('https://qa-fonts.test/**',async route=>{
      const u=new URL(route.request().url());const [family,file]=u.pathname.slice(1).split('/');
      await route.fulfill({contentType:'font/woff2',body:fs.readFileSync(path.join(process.env.QA_FONTS,family,'files',file))});
    });
    await ctx.route('https://accounts.google.com/**',r=>r.abort());
    const p=await ctx.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>errors.push(e.message));
    await p.clock.install({time:new Date('2026-09-28T10:00:00+09:00')});
    if(Object.keys(seed).length)await p.addInitScript(data=>{if(sessionStorage.getItem('qa-seeded'))return;for(const [k,v]of Object.entries(data))localStorage.setItem(k,JSON.stringify(v));sessionStorage.setItem('qa-seeded','1');},seed);
    await p.goto(base+'/'+page+'.html');await p.waitForSelector('#content > *');await p.evaluate(()=>document.fonts.ready);
    return p;
  }
  const shots=process.env.QA_SCREENSHOTS;
  if(shots)fs.mkdirSync(shots,{recursive:true});
  const seed={spot_logs:[{t:'2026-09-27T09:00:00+09:00',cat:'cafe',place:'近所のカフェ',memo:'窓辺の席',rating:4}]};
  for(const page of ['tracker','music','spots','gym']) {
    console.log('Checking',page);
    const p=await pageAt(page,390,seed);
    for(const width of [320,375,390,430,1024]) {
      await p.setViewportSize({width,height:844});
      const tabs=await p.locator('.tab-btn').count();
      for(let i=0;i<tabs;i++) {
        await p.locator('.tab-btn').nth(i).click();
        assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${page} ${width} body overflow`);
        const overflow=await p.locator('#content').evaluate(e=>e.scrollWidth>e.clientWidth);
        assert.equal(overflow,false,`${page} ${width} content overflow`);
      }
    }
    await p.setViewportSize({width:390,height:844});
    await p.locator('.tab-btn').first().click();
    if(page==='tracker') {
      await p.locator('.add-btn').first().click();
      await p.locator('#add-label').fill('朝の習慣');await p.locator('#add-save').click();
      await p.locator('[data-tab="log"]').click();
      await p.locator('.rec-btn').first().click();
      await p.locator('#rec-duration').fill('20');await p.locator('#rec-note').fill('自分のペースで');
      await p.locator('#rec-save').click();
      assert.match(await p.evaluate(()=>localStorage.getItem('wt_records')),/自分のペースで/);
      await p.clock.runFor(3000);await p.evaluate(()=>document.fonts.ready);
      if(shots)await p.screenshot({path:path.join(shots,'weekly-mobile.png')});
      await p.locator('[data-tab="status"]').click();
      await p.waitForFunction(()=>document.querySelector('#status-view .hero-sprite')?.naturalWidth>0);
      assert.ok(await p.locator('#status-view .hero-sprite').evaluate(img=>img.naturalWidth>0));
      if(shots)await p.screenshot({path:path.join(shots,'weekly-growth-mobile.png')});
    }
    if(page==='music') {
      await p.locator('#log-btn').click();
      assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('mus_logs')).length),1);
      assert.match(await p.evaluate(()=>localStorage.getItem('wt_records')),/instrument/);
      await p.locator('#timer-btn').click();
      assert.ok(await p.evaluate(()=>JSON.parse(localStorage.getItem('mus_timer'))));
      await p.reload();assert.ok(await p.locator('#timer-btn').evaluate(e=>e.classList.contains('running')));
      if(shots)await p.screenshot({path:path.join(shots,'music-mobile.png')});
    }
    if(page==='spots') {
      await p.locator('.place-btn').first().click();await p.locator('#memo-input').fill('また来たい');await p.locator('#log-btn').click();
      const logs=await p.evaluate(()=>JSON.parse(localStorage.getItem('spot_logs')));
      assert.equal(logs.length,2);assert.equal(logs[0].memo,'窓辺の席');assert.equal(logs[1].memo,'また来たい');
      await p.reload();assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('spot_logs')).length),2);
      if(shots)await p.screenshot({path:path.join(shots,'spots-mobile.png')});
    }
    await p.locator('#menu-open').click();await p.locator('#menu-close').click();
    await p.evaluate(async()=>{await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;});
    await p.reload();await p.context().setOffline(true);await p.reload();
    assert.equal(await p.locator('#header').evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
    assert.ok(await p.evaluate(async()=>(await caches.match('./css/weekly-theme.css'))!==undefined));
    await p.context().close();
  }
  assert.deepEqual(errors,[]);
  console.log('All four apps: five widths, every tab, settings, recording, timer resume, Weekly link, offline passed.');
  await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1);});
