// 批量修改作者端到端：勾选多个主题 → 弹窗输入作者 → 只 PATCH author，
// 作品名/类别/标签保持原样；未勾选的主题不受影响。
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
for(let i=1;i<=3;i++){
  const record={kind:'theme',id:'theme'+i,name:'作品'+i,author:'原作者'+i,style:'',tags:['原标签'],categories:['浅色'],saved_to_cloud:true,sync_status:{library:'synced'}};
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
const patches=[];
await p.route('**/api/themes/**',async route=>{
  if(route.request().method()==='PATCH')patches.push(route.request().postDataJSON()||{});
  return route.continue();
});
try{
  await p.goto(origin+'/reeden-library/#themes',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'),{},{timeout:20000});
  await p.waitForFunction(()=>document.querySelectorAll('#themeList .theme-card-hit').length===3,{},{timeout:20000});
  await p.locator('[data-catalog-selection="theme"]').click();
  await p.locator('#themeList .theme-card-hit').nth(0).click();
  await p.locator('#themeList .theme-card-hit').nth(1).click();
  await p.waitForFunction(()=>document.querySelector('#themeSelectedCount')?.textContent.includes('已选 2'),{},{timeout:10000});
  const before=await p.evaluate(()=>document.querySelector('#bulkAuthorTheme')?.disabled);
  assert.equal(before,false,'勾选主题后“修改作者”按钮必须可用');
  await p.locator('#bulkAuthorTheme').click();
  await p.waitForFunction(()=>document.querySelector('#bulkAuthorDialog')?.open,{},{timeout:10000});
  const sub=await p.locator('#bulkAuthorSub').textContent();
  assert.ok(sub.includes('2 个主题'),'弹窗必须显示将要修改的主题数');
  await p.locator('#bulkAuthorInput').fill('新作者');
  const label=await p.locator('#bulkAuthorApply').textContent();
  assert.ok(label.includes('新作者'),'应用按钮必须回显作者名');
  await p.locator('#bulkAuthorApply').click();
  await p.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('新作者'),{},{timeout:20000});
  const stored=await p.evaluate(async()=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const r=await fetch('/api/library?kind=theme',{headers:token?{Authorization:'Bearer '+token}:{}});
    const j=await r.json().catch(()=>({}));
    return (j.records||[]).slice(0,3).map(x=>({id:x.id,author:x.author,name:x.name,categories:x.categories,tags:x.tags}));
  });
  console.log(JSON.stringify({patches,stored,dialogClosed:await p.evaluate(()=>!document.querySelector('#bulkAuthorDialog')?.open),errors},null,2));
  assert.equal(patches.length,2,'只给勾选的 2 个主题发 PATCH');
  assert.ok(patches.every(body=>body.author==='新作者'),'PATCH 必须携带新作者');
  assert.ok(patches.every(body=>!Object.hasOwn(body,'name')&&!Object.hasOwn(body,'categories')&&!Object.hasOwn(body,'tags')),'批量作者只提交 author，不覆盖作品名/类别/标签');
  assert.equal(stored.filter(item=>item.author==='新作者').length,2,'2 个主题的作者已落库');
  assert.equal(stored.filter(item=>item.author.startsWith('原作者')).length,1,'未勾选的主题作者不变');
  assert.ok(stored.every(item=>item.name&&item.categories?.length&&item.tags?.length),'作品名、类别、标签必须保留');
  assert.deepEqual(errors,[]);
  console.log('PASS: 批量修改作者只改 author，未选主题与其他字段均保持不变。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
