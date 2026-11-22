// 字体样张状态机回归：新上传的大字体在下载期间必须保持简繁五行样张，
// 不能退回入库时的单行 JPG；彻底加载失败要给出可点重试，重试成功后恢复真实字形。
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
const missingSha='f'.repeat(64);
// 正常字体故意慢 1.2s，才能观察到「加载中仍是新版式」这一段。
await bucket.put(`fonts/slow~${sha}.ttf`,fontBytes);
const records=[
  {kind:'font',id:'font-slow',sha256:sha,family:'慢字体',file_name:'slow.ttf',style:'宋体',tags:[],bytes:fontBytes.length,extension:'ttf',preview_url:'',view_url:`/api/objects/fonts/slow~${sha}.ttf`,url:`/api/objects/fonts/slow~${sha}.ttf`,saved_to_cloud:true,sync_status:{library:'synced'},created_at:new Date().toISOString()},
  {kind:'font',id:'font-missing',sha256:missingSha,family:'缺失字体',file_name:'missing.ttf',style:'宋体',tags:[],bytes:1000,extension:'ttf',preview_url:'',view_url:`/api/objects/fonts/missing~${missingSha}.ttf`,url:`/api/objects/fonts/missing~${missingSha}.ttf`,saved_to_cloud:true,sync_status:{library:'synced'},created_at:new Date().toISOString()},
];
for(const record of records){
  const bytes=Buffer.from(JSON.stringify(record));
  await bucket.put(`records/${await __test.digestHex(bytes)}.json`,bytes);
}
let origin;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      const chunks=[];for await(const c of req)chunks.push(c);
      if(url.pathname.includes('slow~')&&req.method==='GET')await new Promise(r=>setTimeout(r,1200));
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
});
const p=await context.newPage();
const errors=[];
p.on('pageerror',e=>errors.push(e.message));
const state=id=>p.evaluate(id=>{
  const frame=document.querySelector(`#fontList [data-font-id="${id}"]`);
  const specimen=frame?.querySelector('.font-specimen');
  const note=frame?.querySelector('.font-specimen-note');
  return {specimenHidden:specimen?.hidden,specimenState:specimen?.dataset.state,opacity:specimen?getComputedStyle(specimen).opacity:'',noteHidden:note?.hidden,noteText:note?.textContent,family:specimen?getComputedStyle(specimen).fontFamily:''};
},id);
try{
  await p.goto(origin+'/reeden-library/#fonts',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelectorAll('#fontList .theme-card').length===2,{},{timeout:20000});
  // 1) 下载期间：两张卡都必须是五行样张，且提示「字形加载中」。
  const loading=await state('font-slow');
  assert.equal(loading.specimenHidden,false,'字体下载期间样张必须可见（不能退回单行 JPG）');
  assert.equal(loading.specimenState,'loading','下载期间样张应处于 loading 状态');
  assert.ok(Number(loading.opacity)<1,'loading 状态要淡化，提示字形还没到');
  assert.equal(loading.noteHidden,false,'下载期间要有「字形加载中」提示');
  assert.ok(loading.noteText.includes('加载中'),`提示文案应为加载中：${loading.noteText}`);
  const rows=await p.locator('#fontList .font-specimen .specimen-tc').count();
  assert.equal(rows,2,'每张卡都要有繁体样张行');

  // 2) 字体到了：慢字体切成真实字形，提示消失。
  await p.waitForFunction(()=>document.querySelector('#fontList [data-font-id="font-slow"] .font-specimen')?.dataset.state==='live',{},{timeout:30000});
  const live=await state('font-slow');
  assert.ok(live.family.includes('font-font-slow'),`加载成功后必须套用真实字体：${live.family}`);
  assert.equal(live.noteHidden,true,'加载成功后不再显示提示');

  // 3) 对象不存在：保持五行样张 + 可点重试，不能出现单行「Aa 中文 你好 123」。
  await p.waitForFunction(()=>document.querySelector('#fontList [data-font-id="font-missing"] .font-specimen')?.dataset.state==='fallback',{},{timeout:40000});
  const failed=await state('font-missing');
  assert.equal(failed.specimenHidden,false,'加载失败也必须保持五行样张');
  assert.ok(failed.noteText.includes('重试'),`失败提示应可重试：${failed.noteText}`);
  const fallbackVisible=await p.locator('#fontList [data-font-id="font-missing"] .font-preview-fallback').isVisible();
  assert.equal(fallbackVisible,false,'失败时不能再露出单行旧样张');

  // 4) 补上对象后点重试：恢复真实字形。
  await bucket.put(`fonts/missing~${missingSha}.ttf`,fontBytes);
  await p.locator('#fontList [data-font-id="font-missing"] .font-specimen-note').click();
  await p.waitForFunction(()=>document.querySelector('#fontList [data-font-id="font-missing"] .font-specimen')?.dataset.state==='live',{},{timeout:40000});
  const retried=await state('font-missing');
  assert.ok(retried.family.includes('font-font-missing'),`重试成功后必须套用真实字体：${retried.family}`);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({loading,live,failed,retried},null,2));
  console.log('PASS: 字体下载期间/失败态都保持简繁五行样张，失败可点重试并恢复真实字形。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
