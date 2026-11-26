// 批量规模回归：复现截图里 21 项批量改标签/作者的场景。
// 旧实现逐条 PATCH，每条都对整份索引做一次 ETag 读-改-写，互相抢锁后大面积 409。
// 新实现一次 batch-patch 请求写完，断言只发一次请求、全部成功、耗时可控。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {handle, __test} from '../pages/worker-api.js';
import {MemoryR2} from './test-memory-r2.mjs';
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url),{chromium}=require('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const bucket=new MemoryR2();
const COUNT=21;
for(let i=1;i<=COUNT;i++){
  const record={kind:'theme',id:'scale'+i,name:'作品'+i,author:'原作者'+i,style:'',tags:['旧标签'],categories:['浅色'],saved_to_cloud:true,sync_status:{library:'synced'}};
  const bytes=Buffer.from(JSON.stringify(record)),sha=await __test.digestHex(bytes);
  await bucket.put(`records/${sha}.json`,bytes);
}
let origin;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      const chunks=[];for await(const c of req)chunks.push(c);
      const response=await handle(new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}),{ASSETS:bucket,SYNC_WRITE_TOKEN:'test-token',ALLOWED_ORIGINS:origin});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const file=url.pathname.replace(/^\/reeden-library\//,'')||'index.html',bytes=await readFile(path.join(root,'dist-pages',file));
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'}).end(bytes);
  }catch(error){if(!res.headersSent)res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true}),errors=[];
const context=await browser.newContext({viewport:{width:1440,height:960}});
await context.addInitScript(()=>{
  localStorage.setItem('reeden-api-base',location.origin);
  localStorage.setItem('reeden-sync-write-token','test-token');
  localStorage.setItem('reeden-auto-resume-queue','off');
});
const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
const batches=[];
await p.route('**/api/library/batch-patch',async route=>{
  batches.push(route.request().postDataJSON()||{});
  return route.continue();
});
const waitFor=async(regex,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){if(regex.test(await p.evaluate(()=>document.querySelector('#toast')?.textContent||'')))return true;await p.waitForTimeout(100);}return false;};
try{
  await p.goto(origin+'/reeden-library/#themes',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'),{},{timeout:20000});
  await p.waitForFunction(()=>document.querySelectorAll('#themeList .theme-card-hit').length>=21,{},{timeout:20000});
  await p.locator('[data-catalog-selection="theme"]').click();
  await p.locator('#selectAllThemes').check();
  await p.waitForFunction(()=>document.querySelector('#themeSelectedCount')?.textContent.includes('已选 21'),{},{timeout:10000});

  // 1) 批量作者：21 项一次提交，不得出现 409 或失败。
  await p.locator('#bulkAuthorTheme').click();
  await p.waitForFunction(()=>document.querySelector('#bulkAuthorDialog')?.open,{},{timeout:10000});
  await p.locator('#bulkAuthorInput').fill('新作者');
  const authorStart=Date.now();
  await p.locator('#bulkAuthorApply').click();
  assert.ok(await waitFor(/已把作者/),'批量作者没有回报成功');
  const authorMs=Date.now()-authorStart;
  const storedAuthors=await p.evaluate(async()=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const r=await fetch('/api/library?all=1&kind=theme',{headers:token?{Authorization:'Bearer '+token}:{}});
    return (await r.json()).records.filter(x=>x.author==='新作者').length;
  });
  assert.equal(storedAuthors,COUNT,`21 项批量作者应全部落库，实际 ${storedAuthors}`);
  assert.equal(batches.length,1,`批量作者只能发一次 batch-patch 请求，实际 ${batches.length}`);
  assert.equal(batches[0].changes?.length,COUNT,'批量作者应一次携带 21 条变更');
  assert.ok(authorMs<15000,`批量作者耗时过长：${authorMs}ms`);

  // 2) 批量标签：同样 21 项，一次请求完成。
  batches.length=0;
  await p.locator('[data-bulk-tags="theme"]').click();
  await p.waitForFunction(()=>document.querySelector('#bulkTagDialog')?.open,{},{timeout:10000});
  await p.locator('#bulkTagForm select[name="mode"]').selectOption('add');
  await p.locator('#bulkTagForm input[name="tags"]').fill('直购');
  await p.locator('#bulkTagForm button[type="submit"]').click();
  assert.ok(await waitFor(/标签已保存/),'批量标签没有回报成功');
  const storedTags=await p.evaluate(async()=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const r=await fetch('/api/library?all=1&kind=theme',{headers:token?{Authorization:'Bearer '+token}:{}});
    return (await r.json()).records.filter(x=>(x.tags||[]).includes('直购')).length;
  });
  assert.equal(storedTags,COUNT,`21 项批量标签应全部落库，实际 ${storedTags}`);
  assert.equal(batches.length,1,`批量标签只能发一次 batch-patch 请求，实际 ${batches.length}`);
  assert.equal(batches[0].changes?.length,COUNT,'批量标签应一次携带 21 条变更');
  const status=await p.locator('#bulkTagStatus').textContent();
  assert.ok(!status.includes('失败'),`批量标签不应有失败项：${status}`);
  // 打进去的标签必须能在主题卡片上看到，且分类与标签分行也能放下。
  await p.evaluate(()=>{location.hash='#themes';});
  await p.waitForFunction(()=>document.querySelectorAll('#themeList .theme-card').length>=21,{},{timeout:10000});
  const cardTags=await p.locator('#themeList .theme-card').first().evaluate(card=>
    [...card.querySelectorAll('.theme-categories em')].map(item=>item.textContent));
  assert.ok(cardTags.includes('#直购'),`卡片上应显示手动打的标签，实际：${cardTags.join(',')}`);
  assert.ok(cardTags.includes('浅色'),`卡片上应保留自动分类，实际：${cardTags.join(',')}`);
  const wrapped=await p.locator('#themeList .theme-card .theme-categories').first().evaluate(el=>{
    const r=el.getBoundingClientRect(),line=el.querySelector('em')?.getBoundingClientRect();
    return {width:r.width,cardWidth:el.closest('.theme-card')?.getBoundingClientRect().width,emWidth:line?.width||0};
  });
  assert.ok(wrapped.width>100&&wrapped.width<=wrapped.cardWidth+1,`标签行应铺满卡片宽度，实际：${JSON.stringify(wrapped)}`);
  assert.deepEqual(errors,[]);
  console.log(`PASS: 21 项批量作者/标签各一次请求完成（作者 ${authorMs}ms），无 409、无失败；标签已显示在卡片上。`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
