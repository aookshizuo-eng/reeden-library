/**
 * Free personal sync API for a GitHub Pages front end.
 *
 * R2 is used only as object storage. Browser clients never receive an R2
 * access key; this Worker is the R2 binding and validates object hashes before
 * accepting a write. Reads require the device access token or a short-lived signed URL.
 * Set PRIVATE_LIBRARY=false only for an intentionally public library. Configure SYNC_WRITE_TOKEN before enabling browser uploads.
 */


const LIBRARY_INDEX_KEY = 'system/library-v1.json';
function problem(status, message) { return Object.assign(new Error(message), {status}); }
const indexRecordId = record => `${record.kind}:${record.id}`;
async function loadLibraryIndex(env) {
  let object = await env.ASSETS.get(LIBRARY_INDEX_KEY);
  if (object) {
    const data = JSON.parse(await object.text());
    if (data.version !== 1 || !Array.isArray(data.records)) throw problem(503, '共享清单格式异常，未覆盖原数据');
    return {data, etag: object.etag};
  }
  // One-time migration reads record JSON only, never RED/font/image payloads.
  const entries = await scanRecordEntries(env);
  const latest = new Map();
  for (const {key,record} of entries) {
    if (!['theme','font','asset'].includes(record?.kind) || !record.id) continue;
    const id = indexRecordId(record), previous = latest.get(id);
    if (!previous || String(previous.updated_at || '') < String(record.updated_at || '')) latest.set(id, {...record,record_sha256:key.slice(8,-5)});
  }
  const data = {version:1, revision:crypto.randomUUID(), records:[...latest.values()], garbage:[], updated_at:new Date().toISOString()};
  const saved = await env.ASSETS.put(LIBRARY_INDEX_KEY,JSON.stringify(data),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if (saved === null) return loadLibraryIndex(env);
  return {data,etag:saved?.etag};
}
async function mutateLibraryIndex(env, change) {
  for (let attempt=0;attempt<6;attempt++) {
    const current = await loadLibraryIndex(env);
    if (current.data.maintenance?.until > Date.now()) throw problem(423,'资源库正在核对清理，请稍后重试；本地任务已保留');
    const value = await change(current.data);
    current.data.revision = crypto.randomUUID();current.data.updated_at = new Date().toISOString();
    const saved = await env.ASSETS.put(LIBRARY_INDEX_KEY,JSON.stringify(current.data),{onlyIf:current.etag?{etagMatches:current.etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'},customMetadata:{maintenance_until:'0'}});
    if (saved !== null) return value;
  }
  throw problem(409,'其他设备正在修改资源库，请稍后重试；本地任务已保留');
}
async function registerRecord(env, record, sha) {
  if (!record || !['theme','font','asset'].includes(record.kind) || typeof record.id!=='string' || !record.id || record.id.length>160) throw problem(400,'资源记录格式无效');
  return mutateLibraryIndex(env,async data=>{
    const previous=data.records.find(item=>indexRecordId(item)===indexRecordId(record));
    if (previous) return previous; // Idempotent replay must not erase user edits.
    const references=[...referencedObjectKeys(record)].filter(key=>!key.startsWith('records/'));
    for(const key of references)if(!await env.ASSETS.head(key))throw problem(409,'关联文件不存在，请从恢复任务重新上传：'+key);
    const item={...record,record_sha256:sha};data.records.push(item);return item;
  });
}
function privateLibrary(env) { return String(env.PRIVATE_LIBRARY ?? 'true') !== 'false'; }
async function readKey(env) {
  if (!env.SYNC_WRITE_TOKEN) throw problem(503,'私有库尚未配置访问口令');
  return crypto.subtle.importKey('raw',new TextEncoder().encode(env.SYNC_WRITE_TOKEN),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
async function readTicket(env) {
  const expires=(Math.floor(Date.now()/86400000)+2)*86400000;
  const signature=new Uint8Array(await crypto.subtle.sign('HMAC',await readKey(env),new TextEncoder().encode(String(expires))));
  return {ticket:`${expires}.${base64String(signature).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`,expires};
}
async function mayRead(request,env) {
  if (!privateLibrary(env) || checkWriteToken(request,env)) return true;
  const url=new URL(request.url);
  if (!url.pathname.startsWith('/api/objects/') && url.pathname!=='/api/download') return false;
  const [expires,signature] = (url.searchParams.get('access') || '').split('.');
  if (!/^\d+$/.test(expires || '') || Number(expires)<Date.now() || Number(expires)>Date.now()+172800000 || !signature) return false;
  try { return await crypto.subtle.verify('HMAC',await readKey(env),base64Bytes(signature.replace(/-/g,'+').replace(/_/g,'/')),new TextEncoder().encode(expires)); } catch { return false; }
}
async function deviceConfig(request,env) {
  if(!originAllowed(request,env,{write:request.method!=='GET'}))throw problem(403,'Origin 不在允许列表中');
  const key='system/device-config-v1.json';
  if(request.method==='GET') {const object=await env.ASSETS.get(key);return object?response(await object.text(),200,request,env,{'Content-Type':'application/json'}):json({error:'尚未保存云端加密配置'},404,request,env);}
  if(!checkWriteToken(request,env))return json({error:'需要访问口令'},401,request,env);
  const raw=await request.text();if(raw.length>262144)return json({error:'配置文件过大'},413,request,env);
  const data=JSON.parse(raw);if(data.format!=='reeden-device-v1'||typeof data.cipher!=='string'||typeof data.salt!=='string'||typeof data.iv!=='string')return json({error:'只接受加密配置'},400,request,env);
  await env.ASSETS.put(key,raw,{httpMetadata:{contentType:'application/json'}});return json({ok:true},200,request,env);
}

const DEFAULT_MAX_UPLOAD_BYTES = 96 * 1024 * 1024;
const MAX_LIST_RECORDS = 200;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_EXT = new Set(["ttf", "otf", "woff", "woff2"]);
const STAGING_EXT = new Set(["red", "ttf", "otf", "woff", "woff2", "svg", "html"]);
const KINDS = new Set(["originals", "compressed", "fonts", "previews", "records", "assets", "staging"]);
const JOBS_PREFIX = "jobs/";
const PAN123_API = "https://www.123pan.cn/b/api";
const PAN123_CHUNK = 16 * 1024 * 1024;
const PRIVATE_RED_MAGIC = new Uint8Array([0x52, 0x45, 0x44, 0x10]);
const PRIVATE_MAX_MANIFEST = 1024 * 1024;
const PRIVATE_MAX_RESOURCE = 80 * 1024 * 1024;
// 服务端还要 JSON.parse + 遍历配置里的图片引用，免费版只有 10ms CPU，
// 所以"服务端映射"保持 1 MB；更大的配置（有的主题 reader_schema 就有 2 MB）
// 由浏览器先按同一规则映射好，这里只登记字节与哈希，不再解析。
const PRIVATE_MAX_CONFIG = 1024 * 1024;
const PRIVATE_MAX_MAPPED_CONFIG = 8 * 1024 * 1024;
const PRIVATE_MAX_MAPPED_TOTAL = 32 * 1024 * 1024;

// R2 list() returns object keys, so records still need individual reads. Keep
// those reads bounded but concurrent; serial reads made a library refresh take
// roughly one network round trip per asset.
async function mapConcurrent(items, limit, worker) {
  const values = Array.from(items || []), result = new Array(values.length);
  const width = Math.max(1, Math.min(Number(limit) || 1, values.length || 1));
  let next = 0;
  async function consume() {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      result[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({length: width}, consume));
  return result;
}

function configuredOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = configuredOrigins(env);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Content-Length,X-Content-SHA256,X-Pan123-Token,X-Pan123-Folder,X-Pan123-Filename,X-Pan123-Etag,If-None-Match,Range,If-Range",
    "Access-Control-Expose-Headers": "ETag,X-Content-SHA256,Content-Disposition,Content-Length,Content-Range,Accept-Ranges",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function response(body, status, request, env, extra = {}) {
  const payload = status === 204 || status === 304 ? null : body;
  return new Response(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
      ...extra,
    },
  });
}

function json(value, status, request, env, extra = {}) {
  return response(JSON.stringify(value), status, request, env, {
    "Content-Type": "application/json; charset=utf-8",
    ...extra,
  });
}

function originAllowed(request, env, {write = false} = {}) {
  const origin = request.headers.get("Origin");
  const allowed = configuredOrigins(env);
  if (!origin) return !write || checkWriteToken(request, env);
  // A Pages deployment may receive its own generated `*.pages.dev` hostname
  // before the dashboard variable list has been refreshed. Same-origin calls
  // are still protected by the write token below, so accepting the Worker
  // origin itself does not make cross-site writes possible.
  return allowed.includes(origin) || origin === new URL(request.url).origin;
}

function checkWriteToken(request, env) {
  const expected = String(env.SYNC_WRITE_TOKEN || "");
  // The personal red-garden fallback can explicitly opt into same-origin
  // public writes when the owner has not configured a token yet. The primary
  // sync project still has SYNC_WRITE_TOKEN set and remains protected.
  if (!expected) return String(env.ALLOW_PUBLIC_WRITES || "") === "1";
  const header = request.headers.get("Authorization") || "";
  return header === `Bearer ${expected}`;
}

// Object keys carry the source name so the R2 dashboard is readable:
// `compressed/Muiii - 雪一片一片~<sha256>.red`.  The SHA-256 is still the last
// segment, so integrity checks and content addressing keep working, and the
// legacy `<sha>.red` layout still resolves for objects uploaded earlier.
function objectLabel(value) {
  const text = String(value || "")
    .replace(/[\\/:*?"<>|~]+/g, "-")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .trim();
  return text.slice(0, 80).replace(/[.\s]+$/, "");
}
function objectSpec(pathname) {
  const match = pathname.match(/^\/api\/objects\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, kind, rawFilename] = match;
  if (!KINDS.has(kind)) return null;
  let filename;
  try { filename = decodeURIComponent(rawFilename); } catch { return null; }
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) return null;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;
  const base = filename.slice(0, dot);
  const ext = filename.slice(dot + 1).toLowerCase();
  // Two key shapes are valid. Older objects end in "~<sha>" (or are a bare
  // "<sha>") because the digest used to sit in the path. New objects are just
  // "<source name>" and carry the digest in X-Content-SHA256 and in object
  // metadata, so the R2 dashboard reads like a folder of themes.
  const separator = base.lastIndexOf("~");
  const tail = (separator >= 0 ? base.slice(separator + 1) : base).toLowerCase();
  const legacy = tail.length === 64 && SHA256.test(tail);
  // A "~" only ever came from the old separator, so a stray one is malformed.
  if (separator >= 0 && !legacy) return null;
  const label = objectLabel(legacy ? (separator >= 0 ? base.slice(0, separator) : "") : base);
  if (!legacy && !label) return null;
  if ((kind === "compressed" || kind === "originals") && ext !== "red") return null;
  if (kind === "previews" && ext !== "jpg") return null;
  if (kind === "records" && ext !== "json") return null;
  if (kind === "fonts" && !SAFE_EXT.has(ext)) return null;
  if (kind === "staging" && !STAGING_EXT.has(ext)) return null;
  // RED 图集 / 高亮包也算收藏：保留 .red 原包，供收藏库直接下载。
  if (kind === "assets" && !new Set(["svg", "html", "red"]).has(ext)) return null;
  const name = label ? (legacy ? `${label}~${tail}` : label) : tail;
  return {kind, sha: legacy ? tail : null, ext, label, filename: `${name}.${ext}`, key: `${kind}/${name}.${ext}`};
}

function maxUpload(env) {
  const value = Number(env.MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100 * 1024 * 1024) {
    return DEFAULT_MAX_UPLOAD_BYTES;
  }
  return value;
}

async function digestHex(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Bytes(value, label) {
  if (typeof value !== "string" || value.length > 140 * 1024 * 1024) throw new Error(`${label} 不是有效 Base64`);
  let decoded;
  try { decoded = atob(value); } catch { throw new Error(`${label} 不是有效 Base64`); }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function base64String(bytes) {
  let result = "";
  const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let index = 0; index < values.length; index += 0x8000) {
    result += String.fromCharCode(...values.subarray(index, Math.min(index + 0x8000, values.length)));
  }
  return btoa(result);
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function utf8Json(bytes, label) {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("对象无效");
    return value;
  } catch { throw new Error(`${label} 不是有效 JSON 对象`); }
}

function assertPrivateHeader(header) {
  const expected = {
    version: 2, resourceType: "themeBundle", payloadType: "directory",
    containerMode: "reedenPrivate", algorithm: "aes-256-gcm-manifest", assetMode: "plain-sequential",
  };
  if (!header || typeof header !== "object" || Object.keys(expected).some(key => header[key] !== expected[key])) {
    throw new Error("此私有 RED 协议尚未支持重封");
  }
  if (!Number.isSafeInteger(header.manifestLength) || header.manifestLength < 16 || header.manifestLength > PRIVATE_MAX_MANIFEST) {
    throw new Error("RED v2 加密目录长度无效");
  }
}

function assertPrivateManifest(manifest) {
  if (!manifest || manifest.version !== 2 || manifest.payloadKind !== "directory" || !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > 3000) {
    throw new Error("RED v2 已认证目录结构无效");
  }
  const seen = new Set();
  for (const entry of manifest.entries) {
    const path = entry?.path;
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.includes(":" ) || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..") || seen.has(path)) throw new Error("RED v2 目录路径无效或重复");
    if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || !Number.isSafeInteger(entry.length) || entry.length < 0 || entry.length > PRIVATE_MAX_RESOURCE || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ""))) throw new Error("RED v2 目录项无效");
    seen.add(path);
  }
}

async function importPrivateKey(env) {
  const keyBytes = base64Bytes(String(env.REEDEN_PRIVATE_FORMAT_KEY_B64 || ""), "REEDEN_PRIVATE_FORMAT_KEY_B64");
  if (keyBytes.length !== 32) throw new Error("RED v2 格式密钥长度无效");
  return crypto.subtle.importKey("raw", keyBytes, {name: "AES-GCM"}, false, ["decrypt", "encrypt"]);
}

async function decryptPrivateManifest(raw, env) {
  if (raw.length < 8 || !PRIVATE_RED_MAGIC.every((value, index) => raw[index] === value)) throw new Error("不是 RED v2 私有主题");
  const headerLength = readU32(raw, 4);
  if (headerLength < 2 || headerLength > 65536 || 8 + headerLength > raw.length) throw new Error("RED v2 公开头长度无效");
  const header = utf8Json(raw.subarray(8, 8 + headerLength), "RED v2 公开头");
  assertPrivateHeader(header);
  const nonce = base64Bytes(header.manifestNonce, "RED v2 目录随机数");
  if (nonce.length !== 12) throw new Error("RED v2 目录随机数长度无效");
  const manifestStart = 8 + headerLength;
  const manifestEnd = manifestStart + header.manifestLength;
  if (manifestEnd > raw.length) throw new Error("RED v2 加密目录不完整");
  let plain;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv: nonce}, await importPrivateKey(env), raw.subarray(manifestStart, manifestEnd))); }
  catch { throw new Error("RED v2 加密目录认证失败，文件可能损坏或密钥不匹配"); }
  const manifest = utf8Json(plain, "RED v2 已认证目录");
  assertPrivateManifest(manifest);
  return {header, manifest, manifestEnd};
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

function replacePrivateExtension(path, extension) {
  const ext = String(extension || "").replace(/^\./, "").toLowerCase();
  const safe = ["png", "jpg", "jpeg", "webp", "gif"].includes(ext);
  // `.img` 是 Reeden 的固定槽位（theme_bg.img / card_bg.img / bg.img /
  // 000.img），按路径加载，改名会让书架背景、阅读背景和轮播图全部失联。
  return safe && /\.(?:png|jpe?g|webp|gif)$/i.test(String(path || "")) ? String(path).replace(/\.(?:png|jpe?g|webp|gif)$/i, `.${ext}`) : path;
}

function pathExtensionSuffix(path) {
  const match = String(path || "").match(/\.([A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function mapPrivateRefs(value, replacements, pathReplacements, extensionReplacements = new Map(), configPath = "") {
  if (Array.isArray(value)) return value.map(item => mapPrivateRefs(item, replacements, pathReplacements, extensionReplacements, configPath));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapPrivateRefs(item, replacements, pathReplacements, extensionReplacements, configPath)]));
  if (typeof value !== "string") return value;
  if (pathReplacements.has(value)) return pathReplacements.get(value);
  const exact = replacements.get(value) || replacements.get(value.toLowerCase());
  if (exact) return exact;
  const match = value.match(/^([a-f0-9]{32}|[a-f0-9]{64})(\.[A-Za-z0-9]+)?$/i);
  if (match) {
    const mapped = replacements.get(match[1].toLowerCase());
    const extension = extensionReplacements.get(match[1].toLowerCase());
    return mapped ? mapped + (extension ? `.${extension}` : (match[2] || "")) : value;
  }
  // 相对文件名（轮播 manifest 的 "file": "000.img"）按配置所在目录解析，
  // 资源改名后这里必须同步，否则 Reeden 找不到轮播图。
  if (configPath) {
    const dir = configPath.slice(0, configPath.lastIndexOf("/") + 1);
    if (dir) {
      const target = pathReplacements.get(dir + value);
      if (target && target.startsWith(dir)) return target.slice(dir.length);
    }
  }
  return value;
}

async function repackPrivateRed(request, env) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "加密 RED 重封接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let payload;
  try { payload = await request.json(); } catch { return json({error: "重封请求不是有效 JSON"}, 400, request, env); }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.replacements)) return json({error: "重封请求缺少 replacements"}, 400, request, env);
  let raw;
  try { raw = base64Bytes(payload.red_base64, "red_base64"); } catch (error) { return json({error: error.message}, 400, request, env); }
  if (raw.length > maxUpload(env)) return json({error: "原始 RED 超过上传大小限制"}, 413, request, env);
  try {
    const {header, manifest, manifestEnd} = await decryptPrivateManifest(raw, env);
    const payloadBytes = raw.subarray(manifestEnd);
    const ranges = manifest.entries.map(entry => [entry.offset, entry.offset + entry.length]);
    let cursor = 0;
    for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
      if (start !== cursor || end < start || end > payloadBytes.length) throw new Error("RED v2 资源载荷有空隙、重叠或越界");
      cursor = end;
    }
    if (cursor !== payloadBytes.length) throw new Error("RED v2 资源载荷末尾有未登记数据");
    const byPath = new Map(manifest.entries.map(entry => [entry.path, entry]));
    const replacements = new Map();
    const pathReplacements = new Map();
    const extensionReplacements = new Map();
    const changed = new Map();
    for (const item of payload.replacements) {
      if (!item || typeof item !== "object") throw new Error("replacement 格式无效");
      let entry = typeof item.path === "string" ? byPath.get(item.path) : null;
      if (!entry && Number.isSafeInteger(item.offset) && Number.isSafeInteger(item.end) && item.end > item.offset) {
        entry = manifest.entries.find(candidate => {
          const relativeEnd = candidate.offset + candidate.length;
          return (candidate.offset === item.offset && relativeEnd === item.end)
            || (manifestEnd + candidate.offset === item.offset && manifestEnd + relativeEnd === item.end);
        });
      }
      if (!entry) throw new Error(`找不到待替换资源：${item.path || `${item.offset}-${item.end}`}`);
      const itemPath = entry.path;
      const oldBytes = payloadBytes.subarray(entry.offset, entry.offset + entry.length);
      const oldSha = await digestHex(oldBytes);
      if (oldSha.toLowerCase() !== String(entry.sha256).toLowerCase() || (item.old_sha256 && oldSha.toLowerCase() !== String(item.old_sha256).toLowerCase())) throw new Error(`资源 SHA-256 校验失败：${itemPath}`);
      const bytes = base64Bytes(item.bytes_base64, `${itemPath} bytes_base64`);
      if (bytes.length > PRIVATE_MAX_RESOURCE) throw new Error(`资源超过处理上限：${itemPath}`);
      const newSha = await digestHex(bytes);
      const oldPath = itemPath;
      const newExtension = String(item.new_extension || "").replace(/^\./, "").toLowerCase();
      if (newExtension && !["png", "jpg", "jpeg", "webp", "gif"].includes(newExtension)) throw new Error(`不支持的图片扩展名：${newExtension}`);
      const newPath = typeof item.new_path === "string" && item.new_path ? item.new_path : replacePrivateExtension(oldPath, newExtension);
      if (newPath !== oldPath) pathReplacements.set(oldPath, newPath);
      // 资源没有改名时，引用里的扩展名保持原样（`.img` 依旧写 `.img`），
      // 否则「哈希.扩展名」形态的引用会指向并不存在的文件名。
      const effectiveExtension = newPath === oldPath ? pathExtensionSuffix(oldPath) : newExtension;
      if (effectiveExtension) extensionReplacements.set(oldSha.toLowerCase(), effectiveExtension);
      replacements.set(oldSha, newSha);
      replacements.set(oldSha.toUpperCase(), newSha.toUpperCase());
      if (item.old_md5 && item.new_md5) { replacements.set(String(item.old_md5).toLowerCase(), String(item.new_md5).toLowerCase()); replacements.set(String(item.old_md5).toUpperCase(), String(item.new_md5).toUpperCase()); if (effectiveExtension) extensionReplacements.set(String(item.old_md5).toLowerCase(), effectiveExtension); }
      changed.set(oldPath, {bytes, newPath, newSha});
    }
    const outputEntries = [];
    const newManifest = cloneJson(manifest);
    let outputCursor = 0;
    const resources = [];
    for (const entry of newManifest.entries) {
      const original = manifest.entries.find(item => item.path === entry.path);
      const replacement = changed.get(entry.path);
      let bytes = replacement ? replacement.bytes : payloadBytes.subarray(original.offset, original.offset + original.length);
      let path = replacement?.newPath || entry.path;
      if (path !== entry.path) entry.path = path;
      if (entry.path.endsWith(".json")) {
        try {
          const document = JSON.parse(new TextDecoder().decode(bytes));
          const mapped = mapPrivateRefs(document, replacements, pathReplacements, extensionReplacements);
          bytes = new TextEncoder().encode(JSON.stringify(mapped));
        } catch { /* opaque JSON-like resources remain byte-for-byte unchanged */ }
      }
      entry.offset = outputCursor;
      entry.length = bytes.length;
      entry.sha256 = await digestHex(bytes);
      outputCursor += bytes.length;
      resources.push(bytes);
      outputEntries.push(entry.path);
    }
    if (new Set(outputEntries).size !== outputEntries.length) throw new Error("重封后的资源路径冲突");
    const nextNonce = crypto.getRandomValues(new Uint8Array(12));
    const nextManifest = new TextEncoder().encode(JSON.stringify(newManifest));
    const key = await importPrivateKey(env);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: nextNonce}, key, nextManifest));
    const nextHeader = {...header, manifestNonce: base64String(nextNonce), manifestLength: encrypted.length};
    const headerBytes = new TextEncoder().encode(JSON.stringify(nextHeader));
    if (headerBytes.length > 65536 || encrypted.length > PRIVATE_MAX_MANIFEST) throw new Error("重封后的目录超过处理上限");
    const prefix = new Uint8Array(8 + headerBytes.length + encrypted.length);
    prefix.set(PRIVATE_RED_MAGIC, 0); new DataView(prefix.buffer).setUint32(4, headerBytes.length, false); prefix.set(headerBytes, 8); prefix.set(encrypted, 8 + headerBytes.length);
    const result = new Uint8Array(prefix.length + resources.reduce((sum, item) => sum + item.length, 0));
    result.set(prefix, 0); let offset = prefix.length;
    for (const bytes of resources) { result.set(bytes, offset); offset += bytes.length; }
    return json({ok: true, bytes: base64String(result), bytes_length: result.length, sha256: await digestHex(result)}, 200, request, env);
  } catch (error) { return json({error: error?.message || "加密 RED 重封失败"}, 422, request, env); }
}

function contentType(spec) {
  if (spec.kind === "compressed" || spec.kind === "originals" || spec.kind === "staging") return "application/octet-stream";
  if (spec.kind === "fonts") {
    return spec.ext === "woff2" ? "font/woff2" : spec.ext === "woff" ? "font/woff" : "font/ttf";
  }
  if (spec.kind === "previews") return "image/jpeg";
  if (spec.kind === "assets") return spec.ext === "svg" ? "image/svg+xml" : spec.ext === "red" ? "application/octet-stream" : "text/html; charset=utf-8";
  return "application/json; charset=utf-8";
}

// Staging objects are raw copies parked for later processing. Once a device has
// finished the batch they are dead weight, so the same device may delete them.
// Only the staging prefix is deletable; library objects go through the record
// delete route, which also drops references.
async function deleteStagingObject(request, env, spec) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "删除暂存文件需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  if (typeof env.ASSETS.delete !== "function") return json({error: "R2 不支持删除"}, 405, request, env);
  await env.ASSETS.delete(spec.key);
  return json({ok: true, deleted: spec.key}, 200, request, env);
}
async function putObject(request, env, spec) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "上传接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  const indexHead=typeof env.ASSETS.head==='function'?await env.ASSETS.head(LIBRARY_INDEX_KEY):null;
  if(Number(indexHead?.customMetadata?.maintenance_until)>Date.now())throw problem(423,'资源库正在清理，请稍后继续恢复任务');
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxUpload(env))) {
    return json({error: "上传文件超过大小限制"}, 413, request, env);
  }
  const data = await request.arrayBuffer();
  if (data.byteLength > maxUpload(env)) return json({error: "上传文件超过大小限制"}, 413, request, env);
  const actual = await digestHex(data);
  // The digest is no longer part of the key, so integrity comes from the
  // declared header (legacy keys still declare it in the path).
  const declared = String(request.headers.get("X-Content-SHA256") || "").toLowerCase();
  if (declared && declared !== actual) return json({error: "内容与声明的 SHA-256 不一致", actual}, 400, request, env);
  if (spec.sha && spec.sha !== actual) return json({error: "SHA-256 与对象路径不一致", actual}, 400, request, env);
  const key = await resolveObjectKey(env, spec, actual);
  let item;
  if (spec.kind === 'records') {
    let record; try { record=JSON.parse(new TextDecoder().decode(data)); } catch { throw problem(400,'资源记录不是有效 JSON'); }
    await env.ASSETS.put(key,data,{httpMetadata:{contentType:'application/json'},customMetadata: {sha256: actual}});
    item=await registerRecord(env,record,actual);
  } else {
    // Conditional creation closes the readable-name race between devices.
    let candidate=key, saved;
    for(let attempt=0;attempt<6;attempt++) {
      saved=await env.ASSETS.put(candidate,data,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:contentType(spec)},customMetadata: {sha256: actual}});
      if(saved!==null)break;
      const existing=await env.ASSETS.head(candidate);
      if(existing?.customMetadata?.sha256===actual){saved=existing;break;}
      candidate=`${spec.kind}/${spec.label || spec.sha}-${actual.slice(0,16)}${attempt?'-'+attempt:''}.${spec.ext}`;
    }
    if(saved===null)throw problem(409,'同名文件正在由其他设备上传，请重试');
    return json({ok:true,key:candidate,filename:candidate.slice(spec.kind.length+1),sha256:actual,bytes:data.byteLength},201,request,env);
  }
  const filename = key.slice(spec.kind.length + 1);
  return json({ok: true, key, filename, sha256: actual, bytes: data.byteLength, item}, 201, request, env);
}
// A readable key is not unique on its own: two themes can share a name, and a
// re-compressed pack must not silently replace the previous one. Reuse the
// existing object when the bytes are identical, otherwise suffix -2, -3 ...
async function resolveObjectKey(env, spec, digest) {
  if (spec.sha) return spec.key;
  const head = key => (typeof env.ASSETS.head === "function" ? env.ASSETS.head(key) : env.ASSETS.get(key));
  for (let index = 1; index <= 40; index++) {
    const key = `${spec.kind}/${index === 1 ? spec.label : `${spec.label}-${index}`}.${spec.ext}`;
    const existing = await head(key);
    if (!existing) return key;
    if (existing.customMetadata?.sha256 === digest) return key;
  }
  return `${spec.kind}/${spec.label}-${Date.now()}.${spec.ext}`;
}

async function getObject(request, env, spec) {
  let range;
  if(request.method==='GET' && request.headers.has('Range')) {
    const head=await env.ASSETS.head(spec.key);if(!head)return json({error:'对象不存在'},404,request,env);
    const etag=head.httpEtag||'"'+head.etag+'"';
    if(!request.headers.has('If-Range')||request.headers.get('If-Range')===etag){
      const match=/^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range'));
      const size=head.size;let start,end;
      if(match&&(match[1]||match[2])){if(!match[1]){start=Math.max(0,size-Number(match[2]));end=size-1;}else{start=Number(match[1]);end=match[2]?Math.min(size-1,Number(match[2])):size-1;}}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=size)return response(null,416,request,env,{'Content-Range':'bytes */'+size});
      range={offset:start,length:end-start+1};
    }
  }
  const object=request.method==='HEAD'?await env.ASSETS.head(spec.key):await env.ASSETS.get(spec.key,{...(range?{range}:{}),onlyIf:request.headers});
  if(!object)return json({error:'对象不存在'},404,request,env);
  const headers = new Headers(corsHeaders(request, env));
  headers.set("Cache-Control", privateLibrary(env) ? "private, max-age=86400" : "public, max-age=31536000, immutable");
  headers.set("Referrer-Policy", "no-referrer");
  const etag=object.httpEtag||(object.etag?'"'+object.etag+'"':null);if(etag)headers.set("ETag",etag);
  headers.set("Accept-Ranges","bytes");
  if(request.method!=="HEAD" && !object.body)return new Response(null,{status:304,headers});
  if(range)headers.set("Content-Range",`bytes ${range.offset}-${range.offset+range.length-1}/${object.size}`);
  headers.set("Content-Length",String(range?range.length:object.size));
  if(object.customMetadata?.sha256)headers.set('X-Content-SHA256',object.customMetadata.sha256);
  headers.set("Content-Type", contentType(spec));
  if (object.httpMetadata?.contentType) headers.set("Content-Type", object.httpMetadata.contentType);
  if (spec.kind === "assets" && spec.ext === "html") headers.set("Content-Security-Policy", "sandbox");
  // `?download=1` turns a previewable object into a real attachment. Android
  // WebView only calls DownloadListener for attachment responses; a bare
  // cross-origin href is treated as navigation and then blocked by the app.
  const download = new URL(request.url).searchParams.get("download");
  if (download !== null && download !== "0" && download !== "false") {
    const requestedName = new URL(request.url).searchParams.get("name") || spec.filename;
    const downloadName = requestedName.replace(/[\\/:*?"<>|\r\n]/g,"_").slice(0,160);
    const ascii = downloadName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    headers.set("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  }
  return new Response(request.method==='HEAD'?null:object.body, {status: range?206:200, headers});
}

/**
 * Batch downloads used to pull every selected object into the browser, run a
 * second DEFLATE pass over fonts/RED packages that are already compressed, and
 * only then hand a Blob to the download manager. A 5-font selection is ~50 MB,
 * so the tab could appear frozen for minutes. The Worker now builds a Stored
 * ZIP straight from R2 and streams it; the browser gets one native download
 * with its own progress indicator and never holds the archive in JS memory.
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
function crc32Bytes(bytes) {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function zipU16(value) { return new Uint8Array([value & 255, (value >>> 8) & 255]); }
function zipU32(value) { return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]); }
function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function zipLocalHeader(name, crc, size, flags=0x0800) {
  return concatBytes([
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]), zipU16(20), zipU16(flags), zipU16(0),
    zipU16(0), zipU16(0), zipU32(crc), zipU32(size), zipU32(size),
    zipU16(name.length), zipU16(0), name,
  ]);
}
function zipCentralHeader(name, crc, size, offset, flags=0x0800) {
  return concatBytes([
    new Uint8Array([0x50, 0x4b, 0x01, 0x02]), zipU16(20), zipU16(20), zipU16(flags), zipU16(0),
    zipU16(0), zipU16(0), zipU32(crc), zipU32(size), zipU32(size),
    zipU16(name.length), zipU16(0), zipU16(0), zipU16(0), zipU16(0), zipU32(0), zipU32(offset), name,
  ]);
}
function zipEndOfCentralDirectory(count, centralSize, localSize) {
  return concatBytes([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]), zipU16(0), zipU16(0),
    zipU16(count), zipU16(count), zipU32(centralSize), zipU32(localSize), zipU16(0),
  ]);
}
async function latestLibraryRecords(env,kind=null) {
  const {data}=await loadLibraryIndex(env);return data.records.filter(item=>!kind || item.kind===kind);
}

// Mirrors downloadableFiles() in the front end so the archive layout stays the
// same in remote mode and in the browser-only fallback.
function redDownloadLabel(record) {
  let title=String(record.name||record.source_name||record.file_name||record.id||'主题').replace(/\.red$/i,'').trim();
  const author=String(record.author||'').trim();
  if(author && author!=='作者未记录') {
    const escaped=author.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    title=title.replace(new RegExp('^'+escaped+'\\s*[-–—－]\\s*','i'),'');
    title=author+' - '+title;
  }
  return title.replace(/[\\/:*?"<>|\0\r\n]/g,'_').slice(0,140)||'主题';
}
function downloadFileList(kind, record, extras = kind !== "theme") {
  const raw = String(record?.file_name || record?.name || record?.family || record?.id || "item");
  const label = kind === "theme" ? redDownloadLabel(record) : raw.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\0]/g, "_").slice(0, 90) || "item";
  const files = [];
  const add = (path, suffix) => { if (path && !files.some(item => item.path === path)) files.push({path, name: label + suffix}); };
  if (kind === "theme") {
    const compressed = record.compressed_url || record.library_url;
    add(compressed || record.original_url, ".red");
    if(!extras)return files;
    if (record.original_url && record.original_url !== compressed) add(record.original_url, ".original.red");
    if (record.preview_light_url) add(record.preview_light_url, ".preview.jpg");
    if (record.preview_dark_url) add(record.preview_dark_url, ".night.jpg");
  } else if (kind === "font") {
    add(record.url || record.view_url, "." + String(record.extension || "ttf").replace(/^\./, ""));
    if (record.preview_url) add(record.preview_url, ".preview.jpg");
  } else {
    add(record.url || record.object_url, "." + String(record.extension || "svg").replace(/^\./, ""));
    if (record.preview_url) add(record.preview_url, ".preview.jpg");
  }
  return files;
}
function downloadObjectSpec(path) {
  let pathname = String(path || "").trim();
  if (/^https?:\/\//i.test(pathname)) {
    try { pathname = new URL(pathname).pathname; } catch { return null; }
  }
  if (!pathname.startsWith("/")) pathname = `/api/objects/${pathname.replace(/^\/?api\/objects\//, "")}`;
  else if (!pathname.startsWith("/api/objects/")) return null;
  const spec = objectSpec(pathname);
  return spec?.key ? spec : null;
}
function downloadEntries(kind, records, extras=kind!=="theme") {
  const entries = [], usedKeys = new Set(), usedNames = new Set();
  for (const record of records) {
    for (const file of downloadFileList(kind, record, extras)) {
      const spec = downloadObjectSpec(file.path);
      if (!spec || usedKeys.has(spec.key)) continue;
      usedKeys.add(spec.key);
      let name = `${kind}/${file.name.replace(/[\\/:*?"<>|]/g, "_")}`;
      if (usedNames.has(name)) {
        let index = 2;
        while (usedNames.has(`${name}-${index}`)) index++;
        name = `${name}-${index}`;
      }
      usedNames.add(name);
      entries.push({name, key: spec.key, path: file.path, record_id: String(record.id), original_name: file.name});
    }
  }
  return entries;
}
function streamZip(request, env, kind, entries, stamp) {
  const encoder = new TextEncoder();
  const manifest = {
    created_at: new Date().toISOString(), kind,
    files: entries.map(item => ({kind, id: item.record_id, name: item.original_name, path: item.name, source: item.path})),
  };
  const pending=[{name:'manifest.json',bytes:encoder.encode(JSON.stringify(manifest,null,2))},...entries];
  const central=[],errors=[];let offset=0,count=0;
  async function* chunks() {
    for(let index=0;index<=pending.length;index++) {
      if(index===pending.length){if(!errors.length)break;pending.push({name:'__errors.json',bytes:encoder.encode(JSON.stringify({skipped:errors},null,2))});errors.length=0;}
      const item=pending[index];let object;
      if(item.key){object=await env.ASSETS.get(item.key);if(!object){errors.push({path:item.path,name:item.name,error:'R2 对象不存在'});continue;}}
      const name=encoder.encode(item.name),start=offset,flags=0x0808;
      if(name.length>65535 || offset>0xffffffff || count>=65535)throw new Error('批量下载超过普通 ZIP 上限，请拆分下载');
      const header=zipLocalHeader(name,0,0,flags);offset+=header.length;yield header;
      let size=0,crc=0xffffffff;
      const update=bytes=>{for(let i=0;i<bytes.length;i++)crc=(crc>>>8)^CRC32_TABLE[(crc^bytes[i])&255];size+=bytes.length;offset+=bytes.length;if(size>0xffffffff)throw new Error('文件超过 ZIP 上限');return bytes;};
      if(object){const reader=object.body.getReader();try{while(true){const part=await reader.read();if(part.done)break;yield update(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
      else yield update(item.bytes);
      crc=(crc^0xffffffff)>>>0;
      const descriptor=concatBytes([zipU32(0x08074b50),zipU32(crc),zipU32(size),zipU32(size)]);offset+=descriptor.length;yield descriptor;
      central.push(zipCentralHeader(name,crc,size,start,flags));count++;
    }
    const directory=concatBytes(central);yield directory;yield zipEndOfCentralDirectory(count,directory.length,offset);
  }
  const iterator=chunks();
  const stream=new ReadableStream({async pull(controller){try{const part=await iterator.next();if(part.done)controller.close();else controller.enqueue(part.value);}catch(error){controller.error(error);}},async cancel(){await iterator.return();}},{highWaterMark:1});
  const headers = new Headers(corsHeaders(request, env));
  headers.set("Content-Type", "application/zip");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Disposition", `attachment; filename="reeden-${kind}-${stamp}.zip"`);
  headers.set("X-Reeden-Download-Files", String(entries.length));
  return new Response(stream, {status: 200, headers});
}
async function downloadSelected(request, env) {
  if (!originAllowed(request, env)) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  const url = new URL(request.url);
  const kinds = {theme: "theme", themes: "theme", font: "font", fonts: "font", asset: "asset", assets: "asset"};
  const kind = kinds[String(url.searchParams.get("kind") || "").toLowerCase()];
  if (!kind) return json({error: "下载类型必须是 theme / font / asset"}, 400, request, env);
  const ids = [...new Set(String(url.searchParams.get("ids") || "").split(/[,\s]+/).filter(id => /^[A-Za-z0-9_.:-]{1,120}$/.test(id)))].slice(0, 100);
  if (!ids.length) return json({error: "请先选择要下载的项目"}, 400, request, env);
  const records = await latestLibraryRecords(env, kind);
  const chosen = ids.map(id => records.find(record => String(record.id) === id)).filter(Boolean);
  if (!chosen.length) return json({error: "所选记录不存在或已被删除"}, 404, request, env);
  const entries = downloadEntries(kind, chosen, kind!=="theme" || url.searchParams.get("extras")==="1");
  if (!entries.length) return json({error: "所选记录没有可下载的 R2 对象"}, 404, request, env);
  if (url.searchParams.get("probe") === "1") {
    return json({ok: true, kind, records: chosen.length, count: entries.length,
      files: entries.map(item => ({name: item.name, path: item.path}))}, 200, request, env);
  }
  // The archive name should follow the user's calendar. A Worker has no
  // timezone, so the client passes its local date and we only accept a plain
  // YYYY-MM-DD (a 03:00 CST download used to be stamped with yesterday).
  const requested = String(url.searchParams.get("date") || "");
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : new Date().toISOString().slice(0, 10);
  return streamZip(request, env, kind, entries, stamp);
}

async function listRecords(request,env,wantedKind=null) {
  if(!originAllowed(request,env))return json({error:'Origin 不在允许列表中'},403,request,env);
  const {data}=await loadLibraryIndex(env),url=new URL(request.url);
  const etag='"'+data.revision+'"';
  if(request.headers.get('If-None-Match')===etag)return response(null,304,request,env,{ETag:etag});
  const all=data.records.filter(item=>!wantedKind || item.kind===wantedKind);
  // The new client asks for one shared manifest; old clients keep pagination.
  const start=Math.max(0,Number(url.searchParams.get('cursor'))||0),limit=url.searchParams.get('all')==='1'?all.length:MAX_LIST_RECORDS;
  const records=all.slice(start,start+limit);
  return json({records,items:records,cursor:start+limit<all.length?String(start+limit):null,revision:data.revision},200,request,env,{ETag:etag});
}

function normalizeAssetClassification(value) {
  const text = String(value ?? "").trim();
  return text.length > 200 ? text.slice(0, 200) : text;
}

function normalizeAssetTags(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => String(item ?? "").trim()).filter(Boolean))]
    .map((item) => item.slice(0, 80)).slice(0, 30);
}

async function updateRecordClassification(request, env, kind, id) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "分类更新接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let payload;
  try { payload = await request.json(); } catch { return json({error: "分类数据不是有效 JSON"}, 400, request, env); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json({error: "更新数据必须是 JSON 对象"}, 400, request, env);
  const previewUpdates = {};
  for (const key of ["preview_light_url", "preview_dark_url"]) {
    if (!Object.hasOwn(payload, key)) continue;
    const value = payload[key];
    const spec = typeof value === "string" && value ? objectSpec(value) : null;
    if (kind !== "theme" || (value !== "" && spec?.kind !== "previews")) return json({error: "预览地址必须指向本站 previews 对象"}, 400, request, env);
    previewUpdates[key] = value;
  }
  if (Object.hasOwn(payload, "preview_details")) {
    if (kind !== "theme" || !payload.preview_details || typeof payload.preview_details !== "object" || Array.isArray(payload.preview_details) || JSON.stringify(payload.preview_details).length > 2048) return json({error: "预览信息无效"}, 400, request, env);
    previewUpdates.preview_details = payload.preview_details;
  }
  const reference = String(payload.record_sha256 || "");
  if (reference && !SHA256.test(reference)) return json({error: "记录版本无效，请刷新列表"}, 400, request, env);
  // 自动识别的类别（auto_categories / auto_category）平时由入库流程写入。前端删除一个
  // 类别时必须能同时清掉它，否则 themeCategoryList() 会把 auto 分类合并回来，看起来
  // 「删了又复活」。只有显式带这两个字段时才覆盖，旧客户端不带字段时保持原样。
  const hasAutoCategories = Object.hasOwn(payload, "auto_categories");
  const hasAutoCategory = Object.hasOwn(payload, "auto_category");
  let updated;
  await mutateLibraryIndex(env,async data=>{
    const target=data.records.find(item=>item.kind===kind && String(item.id)===String(id));
    if(!target)throw problem(404,'资源记录不存在');
    if(reference && reference!==target.record_sha256)throw problem(409,'这条记录已被其他设备修改，请刷新资源库后重试');
    const record={...target};delete record.record_sha256;
  const displayName = normalizeAssetClassification(payload.name);
  updated = {
    ...record,
    ...previewUpdates,
    ...(displayName ? {name: displayName} : {}),
    ...Object.fromEntries(["author", "style"].filter(key => Object.hasOwn(payload, key)).map(key => [key, normalizeAssetClassification(payload[key])])),
    tags: normalizeAssetTags(payload.tags ?? record.tags),
    categories: normalizeAssetTags(payload.categories ?? record.categories).map(item => item.slice(0, 24)),
    ...(kind === "theme" && hasAutoCategories ? {auto_categories: normalizeAssetTags(payload.auto_categories).map(item => item.slice(0, 24))} : {}),
    ...(kind === "theme" && hasAutoCategory ? {auto_category: normalizeAssetClassification(payload.auto_category)} : {}),
    updated_at: new Date().toISOString(),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(updated));
  const sha = await digestHex(bytes);
  const key = `records/${sha}.json`;
  await env.ASSETS.put(key, bytes, {httpMetadata: {contentType: "application/json; charset=utf-8"}});
  updated.record_sha256=sha;
  data.records=data.records.map(item=>indexRecordId(item)===indexRecordId(updated)?updated:item);
  });
  return json({ok: true, item: updated}, 200, request, env);
}

function referencedObjectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) { value.forEach(item => referencedObjectKeys(item, keys)); return keys; }
  if (value && typeof value === "object") { Object.entries(value).forEach(([key, item]) => {
    if (key === "record_sha256" && /^[a-f0-9]{64}$/i.test(String(item || ""))) keys.add(`records/${String(item).toLowerCase()}.json`);
    referencedObjectKeys(item, keys);
  }); return keys; }
  if (typeof value !== "string") return keys;
  let path = value;
  if (/^https?:\/\//i.test(path)) { try { path = new URL(path).pathname; } catch { return keys; } }
  path = path.split(/[?#]/)[0];
  if (/^\/?(originals|compressed|fonts|previews|assets|records)\//.test(path)) path = '/api/objects/' + path.replace(/^\//, '');
  const spec = objectSpec(path);
  if (spec && spec.kind !== 'staging') keys.add(spec.key);
  return keys;
}

async function listAllRecordEntries(env) {
  const {data}=await loadLibraryIndex(env);return data.records.map(record=>({key:`records/${record.record_sha256}.json`,record}));
}

async function scanRecordEntries(env) {
  const entries = [];
  let cursor;
  do {
    const listing = await env.ASSETS.list({prefix: "records/", cursor, limit: MAX_LIST_RECORDS});
    const loaded = await mapConcurrent(listing.objects || [], 16, async item => {
      const object = await env.ASSETS.get(item.key);
      if (!object) return null;
      try {
        const record = JSON.parse(await object.text());
        return record && typeof record === "object" ? {key: item.key, record} : null;
      } catch { return null; }
    });
    entries.push(...loaded.filter(Boolean));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return entries;
}

async function deleteLibraryRecords(request,env) {
  if(!originAllowed(request,env,{write:true}) || !checkWriteToken(request,env))return json({error:'删除需要访问口令'},401,request,env);
  const payload=await request.json(),items=Array.isArray(payload?.items)?payload.items:[];
  if(!items.length || items.length>100)return json({error:'请提供 1–100 个待删除记录'},400,request,env);
  const targets=new Set(items.filter(x=>['theme','font','asset'].includes(x?.kind)&&x.id).map(indexRecordId));
  const result=await mutateLibraryIndex(env,data=>{
    const matched=data.records.filter(x=>targets.has(indexRecordId(x))),remaining=data.records.filter(x=>!targets.has(indexRecordId(x)));
    const refs=new Set();remaining.forEach(x=>referencedObjectKeys(x,refs));
    const keys=new Set();matched.forEach(x=>referencedObjectKeys(x,keys));
    const candidates=[...keys].filter(x=>!refs.has(x));
    // Keep a recovery window. Physical deletion runs only from a reviewed GC plan.
    const at=new Date().toISOString();
    data.garbage=[...(data.garbage||[]),...candidates.map(key=>({key,at}))];data.records=remaining;
    return {ok:true,deleted:matched.map(({kind,id})=>({kind,id})),retainedShared:[...keys].filter(x=>refs.has(x)),deferredObjects:candidates,failed:[]};
  });
  return json(result,200,request,env);
}

/**
 * Prefix-only private RED processing. The image payload is plaintext, so only
 * the authenticated header + encrypted manifest cross the network. The browser
 * keeps every resource byte locally and reassembles the package after the
 * Worker re-seals the manifest with new hashes and offsets.
 */
function requirePrivateWrite(request, env) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "加密目录接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  return null;
}

async function privateDirectory(request, env) {
  const denied = requirePrivateWrite(request, env);
  if (denied) return denied;
  let payload;
  try { payload = await request.json(); } catch { return json({error: "目录请求不是有效 JSON"}, 400, request, env); }
  try {
    const prefix = base64Bytes(payload?.prefix_base64, "prefix_base64");
    if (prefix.length > PRIVATE_MAX_MANIFEST + 65536 + 8) return json({error: "加密目录前缀过长"}, 413, request, env);
    const {manifest, manifestEnd} = await decryptPrivateManifest(prefix, env);
    if (manifestEnd !== prefix.length) throw new Error("加密目录前缀长度与清单不一致");
    const entries = manifest.entries.map(entry => ({path: entry.path, offset: entry.offset, length: entry.length, sha256: entry.sha256}));
    return json({ok: true, prefix_length: prefix.length, entries,
      permissions: manifest.permissions || {}, can_save_images: manifest.canSaveImages === true,
      restricted_enabled: manifest.restrictedEnabled === true}, 200, request, env);
  } catch (error) { return json({error: error?.message || "加密目录解析失败"}, 422, request, env); }
}

async function sealPrivatePrefix(request, env) {
  const denied = requirePrivateWrite(request, env);
  if (denied) return denied;
  let payload;
  try { payload = await request.json(); } catch { return json({error: "封包请求不是有效 JSON"}, 400, request, env); }
  const replacements = Array.isArray(payload?.replacements) ? payload.replacements : [];
  const configs = Array.isArray(payload?.configs) ? payload.configs : [];
  if (replacements.length > 3000 || configs.length > 3000) return json({error: "封包请求资源过多"}, 413, request, env);
  try {
    const prefix = base64Bytes(payload.prefix_base64, "prefix_base64");
    const {header, manifest, manifestEnd} = await decryptPrivateManifest(prefix, env);
    if (manifestEnd !== prefix.length) throw new Error("加密目录前缀长度与清单不一致");
    const byPath = new Map(manifest.entries.map(entry => [entry.path, entry]));
    const hashReplacements = new Map();
    const pathReplacements = new Map();
    const extensionReplacements = new Map();
    const changed = new Map();
    for (const item of replacements) {
      if (!item || typeof item !== "object") throw new Error("replacement 格式无效");
      const entry = byPath.get(item.path);
      if (!entry) throw new Error(`找不到待替换资源：${item.path}`);
      const oldSha = String(entry.sha256).toLowerCase();
      if (String(item.old_sha256 || "").toLowerCase() !== oldSha) throw new Error(`资源 SHA-256 校验失败：${item.path}`);
      if (!/^[a-f0-9]{64}$/i.test(String(item.new_sha256 || ""))) throw new Error(`替换资源 SHA-256 无效：${item.path}`);
      if (!Number.isSafeInteger(item.new_length) || item.new_length < 1 || item.new_length > PRIVATE_MAX_RESOURCE) throw new Error(`替换资源长度无效：${item.path}`);
      const extension = String(item.new_extension || "").replace(/^\./, "").toLowerCase();
      if (extension && !["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) throw new Error(`不支持的图片扩展名：${item.path}`);
      const newPath = replacePrivateExtension(entry.path, extension);
      if (newPath !== entry.path) pathReplacements.set(entry.path, newPath);
      const effectiveExtension = newPath === entry.path ? pathExtensionSuffix(entry.path) : extension;
      const newSha = String(item.new_sha256).toLowerCase();
      hashReplacements.set(oldSha, newSha);
      hashReplacements.set(oldSha.toUpperCase(), newSha.toUpperCase());
      if (effectiveExtension) extensionReplacements.set(oldSha, effectiveExtension);
      if (item.old_md5 && item.new_md5) {
        const oldMd5 = String(item.old_md5).toLowerCase(), newMd5 = String(item.new_md5).toLowerCase();
        hashReplacements.set(oldMd5, newMd5);
        hashReplacements.set(oldMd5.toUpperCase(), newMd5.toUpperCase());
        if (effectiveExtension) extensionReplacements.set(oldMd5, effectiveExtension);
      }
      if (changed.has(entry.path)) throw new Error(`资源重复替换：${item.path}`);
      changed.set(entry.path, {newPath, newSha, newLength: item.new_length});
    }
    const configByPath = new Map();
    const configShaByPath = new Map();
    const outputConfigs = [];
    let mappedTotal = 0;
    for (const item of configs) {
      if (!item || typeof item !== "object" || !byPath.has(item.path)) throw new Error("配置资源路径无效");
      if (!String(item.path).toLowerCase().endsWith(".json")) throw new Error("配置资源不是 JSON");
      const bytes = base64Bytes(item.bytes_base64, `configs ${item.path}`);
      if (item.mapped) {
        // 浏览器已经改好引用：大 schema 在这里 JSON.parse 会撞 CPU 上限，所以只
        // 校验形状、登记字节与哈希，映射规则与 mapPrivateRefs 完全一致。
        if (bytes.length > PRIVATE_MAX_MAPPED_CONFIG) throw new Error(`配置资源过大：${item.path}`);
        mappedTotal += bytes.length;
        if (mappedTotal > PRIVATE_MAX_MAPPED_TOTAL) throw new Error("配置资源总量超过处理上限");
        const sha = String(item.sha256 || "").toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error(`配置资源 SHA-256 无效：${item.path}`);
        configByPath.set(item.path, bytes);
        configShaByPath.set(item.path, sha);
        continue;
      }
      if (bytes.length > PRIVATE_MAX_CONFIG) throw new Error(`配置资源过大：${item.path}（超过 1 MB 的配置需由客户端先映射引用后上传）`);
      let document;
      try { document = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`配置资源无法解析：${item.path}`); }
      const mapped = mapPrivateRefs(document, hashReplacements, pathReplacements, extensionReplacements, item.path);
      const output = new TextEncoder().encode(JSON.stringify(mapped));
      configByPath.set(item.path, output);
      configShaByPath.set(item.path, await digestHex(output));
      outputConfigs.push({path: item.path, bytes_base64: base64String(output)});
    }
    const newManifest = cloneJson(manifest);
    const outputEntries = [];
    let cursor = 0;
    const seen = new Set();
    for (const entry of newManifest.entries) {
      const sourcePath = entry.path;
      const sourceOffset = entry.offset;
      const change = changed.get(sourcePath);
      const configBytes = configByPath.get(sourcePath);
      if (change) {
        entry.path = change.newPath;
        entry.length = change.newLength;
        entry.sha256 = change.newSha;
      } else if (configBytes) {
        entry.length = configBytes.length;
        entry.sha256 = configShaByPath.get(sourcePath) || await digestHex(configBytes);
      }
      if (seen.has(entry.path)) throw new Error("重封后的资源路径冲突");
      seen.add(entry.path);
      entry.offset = cursor;
      cursor += entry.length;
      if (!Number.isSafeInteger(cursor) || cursor > 256 * 1024 * 1024) throw new Error("重封后的资源总长越界");
      outputEntries.push({path: entry.path, source_path: sourcePath, source_offset: sourceOffset, offset: entry.offset, length: entry.length, sha256: entry.sha256, config: Boolean(configBytes), replaced: Boolean(change)});
    }
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const nextManifest = new TextEncoder().encode(JSON.stringify(newManifest));
    const key = await importPrivateKey(env);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: nonce}, key, nextManifest));
    const nextHeader = {...header, manifestNonce: base64String(nonce), manifestLength: encrypted.length};
    const headerBytes = new TextEncoder().encode(JSON.stringify(nextHeader));
    if (headerBytes.length > 65536 || encrypted.length > PRIVATE_MAX_MANIFEST) throw new Error("重封后的目录超过处理上限");
    const nextPrefix = new Uint8Array(8 + headerBytes.length + encrypted.length);
    nextPrefix.set(PRIVATE_RED_MAGIC, 0);
    new DataView(nextPrefix.buffer).setUint32(4, headerBytes.length, false);
    nextPrefix.set(headerBytes, 8);
    nextPrefix.set(encrypted, 8 + headerBytes.length);
    return json({ok: true, prefix_base64: base64String(nextPrefix), prefix_length: nextPrefix.length,
      entries: outputEntries, configs: outputConfigs, payload_length: cursor,
      total_length: nextPrefix.length + cursor}, 200, request, env);
  } catch (error) { return json({error: error?.message || "加密 RED 封包失败"}, 422, request, env); }
}

function jobKey(id) { return `${JOBS_PREFIX}${id}.json`; }
function safeJobId(value) { return /^[a-f0-9]{8,64}$/.test(String(value || "")) ? String(value) : ""; }

async function listJobs(request, env) {
  if (!originAllowed(request, env)) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  const listed = await env.ASSETS.list({prefix: JOBS_PREFIX, limit: 200});
  const loaded = await mapConcurrent(listed.objects || [], 16, async item => {
    const object = await env.ASSETS.get(item.key);
    if (!object) return null;
    try { const job = JSON.parse(await object.text()); return job && typeof job === "object" ? job : null; } catch { return null; }
  });
  const items = loaded.filter(Boolean).sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).slice(0, 100);
  return json({items, ...LOCAL_JOB_NOTICE}, 200, request, env);
}

async function createJob(request, env) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "任务接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let payload;
  try { payload = await request.json(); } catch { return json({error: "任务数据不是有效 JSON"}, 400, request, env); }
  const id = [...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const now = new Date().toISOString();
  const total = Math.max(Number(payload?.total)||0,Array.isArray(payload?.source_keys)?payload.source_keys.length:0,Array.isArray(payload?.items)?payload.items.length:0);
  const job = {
    id, kind: String(payload?.kind || payload?.action || "upload").slice(0, 60),
    title: String(payload?.title || "上传任务").slice(0, 160),
    status: payload?.upload_complete === false ? "uploading" : "queued", stage: "等待处理", completed: 0, failed: 0, total,
    items: Array.isArray(payload?.items) ? payload.items.slice(0, 1000).map(item => String(item).slice(0, 200)) : [],
    source_keys: Array.isArray(payload?.source_keys) ? payload.source_keys.slice(0, 1000).map(item => String(item).slice(0, 600)) : [],
    done_keys: [], upload_complete: payload?.upload_complete !== false,
    uploads: Array.isArray(payload?.uploads) ? payload.uploads.slice(0,1000).map(x=>({name:String(x.name||'').slice(0,200),key:String(x.key||'').slice(0,600)})) : [],
    // The device that staged the batch already accepted "process this later",
    // so the next page load may finish compression without asking again.
    auto_commit: payload?.auto_commit === true,
    device: String(payload?.device || "").slice(0, 80),
    created_at: now, updated_at: now,
  };
  await env.ASSETS.put(jobKey(id), new TextEncoder().encode(JSON.stringify(job)), {httpMetadata: {contentType: "application/json"}});
  return json({ok: true, job}, 201, request, env);
}

async function updateJob(request, env, id, attempt=0) {
  if (!safeJobId(id)) return json({error: "任务编号无效"}, 400, request, env);
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "任务接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  const object = await env.ASSETS.get(jobKey(id));
  if (!object) return json({error: "任务不存在"}, 404, request, env);
  let patch;
  try { patch = await request.json(); } catch { return json({error: "任务更新不是有效 JSON"}, 400, request, env); }
  let job;
  try { job = JSON.parse(await object.text()); } catch { return json({error: "任务记录损坏"}, 409, request, env); }
  if (job.lease?.until > Date.now() && patch.owner !== job.lease.owner) return json({error:'其他设备正在处理此任务，请稍后接管'},409,request,env);
  if(patch.owner)job.lease={owner:String(patch.owner).slice(0,80),until:Date.now()+120000};
  if(patch.release===true || ['completed','partial','failed'].includes(patch.status))delete job.lease;
  const previousDone=job.done_keys||[];
  // `current` carries the item being processed right now (theme/font name);
  // without it the job list only showed "0 / 1" and users could not tell what
  // the device was actually working on.
  for (const key of ["title", "stage", "current", "status", "result", "error"]) {
    if (patch[key] !== undefined) job[key] = typeof patch[key] === "string" ? patch[key].slice(0, 2000) : patch[key];
  }
  for (const key of ["completed", "failed", "total"]) {
    if (Number.isFinite(Number(patch[key]))) job[key] = Math.max(0, Number(patch[key]));
  }
  for(const key of ['items','source_keys','done_keys'])if(Array.isArray(patch[key]))job[key]=patch[key].slice(0,1000).map(x=>String(x).slice(0,600));
  if(Array.isArray(patch.done_keys)) {job.done_keys=[...new Set([...previousDone,...patch.done_keys])];job.completed=Math.max(job.completed||0,job.done_keys.length);}
  if(typeof patch.upload_complete==='boolean')job.upload_complete=patch.upload_complete;
  job.updated_at = new Date().toISOString();
  const saved=await env.ASSETS.put(jobKey(id),new TextEncoder().encode(JSON.stringify(job)),{onlyIf:object.etag?{etagMatches:object.etag}:undefined,httpMetadata:{contentType:'application/json'}});
  if(saved===null){if(attempt<3)return updateJob(new Request(request.url,{method:'PATCH',headers:request.headers,body:JSON.stringify(patch)}),env,id,attempt+1);return json({error:'任务已被其他设备更新，请刷新后重试'},409,request,env);}
  return json({ok: true, job}, 200, request, env);
}

async function deleteJob(request, env, id) {
  if (!safeJobId(id)) return json({error: "任务编号无效"}, 400, request, env);
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "任务接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  if (typeof env.ASSETS.delete !== "function") return json({error: "R2 不支持删除"}, 405, request, env);
  await env.ASSETS.delete(jobKey(id));
  return json({ok: true, deleted: id}, 200, request, env);
}

/** Optional 123 web-protocol backup. The session token comes from the device
 * on each request and is never stored server-side; only the fixed 123 hosts
 * receive it. Presigned transfer URLs must be public HTTPS and never get it. */
function pan123Token(value) {
  const token = String(value || "").trim().replace(/^Bearer\s+/i, "");
  if (!token || token.length > 16384 || /\s/.test(token)) throw new Error("123 会话 Token 无效");
  return token;
}
/** Header values are ISO-8859-1 only, so Chinese theme names and folder names
 * travel percent-encoded. Plain ASCII (and legacy clients that never encoded)
 * decode to themselves; malformed escapes fall back to the raw value. */
function headerText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const raw = String(value);
  try { return decodeURIComponent(raw); } catch { return raw; }
}
function safeTransferUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("123 返回了无效的传输地址"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
      || host === "localhost" || host.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new Error("123 返回了不安全的传输地址");
  }
  return url.href;
}
async function pan123Request(token, path, {method = "POST", payload, params, fetchImpl = fetch} = {}) {
  const url = new URL(PAN123_API + path);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
  let response;
  try { response = await fetchImpl(url.href, {
    method, redirect: "manual",signal:AbortSignal.timeout(20000),
    headers: {
      "User-Agent": "RedGarden/1.0 (123 web backup)", platform: "web", "app-version": "3",
      Origin: "https://yun.123pan.cn", Referer: "https://yun.123pan.cn/",
      Accept: "application/json", Authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : {"Content-Type": "application/json"}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }); }catch(error){error.stage ||=path;throw error;}
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error("123 登录已过期或被拒绝，请在存储设置重新填写会话 Token"),{httpStatus:response.status,stage:path});
  if (!response.ok) throw Object.assign(new Error(`123 请求失败（HTTP ${response.status}）`),{httpStatus:response.status,stage:path});
  let body;
  try { body = await response.json(); } catch { throw new Error("123 未返回有效接口数据"); }
  if (!body || ![0, 200].includes(body.code)) throw Object.assign(new Error(`123 请求被拒绝（${body?.code ?? "unknown"}）`),{httpStatus:response.status,platformCode:body?.code,stage:path});
  return body.data && typeof body.data === "object" ? body.data : {};
}
async function pan123Find(token, parent, name, fetchImpl) {
  const data = await pan123Request(token, "/file/list/new", {method: "GET", fetchImpl, params: {
    driveId: 0, limit: 100, next: "0", orderBy: "file_id", orderDirection: "desc",
    parentFileId: String(parent), trashed: "false", SearchData: "", Page: 1,
    OnlyLookAbnormalFile: 0, event: "homeListFile", operateType: 4, inDirectSpace: "false",
  }});
  const items = Array.isArray(data.InfoList) ? data.InfoList : [];
  return items.find(item => item && String(item.FileName) === name) || null;
}
async function pan123Folder(token, path, fetchImpl) {
  let parent = 0;
  for (const name of String(path || "").split("/").filter(Boolean)) {
    if (name.length > 240 || name === "." || name === "..") throw new Error("123 备份目录名称无效");
    let found = await pan123Find(token, parent, name, fetchImpl);
    if (!found) {
      await pan123Request(token, "/file/upload_request", {fetchImpl, payload: {
        driveId: 0, etag: "", fileName: name, parentFileId: parent, size: 0, type: 1,
        duplicate: 0, NotReuse: true, event: "newCreateFolder", operateType: 1,
      }});
      found = await pan123Find(token, parent, name, fetchImpl);
    }
    if (!found || Number(found.Type) !== 1) throw new Error(`123 备份目录不可用：${name}`);
    parent = Number(found.FileId);
  }
  return parent;
}
// Read-only variant used by "测试连接": walk the configured folder without
// creating anything, so connecting never leaves a probe file in the account.
async function findPan123Folder(token, path, fetchImpl) {
  let parent = 0;
  for (const name of String(path || "").split("/").filter(Boolean)) {
    if (name.length > 240 || name === "." || name === "..") throw new Error("123 备份目录名称无效");
    const found = await pan123Find(token, parent, name, fetchImpl);
    if (!found || Number(found.Type) !== 1) return {exists: false, parent};
    parent = Number(found.FileId);
  }
  return {exists: true, parent};
}
/** 网页端账号密码登录 123：浏览器既拿不到 123 的跨域响应，也不该把密码交给
 * 一个陌生页面，所以这一次登录请求由 Worker 代发，成功只回会话 Token。
 * 密码只在这次请求的内存里过一遍——不写日志、不落 R2、不写 KV；返回体里也
 * 只有 token 和昵称。手机号与邮箱走 123 自己的两种表单形状。 */
const PAN123_SIGN_IN = "https://login.123pan.com/api/user/sign_in";
async function loginPan123(request, env, fetchImpl = fetch) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "123 登录需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let payload;
  try { payload = await request.json(); } catch { return json({error: "请求体不是有效 JSON"}, 400, request, env); }
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "");
  if (!username || !password) return json({error: "请填写 123 云盘账号和密码"}, 400, request, env);
  if (username.length > 120 || password.length > 200) return json({error: "账号或密码过长"}, 400, request, env);
  const isMail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
  const body = isMail ? {mail: username, password, type: 2} : {passport: username, password, remember: true};
  let response;
  try {
    response = await fetchImpl(PAN123_SIGN_IN, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", platform: "web", "app-version": "3",
        Origin: "https://yun.123pan.com", Referer: "https://yun.123pan.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return json({ok: false, error: "123 登录接口暂时不可达，请稍后重试"}, 502, request, env);
  }
  let data = {};
  try { data = await response.json(); } catch {
    return json({ok: false, error: `123 登录返回了非 JSON 响应（HTTP ${response.status}）`}, 502, request, env);
  }
  const code = Number(data?.code);
  const token = String(data?.data?.token || "");
  if (![0, 200].includes(code) || !token) {
    // Worker 代发时请求从 Cloudflare 出口出去，123 多半按「海外登录」处理并
    // 要求图形验证码，所以这里的失败几乎都不是账号密码本身的问题。说明白，
    // 好让用户改走浏览器直连或扫码。
    const detail = String(data?.message || "").trim();
    const error = detail || "123 没有接受这次登录。Worker 代发使用海外出口 IP，123 通常会要求图形验证码——请改用网页端的「扫码连接」或账号密码浏览器直连登录。";
    return json({ok: false, error, code}, 422, request, env);
  }
  // 顺手取昵称，前端就能只说「已连接 xxx」，不必把文件清单铺出来。
  let nickname = "";
  try {
    const user = await pan123Request(token, "/user/info", {method: "GET", fetchImpl});
    nickname = String(user?.Nickname || user?.nickname || user?.UserName || user?.userName || "");
  } catch {}
  return json({ok: true, provider: "123pan", token, nickname, channel: isMail ? "mail" : "passport"}, 200, request, env);
}
async function verifyPan123(request, env, fetchImpl = fetch) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "123 连接校验需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let token, folder;
  try {
    token = pan123Token(request.headers.get("X-Pan123-Token"));
    const rawFolder = request.headers.get("X-Pan123-Folder");
    folder = rawFolder === null ? "Red-Garden-Backup" : headerText(rawFolder).trim().replace(/^\/+|\/+$/g, "");
  } catch (error) { return json({error: error.message}, 400, request, env); }
  try {
    const data = await pan123Request(token, "/file/list/new", {method: "GET", fetchImpl, params: {
      driveId: 0, limit: 100, next: "0", orderBy: "file_id", orderDirection: "desc",
      parentFileId: "0", trashed: "false", SearchData: "", Page: 1,
      OnlyLookAbnormalFile: 0, event: "homeListFile", operateType: 4, inDirectSpace: "false",
    }});
    const items = Array.isArray(data.InfoList) ? data.InfoList : [];
    const folderInfo = await findPan123Folder(token, folder, fetchImpl);
    let nickname = "";
    try {
      const user = await pan123Request(token, "/user/info", {method: "GET", fetchImpl});
      nickname = String(user?.Nickname || user?.nickname || user?.UserName || user?.userName || "");
    } catch {}
    return json({ok: true, provider: "123pan", connected: true, folder,
      folderExists: folderInfo.exists, rootItems: items.length, nickname}, 200, request, env);
  } catch (error) { return json({ok: false, error: error?.message || "123 连接校验失败"}, 422, request, env); }
}
/** Read-only inventory of the configured 123 backup directory. It never
 * creates a folder or writes a file, and is auth-gated like the write route
 * because it exposes the contents of the user's cloud drive. */
async function listPan123Backups(request, env, fetchImpl = fetch) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "123 备份清单需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let token, folder;
  try {
    token = pan123Token(request.headers.get("X-Pan123-Token"));
    const rawFolder = request.headers.get("X-Pan123-Folder");
    folder = rawFolder === null ? "Red-Garden-Backup" : headerText(rawFolder).trim().replace(/^\/+|\/+$/g, "");
  } catch (error) { return json({error: error.message}, 400, request, env); }
  try {
    const {exists, parent} = await findPan123Folder(token, folder, fetchImpl);
    if (!exists) return json({ok: true, provider: "123pan", connected: true, folder, folderExists: false, items: [], fileCount: 0, totalBytes: 0, truncated: false}, 200, request, env);
    const items = [];
    let next = "0", pages = 0;
    while (pages < 10) {
      const data = await pan123Request(token, "/file/list/new", {method: "GET", fetchImpl, params: {
        driveId: 0, limit: 100, next, orderBy: "file_id", orderDirection: "desc",
        parentFileId: String(parent), trashed: "false", SearchData: "", Page: 1,
        OnlyLookAbnormalFile: 0, event: "homeListFile", operateType: 4, inDirectSpace: "false",
      }});
      const list = Array.isArray(data.InfoList) ? data.InfoList : [];
      for (const item of list) {
        if (!item || !item.FileName) continue;
        items.push({
          name: String(item.FileName), type: Number(item.Type) === 1 ? "folder" : "file",
          bytes: Number(item.Size) || 0, etag: String(item.Etag || ""), fileId: String(item.FileId || ""),
          created_at: String(item.CreateTime || item.CreateAt || ""), updated_at: String(item.UpdateTime || item.UpdateAt || ""),
        });
      }
      const cursor = String(data.Next ?? "-1");
      if (!list.length || cursor === "-1" || cursor === "" || cursor === "0" || cursor === next) break;
      next = cursor;
      pages++;
    }
    const files = items.filter(item => item.type === "file");
    return json({ok: true, provider: "123pan", connected: true, folder, folderExists: true,
      items, fileCount: files.length, totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
      truncated: pages >= 10}, 200, request, env);
  } catch (error) { return json({ok: false, error: error?.message || "123 备份清单读取失败"}, 422, request, env); }
}
async function savePan123Result(env,source,result,error,md5) {
  if(!source)return null;
  return mutateLibraryIndex(env,async data=>{
    const current=data.records.find(item=>item.kind==='theme'&&item.id===source.id);
    if(!current||current.original_url!==source.original_url)return null;
    const updated={...current,original_md5:md5,original_123:result||current.original_123||null,original_123_error:result||current.original_123?.key?'':error||'',updated_at:new Date().toISOString()};delete updated.record_sha256;
    const bytes=new TextEncoder().encode(JSON.stringify(updated)),sha=await digestHex(bytes);
    await env.ASSETS.put('records/'+sha+'.json',bytes,{httpMetadata:{contentType:'application/json'}});
    updated.record_sha256=sha;data.records[data.records.indexOf(current)]=updated;return updated;
  });
}
// Browser-direct backup calls this only to persist the RESULT of an upload the
// browser already performed against 123 over the user's own network. No file
// bytes pass through the Worker and no 123 API is proxied here, so there is no
// overseas Cloudflare egress to trigger 123's risk control. The token here is
// the SYNC_WRITE_TOKEN (same as every other library write), never the 123 session.
async function savePan123DirectResult(request, env) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "写回备份结果需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let payload;
  try { payload = await request.json(); } catch { throw problem(400, '备份结果不是有效 JSON'); }
  const themeId = String(payload?.theme_id || "");
  const md5 = String(payload?.md5 || "").toLowerCase();
  const error = String(payload?.error || "").slice(0, 500);
  const result = payload?.result && typeof payload.result === "object" ? payload.result : null;
  if (!themeId || !/^[a-f0-9]{32}$/.test(md5)) return json({error: "缺少主题 id 或有效的 MD5 校验值"}, 400, request, env);
  const source = (await latestLibraryRecords(env, 'theme')).find(item => String(item.id) === themeId);
  if (!source) return json({error: "主题记录不存在"}, 404, request, env);
  const item = await savePan123Result(env, source, result?.ok ? result : null, error || (result?.ok ? "" : "123 直连备份未完成"), md5);
  return json({ok: true, item}, 200, request, env);
}
async function backupOriginalTo123(request, env, fetchImpl = fetch) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "123 备份接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let token, name, folder, etag,sourceRecord,bytes;
  try {
    token = pan123Token(request.headers.get("X-Pan123-Token"));
    name = headerText(request.headers.get("X-Pan123-Filename")).trim();
    const rawFolder = request.headers.get("X-Pan123-Folder");
    // An explicitly empty folder means the 123 root; an absent header uses
    // the conventional backup directory.
    folder = rawFolder === null ? "Red-Garden-Backup" : headerText(rawFolder).trim().replace(/^\/+|\/+$/g, "");
    etag = String(request.headers.get("X-Pan123-Etag") || "").toLowerCase();
  } catch (error) { return json({error: error.message}, 400, request, env); }
  if((request.headers.get('Content-Type')||'').includes('application/json')) {
    let payload;try{payload=await request.json();}catch{throw problem(400,'备份请求不是有效 JSON');}
    sourceRecord=(await latestLibraryRecords(env,'theme')).find(item=>item.id===payload.theme_id);
    if(!sourceRecord)throw problem(404,'主题记录不存在');
    const spec=downloadObjectSpec(sourceRecord.original_url);
    if(!spec||!['originals','compressed'].includes(spec.kind))throw problem(400,'没有可用于备份的 R2 原包');
    etag=sourceRecord.original_md5||etag;name=name||sourceRecord.source_name||redDownloadLabel(sourceRecord)+'.red';
    if(!/^[a-f0-9]{32}$/.test(etag))throw problem(400,'旧记录缺少 MD5 校验，请先补齐校验再重试');
    const object=await env.ASSETS.get(spec.key);if(!object)throw problem(404,'R2 原包不存在');
    if(object.size>maxUpload(env))throw problem(413,'原包大小超出限制');
    bytes=new Uint8Array(await new Response(object.body).arrayBuffer());
  } else bytes=new Uint8Array(await request.arrayBuffer());
  if (!name || name.length > 240 || name.includes('/') || name.includes('\\') || !/\.red$/i.test(name)) return json({error:'123 备份文件名无效'},400,request,env);
  if(!/^[a-f0-9]{32}$/.test(etag))return json({error:'123 备份缺少原包 MD5 校验值'},400,request,env);
  if(!bytes.length||bytes.length>maxUpload(env))return json({error:'123 备份文件大小超出限制'},413,request,env);
  const reply=async(result,status=200)=>{
    const item=await savePan123Result(env,sourceRecord,status===200?result:null,result.error,etag);
    return json({...result,...(item?{item}:{})},status,request,env);
  };
  try {
    const parent = await pan123Folder(token, folder, fetchImpl);
    const existing = await pan123Find(token, parent, name, fetchImpl);
    if (existing) {
      if (Number(existing.Type) !== 0 || Number(existing.Size) !== bytes.length || String(existing.Etag || "").toLowerCase() !== etag) {
        throw new Error("123 备份目录已有同名但不同的文件，未覆盖");
      }
      return reply({ok: true, provider: "123pan", key: folder ? `${folder}/${name}` : name, fileId: String(existing.FileId), bytes: bytes.length, sha256: await digestHex(bytes), reused: true});
    }
    const info = await pan123Request(token, "/file/upload_request", {fetchImpl, payload: {
      driveId: 0, duplicate: 0, etag, fileName: name, parentFileId: parent, size: bytes.length, type: 0,
    }});
    if (!info.Reuse) {
      if (!info.Bucket || !info.Key || !info.StorageNode || !info.FileId) throw new Error("123 未返回完整上传参数，原包仍保留在 R2");
      const common = {StorageNode: info.StorageNode, bucket: info.Bucket, key: info.Key, uploadId: String(info.UploadId || "")};
      const parts = Math.max(1, Math.ceil(bytes.length / PAN123_CHUNK));
      for (let number = 1; number <= parts; number++) {
        const auth = await pan123Request(token, parts === 1 ? "/file/s3_upload_object/auth" : "/file/s3_repare_upload_parts_batch", {fetchImpl, payload: {...common, partNumberStart: number, partNumberEnd: number + 1}});
        const url = safeTransferUrl(auth?.presignedUrls?.[String(number)]);
        const chunk = bytes.subarray((number - 1) * PAN123_CHUNK, Math.min(bytes.length, number * PAN123_CHUNK));
        const upload = await fetchImpl(url, {method: "PUT", body: chunk, redirect: "manual",signal:AbortSignal.timeout(90000)});
        if (!upload.ok) throw new Error(`123 分块上传失败（HTTP ${upload.status}）`);
      }
      await pan123Request(token, "/file/upload_complete/v2", {fetchImpl, payload: {...common, fileId: info.FileId, fileSize: bytes.length, isMultipart: parts > 1}});
    }
    const stored = await pan123Find(token, parent, name, fetchImpl);
    if (!stored || Number(stored.Type) !== 0 || Number(stored.Size) !== bytes.length || String(stored.Etag || "").toLowerCase() !== etag) {
      throw new Error("123 尚未确认原包落盘，未记为成功；R2 副本仍在");
    }
    return reply({ok: true, provider: "123pan", key: folder ? `${folder}/${name}` : name, fileId: String(stored.FileId), bytes: bytes.length, sha256: await digestHex(bytes), reused: false});
  } catch (error) { return reply({error:error?.message||"123 备份失败",stage:error?.stage||"123-transfer",upstreamStatus:error?.httpStatus,platformCode:error?.platformCode},422); }
}

const LOCAL_PROCESSING_NOTICE = {
  mode: "browser-local",
  // Staged batches survive a closed tab because the queue lives in R2, and the
  // next page load on any device resumes them automatically. Image
  // recompression still needs a real canvas, which the free Workers runtime
  // does not provide, so it stays on the device.
  backgroundJobs: false,
  persistentJobs: true,
  autoResume: true,
  cloudCompression: false,
  message: "批次队列存在共享 R2：关掉页面不会丢，换一台设备或重开页面会自动继续。免费模式没有云端画布，图片压缩由设备浏览器执行。",
};
const LOCAL_JOB_NOTICE = {...LOCAL_PROCESSING_NOTICE};

async function maintenance(request,env) {
  if(!checkWriteToken(request,env))throw problem(401,'维护需要访问口令');
  const input=await request.json(),now=Date.now(),age=7*86400000;
  if(input.action==='plan') {
    const {data}=await loadLibraryIndex(env),refs=new Set();data.records.forEach(record=>referencedObjectKeys(record,refs));
    const explicit=new Map((data.garbage||[]).map(item=>[item.key,Date.parse(item.at)]));
    const candidates=[],held=[];
    for(const prefix of ['records/','previews/','originals/','compressed/','fonts/','assets/']) {
      let cursor;
      do {
        const listing=await env.ASSETS.list({prefix,cursor,limit:1000});
        for(const object of listing.objects||[]) {
          if(refs.has(object.key))continue;
          const uploaded=new Date(object.uploaded).getTime();
          const tracked=explicit.has(object.key),eligible=prefix==='records/'||prefix==='previews/'||tracked;
          if(eligible && Number.isFinite(uploaded) && now-uploaded>age && (!tracked || now-explicit.get(object.key)>age))candidates.push({key:object.key,etag:object.etag,bytes:object.size||0,reason:tracked?'已删除记录的无引用文件':'无引用旧预览或旧版本记录'});
          else held.push({key:object.key,reason:!eligible?'尚未入库的原文件：保留，建议先解析':'未满 7 天或无法确认时间：保留'});
        }
        cursor=listing.truncated?listing.cursor:undefined;
      }while(cursor);
    }
    const plan={id:crypto.randomUUID(),revision:data.revision,created_at:now,items:candidates.slice(0,50),remaining:Math.max(0,candidates.length-50),held:held.slice(0,100),held_count:held.length};
    await env.ASSETS.put('system/cleanup-'+plan.id+'.json',JSON.stringify(plan),{httpMetadata:{contentType:'application/json'}});
    return json(plan,200,request,env);
  }
  if(input.action!=='delete'||!/^[a-f\d-]{36}$/.test(input.id||''))throw problem(400,'清理请求无效');
  const planObject=await env.ASSETS.get('system/cleanup-'+input.id+'.json');if(!planObject)throw problem(404,'核对清单不存在，请重新生成');
  const plan=JSON.parse(await planObject.text());if(now-plan.created_at>1800000)throw problem(409,'清理清单已过期，请重新核对');
  let current=await loadLibraryIndex(env);if(current.data.revision!==plan.revision)throw problem(409,'资源库已有更改，请重新核对');
  if(current.data.maintenance?.until>now)throw problem(423,'其他设备正在清理');
  current.data.maintenance={owner:plan.id,until:now+60000};
  const locked=await env.ASSETS.put(LIBRARY_INDEX_KEY,JSON.stringify(current.data),{onlyIf:current.etag?{etagMatches:current.etag}:undefined,httpMetadata:{contentType:'application/json'},customMetadata:{maintenance_until:String(now+60000)}});
  if(locked===null)throw problem(409,'资源库已有更改，请重新核对');
  const deleted=[],skipped=[];
  try {
    const refs=new Set();current.data.records.forEach(record=>referencedObjectKeys(record,refs));
    await mapConcurrent(plan.items,4,async item=>{
      if(Date.now()>now+50000||refs.has(item.key)){skipped.push(item.key);return;}
      const head=await env.ASSETS.head(item.key);
      if(!head || !item.etag || head.etag!==item.etag || now-new Date(head.uploaded).getTime()<age){skipped.push(item.key);return;}
      await env.ASSETS.delete(item.key);deleted.push(item.key);
    });
  }finally{
    current=await loadLibraryIndex(env);
    if(current.data.maintenance?.owner===plan.id){delete current.data.maintenance;current.data.garbage=(current.data.garbage||[]).filter(item=>!deleted.includes(item.key));current.data.revision=crypto.randomUUID();await env.ASSETS.put(LIBRARY_INDEX_KEY,JSON.stringify(current.data),{onlyIf:current.etag?{etagMatches:current.etag}:undefined,httpMetadata:{contentType:'application/json'},customMetadata:{maintenance_until:'0'}});}
  }
  await env.ASSETS.delete('system/cleanup-'+plan.id+'.json');return json({ok:true,deleted,skipped},200,request,env);
}

async function routeRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    if (!originAllowed(request, env)) return response("", 403, request, env);
    return response("", 204, request, env);
  }
  if (url.pathname === "/healthz" && request.method === "GET") return json({ok: true}, 200, request, env);
  if (url.pathname === "/api/session" && request.method === "GET") {
    if (!originAllowed(request, env)) return json({error: "Origin 不在允许列表中"}, 403, request, env);
    const canWrite = checkWriteToken(request, env);
    return json({ok: canWrite, canWrite, privateLibrary:privateLibrary(env), requiresToken: Boolean(env.SYNC_WRITE_TOKEN), ...(canWrite?await readTicket(env):{})}, canWrite ? 200 : 401, request, env);
  }
  if (['GET','HEAD'].includes(request.method) && url.pathname.startsWith('/api/') && !await mayRead(request,env)) return json({error:'私有资源库，请先在存储设置导入配置或填写访问口令'},401,request,env,{'WWW-Authenticate':'Bearer'});
  if(url.pathname==='/api/maintenance' && request.method==='POST'){if(!originAllowed(request,env,{write:true}))throw problem(403,'Origin 不在允许列表中');return maintenance(request,env);}
  if(url.pathname==='/api/device-config' && ['GET','PUT'].includes(request.method))return deviceConfig(request,env);
  if (url.pathname === "/api/library" && request.method === "GET") return listRecords(request, env);
  if (url.pathname === "/api/themes" && request.method === "GET") return listRecords(request, env, "theme");
  if (url.pathname === "/api/fonts" && request.method === "GET") return listRecords(request, env, "font");
  if (url.pathname === "/api/assets" && request.method === "GET") return listRecords(request, env, "asset");
  if (url.pathname === "/api/download" && request.method === "GET") return downloadSelected(request, env);
  if (url.pathname === "/api/library" && request.method === "DELETE") return deleteLibraryRecords(request, env);
  if (url.pathname === "/api/private/repack" && request.method === "POST") return repackPrivateRed(request, env);
  if (url.pathname === "/api/private/directory" && request.method === "POST") return privateDirectory(request, env);
  if (url.pathname === "/api/private/seal" && request.method === "POST") return sealPrivatePrefix(request, env);
  if (url.pathname === "/api/storage/123/login" && request.method === "POST") return loginPan123(request, env);
  if (url.pathname === "/api/backup/123/verify" && request.method === "POST") return verifyPan123(request, env);
  if (url.pathname === "/api/backup/123/list" && request.method === "POST") return listPan123Backups(request, env);
  if(url.pathname==='/api/backup/123/from-r2'&&request.method==='POST'){
    if(!(request.headers.get('Content-Type')||'').includes('application/json'))return json({error:'此接口仅接受 R2 原包记录 JSON'},400,request,env);
    return backupOriginalTo123(request,env);
  }
  if (url.pathname === "/api/backup/123/result" && request.method === "POST") return savePan123DirectResult(request, env);
  if (url.pathname === "/api/backup/123" && request.method === "POST") return backupOriginalTo123(request, env);
  const classificationUpdate = url.pathname.match(/^\/api\/(assets|themes|fonts)\/([^/]+)$/);
  if (classificationUpdate && request.method === "PATCH") {
    const kind = classificationUpdate[1] === "assets" ? "asset" : classificationUpdate[1] === "themes" ? "theme" : "font";
    return updateRecordClassification(request, env, kind, decodeURIComponent(classificationUpdate[2]));
  }
  if (url.pathname === "/api/storage" && request.method === "GET") {
    if (!originAllowed(request, env)) return json({error: "Origin 不在允许列表中"}, 403, request, env);
    return json({provider: "cloudflare_r2", shared: true, publicReads: !privateLibrary(env), ...LOCAL_PROCESSING_NOTICE,
      maxUploadBytes: maxUpload(env)}, 200, request, env);
  }
  if (url.pathname === "/api/jobs" && request.method === "GET") return listJobs(request, env);
  if (url.pathname === "/api/jobs" && request.method === "POST") return createJob(request, env);
  const jobRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if(jobRoute && request.method==='GET') {const object=await env.ASSETS.get(jobKey(decodeURIComponent(jobRoute[1])));return object?json({job:JSON.parse(await object.text())},200,request,env):json({error:'任务不存在'},404,request,env);}
  if (jobRoute && request.method === "PATCH") return updateJob(request, env, decodeURIComponent(jobRoute[1]));
  if (jobRoute && request.method === "DELETE") return deleteJob(request, env, decodeURIComponent(jobRoute[1]));
  const spec = objectSpec(url.pathname);
  if (!spec || !["GET", "HEAD", "PUT", "POST", "DELETE"].includes(request.method)) return json({error: "Not found"}, 404, request, env);
  if (spec.kind === "staging" && request.method === "DELETE") return deleteStagingObject(request, env, spec);
  if (request.method === "PUT" || request.method === "POST") return putObject(request, env, spec);
  return getObject(request, env, spec);
}

export async function handle(request,env) {
  try{return await routeRequest(request,env);}catch(error){return json({error:error?.message||'请求失败'},error?.status||500,request,env);}
}
export default {fetch: handle};

export const __test = {configuredOrigins, corsHeaders, originAllowed, objectSpec, maxUpload, digestHex, base64Bytes, base64String, decryptPrivateManifest, repackPrivateRed, privateDirectory, sealPrivatePrefix, listJobs, createJob, updateJob, deleteJob, backupOriginalTo123, savePan123DirectResult, verifyPan123, listPan123Backups, loginPan123, downloadSelected, downloadEntries, crc32Bytes, headerText, deleteStagingObject,loadLibraryIndex,mutateLibraryIndex,readTicket,mayRead};
