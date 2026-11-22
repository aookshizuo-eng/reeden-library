// RED\x02 是 Reeden 新版「封面图集」容器：4 字节头 + 普通 ZIP，条目是
// 1.jpg / 2.jpg / meta.json。旧解析只认 RED\x04、RED\x01、RED\x10，遇到这类
// 图集会直接报「无法识别 RED 文件头」，整包进恢复列表。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {handle} from '../pages/worker-api.js';
import {MemoryR2} from './test-memory-r2.mjs';
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url),{chromium}=require('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const bucket=new MemoryR2();
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=buffer=>{let c=0xffffffff;for(const byte of buffer)c=crcTable[(c^byte)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const png=(width,height,[r,g,b])=>{
  const chunk=(type,data)=>{const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'ascii'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([length,body,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++){row[1+x*3]=r;row[2+x*3]=g;row[3+x*3]=b;}
  const raw=Buffer.concat(Array.from({length:height},()=>row));
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
};
const u16=value=>{const buffer=Buffer.alloc(2);buffer.writeUInt16LE(value);return buffer;};
const u32=value=>{const buffer=Buffer.alloc(4);buffer.writeUInt32LE(value>>>0);return buffer;};
// 只用 store（method=0）写 ZIP，够复现图集容器的真实结构。
const storeZip=files=>{
  const locals=[],centrals=[];let offset=0;
  for(const {name,bytes} of files){
    const nameBytes=Buffer.from(name,'utf8'),crc=crc32(bytes);
    const local=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),u16(20),u16(0x0800),u16(0),u16(0),u16(0),u32(crc),u32(bytes.length),u32(bytes.length),u16(nameBytes.length),u16(0),nameBytes,bytes]);
    locals.push(local);offset+=local.length;
    centrals.push(Buffer.concat([Buffer.from([0x50,0x4b,0x01,0x02]),u16(20),u16(20),u16(0x0800),u16(0),u16(0),u16(0),u32(crc),u32(bytes.length),u32(bytes.length),u16(nameBytes.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset-local.length),nameBytes]));
  }
  const localBytes=Buffer.concat(locals),centralBytes=Buffer.concat(centrals);
  return Buffer.concat([localBytes,centralBytes,Buffer.from([0x50,0x4b,0x05,0x06]),u16(0),u16(0),u16(files.length),u16(files.length),u32(centralBytes.length),u32(localBytes.length),u16(0)]);
};
const galleryBuffer=(name,covers)=>Buffer.concat([
  Buffer.from([82,69,68,2]),
  storeZip([...covers.map((bytes,index)=>({name:`${index+1}.jpg`,bytes})),{name:'meta.json',bytes:Buffer.from(JSON.stringify({name,transparentOptimization:true}))}])
]);
const firstGallery=galleryBuffer('封面图集-测试集',[png(300,420,[176,96,64]),png(300,420,[70,96,120]),png(300,420,[92,110,80])]);
const secondGallery=galleryBuffer('封面图集-小编号',[png(240,320,[120,120,60]),png(240,320,[60,120,140])]);
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
  await p.locator('#unifiedInput').setInputFiles([
    {name:'封面图集-测试集.red',mimeType:'application/octet-stream',buffer:firstGallery},
    {name:'封面图集-小编号.red',mimeType:'application/octet-stream',buffer:secondGallery}
  ]);
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===2,{},{timeout:60000});
  // 旧版会在这里显示「2 个文件无法读取」：断言恢复列表为空。
  const failed=await p.locator('#reviewList .review-card').evaluateAll(cards=>cards.filter(card=>/无法识别|读取失败|格式尚未支持/.test(card.textContent||'')).length);
  assert.equal(failed,0,'RED\\x02 图集不应再进无法读取清单');
  await p.locator('#commitSelectedThemes').click();
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===0&&document.querySelectorAll('#pendingList .pending-card').length===0,{},{timeout:120000});
  const read=async kind=>p.evaluate(async kind=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const response=await fetch('/api/'+kind+'s',{headers:token?{Authorization:'Bearer '+token}:{}});
    const data=await response.json().catch(()=>({}));
    return data.records||data.items||[];
  },kind);
  const assets=await read('asset'),themes=await read('theme');
  assert.equal(themes.length,0,'封面图集不能进主题库');
  assert.equal(assets.length,2,`两个图集都要进收藏库，实际 ${assets.length}`);
  for(const record of assets){
    assert.equal(record.asset_type,'red');
    assert.equal(record.red_category,'图集',`图集分类应识别为图集：${record.red_category}`);
    assert.equal(record.preview_kind,'gallery','图集预览必须走封面网格');
    assert.ok(record.preview_url,'图集要生成预览图');
    assert.equal(record.container_format,'red_v2_gallery','要标记 RED\\x02 容器，避免压缩改名');
    assert.equal(record.compression_supported,false,'图集必须原包保留');
  }
  // 原包字节要按原样存：序号文件名是图集的寻址方式。
  const sources={[await sha(firstGallery)]:firstGallery,[await sha(secondGallery)]:secondGallery};
  for(const record of assets){
    const source=sources[record.sha256];
    assert.ok(source,'收藏记录应指向原包字节');
    assert.equal(record.bytes,source.length,'字节数必须与原包一致');
  }
  await p.evaluate(()=>{location.hash='#assets';});
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===2,{},{timeout:20000});
  await p.locator('#assetCategoryFilter').selectOption('gallery');
  await p.waitForTimeout(250);
  assert.equal(await p.locator('#assetList .asset-card').count(),2,'图集筛选应命中两条');
  await p.waitForFunction(()=>[...document.querySelectorAll('#assetList .asset-card img')].every(img=>img.complete&&img.naturalWidth>0),{},{timeout:20000});
  const chips=await p.locator('#assetList .theme-categories em.is-key').allInnerTexts();
  assert.ok(chips.includes('图集'),`收藏卡要有图集标签：${chips.join(',')}`);
  assert.deepEqual(errors,[]);
  console.log('PASS: RED\\x02 封面图集可以读取、进收藏库、按封面网格预览，并且原包保留。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
