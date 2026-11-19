import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {handle,__test} from '../pages/worker-api.js';
import {MemoryR2} from './test-memory-r2.mjs';
const origin='https://test.example',bucket=new MemoryR2(),env={ASSETS:bucket,SYNC_WRITE_TOKEN:'test-token',ALLOWED_ORIGINS:origin};
const raw=new TextEncoder().encode('original RED data from R2'),md5=createHash('md5').update(raw).digest('hex'),sha=await __test.digestHex(raw);
await bucket.put('originals/source.red',raw);
const headers={Origin:origin,Authorization:'Bearer test-token','Content-Type':'application/json','X-Pan123-Token':'fixture-session','X-Pan123-Folder':'','X-Pan123-Filename':encodeURIComponent('作者 - 主题.red'),'X-Pan123-Etag':md5};
for(const id of ['ready','failed']){const record={kind:'theme',id,name:'主题',author:'作者',tags:['保留'],original_md5:md5,original_sha256:sha,original_url:'/api/objects/originals/source.red'};const bytes=new TextEncoder().encode(JSON.stringify(record));await bucket.put('records/'+await __test.digestHex(bytes)+'.json',bytes);}
const make=id=>new Request(origin+'/api/backup/123',{method:'POST',headers,body:JSON.stringify({theme_id:id})});
let calls=0;const reused=async(url,options)=>{calls++;assert.ok(options.signal,'upstream request must have a deadline');return new Response(JSON.stringify({code:0,data:{InfoList:[{FileName:'作者 - 主题.red',Type:0,Size:raw.length,Etag:md5,FileId:'77'}],Next:'-1'}}),{headers:{Origin:origin,'Content-Type':'application/json'}});};
const response=await __test.backupOriginalTo123(make('ready'),env,reused);assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.reused,true);assert.equal(result.bytes,raw.length);assert.equal(result.sha256,sha);assert.equal(result.item.original_123.key,'作者 - 主题.red');assert.deepEqual(result.item.tags,['保留']);assert.equal(calls,1);
const rejected=await __test.backupOriginalTo123(make('failed'),env,async()=>new Response('{}',{status:401}));assert.equal(rejected.status,422);const failure=await rejected.json();assert.equal(failure.upstreamStatus,401);assert.ok(failure.stage);assert.ok(failure.item.original_123_error.includes('过期'));assert.deepEqual(failure.item.tags,['保留']);
assert.ok(bucket.items.has('originals/source.red'));
const before=bucket.gets;const denied=await handle(new Request(origin+'/api/backup/123',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({theme_id:'ready'})}),env);assert.equal(denied.status,401);assert.equal(bucket.gets,before);
await assert.rejects(()=>__test.backupOriginalTo123(make('missing'),env,reused),/不存在/);
const folderRequest=new Request(origin+'/api/backup/123',{method:'POST',headers:{...headers,'X-Pan123-Folder':encodeURIComponent('中文备份')},body:JSON.stringify({theme_id:'failed'})});
const folderResult=await __test.backupOriginalTo123(folderRequest,env,async()=>new Response(JSON.stringify({code:0,data:{InfoList:[{FileName:'中文备份',Type:1,FileId:9},{FileName:'作者 - 主题.red',Type:0,Size:raw.length,Etag:md5,FileId:'88'}]}})));
assert.equal(folderResult.status,200);assert.equal((await folderResult.json()).key,'中文备份/作者 - 主题.red');
const nativeFetch=globalThis.fetch;try{globalThis.fetch=reused;const routed=await handle(new Request(origin+'/api/backup/123/from-r2',{method:'POST',headers,body:JSON.stringify({theme_id:'ready'})}),env);assert.equal(routed.status,200);}finally{globalThis.fetch=nativeFetch;}
const saved=JSON.parse(await (await bucket.get('system/library-v1.json')).text());assert.equal(saved.records.find(item=>item.id==='ready').original_123.fileId,'77');assert.ok(saved.records.find(item=>item.id==='failed').original_123.key);assert.ok(!JSON.stringify(saved).includes('fixture-session'));
console.log('PASS: small JSON request backs up existing R2 source; provider verification; backup result persisted without losing tags; real platform status preserved; private auth; no stored session secrets.');
