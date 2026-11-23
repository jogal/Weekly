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
// Main Questは部位タブで絞り込むため、隠れている行はタブを切り替えてから押す
// 週の冒険ルートはPLANタブだけに出す(きろくタブからは外した)
async function routeText(page){
  if(await page.locator('#rec-sheet').count()) await page.locator('#rec-sheet .sheet-close').click();
  await page.locator('[data-tab="plan"]').click();
  const text=await page.locator('#adventure-route').innerText();
  await page.locator('[data-tab="today"]').click();
  return text;
}
async function pickEx(page,ex){
  // 記録シートが開いていれば閉じてから(シートの裏の行は押せない)
  if(await page.locator('#rec-sheet').count()) await page.locator('#rec-sheet .sheet-close').click();
  const row=page.locator(`[data-exercise="${ex}"]`);
  if(!(await row.isVisible())) await page.locator(`.quest-part-tab[data-part="${await row.getAttribute('data-part')}"]`).click();
  await page.locator(`[data-exercise="${ex}"]`).click();
}
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
  const names=['懸垂','ベンチプレス','リアデルト','インクラインダンベルプレス','ラットプルダウン','ショルダープレス','サイドレイズ'];
  async function log(ex){await pickEx(p,ex);await p.locator('#log-btn').click();}
  assert.equal(await label(),'0 / 3 CLEAR');
  assert.equal(await p.locator('.quest-exercise').count(),8);
  assert.match(await p.locator('.quest-next').innerText(),/あと3種目でクリア\s+·\s+4でBONUS\s+·\s+5でFULL（8種目から自由に）/);
  assert.equal(await p.locator('#adventure-route').count(),0);
  // Non-standard order, repeat sets, and 0..5 transitions.
  await log(names[2]); assert.equal(await label(),'1 / 3 CLEAR');
  await log(names[2]); assert.equal(await label(),'1 / 3 CLEAR');
  await log(names[4]); assert.equal(await label(),'2 / 3 CLEAR');
  await p.locator('#rec-sheet .sheet-close').click();
  await p.getByRole('button',{name:'今日はここまで・記録を確認'}).click();
  assert.match(await p.locator('#toast').innerText(),/今日は2\/8。記録は残っています/);
  await log(names[0]); assert.equal(await label(),'MAIN QUEST CLEAR');
  assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2')).filter(s=>s.status==='completed').length),1);
  await log(names[1]);assert.equal(await label(),'BONUS CLEAR');
  await log(names[3]);assert.equal(await label(),'FULL CLEAR');
  await log(names[5]);assert.equal(await label(),'FULL CLEAR');
  await log(names[6]);assert.equal(await label(),'FULL CLEAR');
  assert.match(await routeText(p),/CLEAR/);
  const stored=await p.evaluate(()=>localStorage.getItem('gym_logs'));
  await p.reload();assert.equal(await label(),'FULL CLEAR');
  assert.equal(await p.evaluate(()=>localStorage.getItem('gym_logs')),stored);
  if(process.env.QA_SCREENSHOTS){
    fs.mkdirSync(process.env.QA_SCREENSHOTS,{recursive:true});
    await p.screenshot({path:path.join(process.env.QA_SCREENSHOTS,'gym-quest-clear.png')});
  }
  // Delete recorded sets back through all milestones; auto session is reversible.
  p.on('dialog',d=>d.accept());
  for(const expect of ['FULL CLEAR','FULL CLEAR','BONUS CLEAR','MAIN QUEST CLEAR','2 / 3 CLEAR']){
    await p.locator('.set-del').first().click();assert.equal(await label(),expect);
  }
  assert.equal(await p.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2')).filter(s=>s.status==='completed').length),0);
  assert.match(await routeText(p),/LOGGED/);
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
  const pain=await pageAt(390,seed);await pickEx(pain,'ベンチプレス');
  assert.match(await pain.locator('#input-card').innerText(),/目標提案を休止/);
  assert.equal(await pain.evaluate(()=>window.TrainingUI.quickTarget('ベンチプレス').target.weight),null);
  await pain.locator('#log-btn').click();
  assert.deepEqual(await pain.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).slice(0,4)),oldLogs);
  assert.deepEqual(await pain.evaluate(()=>JSON.parse(localStorage.getItem('wt_records'))['2026-09-21']),oldRecords['2026-09-21']);
  // Workout mode retains direct exercise choice, numeric inputs and partial finish.
  const w=await pageAt();
  await w.locator('[data-tab="workout"]').click();
  await w.getByRole('button',{name:'ワークアウトを始める'}).click();
  for(const ex of [names[4],names[1]]){
    await pickEx(w,ex);
    await w.getByLabel('重量 kg',{exact:true}).fill('42.5');
    await w.getByLabel('回数',{exact:true}).fill('8');
    await w.getByRole('button',{name:/^⚡ セット記録/}).click();
  }
  await w.getByRole('button',{name:'ワークアウト終了',exact:true}).click();
  assert.match(await w.getByRole('dialog').innerText(),/今日は2\/8/);
  await w.getByRole('button',{name:'記録を残して終了'}).click();
  assert.equal(await w.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2'))[0].status),'aborted');
  assert.deepEqual(await w.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).map(l=>[l.kg,l.reps])),[[42.5,8],[42.5,8]]);
  // Mix free logging and Workout on the same day: third exercise clears immediately.
  const mixed=await pageAt();
  await pickEx(mixed,'懸垂');await mixed.locator('#log-btn').click();
  await pickEx(mixed,'リアデルト');await mixed.locator('#log-btn').click();
  await mixed.locator('#rec-sheet .sheet-close').click();
  await mixed.locator('[data-tab="workout"]').click();
  await mixed.getByRole('button',{name:'ワークアウトを始める'}).click();
  await pickEx(mixed,'ベンチプレス');
  await mixed.getByRole('button',{name:/^⚡ セット記録/}).click();
  assert.equal(await mixed.locator('#today-quest .quest-count').innerText(),'MAIN QUEST CLEAR');
  await mixed.getByRole('button',{name:'ワークアウト終了',exact:true}).click();
  await mixed.getByRole('button',{name:'記録を残して終了'}).click();
  assert.equal(await mixed.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2'))[0].status),'completed');
  await mixed.waitForFunction(()=>document.querySelector('.mk-img')?.naturalWidth>0);
  assert.match(await mixed.locator('.mk-img').getAttribute('src'),/monk-idle\/lv\d+\.webp$/);
  assert.ok(Math.abs(await mixed.locator('.mk-img').evaluate(img=>img.offsetWidth/img.parentElement.offsetWidth)-2)<.02);
  await mixed.locator('[data-tab="today"]').click();mixed.on('dialog',d=>d.accept());
  await mixed.locator('.set-del').first().click();
  assert.equal(await mixed.locator('#today-quest .quest-count').innerText(),'2 / 3 CLEAR');
  assert.match(await routeText(mixed),/LOGGED/);
  // Exercise picker remains usable after switching parts and rerendering.
  await mixed.locator('.quest-more summary').click();
  await mixed.getByRole('button',{name:'Main Quest以外の種目',exact:true}).click();
  await mixed.getByRole('button',{name:'脚',exact:true}).click();
  assert.match(await mixed.locator('#sheet-title').innerText(),/Main Quest以外の種目/);
  await mixed.getByRole('button',{name:'スクワット',exact:true}).click();
  assert.match(await mixed.locator('#sel-ex-name').innerText(),/スクワット/);
  // Reduced motion turns off idle animation.
  await w.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await w.locator('.monk-sprite').evaluate(el=>getComputedStyle(el).animationName),'none');
  // Part tabs: only the current part's rows are shown; add/remove candidates per part.
  const parts=await pageAt();
  assert.equal(await parts.locator('.quest-part-tab').count(),6);
  assert.equal(await parts.locator('.quest-part-tab[aria-selected="true"]').getAttribute('data-part'),'chest');
  assert.deepEqual(await parts.locator('.quest-exercise:visible').evaluateAll(r=>r.map(x=>x.dataset.exercise)),['ベンチプレス','インクラインダンベルプレス']);
  await parts.locator('.quest-part-tab[data-part="arm"]').click();
  assert.equal(await parts.locator('.quest-exercise:visible').count(),0);
  assert.match(await parts.locator('.quest-part-empty').innerText(),/腕の種目はまだありません/);
  await parts.getByRole('button',{name:'＋ 腕の種目を追加'}).click();
  await parts.locator('.quest-sheet-chip[data-name="ケーブルプレスダウン"]').click();
  await parts.locator('.quest-sheet-chip',{hasText:'10–15'}).click();
  await parts.getByRole('button',{name:'追加する'}).click();
  const added=await parts.evaluate(()=>JSON.parse(localStorage.getItem('gym_program_v2')).templates[0]);
  assert.equal(added.exercises.length,9);
  assert.equal(added.focus,'胸＋背中＋肩＋脚 / 3 of 9');
  const pd=added.exercises[8];
  assert.deepEqual([pd.ex,pd.part,pd.sets,pd.repMin,pd.repMax],['ケーブルプレスダウン','arm',3,10,15]);
  assert.ok(pd.slot && !added.exercises.slice(0,8).some(e=>e.slot===pd.slot));
  assert.equal(await parts.locator('.quest-part-tab[aria-selected="true"]').getAttribute('data-part'),'arm');
  assert.match(await parts.locator('.quest-milestones').innerText(),/9種目から自由に/);
  // The new exercise counts toward the clear like any candidate (across parts).
  await pickEx(parts,'ケーブルプレスダウン');await parts.locator('#log-btn').click();
  await pickEx(parts,'懸垂');await parts.locator('#log-btn').click();
  await pickEx(parts,'スクワット');await parts.locator('#log-btn').click();
  assert.equal(await parts.locator('#today-quest .quest-count').innerText(),'MAIN QUEST CLEAR');
  assert.equal(await parts.locator('.quest-part-tab[data-part="arm"]').evaluate(b=>b.classList.contains('has-done')),true);
  // Custom names typed by hand are added too; duplicates are refused.
  await parts.locator('#rec-sheet .sheet-close').click();
  await parts.locator('.quest-part-tab[data-part="arm"]').click();
  await parts.getByRole('button',{name:'＋ 腕の種目を追加'}).click();
  await parts.getByLabel('種目名',{exact:true}).fill('ケーブルプレスダウン');
  await parts.getByRole('button',{name:'追加する'}).click();
  assert.match(await parts.locator('#toast').innerText(),/もう候補に入っています/);
  await parts.getByLabel('種目名',{exact:true}).fill('フレンチプレス');
  await parts.getByRole('button',{name:'追加する'}).click();
  assert.equal(await parts.evaluate(()=>JSON.parse(localStorage.getItem('gym_program_v2')).templates[0].exercises.length),10);
  assert.ok(await parts.evaluate(()=>JSON.parse(localStorage.getItem('gym_custom')).arm.includes('フレンチプレス')));
  // Organize mode removes a candidate but keeps its logs.
  parts.once('dialog',d=>d.accept());
  await parts.locator('.quest-more summary').click();
  await parts.getByRole('button',{name:'候補を整理'}).click();
  await parts.locator('[data-exercise="ケーブルプレスダウン"]').click();
  const afterRemove=await parts.evaluate(()=>JSON.parse(localStorage.getItem('gym_program_v2')).templates[0]);
  assert.deepEqual(afterRemove.exercises.map(e=>e.ex).slice(-1),['フレンチプレス']);
  assert.equal(afterRemove.focus,'胸＋背中＋肩＋脚 / 3 of 9');
  assert.ok(await parts.evaluate(()=>JSON.parse(localStorage.getItem('gym_logs')).some(l=>l.ex==='ケーブルプレスダウン')));
  // During a workout: adding works (appended, current exercise unchanged), removing is blocked.
  const wa=await pageAt();
  await wa.locator('[data-tab="workout"]').click();
  await wa.getByRole('button',{name:'ワークアウトを始める'}).click();
  await pickEx(wa,'ベンチプレス');
  const curBefore=await wa.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2'))[0].curEx);
  await wa.locator('.quest-part-tab[data-part="arm"]').click();
  await wa.getByRole('button',{name:'＋ 腕の種目を追加'}).click();
  await wa.locator('.quest-sheet-chip[data-name="ケーブルプレスダウン"]').click();
  await wa.getByRole('button',{name:'追加する'}).click();
  assert.equal(await wa.evaluate(()=>JSON.parse(localStorage.getItem('gym_sessions_v2'))[0].curEx),curBefore);
  assert.equal(await wa.locator('#input-card h2').innerText(),'ベンチプレス');
  await wa.locator('.quest-more summary').click();
  await wa.getByRole('button',{name:'候補を整理'}).click();
  assert.match(await wa.locator('#toast').innerText(),/ワークアウト中は外せません/);
  assert.equal(await wa.locator('#today-quest.is-organizing').count(),0);
  await pickEx(wa,'ケーブルプレスダウン');
  assert.equal(await wa.locator('#input-card h2').innerText(),'ケーブルプレスダウン');
  // PWA assets (including all sprites) install and the page reloads offline.
  const offline=await pageAt();
  await pickEx(offline,'ベンチプレス');await offline.locator('#log-btn').click();
  const offlineLogs=await offline.evaluate(()=>localStorage.getItem('gym_logs'));
  await offline.evaluate(async()=>{
    const old=await caches.open('weekly-quest-v44');await old.put('./gym.html',new Response('old page'));
    await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;
  });
  await offline.reload();
  await offline.context().setOffline(true);await offline.reload();
  assert.equal(await offline.locator('.quest-exercise').count(),8);
  assert.equal(await offline.evaluate(()=>localStorage.getItem('gym_logs')),offlineLogs);
  assert.equal(await offline.evaluate(async()=>(await caches.keys()).includes('weekly-quest-v44')),false);
  const cachedAssets=await offline.evaluate(async()=>Promise.all([1,10,20,30,40].map(async tier=>(await fetch(`sprites/monk_lv${tier}x2.png`)).ok)));
  assert.ok(cachedAssets.every(Boolean));
  assert.equal(await offline.locator('.monk-sprite').evaluate(el=>el.naturalWidth>0),true);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Browser regression checks passed: 0–5, undo, reload, 5 viewport widths, pain, legacy data, workout, reduced motion, offline PWA.');
  await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1);});
