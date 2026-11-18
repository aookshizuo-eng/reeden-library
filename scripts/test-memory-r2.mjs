import {createHash} from 'node:crypto';
export class MemoryR2 {
  items=new Map();gets=0;lists=0;readKeys=[];
  async put(key,data,options={}) {
    const previous=this.items.get(key),condition=options.onlyIf;
    if(condition?.etagMatches && previous?.etag!==condition.etagMatches)return null;
    if(condition?.etagDoesNotMatch==='*'&&previous)return null;
    const bytes=typeof data==='string'?new TextEncoder().encode(data):new Uint8Array(data);
    const item={key,bytes,size:bytes.length,etag:createHash('sha256').update(bytes).digest('hex'),uploaded:new Date(),httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{},get body(){return new Response(bytes).body;},text:async()=>new TextDecoder().decode(bytes)};
    this.items.set(key,item);return item;
  }
  async get(key,options={}){
    this.gets++;this.readKeys.push(key);const item=this.items.get(key);if(!item)return null;
    const etag='"'+item.etag+'"';
    if(options.onlyIf?.get?.('If-None-Match')===etag){const {body,...metadata}=item;return metadata;}
    if(options.range){const {offset,length}=options.range,bytes=item.bytes.slice(offset,offset+length);return {...item,range:options.range,get body(){return new Response(bytes).body;}};}
    return item;
  }
  async head(key){return this.items.get(key)||null;}
  async delete(key){for(const value of Array.isArray(key)?key:[key])this.items.delete(value);}
  async list({prefix='',cursor,limit=1000}={}){this.lists++;const keys=[...this.items.keys()].filter(key=>key.startsWith(prefix)).sort(),start=Number(cursor||0);return {objects:keys.slice(start,start+limit).map(key=>{const x=this.items.get(key);return {key,size:x.size,etag:x.etag,uploaded:x.uploaded};}),truncated:start+limit<keys.length,cursor:String(start+limit)};}
}
