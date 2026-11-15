/**
 * Free personal sync API for a GitHub Pages front end.
 *
 * R2 is used only as object storage. Browser clients never receive an R2
 * access key; this Worker is the R2 binding and validates object hashes before
 * accepting a write. Reads are intentionally public when the Worker URL is
 * known. Configure SYNC_WRITE_TOKEN before enabling browser uploads.
 */

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
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Content-Length,X-Pan123-Token,X-Pan123-Folder,X-Pan123-Filename,X-Pan123-Etag",
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
  if (!origin) return !write;
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

function objectSpec(pathname) {
  const match = pathname.match(/^\/api\/objects\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, kind, filename] = match;
  if (!KINDS.has(kind)) return null;
  const suffix = kind === "fonts" ? filename.match(/^([a-f0-9]{64})\.([a-z0-9]+)$/i) :
    kind === "assets" ? filename.match(/^([a-f0-9]{64})\.(svg|html)$/i) :
    kind === "staging" ? filename.match(/^([a-f0-9]{64})\.([a-z0-9]+)$/i) :
    filename.match(/^([a-f0-9]{64})\.(red|jpg|json)$/i);
  if (!suffix || suffix[1].length !== 64) return null;
  const sha = suffix[1].toLowerCase();
  const ext = suffix[2].toLowerCase();
  if (!SHA256.test(sha)) return null;
  if ((kind === "compressed" || kind === "originals") && ext !== "red") return null;
  if (kind === "previews" && ext !== "jpg") return null;
  if (kind === "records" && ext !== "json") return null;
  if (kind === "fonts" && !SAFE_EXT.has(ext)) return null;
  if (kind === "staging" && !STAGING_EXT.has(ext)) return null;
  if (kind === "assets" && !new Set(["svg", "html"]).has(ext)) return null;
  return {kind, sha, ext, filename, key: `${kind}/${sha}.${ext}`};
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
  return safe && /\.(?:png|jpe?g|webp|gif|img)$/i.test(String(path || "")) ? String(path).replace(/\.(?:png|jpe?g|webp|gif|img)$/i, `.${ext}`) : path;
}

function mapPrivateRefs(value, replacements, pathReplacements, extensionReplacements = new Map()) {
  if (Array.isArray(value)) return value.map(item => mapPrivateRefs(item, replacements, pathReplacements, extensionReplacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapPrivateRefs(item, replacements, pathReplacements, extensionReplacements)]));
  if (typeof value !== "string") return value;
  if (pathReplacements.has(value)) return pathReplacements.get(value);
  const exact = replacements.get(value) || replacements.get(value.toLowerCase());
  if (exact) return exact;
  const match = value.match(/^([a-f0-9]{32}|[a-f0-9]{64})(\.[A-Za-z0-9]+)?$/i);
  if (!match) return value;
  const mapped = replacements.get(match[1].toLowerCase());
  const extension = extensionReplacements.get(match[1].toLowerCase());
  return mapped ? mapped + (extension ? `.${extension}` : (match[2] || "")) : value;
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
      if (newExtension) extensionReplacements.set(oldSha.toLowerCase(), newExtension);
      replacements.set(oldSha, newSha);
      replacements.set(oldSha.toUpperCase(), newSha.toUpperCase());
      if (item.old_md5 && item.new_md5) { replacements.set(String(item.old_md5).toLowerCase(), String(item.new_md5).toLowerCase()); replacements.set(String(item.old_md5).toUpperCase(), String(item.new_md5).toUpperCase()); if (newExtension) extensionReplacements.set(String(item.old_md5).toLowerCase(), newExtension); }
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
  if (spec.kind === "assets") return spec.ext === "svg" ? "image/svg+xml" : "text/html; charset=utf-8";
  return "application/json; charset=utf-8";
}

async function putObject(request, env, spec) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "上传接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxUpload(env))) {
    return json({error: "上传文件超过大小限制"}, 413, request, env);
  }
  const data = await request.arrayBuffer();
  if (data.byteLength > maxUpload(env)) return json({error: "上传文件超过大小限制"}, 413, request, env);
  const actual = await digestHex(data);
  if (actual !== spec.sha) return json({error: "SHA-256 与对象路径不一致", actual}, 400, request, env);
  await env.ASSETS.put(spec.key, data, {httpMetadata: {contentType: contentType(spec)}});
  return json({ok: true, key: spec.key, sha256: actual, bytes: data.byteLength}, 201, request, env);
}

async function getObject(request, env, spec) {
  const object = await env.ASSETS.get(spec.key);
  if (!object) return json({error: "对象不存在"}, 404, request, env);
  const headers = new Headers(corsHeaders(request, env));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Content-Type", contentType(spec));
  if (object.httpMetadata?.contentType) headers.set("Content-Type", object.httpMetadata.contentType);
  if (spec.kind === "assets" && spec.ext === "html") headers.set("Content-Security-Policy", "sandbox");
  return new Response(object.body, {status: 200, headers});
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
function zipLocalHeader(name, crc, size) {
  return concatBytes([
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]), zipU16(20), zipU16(0x0800), zipU16(0),
    zipU16(0), zipU16(0), zipU32(crc), zipU32(size), zipU32(size),
    zipU16(name.length), zipU16(0), name,
  ]);
}
function zipCentralHeader(name, crc, size, offset) {
  return concatBytes([
    new Uint8Array([0x50, 0x4b, 0x01, 0x02]), zipU16(20), zipU16(20), zipU16(0x0800), zipU16(0),
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
async function readObjectBytes(object) {
  if (typeof object?.arrayBuffer === "function") return new Uint8Array(await object.arrayBuffer());
  if (object?.body) return new Uint8Array(await new Response(object.body).arrayBuffer());
  throw new Error("R2 对象没有可读取的数据");
}
async function latestLibraryRecords(env, kind = null) {
  const byId = new Map();
  let cursor;
  do {
    const listing = await env.ASSETS.list({prefix: "records/", cursor, limit: MAX_LIST_RECORDS});
    const loaded = await mapConcurrent(listing.objects || [], 16, async item => {
      const object = await env.ASSETS.get(item.key);
      if (!object) return null;
      try { return JSON.parse(await object.text()); } catch { return null; }
    });
    for (const record of loaded) {
      if (!record || typeof record !== "object" || !record.kind || !record.id) continue;
      if (kind && record.kind !== kind) continue;
      const key = `${record.kind}:${record.id}`;
      const current = byId.get(key);
      if (!current || String(record.updated_at || "") > String(current.updated_at || "")) byId.set(key, record);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return [...byId.values()];
}
// Mirrors downloadableFiles() in the front end so the archive layout stays the
// same in remote mode and in the browser-only fallback.
function downloadFileList(kind, record) {
  const raw = String(record?.file_name || record?.name || record?.family || record?.id || "item");
  const label = raw.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\0]/g, "_").slice(0, 90) || "item";
  const files = [];
  const add = (path, suffix) => { if (path && !files.some(item => item.path === path)) files.push({path, name: label + suffix}); };
  if (kind === "theme") {
    const compressed = record.compressed_url || record.library_url;
    add(compressed, ".red");
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
function downloadEntries(kind, records) {
  const entries = [], usedKeys = new Set(), usedNames = new Set();
  for (const record of records) {
    for (const file of downloadFileList(kind, record)) {
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
function streamZip(request, env, kind, entries) {
  const encoder = new TextEncoder();
  const manifest = {
    created_at: new Date().toISOString(), kind,
    files: entries.map(item => ({kind, id: item.record_id, name: item.original_name, path: item.name, source: item.path})),
  };
  const pending = [{name: "manifest.json", bytes: encoder.encode(JSON.stringify(manifest, null, 2))}, ...entries];
  const central = [];
  const errors = [];
  let offset = 0, cursor = 0, emitted = 0, finalized = false, finished = false;
  let chunks = [];
  const emit = entry => {
    const name = encoder.encode(entry.name), data = entry.bytes;
    if (name.length > 65535 || data.length > 0xffffffff || offset > 0xffffffff || emitted > 0xffff) throw new Error("批量下载超过普通 ZIP 上限");
    const crc = crc32Bytes(data), header = zipLocalHeader(name, crc, data.length);
    central.push(zipCentralHeader(name, crc, data.length, offset));
    offset += header.length + data.length;
    emitted++;
    const slices = [header];
    for (let start = 0; start < data.length; start += 65536) slices.push(data.subarray(start, Math.min(start + 65536, data.length)));
    if (data.length === 0) slices.push(new Uint8Array());
    return slices;
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (!chunks.length) {
          if (cursor < pending.length) {
            const item = pending[cursor++];
            if (item.key) {
              const object = await env.ASSETS.get(item.key);
              if (!object) { errors.push({path: item.path, name: item.name, error: "R2 对象不存在"}); continue; }
              item.bytes = await readObjectBytes(object);
            }
            chunks = emit(item);
          } else if (!finalized) {
            finalized = true;
            if (errors.length) {
              pending.push({name: "__errors.json", bytes: encoder.encode(JSON.stringify({skipped: errors}, null, 2))});
            }
          } else if (!finished) {
            finished = true;
            const centralBytes = concatBytes(central);
            chunks = [centralBytes, zipEndOfCentralDirectory(emitted, centralBytes.length, offset)];
          } else { controller.close(); return; }
        }
        controller.enqueue(chunks.shift());
      } catch (error) { controller.error(error); }
    },
  }, {highWaterMark: 1});
  const headers = new Headers(corsHeaders(request, env));
  headers.set("Content-Type", "application/zip");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Disposition", `attachment; filename="reeden-${kind}-${new Date().toISOString().slice(0, 10)}.zip"`);
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
  const entries = downloadEntries(kind, chosen);
  if (!entries.length) return json({error: "所选记录没有可下载的 R2 对象"}, 404, request, env);
  if (url.searchParams.get("probe") === "1") {
    return json({ok: true, kind, records: chosen.length, count: entries.length,
      files: entries.map(item => ({name: item.name, path: item.path}))}, 200, request, env);
  }
  return streamZip(request, env, kind, entries);
}

async function listRecords(request, env, wantedKind = null) {
  if (!originAllowed(request, env)) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || undefined;
  const listed = await env.ASSETS.list({prefix: "records/", cursor, limit: MAX_LIST_RECORDS});
  const loaded = await mapConcurrent(listed.objects || [], 16, async (item) => {
    const object = await env.ASSETS.get(item.key);
    if (!object) return null;
    try {
      const record = JSON.parse(await object.text());
      if (record && typeof record === "object" && (!wantedKind || record.kind === wantedKind)) return record;
    } catch {
      // A malformed record must not prevent the rest of the library loading.
    }
    return null;
  });
  const records = loaded.filter(Boolean);
  // `items` keeps the existing library UI contract; `records` is the clearer
  // name used by the standalone free-sync client.
  return json({records, items: records, cursor: listed.truncated ? listed.cursor : null}, 200, request, env);
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
  let cursor;
  do {
    const listing = await env.ASSETS.list({prefix: "records/", cursor, limit: MAX_LIST_RECORDS});
    for (const item of listing.objects || []) {
      const object = await env.ASSETS.get(item.key);
      if (!object) continue;
      let record;
      try { record = JSON.parse(await object.text()); } catch { continue; }
      if (!record || record.kind !== kind || String(record.id) !== String(id)) continue;
      const updated = {
        ...record,
        author: normalizeAssetClassification(payload.author),
        style: normalizeAssetClassification(payload.style),
        tags: normalizeAssetTags(payload.tags),
        updated_at: new Date().toISOString(),
      };
      const bytes = new TextEncoder().encode(JSON.stringify(updated));
      const sha = await digestHex(bytes);
      const key = `records/${sha}.json`;
      await env.ASSETS.put(key, bytes, {httpMetadata: {contentType: "application/json; charset=utf-8"}});
      if (item.key !== key && typeof env.ASSETS.delete === "function") await env.ASSETS.delete(item.key);
      updated.record_sha256 = sha;
      return json({ok: true, item: updated}, 200, request, env);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return json({error: "收藏记录不存在"}, 404, request, env);
}

function referencedObjectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) { value.forEach(item => referencedObjectKeys(item, keys)); return keys; }
  if (value && typeof value === "object") { Object.entries(value).forEach(([key, item]) => {
    if (key === "record_sha256" && /^[a-f0-9]{64}$/i.test(String(item || ""))) keys.add(`records/${String(item).toLowerCase()}.json`);
    referencedObjectKeys(item, keys);
  }); return keys; }
  if (typeof value !== "string") return keys;
  const pattern = /(?:https?:\/\/[^/]+)?\/?(?:api\/objects\/)?(originals|compressed|fonts|previews|assets|records)\/([a-f0-9]{64})\.(red|jpg|json|ttf|otf|woff2?|svg|html)(?:[?#].*)?$/i;
  const match = value.match(pattern);
  if (match) keys.add(`${match[1].toLowerCase()}/${match[2].toLowerCase()}.${match[3].toLowerCase()}`);
  return keys;
}

async function listAllRecordEntries(env) {
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

async function deleteLibraryRecords(request, env) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "删除接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let payload;
  try { payload = await request.json(); } catch { return json({error: "删除请求不是有效 JSON"}, 400, request, env); }
  const requested = Array.isArray(payload?.items) ? payload.items : [];
  if (!requested.length || requested.length > 100) return json({error: "请提供 1–100 个待删除记录"}, 400, request, env);
  const targets = new Set(requested.filter(item => item && ["theme", "font", "asset"].includes(item.kind) && String(item.id || "")).map(item => `${item.kind}:${item.id}`));
  if (!targets.size) return json({error: "删除记录格式无效"}, 400, request, env);
  const entries = await listAllRecordEntries(env);
  const matched = entries.filter(({record}) => targets.has(`${record.kind}:${record.id}`));
  if (!matched.length) return json({ok: true, deleted: [], missing: [...targets], retainedShared: []}, 200, request, env);
  const remainingRefs = new Set();
  entries.filter(entry => !matched.includes(entry)).forEach(entry => referencedObjectKeys(entry.record, remainingRefs));
  const deleteKeys = new Set(matched.map(entry => entry.key));
  const candidateObjects = new Set();
  matched.forEach(entry => referencedObjectKeys(entry.record, candidateObjects));
  const retainedShared = [];
  for (const key of candidateObjects) {
    if (key.startsWith("records/")) continue;
    if (remainingRefs.has(key)) retainedShared.push(key); else deleteKeys.add(key);
  }
  const failed = [];
  for (const key of deleteKeys) {
    try { if (typeof env.ASSETS.delete === "function") await env.ASSETS.delete(key); else failed.push({key, error: "R2 不支持删除"}); }
    catch (error) { failed.push({key, error: error?.message || "删除失败"}); }
  }
  return json({ok: failed.length === 0, deleted: matched.map(entry => ({kind: entry.record.kind, id: entry.record.id})), deletedObjects: [...deleteKeys].filter(key => !key.startsWith("records/")), retainedShared, failed}, failed.length ? 207 : 200, request, env);
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
      const newSha = String(item.new_sha256).toLowerCase();
      hashReplacements.set(oldSha, newSha);
      hashReplacements.set(oldSha.toUpperCase(), newSha.toUpperCase());
      if (extension) extensionReplacements.set(oldSha, extension);
      if (item.old_md5 && item.new_md5) {
        const oldMd5 = String(item.old_md5).toLowerCase(), newMd5 = String(item.new_md5).toLowerCase();
        hashReplacements.set(oldMd5, newMd5);
        hashReplacements.set(oldMd5.toUpperCase(), newMd5.toUpperCase());
        if (extension) extensionReplacements.set(oldMd5, extension);
      }
      if (changed.has(entry.path)) throw new Error(`资源重复替换：${item.path}`);
      changed.set(entry.path, {newPath, newSha, newLength: item.new_length});
    }
    const configByPath = new Map();
    const outputConfigs = [];
    for (const item of configs) {
      if (!item || typeof item !== "object" || !byPath.has(item.path)) throw new Error("配置资源路径无效");
      if (!String(item.path).toLowerCase().endsWith(".json")) throw new Error("配置资源不是 JSON");
      const bytes = base64Bytes(item.bytes_base64, `configs ${item.path}`);
      if (bytes.length > 1024 * 1024) throw new Error(`配置资源过大：${item.path}`);
      let document;
      try { document = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`配置资源无法解析：${item.path}`); }
      const mapped = mapPrivateRefs(document, hashReplacements, pathReplacements, extensionReplacements);
      const output = new TextEncoder().encode(JSON.stringify(mapped));
      configByPath.set(item.path, output);
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
        entry.sha256 = await digestHex(configBytes);
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
  const total = Number.isFinite(Number(payload?.total)) ? Math.max(0, Number(payload.total)) : 0;
  const job = {
    id, kind: String(payload?.kind || payload?.action || "upload").slice(0, 60),
    title: String(payload?.title || "上传任务").slice(0, 160),
    status: "queued", stage: "等待处理", completed: 0, failed: 0, total,
    items: Array.isArray(payload?.items) ? payload.items.slice(0, 100).map(item => String(item).slice(0, 200)) : [],
    source_keys: Array.isArray(payload?.source_keys) ? payload.source_keys.slice(0, 100).map(item => String(item).slice(0, 200)) : [],
    device: String(payload?.device || "").slice(0, 80),
    created_at: now, updated_at: now,
  };
  await env.ASSETS.put(jobKey(id), new TextEncoder().encode(JSON.stringify(job)), {httpMetadata: {contentType: "application/json"}});
  return json({ok: true, job}, 201, request, env);
}

async function updateJob(request, env, id) {
  if (!safeJobId(id)) return json({error: "任务编号无效"}, 400, request, env);
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "任务接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  const object = await env.ASSETS.get(jobKey(id));
  if (!object) return json({error: "任务不存在"}, 404, request, env);
  let patch;
  try { patch = await request.json(); } catch { return json({error: "任务更新不是有效 JSON"}, 400, request, env); }
  let job;
  try { job = JSON.parse(await object.text()); } catch { return json({error: "任务记录损坏"}, 409, request, env); }
  for (const key of ["title", "stage", "status", "result", "error"]) {
    if (patch[key] !== undefined) job[key] = typeof patch[key] === "string" ? patch[key].slice(0, 2000) : patch[key];
  }
  for (const key of ["completed", "failed", "total"]) {
    if (Number.isFinite(Number(patch[key]))) job[key] = Math.max(0, Number(patch[key]));
  }
  job.updated_at = new Date().toISOString();
  await env.ASSETS.put(jobKey(id), new TextEncoder().encode(JSON.stringify(job)), {httpMetadata: {contentType: "application/json"}});
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
  const response = await fetchImpl(url.href, {
    method, redirect: "manual",
    headers: {
      "User-Agent": "RedGarden/1.0 (123 web backup)", platform: "web", "app-version": "3",
      Origin: "https://yun.123pan.cn", Referer: "https://yun.123pan.cn/",
      Accept: "application/json", Authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : {"Content-Type": "application/json"}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (response.status === 401 || response.status === 403) throw new Error("123 登录已过期或被拒绝，请在存储设置重新填写会话 Token");
  if (!response.ok) throw new Error(`123 请求失败（HTTP ${response.status}）`);
  let body;
  try { body = await response.json(); } catch { throw new Error("123 未返回有效接口数据"); }
  if (!body || ![0, 200].includes(body.code)) throw new Error(`123 请求被拒绝（${body?.code ?? "unknown"}）`);
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
async function backupOriginalTo123(request, env, fetchImpl = fetch) {
  if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
  if (!checkWriteToken(request, env)) return json({error: "123 备份接口需要 SYNC_WRITE_TOKEN"}, 401, request, env, {"WWW-Authenticate": "Bearer"});
  let token, name, folder, etag;
  try {
    token = pan123Token(request.headers.get("X-Pan123-Token"));
    name = String(request.headers.get("X-Pan123-Filename") || "").trim();
    const rawFolder = request.headers.get("X-Pan123-Folder");
    // An explicitly empty folder means the 123 root; an absent header uses
    // the conventional backup directory.
    folder = rawFolder === null ? "Red-Garden-Backup" : String(rawFolder).trim().replace(/^\/+|\/+$/g, "");
    etag = String(request.headers.get("X-Pan123-Etag") || "").toLowerCase();
  } catch (error) { return json({error: error.message}, 400, request, env); }
  if (!name || name.length > 240 || name.includes("/") || name.includes("\\") || !/\.red$/i.test(name)) return json({error: "123 备份文件名无效"}, 400, request, env);
  if (!/^[a-f0-9]{32}$/.test(etag)) return json({error: "123 备份缺少原包 MD5 校验值"}, 400, request, env);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > maxUpload(env)) return json({error: "123 备份文件大小超出限制"}, 413, request, env);
  try {
    const parent = await pan123Folder(token, folder, fetchImpl);
    const existing = await pan123Find(token, parent, name, fetchImpl);
    if (existing) {
      if (Number(existing.Type) !== 0 || Number(existing.Size) !== bytes.length || String(existing.Etag || "").toLowerCase() !== etag) {
        throw new Error("123 备份目录已有同名但不同的文件，未覆盖");
      }
      return json({ok: true, provider: "123pan", key: folder ? `${folder}/${name}` : name, fileId: String(existing.FileId), bytes: bytes.length, sha256: await digestHex(bytes), reused: true}, 200, request, env);
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
        const upload = await fetchImpl(url, {method: "PUT", body: chunk, redirect: "manual"});
        if (!upload.ok) throw new Error(`123 分块上传失败（HTTP ${upload.status}）`);
      }
      await pan123Request(token, "/file/upload_complete/v2", {fetchImpl, payload: {...common, fileId: info.FileId, fileSize: bytes.length, isMultipart: parts > 1}});
    }
    const stored = await pan123Find(token, parent, name, fetchImpl);
    if (!stored || Number(stored.Type) !== 0 || Number(stored.Size) !== bytes.length || String(stored.Etag || "").toLowerCase() !== etag) {
      throw new Error("123 尚未确认原包落盘，未记为成功；R2 副本仍在");
    }
    return json({ok: true, provider: "123pan", key: folder ? `${folder}/${name}` : name, fileId: String(stored.FileId), bytes: bytes.length, sha256: await digestHex(bytes), reused: false}, 200, request, env);
  } catch (error) { return json({error: error?.message || "123 备份失败"}, 422, request, env); }
}

const LOCAL_PROCESSING_NOTICE = {
  mode: "browser-local",
  backgroundJobs: false,
  persistentJobs: true,
  message: "免费模式由当前浏览器本地处理；关闭页面或设备休眠后不会继续。上传进度会写入 R2，可在任意设备查看与续跑。",
};
const LOCAL_JOB_NOTICE = {...LOCAL_PROCESSING_NOTICE};

export async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    if (!originAllowed(request, env)) return response("", 403, request, env);
    return response("", 204, request, env);
  }
  if (url.pathname === "/healthz" && request.method === "GET") return json({ok: true}, 200, request, env);
  if (url.pathname === "/api/library" && request.method === "GET") return listRecords(request, env);
  if (url.pathname === "/api/themes" && request.method === "GET") return listRecords(request, env, "theme");
  if (url.pathname === "/api/fonts" && request.method === "GET") return listRecords(request, env, "font");
  if (url.pathname === "/api/assets" && request.method === "GET") return listRecords(request, env, "asset");
  if (url.pathname === "/api/download" && request.method === "GET") return downloadSelected(request, env);
  if (url.pathname === "/api/library" && request.method === "DELETE") return deleteLibraryRecords(request, env);
  if (url.pathname === "/api/private/repack" && request.method === "POST") return repackPrivateRed(request, env);
  if (url.pathname === "/api/private/directory" && request.method === "POST") return privateDirectory(request, env);
  if (url.pathname === "/api/private/seal" && request.method === "POST") return sealPrivatePrefix(request, env);
  if (url.pathname === "/api/backup/123" && request.method === "POST") return backupOriginalTo123(request, env);
  const classificationUpdate = url.pathname.match(/^\/api\/(assets|themes|fonts)\/([^/]+)$/);
  if (classificationUpdate && request.method === "PATCH") {
    const kind = classificationUpdate[1] === "assets" ? "asset" : classificationUpdate[1] === "themes" ? "theme" : "font";
    return updateRecordClassification(request, env, kind, decodeURIComponent(classificationUpdate[2]));
  }
  if (url.pathname === "/api/storage" && request.method === "GET") {
    if (!originAllowed(request, env)) return json({error: "Origin 不在允许列表中"}, 403, request, env);
    return json({provider: "cloudflare_r2", shared: true, publicReads: true, ...LOCAL_PROCESSING_NOTICE,
      maxUploadBytes: maxUpload(env)}, 200, request, env);
  }
  if (url.pathname === "/api/jobs" && request.method === "GET") return listJobs(request, env);
  if (url.pathname === "/api/jobs" && request.method === "POST") return createJob(request, env);
  const jobRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobRoute && request.method === "PATCH") return updateJob(request, env, decodeURIComponent(jobRoute[1]));
  if (jobRoute && request.method === "DELETE") return deleteJob(request, env, decodeURIComponent(jobRoute[1]));
  const spec = objectSpec(url.pathname);
  if (!spec || !["GET", "HEAD", "PUT", "POST"].includes(request.method)) return json({error: "Not found"}, 404, request, env);
  if (request.method === "PUT" || request.method === "POST") return putObject(request, env, spec);
  return getObject(request, env, spec);
}

export default {fetch: handle};

export const __test = {configuredOrigins, corsHeaders, originAllowed, objectSpec, maxUpload, digestHex, base64Bytes, base64String, decryptPrivateManifest, repackPrivateRed, privateDirectory, sealPrivatePrefix, listJobs, createJob, updateJob, deleteJob, backupOriginalTo123, downloadSelected, downloadEntries, crc32Bytes};
