// 字体库端到端回归：
//   1) 样张在网格里用 cover 铺满，不再 contain 留白；
//   2) 反复搜索渲染时同一字体只创建一个 FontFace（无重复下载）；
//   3) 字体分类下拉计数跟随当前搜索结果；
//   4) 数字 id 字体的分类能保存（字符串 id 比较修复）。
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
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB7sAAAAASUVORK5CYII=','base64');
const previewPath='/api/objects/previews/'+'a'.repeat(64)+'.jpg';
await bucket.put('previews/'+'a'.repeat(64)+'.jpg',png);
const fontPath=hash=>'/api/objects/fonts/'+hash+'.ttf';
const records=[
  {kind:'font',id:'font-a',family:'甲字体',file_name:'a.ttf',style:'黑体',tags:['标签甲'],bytes:1000,extension:'ttf',preview_url:previewPath,view_url:fontPath('a'.repeat(64)),url:fontPath('a'.repeat(64)),saved_to_cloud:true,sync_status:{library:'synced'}},
  {kind:'font',id:'font-b',family:'乙字体',file_name:'b.ttf',style:'宋体',tags:['标签乙'],bytes:2000,extension:'ttf',preview_url:'',view_url:fontPath('b'.repeat(64)),url:fontPath('b'.repeat(64)),saved_to_cloud:true,sync_status:{library:'synced'}},
  {kind:'font',id:'font-c',family:'丙字体',file_name:'c.ttf',style:'圆体',tags:['标签丙'],bytes:3000,extension:'ttf',preview_url:'',view_url:fontPath('c'.repeat(64)),url:fontPath('c'.repeat(64)),saved_to_cloud:true,sync_status:{library:'synced'}},
  {kind:'font',id:42,family:'数字字体',file_name:'d.ttf',style:'其他',tags:['标签丁'],bytes:4000,extension:'ttf',preview_url:previewPath,view_url:fontPath('d'.repeat(64)),url:fontPath('d'.repeat(64)),saved_to_cloud:true,sync_status:{library:'synced'}},
];
for(const record of records){
  const bytes=Buffer.from(JSON.stringify(record)),sha=await __test.digestHex(bytes);
  await bucket.put(`records/${sha}.json`,bytes);
}
let origin;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname==='/api/objects/previews/'+'a'.repeat(64)+'.jpg'){res.writeHead(200,{'Content-Type':'image/jpeg'}).end(png);return;}
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
  // 只计数，不改变真实 FontFace 行为：重复创建会立刻在 families 里暴露。
  const Real=window.FontFace;
  window.FontFace=class extends Real{
    constructor(...args){super(...args);window.__fontFaceFamilies=window.__fontFaceFamilies||[];window.__fontFaceFamilies.push(String(args[0]));}
  };
});
const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
const patches=[];
await p.route('**/api/fonts/**',async route=>{
  if(route.request().method()==='PATCH')patches.push(route.request().postDataJSON()||{});
  return route.continue();
});
try{
  await p.goto(origin+'/reeden-library/#fonts',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'),{},{timeout:20000});
  await p.waitForFunction(()=>document.querySelectorAll('#fontList .theme-card').length===4,{},{timeout:20000});
  const objectFit=await p.locator('#fontList .font-preview-image').first().evaluate(el=>getComputedStyle(el).objectFit);
  assert.equal(objectFit,'cover','网格里的字体样张必须 cover 铺满，不能 contain 留白');

  // 反复搜索渲染：无预览字体的 FontFace 每个 id 只允许创建一次。
  for(const term of ['乙','丙','甲','','乙','']){
    await p.locator('#fontSearchInput').fill(term);
    await p.waitForTimeout(220);
  }
  const families=await p.evaluate(()=>window.__fontFaceFamilies||[]);
  const duplicates=families.filter((item,index)=>families.indexOf(item)!==index);
  assert.deepEqual(duplicates,[],`同一字体被重复创建 FontFace：${JSON.stringify(families)}`);

  await p.locator('#fontSearchInput').fill('数字');
  await p.waitForTimeout(250);
  const filterText=await p.locator('#fontCategoryFilters option[value="all"]').textContent();
  assert.ok(filterText.includes('(1)'),`分类计数应跟随搜索结果变为 1，实际：${filterText}`);

  await p.locator('#fontList .theme-card-hit').first().click();
  await p.waitForFunction(()=>document.querySelector('#recordDialog')?.open,{},{timeout:10000});
  const form=p.locator('#recordDialog form[data-record-form="42"]');
  await form.locator('input[name="style"]').fill('新分类');
  const [patchResponse]=await Promise.all([
    p.waitForResponse(resp=>resp.url().includes('/api/fonts/')&&resp.request().method()==='PATCH',{timeout:20000}),
    form.locator('button[type="submit"]').click(),
  ]);
  assert.equal(patchResponse.status(),200,'分类保存请求必须成功');
  const savedStyle=await p.evaluate(async()=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const r=await fetch('/api/library?kind=font',{headers:token?{Authorization:'Bearer '+token}:{}});
    const j=await r.json().catch(()=>({}));
    return (j.records||[]).find(item=>String(item.id)==='42')?.style||'';
  });
  console.log(JSON.stringify({objectFit,families,filterText,patches,savedStyle,errors},null,2));
  assert.ok(patches.length>=1,'数字 id 字体必须发出 PATCH 才能保存分类');
  assert.ok(patches.some(body=>body.style==='新分类'),'PATCH 必须携带新分类');
  assert.equal(savedStyle,'新分类','数字 id 字体的分类已落库');
  assert.deepEqual(errors,[]);
  console.log('PASS: 字体样张 cover、FontFace 不重复、筛选计数随搜索、数字 id 分类可保存。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
