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
  // 廃止した めぐり画面の記録。週クエの書き出しに入り、復元で戻ることを確かめる
  const seed={spot_logs:[{t:'2026-09-27T09:00:00+09:00',cat:'cafe',place:'近所のカフェ',memo:'窓辺の席',rating:4}]};
  for(const page of ['tracker','gym']) {
    console.log('Checking',page);
    const p=await pageAt(page,390,seed);
    for(const width of [320,375,390,430,1024]) {
      await p.setViewportSize({width,height:844});
      const tabs=await p.locator('.tab-btn').count();
      for(let i=0;i<tabs;i++) {
        await p.locator('.tab-btn').nth(i).click();
        assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${page} ${width} body overflow`);
        // iOSのホーム画面アプリで100dvhが短くなる問題の回避: 高さの単位ではなく四辺固定で全高を使う
        const fill=await p.evaluate(()=>{const a=document.getElementById('app');return getComputedStyle(a).position==='fixed'&&Math.round(a.getBoundingClientRect().bottom)===innerHeight;});
        assert.ok(fill,`${page} ${width} app must fill the screen height`);
        const overflow=await p.locator('#content').evaluate(e=>e.scrollWidth>e.clientWidth);
        assert.equal(overflow,false,`${page} ${width} content overflow`);
      }
    }
    await p.setViewportSize({width:390,height:844});
    await p.locator('.tab-btn').first().click();
    if(page==='tracker') {
      await p.locator('.hb-card',{hasText:'自炊'}).locator('.hb-ring').click();
      assert.match(await p.evaluate(()=>localStorage.getItem('wt_records')),/cooking/);
      await p.locator('#menu-open').click();
      const [dl]=await Promise.all([p.waitForEvent('download'),p.locator('#export-btn').click()]);
      const backup=JSON.parse(fs.readFileSync(await dl.path(),'utf8'));
      assert.match(backup.archivedData.spot_logs,/窓辺の席/);
      assert.equal(backup.archivedData.mus_logs,undefined);
      await p.evaluate(()=>localStorage.removeItem('spot_logs'));
      const file=path.join(require('node:os').tmpdir(),'weekly-backup-test.json');fs.writeFileSync(file,JSON.stringify(backup));
      await p.locator('#menu-open').click();
      const [chooser]=await Promise.all([p.waitForEvent('filechooser'),p.locator('#import-btn').click()]);
      await chooser.setFiles(file);
      await p.waitForFunction(()=>!!localStorage.getItem('spot_logs'));
      assert.match(await p.evaluate(()=>localStorage.getItem('spot_logs')),/窓辺の席/);
      await p.clock.runFor(3000);await p.evaluate(()=>document.fonts.ready);
      if(shots)await p.screenshot({path:path.join(shots,'weekly-mobile.png')});
      await p.locator('[data-tab="status"]').click();
      await p.waitForFunction(()=>document.querySelector('#status-view .hero-sprite')?.naturalWidth>0);
      assert.ok(await p.locator('#status-view .hero-sprite').evaluate(img=>img.naturalWidth>0));
      if(shots)await p.screenshot({path:path.join(shots,'weekly-growth-mobile.png')});
    }
    await p.locator('#menu-open').click();await p.locator('#menu-close').click();
    await p.evaluate(async()=>{await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;});
    await p.reload();await p.context().setOffline(true);await p.reload();
    assert.equal(await p.locator('#header').evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
    assert.ok(await p.evaluate(async()=>(await caches.match('./css/weekly-theme.css'))!==undefined));
    await p.context().close();
  }
  assert.deepEqual(errors,[]);
  console.log('Weekly and Gym: five widths, every tab, settings, recording, offline passed.');
  await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1);});
