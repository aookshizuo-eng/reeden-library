// 存成 .txt 的 SVG 回归：
//   很多素材是从网页另存为 .txt 的，扩展名不可信。内容里出现 <svg 就必须按
//   SVG 收藏收录：对象存 .svg、给 image/svg+xml、生成 JPG 预览；
//   真正的纯文本 .txt 要被忽略，不能塞进收藏库。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {handle} from '../pages/worker-api.js';
import {MemoryR2} from './test-memory-r2.mjs';
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url),{chromium}=require('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const bucket=new MemoryR2();
// BOM + 空行 + XML 声明：真实 .txt 素材常见的开头，必须能被识别并裁掉。
const svgSource='\uFEFF\n\n<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect width="160" height="80" fill="#8a4a30"/><circle cx="40" cy="40" r="24" fill="#f2eee5"/><path d="M70 56 L100 24 L130 56 Z" fill="#fffdf8"/></svg>\n';
const svgTxt={name:'封面排版-样张.txt',mimeType:'text/plain',buffer:Buffer.from(svgSource,'utf8')};
const plainTxt={name:'随手记.txt',mimeType:'text/plain',buffer:Buffer.from('这是一份纯文本笔记，里面没有图形。\n第二行。\n','utf8')};
let origin;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      const chunks=[];for await(const c of req)chunks.push(c);
      const response=await handle(new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}),{ASSETS:bucket,SYNC_WRITE_TOKEN:'test-token',ALLOWED_ORIGINS:origin,REEDEN_PRIVATE_FORMAT_KEY_B64:Buffer.from(Array.from({length:32},(_,i)=>i+1)).toString('base64')});
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
  localStorage.setItem('reeden-backup-123-enabled','off');
  localStorage.setItem('reeden-pending-queue','off');
});
const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
try{
  await p.goto(origin+'/reeden-library/#import',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'),{},{timeout:20000});
  // 一个 .txt 里是 SVG，一个 .txt 是纯文本：只能进 1 个收藏。
  await p.locator('#unifiedInput').setInputFiles([svgTxt,plainTxt]);
  await p.waitForFunction(()=>document.querySelectorAll('#pendingList .pending-card').length===1,{},{timeout:40000});
  assert.equal(await p.locator('#pendingList .pending-card').count(),1,'纯文本 .txt 不能进待处理区');
  await p.locator('#commitSelectedThemes').click();
  await p.waitForFunction(()=>document.querySelectorAll('#pendingList .pending-card').length===0,{},{timeout:60000});
  const read=async kind=>p.evaluate(async kind=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const response=await fetch('/api/'+kind+'s',{headers:token?{Authorization:'Bearer '+token}:{}});
    const data=await response.json().catch(()=>({}));
    return data.records||data.items||[];
  },kind);
  const assets=await read('asset');
  assert.equal(assets.length,1,`只应收入 1 个 SVG 收藏，实际 ${assets.length}`);
  const record=assets[0];
  assert.equal(record.asset_type,'svg','来自 .txt 的 SVG 必须识别成 svg');
  assert.equal(record.extension,'svg');
  assert.equal(record.name,'封面排版-样张');
  assert.match(record.file_name,/\.svg$/,'收录后要存成 .svg，下载才能直接当图片用');
  assert.equal(record.source_file_name,'封面排版-样张.txt','要记住原文件名，方便回溯');
  assert.match(record.object_url,/\/assets\/.*\.svg$/);
  // Chromium 的 createImageBitmap 不解 SVG，SVG 缩略图一直直接用对象地址渲染（见卡片断言）。
  assert.equal(record.saved_to_cloud,true);
  assert.equal((await read('theme')).length,0,'收藏不能混进主题库');
  // 对象头必须是 image/svg+xml，浏览器 <img> 才会按矢量渲染；内容已裁掉 BOM 与空行。
  const served=await p.evaluate(async url=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const response=await fetch(url,{headers:token?{Authorization:'Bearer '+token}:{}});
    const text=await response.text();
    return {type:response.headers.get('content-type'),head:text.slice(0,40)};
  },record.object_url);
  assert.match(served.type||'',/image\/svg\+xml/,'对象类型必须是 image/svg+xml');
  assert.ok(served.head.startsWith('<?xml')||served.head.startsWith('<svg'),`对象内容必须是纯 SVG：${served.head}`);
  // 收藏库卡片：SVG 徽标 + 真实图片预览。
  await p.evaluate(()=>{location.hash='#assets';});
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===1,{},{timeout:20000});
  const caption=await p.locator('#assetList .asset-card .preview-caption').first().textContent();
  assert.match(caption,/SVG/,'收藏卡必须标成 SVG，不能被当成 HTML');
  // 卡片缩略图是懒加载的，等它真正解码完再看尺寸。
  await p.waitForFunction(()=>{const img=document.querySelector('#assetList .asset-card img');return img&&img.complete&&img.naturalWidth>0;},{},{timeout:15000}).catch(()=>{});
  const image=await p.locator('#assetList .asset-card img').first().evaluate(img=>({w:img.naturalWidth,h:img.naturalHeight,src:img.currentSrc||img.src}));
  assert.ok(image.w>0&&image.h>0,`SVG 预览图必须真的渲染出来：${JSON.stringify(image)}`);
  assert.deepEqual(errors,[]);
  console.log('PASS: 存成 .txt 的 SVG 能识别、转存 .svg、生成预览并收录进收藏库；纯文本 .txt 被忽略。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
