// All uploads use in-memory R2. REEDEN_READER_FILE optionally reads a real,
// unmodified RED v1 source; no real user files are changed or deleted.
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
const generated=Buffer.concat([Buffer.from([82,69,68,1]),gzipSync(JSON.stringify({version:1,type:'readerColorSchema',data:[{name:'旧版阅读样例',backgroundImageData:gzipSync(png).toString('base64'),themeMode:'light',backgroundColor:'#fff',textColor:'#222'}]}))]);
const reader=process.env.REEDEN_READER_FILE?await readFile(process.env.REEDEN_READER_FILE):generated;
const entries=await codec.readZipEntries(reader),inspection=await codec.inspectContainer(reader);
assert.equal(inspection.format,'red_v1_gzip');assert.ok(entries.some(entry=>codec.mimeFromBytes(entry.bytes,entry.name).startsWith('image/')));assert.ok(!new TextDecoder().decode(entries[0].bytes).includes('backgroundImageData'));
assert.deepEqual(Buffer.from((await codec.compressRed(reader)).bytes),reader,'legacy reader packages must retain every original byte');
await assert.rejects(()=>codec.readZipEntries(generated.subarray(0,generated.length-8)),error=>error.code==='reader_data_invalid');
const bad={name:'损坏的阅读主题.red',mimeType:'application/octet-stream',buffer:generated.subarray(0,generated.length-8)};
const make=async name=>({name:name+'.red',mimeType:'application/octet-stream',buffer:Buffer.from(await codec.writeZipEntries([{name:'theme.json',bytes:Buffer.from(JSON.stringify({name,author:'恢复测试'}))},{name:'shelf.png',bytes:png}],{store:true}))});
console.log('PASS: legacy gzip schema, nested background image, structured corruption error, original-byte preservation'+(process.env.REEDEN_READER_FILE?' (real source)':'')+'.');
const bucket=new MemoryR2();let origin,hold=false;const releases=[];let heldPuts=0;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      const chunks=[];for await(const c of req)chunks.push(c);
      if(hold&&req.method==='PUT'&&url.pathname.startsWith('/api/objects/')){heldPuts++;await new Promise(resolve=>releases.push(resolve));}
      const response=await handle(new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}),{ASSETS:bucket,SYNC_WRITE_TOKEN:'test-token',ALLOWED_ORIGINS:origin});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const file=url.pathname.replace(/^\/reeden-library\//,'')||'index.html',bytes=await readFile(path.join(root,'dist-pages',file));
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'}).end(bytes);
  }catch(error){if(!res.headersSent)res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true}),errors=[];
async function page(){
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  await context.addInitScript(()=>{
    localStorage.setItem('reeden-api-base',location.origin);localStorage.setItem('reeden-sync-write-token','test-token');localStorage.setItem('reeden-auto-resume-queue','off');localStorage.setItem('reeden-backup-123-enabled','off');
    const read=File.prototype.arrayBuffer;window.waitingReads=[];
    File.prototype.arrayBuffer=function(){if(window.delayReads&&this.name.startsWith('暂停读取'))return new Promise(resolve=>window.waitingReads.push(()=>resolve(read.call(this))));return read.call(this);};
  });
  const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/reeden-library/#import');await p.waitForFunction(()=>document.querySelector('#apiBaseStatus').textContent.includes('已连接共享库'));return p;
}
async function rows(p){return p.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('reeden-transfers-v1');r.onsuccess=()=>{const q=r.result.transaction('files').objectStore('files').getAll();q.onsuccess=()=>resolve(q.result.map(x=>({name:x.file.name,id:x.id})));};}));}
function records(){return [...bucket.items].filter(([key])=>key.startsWith('records/')).map(([,value])=>JSON.parse(new TextDecoder().decode(value.bytes)));}
try{
  const p=await page(),files=[];for(let i=0;i<64;i++)files.push(await make('混合批次'+i));files.splice(17,0,bad);files.push({name:'阅读主题 - 旧版样例.red',mimeType:'application/octet-stream',buffer:reader});
  await p.locator('#unifiedInput').setInputFiles(files);await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===65&&!document.querySelector('#pauseTransfer').offsetParent,{},{timeout:60000});
  assert.match(await p.locator('#importIssueSummary').innerText(),/1 个文件/);assert.match(await p.locator('#reviewList').innerText(),/保留原始 gzip/);assert.equal((await rows(p)).length,66);
  await p.reload();await p.waitForSelector('#localResumePanel:not([hidden])');await p.locator('#resumeLocalTransfers').evaluate(button=>{button.click();button.click();});
  await p.waitForFunction(()=>document.querySelector('#localResumeText').textContent.includes('1 个未完成')&&!document.querySelector('#resumeLocalTransfers').disabled,{},{timeout:60000});
  assert.equal(records().length,65);assert.equal((await rows(p)).length,1);assert.match(await p.locator('#unifiedImportStatus').innerText(),/1 项待处理|1 个.*无法读取/);assert.doesNotMatch(await p.locator('#unifiedImportStatus').innerText(),/请先勾选/);
  const legacy=records().find(record=>record.container_format==='red_v1_gzip');assert.ok(legacy);assert.notEqual(legacy.author,'阅读主题');
  // 入库用的是可读文件名 `<name>-压缩.red`（objectFileName 带 label），不是裸 sha；
  // 按内容在 compressed/ 前缀下找落盘对象，断言阅读主题字节原样保留。
  const stored=[...bucket.items].find(([key,value])=>key.startsWith('compressed/')&&value.bytes&&Buffer.from(value.bytes).equals(reader));
  assert.ok(stored,'阅读主题原始 gzip 字节必须原样落盘（不转 ZIP、不重编码）');
  await p.locator('#retryImportIssues').click();await p.waitForFunction(()=>!document.querySelector('#retryImportIssues').disabled);assert.equal(records().length,65);assert.equal((await rows(p)).length,1);
  await p.locator('#resumeLocalTransfers').click();await p.waitForFunction(()=>document.querySelector('#unifiedImportStatus').textContent.includes('仍无法读取')&&!document.querySelector('#resumeLocalTransfers').disabled);
  if(process.env.IMPORT_SCREENSHOT)await p.screenshot({path:process.env.IMPORT_SCREENSHOT,fullPage:true});
  await p.locator('[data-remove-import-issue]').click();await p.waitForFunction(()=>document.querySelector('#localResumePanel').hidden);assert.equal((await rows(p)).length,0);
  console.log('PASS: 66-file batch with one corrupt source yields 65 ready files; reload + double-click resume uploads each once; failed file remains actionable; real reader bytes preserved in R2.');

  const paused=await page(),pending=[];for(let i=0;i<4;i++)pending.push(await make('暂停读取'+i));await paused.evaluate(()=>window.delayReads=true);await paused.locator('#unifiedInput').setInputFiles(pending);await paused.waitForFunction(()=>window.waitingReads.length>0);
  await paused.locator('#pauseTransfer').click();await paused.evaluate(()=>{window.delayReads=false;window.waitingReads.splice(0).forEach(resolve=>resolve());});await paused.waitForFunction(()=>!document.querySelector('#resumeLocalTransfers').disabled&&!document.querySelector('#pauseTransfer').offsetParent);
  assert.equal((await rows(paused)).length,4);assert.equal(await paused.locator('#reviewList .review-card').count(),0);
  await paused.locator('#resumeLocalTransfers').click();await paused.waitForFunction(()=>document.querySelector('#localResumePanel').hidden&&!document.querySelector('#resumeLocalTransfers').disabled,{},{timeout:20000});assert.equal((await rows(paused)).length,0);assert.equal(records().length,69);
  console.log('PASS: pause during reading keeps all originals, then one resume action re-reads and uploads them.');

  const uploading=await page();await uploading.locator('#unifiedInput').setInputFiles([await make('上传暂停甲'),await make('上传暂停乙')]);await uploading.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===2&&!document.querySelector('#pauseTransfer').offsetParent);hold=true;await uploading.locator('#commitSelectedThemes').click();
  // 等真实的 PUT 被 mock 挂起（heldPuts>0）比等 stage 文案更可靠：小文件 XHR 的
  // onprogress 不一定触发，但 PUT 一定到达并停在我们设置的闸门上。
  for(let i=0;i<600&&!heldPuts;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(heldPuts>0,'应有一个主题对象 PUT 到达并在暂停闸门处挂起');
  await uploading.locator('#pauseTransfer').click();hold=false;releases.splice(0).forEach(resolve=>resolve());await uploading.waitForFunction(()=>!document.querySelector('#resumeLocalTransfers').disabled&&!document.querySelector('#pauseTransfer').offsetParent);
  assert.equal((await rows(uploading)).length,2);await uploading.locator('#resumeLocalTransfers').click();await uploading.waitForFunction(()=>document.querySelector('#localResumePanel').hidden&&!document.querySelector('#resumeLocalTransfers').disabled,{},{timeout:20000});assert.equal(records().length,71);
  assert.deepEqual(errors,[]);console.log('PASS: pause in real object uploads and resume already-loaded pending themes; no selection toast or browser runtime errors.');
}finally{hold=false;releases.splice(0).forEach(resolve=>resolve());await browser.close();await new Promise(resolve=>server.close(resolve));}
