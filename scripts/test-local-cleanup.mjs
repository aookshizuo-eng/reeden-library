// Build first. Uses Playwright (or PLAYWRIGHT_PACKAGE pointing at its package.json).
// All deleted files are disposable OPFS fixtures, never the user's local files.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {handle} from '../pages/worker-api.js';
import {MemoryR2} from './test-memory-r2.mjs';

const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||import.meta.url)('playwright');
const root=fileURLToPath(new URL('..',import.meta.url)),bucket=new MemoryR2();
let origin;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      const chunks=[];for await(const part of req)chunks.push(part);
      const response=await handle(new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}),{ASSETS:bucket,SYNC_WRITE_TOKEN:'test-token',ALLOWED_ORIGINS:origin});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const file=url.pathname.replace(/^\/reeden-library\//,'')||'index.html';
    const bytes=await readFile(path.join(root,'dist-pages',file));
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'}).end(bytes);
  }catch(error){res.writeHead(500).end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
const errors=[];
async function page(){
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>{
    localStorage.setItem('reeden-api-base',location.origin);localStorage.setItem('reeden-sync-write-token','test-token');localStorage.setItem('reeden-auto-resume-queue','off');localStorage.setItem('reeden-local-cleanup','1');
    window.cleanupCalls={folders:0,fileRequests:0,fileRemoves:0,activation:[]};
    const query=FileSystemDirectoryHandle.prototype.queryPermission;
    FileSystemDirectoryHandle.prototype.queryPermission=function(...args){return window.cleanupRevoked?Promise.resolve('prompt'):query.apply(this,args);};
    FileSystemFileHandle.prototype.requestPermission=async()=>{window.cleanupCalls.fileRequests++;throw new DOMException('User activation is required to request permissions.','SecurityError');};
    FileSystemFileHandle.prototype.remove=async()=>{window.cleanupCalls.fileRemoves++;throw new Error('Per-file deletion must not be used');};
  });
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(origin+'/reeden-library/#import');await p.waitForFunction(()=>document.querySelector('#apiBaseStatus').textContent.includes('已连接共享库'));
  return p;
}
const svg=label=>`<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>`;
async function seed(p,files,selected=files.map(x=>x.path)){
  await p.evaluate(async({files,selected})=>{
    const root=await(await navigator.storage.getDirectory()).getDirectoryHandle('batch-cleanup-'+crypto.randomUUID(),{create:true});
    const handles=new Map();
    for(const item of files){const parts=item.path.split('/'),name=parts.pop();let parent=root;for(const part of parts)parent=await parent.getDirectoryHandle(part,{create:true});const handle=await parent.getFileHandle(name,{create:true}),writer=await handle.createWritable();await writer.write(item.text);await writer.close();handles.set(item.path,handle);}
    window.cleanupRoot=root;window.cleanupPaths=[...handles.keys()];window.cleanupPickResult='allow';
    window.showOpenFilePicker=async()=>selected.map(name=>{
      const handle=handles.get(name);
      return {getFile:()=>handle.getFile(),isSameEntry:other=>handle.isSameEntry(other),queryPermission:async()=> 'prompt',requestPermission:()=>handle.requestPermission({mode:'readwrite'}),remove:()=>handle.remove()};
    });
    window.showDirectoryPicker=async options=>{
      window.cleanupCalls.folders++;window.cleanupCalls.activation.push(navigator.userActivation.isActive);
      if(options.mode!=='readwrite')throw new Error('Expected directory write access');
      if(window.cleanupPickResult==='cancel')throw new DOMException('Canceled','AbortError');
      if(window.cleanupPickResult==='deny')throw new DOMException('Permission denied','NotAllowedError');
      window.cleanupRevoked=false;return window.cleanupRoot;
    };
  },{files,selected});
}
async function removeSelected(p){
  await p.locator('#selectAllReview').check();await p.locator('#removeSelectedImports').click();await p.locator('#removeImportWithLocal').click();await p.waitForSelector('#cleanupDialog[open]');
}
async function remaining(p){return p.evaluate(async()=>{const found=[];async function walk(dir,prefix=''){for await(const entry of dir.values()){if(entry.kind==='directory')await walk(entry,prefix+entry.name+'/');else found.push(prefix+entry.name);}}await walk(window.cleanupRoot);return found.sort();});}
async function checkCalls(p,folders){const calls=await p.evaluate(()=>window.cleanupCalls);assert.equal(calls.folders,folders);assert.equal(calls.fileRequests,0);assert.equal(calls.fileRemoves,0);assert.ok(calls.activation.every(Boolean),'directory picker must start in the user click');}
try{
  // Regression: 60 read-only handles used to prompt twice, then fail 58 times.
  const bulk=await page(),files=Array.from({length:60},(_,i)=>({path:`${i%3===0?'一/':i%3===1?'二/深/':''}作者 - 主题${i}.svg`,text:svg('作品'+i)}));
  await seed(bulk,[...files,{path:'保留.svg',text:svg('unselected')},{path:'无关.txt',text:'untouched'}],files.map(x=>x.path));
  await bulk.locator('#chooseUnifiedFiles').click();await bulk.waitForFunction(()=>document.querySelectorAll('#pendingList .pending-card').length===60);
  await removeSelected(bulk);assert.equal(await bulk.locator('#cleanupList input:checked').count(),60);assert.equal(await bulk.locator('#cleanupList input:disabled').count(),0);
  await bulk.locator('#cleanupConfirm').click();await bulk.waitForFunction(()=>document.querySelector('#reviewBatchStatus').textContent.includes('本地已删除 60'));
  assert.deepEqual(await remaining(bulk),['保留.svg','无关.txt']);await checkCalls(bulk,1);
  console.log('PASS: 60 real OPFS files across nested folders deleted with one directory grant and zero per-file permission requests.');

  const canceled=await page();await seed(canceled,[{path:'甲.svg',text:svg('a')},{path:'乙.svg',text:svg('b')}]);
  await canceled.locator('#chooseUnifiedFiles').click();await canceled.waitForFunction(()=>document.querySelectorAll('#pendingList .pending-card').length===2);await removeSelected(canceled);
  await canceled.evaluate(()=>window.cleanupPickResult='cancel');await canceled.locator('#cleanupConfirm').click();await canceled.waitForFunction(()=>!document.querySelector('#cleanupConfirm').disabled);assert.equal((await remaining(canceled)).length,2);assert.equal(await canceled.locator('#cleanupDialog').isVisible(),true);
  await canceled.evaluate(()=>window.cleanupPickResult='deny');await canceled.locator('#cleanupConfirm').click();await canceled.waitForFunction(()=>document.querySelector('#cleanupNote').textContent.includes('授权失败'));assert.equal((await remaining(canceled)).length,2);
  await canceled.evaluate(()=>window.cleanupPickResult='allow');await canceled.locator('#cleanupList input').nth(1).uncheck();await canceled.locator('#cleanupConfirm').click();await canceled.waitForFunction(()=>document.querySelector('#reviewBatchStatus').textContent.includes('本地已删除 1'));assert.deepEqual(await remaining(canceled),['乙.svg']);await checkCalls(canceled,3);
  console.log('PASS: cancellation and denial preserve every file; retry keeps the unchecked source.');

  const safe=await page();await seed(safe,[{path:'一/重复.svg',text:svg('same')},{path:'二/重复.svg',text:svg('same')},{path:'改变.svg',text:svg('new!')},{path:'匹配.svg',text:svg('okay')}],[]);
  await safe.locator('#unifiedInput').setInputFiles([{name:'重复.svg',mimeType:'image/svg+xml',buffer:Buffer.from(svg('same'))},{name:'改变.svg',mimeType:'image/svg+xml',buffer:Buffer.from(svg('old!'))},{name:'匹配.svg',mimeType:'image/svg+xml',buffer:Buffer.from(svg('okay'))}]);
  await safe.waitForFunction(()=>document.querySelectorAll('#pendingList .pending-card').length===3);await removeSelected(safe);await safe.locator('#cleanupConfirm').click();await safe.waitForFunction(()=>document.querySelector('#cleanupNote').textContent.includes('仍有 2 个未匹配'));assert.equal((await remaining(safe)).length,4);
  await safe.locator('#cleanupList input').nth(0).uncheck();await safe.locator('#cleanupList input').nth(1).uncheck();
  if(process.env.CLEANUP_SCREENSHOTS){await mkdir(process.env.CLEANUP_SCREENSHOTS,{recursive:true});await safe.screenshot({path:path.join(process.env.CLEANUP_SCREENSHOTS,'cleanup-desktop.png')});await safe.setViewportSize({width:390,height:844});await safe.screenshot({path:path.join(process.env.CLEANUP_SCREENSHOTS,'cleanup-mobile.png')});assert.ok(await safe.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await safe.locator('#cleanupConfirm').click();await safe.waitForFunction(()=>document.querySelector('#reviewBatchStatus').textContent.includes('本地已删除 1'));assert.deepEqual(await remaining(safe),['一/重复.svg','二/重复.svg','改变.svg']);await checkCalls(safe,1);
  console.log('PASS: ambiguous duplicates and same-size changed files stay intact; matched files can be deleted independently.');

  const folder=await page();await seed(folder,[{path:'甲.svg',text:svg('folder-a')},{path:'深/乙.svg',text:svg('folder-b')}]);await folder.locator('#chooseUnifiedFolder').click();await folder.waitForFunction(()=>document.querySelectorAll('#pendingList .pending-card').length===2);
  assert.equal(await folder.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('reeden-transfers-v1');r.onsuccess=()=>{const q=r.result.transaction('files').objectStore('files').getAll();q.onsuccess=()=>resolve(q.result.length===2&&q.result.every(row=>row.directory?.kind==='directory'&&row.parent?.kind==='directory'));q.onerror=()=>reject(q.error);};})),true,'recovery checkpoints retain the granted root');
  await removeSelected(folder);await folder.locator('#cleanupConfirm').click();await folder.waitForFunction(()=>document.querySelector('#reviewBatchStatus').textContent.includes('本地已删除 2'));assert.deepEqual(await remaining(folder),[]);await checkCalls(folder,1);
  console.log('PASS: an already-authorized folder needs no second picker; recovery checkpoints retain root handles.');

  const restored=await page();await seed(restored,[{path:'恢复甲.svg',text:svg('resume-a')},{path:'深/恢复乙.svg',text:svg('resume-b')}]);await restored.locator('#chooseUnifiedFolder').click();await restored.waitForFunction(()=>document.querySelectorAll('#pendingList .pending-card').length===2);
  await restored.reload();await restored.waitForSelector('#localResumePanel:not([hidden])');
  await restored.evaluate(async()=>{
    const rows=await new Promise(resolve=>{const r=indexedDB.open('reeden-transfers-v1');r.onsuccess=()=>{const q=r.result.transaction('files').objectStore('files').getAll();q.onsuccess=()=>resolve(q.result);};});
    window.cleanupRoot=rows[0].directory;window.cleanupRevoked=true;
    window.showDirectoryPicker=async()=>{window.cleanupCalls.folders++;window.cleanupCalls.activation.push(navigator.userActivation.isActive);window.cleanupRevoked=false;return window.cleanupRoot;};
  });
  await restored.locator('#resumeLocalTransfers').click();await restored.waitForSelector('#cleanupDialog[open]');assert.match(await restored.locator('#cleanupConfirm').innerText(),/授权文件夹/);await checkCalls(restored,0);
  await restored.locator('#cleanupConfirm').click();await restored.waitForFunction(()=>document.querySelector('#unifiedImportStatus').textContent.includes('已删除 2'));assert.deepEqual(await remaining(restored),[]);await checkCalls(restored,1);
  console.log('PASS: after reload, real uploads resume from checkpoints; expired folder permission is renewed once by a click.');

  const native=await page();await native.evaluate(()=>{
    window.showDirectoryPicker=undefined;window.showOpenFilePicker=undefined;
    window.RedGardenNative={capability:()=>JSON.stringify({canDelete:true}),deleteFiles:payload=>{window.nativeDeleted=JSON.parse(payload);return JSON.stringify({deleted:window.nativeDeleted.length});}};
  });
  await native.locator('#unifiedInput').setInputFiles([{name:'手机.svg',mimeType:'image/svg+xml',buffer:Buffer.from(svg('native'))}]);await native.waitForFunction(()=>document.querySelectorAll('#pendingList .pending-card').length===1);await removeSelected(native);await native.locator('#cleanupConfirm').click();await native.waitForFunction(()=>document.querySelector('#reviewBatchStatus').textContent.includes('本地已删除 1'));assert.equal((await native.evaluate(()=>window.nativeDeleted))[0].name,'手机.svg');await checkCalls(native,0);
  console.log('PASS: Android native deletion remains available without a directory picker.');
  assert.deepEqual(errors,[]);console.log('PASS: no browser runtime errors.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
