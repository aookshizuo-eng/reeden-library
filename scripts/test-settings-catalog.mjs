// npm run build:pages; PLAYWRIGHT_PACKAGE can point to Playwright's package.json.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {handle,__test} from '../pages/worker-api.js';
import {MemoryR2} from './test-memory-r2.mjs';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
const root=fileURLToPath(new URL('..',import.meta.url)),bucket=new MemoryR2();
const preview='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#e3ebe0"/><text x="36" y="140" font-size="36" fill="#33513e">山间有风 · Reading</text></svg>');
for(const kind of ['theme','font','asset'])for(let i=1;i<=110;i++){
  const record={kind,id:kind+i,name:'阅读作品 '+String(i).padStart(3,'0'),family:'阅读字体 '+String(i).padStart(3,'0'),author:'作者 '+i%3,file_name:'素材'+i+'.'+({theme:'red',font:'ttf',asset:'svg'}[kind]),extension:kind==='font'?'ttf':'svg',style:'宋体',categories:['暖色'],tags:['阅读'],bytes:i*100,preview_url:preview,preview_light_url:preview,url:preview,object_url:preview,sync_status:'synced',created_at:new Date(1700000000000+i*86400000).toISOString()};
  const bytes=Buffer.from(JSON.stringify(record));await bucket.put('records/'+await __test.digestHex(bytes)+'.json',bytes);
}
let origin,libraryCalls=0;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      if(url.pathname==='/api/library')libraryCalls++;
      const chunks=[];for await(const c of req)chunks.push(c);
      const response=await handle(new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}),{ASSETS:bucket,SYNC_WRITE_TOKEN:'test-token',ALLOWED_ORIGINS:origin});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const file=url.pathname.replace(/^\/reeden-library\//,'')||'index.html';
    const bytes=await readFile(path.join(root,'dist-pages',file));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'}).end(bytes);
  }catch(error){res.writeHead(500).end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true}),errors=[];
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{localStorage.setItem('reeden-api-base',location.origin);localStorage.setItem('reeden-sync-write-token','test-token');localStorage.setItem('reeden-auto-resume-queue','off');});
const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
async function capture(name){if(process.env.UI_SCREENSHOTS){await mkdir(process.env.UI_SCREENSHOTS,{recursive:true});await p.screenshot({path:path.join(process.env.UI_SCREENSHOTS,name+'.png'),fullPage:!name.includes('detail')});}}
try{
  await p.goto(origin+'/reeden-library/#storage');await p.waitForFunction(()=>document.querySelector('#apiBaseStatus').textContent.includes('已连接共享库'));
  if(process.env.SNAPSHOT_ONLY){await capture('settings-before');await p.locator('[data-view=fonts]').click();await capture('fonts-before');}
  else {
    await capture('settings-after');
    assert.equal(await p.locator('#connectionDetails').getAttribute('open'),null);
    assert.equal(await p.locator('#deviceTransferDetails').getAttribute('open'),null);
    assert.equal(await p.locator('#maintenanceDetails').getAttribute('open'),null);
    assert.equal(await p.locator('#savePan123Backup').count(),0);assert.equal(await p.locator('#testWriteAccess').count(),0);
    // Editing fields must not save or trigger library reloads before the one save action.
    await p.locator('#connectionDetails > summary').click();const before=libraryCalls;
    await p.locator('#syncTokenInput').fill('edited-but-not-saved');await p.locator('#apiBaseInput').focus();
    assert.equal(await p.evaluate(()=>localStorage.getItem('reeden-sync-write-token')),'test-token');assert.equal(libraryCalls,before);
    await p.locator('#syncTokenInput').fill('test-token');await p.locator('#saveApiBase').click();await p.waitForFunction(()=>document.querySelector('#apiBaseStatus').textContent.includes('已连接共享库')&&!document.querySelector('#saveApiBase').disabled);
    assert.ok(libraryCalls-before<=1);await p.locator('#connectionDetails > summary').click();
    await p.locator('#maintenanceDetails > summary').click();const refreshBefore=libraryCalls,listBefore=bucket.lists;await p.locator('#pullStorage').click();await p.waitForFunction(()=>document.querySelector('#storageOperation').textContent.includes('已刷新')&&!document.querySelector('#pullStorage').disabled);assert.equal(libraryCalls-refreshBefore,1);assert.equal(bucket.lists,listBefore,'refresh reads the index without listing all R2 objects');await p.locator('#maintenanceDetails > summary').click();
    await p.locator('#settingsBackup123Enabled').check();assert.equal(await p.locator('#backupTo123').isChecked(),true);assert.equal(await p.locator('#pan123BackupControls').isVisible(),true);
    await p.locator('#pan123BrowserLoginMethods > details > summary').click();await p.locator('#pan123TokenDetails > summary').click();await p.locator('#pan123BackupToken').fill('Bearer settings-fixture-token');await p.locator('#pan123BackupFolder').fill('My-RED-Backup');await p.locator('#pan123BackupFolder').blur();
    assert.equal(await p.evaluate(()=>localStorage.getItem('reeden-pan123-token')),'settings-fixture-token');
    assert.equal(await p.locator('#verifyPan123Write').isVisible(),false,'side-effectful checks are disclosed separately');
    await p.locator('#settingsBackup123Enabled').uncheck();assert.equal(await p.locator('#backupTo123').isChecked(),false);assert.equal(await p.evaluate(()=>localStorage.getItem('reeden-pan123-token')),'settings-fixture-token');
    console.log('PASS: one explicit connection save; 123 folder/token auto-save; shared backup switch; advanced checks collapsed.');

    // Real encryption, device links, wrong-password protection, and import on a fresh device.
    await p.locator('#deviceTransferDetails > summary').click();await p.locator('[name=passphrase]').fill('device-test-passphrase');await p.locator('#deviceTransferForm button[value=link]').click();await p.waitForFunction(()=>!document.querySelector('#deviceLinkLabel').hidden);
    const link=await p.locator('#deviceConnectLink').inputValue();assert.ok(!link.includes('test-token'));
    const fresh=await browser.newContext({viewport:{width:1280,height:900}});await fresh.addInitScript(()=>{localStorage.setItem('reeden-api-base',location.origin);localStorage.setItem('reeden-auto-resume-queue','off');});const q=await fresh.newPage();q.on('pageerror',e=>errors.push(e.message));await q.goto(link);await q.waitForSelector('#deviceTransferDetails[open]');assert.equal(await q.locator('[data-transfer-panel=import]').isVisible(),true);assert.equal(await q.locator('#deviceConfigFileLabel').isVisible(),false);
    await q.locator('[name=passphrase]').fill('wrong-password');await q.locator('#deviceTransferForm button[value=import]').click();await q.waitForFunction(()=>document.querySelector('#deviceTransferStatus').textContent.includes('口令不正确'));assert.equal(await q.evaluate(()=>localStorage.getItem('reeden-sync-write-token')),null);
    await q.locator('[name=passphrase]').fill('device-test-passphrase');await q.locator('#deviceTransferForm button[value=import]').click();await q.waitForFunction(()=>document.querySelector('#apiBaseStatus').textContent.includes('已连接共享库'));assert.equal(await q.evaluate(()=>localStorage.getItem('reeden-sync-write-token')),'test-token');
    await p.locator('#deviceTransferForm details > summary').click();await p.locator('[name=passphrase]').fill('cloud-test-passphrase');await p.locator('#deviceTransferForm button[value=cloud-save]').click();await p.waitForFunction(()=>document.querySelector('#deviceTransferStatus').textContent.includes('保存到私有库'));await p.locator('[name=passphrase]').fill('cloud-test-passphrase');await p.locator('#deviceTransferForm button[value=cloud-load]').click();await p.waitForFunction(()=>document.querySelector('#deviceTransferStatus').textContent.includes('配置已导入')&&!document.querySelector('#deviceTransferForm button[value=cloud-load]').disabled);
    console.log('PASS: encrypted link import on a fresh device, wrong-password safety, cloud save and restore.');

    for(const [kind,view]of [['theme','themes'],['font','fonts'],['asset','assets']]){
      await p.locator(`[data-view=${view}]`).click();const list=p.locator('#'+kind+'List');assert.equal(await list.locator('.theme-card').count(),24);
      await capture(kind+'-library-after');
      const input=p.locator('#'+kind+'PageInput');await input.fill('3');await input.press('Enter');assert.match(await p.locator('#'+kind+'PageInfo').innerText(),/第 3 \/ 5 页/);
      await input.fill('999');await p.locator(`[data-page-jump=${kind}] button`).click();assert.match(await p.locator('#'+kind+'PageInfo').innerText(),/第 5 \/ 5 页/);assert.equal(await list.locator('.theme-card').count(),14);
      await input.fill('');await input.press('Enter');assert.match(await p.locator('#'+kind+'PageInfo').innerText(),/第 5/);await input.fill('0');await input.press('Enter');assert.match(await p.locator('#'+kind+'PageInfo').innerText(),/第 1/);
      await p.locator(`[data-catalog-density=${kind}][data-density=list]`).click();assert.equal(await list.evaluate(e=>e.classList.contains('is-list')),true);await p.locator(`[data-catalog-density=${kind}][data-density=grid]`).click();
      await list.locator('.theme-card-hit').first().click();const dialog=p.locator(kind==='theme'?'#themeDialog':'#recordDialog');assert.equal(await dialog.isVisible(),true);if(kind!=='theme')await capture(kind+'-detail-after');await p.locator(kind==='theme'?'#closeThemeDialog':'#closeRecordDialog').click();
      await p.locator(`[data-catalog-selection=${kind}]`).click();await list.locator('.theme-card-hit').nth(0).click();await list.locator('.theme-card-hit').nth(1).click();assert.match(await p.locator('#'+kind+'SelectedCount').innerText(),/已选 2 项/);
      await list.locator('.theme-more').first().click();assert.equal(await dialog.isVisible(),true);await p.locator(kind==='theme'?'#closeThemeDialog':'#closeRecordDialog').click();assert.match(await p.locator('#'+kind+'SelectedCount').innerText(),/已选 2 项/);
      await p.locator(`[data-catalog-selection=${kind}]`).click();assert.match(await p.locator('#'+kind+'SelectedCount').innerText(),/已选 0 项/);assert.equal(await list.locator('.item-select:checked').count(),0);
    }
    console.log('PASS: all three libraries share card/detail/multi-select/list controls; page input handles Enter, empty and out-of-range values.');

    // Classification controls still persist through the real Worker, off the cards.
    await p.locator('#assetList .theme-card-hit').first().click();await p.locator('#recordDialog input[name=author]').fill('新作者');await p.locator('#recordDialog input[name=tags]').fill('新标签, 测试');await p.locator('#recordDialog button[type=submit]').click();await p.waitForFunction(()=>document.querySelector('#assetList').textContent.includes('新作者'));await p.locator('#closeRecordDialog').click();
    await p.locator('[data-view=fonts]').click();await p.locator('#fontList .theme-card-hit').first().click();await p.locator('#recordDialog input[name=style]').fill('手写体');await p.locator('#recordDialog button[type=submit]').click();await p.waitForFunction(()=>document.querySelector('#fontList').textContent.includes('手写体'));await p.locator('#closeRecordDialog').click();
    await p.locator('#fontCategoryFilters').selectOption('手写体');assert.equal(await p.locator('#fontList .theme-card').count(),1);await p.locator('#fontCategoryFilters').selectOption('all');
    assert.equal(await p.locator('#fontList .font-specimen').first().isVisible(),true,'font cards always keep the rich specimen');assert.equal(await p.locator('#fontList .font-preview-fallback').first().isVisible(),false,'single-line legacy specimen must not come back');
    await p.locator('[data-view=themes]').click();await p.locator('#themePageInput').fill('4');await p.locator('#themePageInput').press('Enter');await p.reload();await p.waitForFunction(()=>document.querySelector('#apiBaseStatus').textContent.includes('已连接共享库'));assert.match(await p.locator('#themePageInfo').innerText(),/第 4/);
    console.log('PASS: font/asset classification edits persist; filtering resets pages; current page survives reload.');
    await p.setViewportSize({width:390,height:844});
    for(const [view,kind]of [['storage','settings'],['themes','theme'],['fonts','font'],['assets','asset']]){
      await p.evaluate(view=>document.querySelector(`[data-view="${view}"]`).click(),view);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),view+' must fit phone');await capture(kind+'-mobile-after');
      if(view!=='storage'){await p.locator('#'+kind+'PageInput').fill('2');await p.locator('#'+kind+'PageInput').press('Enter');assert.match(await p.locator('#'+kind+'PageInfo').innerText(),/第 2/);}
    }
    assert.deepEqual(errors,[]);
    assert.deepEqual(await p.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return ids.filter((id,i)=>ids.indexOf(id)!==i);}),[],'shared components must not duplicate IDs');
    console.log('PASS: mobile settings, all catalogs and page jumps; zero browser runtime errors.');
  }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
