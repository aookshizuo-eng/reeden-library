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
const KINDS = new Set(["originals", "compressed", "fonts", "previews", "records", "assets"]);
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
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Content-Length",
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
  return allowed.includes(origin);
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
    filename.match(/^([a-f0-9]{64})\.(red|jpg|json)$/i);
  if (!suffix || suffix[1].length !== 64) return null;
  const sha = suffix[1].toLowerCase();
  const ext = suffix[2].toLowerCase();
  if (!SHA256.test(sha)) return null;
  if ((kind === "compressed" || kind === "originals") && ext !== "red") return null;
  if (kind === "previews" && ext !== "jpg") return null;
  if (kind === "records" && ext !== "json") return null;
  if (kind === "fonts" && !SAFE_EXT.has(ext)) return null;
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

function mapPrivateRefs(value, replacements, pathReplacements) {
  if (Array.isArray(value)) return value.map(item => mapPrivateRefs(item, replacements, pathReplacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapPrivateRefs(item, replacements, pathReplacements)]));
  if (typeof value !== "string") return value;
  if (pathReplacements.has(value)) return pathReplacements.get(value);
  const exact = replacements.get(value) || replacements.get(value.toLowerCase());
  if (exact) return exact;
  const match = value.match(/^([a-f0-9]{32}|[a-f0-9]{64})(\.[A-Za-z0-9]+)?$/i);
  if (!match) return value;
  const mapped = replacements.get(match[1].toLowerCase());
  return mapped ? mapped + (match[2] || "") : value;
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
      const newPath = typeof item.new_path === "string" && item.new_path ? item.new_path : oldPath;
      if (newPath !== oldPath) pathReplacements.set(oldPath, newPath);
      replacements.set(oldSha, newSha);
      replacements.set(oldSha.toUpperCase(), newSha.toUpperCase());
      if (item.old_md5 && item.new_md5) { replacements.set(String(item.old_md5).toLowerCase(), String(item.new_md5).toLowerCase()); replacements.set(String(item.old_md5).toUpperCase(), String(item.new_md5).toUpperCase()); }
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
          const mapped = mapPrivateRefs(document, replacements, pathReplacements);
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
  if (spec.kind === "compressed" || spec.kind === "originals") return "application/octet-stream";
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

const LOCAL_PROCESSING_NOTICE = {
  mode: "browser-local",
  backgroundJobs: false,
  message: "免费模式由当前浏览器本地处理；关闭页面或设备休眠后不会继续，Worker 不创建后台任务。",
};

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
  if (url.pathname === "/api/private/repack" && request.method === "POST") return repackPrivateRed(request, env);
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
  if (url.pathname === "/api/jobs" && request.method === "GET") {
    if (!originAllowed(request, env)) return json({error: "Origin 不在允许列表中"}, 403, request, env);
    return json({items: [], ...LOCAL_PROCESSING_NOTICE}, 200, request, env);
  }
  if (url.pathname === "/api/jobs" && request.method === "POST") {
    if (!originAllowed(request, env, {write: true})) return json({error: "Origin 不在允许列表中"}, 403, request, env);
    return json({error: "此免费模式不提供云端后台队列", ...LOCAL_PROCESSING_NOTICE}, 501, request, env);
  }
  const spec = objectSpec(url.pathname);
  if (!spec || !["GET", "HEAD", "PUT", "POST"].includes(request.method)) return json({error: "Not found"}, 404, request, env);
  if (request.method === "PUT" || request.method === "POST") return putObject(request, env, spec);
  return getObject(request, env, spec);
}

export default {fetch: handle};

export const __test = {configuredOrigins, corsHeaders, originAllowed, objectSpec, maxUpload, digestHex, base64Bytes, base64String, decryptPrivateManifest, repackPrivateRed};
