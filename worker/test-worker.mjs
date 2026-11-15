import assert from "node:assert/strict";
import {handle, __test} from "./worker.js";

class MemoryObject {
  constructor(bytes, metadata) { this.bytes = bytes; this.httpMetadata = metadata; }
  get body() { return new Response(this.bytes).body; }
  async text() { return new TextDecoder().decode(this.bytes); }
}
class MemoryR2 {
  constructor() { this.items = new Map(); }
  async put(key, data, options = {}) { this.items.set(key, new MemoryObject(new Uint8Array(data), options.httpMetadata)); }
  async get(key) { return this.items.get(key) || null; }
  async delete(key) { this.items.delete(key); }
  async list({prefix, cursor, limit}) {
    const keys = [...this.items.keys()].filter(key => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + limit);
    return {objects: page.map(key => ({key})), truncated: start + limit < keys.length, cursor: String(start + limit)};
  }
}

const encoder = new TextEncoder();
const origin = "https://example.github.io";
const token = "test-token";
const env = {ASSETS: new MemoryR2(), ALLOWED_ORIGINS: origin, SYNC_WRITE_TOKEN: token};
const headers = (extra = {}) => ({Origin: origin, Authorization: `Bearer ${token}`, ...extra});
const sha256 = async bytes => __test.digestHex(bytes);

const svg = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>');
const svgSha = await sha256(svg);
assert.equal(__test.objectSpec(`/api/objects/assets/${svgSha}.svg`).ext, "svg");
assert.equal(__test.objectSpec(`/api/objects/assets/${svgSha}.js`), null);
const put = await handle(new Request(`https://worker.example/api/objects/assets/${svgSha}.svg`, {method: "PUT", headers: headers({"Content-Type": "image/svg+xml"}), body: svg}), env);
assert.equal(put.status, 201);
const read = await handle(new Request(`https://worker.example/api/objects/assets/${svgSha}.svg`, {headers: {Origin: origin}}), env);
assert.equal(read.status, 200);
assert.equal(read.headers.get("Content-Type"), "image/svg+xml");
assert.deepEqual(new Uint8Array(await read.arrayBuffer()), svg);
const html = encoder.encode("<!doctype html><title>safe</title><script>window.parent.postMessage('bad','*')</script>");
const htmlSha = await sha256(html);
const htmlPut = await handle(new Request(`https://worker.example/api/objects/assets/${htmlSha}.html`, {method: "PUT", headers: headers({"Content-Type": "text/html"}), body: html}), env);
assert.equal(htmlPut.status, 201);
const htmlRead = await handle(new Request(`https://worker.example/api/objects/assets/${htmlSha}.html`, {headers: {Origin: origin}}), env);
assert.equal(htmlRead.status, 200);
assert.equal(htmlRead.headers.get("Content-Security-Policy"), "sandbox");

const record = encoder.encode(JSON.stringify({kind: "asset", id: "asset-1", asset_type: "svg", name: "Circle", author: "", style: "", tags: []}));
const recordSha = await sha256(record);
await handle(new Request(`https://worker.example/api/objects/records/${recordSha}.json`, {method: "PUT", headers: headers(), body: record}), env);
const patch = await handle(new Request("https://worker.example/api/assets/asset-1", {method: "PATCH", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({author: "Alice", style: "极简", tags: ["icon"]})}), env);
assert.equal(patch.status, 200);
const assetList = await handle(new Request("https://worker.example/api/assets", {headers: {Origin: origin}}), env);
const listed = await assetList.json();
assert.equal(listed.records.length, 1);
assert.equal(listed.records[0].author, "Alice");
assert.deepEqual(listed.records[0].tags, ["icon"]);
// Deletion removes the record and unreferenced objects while preserving an
// object still referenced by another record.
const sharedBytes = encoder.encode("shared-object");
const sharedSha = await sha256(sharedBytes);
await handle(new Request(`https://worker.example/api/objects/assets/${sharedSha}.svg`, {method: "PUT", headers: headers({"Content-Type": "image/svg+xml"}), body: sharedBytes}), env);
for (const id of ["shared-a", "shared-b"]) {
  const bytes = encoder.encode(JSON.stringify({kind: "asset", id, asset_type: "svg", name: id, object_url: `assets/${sharedSha}.svg`}));
  const recordSha = await sha256(bytes);
  await handle(new Request(`https://worker.example/api/objects/records/${recordSha}.json`, {method: "PUT", headers: headers(), body: bytes}), env);
}
const deleteOne = await handle(new Request("https://worker.example/api/library", {method: "DELETE", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({items: [{kind: "asset", id: "shared-a"}]}),}), env);
assert.equal(deleteOne.status, 200);
assert.equal((await env.ASSETS.get(`assets/${sharedSha}.svg`)) !== null, true);
const deleteTwo = await handle(new Request("https://worker.example/api/library", {method: "DELETE", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({items: [{kind: "asset", id: "shared-b"}]}),}), env);
assert.equal(deleteTwo.status, 200);
assert.equal((await env.ASSETS.get(`assets/${sharedSha}.svg`)) === null, true);
// The standalone Worker shares the Pages implementation, so the encrypted
// RED repack route must exist here too (a 404 would mean the copies drifted).
const repack = await handle(new Request("https://worker.example/api/private/repack", {method: "POST", headers: {Origin: origin, "Content-Type": "application/json"}, body: "{}"}), env);
assert.equal(repack.status, 401);
assert.match((await repack.text()), /SYNC_WRITE_TOKEN/);
const options = await handle(new Request("https://worker.example/api/assets", {method: "OPTIONS", headers: {Origin: origin}}), env);
assert.equal(options.status, 204);
assert.match(options.headers.get("Access-Control-Allow-Methods") || "", /PATCH/);
assert.match(options.headers.get("Access-Control-Allow-Methods") || "", /DELETE/);
// Classification updates must work after the first R2 list page as well.
for (let index = 0; index < 205; index++) {
  const extra = encoder.encode(JSON.stringify({kind: "asset", id: `asset-extra-${String(index).padStart(3, "0")}`, asset_type: "svg", name: `Extra ${index}`, author: "", style: "", tags: []}));
  const extraSha = await sha256(extra);
  await handle(new Request(`https://worker.example/api/objects/records/${extraSha}.json`, {method: "PUT", headers: headers(), body: extra}), env);
}
const pagedPatch = await handle(new Request("https://worker.example/api/assets/asset-extra-204", {method: "PATCH", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({author: "Paged", style: "grid", tags: ["large-library"]})}), env);
assert.equal(pagedPatch.status, 200);
assert.equal((await pagedPatch.json()).item.author, "Paged");
console.log("github-pages worker tests passed");
