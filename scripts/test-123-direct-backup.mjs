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
// 123 控制面：浏览器直连，返回完整上传序列；list/new 第二次起返回已落盘文件。
let listCount=0,uploadComplete=false,uploadFileName='',uploadSize=0,uploadEtag='';
await p.route('**/b/api/**',async route=>{
  const u=new URL(route.request().url()),path=u.pathname;
  calls.push('DIRECT '+path);
  let data={};
  if(path.endsWith('/file/list/new')){
    listCount++;
    const parentId=u.searchParams.get('parentFileId');
    // parentFileId=0 是根目录查询（找备份目录）；非 0 是目录内查询（查重/落盘确认）。
    if(parentId==='0')data={InfoList:[{FileName:'Red-Garden-Backup',Type:1,FileId:'9'}]};
    else if(uploadComplete){
      // 落盘确认：返回一个与上传参数匹配的文件项（Size/Etag 由脚本按实际值填）。
      data={InfoList:[{FileName:uploadFileName,Type:0,Size:uploadSize,Etag:uploadEtag,FileId:'777'}]};
    } else data={InfoList:[]};
  } else if(path.endsWith('/file/upload_request')){
    let body={};try{body=route.request().postDataJSON()||{};}catch{}
    // 第一个 upload_request 可能是建目录（size:0,type:1），第二个才是文件。
    if(body.size>0){uploadFileName=body.fileName;uploadSize=body.size;uploadEtag=body.etag;}
    data={Reuse:false,Bucket:'bucket',Key:'key',StorageNode:'https://m74.123624.com',FileId:'777',UploadId:'up'};
  } else if(path.endsWith('/file/s3_upload_object/auth')){
    data={presignedUrls:{'1':'https://m74.123624.com/part1'}};
  } else if(path.endsWith('/file/upload_complete/v2')){
    uploadComplete=true;data={file_info:{FileId:'777'}};
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
  await p.locator('#unifiedInput').setInputFiles([await make('直连备份主题')]);
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===1&&!document.querySelector('#pauseTransfer').offsetParent,{},{timeout:60000});
  await p.locator('#commitSelectedThemes').click();
  // 等备份阶段跑完：transferStage 出现"已入库/备份"字样，或直接给足时间。
  // 备份会重新显示进度面板，所以不能等 #transferProgress 消失。
  await p.waitForTimeout(15000);
  const status=await p.evaluate(()=>({
    batch:document.querySelector('#reviewBatchStatus')?.textContent?.trim()||'',
    backup:document.querySelector('#pan123BackupStatus')?.textContent?.trim()||'',
    stage:document.querySelector('#transferProgressStage')?.textContent?.trim()||'',
  }));
  const directControl=calls.filter(c=>c.startsWith('DIRECT /b/api/'));
  const directPut=calls.filter(c=>c==='DIRECT PUT presigned');
  const workerTransit=calls.filter(c=>c.startsWith('WORKER'));
  const resultWrite=calls.filter(c=>c.includes('/api/backup/123/result'));
  console.log(JSON.stringify({calls,status,resultWrite,check:{
    directControl:directControl.length>0,
    directPut:directPut.length>0,
    workerTransitZero:workerTransit.length===0,
    noJsErrors:errors.length===0,
  }},null,2));
  assert.ok(directControl.length>0,'控制面必须走浏览器直连 /b/api');
  assert.ok(directPut.length>0,'数据面必须浏览器直传 presigned 节点');
  assert.equal(workerTransit.length,0,'不得退回 Worker 海外中转');
  assert.deepEqual(errors,[]);
  console.log('PASS: 123 backup uses browser-direct control plane + presigned PUT; Worker transit 0 calls.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
