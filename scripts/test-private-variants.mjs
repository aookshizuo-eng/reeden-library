// 图集 / 高亮 RED 回归：
//   浏览器能读出明文图片并合成预览。这类文件不是阅读主题，必须收录进收藏库，
//   并各自带「图集」「高亮」分类；主题库里不能再出现它们。
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
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
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB7sAAAAASUVORK5CYII=','base64');
const encoder=new TextEncoder();
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
// 图集：私有 v2，公开头 resourceType=coverGallery，图片区仍是顺序明文。
const gallery=await (async()=>{
  const theme=encoder.encode(JSON.stringify({name:'封面图集-从前慢1',author:'测试作者'}));
  const manifest=encoder.encode(JSON.stringify({version:2,payloadKind:'coverGallery',entries:[{path:'cover.jpg',offset:0,length:png.length,sha256:await sha(png)}]}));
  const header=encoder.encode(JSON.stringify({version:2,resourceType:'coverGallery',payloadType:'directory',containerMode:'reedenPrivate',algorithm:'aes-256-gcm-manifest',assetMode:'plain-sequential',manifestLength:manifest.length,manifestNonce:'AAAAAAAAAAAAAAAAAAAAAA=='}));
  const raw=new Uint8Array(8+header.length+manifest.length+theme.length+png.length);
  raw.set([0x52,0x45,0x44,0x10],0);new DataView(raw.buffer).setUint32(4,header.length,false);
  raw.set(header,8);raw.set(manifest,8+header.length);raw.set(theme,8+header.length+manifest.length);raw.set(png,8+header.length+manifest.length+theme.length);
  return {name:'封面图集-从前慢1.red',mimeType:'application/octet-stream',buffer:Buffer.from(raw)};
})();
// 高亮：RED v1 gzip，没有公开头，只能按文件名识别成「高亮」；图片在 images 映射里。
const highlight={name:'高亮规则 - 花荫·对话.red',mimeType:'application/octet-stream',buffer:Buffer.concat([Buffer.from([82,69,68,1]),gzipSync(JSON.stringify({version:1,type:'highlightRule',data:[{name:'花荫',keyword:'“[^”]+”',styleType:'background',styleColorType:'brown',styleMode:'advanced',images:{FF5E27D02A6D8E82EF9CF612E115BE2B:gzipSync(png).toString('base64')}}]}))])};
const fixtureHeaderBytes=new DataView(gallery.buffer.buffer,gallery.buffer.byteOffset,gallery.buffer.byteLength).getUint32(4,false);
assert.equal(new TextDecoder().decode(gallery.buffer.subarray(8,8+fixtureHeaderBytes)).includes('coverGallery'),true);
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
});
const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
try{
  await p.goto(origin+'/reeden-library/#import',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'),{},{timeout:20000});
  await p.locator('#unifiedInput').setInputFiles([gallery,highlight]);
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===2&&!document.querySelector('#pauseTransfer').offsetParent,{},{timeout:30000});
  const notes=await p.locator('#reviewList .review-card').allInnerTexts();
  assert.ok(notes.some(text=>/图集包：收录进收藏库「图集」分类/.test(text)),`图集包应提示进收藏库：${notes.join('|')}`);
  assert.ok(notes.some(text=>/高亮包：收录进收藏库「高亮」分类/.test(text)),`高亮包应提示进收藏库：${notes.join('|')}`);
  assert.match(await p.locator('#reviewList .commit-theme').first().textContent(),/^确认并收录到收藏库/);
  // 待确认区默认全选，整批确认即可；逐张点会撞上按钮重绘。
  await p.locator('#commitSelectedThemes').click();
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===0&&/收藏库/.test(document.querySelector('#reviewBatchStatus')?.textContent||''),{},{timeout:60000});
  const read=async kind=>p.evaluate(async kind=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const response=await fetch('/api/'+kind+'s',{headers:token?{Authorization:'Bearer '+token}:{}});
    const data=await response.json().catch(()=>({}));
    return data.records||data.items||[];
  },kind);
  const assets=await read('asset');
  const galleryRecord=assets.find(item=>String(item.file_name||'').includes('封面图集'));
  const highlightRecord=assets.find(item=>String(item.file_name||'').includes('高亮'));
  assert.ok(galleryRecord,'图集必须收录进收藏库');
  assert.ok(highlightRecord,'高亮必须收录进收藏库');
  assert.equal(galleryRecord.asset_type,'red');
  assert.equal(galleryRecord.red_category,'图集');
  assert.equal(highlightRecord.red_category,'高亮');
  assert.ok(galleryRecord.preview_url&&highlightRecord.preview_url,'收藏记录必须保存浏览器生成的预览');
  assert.match(galleryRecord.object_url,/\.red$/,'图集原包地址必须是 .red');
  assert.match(highlightRecord.object_url,/\.red$/,'高亮原包地址必须是 .red');
  assert.equal(galleryRecord.saved_to_cloud,true);
  assert.equal((await read('theme')).length,0,'图集/高亮不能混进主题库');
  // 收藏库里能看到两张卡、分类标签和预览，并且筛选「图集 / 高亮」各剩一张。
  await p.evaluate(()=>{location.hash='#assets';});
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===2,{},{timeout:20000});
  const chips=await p.locator('#assetList .theme-categories em.is-key, #assetList .category-chip.is-key').allInnerTexts();
  assert.ok(chips.includes('图集')&&chips.includes('高亮'),`收藏卡必须显示图集/高亮分类：${chips.join(',')}`);
  // 缩略图是 loading="lazy"，卡片刚渲染时 naturalWidth 可能还是 0，等解码完再断言。
  await p.waitForFunction(()=>[...document.querySelectorAll('#assetList .theme-thumbnail img')].every(image=>image.complete&&image.naturalWidth>0),{},{timeout:15000});
  const previews=await p.locator('#assetList .theme-thumbnail img').evaluateAll(images=>images.map(image=>({src:image.currentSrc||image.src,w:image.naturalWidth})));
  assert.equal(previews.length,2,'两张收藏卡都要有图片预览');
  assert.ok(previews.every(item=>item.w>0&&item.src.includes('/previews/')),`预览必须是已上传的 JPG：${JSON.stringify(previews)}`);
  await p.locator('#assetFilterTabs [data-asset-filter="gallery"]').click();
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===1,{},{timeout:10000});
  await p.locator('#assetFilterTabs [data-asset-filter="highlight"]').click();
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===1,{},{timeout:10000});
  await p.locator('#assetFilterTabs [data-asset-filter="all"]').click();
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===2,{},{timeout:10000});
  assert.deepEqual(errors,[]);
  console.log('PASS: 图集/高亮 RED 可预览、收录进收藏库并带分类筛选，主题库保持干净。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
