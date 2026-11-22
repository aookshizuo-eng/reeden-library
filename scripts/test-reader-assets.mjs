// 阅读主题（RED\x01 阅读配色）现在归收藏库「阅读主题」：新导入的走 redAsset
// 分支，旧库里已经当主题存过的记录在打开页面时自动迁移。纯配色、没有背景图
// 的阅读主题也要画出配色预览，不能只剩「暂无预览」。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {handle} from '../pages/worker-api.js';
import {MemoryR2} from './test-memory-r2.mjs';
const require=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url),{chromium}=require('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const bucket=new MemoryR2();
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
// 预置一条「旧版」主题库记录：以前阅读主题就是 theme。
const legacySha='a'.repeat(64);
const legacy={kind:'theme',id:'theme-legacy',name:'旧阅读主题',author:'旧作者',file_name:'旧阅读主题.red',bytes:2048,
  container_format:'red_v1_gzip',preview_details:{kind:'reader'},sha256:legacySha,original_sha256:legacySha,
  compressed_url:'/api/objects/originals/legacy.red',library_url:'/api/objects/originals/legacy.red',original_url:'/api/objects/originals/legacy.red',
  preview_light_url:'',created_at:'2026-01-01T00:00:00.000Z',tags:[]};
{
  // Worker 写记录时会校验引用的对象真实存在。
  await bucket.put('originals/legacy.red',new TextEncoder().encode('RED\x01legacy'));
  const bytes=new TextEncoder().encode(JSON.stringify(legacy));
  const recordSha=await sha(bytes);
  await bucket.put('records/'+recordSha+'.json',bytes);
  // 线上库一直有 system/library-v1.json 索引；只放 records 对象会让 Worker
  // 在删除后从 records 重建索引，把刚删掉的记录又读回来。
  await bucket.put('system/library-v1.json',JSON.stringify({version:1,revision:'legacy-revision',records:[{...legacy,record_sha256:recordSha}],garbage:[],updated_at:'2026-01-01T00:00:00.000Z'}));
}
// 纯配色阅读主题：只有背景色 / 正文色 / 主色，没有任何背景图。
const swatch=Buffer.concat([Buffer.from([82,69,68,1]),gzipSync(JSON.stringify({version:1,type:'readerColorSchema',data:[
  {name:'咖啡·爪磨咖啡',themeMode:'light',backgroundColor:'#FFF2EEE5',textColor:'#FF1D1A15',primaryColor:'#FF8A4A30'},
  {name:'咖啡·爪磨咖啡 夜间',themeMode:'dark',backgroundColor:'#FF23201C',textColor:'#FFEDE4D8',primaryColor:'#FFC08A5E'}
]}))]);
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
const read=async kind=>p.evaluate(async kind=>{
  const token=localStorage.getItem('reeden-sync-write-token');
  const response=await fetch('/api/'+kind+'s?t='+Date.now(),{cache:'no-store',headers:token?{Authorization:'Bearer '+token}:{}});
  const data=await response.json().catch(()=>({}));
  return data.records||data.items||[];
},kind);
try{
  await p.goto(origin+'/reeden-library/#import',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'),{},{timeout:20000});
  // 旧主题记录应被自动搬到收藏库，主题库清空。
  await p.waitForFunction(async()=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const headers=token?{Authorization:'Bearer '+token}:{};
    const stamp=Date.now();
    const [themes,assets]=await Promise.all([fetch('/api/themes?t='+stamp,{cache:'no-store',headers}).then(r=>r.json()),fetch('/api/assets?t='+stamp,{cache:'no-store',headers}).then(r=>r.json())]);
    return (themes.records||[]).length===0&&(assets.records||[]).length===1;
  },{},{timeout:30000});
  const [themesAfter,assetsAfter]=[await read('theme'),await read('asset')];
  assert.equal(themesAfter.length,0,'阅读主题不应再留在主题库');
  assert.equal(assetsAfter.length,1,'旧阅读主题要迁到收藏库');
  assert.equal(assetsAfter[0].red_category,'阅读主题','迁移后分类应为阅读主题');
  assert.equal(assetsAfter[0].preview_kind,'reader');
  assert.equal(assetsAfter[0].name,'旧阅读主题','迁移要保留名称');
  assert.equal(assetsAfter[0].author,'旧作者','迁移要保留作者');
  assert.equal(assetsAfter[0].container_format,'red_v1_gzip');

  // 新导入一个纯配色阅读主题。
  await p.locator('#unifiedInput').setInputFiles([{name:'阅读主题-咖啡·爪磨咖啡.red',mimeType:'application/octet-stream',buffer:swatch}]);
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===1,{},{timeout:60000});
  const note=await p.locator('#reviewList .review-card').first().innerText();
  assert.match(note,/阅读主题/,'确认卡要写明这是阅读主题包，不能再说成主题');
  await p.locator('#commitSelectedThemes').click();
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===0,{},{timeout:60000});
  const assets=await read('asset'),themes=await read('theme');
  assert.equal(themes.length,0);
  assert.equal(assets.length,2,`收藏应有迁移 + 新导入共 2 条，实际 ${assets.length}`);
  const coffee=assets.find(record=>/咖啡/.test(record.name||''));
  assert.ok(coffee,'新阅读主题要进收藏库');
  assert.equal(coffee.red_category,'阅读主题');
  assert.equal(coffee.preview_kind,'reader');
  assert.ok(coffee.preview_url,'纯配色阅读主题也要生成预览');
  assert.equal(coffee.bytes,swatch.length);
  assert.equal(coffee.container_format,'red_v1_gzip');
  assert.equal(coffee.compression_supported,false);

  await p.evaluate(()=>{location.hash='#assets';});
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===2,{},{timeout:20000});
  await p.locator('#assetCategoryFilter').selectOption('reader');
  await p.waitForTimeout(250);
  assert.equal(await p.locator('#assetList .asset-card').count(),2,'阅读主题筛选应命中两条');
  await p.waitForFunction(()=>[...document.querySelectorAll('#assetList .asset-card img')].every(img=>img.complete&&img.naturalWidth>0),{},{timeout:20000});
  const chips=await p.locator('#assetList .theme-categories em.is-key').allInnerTexts();
  assert.ok(chips.includes('阅读主题'),`收藏卡要有阅读主题标签：${chips.join(',')}`);
  await p.screenshot({path:'scripts/tmp-reader-assets.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: 阅读主题进收藏库「阅读主题」，旧记录自动迁移，纯配色包也能生成预览。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
