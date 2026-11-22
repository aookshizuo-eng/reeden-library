// 收藏库分类 + 主题部件预览回归：
//   1) 收藏库先按大类型分：SVG / HTML / 主题部件（RED 包），部件里再分封面图集、高亮包；
//   2) 封面图集预览只排封面本身，不套「书架 + 手机屏」那套主题拼贴；
//   3) 阅读主题预览 = 阅读背景 + 高亮图片；
//   4) 单独的高亮包只排高亮图片，不掺背景、不画手机屏。
import assert from 'node:assert/strict';
import {gzipSync, deflateSync} from 'node:zlib';
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
const encoder=new TextEncoder();
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
// 测试要真实尺寸、真实颜色的 PNG：预览是按图片本身比例排版的，1x1 占位图看不出问题。
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=buffer=>{let c=0xffffffff;for(const byte of buffer)c=crcTable[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const png=(width,height,[r,g,b])=>{
  const chunk=(type,data)=>{const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'ascii'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++){row[1+x*3]=r;row[2+x*3]=g;row[3+x*3]=b;}
  const raw=Buffer.concat(Array.from({length:height},()=>row));
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
};
const covers=[png(300,420,[176,96,64]),png(300,420,[70,96,120]),png(300,420,[92,110,80])];
// 图集：私有 v2，公开头 resourceType=coverGallery，图片区顺序明文。
const gallery=await (async()=>{
  const theme=encoder.encode(JSON.stringify({name:'封面图集-测试集',author:'测试作者'}));
  const manifest=encoder.encode(JSON.stringify({version:2,payloadKind:'coverGallery',entries:covers.map((bytes,index)=>({path:`cover-${index}.png`,length:bytes.length,sha256:''}))}));
  const header=encoder.encode(JSON.stringify({version:2,resourceType:'coverGallery',payloadType:'directory',containerMode:'reedenPrivate',algorithm:'aes-256-gcm-manifest',assetMode:'plain-sequential',manifestLength:manifest.length,manifestNonce:'AAAAAAAAAAAAAAAAAAAAAA=='}));
  const total=covers.reduce((sum,bytes)=>sum+bytes.length,0);
  const raw=new Uint8Array(8+header.length+manifest.length+theme.length+total);
  raw.set([0x52,0x45,0x44,0x10],0);new DataView(raw.buffer).setUint32(4,header.length,false);
  let cursor=8;
  raw.set(header,cursor);cursor+=header.length;
  raw.set(manifest,cursor);cursor+=manifest.length;
  raw.set(theme,cursor);cursor+=theme.length;
  for(const bytes of covers){raw.set(bytes,cursor);cursor+=bytes.length;}
  return {name:'封面图集-测试集.red',mimeType:'application/octet-stream',buffer:Buffer.from(raw)};
})();
// 阅读主题：RED v1 gzip，一张阅读背景 + 两张高亮图（images 映射）。
const reader={name:'阅读主题-测试.red',mimeType:'application/octet-stream',buffer:Buffer.concat([Buffer.from([82,69,68,1]),gzipSync(JSON.stringify({version:1,type:'readerColorSchema',data:[{themeMode:'light',name:'阅读主题-测试',backgroundImageData:gzipSync(png(480,900,[236,230,218])).toString('base64'),images:{A1:gzipSync(png(420,110,[186,120,72])).toString('base64'),A2:gzipSync(png(420,110,[92,132,168])).toString('base64')}}]}))])};
// 单独的高亮包：只有高亮图片，没有阅读背景。
const highlight={name:'高亮规则-测试.red',mimeType:'application/octet-stream',buffer:Buffer.concat([Buffer.from([82,69,68,1]),gzipSync(JSON.stringify({version:1,type:'highlightRule',data:[{name:'高亮规则-测试',images:{B1:gzipSync(png(520,130,[168,92,62])).toString('base64'),B2:gzipSync(png(520,130,[64,104,150])).toString('base64')}}]}))])};
const svgAsset={name:'图标-测试.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#8a4a30"/></svg>')};
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
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{
  localStorage.setItem('reeden-api-base',location.origin);
  localStorage.setItem('reeden-sync-write-token','test-token');
  localStorage.setItem('reeden-auto-resume-queue','off');
  localStorage.setItem('reeden-backup-123-enabled','off');
});
const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
try{
  await p.goto(origin+'/reeden-library/#import',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'),{},{timeout:20000});
  await p.locator('#unifiedInput').setInputFiles([gallery,reader,highlight,svgAsset]);
  // RED 包统一先在确认区解析（图集 / 高亮 / 阅读主题），SVG 直接进待处理。
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===3&&document.querySelectorAll('#pendingList .pending-card').length===1,{},{timeout:60000});
  await p.locator('#commitSelectedThemes').click();
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===0&&document.querySelectorAll('#pendingList .pending-card').length===0,{},{timeout:120000});
  const read=async kind=>p.evaluate(async kind=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const response=await fetch('/api/'+kind+'s',{headers:token?{Authorization:'Bearer '+token}:{}});
    const data=await response.json().catch(()=>({}));
    return data.records||data.items||[];
  },kind);
  const assets=await read('asset'),themes=await read('theme');
  assert.equal(assets.length,4,`收藏应有图集 + 高亮 + 阅读主题 + SVG 共 4 条，实际 ${assets.length}`);
  assert.equal(themes.length,0,'阅读主题不能再留在主题库');
  const galleryRecord=assets.find(item=>item.red_category==='图集');
  const highlightRecord=assets.find(item=>item.red_category==='高亮');
  const readerRecord=assets.find(item=>item.red_category==='阅读主题');
  const svgRecord=assets.find(item=>item.asset_type==='svg');
  assert.ok(galleryRecord&&highlightRecord&&readerRecord&&svgRecord,'四类收藏都要入库');
  assert.equal(galleryRecord.preview_kind,'gallery','图集预览必须走封面网格，不能沿用主题拼贴');
  assert.equal(highlightRecord.preview_kind,'highlight','高亮预览必须只排高亮图片');
  assert.ok(galleryRecord.preview_url&&highlightRecord.preview_url,'图集/高亮都要有预览图');
  assert.equal(readerRecord.container_format,'red_v1_gzip');
  assert.equal(readerRecord.preview_kind,'reader','阅读主题预览必须走阅读背景 + 高亮这套');
  assert.ok(readerRecord.preview_url,'阅读主题要生成预览');
  assert.equal(readerRecord.extension,'red');

  await p.evaluate(()=>{location.hash='#assets';});
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===4,{},{timeout:20000});
  const optionHandle=await p.locator('#assetCategoryFilter').evaluate(select=>[...select.options].map(option=>({value:option.value,label:option.textContent})));
  for(const value of ['svg','html','red','gallery','highlight','reader']){
    assert.ok(optionHandle.some(option=>option.value===value),`收藏筛选缺少类型选项：${value}`);
  }
  const counts=async value=>{
    await p.locator('#assetCategoryFilter').selectOption(value);
    await p.waitForTimeout(250);
    return p.locator('#assetList .asset-card').count();
  };
  assert.equal(await counts('red'),3,'主题部件筛选应剩图集 + 高亮 + 阅读主题');
  assert.equal(await counts('gallery'),1,'封面图集筛选应只剩图集');
  assert.equal(await counts('highlight'),1,'高亮筛选应只剩高亮包');
  assert.equal(await counts('reader'),1,'阅读主题筛选应只剩阅读主题');
  assert.equal(await counts('svg'),1,'SVG 筛选应只剩 SVG 收藏');
  assert.equal(await counts('html'),0,'这次没有 HTML 收藏');
  assert.equal(await counts('all'),4);
  const chips=await p.locator('#assetList .theme-categories em.is-key').allInnerTexts();
  for(const name of ['图集','高亮','阅读主题','SVG']) assert.ok(chips.includes(name),`收藏卡缺少类型标签 ${name}：${chips.join(',')}`);
  await p.waitForFunction(()=>[...document.querySelectorAll('#assetList .asset-card img')].every(img=>img.complete&&img.naturalWidth>0),{},{timeout:20000});
  await p.evaluate(()=>{location.hash='#themes';});
  await p.waitForTimeout(600);
  assert.equal(await p.locator('#themeList .theme-card').count(),0,'主题库不应再有阅读主题卡');
  assert.deepEqual(errors,[]);
  console.log('PASS: 收藏库按 SVG / HTML / 主题部件分类，图集只排封面、阅读主题进收藏库并读阅读背景 + 高亮、单独高亮只排高亮图。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
