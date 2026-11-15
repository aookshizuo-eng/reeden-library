import assert from "node:assert/strict";
import {createHash} from "node:crypto";
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

// Persistent upload progress: any device can read and update the same job.
const jobsUrl = "https://worker.example/api/jobs";
const created = await handle(new Request(jobsUrl, {method: "POST", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({kind: "upload", title: "后台批量上传", total: 3, items: ["a.red"], device: "desktop"})}), env);
assert.equal(created.status, 201);
const job = (await created.json()).job;
assert.equal(job.status, "queued");
const jobsList = await handle(new Request(jobsUrl, {headers: {Origin: origin}}), env);
assert.equal((await jobsList.json()).items.some(item => item.id === job.id), true);
const patched = await handle(new Request(`${jobsUrl}/${job.id}`, {method: "PATCH", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({status: "running", stage: "上传压缩包", completed: 2, total: 3})}), env);
assert.equal((await patched.json()).job.stage, "上传压缩包");
const jobsAfter = await (await handle(new Request(jobsUrl, {headers: {Origin: origin}}), env)).json();
assert.equal(jobsAfter.items.find(item => item.id === job.id).completed, 2);
const jobUnauthorized = await handle(new Request(jobsUrl, {method: "POST", headers: {Origin: origin, "Content-Type": "application/json"}, body: "{}"}), env);
assert.equal(jobUnauthorized.status, 401);
const removed = await handle(new Request(`${jobsUrl}/${job.id}`, {method: "DELETE", headers: headers()}), env);
assert.equal(removed.status, 200);

// Raw staging objects let a device queue an upload that another device resumes.
const staged = encoder.encode("queued raw theme bytes");
const stagedSha = await sha256(staged);
assert.equal(__test.objectSpec(`/api/objects/staging/${stagedSha}.red`).kind, "staging");
const stagedPut = await handle(new Request(`https://worker.example/api/objects/staging/${stagedSha}.red`, {method: "PUT", headers: headers(), body: staged}), env);
assert.equal(stagedPut.status, 201);
assert.equal((await handle(new Request(`https://worker.example/api/objects/staging/${stagedSha}.red`, {headers: {Origin: origin}}), env)).status, 200);

// New private endpoints must be authentication-gated in the shared Worker.
for (const path of ["/api/private/directory", "/api/private/seal"]) {
  const denied = await handle(new Request(`https://worker.example${path}`, {method: "POST", headers: {Origin: origin, "Content-Type": "application/json"}, body: "{}"}), env);
  assert.equal(denied.status, 401);
}
// 123 web-protocol backup: no credentials are stored server-side and the
// presigned transfer URL never receives the account token.
const backupBytes = encoder.encode("original theme package bytes");
const etag = createHash("md5").update(backupBytes).digest("hex");
let listCalls = 0;
const calls = [];
const backupFetch = async (url, init = {}) => {
  const href = String(url);
  const path = new URL(href).pathname;
  calls.push({path, method: init.method || "GET", auth: init.headers?.Authorization || "", tokenHeader: init.headers?.["X-Pan123-Token"] || ""});
  if (href.includes("upload.example.com")) return new Response(null, {status: 200});
  let data = {};
  if (path === "/b/api/file/list/new") {
    listCalls++;
    data = listCalls === 1 ? {InfoList: []} : {InfoList: [{FileName: "probe.red", Type: 0, Size: backupBytes.length, Etag: etag, FileId: "42"}]};
  } else if (path === "/b/api/file/upload_request") {
    data = {Reuse: false, Bucket: "bucket", Key: "key", StorageNode: "node", FileId: "42", UploadId: "upload"};
  } else if (path === "/b/api/file/s3_upload_object/auth") {
    data = {presignedUrls: {"1": "https://upload.example.com/part1"}};
  } else if (path === "/b/api/file/upload_complete/v2") {
    data = {file_info: {FileId: "42"}};
  }
  return new Response(JSON.stringify({code: 0, data}), {status: 200, headers: {"Content-Type": "application/json"}});
};
const backupHeaders = headers({
  "Content-Type": "application/octet-stream", "X-Pan123-Token": "device-session-token",
  "X-Pan123-Folder": "", "X-Pan123-Filename": "probe.red", "X-Pan123-Etag": etag,
});
const backupRequest = new Request("https://worker.example/api/backup/123", {method: "POST", headers: backupHeaders, body: backupBytes});
const backup = await __test.backupOriginalTo123(backupRequest, env, backupFetch);
assert.equal(backup.status, 200);
const backupResult = await backup.json();
assert.equal(backupResult.provider, "123pan");
assert.equal(backupResult.bytes, backupBytes.length);
assert.equal(calls.filter(call => call.path.includes("/b/api/") && call.auth === "Bearer device-session-token").length > 0, true);
assert.equal(calls.some(call => call.path === "/part1" && !call.auth && !call.tokenHeader), true);
const backupUnauthorized = await __test.backupOriginalTo123(new Request("https://worker.example/api/backup/123", {method: "POST", headers: {Origin: origin, "Content-Type": "application/octet-stream", "X-Pan123-Token": "device-session-token", "X-Pan123-Filename": "probe.red", "X-Pan123-Etag": etag}, body: backupBytes}), env, backupFetch);
assert.equal(backupUnauthorized.status, 401);
const cors = __test.corsHeaders(new Request("https://worker.example/api/backup/123", {headers: {Origin: origin}}), env);
assert.match(cors["Access-Control-Allow-Headers"] || "", /X-Pan123-Token/);
// Batch download: the Worker builds a Stored ZIP straight from R2, so the
// browser never has to fetch 50 MB of fonts into JS memory and deflate them
// again. Verify the archive byte-for-byte, including the manifest.
const dlEnv = {ASSETS: new MemoryR2(), ALLOWED_ORIGINS: origin, SYNC_WRITE_TOKEN: token};
const dlFontA = encoder.encode("font-A-bytes"), dlPreviewA = encoder.encode("preview-A-jpeg");
const dlFontB = encoder.encode("font-B-bytes"), dlPreviewB = encoder.encode("preview-B-jpeg");
const [faSha, paSha, fbSha, pbSha] = await Promise.all([dlFontA, dlPreviewA, dlFontB, dlPreviewB].map(sha256));
const dlPut = async (path, bytes) => {
  const result = await handle(new Request(`https://worker.example/api/objects/${path}`, {method: "PUT", headers: headers({"Content-Type": "application/octet-stream"}), body: bytes}), dlEnv);
  assert.equal(result.status, 201, `PUT ${path}`);
};
await dlPut(`fonts/${faSha}.ttf`, dlFontA);
await dlPut(`fonts/${fbSha}.ttf`, dlFontB);
await dlPut(`previews/${paSha}.jpg`, dlPreviewA);
await dlPut(`previews/${pbSha}.jpg`, dlPreviewB);
const dlRecord = async (id, file, fontSha, previewSha) => {
  const bytes = encoder.encode(JSON.stringify({kind: "font", id, file_name: file, family: file, extension: "ttf",
    url: `/api/objects/fonts/${fontSha}.ttf`, preview_url: `/api/objects/previews/${previewSha}.jpg`, updated_at: "2026-11-15T00:00:00.000Z"}));
  await dlPut(`records/${await sha256(bytes)}.json`, bytes);
};
await dlRecord("font-dl-a", "Alpha.ttf", faSha, paSha);
await dlRecord("font-dl-b", "Beta.ttf", fbSha, pbSha);
const dlBase = "https://worker.example/api/download?kind=font&ids=font-dl-a,font-dl-b";
const dlProbe = await handle(new Request(`${dlBase}&probe=1`, {headers: {Origin: origin}}), dlEnv);
assert.equal(dlProbe.status, 200);
assert.equal((await dlProbe.json()).count, 4);
const dlBadKind = await handle(new Request("https://worker.example/api/download?kind=nope&ids=font-dl-a", {headers: {Origin: origin}}), dlEnv);
assert.equal(dlBadKind.status, 400);
const dlMissing = await handle(new Request("https://worker.example/api/download?kind=font&ids=does-not-exist", {headers: {Origin: origin}}), dlEnv);
assert.equal(dlMissing.status, 404);
const dlForbidden = await handle(new Request(dlBase, {headers: {Origin: "https://evil.example"}}), dlEnv);
assert.equal(dlForbidden.status, 403);
const dlResponse = await handle(new Request(dlBase, {headers: {Origin: origin}}), dlEnv);
assert.equal(dlResponse.status, 200);
assert.equal(dlResponse.headers.get("Content-Type"), "application/zip");
assert.match(dlResponse.headers.get("Content-Disposition") || "", /^attachment; filename=/);
const zipBytes = new Uint8Array(await dlResponse.arrayBuffer());
const u16 = at => zipBytes[at] | (zipBytes[at + 1] << 8);
const u32 = at => (zipBytes[at] | (zipBytes[at + 1] << 8) | (zipBytes[at + 2] << 16) | (zipBytes[at + 3] << 24)) >>> 0;
let eocd = -1;
for (let at = zipBytes.length - 22; at >= 0; at--) if (zipBytes[at] === 0x50 && zipBytes[at + 1] === 0x4b && zipBytes[at + 2] === 0x05 && zipBytes[at + 3] === 0x06) { eocd = at; break; }
assert.notEqual(eocd, -1, "ZIP 缺少 End Of Central Directory");
assert.equal(u16(eocd + 8), u16(eocd + 10), "ZIP 中央目录条目数不一致");
assert.equal(u32(eocd + 12) + u32(eocd + 16), eocd, "ZIP 中央目录偏移不正确");
const extracted = new Map();
let centralAt = u32(eocd + 16);
for (let index = 0; index < u16(eocd + 10); index++) {
  assert.equal(u32(centralAt), 0x02014b50, "ZIP 中央目录签名错误");
  assert.equal(u16(centralAt + 10), 0, "批量下载应使用 Stored 条目，不应二次压缩");
  const crc = u32(centralAt + 16), size = u32(centralAt + 20), nameLen = u16(centralAt + 28);
  const extraLen = u16(centralAt + 30), commentLen = u16(centralAt + 32), localAt = u32(centralAt + 42);
  const name = new TextDecoder().decode(zipBytes.subarray(centralAt + 46, centralAt + 46 + nameLen));
  assert.equal(u32(localAt), 0x04034b50, `ZIP 本地头无效：${name}`);
  const dataAt = localAt + 30 + u16(localAt + 26) + u16(localAt + 28);
  const data = zipBytes.subarray(dataAt, dataAt + size);
  assert.equal(__test.crc32Bytes(data), crc, `ZIP CRC 校验失败：${name}`);
  extracted.set(name, new TextDecoder().decode(data));
  centralAt += 46 + nameLen + extraLen + commentLen;
}
assert.equal(extracted.size, 5, "ZIP 应含 2 个字体 + 2 个预览 + manifest.json");
assert.equal(extracted.get("font/Alpha.ttf"), "font-A-bytes");
assert.equal(extracted.get("font/Beta.ttf"), "font-B-bytes");
assert.equal(extracted.get("font/Alpha.preview.jpg"), "preview-A-jpeg");
assert.equal(extracted.get("font/Beta.preview.jpg"), "preview-B-jpeg");
const dlManifest = JSON.parse(extracted.get("manifest.json"));
assert.equal(dlManifest.files.length, 4);
assert.equal(dlManifest.kind, "font");
// A missing object is reported inside the archive instead of aborting the
// whole download; the remaining files stay usable.
const ghostSha = "f".repeat(64);
const ghostRecord = encoder.encode(JSON.stringify({kind: "font", id: "font-dl-ghost", file_name: "Ghost.ttf", extension: "ttf",
  url: `/api/objects/fonts/${ghostSha}.ttf`, updated_at: "2026-11-15T00:00:00.000Z"}));
await dlPut(`records/${await sha256(ghostRecord)}.json`, ghostRecord);
const ghostResponse = await handle(new Request(`https://worker.example/api/download?kind=font&ids=font-dl-a,font-dl-ghost`, {headers: {Origin: origin}}), dlEnv);
assert.equal(ghostResponse.status, 200);
const ghostZip = new Uint8Array(await ghostResponse.arrayBuffer());
assert.equal(new TextDecoder().decode(ghostZip).includes("__errors.json"), true);
assert.equal(new TextDecoder().decode(ghostZip).includes("font-dl-ghost"), true);
console.log("github-pages worker tests passed");
