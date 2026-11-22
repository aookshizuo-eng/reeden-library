// 阅读主题（RED\x01 阅读配色）归收藏库「阅读主题」：新导入的走 redAsset
// 分支，旧库里已经当主题存过的记录在打开页面时自动迁移。纯配色、没有背景图
// 的阅读主题也要画出配色预览，不能只剩「暂无预览」。
// 反方向同样重要：加密应用主题（RED\x10）的预览偶尔只能认出阅读背景，不能被
// 当成阅读主题——留在主题库、也不带「阅读主题」标签；早先被误迁进收藏库的
// 记录要搬回主题库。
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
// 真正的阅读主题收藏（RED\x01）：回迁必须放过它。
const readerAssetSha='d'.repeat(64);
const readerAsset={kind:'asset',id:'asset-'+readerAssetSha.slice(0,16),asset_type:'red',extension:'red',category:'阅读主题',red_category:'阅读主题',
  preview_kind:'reader',file_name:'阅读主题-真阅读.red',name:'真阅读主题',author:'',style:'',tags:[],
  sha256:readerAssetSha,original_sha256:readerAssetSha,bytes:2048,mime:'application/octet-stream',container_format:'red_v1_gzip',compression_supported:false,
  object_url:'/api/objects/assets/reader.red',url:'/api/objects/assets/reader.red',preview_url:'',created_at:'2026-01-01T00:00:00.000Z',saved_to_cloud:true};
// 加密应用主题：目录是密文，角色识别失败时 preview_details.kind 会退化成 reader，
// 旧逻辑因此把它标成「阅读主题」甚至搬进收藏库。它必须留在主题库，也不该带这个标签。
const appThemeSha='b'.repeat(64);
const appTheme={kind:'theme',id:'theme-app',name:'透色天窗蓝',author:'沈应夌',file_name:'应用主题 - 透色天窗蓝.red',bytes:4096,
  container_format:'red_private_v2',preview_details:{kind:'reader',encrypted_source:true},sha256:appThemeSha,original_sha256:appThemeSha,
  compressed_url:'/api/objects/originals/app-theme.red',library_url:'/api/objects/originals/app-theme.red',original_url:'/api/objects/originals/app-theme.red',
  preview_light_url:'',categories:['冷色'],auto_categories:['冷色','阅读主题'],created_at:'2026-01-01T00:00:00.000Z',tags:[]};
// 已经被误迁进收藏库的应用主题：打开页面后要搬回主题库。故意把记录里的
// container_format 写成 red_v1_gzip，验证回迁是按原包文件头判断的。
const wrongAssetSha='c'.repeat(64);
const wrongAsset={kind:'asset',id:'asset-'+wrongAssetSha.slice(0,16),asset_type:'red',extension:'red',category:'阅读主题',red_category:'阅读主题',
  preview_kind:'reader',file_name:'应用主题 - 透色笺花粉.red',name:'透色笺花粉',author:'沈应夌',style:'',tags:[],
  sha256:wrongAssetSha,original_sha256:wrongAssetSha,bytes:0,mime:'application/octet-stream',container_format:'red_v1_gzip',compression_supported:false,
  object_url:'/api/objects/assets/flowers.red',url:'/api/objects/assets/flowers.red',preview_url:'',created_at:'2026-01-01T00:00:00.000Z',saved_to_cloud:true};
{
  // Worker 写记录时会校验引用的对象真实存在。
  await bucket.put('originals/legacy.red',new TextEncoder().encode('RED\x01legacy'));
  await bucket.put('originals/app-theme.red',new TextEncoder().encode('RED\x10apptheme'));
  await bucket.put('assets/flowers.red',new TextEncoder().encode('RED\x10flowers'));
  await bucket.put('assets/reader.red',new TextEncoder().encode('RED\x01reader'));
  const records=[];
  for(const record of [legacy,appTheme,wrongAsset,readerAsset]){
    const recordSha=await sha(new TextEncoder().encode(JSON.stringify(record)));
    await bucket.put('records/'+recordSha+'.json',new TextEncoder().encode(JSON.stringify(record)));
    records.push({...record,record_sha256:recordSha});
  }
  // 线上库一直有 system/library-v1.json 索引；只放 records 对象会让 Worker
  // 在删除后从 records 重建索引，把刚删掉的记录又读回来。
  await bucket.put('system/library-v1.json',JSON.stringify({version:1,revision:'legacy-revision',records,garbage:[],updated_at:'2026-01-01T00:00:00.000Z'}));
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
  // 旧阅读主题记录应被自动搬到收藏库；加密应用主题必须留在主题库，
  // 已经被误迁进收藏库的那条要搬回来。用轮询而不是 waitForFunction：
  // 异步谓词会立刻被当成真值，导致还在迁移时就往下断言。
  const snapshot=async()=>p.evaluate(async()=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const headers=token?{Authorization:'Bearer '+token}:{};
    const stamp=Date.now()+Math.random();
    const [themes,assets]=await Promise.all([fetch('/api/themes?t='+stamp,{cache:'no-store',headers}).then(r=>r.json()),fetch('/api/assets?t='+stamp,{cache:'no-store',headers}).then(r=>r.json())]);
    return {themeNames:(themes.records||[]).map(item=>item.name),assetNames:(assets.records||[]).map(item=>item.name)};
  });
  let ready=false,last=null;
  for(const deadline=Date.now()+30000;Date.now()<deadline;){
    last=await snapshot();
    if(last.themeNames.length===2&&last.themeNames.includes('透色天窗蓝')&&last.themeNames.includes('透色笺花粉')
      &&!last.themeNames.includes('旧阅读主题')&&last.assetNames.length===2
      &&last.assetNames.includes('旧阅读主题')&&last.assetNames.includes('真阅读主题')){ready=true;break;}
    await p.waitForTimeout(200);
  }
  assert.ok(ready,`回迁/迁移未完成：主题 ${last?.themeNames.join(',')}；收藏 ${last?.assetNames.join(',')}`);
  const [themesAfter,assetsAfter]=[await read('theme'),await read('asset')];
  assert.equal(themesAfter.length,2,`主题库应只剩应用主题（原记录 + 回迁记录），实际 ${themesAfter.map(item=>item.name).join(',')}`);
  assert.ok(themesAfter.some(item=>item.name==='透色天窗蓝'),'加密应用主题不能被迁出主题库');
  assert.ok(themesAfter.some(item=>item.name==='透色笺花粉'),`误迁进收藏库的应用主题要搬回主题库，实际主题：${themesAfter.map(item=>item.name+':'+item.container_format).join(' / ')}；收藏：${assetsAfter.map(item=>item.name+':'+item.red_category).join(' / ')}`);
  assert.equal(assetsAfter.length,2,'收藏库只该留下真正的阅读主题');
  const migrated=assetsAfter.find(item=>item.name==='旧阅读主题');
  assert.ok(migrated,'旧阅读主题要迁到收藏库');
  assert.equal(migrated.red_category,'阅读主题','迁移后分类应为阅读主题');
  assert.equal(migrated.preview_kind,'reader');
  assert.equal(migrated.author,'旧作者','迁移要保留作者');
  assert.equal(migrated.container_format,'red_v1_gzip');
  assert.ok(assetsAfter.some(item=>item.name==='真阅读主题'),'真正的阅读主题收藏不能被回迁搬走');
  // 应用主题卡片不能再带「阅读主题」标签。
  await p.evaluate(()=>{location.hash='#themes';});
  await p.waitForTimeout(800);
  const themeChips=await p.locator('#themeList .theme-card').evaluateAll(cards=>cards.map(card=>({name:card.querySelector('.theme-title')?.textContent,categories:[...card.querySelectorAll('.theme-categories em')].map(item=>item.textContent)})));
  const appCard=themeChips.find(card=>card.name==='透色天窗蓝');
  assert.ok(appCard,'主题库里应有应用主题卡片');
  assert.ok(!appCard.categories.includes('阅读主题'),`应用主题不该带阅读主题标签：${appCard.categories.join(',')}`);
  assert.ok(appCard.categories.includes('冷色'),'原有色系分类要保留');

  // 新导入一个纯配色阅读主题。
  await p.evaluate(()=>{location.hash='#import';});
  await p.waitForTimeout(600);
  await p.locator('#unifiedInput').setInputFiles([{name:'阅读主题-咖啡·爪磨咖啡.red',mimeType:'application/octet-stream',buffer:swatch}]);
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===1,{},{timeout:60000});
  const note=await p.locator('#reviewList .review-card').first().innerText();
  assert.match(note,/阅读主题/,'确认卡要写明这是阅读主题包，不能再说成主题');
  await p.locator('#commitSelectedThemes').click();
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===0,{},{timeout:60000});
  const assets=await read('asset'),themes=await read('theme');
  assert.equal(themes.length,2,'应用主题还要留在主题库');
  assert.equal(assets.length,3,`收藏应有真阅读 + 迁移 + 新导入共 3 条，实际 ${assets.length}`);
  const coffee=assets.find(record=>/咖啡/.test(record.name||''));
  assert.ok(coffee,'新阅读主题要进收藏库');
  assert.equal(coffee.red_category,'阅读主题');
  assert.equal(coffee.preview_kind,'reader');
  assert.ok(coffee.preview_url,'纯配色阅读主题也要生成预览');
  assert.equal(coffee.bytes,swatch.length);
  assert.equal(coffee.container_format,'red_v1_gzip');
  assert.equal(coffee.compression_supported,false);

  await p.evaluate(()=>{location.hash='#assets';});
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===3,{},{timeout:20000});
  await p.locator('#assetCategoryFilter').selectOption('reader');
  await p.waitForTimeout(250);
  assert.equal(await p.locator('#assetList .asset-card').count(),3,'阅读主题筛选应命中三条');
  await p.waitForFunction(()=>[...document.querySelectorAll('#assetList .asset-card img')].every(img=>img.complete&&img.naturalWidth>0),{},{timeout:20000});
  const chips=await p.locator('#assetList .theme-categories em.is-key').allInnerTexts();
  assert.ok(chips.includes('阅读主题'),`收藏卡要有阅读主题标签：${chips.join(',')}`);
  await p.screenshot({path:'scripts/tmp-reader-assets.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: 阅读主题进收藏库「阅读主题」，旧记录自动迁移；加密应用主题留在主题库并清掉错误标签，误迁的收藏会搬回来。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
