/*
 * Red Garden free device-local codec.
 *
 * This file intentionally contains no R2 credential, private RED key, CDN or
 * remote call.  It exposes a small browser/Node-compatible API as
 * `ReedenFreeCodec`.  RED\x10 is inspected only; it is never silently treated
 * as a normal ZIP and is explicitly rejected by compressRed().
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReedenFreeCodec = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";
  const RED_ZIP = new Uint8Array([82, 69, 68, 4]);
  const RED_PRIVATE = new Uint8Array([82, 69, 68, 16]);
  const te = typeof TextEncoder === "function" ? new TextEncoder() : null;
  const td = typeof TextDecoder === "function" ? new TextDecoder("utf-8", { fatal: false }) : null;
  class FreeCodecError extends Error {
    constructor(message, code = "free_codec_error") { super(message); this.name = "FreeCodecError"; this.code = code; }
  }
  function bytesOf(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("需要 ArrayBuffer 或 Uint8Array");
  }
  async function readBytes(value) {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return bytesOf(value);
    if (value && typeof value.arrayBuffer === "function") return new Uint8Array(await value.arrayBuffer());
    throw new TypeError("需要文件、Blob、ArrayBuffer 或 Uint8Array");
  }
  function sameBytes(a, b) {
    a = bytesOf(a); b = bytesOf(b);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function hex(bytes) { return [...bytes].map(value => value.toString(16).padStart(2, "0")).join(""); }
  async function sha256Hex(value) {
    const data = await readBytes(value);
    if (!root.crypto?.subtle) throw new FreeCodecError("当前浏览器没有 Web Crypto，无法计算 SHA-256", "crypto_unavailable");
    return hex(new Uint8Array(await root.crypto.subtle.digest("SHA-256", data)));
  }
  // Small dependency-free MD5 implementation. RED v4 configurations may
  // contain MD5 references even though package integrity uses SHA-256.
  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  function rotl(value, amount) { return (value << amount) | (value >>> (32 - amount)); }
  function md5Hex(value) {
    const input = bytesOf(value), bitLength = input.length * 8;
    const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
    const data = new Uint8Array(paddedLength); data.set(input); data[input.length] = 0x80;
    const view = new DataView(data.buffer);
    view.setUint32(paddedLength - 8, bitLength >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000) >>> 0, true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let offset = 0; offset < data.length; offset += 64) {
      const m = new Uint32Array(16);
      for (let i = 0; i < 16; i++) m[i] = view.getUint32(offset + i * 4, true);
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const oldD = d;
        d = c; c = b;
        const amount = MD5_S[(i >> 4) * 4 + (i % 4)];
        b = (b + rotl((a + f + MD5_K[i] + m[g]) >>> 0, amount)) >>> 0;
        a = oldD;
      }
      a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    }
    const output = new Uint8Array(16), out = new DataView(output.buffer);
    out.setUint32(0, a0, true); out.setUint32(4, b0, true); out.setUint32(8, c0, true); out.setUint32(12, d0, true);
    return hex(output);
  }
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : c >>> 1; table[n] = c >>> 0; }
    return table;
  })();
  function crc32(value) {
    let crc = 0xffffffff;
    for (const byte of bytesOf(value)) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function u16(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true); }
  function u32(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
  function put16(value) { const result = new Uint8Array(2); new DataView(result.buffer).setUint16(0, value, true); return result; }
  function put32(value) { const result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, value >>> 0, true); return result; }
  function concat(chunks) { const total = chunks.reduce((sum, part) => sum + part.length, 0); const result = new Uint8Array(total); let offset = 0; for (const part of chunks) { result.set(part, offset); offset += part.length; } return result; }
  function text(bytes) { return td ? td.decode(bytes) : String.fromCharCode(...bytes); }
  function textBytes(value) { if (!te) throw new FreeCodecError("当前浏览器没有 TextEncoder", "text_encoder_unavailable"); return te.encode(value); }
  function startsWith(bytes, signature) { return signature.every((value, index) => bytes[index] === value); }
  // Keep browser work bounded.  A small pool is faster than a long serial
  // chain while avoiding hundreds of simultaneous ImageBitmap/ZIP streams on
  // phones with limited memory.
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
  function defaultConcurrency(fallback = 3) {
    const cores = Number(root.navigator?.hardwareConcurrency);
    return Number.isFinite(cores) && cores > 1 ? Math.min(4, Math.max(2, cores - 1)) : fallback;
  }
  function mimeFromBytes(bytes, name = "") {
    const lower = String(name).toLowerCase();
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
    if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && text(bytes.slice(8, 12)) === "WEBP") return "image/webp";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.match(/\.jpe?g$/)) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    return "application/octet-stream";
  }
  function hasSignature(bytes, signature) {
    outer: for (let start = 0; start + signature.length <= bytes.length; start++) {
      for (let i = 0; i < signature.length; i++) if (bytes[start + i] !== signature[i]) continue outer;
      return true;
    }
    return false;
  }
  function isSkippableImage(bytes, mime, name) {
    const lower = String(name).toLowerCase();
    if (mime === "image/gif" || lower.includes(".9.png") || lower.includes("card_bg") || lower.includes("cardbackground")) return "动画 GIF 或九宫格资源保留原样";
    if (mime === "image/png" && hasSignature(bytes, [0x61, 0x63, 0x54, 0x4c])) return "APNG 动画保留原样";
    if (mime === "image/webp" && (hasSignature(bytes, [0x41, 0x4e, 0x49, 0x4d]) || hasSignature(bytes, [0x41, 0x4e, 0x4d, 0x46]))) return "动画 WebP 保留原样";
    if (hasSignature(bytes.slice(0, 100000), [0x6e, 0x70, 0x54, 0x63])) return "九宫格资源保留原样";
    return "";
  }
  async function inflateRaw(bytes) {
    if (typeof root.DecompressionStream !== "function") throw new FreeCodecError("当前浏览器没有 deflate 解压能力，无法读取 RED ZIP", "zip_decompress_unavailable");
    const stream = new Blob([bytes]).stream().pipeThrough(new root.DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function deflateRaw(bytes) {
    if (typeof root.CompressionStream !== "function") throw new FreeCodecError("当前浏览器没有 deflate 压缩能力，请使用现代浏览器", "zip_compress_unavailable");
    const stream = new Blob([bytes]).stream().pipeThrough(new root.CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function findEndOfCentralDirectory(zip) {
    const lower = Math.max(0, zip.length - 22 - 65535);
    for (let offset = zip.length - 22; offset >= lower; offset--) if (u32(zip, offset) === 0x06054b50) return offset;
    throw new FreeCodecError("RED ZIP 缺少中央目录", "zip_directory_missing");
  }
  async function readZipEntries(redBytes) {
    const raw = bytesOf(redBytes);
    if (!startsWith(raw, RED_ZIP)) {
      if (startsWith(raw, RED_PRIVATE)) throw new FreeCodecError("加密 RED v2 当前浏览器版本只做结构识别，暂不重新封包", "private_red_unsupported");
      throw new FreeCodecError("不是 RED\\x04 普通 ZIP 封装", "red_header_invalid");
    }
    // Keep a view over the caller's buffer instead of copying the complete
    // package before reading its central directory. This matters for phone
    // browsers where a RED can be tens of megabytes.
    const zip = raw.subarray(4), end = findEndOfCentralDirectory(zip);
    const count = u16(zip, end + 10), cdSize = u32(zip, end + 12), cdOffset = u32(zip, end + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new FreeCodecError("ZIP64 RED 暂未支持", "zip64_unsupported");
    if (cdOffset + cdSize > zip.length) throw new FreeCodecError("RED ZIP 中央目录越界", "zip_directory_invalid");
    const entries = []; let cursor = cdOffset; const pending = [];
    for (let index = 0; index < count; index++) {
      if (u32(zip, cursor) !== 0x02014b50) throw new FreeCodecError("RED ZIP 中央目录项无效", "zip_entry_invalid");
      const flags = u16(zip, cursor + 8), method = u16(zip, cursor + 10), crc = u32(zip, cursor + 16);
      const compressedSize = u32(zip, cursor + 20), size = u32(zip, cursor + 24), nameLength = u16(zip, cursor + 28), extraLength = u16(zip, cursor + 30), commentLength = u16(zip, cursor + 32);
      const externalAttr = u32(zip, cursor + 38), localOffset = u32(zip, cursor + 42);
      if (flags & 1) throw new FreeCodecError("加密 ZIP 资源暂不支持", "zip_entry_encrypted");
      if ([compressedSize, size, localOffset].some(value => value === 0xffffffff)) throw new FreeCodecError("ZIP64 RED 暂未支持", "zip64_unsupported");
      const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength), name = text(nameBytes);
      if (!name || name.includes("\\") || name.split("/").some(part => part === "..")) throw new FreeCodecError("RED ZIP 资源路径不安全", "zip_path_invalid");
      const comment = zip.subarray(cursor + 46 + nameLength + extraLength, cursor + 46 + nameLength + extraLength + commentLength);
      if (u32(zip, localOffset) !== 0x04034b50) throw new FreeCodecError("RED ZIP 本地项无效", "zip_local_invalid");
      const localNameLength = u16(zip, localOffset + 26), localExtraLength = u16(zip, localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength, endData = start + compressedSize;
      if (endData > zip.length) throw new FreeCodecError("RED ZIP 资源越界", "zip_resource_invalid");
      const compressed = zip.subarray(start, endData);
      pending.push({ name, compressed, method, size, crc, flags, externalAttr, comment });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (cursor !== cdOffset + cdSize) throw new FreeCodecError("RED ZIP 中央目录长度不一致", "zip_directory_length");
    const decoded = await mapConcurrent(pending, defaultConcurrency(4), async item => {
      let data;
      if (item.method === 0) data = item.compressed;
      else if (item.method === 8) data = await inflateRaw(item.compressed);
      else throw new FreeCodecError(`RED ZIP 压缩方法 ${item.method} 暂未支持`, "zip_method_unsupported");
      if (data.length !== item.size || crc32(data) !== item.crc) throw new FreeCodecError(`RED ZIP 资源校验失败：${item.name}`, "zip_crc_invalid");
      return { name: item.name, bytes: data, method: item.method, flags: item.flags, crc: item.crc, externalAttr: item.externalAttr, comment: item.comment };
    });
    entries.push(...decoded);
    return entries;
  }
  async function writeZipEntries(entries, options = {}) {
    const local = [], central = []; let offset = 0;
    const prepared = await mapConcurrent(entries, options.concurrency || defaultConcurrency(4), async source => {
      const data = bytesOf(source.bytes), name = textBytes(source.name);
      if (name.length > 65535 || data.length > 0xffffffff) throw new FreeCodecError("资源超过普通 ZIP 上限", "zip_size_limit");
      let compressed = data, method = 0;
      if (data.length && typeof root.CompressionStream === "function") {
        const candidate = await deflateRaw(data);
        if (candidate.length < data.length) { compressed = candidate; method = 8; }
      }
      const crc = crc32(data), comment = source.comment ? bytesOf(source.comment) : new Uint8Array();
      return { source, data, name, compressed, method, crc, comment };
    });
    for (const item of prepared) {
      const {source, data, name, compressed, method, crc, comment} = item;
      const time = source.dosTime || 0, date = source.dosDate || 0, flags = 0x0800;
      const localHeader = concat([new Uint8Array([0x50, 0x4b, 0x03, 0x04]), put16(20), put16(flags), put16(method), put16(time), put16(date), put32(crc), put32(compressed.length), put32(data.length), put16(name.length), put16(0), name]);
      local.push(localHeader, compressed);
      const centralHeader = concat([new Uint8Array([0x50, 0x4b, 0x01, 0x02]), put16(20), put16(20), put16(flags), put16(method), put16(time), put16(date), put32(crc), put32(compressed.length), put32(data.length), put16(name.length), put16(0), put16(comment.length), put16(0), put16(0), put32(source.externalAttr || 0), put32(offset), name, comment]);
      central.push(centralHeader); offset += localHeader.length + compressed.length;
    }
    const centralBytes = concat(central), localBytes = concat(local);
    if (entries.length > 0xffff || offset > 0xffffffff || centralBytes.length > 0xffffffff) throw new FreeCodecError("RED ZIP 资源超过普通 ZIP 上限", "zip_size_limit");
    const end = concat([new Uint8Array([0x50, 0x4b, 0x05, 0x06]), put16(0), put16(0), put16(entries.length), put16(entries.length), put32(centralBytes.length), put32(localBytes.length), put16(0)]);
    return concat([RED_ZIP, localBytes, centralBytes, end]);
  }
  function mapHashValue(value, replacements) {
    if (typeof value !== "string") return value;
    const match = value.match(/^([0-9a-fA-F]{32}|[0-9a-fA-F]{64})(\.[A-Za-z0-9]+)?$/);
    if (!match) return value;
    const replacement = replacements[match[1].toLowerCase()];
    if (!replacement) return value;
    return (match[1] === match[1].toUpperCase() ? replacement.toUpperCase() : replacement) + (match[2] || "");
  }
  function mapHashes(value, replacements) {
    if (Array.isArray(value)) return value.map(item => mapHashes(item, replacements));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapHashes(item, replacements)]));
    return mapHashValue(value, replacements);
  }
  async function compressImage(bytes, name, options = {}) {
    const original = bytesOf(bytes), mime = mimeFromBytes(original, name), skipped = isSkippableImage(original, mime, name);
    const decision = { path: name, mime, used: false, originalBytes: original.length };
    if (skipped) { decision.reason = skipped; return { bytes: original, mime, decision }; }
    if (!(mime === "image/png" || mime === "image/jpeg" || mime === "image/webp")) { decision.reason = "格式不在浏览器兼容压缩范围"; return { bytes: original, mime, decision }; }
    if (typeof root.createImageBitmap !== "function") throw new FreeCodecError("当前浏览器不支持 createImageBitmap，无法本地压缩图片", "image_decode_unavailable");
    const bitmap = await root.createImageBitmap(new Blob([original], { type: mime }));
    try {
      const maxEdge = Number.isFinite(options.maxEdge) ? Math.max(0, options.maxEdge) : 2048;
      const scale = maxEdge ? Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)) : 1;
      const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = root.OffscreenCanvas ? new root.OffscreenCanvas(width, height) : root.document?.createElement("canvas");
      if (!canvas) throw new FreeCodecError("当前浏览器没有 Canvas，无法本地压缩图片", "canvas_unavailable");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d"); if (!context) throw new FreeCodecError("无法创建 Canvas 2D 上下文", "canvas_unavailable");
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high"; context.drawImage(bitmap, 0, 0, width, height);
      const quality = Math.min(1, Math.max(0.01, Number(options.quality ?? 88) / 100));
      const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: mime, quality }) : await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new FreeCodecError("图片编码失败", "image_encode_failed")), mime, quality));
      const candidate = new Uint8Array(await blob.arrayBuffer());
      if (candidate.length >= original.length) { decision.reason = "压缩结果未变小"; return { bytes: original, mime, decision }; }
      decision.used = true; decision.reason = "压缩后体积更小"; decision.compressedBytes = candidate.length; decision.width = width; decision.height = height;
      return { bytes: candidate, mime, decision };
    } finally { bitmap.close?.(); }
  }
  function parsePrivateHeader(raw) {
    if (!startsWith(raw, RED_PRIVATE) || raw.length < 8) throw new FreeCodecError("不是 RED v2 私有主题", "private_header_invalid");
    const headerLength = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(4, false);
    if (headerLength < 2 || headerLength > 65536 || 8 + headerLength > raw.length) throw new FreeCodecError("RED v2 公开头长度无效", "private_header_invalid");
    let header; try { header = JSON.parse(text(raw.slice(8, 8 + headerLength))); } catch { throw new FreeCodecError("RED v2 公开头不是有效 JSON", "private_header_invalid"); }
    return { format: "red_private_v2", header, encryptedManifestOffset: 8 + headerLength, encryptedManifestLength: header.manifestLength, compressionSupported: false };
  }
  // RED\\x10 keeps its manifest encrypted, but the current private format
  // stores image payloads sequentially after that manifest.  We cannot name
  // or decrypt those resources without the theme key, however their standard
  // image headers remain enough to make a useful visual index.  Extract only
  // complete PNG/JPEG frames; never treat the encrypted bytes as a ZIP.
  function jsonObjectEnd(raw, start, limit = 4 * 1024 * 1024) {
    if (raw[start] !== 0x7b) return -1;
    let depth = 0, inString = false, escaped = false;
    const end = Math.min(raw.length, start + limit);
    for (let index = start; index < end; index++) {
      const byte = raw[index];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (byte === 0x5c) { escaped = true; continue; }
        if (byte === 0x22) inString = false;
        continue;
      }
      if (byte === 0x22) { inString = true; continue; }
      if (byte === 0x7b) depth++;
      else if (byte === 0x7d && --depth === 0) return index + 1;
      if (depth < 0) return -1;
    }
    return -1;
  }
  function privateJsonDocuments(raw, start, limit = 2000) {
    const documents = [];
    for (let offset = start; offset < raw.length && documents.length < limit; offset++) {
      if (raw[offset] !== 0x7b) continue;
      // Binary payloads contain braces frequently. JSON objects almost always
      // begin with a quoted key; this guard avoids expensive scans through
      // compressed/encrypted bytes while retaining UTF-8 object values.
      let next = offset + 1;
      while (next < raw.length && (raw[next] === 0x20 || raw[next] === 0x09 || raw[next] === 0x0a || raw[next] === 0x0d)) next++;
      if (raw[next] !== 0x22) continue;
      const end = jsonObjectEnd(raw, offset);
      if (end <= offset) continue;
      try {
        const value = JSON.parse(text(raw.subarray(offset, end)));
        if (value && typeof value === "object" && !Array.isArray(value)) documents.push({ offset, end, value });
        offset = end - 1;
      } catch { /* A binary brace or partial object; resume at the next byte. */ }
    }
    return documents;
  }
  function hashValue(value) {
    if (typeof value !== "string") return "";
    const match = value.match(/^([0-9a-f]{32}|[0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$/i);
    return match ? match[1].toLowerCase() : "";
  }
  function isThemeObject(value) {
    return Boolean(value && typeof value.name === "string" && (value.light && typeof value.light === "object" || value.dark && typeof value.dark === "object"));
  }
  async function annotatePrivatePreviewRoles(raw, parsed, found, options = {}) {
    const documents = privateJsonDocuments(raw, parsed.encryptedManifestOffset + (Number(parsed.header?.manifestLength) || 0));
    const themeCandidates = documents.filter(item => isThemeObject(item.value));
    const theme = themeCandidates.length ? themeCandidates[themeCandidates.length - 1].value : null;
    const rolesByHash = new Map(), splashIds = new Set();
    for (const mode of ["light", "dark"]) {
      const config = theme?.[mode];
      if (!config || typeof config !== "object") continue;
      const bind = (value, role) => { const digest = hashValue(value); if (digest) rolesByHash.set(digest, role); };
      bind(config.backgroundImage, "shelf");
      bind(config.cardBackgroundImage, "card");
      const carousels = Array.isArray(config.bookshelfCarouselImageUrls) ? config.bookshelfCarouselImageUrls : [config.bookshelfCarouselImageUrls];
      for (const value of carousels) bind(value, "carousel");
      if (typeof config.customSplashId === "string" && config.customSplashId) splashIds.add(config.customSplashId);
    }
    // MD5 is what current private theme configs use for background/card IDs.
    // The async SHA pass below covers splash metadata, which stores SHA-256.
    const hashes = found.map(item => md5Hex(item.bytes).toLowerCase());
    for (let index = 0; index < found.length; index++) {
      const role = rolesByHash.get(hashes[index]);
      if (role) found[index].role = role;
    }
    const sha = await Promise.all(found.map(item => sha256Hex(item.bytes).catch(() => "")));
    const splashDocs = documents.filter(item => {
      const value = item.value;
      return value && typeof value === "object" && value.assetType === "image" && hashValue(value.assetId);
    });
    const unlabeledSplashDocs = splashDocs.filter(item => !["id", "resourceId", "customSplashId"].some(key => typeof item.value[key] === "string"));
    const adjacent = (doc, index) => found[index].end === doc.offset;
    for (const doc of splashDocs) {
      const explicit = new Set(["id", "resourceId", "customSplashId"].map(key => doc.value[key]).filter(value => typeof value === "string"));
      let matched = false;
      for (let index = 0; index < found.length; index++) {
        if (!adjacent(doc, index)) continue;
        const digest = hashValue(doc.value.assetId);
        const matches = digest === hashes[index] || digest === sha[index];
        if (!matches) continue;
        const idMatch = [...explicit].some(id => splashIds.has(id));
        if (idMatch || (!explicit.size && splashIds.size === 1 && unlabeledSplashDocs.length === 1)) {
          found[index].role = "splash"; found[index].roleEvidence = "public_splash_metadata"; matched = true;
        }
      }
      if (matched) continue;
    }
    // Public cover metadata is commonly adjacent to one gallery image while
    // the remaining gallery members have no names. Treat the leading unbound
    // images before the verified splash as the same cover gallery; this keeps
    // stamps/illustrations together and excludes later navbar decorations.
    const splashIndex = found.findIndex(item => item.role === "splash");
    const coverDocs = documents.filter(item => {
      const keys = Object.keys(item.value || {}).sort();
      return keys.length === 2 && keys[0] === "name" && keys[1] === "transparentOptimization" && typeof item.value.name === "string" && typeof item.value.transparentOptimization === "boolean";
    });
    if (splashIndex >= 0 && coverDocs.length) {
      const leading = found.slice(0, splashIndex).filter(item => !item.role);
      for (const item of leading) item.role = "cover";
    }
    // Reader backgrounds are not hash-bound in the public schema. In the
    // private sequential layout they are the final large portrait image(s),
    // after the navigation/decoration block, while shelf is already bound.
    if (typeof root.createImageBitmap === "function") {
      await Promise.all(found.map(async item => {
        try {
          const bitmap = await root.createImageBitmap(new Blob([item.bytes], { type: item.mime }));
          item.width = bitmap.width; item.height = bitmap.height; bitmap.close?.();
        } catch { /* undecodable image remains unclassified */ }
      }));
    }
    const readerCandidates = found.filter(item => !item.role && item.width && item.height && item.width >= 900 && item.height >= 1200 && item.width / item.height > 0.65 && item.width / item.height < 0.85);
    if (readerCandidates.length) readerCandidates[readerCandidates.length - 1].role = "reader";
    return { theme, documents };
  }
  async function extractPrivatePreviewImages(value, options = {}) {
    const raw = bytesOf(value);
    if (!startsWith(raw, RED_PRIVATE)) return [];
    const parsed = parsePrivateHeader(raw);
    if (parsed.header?.assetMode && parsed.header.assetMode !== "plain-sequential") return [];
    const manifestLength = Number(parsed.header?.manifestLength);
    const start = Number.isSafeInteger(manifestLength) && manifestLength >= 0
      ? Math.min(raw.length, parsed.encryptedManifestOffset + manifestLength)
      : parsed.encryptedManifestOffset;
    const limit = Math.max(1, Math.min(24, Number(options.limit) || 24));
    const maxBytes = Math.max(1024, Number(options.maxBytes) || 24 * 1024 * 1024);
    const found = [];
    const seen = new Set();
    const add = (offset, end, mime, extension) => {
      if (found.length >= limit || end <= offset || end - offset > maxBytes) return;
      const key = `${offset}:${end}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ name: `private-preview-${found.length + 1}.${extension}`, bytes: raw.slice(offset, end), mime, offset, end });
    };
    for (let offset = start; offset + 12 <= raw.length && found.length < limit; offset++) {
      // PNG: walk chunks so a byte sequence in compressed data cannot end the
      // frame prematurely.  Invalid chunks are ignored and scanning resumes.
      if (raw[offset] === 0x89 && raw[offset + 1] === 0x50 && raw[offset + 2] === 0x4e && raw[offset + 3] === 0x47 && raw[offset + 4] === 0x0d && raw[offset + 5] === 0x0a && raw[offset + 6] === 0x1a && raw[offset + 7] === 0x0a) {
        let cursor = offset + 8, valid = true, end = 0;
        while (cursor + 12 <= raw.length && cursor - offset <= maxBytes) {
          const length = ((raw[cursor] << 24) | (raw[cursor + 1] << 16) | (raw[cursor + 2] << 8) | raw[cursor + 3]) >>> 0;
          if (length > maxBytes || cursor + 12 + length > raw.length) { valid = false; break; }
          const type = String.fromCharCode(raw[cursor + 4], raw[cursor + 5], raw[cursor + 6], raw[cursor + 7]);
          cursor += 12 + length;
          if (type === "IEND") { end = cursor; break; }
        }
        if (valid && end) { add(offset, end, "image/png", "png"); offset = end - 1; }
        continue;
      }
      // JPEG EOI is unambiguous enough here because each payload starts at a
      // signature boundary; accept the first EOI after SOI and cap scanning.
      if (raw[offset] === 0xff && raw[offset + 1] === 0xd8 && raw[offset + 2] === 0xff) {
        const endMarker = raw.indexOf ? raw.indexOf(0xff, offset + 3) : -1;
        let end = -1;
        if (endMarker >= 0) {
          for (let cursor = endMarker; cursor + 1 < raw.length && cursor - offset <= maxBytes; cursor++) {
            if (raw[cursor] === 0xff && raw[cursor + 1] === 0xd9) { end = cursor + 2; break; }
          }
        }
        if (end > 0) { add(offset, end, "image/jpeg", "jpg"); offset = end - 1; }
        continue;
      }
      if (raw[offset] === 0x47 && raw[offset + 1] === 0x49 && raw[offset + 2] === 0x46 && raw[offset + 3] === 0x38) {
        const end = raw.indexOf(0x3b, offset + 6);
        if (end >= 0 && end - offset <= maxBytes) { add(offset, end + 1, "image/gif", "gif"); offset = end; }
        continue;
      }
      if (raw[offset] === 0x52 && raw[offset + 1] === 0x49 && raw[offset + 2] === 0x46 && raw[offset + 3] === 0x46 && raw[offset + 8] === 0x57 && raw[offset + 9] === 0x45 && raw[offset + 10] === 0x42 && raw[offset + 11] === 0x50) {
        const size = (raw[offset + 4] | (raw[offset + 5] << 8) | (raw[offset + 6] << 16) | (raw[offset + 7] << 24)) >>> 0;
        const end = Math.min(raw.length, offset + 8 + size + (size & 1));
        if (end > offset + 12 && end - offset <= maxBytes) { add(offset, end, "image/webp", "webp"); offset = end - 1; }
      }
    }
    await annotatePrivatePreviewRoles(raw, parsed, found, options);
    return found;
  }
  async function inspectContainer(value) {
    const raw = await readBytes(value);
    if (startsWith(raw, RED_PRIVATE)) return parsePrivateHeader(raw);
    if (!startsWith(raw, RED_ZIP)) throw new FreeCodecError("缺少 RED\\x04 或 RED\\x10 头", "red_header_invalid");
    const entries = await readZipEntries(raw);
    return { format: "red_v4", entries: entries.map(entry => ({ name: entry.name, bytes: entry.bytes.length, mime: mimeFromBytes(entry.bytes, entry.name) })), compressionSupported: true };
  }
  async function compressRed(value, options = {}) {
    const raw = await readBytes(value);
    if (startsWith(raw, RED_PRIVATE)) throw new FreeCodecError("加密 RED v2 当前浏览器版本只做结构识别，暂不重新封包；请使用电脑后台版本", "private_red_unsupported");
    const entries = await readZipEntries(raw), replacements = {}, decisions = [], output = [];
    const processed = await mapConcurrent(entries, options.concurrency || defaultConcurrency(3), async entry => {
      const bytes = entry.bytes;
      let result = { bytes, decision: { path: entry.name, mime: mimeFromBytes(bytes, entry.name), used: false, reason: "非图片资源" } };
      if (result.decision.mime.startsWith("image/")) result = await compressImage(bytes, entry.name, options);
      if (result.decision.used) {
        const [oldSha, newSha] = await Promise.all([sha256Hex(bytes), sha256Hex(result.bytes)]);
        replacements[md5Hex(bytes)] = md5Hex(result.bytes);
        replacements[oldSha] = newSha;
      }
      return {entry, result};
    });
    for (const {entry, result} of processed) { decisions.push(result.decision); output.push({ ...entry, bytes: result.bytes }); }
    if (Object.keys(replacements).length) {
      for (const entry of output) if (entry.name.toLowerCase().endsWith(".json")) {
        try { const value = JSON.parse(text(entry.bytes)), mapped = mapHashes(value, replacements); entry.bytes = textBytes(JSON.stringify(mapped)); }
        catch { /* Non-JSON resources keep their original bytes. */ }
      }
    }
    const candidate = await writeZipEntries(output, { concurrency: options.concurrency || defaultConcurrency(3) });
    const selected = candidate.length < raw.length ? candidate : raw;
    return { bytes: selected, originalBytes: raw.length, compressedBytes: selected.length, savedBytes: raw.length - selected.length, packageSelected: selected !== raw, decisions, format: "red_v4" };
  }
  async function inspectFont(value) {
    const bytes = await readBytes(value), name = typeof value?.name === "string" ? value.name : "font";
    const extension = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] || "").toLowerCase();
    if (!["ttf", "otf", "woff", "woff2"].includes(extension)) throw new FreeCodecError("字体格式仅支持 TTF、OTF、WOFF、WOFF2", "font_format_unsupported");
    return { fileName: name, extension, bytes: bytes.length, sha256: await sha256Hex(bytes), previewText: "Aa 中文 0123 · Reeden Theme" };
  }
  async function fontPreview(value, options = {}) {
    if (!root.FontFace || !root.document) throw new FreeCodecError("当前环境没有 FontFace/DOM，无法生成字体预览", "font_preview_unavailable");
    const bytes = await readBytes(value), info = await inspectFont(value), family = options.family || `ReedenFont_${info.sha256.slice(0, 12)}`;
    const url = root.URL.createObjectURL(new Blob([bytes], { type: `font/${info.extension}` }));
    const face = new root.FontFace(family, `url(${url})`); await face.load(); root.document.fonts.add(face);
    const canvas = root.document.createElement("canvas"); canvas.width = options.width || 900; canvas.height = options.height || 220;
    const context = canvas.getContext("2d"); context.fillStyle = options.background || "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = options.color || "#202530"; context.font = `${options.fontSize || 36}px "${family}"`; context.textBaseline = "top"; context.fillText(options.text || info.previewText, 24, 24);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new FreeCodecError("字体预览编码失败", "font_preview_encode_failed")), "image/png"));
    return { ...info, family, blob, release() { root.document.fonts.delete(face); root.URL.revokeObjectURL(url); } };
  }
  const api = { FreeCodecError, RED_ZIP, RED_PRIVATE, sha256Hex, md5Hex, crc32, mimeFromBytes, readZipEntries, writeZipEntries, inspectContainer, extractPrivatePreviewImages, compressImage, compressRed, inspectFont, fontPreview };
  if (root && typeof root === "object") root.ReedenFreeCodec = api;
  return api;
});
