// Local browser smoke test only; no live OAuth/provider calls.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const mime = { '.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };
const server = http.createServer((req,res)=> {
  const url=new URL(req.url,'http://localhost');
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/tracker.html':url.pathname));
  if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
  fs.readFile(file,(e,data)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.addInitScript(()=>localStorage.setItem('wt_habits_v1',JSON.stringify({habits:[{id:'synthetic',name:'Synthetic habit',goal:{type:'check',target:1},freq:{type:'daily',days:[],times:1},createdOn:'2026-10-18',archived:false}]})));
    const requests=[];await page.route('**/api/private-sync**',route=>{requests.push(route.request().method());return route.fulfill({json:{configured:false,connected:false,enabled:false,csrfToken:null}});});
    await page.goto(`http://127.0.0.1:${server.address().port}/tracker.html`);
    await page.locator('#menu-open').click();await page.locator('#private-sync-open').click();
    await page.locator('#private-sync-modal').waitFor({state:'visible'});
    assert.match(await page.locator('#ps-title').innerText(),/Notion/);
    await page.locator('#ps-preview-button').click();
    assert.match(await page.locator('#ps-preview').innerText(),/Synthetic habit/);
    assert.match(await page.locator('#private-sync-modal').innerText(),/30/);
    await page.keyboard.press('Escape');await page.locator('#private-sync-modal').waitFor({state:'hidden'});
    await page.locator('#menu-open').click();await page.locator('#private-sync-open').click();
    assert.equal(await page.locator('#ps-consent').isChecked(),false);
    assert.equal(requests.filter(m=>m==='POST').length,0);
    console.log('Private Notion settings/preview/close/reopen mobile smoke passed; no mutation requests.');
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
