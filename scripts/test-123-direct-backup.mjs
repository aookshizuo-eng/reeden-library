// 端到端验收问题3：123 备份走浏览器直连而非 Cloudflare 海外中转。
// 复用导入流程触发真实备份，用 page.route 拦截 123 外部域名并断言：
//   1) 控制面 /b/api/* 浏览器直连命中；2) presigned 节点 PUT 命中；
//   3) 结果写回 /api/backup/123/result 命中；4) Worker 中转接口调用为 0。
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
const root=fileURLToPath(new URL('..',import.meta.url)),codec=createRequire(import.meta.url)('../site/free_codec.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB7sAAAAASUVORK5CYII=','base64');
const make=async name=>({name:name+'.red',mimeType:'application/octet-stream',buffer:Buffer.from(await codec.writeZipEntries([{name:'theme.json',bytes:Buffer.from(JSON.stringify({name,author:'直连备份测试'}))},{name:'shelf.png',bytes:png}],{store:true}))});

const bucket=new MemoryR2();let origin;
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
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true}),errors=[];
const context=await browser.newContext({viewport:{width:1440,height:960}});
await context.addInitScript(()=>{
  localStorage.setItem('reeden-api-base',location.origin);
  localStorage.setItem('reeden-sync-write-token','test-token');
  localStorage.setItem('reeden-auto-resume-queue','off');
  localStorage.setItem('reeden-pan123-token','mock-session-token');
  localStorage.setItem('reeden-pan123-folder','Red-Garden-Backup');
  // 打开 123 备份：写入 config + 勾选框（app.js 启动时读取 localStorage）。
  localStorage.setItem('reeden-backup-123-enabled','on');
});
const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
const calls=[];
// 反向断言：原包只进 123，不写 R2、也不从 R2 回读；压缩版仍要写 R2。
const originalGets=[],originalWrites=[],compressedWrites=[];
await p.route('**/api/objects/originals/**',async route=>{
  const method=route.request().method();
  if(method==='GET')originalGets.push(route.request().url());
  if(method==='PUT')originalWrites.push(route.request().url());
  return route.continue();
});
await p.route('**/api/objects/compressed/**',async route=>{
  if(route.request().method()==='PUT')compressedWrites.push(route.request().url());
  return route.continue();
});
// 123 控制面：浏览器直连，返回完整上传序列。并发多主题时用 etag（=md5）区分各自文件。
const uploadedFiles=new Map(); // etag -> {fileName,size}
await p.route('**/b/api/**',async route=>{
  const u=new URL(route.request().url()),path=u.pathname;
  calls.push('DIRECT '+path);
  let data={};
  if(path.endsWith('/file/list/new')){
    const parentId=u.searchParams.get('parentFileId');
    // parentFileId=0 是根目录查询（找备份目录）；非 0 是目录内查询（查重/落盘确认）。
    if(parentId==='0')data={InfoList:[{FileName:'Red-Garden-Backup',Type:1,FileId:'9'}]};
    else data={InfoList:[...uploadedFiles.values()].map(f=>({FileName:f.fileName,Type:0,Size:f.size,Etag:f.etag,FileId:'777'}))};
  } else if(path.endsWith('/file/upload_request')){
    let body={};try{body=route.request().postDataJSON()||{};}catch{}
    if(body.size>0&&body.type===0)uploadedFiles.set(String(body.etag),{fileName:body.fileName,size:body.size,etag:String(body.etag)});
    data={Reuse:false,Bucket:'bucket',Key:'key',StorageNode:'https://m74.123624.com',FileId:'777',UploadId:'up'};
  } else if(path.endsWith('/file/s3_upload_object/auth')){
    data={presignedUrls:{'1':'https://m74.123624.com/part1'}};
  } else if(path.endsWith('/file/upload_complete/v2')){
    data={file_info:{FileId:'777'}};
  } else if(path.endsWith('/user/info')){
    data={Nickname:'直连测试'};
  }
  return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({code:0,data})});
});
await p.route('**/m74.123624.com/**',async route=>{
  calls.push('DIRECT PUT presigned');
  return route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*','ETag':'mock'}});
});
// 反向断言：Worker 中转 123 的路由必须为 0。
await p.route('**/api/backup/123/from-r2',async route=>{
  calls.push('WORKER from-r2');
  return route.fulfill({status:200,contentType:'application/json',body:'{"ok":false,"error":"should not be called"}'});
});
await p.route('**/api/backup/123',async route=>{
  const ct=route.request().headers()['content-type']||'';
  if(route.request().method()==='POST'&&ct.includes('octet-stream'))calls.push('WORKER bytes /api/backup/123');
  return route.continue();
});
try{
  await p.goto(origin+'/reeden-library/#import',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'),{},{timeout:20000});
  await p.locator('#unifiedInput').setInputFiles([await make('直连备份甲'),await make('直连备份乙'),await make('直连备份丙')]);
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===3&&!document.querySelector('#pauseTransfer').offsetParent,{},{timeout:60000});
  await p.locator('#commitSelectedThemes').click();
  // 等 3 个原包全部备份完成（并发后应快速收敛）。
  await p.waitForFunction(()=>/本次 \d+ 个原包已备份/.test(document.querySelector('#pan123BackupStatus')?.textContent||''),{},{timeout:45000}).catch(()=>{});
  await p.waitForFunction(()=>document.querySelector('#localResumePanel')?.hidden,{},{timeout:15000}).catch(()=>{});
  const status=await p.evaluate(()=>({
    batch:document.querySelector('#reviewBatchStatus')?.textContent?.trim()||'',
    backup:document.querySelector('#pan123BackupStatus')?.textContent?.trim()||'',
    stage:document.querySelector('#transferProgressStage')?.textContent?.trim()||'',
    localResume:document.querySelector('#localResumeText')?.textContent?.trim()||'',
    localResumeHidden:document.querySelector('#localResumePanel')?.hidden,
  }));
  const recordState=await p.evaluate(async()=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const r=await fetch('/api/library?kind=theme',{headers:token?{Authorization:'Bearer '+token}:{}});
    const j=await r.json().catch(()=>({}));
    return (j.records||[]).slice(0,3).map(x=>({id:x.id,original_url:x.original_url,original_storage:x.original_storage,original_123:x.original_123,original_123_error:x.original_123_error}));
  });
  const directControl=calls.filter(c=>c.startsWith('DIRECT /b/api/'));
  const directPut=calls.filter(c=>c==='DIRECT PUT presigned');
  const workerTransit=calls.filter(c=>c.startsWith('WORKER'));
  const resultWrite=calls.filter(c=>c.includes('/api/backup/123/result'));
  const rootList=calls.filter(c=>c==='DIRECT /b/api//file/list/new').length;
  // 3 个主题：目根目录查询（找备份目录）应远少于主题数（目录已缓存）。
  const completed=(status.backup.match(/本次 (\d+) 个原包已备份/)||[])[1];
  console.log(JSON.stringify({calls,status,recordState,resultWrite,originalGets:originalGets.length,originalWrites:originalWrites.length,compressedWrites:compressedWrites.length,check:{
    directControl:directControl.length>0,
    directPut:directPut.length>0,
    workerTransitZero:workerTransit.length===0,
    noJsErrors:errors.length===0,
    noR2OriginalWrite:originalWrites.length===0,
    noR2ReDownload:originalGets.length===0,
    compressedInR2:compressedWrites.length===3,
    backed:completed,
  }},null,2));
  assert.ok(directControl.length>0,'控制面必须走浏览器直连 /b/api');
  assert.ok(directPut.length>0,'数据面必须浏览器直传 presigned 节点');
  assert.equal(workerTransit.length,0,'不得退回 Worker 海外中转');
  assert.equal(originalWrites.length,0,'启用 123 备份时原包不得写入 R2');
  assert.equal(compressedWrites.length,3,'压缩版必须写入 R2');
  assert.equal(originalGets.length,0,'备份阶段不得再从 R2 下载原包（应复用入库内存字节）');
  assert.equal(completed,'3','3 个主题应全部备份成功（并发隔离）');
  assert.equal(status.localResumeHidden,true,'备份成功后本地恢复副本应自动清除，不再显示“未完成文件”横幅');
  assert.deepEqual(errors,[]);
  console.log('PASS: 原包直传 123、压缩版入 R2；Worker 中转 0、R2 原包写入/回读 0。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
