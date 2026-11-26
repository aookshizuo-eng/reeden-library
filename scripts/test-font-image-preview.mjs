// 字体预览图片化回归：
//   1) 带 specimen-v2 预览图的字体直接显示图片，不下载原字体、不建 FontFace；
//   2) 老版单行预览只在第一次看到时重画一次并 PATCH 写回，之后刷新不再重画；
//   3) 重画出来的 JPG 是 700×300 的五行样张，尺寸与卡片固定高度一致。
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
const fontBytes=await readFile('C:/Windows/Fonts/Deng.ttf');
const sha=await __test.digestHex(fontBytes);
const oldPreview=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB7sAAAAASUVORK5CYII=','base64');
const oldPreviewPath='/api/objects/previews/'+'a'.repeat(64)+'.jpg';
await bucket.put('previews/'+'a'.repeat(64)+'.jpg',oldPreview);
await bucket.put(`fonts/legacy~${sha}.ttf`,fontBytes);
await bucket.put(`fonts/v2~${sha}.ttf`,fontBytes);
const records=[
  {kind:'font',id:'font-legacy',sha256:sha,family:'老预览字体',file_name:'legacy.ttf',style:'宋体',tags:[],bytes:fontBytes.length,extension:'ttf',preview_url:oldPreviewPath,view_url:`/api/objects/fonts/legacy~${sha}.ttf`,url:`/api/objects/fonts/legacy~${sha}.ttf`,saved_to_cloud:true,sync_status:{library:'synced'},created_at:new Date().toISOString()},
  {kind:'font',id:'font-v2',sha256:sha,family:'图片样张字体',file_name:'v2.ttf',style:'黑体',tags:[],bytes:fontBytes.length,extension:'ttf',preview_url:oldPreviewPath,preview_kind:'specimen-v2',view_url:`/api/objects/fonts/v2~${sha}.ttf`,url:`/api/objects/fonts/v2~${sha}.ttf`,saved_to_cloud:true,sync_status:{library:'synced'},created_at:new Date().toISOString()},
];
for(const record of records){
  const bytes=Buffer.from(JSON.stringify(record));
  await bucket.put(`records/${await __test.digestHex(bytes)}.json`,bytes);
}
function jpegSize(buffer){
  let i=2;
  while(i+9<buffer.length){
    if(buffer[i]!==0xFF){i++;continue;}
    const marker=buffer[i+1];
    if([0xC0,0xC1,0xC2,0xC3].includes(marker))return {height:buffer.readUInt16BE(i+5),width:buffer.readUInt16BE(i+7)};
    if(marker===0xD8||marker===0xD9||marker===0x01||(marker>=0xD0&&marker<=0xD7)){i+=2;continue;}
    const length=buffer.readUInt16BE(i+2);
    if(length<2)return null;
    i+=2+length;
  }
  return null;
}
let origin;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      const chunks=[];for await(const c of req)chunks.push(c);
      const headers={...req.headers,...(req.method==='GET'&&url.pathname.startsWith('/api/')?{authorization:'Bearer test-token'}:{})};
      const response=await handle(new Request(url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}),{ASSETS:bucket,SYNC_WRITE_TOKEN:'test-token',ALLOWED_ORIGINS:origin});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const file=url.pathname.replace(/^\/reeden-library\//,'')||'index.html',bytes=await readFile(path.join(root,'dist-pages',file));
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'}).end(bytes);
  }catch(error){if(!res.headersSent)res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:960}});
await context.addInitScript(()=>{
  localStorage.setItem('reeden-api-base',location.origin);
  localStorage.setItem('reeden-sync-write-token','test-token');
  localStorage.setItem('reeden-auto-resume-queue','off');
  const Real=window.FontFace;
  window.FontFace=class extends Real{
    constructor(...args){super(...args);window.__fontFaceFamilies=window.__fontFaceFamilies||[];window.__fontFaceFamilies.push(String(args[0]));}
  };
});
const p=await context.newPage(),errors=[],fontRequests=[],patches=[];
p.on('pageerror',e=>errors.push(e.message));
await p.route('**/api/objects/fonts/**',route=>{fontRequests.push(route.request().url());return route.continue();});
await p.route('**/api/fonts/**',route=>{
  if(route.request().method()==='PATCH')patches.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()||{}});
  return route.continue();
});
try{
  await p.goto(origin+'/reeden-library/#fonts',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelectorAll('#fontList .theme-card').length===2,{},{timeout:20000});
  const cardState=id=>p.evaluate(id=>{
    const frame=document.querySelector(`#fontList .font-preview-frame[data-font-id="${id}"]`);
    const image=frame?.querySelector('.font-preview-image');
    return {src:image?.getAttribute('src')||'',hidden:image?.hidden,upgrade:image?.dataset.fontUpgrade||'',hasSpecimen:Boolean(frame?.querySelector('.font-specimen'))};
  },id);
  const v2=await cardState('font-v2');
  assert.ok(v2.src.includes('/previews/')&&v2.hidden===false&&!v2.hasSpecimen,`图片字体必须直接显示预览图：${JSON.stringify(v2)}`);
  const before=await cardState('font-legacy');
  assert.ok(before.src.includes('/previews/')&&before.upgrade.includes('font-legacy'),`老版预览先显示旧图并排队升级：${JSON.stringify(before)}`);

  await p.waitForFunction(()=>document.querySelector('#fontList .font-preview-frame[data-font-id="font-legacy"] .font-preview-image')?.dataset.fontUpgrade===undefined,{},{timeout:60000});
  const after=await cardState('font-legacy');
  assert.notEqual(after.src,before.src,'老版预览升级后必须换成新画的图');
  assert.equal(after.hasSpecimen,false,'升级完成后不能再出现实时字形样张');
  const patch=patches.find(item=>String(item.path).includes('/api/fonts/font-legacy'));
  assert.ok(patch&&patch.body.preview_kind==='specimen-v2',`升级必须 PATCH 写回新预览：${JSON.stringify(patches)}`);
  const response=await fetch(new URL(after.src,origin),{headers:{authorization:'Bearer test-token'}});
  assert.equal(response.status,200,'新预览图必须能从对象池读回');
  const size=jpegSize(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(size,{height:300,width:700},`五行样张必须是 700×300 JPG：${JSON.stringify(size)}`);

  const families=await p.evaluate(()=>window.__fontFaceFamilies||[]);
  assert.ok(!families.includes('font-font-v2'),`图片字体不能创建 FontFace：${JSON.stringify(families)}`);
  assert.ok(!fontRequests.some(url=>url.includes('v2~')),'图片字体不能再下载原字体');
  assert.equal(fontRequests.filter(url=>url.includes('legacy~')).length,1,'老字体只应下载一次');

  await p.reload({waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelectorAll('#fontList .theme-card').length===2,{},{timeout:20000});
  const again=await cardState('font-legacy');
  assert.equal(again.src,after.src,'刷新后应直接沿用已写回的图片预览');
  assert.equal(patches.filter(item=>String(item.path).includes('/api/fonts/font-legacy')).length,1,'刷新后不能再次升级同一张预览');
  assert.equal(fontRequests.filter(url=>url.includes('legacy~')).length,1,'刷新后不能再下载原字体');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({before,after,again,size,fontRequests,patchBodies:patches.map(item=>item.body),errors},null,2));
  console.log('PASS: 字体预览直接读图；老预览只重画一次，刷新后不再下载原字体或重渲染。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
