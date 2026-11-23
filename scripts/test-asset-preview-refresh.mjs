// 收藏库的两件事：
//   1. HTML 预览按 1024px 桌面视口排版，再把主内容块放大到刚好填满卡片——
//      以前直接塞进 140px 宽的 iframe，页面被挤成窄屏、出现滚动条，内容看不全。
//   2. 「刷新预览」按原包重画 RED 收藏的预览图：入库时预览失败或想换一套时，
//      不必删掉重传。
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
// 封面图集（RED\x02）：预览要靠原包里的图重新合成，正好用来验证「刷新预览」。
const galleryBytes=Buffer.concat([
  Buffer.from([82,69,68,2]),
  storeZip([1,2,3].map((index)=>({name:`${index}.jpg`,bytes:png(300,420,[80+index*40,96,120])})).concat([{name:'meta.json',bytes:Buffer.from(JSON.stringify({name:'封面图集-刷新测试'}))}]))
]);
// 固定 480×640 海报 + 灰色页面：模板最常见的样子，正好检验「整页缩进卡片」。
const htmlSource=`<!doctype html><meta charset="utf-8"><title>预览模板</title>
<style>
  html,body{margin:0;height:100%;background:#e9e9e9;overflow:hidden;font-family:system-ui,sans-serif}
  .poster{position:absolute;left:0;top:0;width:480px;height:640px;box-sizing:border-box;padding:32px;background:#fafafa;color:#141416}
  .poster h1{margin:0 0 12px;font-size:34px}
  .poster p{margin:0;color:#6b6b72;font-size:20px}
</style>
<div class="poster"><h1>Reeden 主题预览</h1><p>HTML 预览填满测试</p></div>`;
const htmlBytes=Buffer.from(htmlSource,'utf8');
const gallerySha='1'.repeat(64);
const htmlSha='2'.repeat(64);
const galleryRecord={kind:'asset',id:'asset-'+gallerySha.slice(0,16),asset_type:'red',extension:'red',category:'图集',red_category:'图集',
  preview_kind:'gallery',file_name:'封面图集-刷新测试.red',name:'封面图集-刷新测试',author:'',style:'',tags:[],
  sha256:gallerySha,original_sha256:gallerySha,bytes:galleryBytes.length,mime:'application/octet-stream',container_format:'red_v2_gallery',compression_supported:false,
  object_url:'/api/objects/assets/gallery.red',url:'/api/objects/assets/gallery.red',preview_url:'',
  created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z',saved_to_cloud:true};
const htmlRecord={kind:'asset',id:'asset-'+htmlSha.slice(0,16),asset_type:'html',extension:'html',
  file_name:'春随-简约预览模板.html',name:'春随-简约预览模板',author:'',style:'',tags:[],
  sha256:htmlSha,original_sha256:htmlSha,bytes:htmlBytes.length,mime:'text/html',
  object_url:'/api/objects/assets/frame.html',url:'/api/objects/assets/frame.html',preview_url:'/api/objects/assets/frame.html',
  created_at:'2026-01-01T00:00:00.000Z',updated_at:'2026-01-01T00:00:00.000Z',saved_to_cloud:true};
{
  await bucket.put('assets/gallery.red',galleryBytes);
  // 预览要能在 iframe 里渲染，对象必须是 text/html；否则浏览器会当成附件下载。
  await bucket.put('assets/frame.html',htmlBytes,{httpMetadata:{contentType:'text/html; charset=utf-8'}});
  const records=[];
  for(const record of [galleryRecord,htmlRecord]){
    const recordSha=await sha(new TextEncoder().encode(JSON.stringify(record)));
    await bucket.put('records/'+recordSha+'.json',new TextEncoder().encode(JSON.stringify(record)));
    records.push({...record,record_sha256:recordSha});
  }
  await bucket.put('system/library-v1.json',JSON.stringify({version:1,revision:'preview-refresh',records,garbage:[],updated_at:'2026-01-01T00:00:00.000Z'}));
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
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.addInitScript(()=>{
  // 这段会注入页面里的每个 iframe；收藏库的 HTML 预览是 sandbox，读写
  // localStorage 会抛 SecurityError，不能让它污染错误断言。
  try{
    localStorage.setItem('reeden-api-base',location.origin);
    localStorage.setItem('reeden-sync-write-token','test-token');
    localStorage.setItem('reeden-auto-resume-queue','off');
    localStorage.setItem('reeden-backup-123-enabled','off');
  }catch{}
});
const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
const waitFor=async(predicate,timeout=20000)=>{for(const end=Date.now()+timeout;Date.now()<end;){if(await predicate())return true;await p.waitForTimeout(200);}return false;};
try{
  await p.goto(origin+'/reeden-library/#assets',{waitUntil:'domcontentloaded'});
  assert.ok(await waitFor(()=>p.evaluate(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'))),'共享库没有连上');
  const cardsReady=await waitFor(()=>p.evaluate(()=>document.querySelectorAll('#assetList .asset-card').length===2),40000);
  assert.ok(cardsReady,'两条收藏没有渲染出来');
  assert.ok(errors.length===0,`页面报错：${errors[0]}`);

  // 1) HTML 卡片：整页按 1024px 桌面视口排版，再整体缩到卡片框里。
  // 页面对象带 CSP sandbox，读不到内部版面，只能验证外层框的缩放；
  // 关键是不能再把页面塞进 140px 宽的 iframe（会挤成窄屏、出滚动条）。
  assert.ok(await waitFor(()=>p.evaluate(()=>document.querySelectorAll('#assetList .asset-html-frame.is-fitted').length===1)),'HTML 预览没有适配卡片尺寸');
  const htmlCard=await p.evaluate(()=>{
    const frame=document.querySelector('#assetList .asset-html-frame');
    const iframe=frame.querySelector('.asset-html-preview');
    const rect=iframe.getBoundingClientRect();
    const box=frame.getBoundingClientRect();
    const scale=Number((iframe.style.transform.match(/scale\(([\d.]+)\)/)||[])[1]||0);
    return {
      viewport:iframe.style.width,
      scale,
      expected:+(box.width/1024).toFixed(3),
      coversFrame:Math.abs(rect.width-box.width)<1.5&&Math.abs(rect.height-box.height)<1.5,
      clipped:getComputedStyle(frame).overflow,
      styledHeight:iframe.style.height,
    };
  });
  assert.equal(htmlCard.viewport,'1024px','HTML 预览应按桌面视口排版');
  assert.ok(htmlCard.scale>0.05,'HTML 预览要有缩放比');
  assert.ok(Math.abs(htmlCard.scale-htmlCard.expected)<0.02,`缩放比应按卡片宽度算：${htmlCard.scale} vs ${htmlCard.expected}`);
  assert.ok(htmlCard.coversFrame,'缩放后的 iframe 应正好盖住卡片预览框');
  assert.equal(htmlCard.clipped,'hidden','预览框要裁掉多余部分，不能撑出滚动条');

  // 2) 刷新预览是「单个文件」的操作：点图集卡上的按钮只重画图集，
  //    不能整页重拉，也不能顺手重载旁边 HTML 卡的预览。
  const galleryId='asset-'+gallerySha.slice(0,16),htmlId='asset-'+htmlSha.slice(0,16);
  const htmlSrcBefore=await p.locator(`#assetList .asset-card[data-asset-id="${htmlId}"] .asset-html-preview`).getAttribute('src');
  assert.ok(await p.locator(`#assetList .asset-card[data-asset-id="${galleryId}"] [data-refresh-asset]`).isVisible(),'图集卡片缺少单卡刷新预览按钮');
  await p.locator(`#assetList .asset-card[data-asset-id="${galleryId}"] [data-refresh-asset]`).click();
  assert.ok(await waitFor(()=>p.evaluate(()=>/预览已刷新/.test(document.querySelector('#toast')?.textContent||''))),'刷新预览没有回报结果');
  const previewed=await waitFor(async()=>{
    const sources=await p.locator(`#assetList .asset-card[data-asset-id="${galleryId}"] .asset-preview-button img`).evaluateAll(nodes=>nodes.map(node=>node.getAttribute('src')||''));
    return sources.some(source=>source.includes('/previews/'));
  });
  assert.ok(previewed,'图集卡片没有换上新的预览图');
  const htmlSrcAfter=await p.locator(`#assetList .asset-card[data-asset-id="${htmlId}"] .asset-html-preview`).getAttribute('src');
  assert.equal(htmlSrcAfter,htmlSrcBefore,'刷新一个收藏不应重载其它收藏的预览');
  // 单卡按钮同样能即时重载 HTML 预览（缓存穿透）。
  await p.locator(`#assetList .asset-card[data-asset-id="${htmlId}"] [data-refresh-asset]`).click();
  assert.ok(await waitFor(async()=>{
    const src=await p.locator(`#assetList .asset-card[data-asset-id="${htmlId}"] .asset-html-preview`).getAttribute('src');
    return !!src&&new URL(src,origin).searchParams.has('v');
  }),'单卡刷新没有重新载入 HTML 预览');

  const records=await p.evaluate(async()=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const response=await fetch('/api/assets',{headers:token?{Authorization:'Bearer '+token}:{}});
    const data=await response.json().catch(()=>({}));
    return data.records||data.items||[];
  });
  const refreshed=records.filter(record=>String(record.id).startsWith('asset-'+gallerySha.slice(0,16)))
    .sort((left,right)=>String(right.updated_at||'').localeCompare(String(left.updated_at||'')))[0];
  assert.ok(refreshed?.preview_url?.includes('/previews/'),'刷新后要写回一条带预览图的新版本记录');
  assert.equal(refreshed.red_category,'图集','刷新预览不能改动分类标签');
  assert.equal(refreshed.name,'封面图集-刷新测试','刷新预览不能改动名称');
  console.log('收藏库刷新预览与 HTML 填充测试通过');
}finally{
  await browser.close();server.close();
}
