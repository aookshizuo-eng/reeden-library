import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {handle, __test} from "./worker.js";

import {MemoryR2} from "../scripts/test-memory-r2.mjs";

const encoder = new TextEncoder();
const origin = "https://example.github.io";
const token = "test-token";
const env = {ASSETS: new MemoryR2(), ALLOWED_ORIGINS: origin, PRIVATE_LIBRARY:false, SYNC_WRITE_TOKEN: token};
const headers = (extra = {}) => ({Origin: origin, Authorization: `Bearer ${token}`, ...extra});
const sha256 = async bytes => __test.digestHex(bytes);

const svg = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>');
const svgSha = await sha256(svg);
assert.equal(__test.objectSpec(`/api/objects/assets/${svgSha}.svg`).ext, "svg");
assert.equal(__test.objectSpec(`/api/objects/assets/${svgSha}.js`), null);
// Readable keys: `<label>~<sha>.<ext>` so the R2 dashboard names objects after
// the theme instead of a bare hash. Integrity and traversal rules still apply.
const labeledSpec = __test.objectSpec(`/api/objects/assets/${encodeURIComponent(`图标-压缩~${svgSha}.svg`)}`);
assert.equal(labeledSpec.sha, svgSha);
assert.equal(labeledSpec.label, "图标-压缩");
assert.equal(labeledSpec.key, `assets/图标-压缩~${svgSha}.svg`);
assert.equal(__test.objectSpec(`/api/objects/assets/${encodeURIComponent(`坏~../~${svgSha}.svg`)}`), null);
assert.equal(__test.objectSpec(`/api/objects/assets/${encodeURIComponent("名字~1234.svg")}`), null);
// New keys are just the readable name; the digest rides in X-Content-SHA256.
const plainSpec = __test.objectSpec(`/api/objects/compressed/${encodeURIComponent("少女心事-压缩.red")}`);
assert.equal(plainSpec.sha, null);
assert.equal(plainSpec.key, "compressed/少女心事-压缩.red");
assert.equal(__test.objectSpec(`/api/objects/assets/${encodeURIComponent("~x.svg")}`), null);
const plainPath = `/api/objects/assets/${encodeURIComponent("图标-压缩.svg")}`;
const plainPut = await handle(new Request(`https://worker.example${plainPath}`, {method: "PUT", headers: headers({"Content-Type": "image/svg+xml", "X-Content-SHA256": svgSha}), body: svg}), env);
assert.equal(plainPut.status, 201);
assert.equal((await plainPut.json()).filename, "图标-压缩.svg");
assert.equal((await env.ASSETS.get("assets/图标-压缩.svg")).customMetadata.sha256, svgSha);
// Identical bytes reuse the same key instead of piling up copies.
const repeat = await handle(new Request(`https://worker.example${plainPath}`, {method: "PUT", headers: headers({"Content-Type": "image/svg+xml", "X-Content-SHA256": svgSha}), body: svg}), env);
assert.equal((await repeat.json()).filename, "图标-压缩.svg");
// A different pack with the same name must not overwrite the first one.
const otherSvg = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="6" r="3"/></svg>');
const otherSha = await sha256(otherSvg);
const clash = await handle(new Request(`https://worker.example${plainPath}`, {method: "PUT", headers: headers({"Content-Type": "image/svg+xml", "X-Content-SHA256": otherSha}), body: otherSvg}), env);
assert.equal((await clash.json()).filename, "图标-压缩-2.svg");
// A declared digest that does not match the body is rejected.
const mismatch = await handle(new Request(`https://worker.example${plainPath}`, {method: "PUT", headers: headers({"Content-Type": "image/svg+xml", "X-Content-SHA256": otherSha}), body: svg}), env);
assert.equal(mismatch.status, 400);
const put = await handle(new Request(`https://worker.example/api/objects/assets/${svgSha}.svg`, {method: "PUT", headers: headers({"Content-Type": "image/svg+xml"}), body: svg}), env);
assert.equal(put.status, 201);
const read = await handle(new Request(`https://worker.example/api/objects/assets/${svgSha}.svg`, {headers: {Origin: origin}}), env);
assert.equal(read.status, 200);
assert.equal(read.headers.get("Content-Type"), "image/svg+xml");
assert.deepEqual(new Uint8Array(await read.arrayBuffer()), svg);
const labeledPath = `/api/objects/assets/${encodeURIComponent(`图标-压缩~${svgSha}.svg`)}`;
const labeledPut = await handle(new Request(`https://worker.example${labeledPath}`, {method: "PUT", headers: headers({"Content-Type": "image/svg+xml"}), body: svg}), env);
assert.equal(labeledPut.status, 201);
assert.equal((await labeledPut.json()).key, `assets/图标-压缩~${svgSha}.svg`);
const labeledRead = await handle(new Request(`https://worker.example${labeledPath}`, {headers: {Origin: origin}}), env);
assert.equal(labeledRead.status, 200);
assert.equal(labeledRead.headers.get("Content-Disposition"), null);
assert.deepEqual(new Uint8Array(await labeledRead.arrayBuffer()), svg);
// Download links add `?download=1`: WebView only invokes DownloadListener for
// attachment responses, so a plain object GET must stay inline for previews.
const labeledDownload = await handle(new Request(`https://worker.example${labeledPath}?download=1`, {headers: {Origin: origin}}), env);
assert.equal(labeledDownload.status, 200);
assert.match(labeledDownload.headers.get("Content-Disposition") || "", /^attachment; filename="[^"\r\n]+"; filename\*=UTF-8''/);
assert.ok((labeledDownload.headers.get("Content-Disposition") || "").includes(encodeURIComponent(`图标-压缩~${svgSha}.svg`)));
assert.deepEqual(new Uint8Array(await labeledDownload.arrayBuffer()), svg);
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
// 入库后改名：PATCH 带 name 时更新展示名；不带 name 时保留原名。
const renamed = await handle(new Request("https://worker.example/api/assets/asset-1", {method: "PATCH", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({name: "Circle 改名", author: "Alice", style: "极简", tags: ["icon"]})}), env);
assert.equal(renamed.status, 200);
assert.equal((await renamed.json()).item.name, "Circle 改名");
const keptName = await handle(new Request("https://worker.example/api/assets/asset-1", {method: "PATCH", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({author: "Alice", style: "极简", tags: ["icon"]})}), env);
assert.equal((await keptName.json()).item.name, "Circle 改名");
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
assert.equal((await env.ASSETS.get(`assets/${sharedSha}.svg`)) !== null, true,"soft deletion retains bytes until reviewed cleanup");
// New uploads use readable object names, including Chinese and URL escapes.
for (const key of ['assets/共享图标.svg', 'assets/仅此一份.html']) await env.ASSETS.put(key, encoder.encode('named-object'));
for (const id of ['named-a', 'named-b']) {
  const item = {kind:'asset', id, object_url:'https://worker.example/api/objects/assets/'+encodeURIComponent('共享图标.svg')};
  if (id === 'named-a') item.preview_url = '/api/objects/assets/'+encodeURIComponent('仅此一份.html');
  const data = encoder.encode(JSON.stringify(item));await handle(new Request('https://worker.example/api/objects/records/'+await sha256(data)+'.json',{method:'PUT',headers:headers(),body:data}),env);
}
for (const id of ['named-a','named-b']) {
  const deleted = await handle(new Request('https://worker.example/api/library',{method:'DELETE',headers:headers({'Content-Type':'application/json'}),body:JSON.stringify({items:[{kind:'asset',id}]})}),env);
  assert.equal(deleted.status,200);
  assert.notEqual(await env.ASSETS.get('assets/共享图标.svg'),null,'bytes remain until reviewed cleanup');
  assert.notEqual(await env.ASSETS.get('assets/仅此一份.html'),null,'unshared named objects are deferred for review');
}
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
const patches = await (await handle(new Request(`${jobsUrl}/${job.id}`, {method: "PATCH", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({status: "running", stage: "上传压缩包", completed: 2, total: 3})}), env)).json();
assert.equal(patches.job.stage, "上传压缩包");
const jobsAfter = await (await handle(new Request(jobsUrl, {headers: {Origin: origin}}), env)).json();
assert.equal(jobsAfter.items.find(item => item.id === job.id).completed, 2);
// A staged batch remembers that the user accepted "process later", so the next
// page load may finish compression without a second confirmation.
const stagedJob = (await (await handle(new Request(jobsUrl, {method: "POST", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({kind: "staged-import", title: "暂存 1 个文件", total: 1, items: ["a.red"], source_keys: ["staging/x.red"], auto_commit: true})}), env)).json()).job;
assert.equal(stagedJob.auto_commit, true);
const plainJob = (await (await handle(new Request(jobsUrl, {method: "POST", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({kind: "upload", title: "普通上传"})}), env)).json()).job;
assert.equal(plainJob.auto_commit, false);
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
// Finished batches must be able to drop their staged raw copies again.
const stagedDeleteDenied = await handle(new Request(`https://worker.example/api/objects/staging/${stagedSha}.red`, {method: "DELETE", headers: {Origin: origin}}), env);
assert.equal(stagedDeleteDenied.status, 401);
const stagedDeleted = await handle(new Request(`https://worker.example/api/objects/staging/${stagedSha}.red`, {method: "DELETE", headers: headers()}), env);
assert.equal(stagedDeleted.status, 200);
assert.equal((await stagedDeleted.json()).deleted, `staging/${stagedSha}.red`);
assert.equal((await handle(new Request(`https://worker.example/api/objects/staging/${stagedSha}.red`, {headers: {Origin: origin}}), env)).status, 404);
// Library objects are only removable through the record delete route.
const compressedDelete = await handle(new Request(`https://worker.example/api/objects/compressed/${stagedSha}.red`, {method: "DELETE", headers: headers()}), env);
assert.equal(compressedDelete.status, 404);

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
// Chinese theme names must travel percent-encoded: header values are
// ISO-8859-1 only, so the browser would throw while constructing Headers.
assert.equal(__test.headerText(encodeURIComponent("Muiii - 雪一片一片.red")), "Muiii - 雪一片一片.red");
assert.equal(__test.headerText(encodeURIComponent("备份目录")), "备份目录");
assert.equal(__test.headerText("probe.red"), "probe.red");
assert.equal(__test.headerText("%%%"), "%%%");
assert.equal(__test.headerText(null, "fallback"), "fallback");
const cnBytes = encoder.encode("chinese theme package bytes");
const cnEtag = createHash("md5").update(cnBytes).digest("hex");
const cnName = "Muiii - 雪一片一片.red";
const cnFolder = "Red-Garden-Backup";
const cnFetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  if (String(url).includes("upload.example.com")) return new Response(null, {status: 200});
  let data = {};
  if (path === "/b/api/file/list/new") {
    data = {InfoList: [
      {FileName: cnFolder, Type: 1, FileId: "9"},
      {FileName: cnName, Type: 0, Size: cnBytes.length, Etag: cnEtag, FileId: "77"},
    ]};
  }
  return new Response(JSON.stringify({code: 0, data}), {status: 200, headers: {"Content-Type": "application/json"}});
};
const cnBackup = await __test.backupOriginalTo123(new Request("https://worker.example/api/backup/123", {
  method: "POST",
  headers: headers({"Content-Type": "application/octet-stream", "X-Pan123-Token": "device-session-token",
    "X-Pan123-Folder": encodeURIComponent(cnFolder), "X-Pan123-Filename": encodeURIComponent(cnName), "X-Pan123-Etag": cnEtag}),
  body: cnBytes,
}), env, cnFetch);
assert.equal(cnBackup.status, 200);
const cnResult = await cnBackup.json();
assert.equal(cnResult.key, `${cnFolder}/${cnName}`);
assert.equal(cnResult.reused, true);
// "测试连接" is strictly read-only: no upload_request, no probe file, no new folder.
const verifyCalls = [];
const verifyFetch = async (url, init = {}) => {
  const p = new URL(String(url)).pathname;
  verifyCalls.push({path: p, method: init.method || "GET", auth: init.headers?.Authorization || ""});
  let data = {};
  if (p === "/b/api/file/list/new") data = {InfoList: [{FileName: "Red-Garden-Backup", Type: 1, FileId: "9"}]};
  else if (p === "/b/api/user/info") data = {Nickname: "测试用户"};
  return new Response(JSON.stringify({code: 0, data}), {status: 200, headers: {"Content-Type": "application/json"}});
};
// 网页端账号密码登录：密码只在这一跳里出现，响应只回会话 Token。
const loginCalls = [];
const loginFetch = async (url, init = {}) => {
  const u = new URL(String(url));
  loginCalls.push({host: u.host, path: u.pathname, body: init.body});
  if (u.pathname === "/api/user/sign_in") return new Response(JSON.stringify({code: 200, data: {token: "jwt-session"}}), {status: 200, headers: {"Content-Type": "application/json"}});
  if (u.pathname === "/b/api/user/info") return new Response(JSON.stringify({code: 0, data: {Nickname: "测试用户"}}), {status: 200, headers: {"Content-Type": "application/json"}});
  return new Response("{}", {status: 200, headers: {"Content-Type": "application/json"}});
};
const loginRequest = new Request("https://worker.example/api/storage/123/login", {method: "POST", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({username: "13800000000", password: "secret"})});
const login = await __test.loginPan123(loginRequest, env, loginFetch);
assert.equal(login.status, 200);
const loginResult = await login.json();
assert.equal(loginResult.ok, true);
assert.equal(loginResult.token, "jwt-session");
assert.equal(loginResult.nickname, "测试用户");
const signInCall = () => loginCalls.filter(call => call.path === "/api/user/sign_in").pop();
assert.equal(signInCall().host, "login.123pan.com");
assert.deepEqual(JSON.parse(signInCall().body), {passport: "13800000000", password: "secret", remember: true});
const mailLogin = await __test.loginPan123(new Request("https://worker.example/api/storage/123/login", {method: "POST", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({username: "a@b.com", password: "x"})}), env, loginFetch);
assert.equal(mailLogin.status, 200);
assert.deepEqual(JSON.parse(signInCall().body), {mail: "a@b.com", password: "x", type: 2});
const badLoginFetch = async () => new Response(JSON.stringify({code: 1, message: "账号或密码错误"}), {status: 200, headers: {"Content-Type": "application/json"}});
const badLogin = await __test.loginPan123(new Request("https://worker.example/api/storage/123/login", {method: "POST", headers: headers({"Content-Type": "application/json"}), body: JSON.stringify({username: "13800000000", password: "x"})}), env, badLoginFetch);
assert.equal(badLogin.status, 422);
assert.equal((await badLogin.json()).error, "账号或密码错误");
const loginDenied = await __test.loginPan123(new Request("https://worker.example/api/storage/123/login", {method: "POST", headers: {Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify({username: "a", password: "b"})}), env, loginFetch);
assert.equal(loginDenied.status, 401);
const verifyRequest = new Request("https://worker.example/api/backup/123/verify", {method: "POST", headers: headers({"X-Pan123-Token": "device-session-token", "X-Pan123-Folder": "Red-Garden-Backup"})});
const verified = await __test.verifyPan123(verifyRequest, env, verifyFetch);
assert.equal(verified.status, 200);
const verifyResult = await verified.json();
assert.equal(verifyResult.connected, true);
assert.equal(verifyResult.folderExists, true);
assert.equal(verifyResult.rootItems, 1);
assert.equal(verifyResult.nickname, "测试用户");
assert.equal(verifyCalls.some(call => call.path.includes("upload_request")), false);
assert.equal(verifyCalls.every(call => call.auth === "Bearer device-session-token"), true);
const verifyDenied = await handle(new Request("https://worker.example/api/backup/123/verify", {method: "POST", headers: {Origin: origin, "X-Pan123-Token": "device-session-token"}}), env);
assert.equal(verifyDenied.status, 401);
const verifyNoToken = await __test.verifyPan123(new Request("https://worker.example/api/backup/123/verify", {method: "POST", headers: headers()}), env, verifyFetch);
assert.equal(verifyNoToken.status, 400);
// The backup inventory is read-only, auth-gated and reconciles with library records.
const inventoryCalls = [];
const inventoryFetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const parent = u.searchParams.get("parentFileId");
  inventoryCalls.push({path: u.pathname, parent, auth: init.headers?.Authorization || ""});
  let data = {};
  if (u.pathname === "/b/api/file/list/new" && parent === "0") data = {InfoList: [{FileName: "Red-Garden-Backup", Type: 1, FileId: "9"}], Next: "-1"};
  else if (u.pathname === "/b/api/file/list/new" && parent === "9") data = {InfoList: [
    {FileName: "theme-a.red", Type: 0, Size: 1024, Etag: "abc", FileId: "101", CreateTime: "2026-11-16T00:00:00+08:00"},
    {FileName: "probes", Type: 1, Size: 131072, FileId: "102"},
  ], Next: "-1"};
  return new Response(JSON.stringify({code: 0, data}), {status: 200, headers: {"Content-Type": "application/json"}});
};
const inventoryRequest = new Request("https://worker.example/api/backup/123/list", {method: "POST", headers: headers({"X-Pan123-Token": "device-session-token", "X-Pan123-Folder": "Red-Garden-Backup"})});
const inventory = await __test.listPan123Backups(inventoryRequest, env, inventoryFetch);
assert.equal(inventory.status, 200);
const inv = await inventory.json();
assert.equal(inv.ok, true);
assert.equal(inv.folderExists, true);
assert.equal(inv.items.length, 2);
assert.equal(inv.fileCount, 1);
assert.equal(inv.totalBytes, 1024);
assert.equal(inv.items[0].name, "theme-a.red");
assert.equal(inv.items[0].type, "file");
assert.equal(inv.items[1].type, "folder");
assert.equal(inventoryCalls.some(call => call.path.includes("upload_request")), false);
assert.equal(inventoryCalls.every(call => call.auth === "Bearer device-session-token"), true);
const inventoryDenied = await handle(new Request("https://worker.example/api/backup/123/list", {method: "POST", headers: {Origin: origin, "X-Pan123-Token": "device-session-token"}}), env);
assert.equal(inventoryDenied.status, 401);
const emptyInventoryFetch = async () => new Response(JSON.stringify({code: 0, data: {InfoList: [], Next: "-1"}}), {status: 200, headers: {"Content-Type": "application/json"}});
const emptyInventory = await __test.listPan123Backups(inventoryRequest, env, emptyInventoryFetch);
assert.equal(emptyInventory.status, 200);
assert.equal((await emptyInventory.json()).folderExists, false);
// Batch download: the Worker builds a Stored ZIP straight from R2, so the
// browser never has to fetch 50 MB of fonts into JS memory and deflate them
// again. Verify the archive byte-for-byte, including the manifest.
const dlEnv = {ASSETS: new MemoryR2(), ALLOWED_ORIGINS: origin, PRIVATE_LIBRARY:false, SYNC_WRITE_TOKEN: token};
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
// The archive name follows the caller's local date; junk falls back to UTC.
const dlDated = await handle(new Request(`${dlBase}&date=2026-11-16`, {headers: {Origin: origin}}), dlEnv);
assert.match(dlDated.headers.get("Content-Disposition") || "", /reeden-font-2026-11-16\.zip/);
const dlJunkDate = await handle(new Request(`${dlBase}&date=../../etc`, {headers: {Origin: origin}}), dlEnv);
assert.match(dlJunkDate.headers.get("Content-Disposition") || "", /reeden-font-\d{4}-\d{2}-\d{2}\.zip/);
assert.doesNotMatch(dlJunkDate.headers.get("Content-Disposition") || "", /etc/);
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
const ghostBytes=encoder.encode("ghost font");const ghostSha=await sha256(ghostBytes);await dlPut(`fonts/${ghostSha}.ttf`,ghostBytes);
const ghostRecord = encoder.encode(JSON.stringify({kind: "font", id: "font-dl-ghost", file_name: "Ghost.ttf", extension: "ttf",
  url: `/api/objects/fonts/${ghostSha}.ttf`, updated_at: "2026-11-15T00:00:00.000Z"}));
await dlPut(`records/${await sha256(ghostRecord)}.json`, ghostRecord);
await dlEnv.ASSETS.delete(`fonts/${ghostSha}.ttf`);
const ghostResponse = await handle(new Request(`https://worker.example/api/download?kind=font&ids=font-dl-a,font-dl-ghost`, {headers: {Origin: origin}}), dlEnv);
assert.equal(ghostResponse.status, 200);
const ghostZip = new Uint8Array(await ghostResponse.arrayBuffer());
assert.equal(new TextDecoder().decode(ghostZip).includes("__errors.json"), true);
assert.equal(new TextDecoder().decode(ghostZip).includes("font-dl-ghost"), true);
console.log("github-pages worker tests passed");
