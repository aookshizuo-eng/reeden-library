import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {handle, __test} from "../pages/worker-api.js";
const codec = createRequire(import.meta.url)("../site/free_codec.js");
const encoder = new TextEncoder();
class MemoryR2 {
  items = new Map(); gets = 0; lists = 0;
  async put(key, value, options={}) {
    const bytes = new Uint8Array(value);
    this.items.set(key,{body:bytes,text:async()=>new TextDecoder().decode(bytes),httpMetadata:options.httpMetadata});
  }
  async get(key) { this.gets++; return this.items.get(key); }
  async list({prefix,cursor,limit}) {
    this.lists++;
    const keys=[...this.items.keys()].filter(key=>key.startsWith(prefix)).sort();
    const start=Number(cursor||0);
    return {objects:keys.slice(start,start+limit).map(key=>({key})),truncated:start+limit<keys.length,cursor:String(start+limit)};
  }
  async delete(key) { this.items.delete(key); }
}
const bucket=new MemoryR2();
const env={ASSETS:bucket,SYNC_WRITE_TOKEN:"test-token",ALLOWED_ORIGINS:"https://app.example"};
const headers={Origin:"https://app.example",Authorization:"Bearer test-token","Content-Type":"application/json"};
let target;
for(let i=0;i<250;i++){
  const record={kind:"theme",id:"theme"+i,name:"作品"+i,author:"作者",style:"清爽",tags:["原标签"],categories:["浅色"]};
  const bytes=encoder.encode(JSON.stringify(record)),sha=await __test.digestHex(bytes);
  await bucket.put(`records/${sha}.json`,bytes);
  if(i===249)target={...record,record_sha256:sha};
}
const denied=await handle(new Request("https://app.example/api/session"),env);
assert.equal(denied.status,401);
const allowed=await handle(new Request("https://app.example/api/session",{headers}),env);
assert.equal((await allowed.json()).canWrite,true);
const listing=await handle(new Request("https://app.example/api/library"),env);
assert.ok((await listing.json()).records.every(item=>/^[a-f0-9]{64}$/.test(item.record_sha256)));
bucket.gets=bucket.lists=0;
const edit=await handle(new Request("https://app.example/api/themes/theme249",{method:"PATCH",headers,body:JSON.stringify({record_sha256:target.record_sha256,tags:["新标签"]})}),env);
assert.equal(edit.status,200);
const updated=(await edit.json()).item;
assert.equal(bucket.lists,0,"an edit must not list the whole library");
assert.equal(bucket.gets,1,"an edit reads only its target");
assert.equal(updated.author,"作者");
assert.equal(updated.style,"清爽");
assert.deepEqual(updated.categories,["浅色"]);
assert.deepEqual(updated.tags,["新标签"]);
const stale=await handle(new Request("https://app.example/api/themes/theme249",{method:"PATCH",headers,body:JSON.stringify({record_sha256:target.record_sha256,name:"过期版本"})}),env);
assert.equal(stale.status,409);
const wrong=await handle(new Request("https://app.example/api/fonts/theme249",{method:"PATCH",headers,body:JSON.stringify({record_sha256:updated.record_sha256,tags:[]})}),env);
assert.equal(wrong.status,409);
const red=await codec.writeZipEntries([{name:"theme.json",bytes:encoder.encode("{}")}],{store:true});
const zip=(await codec.writeZipEntries([
  {name:"字体/阅读体.ttf",bytes:encoder.encode("font-content")},
  {name:"主题/晴天.red",bytes:red},
  {name:"说明.txt",bytes:encoder.encode("do not import")},
],{store:true})).subarray(4);
const extracted=await codec.readZipEntries(zip,{standardZip:true,filter:name=>/\.(ttf|red)$/i.test(name)});
assert.deepEqual(extracted.map(item=>item.name),["字体/阅读体.ttf","主题/晴天.red"]);
assert.deepEqual(extracted[1].bytes,red);
assert.equal((await codec.readZipEntries(red)).length,1);
const unsafe=(await codec.writeZipEntries([{name:"../bad.ttf",bytes:encoder.encode("x")}],{store:true})).subarray(4);
await assert.rejects(()=>codec.readZipEntries(unsafe,{standardZip:true}),/路径不安全/);
const damaged=zip.slice();damaged[Buffer.from(zip).indexOf("font-content")]^=1;
await assert.rejects(()=>codec.readZipEntries(damaged,{standardZip:true}));
console.log("maintenance tests: write permissions, single-record edit, stale version, preserved fields, ZIP/RED, traversal and integrity passed");

