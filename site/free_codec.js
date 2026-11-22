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
  // 封面图集用的是 RED\x02：同样是 4 字节头 + 普通 ZIP，条目是
  // `1.jpg/2.jpg...` 加一份 meta.json。它没有 JSON 前缀，也不加密。
  const RED_GALLERY = new Uint8Array([82, 69, 68, 2]);
  const RED_ZIP_HEADERS = [RED_ZIP, RED_GALLERY];
  const RED_PRIVATE = new Uint8Array([82, 69, 68, 16]);
  const RED_READER = new Uint8Array([82, 69, 68, 1]);
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
    // `card_bg` used to be skipped by name alone, which cost a third of the
    // package on themes that ship a plain PNG card background (real 9-patch
    // files are still caught by the `.9.png` name, the `npTc` chunk and the
    // APNG/GIF checks below).
    if (lower.includes(".9.png")) return "九宫格资源保留原样";
    if (mime === "image/png" && hasSignature(bytes, [0x61, 0x63, 0x54, 0x4c])) return "APNG 动画保留原样";
    if (mime === "image/webp" && (hasSignature(bytes, [0x41, 0x4e, 0x49, 0x4d]) || hasSignature(bytes, [0x41, 0x4e, 0x4d, 0x46]))) return "动画 WebP 保留原样";
    if (hasSignature(bytes.slice(0, 100000), [0x6e, 0x70, 0x54, 0x63])) return "九宫格资源保留原样";
    return "";
  }
  async function inflateRaw(bytes, maxBytes = Infinity) {
    if (typeof root.DecompressionStream !== "function") throw new FreeCodecError("当前浏览器没有 deflate 解压能力，无法读取 RED ZIP", "zip_decompress_unavailable");
    const stream = new Blob([bytes]).stream().pipeThrough(new root.DecompressionStream("deflate-raw"));
    const reader = stream.getReader(), chunks = [];
    let total = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { await reader.cancel(); throw new FreeCodecError("ZIP 解压内容超过声明大小", "zip_size_limit"); }
      chunks.push(value);
    }
    return concat(chunks);
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
  async function gunzipBounded(bytes, limit = 128 * 1024 * 1024) {
    if(typeof root.DecompressionStream!=="function")throw new FreeCodecError("当前浏览器不支持 gzip 阅读主题，请更新浏览器", "gzip_unavailable");
    const reader=new Blob([bytes]).stream().pipeThrough(new root.DecompressionStream("gzip")).getReader(),chunks=[];
    let size=0;
    try{
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new FreeCodecError("阅读主题解压后超过大小限制", "reader_size_limit");}chunks.push(value);}
      return concat(chunks);
    }finally{reader.releaseLock();}
  }
  async function readReaderEntries(raw, options = {}) {
    let document;
    try{document=JSON.parse(text(await gunzipBounded(raw.subarray(4))));}
    catch(error){if(error instanceof FreeCodecError)throw error;throw new FreeCodecError("阅读主题的 gzip 或 JSON 已损坏", "reader_data_invalid");}
    // v1 gzip 容器不只装阅读配色：高亮规则包也是 RED\x01，只是 type 不同。
    // 不认这个类型会让整批高亮在“读取主题”阶段直接失败。
    const readerTypes=new Set(["readerColorSchema","highlightRule","highlightRules"]);
    if(document?.version!==1||!readerTypes.has(document.type)||!Array.isArray(document.data)||!document.data.length||document.data.some(item=>!item||typeof item!=="object"||Array.isArray(item)))throw new FreeCodecError("不支持的 RED 旧版数据类型", "reader_type_unsupported");
    const entries=[],metadata={...document,data:document.data.map(item=>{const {backgroundImageData,images,...rest}=item;return rest;})};
    entries.push({name:"theme.json",bytes:textBytes(JSON.stringify(metadata))});
    let total=0;
    if(options.images!==false)for(const [index,item]of document.data.entries()){
      // 高亮包的图片放在 images 映射里（每张一个 base64 gzip），阅读主题则用
      // backgroundImageData。两条都收，预览才不会只剩一张空 JSON。
      const sources=[];
      if(item?.backgroundImageData)sources.push({key:"",value:item.backgroundImageData});
      if(item?.images&&typeof item.images==="object")for(const [key,value]of Object.entries(item.images))if(typeof value==="string")sources.push({key,value});
      for(const [sourceIndex,source]of sources.entries()){
        try{
          const encoded=String(source.value).replace(/^data:[^,]*;base64,/i,"");
          const binary=root.atob(encoded);let bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
          if(startsWith(bytes,[0x1f,0x8b]))bytes=await gunzipBounded(bytes,64*1024*1024);
          total+=bytes.length;if(total>128*1024*1024)throw new FreeCodecError("阅读主题图片超过大小限制", "reader_size_limit");
          const mime=mimeFromBytes(bytes),extension={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"}[mime];
          if(!extension)continue;
          const mode=item.themeMode==='dark'?'dark':'light';
          if(document.type==="readerColorSchema")entries.push({name:`${mode}/reader/background-${index}.${extension}`,bytes,role:"reader"});
          else entries.push({name:`${mode}/highlight/${index}-${source.key||sourceIndex}.${extension}`,bytes,role:"other"});
        }catch(error){if(error instanceof FreeCodecError)throw error;throw new FreeCodecError("阅读主题背景图片已损坏", "reader_image_invalid");}
      }
    }
    entries.containerFormat="red_v1_gzip";
    return entries;
  }
  async function readZipEntries(redBytes, options = {}) {
    const raw = bytesOf(redBytes);
    const standard = options.standardZip === true;
    if(!standard&&startsWith(raw,RED_READER))return readReaderEntries(raw);
    const zipHeader = standard ? null : RED_ZIP_HEADERS.find(header => startsWith(raw, header));
    if (!standard && !zipHeader) {
      if (startsWith(raw, RED_PRIVATE)) throw new FreeCodecError("加密 RED v2 当前浏览器版本只做结构识别，暂不重新封包", "private_red_unsupported");
      throw new FreeCodecError("无法识别 RED 文件头，文件可能不完整或格式尚未支持", "red_header_invalid");
    }
    const galleryContainer = zipHeader === RED_GALLERY;
    // Keep a view over the caller's buffer instead of copying the complete
    // package before reading its central directory. This matters for phone
    // browsers where a RED can be tens of megabytes.
    const zip = standard ? raw : raw.subarray(4), end = findEndOfCentralDirectory(zip);
    const count = u16(zip, end + 10), cdSize = u32(zip, end + 12), cdOffset = u32(zip, end + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new FreeCodecError("ZIP64 RED 暂未支持", "zip64_unsupported");
    if (cdOffset + cdSize > zip.length) throw new FreeCodecError("RED ZIP 中央目录越界", "zip_directory_invalid");
    const entries = []; let cursor = cdOffset; const pending = [];
    let totalSize = 0;
    if (standard && count > 10000) throw new FreeCodecError("ZIP 条目超过 10000 个，请分批导入", "zip_size_limit");
    for (let index = 0; index < count; index++) {
      if (u32(zip, cursor) !== 0x02014b50) throw new FreeCodecError("RED ZIP 中央目录项无效", "zip_entry_invalid");
      const flags = u16(zip, cursor + 8), method = u16(zip, cursor + 10), crc = u32(zip, cursor + 16);
      const compressedSize = u32(zip, cursor + 20), size = u32(zip, cursor + 24), nameLength = u16(zip, cursor + 28), extraLength = u16(zip, cursor + 30), commentLength = u16(zip, cursor + 32);
      const externalAttr = u32(zip, cursor + 38), localOffset = u32(zip, cursor + 42);
      if (flags & 1) throw new FreeCodecError("加密 ZIP 资源暂不支持", "zip_entry_encrypted");
      if ([compressedSize, size, localOffset].some(value => value === 0xffffffff)) throw new FreeCodecError("ZIP64 RED 暂未支持", "zip64_unsupported");
      const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);
      let name;
      try { name = new TextDecoder("utf-8", {fatal: true}).decode(nameBytes); }
      catch { name = standard ? new TextDecoder("gb18030").decode(nameBytes) : text(nameBytes); }
      if (!name || name.startsWith("/") || /^[a-z]:/i.test(name) || name.includes("\\") || name.includes("\0") || name.split("/").some(part => part === "..")) throw new FreeCodecError("RED ZIP 资源路径不安全", "zip_path_invalid");
      const comment = zip.subarray(cursor + 46 + nameLength + extraLength, cursor + 46 + nameLength + extraLength + commentLength);
      if (u32(zip, localOffset) !== 0x04034b50) throw new FreeCodecError("RED ZIP 本地项无效", "zip_local_invalid");
      const localNameLength = u16(zip, localOffset + 26), localExtraLength = u16(zip, localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength, endData = start + compressedSize;
      if (endData > zip.length) throw new FreeCodecError("RED ZIP 资源越界", "zip_resource_invalid");
      const compressed = zip.subarray(start, endData);
      if (!options.filter || options.filter(name)) {
        totalSize += size;
        if (standard && (pending.length >= 200 || size > 96 * 1024 * 1024 || totalSize > 512 * 1024 * 1024)) throw new FreeCodecError("ZIP 内待导入文件超过 200 个、单文件 96 MB 或总计 512 MB，请拆成小批次", "zip_size_limit");
        pending.push({ name, compressed, method, size, crc, flags, externalAttr, comment });
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (cursor !== cdOffset + cdSize) throw new FreeCodecError("RED ZIP 中央目录长度不一致", "zip_directory_length");
    const decoded = await mapConcurrent(pending, defaultConcurrency(4), async item => {
      let data;
      if (item.method === 0) data = item.compressed;
      else if (item.method === 8) data = await inflateRaw(item.compressed, item.size);
      else throw new FreeCodecError(`RED ZIP 压缩方法 ${item.method} 暂未支持`, "zip_method_unsupported");
      if (data.length !== item.size || crc32(data) !== item.crc) throw new FreeCodecError(`RED ZIP 资源校验失败：${item.name}`, "zip_crc_invalid");
      return { name: item.name, bytes: data, method: item.method, flags: item.flags, crc: item.crc, externalAttr: item.externalAttr, comment: item.comment };
    });
    entries.push(...decoded);
    // 图集容器改名/改扩展名都有风险（Reeden 按数字文件名序号取图），
    // 所以标记成「原包保留」，压缩流程看到它直接回原字节。
    if (galleryContainer) entries.containerFormat = "red_v2_gallery";
    return entries;
  }
  async function writeZipEntries(entries, options = {}) {
    const local = [], central = []; let offset = 0;
    let packed=0;
    const prepared = await mapConcurrent(entries, options.concurrency || defaultConcurrency(4), async source => {
      const data = bytesOf(source.bytes), name = textBytes(source.name);
      if (name.length > 65535 || data.length > 0xffffffff) throw new FreeCodecError("资源超过普通 ZIP 上限", "zip_size_limit");
      let compressed = data, method = 0;
      // `store` skips DEFLATE for payloads that are already compressed (fonts,
      // RED/ZIP packages, JPEGs). Batch downloads use it to avoid re-compressing
      // tens of megabytes on the device for no size gain.
      if (!options.store && data.length && typeof root.CompressionStream === "function") {
        const candidate = await deflateRaw(data);
        if (candidate.length < data.length) { compressed = candidate; method = 8; }
      }
      const crc = crc32(data), comment = source.comment ? bytesOf(source.comment) : new Uint8Array();
      options.onProgress?.({stage:"pack",completed:++packed,total:entries.length,name:source.name});
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
    return concat([options.header || RED_ZIP, localBytes, centralBytes, end]);
  }
  function mapHashValue(value, replacements) {
    if (typeof value !== "string") return value;
    const match = value.match(/^([0-9a-fA-F]{32}|[0-9a-fA-F]{64})(\.[A-Za-z0-9]+)?$/);
    if (!match) return value;
    const replacement = replacements[match[1].toLowerCase()];
    if (!replacement) return value;
    return (match[1] === match[1].toUpperCase() ? replacement.toUpperCase() : replacement) + (match[2] || "");
  }
  function mapReferences(value, replacements, extensions = {}, paths = {}, configPath = "") {
    if (typeof value === "string") {
      if (paths[value]) return paths[value];
      const hash = value.match(/^([0-9a-fA-F]{32}|[0-9a-fA-F]{64})(\.[A-Za-z0-9]+)?$/);
      if (hash && replacements[hash[1].toLowerCase()]) {
        const replacement = replacements[hash[1].toLowerCase()];
        // Keep the reference shape: a bare hash reference stays bare (Reeden
        // resolves it by content hash), while an explicit `.png`/`.img` suffix
        // is swapped for the new payload type.
        const extension = hash[2] ? (extensions[hash[1].toLowerCase()] || hash[2]) : "";
        return (hash[1] === hash[1].toUpperCase() ? replacement.toUpperCase() : replacement) + extension;
      }
      // Relative file names live next to the config that mentions them — the
      // carousel manifest says "file": "000.img" and Reeden resolves it against
      // the manifest's own directory.  When the resource gets renamed the
      // relative name has to follow, otherwise the banner silently disappears.
      if (configPath) {
        const dir = configPath.slice(0, configPath.lastIndexOf("/") + 1);
        if (dir) {
          const target = paths[dir + value];
          if (target && target.startsWith(dir)) return target.slice(dir.length);
        }
      }
      if (/^\s*[\[{]/.test(value)) {
        try { const parsed = JSON.parse(value), mapped = mapReferences(parsed, replacements, extensions, paths, configPath); return JSON.stringify(mapped); } catch { /* plain string */ }
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => mapReferences(item, replacements, extensions, paths, configPath));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapReferences(item, replacements, extensions, paths, configPath)]));
    return value;
  }
  // Nine-slice resources carry pixel coordinates that only make sense on the
  // original pixel grid.  Re-encoding them to WebP drops the `npTc` marker and
  // resizing them invalidates the slice boxes, so Reeden draws nothing.  The
  // reference converter keeps them byte-for-byte; we do the same.
  function nineSlicePaths(entries) {
    const skip = new Set();
    const parse = name => {
      const entry = entries.find(item => item.name === name);
      if (!entry) return null;
      try { return JSON.parse(text(entry.bytes)); } catch { return null; }
    };
    const theme = parse("theme.json");
    if (theme && typeof theme === "object") {
      for (const mode of ["light", "dark"]) {
        const config = theme[mode];
        if (!config || typeof config !== "object") continue;
        if (String(config.cardBackgroundImageFit || "").toLowerCase().startsWith("nineslice")) skip.add(`${mode}/card_bg.img`);
        if (String(config.bookshelfCarouselImageFit || "").toLowerCase().startsWith("nineslice")) {
          for (const entry of entries) {
            if (!entry.name.startsWith(`${mode}/bookshelf_carousel/`)) continue;
            if (entry.name.toLowerCase().endsWith(".json")) continue;
            skip.add(entry.name);
          }
        }
      }
    }
    for (const entry of entries) {
      if (!/^reader_schema\/.+\/schema\.json$/i.test(entry.name)) continue;
      const schema = parse(entry.name);
      if (!schema || typeof schema !== "object") continue;
      if (String(schema.backgroundImageFit || "").toLowerCase().startsWith("nineslice")) skip.add(entry.name.replace(/schema\.json$/i, "bg.img"));
    }
    return [...skip];
  }
  // Compression profiles mirror what users see in the import panel.  The two
  // named profiles pick per-role resolution caps, because a Reeden theme is
  // dominated by a handful of very large bitmaps: resizing the splash and the
  // reading background is what actually moves the package size, while the tab
  // bar needs to stay crisp at its small draw size.
  const COMPRESSION_PRESETS = {
    balanced: { label: "最高性价比", quality: 94, maxEdge: 0, roleCaps: null, iconLossless: true, gifColors: 128 },
    // Full-screen art (启动图/阅读背景/书架底) gets 2560 so it still holds up on
    // 2K/4K displays; only the card-sized surfaces stay at 1600.  Measured on
    // real themes: 2656px art keeps PSNR 40.7dB at 2560 instead of dropping to
    // 36.7dB at 1920, for a few hundred KB more per theme.
    max: { label: "最大压缩", quality: 90, maxEdge: 2560, roleCaps: { icon: 384, splash: 2560, reader: 2560, card: 1600, cover: 1600, carousel: 1600, shelf: 2560, other: 1600 }, iconLossless: true, gifColors: 64 },
    custom: { label: "自定义", quality: 88, maxEdge: 2048, roleCaps: null, iconLossless: false, gifColors: 96 },
  };
  function imageRole(name) {
    const value = String(name || "").replace(/\\/g, "/").toLowerCase();
    if (/navbar_pack|navbar|bottom_bar|tabbar|(^|[/_.-])(icon|normal|selected)([/_.-]|$)/.test(value)) return "icon";
    if (/custom_splash|splash|launch|startup|welcome|opening|启动|开屏/.test(value)) return "splash";
    if (/reader_schema|reader_background|reading|article|content|book_page|reader|正文|阅读/.test(value)) return "reader";
    if (/cover_gallery|book_cover|cover|封面|书封|图集/.test(value)) return "cover";
    if (/carousel|banner|轮播|横幅/.test(value)) return "carousel";
    if (/card_bg|cardbackground|card-background|book_card|bookshelf_card|书架卡片|书卡|卡片/.test(value)) return "card";
    if (/theme_bg|bookshelf|shelf|library|background|书架|书架底|首页|主页/.test(value)) return "shelf";
    return "other";
  }
  function resolveImageTarget(name, options = {}) {
    const preset = COMPRESSION_PRESETS[options.preset] || null;
    const role = imageRole(name);
    if (!preset || options.preset === "custom") {
      const maxEdge = Number.isFinite(options.maxEdge) ? Math.max(0, options.maxEdge) : (preset ? preset.maxEdge : 2048);
      // "自选" mode exposes the encoder, quality, long-edge cap, GIF palette and
      // whether reading backgrounds participate.  codec "png" means lossless:
      // only the long-edge cap changes the pixels.
      const codec = options.codec === "png" ? "png" : "webp";
      const gifColors = Number.isFinite(options.gifColors) ? Math.max(0, options.gifColors) : (preset ? preset.gifColors : 96);
      return {
        role, maxEdge, codec, gifColors, preset: options.preset || "custom",
        quality: Number(options.quality ?? (preset ? preset.quality : 88)),
        iconLossless: options.iconLossless === undefined ? Boolean(preset?.iconLossless) : Boolean(options.iconLossless),
        skip: role === "reader" && options.compressReader === false,
      };
    }
    const cap = preset.roleCaps ? (preset.roleCaps[role] ?? preset.roleCaps.other) : 0;
    return { role, maxEdge: cap || preset.maxEdge, quality: preset.quality, codec: "webp", iconLossless: preset.iconLossless, gifColors: preset.gifColors, preset: options.preset, skip: false };
  }
  // Animated GIFs cannot go through canvas without losing frames, so they are
  // re-quantized instead: omggif (vendored, MIT) decodes each frame into its own
  // rectangle, the colors are merged into a smaller palette, and the frames are
  // written back with their original rect, delay and disposal.  Size, frame
  // count and playback rhythm stay untouched.
  function gifCodecApi() {
    return typeof root.GifReader === "function" && typeof root.GifWriter === "function"
      ? { reader: root.GifReader, writer: root.GifWriter } : null;
  }
  function gifLoopCount(bytes) {
    for (let i = 0; i + 11 < bytes.length; i++) {
      if (bytes[i] !== 0x4e || bytes[i + 1] !== 0x45) continue;
      if (text(bytes.subarray(i, i + 11)) !== "NETSCAPE2.0") continue;
      let p = i + 11;
      if (bytes[p] === 0x03) return bytes[p + 1] | (bytes[p + 2] << 8);
      return 0;
    }
    return 0;
  }
  function medianCutPalette(pixels, maxColors) {
    let boxes = [pixels];
    while (boxes.length < maxColors) {
      let index = -1, best = 0;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.length < 2) continue;
        let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, weight = 0;
        for (const item of box) {
          const [r, g, b] = item.rgb;
          if (r < rmin) rmin = r; if (r > rmax) rmax = r;
          if (g < gmin) gmin = g; if (g > gmax) gmax = g;
          if (b < bmin) bmin = b; if (b > bmax) bmax = b;
          weight += item.w;
        }
        const range = Math.max(rmax - rmin, gmax - gmin, bmax - bmin) * Math.log2(weight + 1);
        if (range > best) { best = range; index = i; }
      }
      if (index < 0) break;
      const box = boxes[index];
      let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
      for (const item of box) {
        const [r, g, b] = item.rgb;
        if (r < rmin) rmin = r; if (r > rmax) rmax = r;
        if (g < gmin) gmin = g; if (g > gmax) gmax = g;
        if (b < bmin) bmin = b; if (b > bmax) bmax = b;
      }
      const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
      const channel = dr >= dg && dr >= db ? 0 : dg >= db ? 1 : 2;
      box.sort((a, b) => a.rgb[channel] - b.rgb[channel]);
      const total = box.reduce((sum, item) => sum + item.w, 0);
      let acc = 0, cut = 1;
      for (let i = 0; i < box.length - 1; i++) { acc += box[i].w; if (acc >= total / 2) { cut = i + 1; break; } }
      boxes.splice(index, 1, box.slice(0, cut), box.slice(cut));
    }
    return boxes.filter(box => box.length).map(box => {
      let r = 0, g = 0, b = 0, weight = 0;
      for (const item of box) { r += item.rgb[0] * item.w; g += item.rgb[1] * item.w; b += item.rgb[2] * item.w; weight += item.w; }
      return [Math.round(r / weight), Math.round(g / weight), Math.round(b / weight)];
    });
  }
  function requantizeGif(bytes, paletteSize) {
    const api = gifCodecApi();
    if (!api) return { reason: "GIF 编解码库未加载" };
    const reader = new api.reader(bytes);
    const width = reader.width, height = reader.height, total = reader.numFrames();
    if (!width || !height || !total) return { reason: "GIF 尺寸或帧数无效" };
    const canvas = new Uint8Array(width * height * 4);
    const frames = [];
    for (let index = 0; index < total; index++) {
      const info = reader.frameInfo(index);
      if (!info?.width || !info?.height) return { reason: "GIF 帧信息无效" };
      canvas.fill(0);
      reader.decodeAndBlitFrameRGBA(index, canvas);
      const patch = new Uint8Array(info.width * info.height * 4);
      for (let row = 0; row < info.height; row++) {
        const start = ((info.y + row) * width + info.x) * 4;
        patch.set(canvas.subarray(start, start + info.width * 4), row * info.width * 4);
      }
      frames.push({ info, patch });
    }
    const counts = new Map();
    for (const frame of frames) {
      const patch = frame.patch;
      for (let i = 0; i < patch.length; i += 4) {
        if (patch[i + 3] < 128) continue;
        const key = (patch[i] << 16) | (patch[i + 1] << 8) | patch[i + 2];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    if (!counts.size) return { reason: "GIF 没有不透明像素" };
    const wanted = Math.max(2, Math.min(256, paletteSize | 0));
    const colors = medianCutPalette([...counts.entries()].map(([key, w]) => ({ rgb: [(key >> 16) & 255, (key >> 8) & 255, key & 255], w })), wanted - 1);
    const entries = 1 << Math.max(1, Math.ceil(Math.log2(colors.length + 1)));
    const palette = new Array(entries).fill(0);
    colors.forEach((c, i) => { if (i + 1 < entries) palette[i + 1] = (c[0] << 16) | (c[1] << 8) | c[2]; });
    const lookup = new Map();
    const nearest = (r, g, b) => {
      const key = (r << 16) | (g << 8) | b;
      const hit = lookup.get(key);
      if (hit !== undefined) return hit;
      let best = 1, bestDistance = Infinity;
      for (let i = 0; i < colors.length; i++) {
        const d = (colors[i][0] - r) ** 2 + (colors[i][1] - g) ** 2 + (colors[i][2] - b) ** 2;
        if (d < bestDistance) { bestDistance = d; best = i + 1; }
      }
      lookup.set(key, best);
      return best;
    };
    // The encoder needs one contiguous buffer, so reserve the original size plus
    // headroom; an overflow always lands above the original length and is then
    // rejected by the caller.
    const buffer = new Uint8Array(bytes.length + (2 << 20));
    const writer = new api.writer(buffer, width, height, { palette, loop: gifLoopCount(bytes) });
    for (const frame of frames) {
      const { info, patch } = frame;
      const indexed = new Uint8Array(info.width * info.height);
      for (let i = 0, p = 0; i < patch.length; i += 4, p++) {
        indexed[p] = patch[i + 3] < 128 ? 0 : nearest(patch[i], patch[i + 1], patch[i + 2]);
      }
      writer.addFrame(info.x, info.y, info.width, info.height, indexed, { delay: info.delay, disposal: info.disposal, transparent: 0 });
    }
    const length = writer.end();
    if (!length || length >= buffer.length) return { reason: "GIF 重新编码超出预留空间" };
    return { bytes: buffer.subarray(0, length), frames: total, colors: colors.length, size: length };
  }
  function extensionForMime(mime) { return mime === "image/webp" ? "webp" : mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : ""; }
  function replaceImageExtension(name, mime) {
    const extension = extensionForMime(mime);
    // `.img` is Reeden's fixed slot extension: `light/theme_bg.img` (bookshelf
    // background), `light/card_bg.img` (card background),
    // `reader_schema/<id>/bg.img` (reading background) and
    // `light/bookshelf_carousel/000.img` (carousel banner).  Reeden loads
    // those by path, so the entry name must stay exactly as it is even when
    // the payload turns into WebP.  Renaming it to `.webp` is what made the
    // compressed theme lose every background.
    return extension && /\.(?:png|jpe?g|webp|gif)$/i.test(String(name || "")) ? String(name).replace(/\.(?:png|jpe?g|webp|gif)$/i, `.${extension}`) : String(name || "");
  }
  async function compressImage(bytes, name, options = {}) {
    const original = bytesOf(bytes), mime = mimeFromBytes(original, name);
    const decision = { path: name, mime, used: false, originalBytes: original.length };
    const target = resolveImageTarget(name, options);
    decision.role = target.role; decision.preset = target.preset;
    if (Array.isArray(options.skipPaths) && options.skipPaths.indexOf(name) >= 0) {
      decision.reason = "九宫格资源保留坐标，未压缩";
      return { bytes: original, mime, decision };
    }
    if (target.skip) { decision.reason = "阅读背景按设置保留原样"; return { bytes: original, mime, decision }; }
    if (mime === "image/gif") {
      if (!target.gifColors) { decision.reason = "GIF 按设置保留原样"; return { bytes: original, mime, decision }; }
      if (original.length < 64 * 1024) { decision.reason = "GIF 体积较小，保留原样"; return { bytes: original, mime, decision }; }
      try {
        const result = requantizeGif(original, target.gifColors);
        if (!result.bytes || result.size >= original.length) { decision.reason = result.reason || "GIF 重新量化后未变小"; return { bytes: original, mime, decision }; }
        decision.used = true;
        decision.reason = `GIF 保留 ${result.frames} 帧、尺寸与播放节奏，颜色合并为 ${result.colors} 色`;
        decision.compressedBytes = result.size; decision.outputMime = "image/gif";
        decision.gif_frames = result.frames; decision.gif_colors = result.colors;
        return { bytes: result.bytes, mime, decision };
      } catch (error) {
        decision.reason = "GIF 重新量化失败，保留原样";
        decision.error = error?.message || "gif_requantize_failed";
        return { bytes: original, mime, decision };
      }
    }
    const skipped = isSkippableImage(original, mime, name);
    if (skipped) { decision.reason = skipped; return { bytes: original, mime, decision }; }
    if (!(mime === "image/png" || mime === "image/jpeg" || mime === "image/webp")) { decision.reason = "格式不在浏览器兼容压缩范围"; return { bytes: original, mime, decision }; }
    if (typeof root.createImageBitmap !== "function") throw new FreeCodecError("当前浏览器不支持 createImageBitmap，无法本地压缩图片", "image_decode_unavailable");
    let bitmap;
    try {
      bitmap = await root.createImageBitmap(new Blob([original], { type: mime }));
    } catch (error) {
      // A theme may contain an image with a valid file signature that the
      // current browser cannot decode (CMYK JPEG, damaged frame, vendor
      // variant, or a truncated optional resource). Do not fail the whole
      // RED import for that one resource: preserve its original bytes and
      // let the remaining images continue through compression/preview.
      decision.reason = "当前浏览器无法解码，保留原图";
      decision.error = error?.message || "image_decode_failed";
      return { bytes: original, mime, decision };
    }
    try {
      const maxEdge = target.maxEdge;
      const scale = maxEdge ? Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)) : 1;
      const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = root.OffscreenCanvas ? new root.OffscreenCanvas(width, height) : root.document?.createElement("canvas");
      if (!canvas) throw new FreeCodecError("当前浏览器没有 Canvas，无法本地压缩图片", "canvas_unavailable");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d"); if (!context) throw new FreeCodecError("无法创建 Canvas 2D 上下文", "canvas_unavailable");
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high"; context.drawImage(bitmap, 0, 0, width, height);
      const quality = Math.min(1, Math.max(0.01, Number(target.quality ?? 88) / 100));
      // OffscreenCanvas only exposes convertToBlob(); HTMLCanvasElement only
      // exposes toBlob().  Using toBlob whenever the requested type differed
      // from the source type made every PNG/JPEG keep its original format (the
      // call threw and fell into the same-type branch), which is why package
      // savings stayed around 30% instead of turning the large bitmaps into
      // WebP.
      const encode = type => canvas.convertToBlob
        ? canvas.convertToBlob({ type, quality })
        : new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new FreeCodecError("图片编码失败", "image_encode_failed")), type, quality));
      let outputMime = mime;
      let blob = null;
      if (target.codec !== "png" && mime !== "image/webp") {
        try { blob = await encode("image/webp"); if (blob?.size && blob.size < original.length) outputMime = "image/webp"; else blob = null; } catch { blob = null; }
      }
      if (!blob) blob = await encode(target.codec === "png" ? "image/png" : mime);
      // The tab bar is drawn at a few dozen pixels but ships as a big bitmap;
      // lossless PNG of the resized copy is often smaller *and* crisper than
      // lossy WebP, so compare the two and keep the better one.  A PNG target is
      // already lossless, so there is nothing to compare.
      if (target.iconLossless && target.codec !== "png" && width * height <= 2048 * 2048) {
        try {
          const lossless = await encode("image/png");
          if (lossless?.size && lossless.size < blob.size) { blob = lossless; outputMime = "image/png"; }
        } catch { /* keep the lossy candidate */ }
      }
      const candidate = new Uint8Array(await blob.arrayBuffer());
      if (candidate.length >= original.length) { decision.reason = "压缩结果未变小"; return { bytes: original, mime, decision }; }
      decision.used = true; decision.reason = outputMime === "image/webp" ? "转为 WebP 后体积更小" : "压缩后体积更小"; decision.compressedBytes = candidate.length; decision.width = width; decision.height = height; decision.outputMime = outputMime; decision.outputName = replaceImageExtension(name, outputMime);
      decision.role = target.role; decision.preset = target.preset; decision.max_edge = maxEdge; decision.quality = Math.round(quality * 100);
      return { bytes: candidate, mime: outputMime, decision };
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
    // Hidden-name private exports commonly store the shelf and reader
    // backgrounds as 926x2048 JPEGs (aspect ~0.45). Keep both bindings when
    // dimensions and payload order make them unambiguous: the first portrait
    // image after the splash is the shelf background and the last is the
    // reader background. The former 0.65–0.85 ratio rejected these real
    // resources and left browser previews with an empty shelf panel.
    const tallCandidates = found.filter(item => !item.role && item.width && item.height
      && item.width >= 850 && item.height >= 1300 && item.width / item.height >= 0.35
      && item.width / item.height <= 0.65);
    if (tallCandidates.length) {
      tallCandidates[0].role = "shelf";
      if (tallCandidates.length > 1) tallCandidates[tallCandidates.length - 1].role = "reader";
    }
    // 新版导出会把背景图裁成方形或异形（例如 2048x2048、1170x2532），尺寸规则
    // 全部落空。这时预览只能拿封面去填手机屏，看起来像阅读主题拼错了。按面积
    // 兜底：最大的图当书架背景，第二大的竖图当阅读背景。只对应用主题生效，
    // 封面图集不受影响。
    const bundleTheme = String(parsed.header?.resourceType || "") === "themeBundle";
    if (bundleTheme && found.length && !found.some(item => item.role === "shelf")) {
      const unbound = found.filter(item => !item.role && item.width && item.height);
      if (unbound.length) {
        const byArea = [...unbound].sort((a, b) => b.width * b.height - a.width * a.height);
        byArea[0].role = "shelf";
        const readerCandidate = byArea.slice(1).find(item => item.width / item.height <= .85);
        if (readerCandidate) readerCandidate.role = "reader";
      }
    }
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
    if(startsWith(raw,RED_READER)){const entries=await readReaderEntries(raw);return {format:"red_v1_gzip",compressionSupported:false,originalPreserved:true,entries:entries.map(entry=>({name:entry.name,bytes:entry.bytes.length,mime:mimeFromBytes(entry.bytes,entry.name)}))};}
    if (!RED_ZIP_HEADERS.some(header => startsWith(raw, header))) throw new FreeCodecError("缺少 RED\\x04、RED\\x02 或 RED\\x10 头", "red_header_invalid");
    const entries = await readZipEntries(raw);
    const format = entries.containerFormat || "red_v4";
    return { format, entries: entries.map(entry => ({ name: entry.name, bytes: entry.bytes.length, mime: mimeFromBytes(entry.bytes, entry.name) })), compressionSupported: format === "red_v4" };
  }
  async function compressRed(value, options = {}) {
    const raw = await readBytes(value);
    if(startsWith(raw,RED_READER)){
      await readReaderEntries(raw,{images:false});
      return {bytes:raw,originalBytes:raw.length,compressedBytes:raw.length,savedBytes:0,packageSelected:false,format:"red_v1_gzip",originalPreserved:true,decisions:[{path:"readerColorSchema",used:false,reason:"阅读主题保留原始 gzip 封装"}]};
    }
    if (startsWith(raw, RED_PRIVATE)) throw new FreeCodecError("加密 RED v2 当前浏览器版本只做结构识别，暂不重新封包；请使用电脑后台版本", "private_red_unsupported");
    // 封面图集是 RED\x02 + 普通 ZIP，图片用 `1.jpg`、`2.jpg` 这种序号命名。
    // 压缩会把 JPEG 换成 WebP 并改扩展名，序号文件一旦改名图集就可能整包
    // 读不出封面，所以这里只做完整性校验，原样保留。
    if (startsWith(raw, RED_GALLERY)) {
      const entries = await readZipEntries(raw);
      return { bytes: raw, originalBytes: raw.length, compressedBytes: raw.length, savedBytes: 0, packageSelected: false, format: "red_v2_gallery", originalPreserved: true, decisions: [{ path: "封面图集", used: false, reason: "图集按序号文件名取图，保留原始 ZIP 封装" }].concat(entries.map(entry => ({ path: entry.name, used: false, reason: "图集原包保留" }))) };
    }
    const entries = await readZipEntries(raw);
    const skipPaths = nineSlicePaths(entries);
    const codecOptions = skipPaths.length ? { ...options, skipPaths } : options;
    const replacements = Object.create(null), extensions = Object.create(null), paths = Object.create(null), decisions = [], output = [];
    let done=0;
    options.onProgress?.({stage:"image",completed:0,total:entries.length});
    const processed = await mapConcurrent(entries, options.concurrency || defaultConcurrency(3), async entry => {
      const bytes = entry.bytes;
      let result = { bytes, decision: { path: entry.name, mime: mimeFromBytes(bytes, entry.name), used: false, reason: "非图片资源" } };
      if (result.decision.mime.startsWith("image/")) result = await compressImage(bytes, entry.name, codecOptions);
      if (result.decision.used) {
        const [oldSha, newSha] = await Promise.all([sha256Hex(bytes), sha256Hex(result.bytes)]);
        replacements[md5Hex(bytes)] = md5Hex(result.bytes);
        replacements[oldSha] = newSha;
        const nextName = result.decision.outputName || entry.name;
        paths[entry.name] = nextName;
        const extension = nextName.match(/\.([A-Za-z0-9]+)$/)?.[0] || "";
        extensions[md5Hex(bytes)] = extension; extensions[oldSha] = extension;
      }
      options.onProgress?.({stage:"image",completed:++done,total:entries.length,name:entry.name});
      return {entry, result, outputName: result.decision.used ? (result.decision.outputName || entry.name) : entry.name};
    });
    for (const {entry, result, outputName} of processed) { decisions.push(result.decision); output.push({ ...entry, name: outputName, bytes: result.bytes }); }
    if (Object.keys(replacements).length) {
      for (const entry of output) if (entry.name.toLowerCase().endsWith(".json")) {
        try { const value = JSON.parse(text(entry.bytes)), mapped = mapReferences(value, replacements, extensions, paths, entry.name); entry.bytes = textBytes(JSON.stringify(mapped)); }
        catch { /* Non-JSON resources keep their original bytes. */ }
      }
    }
    const candidate = await writeZipEntries(output, { concurrency: options.concurrency || defaultConcurrency(3),onProgress:options.onProgress });
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
    const canvas = root.document.createElement("canvas"); canvas.width = options.width || 900; canvas.height = options.height || 520;
    const context = canvas.getContext("2d");
    if (!context) throw new FreeCodecError("当前环境无法创建字体预览画布", "font_preview_canvas_unavailable");
    context.fillStyle = options.background || "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    let face = null;
    try {
      // Passing the bytes directly avoids a WebView/CSP "A network error
      // occurred" from loading a large CJK font through a blob URL.
      face = new root.FontFace(family, bytes); await face.load(); root.document.fonts.add(face);
      const sampleText = options.text || info.previewText;
      let size = options.fontSize || 36;
      context.fillStyle = options.color || "#202530"; context.textBaseline = "middle"; context.textAlign = "center";
      context.font = `${size}px "${family}"`;
      const measured = context.measureText(sampleText).width;
      if (measured > canvas.width - 80) { size *= (canvas.width - 80) / measured; context.font = `${size}px "${family}"`; }
      context.fillText(sampleText, canvas.width / 2, canvas.height / 2);
    } catch (error) {
      // Some large CJK TTFs are valid but rejected by the browser's OTS
      // loader. OpenType.js can still read their glyph outlines locally.
      const parser = root.opentype || root.OpenType || root.window?.opentype || (typeof globalThis !== "undefined" ? globalThis.opentype : null);
      if (!parser?.parse) throw error;
      try {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const parsed = parser.parse(buffer);
        const sampleText = options.text || info.previewText;
        let size = options.fontSize || 36;
        let advance = typeof parsed.getAdvanceWidth === "function" ? parsed.getAdvanceWidth(sampleText, size) : 0;
        if (advance > canvas.width - 80) { size *= (canvas.width - 80) / advance; advance = parsed.getAdvanceWidth(sampleText, size); }
        const x = Math.max(24, (canvas.width - advance) / 2);
        const path = parsed.getPath(sampleText, x, canvas.height / 2 + size * 0.36, size);
        path.fill = options.color || "#202530";
        path.draw(context);
      } catch (fallbackError) {
        throw new FreeCodecError(`字体预览失败：浏览器加载失败（${error?.message || "未知错误"}），轮廓解析失败（${fallbackError?.message || "未知错误"}）`, "font_preview_render_failed");
      }
    }
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new FreeCodecError("字体预览编码失败", "font_preview_encode_failed")), "image/png"));
    return { ...info, family, blob, release() { if (face) root.document.fonts.delete(face); root.URL.revokeObjectURL(url); } };
  }
  const api = { FreeCodecError, RED_ZIP, RED_GALLERY, RED_PRIVATE, COMPRESSION_PRESETS, imageRole, requantizeGif, sha256Hex, md5Hex, crc32, mimeFromBytes, readZipEntries, writeZipEntries, inspectContainer, extractPrivatePreviewImages, compressImage, compressRed, inspectFont, fontPreview, nineSlicePaths };
  if (root && typeof root === "object") root.ReedenFreeCodec = api;
  return api;
});
