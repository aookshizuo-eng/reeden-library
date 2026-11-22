// 高亮规则（RED\x10 + resourceType=highlightRule）回归：
//   1) 整包只有一个加密目录、没有任何图片，浏览器扫不到图，必须由 Worker 解出
//      规则摘要后画预览，收藏库卡片不能停在「暂无预览」；
//   2) 作者和类型是两个字段：类型进标签，没填作者时显示「未填作者」，
//      绝不能拿「高亮规则」这类类型词当作者名；
//   3) 作者可以事后补，补完卡片上就是真实作者。
import assert from 'node:assert/strict';
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
const keyBytes=Uint8Array.from({length:32},(_,i)=>i+1);
const keyB64=Buffer.from(keyBytes).toString('base64');
// Reeden 的高亮规则就是一份 JSON：规则列表里带 keyword / styleColorType 和素材映射。
const rules={version:1,type:'highlightRule',name:'糕手·对话高亮',author:'',data:[
  {name:'对话',keyword:'“[^”]+”',styleType:'background',styleColorType:'brown',styleMode:'advanced'},
  {name:'段评',keyword:'（[^）]+）',styleType:'background',styleColorType:'blue',styleMode:'advanced'},
  {name:'强调',keyword:'\\*\\*[^*]+\\*\\*',styleType:'foreground',styleColorType:'#c0392b',styleMode:'simple'},
]};
const manifest=encoder.encode(JSON.stringify(rules));
// 只有加密目录，没有资源区：manifestLength 正好等于载荷长度。
const cryptoKey=await crypto.subtle.importKey('raw',keyBytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:new Uint8Array(12)},cryptoKey,manifest));
const publicHeader=encoder.encode(JSON.stringify({version:2,resourceType:'highlightRule',payloadType:'directory',containerMode:'reedenPrivate',algorithm:'aes-256-gcm-manifest',assetMode:'plain-sequential',manifestLength:sealed.length,manifestNonce:'AAAAAAAAAAAAAAAA'}));
const raw=new Uint8Array(8+publicHeader.length+sealed.length);
raw.set([0x52,0x45,0x44,0x10],0);new DataView(raw.buffer).setUint32(4,publicHeader.length,false);
raw.set(publicHeader,8);raw.set(sealed,8+publicHeader.length);
const fixture={name:'高亮规则-糕手-116对话-长条眯兔.red',mimeType:'application/octet-stream',buffer:Buffer.from(raw)};

let origin;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      const chunks=[];for await(const c of req)chunks.push(c);
      const response=await handle(new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}),{ASSETS:bucket,SYNC_WRITE_TOKEN:'test-token',ALLOWED_ORIGINS:origin,REEDEN_PRIVATE_FORMAT_KEY_B64:keyB64});
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
const read=async kind=>p.evaluate(async kind=>{
  const token=localStorage.getItem('reeden-sync-write-token');
  const response=await fetch('/api/'+kind+'s',{headers:token?{Authorization:'Bearer '+token}:{}});
  const data=await response.json().catch(()=>({}));
  return data.records||data.items||[];
},kind);
try{
  await p.goto(origin+'/reeden-library/#import',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>document.querySelector('#apiBaseStatus')?.textContent.includes('已连接共享库'),{},{timeout:20000});
  await p.locator('#unifiedInput').setInputFiles([fixture]);
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===1&&!document.querySelector('#pauseTransfer').offsetParent,{},{timeout:30000});
  await p.locator('#commitSelectedThemes').click();
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===0&&/收藏库/.test(document.querySelector('#reviewBatchStatus')?.textContent||''),{},{timeout:60000});
  const assets=await read('asset');
  const record=assets.find(item=>/高亮/.test(String(item.red_category||'')));
  assert.ok(record,'高亮规则包必须进收藏库并标成高亮');
  assert.equal(record.name,'高亮规则-糕手-116对话-长条眯兔','文件名里的类型前缀保留在名称里即可');
  assert.equal(String(record.author||''),'','没填作者时必须留空，不能拿「高亮规则」顶上');
  assert.ok(record.preview_url,`高亮规则包必须生成预览：${JSON.stringify(record)}`);

  await p.evaluate(()=>{location.hash='#assets';});
  await p.waitForFunction(()=>document.querySelectorAll('#assetList .asset-card').length===1,{},{timeout:20000});
  const preview=await p.locator('#assetList .theme-thumbnail img').first().evaluate(img=>({src:img.currentSrc||img.src,w:img.naturalWidth,h:img.naturalHeight}));
  assert.ok(preview.w>0&&preview.h>0,`预览图要真的渲染出来：${JSON.stringify(preview)}`);
  assert.ok(preview.src.includes('/previews/'),'预览必须走已上传的 previews 对象');
  const chips=await p.locator('#assetList .theme-categories em').allInnerTexts();
  assert.ok(chips.includes('高亮'),`类型标签必须存在：${chips.join(',')}`);
  assert.ok(chips.includes('未填作者'),`没作者时要给占位，不能显示类型词：${chips.join(',')}`);
  assert.equal(chips.includes('高亮规则'),false,'类型词不能出现在作者位置');

  // 作者是自己补的：补完卡片上显示真实作者。
  await p.locator('#assetList .theme-card-hit').first().click();
  await p.locator('#recordDialog input[name=author]').fill('糕手');
  await p.locator('#recordDialog button[type=submit]').click();
  await p.waitForFunction(()=>document.querySelector('#assetList').textContent.includes('糕手'),{},{timeout:15000});
  const updated=(await read('asset')).filter(item=>String(item.id)===String(record.id)).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  assert.equal(updated.author,'糕手','作者必须独立保存');
  assert.equal(updated.red_category,'高亮','改作者不能动分类');
  assert.deepEqual(errors,[]);
  console.log('PASS: 高亮规则包解出规则摘要并生成预览；类型与作者分开存，缺作者显示占位，作者可事后补。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
