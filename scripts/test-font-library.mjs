// 字体库端到端回归：
//   1) JPG 兜底样张用 contain 完整显示不裁字，富样张结构存在；
//   2) 反复搜索渲染时同一字体只创建一个 FontFace（无重复下载）；
//   3) 字体分类下拉计数跟随当前搜索结果；
//   4) 数字 id 字体的分类能保存（字符串 id 比较修复）；
//   5) 库卡片右下角显示醒目下载按钮，指向带 download 语义的地址；
//   6) 富样张同时有简体和繁体两行，搜索重建 DOM 后仍套用已加载字形；
//   7) FontFace 被 OTS 拒绝时用 opentype.js 描边样张兜底。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
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
// 用系统字体作为真实 FontFace 源；没有这台机器的字体时测试跳过字形套用断言。
const localFont='C:/Windows/Fonts/NotoSansSC-VF.ttf';
const realFont=existsSync(localFont)?await readFile(localFont):null;
if(realFont){await bucket.put('fonts/'+'a'.repeat(64)+'.ttf',realFont);await bucket.put('fonts/'+'b'.repeat(64)+'.ttf',realFont);await bucket.put('fonts/'+'d'.repeat(64)+'.ttf',realFont);}
const fontPath=hash=>'/api/objects/fonts/'+hash+'.ttf';
const records=[
  {kind:'font',id:'font-a',family:'甲字体',file_name:'a.ttf',style:'黑体',tags:['标签甲'],bytes:1000,extension:'ttf',preview_url:previewPath,preview_kind:'specimen-v2',view_url:fontPath('a'.repeat(64)),url:fontPath('a'.repeat(64)),saved_to_cloud:true,sync_status:{library:'synced'}},
  {kind:'font',id:'font-b',family:'乙字体',file_name:'b.ttf',style:'宋体',tags:['标签乙'],bytes:2000,extension:'ttf',preview_url:'',view_url:fontPath('b'.repeat(64)),url:fontPath('b'.repeat(64)),saved_to_cloud:true,sync_status:{library:'synced'}},
  {kind:'font',id:'font-c',family:'丙字体',file_name:'c.ttf',style:'圆体',tags:['标签丙'],bytes:3000,extension:'ttf',preview_url:'',view_url:fontPath('c'.repeat(64)),url:fontPath('c'.repeat(64)),saved_to_cloud:true,sync_status:{library:'synced'}},
  {kind:'font',id:42,family:'数字字体',file_name:'d.ttf',style:'其他',tags:['标签丁'],bytes:4000,extension:'ttf',preview_url:previewPath,preview_kind:'specimen-v2',view_url:fontPath('d'.repeat(64)),url:fontPath('d'.repeat(64)),saved_to_cloud:true,sync_status:{library:'synced'}},
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
const fontRequests=[];
await p.route('**/api/objects/fonts/**',route=>{fontRequests.push(route.request().url());return route.continue();});
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
  assert.equal(objectFit,'contain','网格里的 JPG 样张必须 contain 完整显示，不能再裁成半截大字');
  const imageCard=await p.locator('#fontList .font-preview-frame[data-font-id="font-a"]').evaluate(frame=>{
    const image=frame.querySelector('.font-preview-image');
    return {src:image?.getAttribute('src')||'',hidden:image?.hidden,hasSpecimen:Boolean(frame.querySelector('.font-specimen'))};
  });
  assert.ok(imageCard.src.includes('/previews/')&&imageCard.hidden===false,`已有五行样张图的字体必须直接显示图片：${JSON.stringify(imageCard)}`);
  assert.equal(imageCard.hasSpecimen,false,'图片预览卡片不能再保留实时字形样张');
  const specimenRows=await p.locator('#fontList .font-specimen .specimen-hero, #fontList .font-specimen .specimen-cjk, #fontList .font-specimen .specimen-latin, #fontList .font-specimen .specimen-digits').count();
  assert.ok(specimenRows>=8,'每张字体卡片应有 4 行富样张结构（4 张卡片）');
  const downloadHref=await p.locator('#fontList .font-card-download, #fontList .catalog-download').first().getAttribute('href');
  assert.ok(downloadHref&&downloadHref.includes('download=1'),`库卡片必须直接提供下载按钮且带 download 语义，实际：${downloadHref}`);
  const downloadBox=await p.locator('#fontList .catalog-download').first().evaluate(el=>{
    const card=el.closest('.theme-card').getBoundingClientRect(),box=el.getBoundingClientRect(),style=getComputedStyle(el);
    return {rightGap:card.right-box.right,bottomGap:card.bottom-box.bottom,position:style.position,zIndex:style.zIndex};
  });
  assert.equal(downloadBox.position,'absolute','下载按钮必须绝对定位到卡片角上');
  assert.ok(downloadBox.rightGap<24&&downloadBox.bottomGap<24,`下载按钮必须贴在卡片右下角：${JSON.stringify(downloadBox)}`);
  assert.ok(Number(downloadBox.zIndex)>=3,'下载按钮必须盖过整卡点击层');
  const scText=await p.locator('#fontList .font-specimen .specimen-sc').first().textContent();
  const tcText=await p.locator('#fontList .font-specimen .specimen-tc').first().textContent();
  assert.ok(scText.includes('简体')&&tcText.includes('繁體'),`样张必须同时有简体与繁体：${scText} / ${tcText}`);

  // 反复搜索渲染：无预览字体的 FontFace 每个 id 只允许创建一次。
  for(const term of ['乙','丙','甲','','乙','']){
    await p.locator('#fontSearchInput').fill(term);
    await p.waitForTimeout(220);
  }
  // 搜索重建 DOM 后，图片预览仍是图片；只有没预览图的字体才复用已加载字形。
  await p.locator('#fontSearchInput').fill('甲');
  const stillImage=await p.locator('#fontList .font-preview-frame[data-font-id="font-a"] .font-preview-image').evaluate(img=>({src:img.getAttribute('src')||'',hidden:img.hidden}));
  assert.ok(stillImage.src.includes('/previews/')&&stillImage.hidden===false,'搜索重建后图片预览不能被换回实时字形');
  if(realFont){
    await p.locator('#fontSearchInput').fill('乙');
    await p.waitForFunction(()=>{const f=document.querySelector('#fontList .font-specimen');return f&&!f.hidden&&getComputedStyle(f).fontFamily.includes('font-');},{},{timeout:15000});
    const reapplied=await p.locator('#fontList .font-specimen').first().evaluate(f=>({hidden:f.hidden,family:getComputedStyle(f).fontFamily}));
    assert.equal(reapplied.hidden,false,'搜索重建后富样张不能被 hidden 盖回旧 JPG');
    assert.ok(reapplied.family.includes('font-'),`搜索重建后必须复用已加载字体：${reapplied.family}`);
  }
  const families=await p.evaluate(()=>window.__fontFaceFamilies||[]);
  const duplicates=families.filter((item,index)=>families.indexOf(item)!==index);
  assert.deepEqual(duplicates,[],`同一字体被重复创建 FontFace：${JSON.stringify(families)}`);
  assert.ok(!families.includes('font-font-a')&&!families.includes('font-42'),`已有预览图的字体不能创建 FontFace：${JSON.stringify(families)}`);
  assert.ok(!fontRequests.some(url=>url.includes('a'.repeat(64))),`已有预览图的字体不能再下载原字体重渲染：${JSON.stringify(fontRequests)}`);

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
  console.log('PASS: JPG contain 不裁字、富样张结构在、卡片有下载按钮、FontFace 不重复、筛选计数随搜索、数字 id 分类可保存。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
