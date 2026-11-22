// 私有 RED 变体（封面图集 / 高亮包）回归：
//   浏览器能读出明文图片并合成预览；Worker 只支持一种公开头，其它形态回 422。
//   这些文件必须仍能收录：保留原包、保存预览、标记为原样保存、不报错。
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
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB7sAAAAASUVORK5CYII=','base64');
const encoder=new TextEncoder();
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
// 封面图集变体：resourceType 与 Worker 已支持的 themeBundle 不同，
// 但图片仍是顺序明文——浏览器应该能预览、能原样收录。
const variant=await (async()=>{
  const theme=encoder.encode(JSON.stringify({name:'封面图集-从前慢1',author:'测试作者'}));
  const manifest=encoder.encode(JSON.stringify({version:2,payloadKind:'coverGallery',entries:[{path:'cover.jpg',offset:0,length:png.length,sha256:await sha(png)}]}));
  const header=encoder.encode(JSON.stringify({version:2,resourceType:'coverGallery',payloadType:'directory',containerMode:'reedenPrivate',algorithm:'aes-256-gcm-manifest',assetMode:'plain-sequential',manifestLength:manifest.length,manifestNonce:'AAAAAAAAAAAAAAAAAAAAAA=='}));
  const raw=new Uint8Array(8+header.length+manifest.length+theme.length+png.length);
  raw.set([0x52,0x45,0x44,0x10],0);new DataView(raw.buffer).setUint32(4,header.length,false);
  raw.set(header,8);raw.set(manifest,8+header.length);raw.set(theme,8+header.length+manifest.length);raw.set(png,8+header.length+manifest.length+theme.length);
  return {name:'封面图集-从前慢1.red',mimeType:'application/octet-stream',buffer:Buffer.from(raw)};
})();
const fixtureHeaderBytes=new DataView(variant.buffer.buffer,variant.buffer.byteOffset,variant.buffer.byteLength).getUint32(4,false);
assert.equal(new TextDecoder().decode(variant.buffer.subarray(8,8+fixtureHeaderBytes)).includes('coverGallery'),true);
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
  await p.locator('#unifiedInput').setInputFiles([variant]);
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===1&&!document.querySelector('#pauseTransfer').offsetParent,{},{timeout:30000});
  const note=await p.locator('#reviewList .review-card').innerText();
  assert.match(note,/暂不支持压缩重封/,`变体应提示原样收录：${note}`);
  assert.ok(await p.locator('#reviewList .review-card img').count(),'封面图集变体必须能读出预览图');
  await p.locator('#reviewList .commit-theme').click();
  await p.waitForFunction(()=>document.querySelectorAll('#reviewList .review-card').length===0&&document.querySelector('#reviewBatchStatus')?.textContent.includes('已保存'),{},{timeout:30000});
  const record=await p.evaluate(async()=>{
    const token=localStorage.getItem('reeden-sync-write-token');
    const response=await fetch('/api/library?kind=theme',{headers:token?{Authorization:'Bearer '+token}:{}});
    const data=await response.json().catch(()=>({}));
    return (data.records||[]).find(item=>String(item.source_name||'').includes('封面图集'));
  });
  assert.ok(record,'封面图集变体必须能收录进库');
  assert.equal(record.status,'browser_original','不支持重封的变体必须标记为原样保存');
  assert.equal(record.compression_supported,false,'不支持重封的变体不能标成可压缩');
  assert.ok(record.preview_light_url,'必须保存浏览器生成的预览');
  assert.equal(record.sha256,record.original_sha256,'原样保存时摘要应与原包一致');
  assert.ok(record.saved_to_cloud===true);
  assert.deepEqual(errors,[]);
  console.log('PASS: 封面图集/高亮等私有 RED 变体可读出预览、原样收录、状态正确且无运行时错误。');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
