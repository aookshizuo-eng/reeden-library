const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
// GitHub Pages mode can point this static UI at a separate sync API without
// putting any R2 credential in the browser. The local Python service remains
// the default when no API base is configured.
const API_BASE_STORAGE_KEY = "reeden-api-base";
const FALLBACK_API_BASE = "https://red-garden-sync.pages.dev";
const SYNC_TOKEN_STORAGE_KEY = "reeden-sync-write-token";
function normalizeApiBase(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  try {
    const url = new URL(text, window.location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) return "";
    return url.href.replace(/\/$/, "");
  } catch { return ""; }
}
let apiBase = normalizeApiBase(window.REEDEN_API_BASE || (() => {
  try {
    const saved = localStorage.getItem(API_BASE_STORAGE_KEY) || "";
    return saved.includes("reeden-library-sync.773541521.workers.dev") ? FALLBACK_API_BASE : saved;
  } catch { return ""; }
})());
let syncToken = (() => { try { return localStorage.getItem(SYNC_TOKEN_STORAGE_KEY) || ""; } catch { return ""; } })();
let remoteUnavailable = false;
let freeCodecModule;
// Reserved browser-processing hook. A future free_codec.js can expose the
// actual ZIP/AES-GCM/Web Worker implementation without changing this UI. Until
// it reports ready=true, this app never claims that a local browser job ran.
async function loadFreeCodec() {
  if (window.ReedenFreeCodec || window.REEDEN_FREE_CODEC) return window.ReedenFreeCodec || window.REEDEN_FREE_CODEC;
  if (freeCodecModule !== undefined) return freeCodecModule;
  try {
    const loaded = await import("./free_codec.js");
    // The codec is a UMD file. In an ES module import its exports live on the
    // namespace only when bundled; the browser build also publishes the same
    // object on globalThis, so prefer that canonical object.
    freeCodecModule = window.ReedenFreeCodec || loaded?.default || loaded?.ReedenFreeCodec || loaded || null;
  } catch { freeCodecModule = null; }
  return window.ReedenFreeCodec || freeCodecModule;
}
function freeCodecReady() { return Boolean(window.ReedenFreeCodec?.inspectContainer || window.REEDEN_FREE_CODEC?.inspectContainer || freeCodecModule?.inspectContainer); }
function apiUrl(path) {
  if (/^(?:https?:|data:|blob:)/i.test(String(path))) return String(path);
  return `${apiBase}${String(path).startsWith("/") ? path : `/${path}`}`;
}
function staticHostedWithoutApi() {
  const host = String(window.location.hostname || "").toLowerCase();
  return !apiBase && window.location.protocol === "https:" && (host.endsWith(".github.io") || host.endsWith(".pages.dev"));
}
function assetUrl(path) { return path ? apiUrl(path) : ""; }
function updateRuntimeMode() {
  const label = $("#runtimeModeLabel");
  if (label) label.textContent = remoteUnavailable ? "本地浏览器处理模式" : apiBase ? "设备同步模式 · R2 API" : staticHostedWithoutApi() ? "等待连接同步 Worker" : "本地处理模式";
  const note = $("#staticModeNote");
  if (note) {
    note.hidden = !apiBase && !remoteUnavailable && !staticHostedWithoutApi();
    note.textContent = staticHostedWithoutApi()
      ? "当前 APK/静态网页没有本机后端。请在“存储设置 → 多设备访问”填写 Cloudflare Worker 地址和同步 Token 后，手机与电脑才会共用 R2。"
      : remoteUnavailable
      ? (freeCodecReady() ? "同步 API 暂时不可用，已切换为本地浏览器处理模式。处理结果会在 API 恢复后同步；页面关闭会暂停本地任务。" : "同步 API 不可用；本地浏览器处理器尚未加载，未执行压缩或上传。请清除同步地址使用电脑本地服务，或稍后重试。")
      : "当前为多设备同步模式：手机和电脑共用同一个 API 与 R2。压缩和重新封包在当前设备浏览器中进行，页面关闭后处理会暂停。";
  }
  const input = $("#apiBaseInput");
  if (input && document.activeElement !== input) input.value = apiBase;
  const tokenInput = $("#syncTokenInput");
  if (tokenInput && document.activeElement !== tokenInput) tokenInput.value = syncToken;
}
function markRemoteUnavailable(reason = "") {
  if (!apiBase) return;
  remoteUnavailable = true;
  updateRuntimeMode();
  const status = $("#apiBaseStatus");
  if (status && reason) operationMessage(status, `同步 API 不可用：${reason}。未执行压缩或上传。`, true);
}
function saveApiBaseSetting() {
  const input = $("#apiBaseInput");
  const value = String(input?.value || "").trim();
  if (value && !normalizeApiBase(value)) {
    operationMessage($("#apiBaseStatus"), "请输入完整的 HTTP 或 HTTPS API 地址，不要带路径、查询参数或片段。", true);
    return;
  }
  apiBase = normalizeApiBase(value);
  syncToken = String($("#syncTokenInput")?.value || "").trim();
  remoteUnavailable = false;
  try {
    if (apiBase) localStorage.setItem(API_BASE_STORAGE_KEY, apiBase);
    else localStorage.removeItem(API_BASE_STORAGE_KEY);
    if (apiBase && syncToken) localStorage.setItem(SYNC_TOKEN_STORAGE_KEY, syncToken);
    else localStorage.removeItem(SYNC_TOKEN_STORAGE_KEY);
  } catch {}
  updateRuntimeMode();
  operationMessage($("#apiBaseStatus"), apiBase ? "已保存同步地址。正在读取共享库…" : "已清除同步地址，当前使用本机服务。");
  (async () => {
    try {
      await loadStorage();
      await Promise.all([loadThemes(), loadFonts(), loadAssets(), ...(browserSyncEnabled() ? [] : [loadPendingThemes()]), loadJobs()]);
    } catch (error) { operationMessage($("#apiBaseStatus"), `连接失败：${error.message}`, true); }
  })();
}
function requestHeaders(headers = {}) {
  const result = new Headers(headers);
  if (apiBase && syncToken) result.set("Authorization", `Bearer ${syncToken}`);
  return result;
}
const state = { themes: [], fonts: [], assets: [], review: [], jobs: [], activeView: "import", importKind: "theme", assetFilter: "all", assetSearch: "", fontSearch: "", fontFilter: "all", storage: null, operation: "", importFontIds: readSessionIds("reeden-import-fonts"), importThemeJobIds: readSessionIds("reeden-import-theme-jobs"), importAssetIds: readSessionIds("reeden-import-assets") };
const selections = { review: new Set(), theme: new Set(), font: new Set(), asset: new Set() };
const loadedFontFaces = new Set();
const BROWSER_TASK_CONCURRENCY = 3;
const BROWSER_RECORD_CACHE_TTL = 15000;
let browserLibraryRecordsCache;
let browserLibraryRecordsPromise;
let browserLibraryRecordsLoadedAt = 0;
let storageDirty = false;
let jobsPollTimer;
let jobsLoading = false;
let jobsRevision = "";
let pan123QrSession;
let pan123QrTimer;
let pan123QrExpiryTimer;
let pan123QrGeneration = 0;
let pan123QrController;
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
  await Promise.all(Array.from({ length: width }, consume));
  return result;
}
function invalidateBrowserLibraryRecords() {
  browserLibraryRecordsCache = undefined;
  browserLibraryRecordsLoadedAt = 0;
}
function readSessionIds(key) {
  try { const value = JSON.parse(sessionStorage.getItem(key) || "[]"); return Array.isArray(value) ? value.filter(id => typeof id === "string") : []; }
  catch { return []; }
}
function saveSessionIds(key, ids) { try { sessionStorage.setItem(key, JSON.stringify(ids)); } catch {} }
function activeJobs() { return state.jobs.filter(job => ["queued", "running"].includes(job.status)); }
function activeAssetIds(kind) {
  return new Set(activeJobs().flatMap(job => (job.items || []).filter(item => item.kind === kind).map(item => item.id)));
}
function jobHasId(job, id) { return (job.ids || []).includes(id) || (job.items || []).some(item => item.id === id); }
function isAssetBusy(kind, id) {
  if (activeAssetIds(kind).has(id)) return true;
  if (kind === "staging") return activeJobs().some(job => job.action === "commit-themes" && jobHasId(job, id));
  const record = kind === "theme" ? state.themes.find(item => item.id === id) : null;
  return Boolean(record?.source_staging_id && activeJobs().some(job => job.action === "commit-themes" && jobHasId(job, record.source_staging_id)));
}
function assetJob(record) { return activeJobs().find(job => jobHasId(job, record.id) || (record.source_staging_id && job.action === "commit-themes" && jobHasId(job, record.source_staging_id))); }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("is-visible"), 2600);
}
async function api(path, options = {}) {
  if (staticHostedWithoutApi()) {
    throw new Error("当前 APK/静态网页尚未连接同步 Worker；请到“存储设置 → 多设备访问”填写 Worker 地址和同步 Token");
  }
  if (apiBase && remoteUnavailable) throw new Error("同步 API 不可用，未执行远程操作；请检查地址或清除同步地址使用本机服务");
  const request = { ...options, headers: requestHeaders(options.headers || {}) };
  let response;
  try { response = await fetch(apiUrl(path), request); }
  catch (error) {
    if (apiBase) markRemoteUnavailable(error.message || "网络连接失败");
    throw error;
  }
  const responseText = await response.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("同步写入令牌无效或已过期，请到“存储设置”重新保存同步写入 Token；文件本身没有问题。");
    }
    if (response.status === 405) {
      const message = "同步地址返回 405：请在“设置 → 多设备访问”填写 Cloudflare Worker 的 workers.dev 地址，而不是 GitHub Pages 网页地址或 Cloudflare 控制台地址；修改 Worker 后还要重新部署。";
      if (apiBase) markRemoteUnavailable(message);
      throw new Error(message);
    }
    if (apiBase && [404, 405, 500, 502, 503].includes(response.status)) {
      markRemoteUnavailable(`HTTP ${response.status}`);
      const detail = data.error || data.message || responseText.trim().slice(0, 240);
      throw new Error(`同步 API 暂不可用（HTTP ${response.status}）${detail ? `：${detail}` : ""}，未执行压缩或上传`);
    }
    const detail = data.error || data.message || responseText.trim().slice(0, 240);
    throw new Error(`请求失败（${response.status}）${detail ? `：${detail}` : ""}`);
  }
  if (apiBase && remoteUnavailable) { remoteUnavailable = false; updateRuntimeMode(); }
  return data;
}
function browserSyncEnabled() {
  return Boolean(apiBase && state.storage?.mode === "browser-local");
}
function browserPrivateCompressionEnabled() {
  // The sync Worker keeps the private RED format key server-side. The browser
  // only supplies compressed image replacements, so mobile can process a
  // private package without receiving the key.
  return browserSyncEnabled();
}
function base64Bytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  let output = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    output += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
  }
  return btoa(output);
}
function imageExtensionForMime(mime) {
  return mime === "image/webp" ? "webp" : mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : "";
}
async function compressPrivateRedViaWorker(raw, codec, options = {}) {
  const previewEntries = await codec.extractPrivatePreviewImages(raw, { limit: 2000, maxBytes: 80 * 1024 * 1024 });
  const replacements = [];
  for (const entry of previewEntries) {
    const result = await codec.compressImage(entry.bytes, entry.name, options);
    if (!result?.decision?.used || result.bytes.length >= entry.bytes.length) continue;
    const [oldSha256, newSha256, oldMd5, newMd5] = await Promise.all([
      codec.sha256Hex(entry.bytes), codec.sha256Hex(result.bytes), codec.md5Hex(entry.bytes), codec.md5Hex(result.bytes),
    ]);
    replacements.push({ offset: entry.offset, end: entry.end, oldSha256, newSha256, oldMd5, newMd5, newExtension: imageExtensionForMime(result.mime), bytes: base64Bytes(result.bytes) });
  }
  if (!replacements.length) {
    return { bytes: raw, originalBytes: raw.length, compressedBytes: raw.length, savedBytes: 0, packageSelected: false, decisions: [], format: "red_private_v2", privateWorker: true };
  }
  const response = await fetch(apiUrl("/api/private/repack"), {
    method: "POST",
    headers: requestHeaders({ "Content-Type": "application/json" }),
  body: JSON.stringify({ red_base64: base64Bytes(raw), replacements: replacements.map(item => ({ offset: item.offset, end: item.end, old_sha256: item.oldSha256, old_md5: item.oldMd5, new_md5: item.newMd5, new_extension: item.newExtension, bytes_base64: item.bytes })) }),
  });
  const responseText = await response.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
  if (!response.ok) {
    const detail = data.error || data.message || responseText.trim().slice(0, 240);
    throw new Error(`加密主题重封失败（${response.status}）${detail ? `：${detail}` : ""}`);
  }
  if (!data.bytes) throw new Error("加密主题重封接口没有返回压缩包");
  const encoded = atob(data.bytes), output = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index++) output[index] = encoded.charCodeAt(index);
  if (output.length >= raw.length) {
    return { bytes: raw, originalBytes: raw.length, compressedBytes: raw.length, savedBytes: 0, packageSelected: false, decisions: replacements.map(item => ({ path: `private@${item.offset}`, used: false, reason: "重封后未变小，保留原包", original_bytes: item.end - item.offset, compressed_bytes: atob(item.bytes).length })), format: "red_private_v2", privateWorker: true };
  }
  return { bytes: output, originalBytes: raw.length, compressedBytes: output.length, savedBytes: Math.max(0, raw.length - output.length), packageSelected: output.length < raw.length, decisions: replacements.map(item => ({ path: `private@${item.offset}`, used: true, reason: "压缩后由同步 Worker 认证重封", original_bytes: item.end - item.offset, compressed_bytes: atob(item.bytes).length })), format: "red_private_v2", privateWorker: true };
}
async function browserCodec() {
  const codec = await loadFreeCodec();
  if (!codec?.inspectContainer || !codec?.sha256Hex || !codec?.md5Hex || !codec?.compressImage || !codec?.extractPrivatePreviewImages) throw new Error("浏览器处理器未加载，请刷新页面后重试");
  return codec;
}
async function uploadBrowserObject(kind, sha, extension, body, contentType) {
  const path = `/api/objects/${encodeURIComponent(kind)}/${encodeURIComponent(sha)}.${extension}`;
  const request = (method) => fetch(apiUrl(path), {
    method,
    headers: requestHeaders({ "Content-Type": contentType || "application/octet-stream" }),
    body,
  });
  // PUT is the canonical R2 object method. A few WebView proxies and older
  // Worker deployments reject PUT with 405; retrying as POST keeps the same
  // content-addressed endpoint while the Worker accepts both methods.
  let response = await request("PUT");
  if (response.status === 405) response = await request("POST");
  if (!response.ok) {
    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
    if (response.status === 401) {
      throw new Error("同步写入令牌无效或已过期，请到“存储设置”重新保存同步写入 Token；文件本身没有问题。");
    }
    if (response.status === 405) {
      throw new Error("同步 API 返回 405：请确认填写的是 Worker 地址而不是 Pages 或 Cloudflare 控制台地址，并重新部署最新 Worker");
    }
    const detail = data.error || data.message || responseText.trim().slice(0, 240);
    throw new Error(`上传失败（${response.status}）${detail ? `：${detail}` : ""}`);
  }
  return path;
}
async function uploadBrowserRecord(record, codec) {
  // Records are immutable content-addressed objects. Keep a stable asset id
  // and timestamp so a classification edit supersedes its older record.
  if (!record.updated_at) record.updated_at = new Date().toISOString();
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const recordSha = await codec.sha256Hex(bytes);
  await uploadBrowserObject("records", recordSha, "json", bytes, "application/json");
  record.record_sha256 = recordSha;
  invalidateBrowserLibraryRecords();
  return record;
}
function normalizeIdentity(value) {
  return String(value || "").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}
function browserDuplicateCandidates(name, author) {
  const target = `${normalizeIdentity(name)}\u0000${normalizeIdentity(author || "作者未记录")}`;
  return state.themes.filter(theme => `${normalizeIdentity(theme.name)}\u0000${normalizeIdentity(theme.author || "作者未记录")}` === target);
}
function filenameIdentityFallback(fileName) {
  const stem = String(fileName || "主题").replace(/\.red$/i, "").replace(/\s*[([【（].*?(?:加密|未加密|日夜|夜间).*?[)\]】）]\s*$/i, "").replace(/\s*[-_·]?(?:未加密|加密|日夜|夜间)\s*$/i, "").replace(/\s*\(\d+\)\s*$/i, "").trim();
  const parts = (stem.includes("_-_") ? stem.split(/_-_+/) : stem.split(/\s*[-—–]\s+/)).map(item => item.trim()).filter(Boolean);
  if (parts.length < 3) return { name: stem || "主题", author: "作者未记录" };
  const first = parts[0];
  const author = parts[1];
  const name = /^(?:应用主题|主题|reeden)$/i.test(first) ? parts.slice(2).join(" - ") : parts.slice(2).join(" - ");
  return { name: name || stem || "主题", author: author || "作者未记录" };
}
function metadataFromEntries(entries, fileName) {
  const fallback = filenameIdentityFallback(fileName);
  let name = fallback.name, author = fallback.author;
  let metadataName = false, metadataAuthor = false;
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (!metadataName) {
      const candidate = value.name || value.title || value.themeName || value.theme_name;
      if (typeof candidate === "string" && candidate.trim()) { name = candidate.trim(); metadataName = true; }
    }
    if (!metadataAuthor) {
      const candidate = value.author || value.creator || value.designer || value.by || value.themeAuthor;
      if (typeof candidate === "string" && candidate.trim()) { author = candidate.trim(); metadataAuthor = true; }
    }
    for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
  };
  for (const entry of entries || []) {
    if (!entry.name?.toLowerCase().endsWith(".json")) continue;
    try {
      const value = JSON.parse(new TextDecoder().decode(entry.bytes));
      visit(value);
      if (metadataName && metadataAuthor) break;
    } catch { /* JSON assets can be unrelated configuration. */ }
  }
  return { name, author };
}
async function imagePreviewBlob(bytes, mime, maxWidth = 900) {
  if (!bytes?.length || !mime?.startsWith("image/") || typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    try {
      const ratio = Math.min(1, maxWidth / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const context = canvas.getContext("2d"); if (!context) return null;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .86));
    } finally { bitmap.close?.(); }
  } catch { return null; }
}
function previewRole(name) {
  const value = String(name || "").replace(/\\/g, "/").toLowerCase();
  if (/navbar_pack|navbar|bottom_bar|tabbar|(^|[/_.-])(icon|normal|selected)([/_.-]|$)/i.test(value)) return "icon";
  if (/custom_splash|splash|launch|startup|welcome|opening|启动|开屏/i.test(value)) return "splash";
  if (/reader_schema|reader_background|reading|article|content|book_page|reader|正文|阅读/i.test(value)) return "reader";
  if (/cover_gallery|book_cover|cover|封面|书封|图集/i.test(value)) return "cover";
  if (/carousel|banner|轮播|横幅/i.test(value)) return "carousel";
  if (/card_bg|cardbackground|card-background|book_card|bookshelf_card|书架卡片|书卡|卡片/i.test(value)) return "card";
  if (/theme_bg|bookshelf|shelf|library|background|书架|书架底|首页|主页/i.test(value)) return "shelf";
  return "other";
}
function isNightAsset(name) {
  return /(^|[._/-])(dark|night|nighttime|darkmode|黑夜|夜间)([._/-]|$)/i.test(String(name || ""));
}
async function composeThemePreviewBlob(entries, codec) {
  if (!Array.isArray(entries) || typeof createImageBitmap !== "function") return null;
  const allImages = entries
    .map((entry, index) => ({entry, index, mime: codec.mimeFromBytes(entry.bytes, entry.name), role: entry.role || previewRole(entry.name)}))
    .filter(item => item.mime?.startsWith("image/") && item.role !== "icon");
  // Select one visual mode for a preview.  Mixing day shelf art with a night
  // splash makes the thumbnail look like a broken theme, while filtering all
  // night resources leaves night-only packages blank.  Prefer the complete
  // daytime set whenever it exists, then fall back to the complete night set.
  const dayImages = allImages.filter(item => !isNightAsset(item.entry.name));
  const images = dayImages.length ? dayImages : allImages;
  if (!images.length) return null;
  // Decode once to classify nameless images recovered from encrypted REDs.
  for (const item of images) {
    try {
      const bitmap = await createImageBitmap(new Blob([item.entry.bytes], {type: item.mime}));
      item.width = bitmap.width; item.height = bitmap.height; item.aspect = bitmap.width / Math.max(1, bitmap.height); bitmap.close?.();
    } catch { item.aspect = 1; }
  }
  const privatePreview = images.some(item => /^private-preview-/i.test(String(item.entry.name || "")));
  let splash = images.find(item => item.role === "splash") || null;
  let reader = images.find(item => item.role === "reader") || null;
  const wide = images.filter(item => item.role === "carousel" || item.role === "shelf" || (item.role === "other" && item.aspect > 1.55));
  const namedShelf = images.find(item => item.role === "shelf");
  let shelf;
  let card;
  let carousel;
  let covers;
  if (privatePreview) {
    // RED v2 keeps the manifest encrypted, so these entries have no names.
    // The fallback uses observable dimensions and payload order instead of a
    // fixed image index: the public metadata role identifies a real splash;
    // the first tall portrait image after it is the shelf background and the
    // last is the reader background. Current private exports use 926x2048
    // JPEGs (aspect ~0.45), so a width >=1000 or aspect >=.65 check would
    // incorrectly discard both and leave the shelf panel blank. Small
    // resources before the splash are the cover gallery. This also keeps
    // transparent navigation art (for example the anchor) out of the reader.
    const tallPortraits = images.filter(item => {
      const imageMime = item.mime === "image/jpeg" || item.mime === "image/png" || item.mime === "image/webp";
      return imageMime && item.width >= 850 && item.height >= 1300 && item.aspect >= .35 && item.aspect <= .65 && item !== splash;
    });
    // For nameless resources dimensions are the primary signal. Public
    // metadata roles are retained when available, and the shape-based signal
    // fills only the missing shelf/reader bindings.
    const shelfBackgrounds = tallPortraits.filter(item => !splash || item.index > splash.index);
    shelf = shelfBackgrounds[0] || namedShelf || null;
    const readerBackgrounds = shelfBackgrounds.filter(item => item !== shelf);
    reader = readerBackgrounds[readerBackgrounds.length - 1] || reader || images.find(item => item.role === "reader") || images.find(item => item.mime === "image/png" && item.width >= 1000 && item.aspect < .7) || null;
    carousel = images.find(item => item.role === "carousel") || null;
    const coverLimit = splash ? splash.index : (shelfBackgrounds[0]?.index ?? images.length);
    covers = images.filter(item => item.index < coverLimit && item !== splash && item !== shelf && item !== reader && item.role !== "card" && item.width <= 1100 && item.height <= 1600).slice(0, 6);
    if (!covers.length) covers = images.filter(item => item.role === "cover" && item !== splash && item !== shelf && item !== reader).slice(0, 6);
    if (!covers.length) covers = images.filter(item => item !== splash && item !== shelf && item !== reader && item.width <= 1100 && item.height <= 1600).slice(0, 6);
    try { entries.previewKind = splash ? "shelf_and_splash" : "shelf_and_reader"; } catch {}
  } else {
    shelf = namedShelf || images.find(item => item.role === "shelf") || wide.find(item => item.role === "shelf") || null;
    card = images.find(item => item.role === "card") || null;
    // A normal RED has explicit resource paths. Only use a named carousel;
    // treating an unrelated wide image (especially card_bg) as a banner makes
    // the shelf preview look like a blank or stretched panel.
    carousel = images.find(item => item.role === "carousel") || null;
    covers = images.filter(item => item !== shelf && item !== card && item !== carousel && item.role === "cover").slice(0, 6);
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1000; canvas.height = 1000;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#e9e7df"; context.fillRect(0, 0, canvas.width, canvas.height);
  const drawFit = async (item, x, y, width, height, mode = "cover") => {
    if (!item) return;
    let bitmap;
    try { bitmap = await createImageBitmap(new Blob([item.entry.bytes], {type: item.mime})); } catch { return; }
    try {
      const scale = mode === "contain"
        ? Math.min(width / bitmap.width, height / bitmap.height)
        : Math.max(width / bitmap.width, height / bitmap.height);
      const drawWidth = bitmap.width * scale, drawHeight = bitmap.height * scale;
      const dx = x + (width - drawWidth) / 2, dy = y + (height - drawHeight) / 2;
      context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip();
      context.drawImage(bitmap, dx, dy, drawWidth, drawHeight); context.restore();
    } finally { bitmap.close?.(); }
  };
  // Keep the thumbnail square, but let the actual theme artwork dominate it:
  // a real splash goes left when present; otherwise use a real reader page.
  context.fillStyle = "#e9e7df"; context.fillRect(16, 16, 968, 968);
  context.fillStyle = "#f8f8f5"; context.fillRect(28, 28, 390, 936);
  const leftAsset = splash || reader || shelf;
  if (leftAsset) await drawFit(leftAsset, 40, 58, 366, 876, splash || reader ? "contain" : "cover");
  else { context.fillStyle = "#cfd9d8"; context.fillRect(40, 58, 366, 876); context.fillStyle = "#253338"; context.font = "600 24px system-ui, sans-serif"; context.fillText("无可用阅读页", 130, 500); }
  const panelX = 436, panelY = 28, panelW = 548, panelH = 936;
  context.fillStyle = "#f8f4e9"; context.fillRect(panelX, panelY, panelW, panelH);
  if (shelf) await drawFit(shelf, panelX, panelY, panelW, panelH, card ? "contain" : "cover");
  // A light veil keeps the cover row readable without hiding the real theme
  // background. The previous version used opaque white blocks and labels,
  // which made encrypted previews look like empty mockups.
  context.fillStyle = "rgba(255,255,255,.18)"; context.fillRect(panelX + 18, panelY + 18, panelW - 36, 202);
  if (carousel) await drawFit(carousel, panelX + 30, panelY + 30, panelW - 60, 178, "contain");
  if (card) {
    // card_bg is the actual bookshelf container (a transparent horizontal
    // card). Repeat it behind the cover thumbnails so the preview reflects
    // the theme's real shelf layout instead of floating covers on empty space.
    const cardX = panelX + 28, cardW = panelW - 56, cardH = 158;
    const firstY = panelY + 300, rowGap = 18;
    for (let index = 0; index < Math.min(covers.length, 4); index++) {
      const y = firstY + index * (cardH + rowGap);
      if (y + cardH > panelY + panelH - 24) break;
      await drawFit(card, cardX, y, cardW, cardH, "cover");
      const coverW = 92, coverH = 132;
      context.fillStyle = "rgba(25,40,42,.16)"; context.fillRect(cardX + 20, y + 14, coverW + 4, coverH + 4);
      await drawFit(covers[index], cardX + 22, y + 12, coverW, coverH, "cover");
      context.fillStyle = "rgba(75,44,52,.74)";
      context.font = "600 16px system-ui, sans-serif";
      context.fillText(`Reeden 主题 ${index + 1}`, cardX + 132, y + 58);
      context.font = "13px system-ui, sans-serif";
      context.fillText("书架卡片预览", cardX + 132, y + 84);
    }
  } else {
    context.fillStyle = "rgba(255,255,255,.48)"; context.fillRect(panelX + 22, panelY + 548, panelW - 44, 330);
    const cardWidth = 86, cardHeight = 168, gap = 16, startX = panelX + 42, startY = panelY + 590;
    for (let index = 0; index < covers.length; index++) {
      const column = index % 5, row = Math.floor(index / 5), x = startX + column * (cardWidth + gap), y = startY + row * (cardHeight + 28);
      if (x + cardWidth > panelX + panelW - 24 || y + cardHeight > panelY + panelH - 34) continue;
      context.fillStyle = "rgba(25,40,42,.16)"; context.fillRect(x + 3, y + 4, cardWidth, cardHeight);
      await drawFit(covers[index], x, y, cardWidth, cardHeight, "cover");
    }
  }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .86));
  try { entries.previewKind = splash ? "shelf_and_splash" : "shelf_and_reader"; } catch {}
  return blob;
}
async function jpegBytesFromBlob(blob) {
  if (!blob || typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      const ratio = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const context = canvas.getContext("2d"); if (!context) return null;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .88));
      return jpeg ? new Uint8Array(await jpeg.arrayBuffer()) : null;
    } finally { bitmap.close?.(); }
  } catch { return null; }
}
function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}
function compressionSummary(theme) {
  if (requiresOriginalPreservation(theme)) return "加密主题 · 原样保存，未压缩";
  if (theme.status === "cloud_existing") return "R2 已有文件 · 历史压缩状态未知";
  if (!theme.compressed_size) return "已有库索引 · 尚未压缩";
  const before = Number(theme.original_size), after = Number(theme.compressed_size);
  if (!before) return `压缩后 ${formatBytes(after)}`;
  const saved = Math.max(0, before - after);
  return `${formatBytes(before)} → ${formatBytes(after)} · ${saved ? `节省 ${(saved / before * 100).toFixed(1)}%` : "原包已较小，保留原字节"}`;
}
function compressionOptions() {
  const quality = Number($("#compressionQuality").value);
  const max_edge = Number($("#compressionMaxEdge").value);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("图片质量请填写 1–100 的整数");
  if (!Number.isInteger(max_edge) || max_edge < 64 || max_edge > 8192) throw new Error("图片长边上限请填写 64–8192 的整数");
  return { quality, max_edge };
}
function renderCompressionResults() {
  const batch = new Set(state.jobs.filter(job => state.importThemeJobIds.includes(job.id)).flatMap(job => job.ids || []));
  const themes = state.themes.filter(theme => batch.has(theme.source_staging_id));
  $("#themeCompressionResults").innerHTML = themes.map(theme => {
    const url = assetUrl(theme.compressed_url || theme.library_url || theme.original_url);
    return `<article class="compression-result"><div><strong>${escapeHtml(theme.name || theme.source_name || "主题")}</strong><p>${escapeHtml(compressionSummary(theme))}</p><p>${escapeHtml(syncLabel(theme))}</p></div>${url ? `<a class="download-link" href="${escapeHtml(url)}">${requiresOriginalPreservation(theme) ? "下载原样主题" : "下载压缩 RED"}</a>` : ""}</article>`;
  }).join("");
}
function preferredPreview(light, dark) {
  return {url: light || dark || "", label: light ? "日间" : dark ? "夜间补位" : "暂无预览"};
}
function previewCompositionKind(entries) {
  if (entries?.previewKind) return entries.previewKind;
  return (entries || []).some(entry => (entry?.role || previewRole(entry?.name)) === "splash") ? "shelf_and_splash" : "shelf_and_reader";
}
function previewKind(details = {}) {
  if (details?.kind === "shelf_and_splash") return "书架 + 启动";
  if (details?.kind === "shelf_and_reader") return "书架 + 阅读页";
  if (details?.kind === "shelf") return "书架模拟";
  if (details?.kind === "splash") return "启动图";
  return "主题预览";
}
function previewImage(url, alt, className = "", details = {}) {
  if (!url) return `<span class="${className} preview-empty" role="img" aria-label="暂无可用预览">暂无预览</span>`;
  url = assetUrl(url);
  const description = details?.encrypted_source
    ? (browserPrivateCompressionEnabled()
      ? "加密 RED 的图片先在当前设备压缩，再交给同步 Worker 认证清单并重新封包。"
      : "加密 RED 清单保持加密；本机服务会压缩包内图片并重新封包。")
    : details?.simulation ? "书架使用主题真实素材离线合成，右侧为书架、轮播和封面图集。" + (details.kind === "shelf_and_splash" ? "左侧为启动图。" : "左侧为阅读页或阅读背景。") : "使用主题包内图片生成的轻量预览。";
  return `<button class="preview-open ${className}" type="button" aria-label="${escapeHtml(alt)}，点击放大" data-preview-url="${escapeHtml(url)}" data-preview-title="${escapeHtml(alt)}" data-preview-description="${escapeHtml(description)}"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" /></button>`;
}
function showPreview(button) {
  const dialog = $("#previewDialog");
  $("#previewDialogTitle").textContent = button.dataset.previewTitle;
  $("#previewDialogDescription").textContent = button.dataset.previewDescription;
  const image = $("#previewDialogImage");
  image.src = assetUrl(button.dataset.previewUrl);
  image.alt = button.dataset.previewTitle;
  dialog.showModal();
}
function requiresOriginalPreservation(record) {
  return record.compression_supported === false || record.status === "private_preserved";
}
function syncLabel(record) {
  const job = assetJob(record);
  if (job) return job.status === "running" ? "后台正在处理" : "已加入后台队列";
  const status = record.sync_status?.library;
  if (record.local_status === "cloud_only" && status === "synced") return "云端已保存 · 本机副本已清理";
  if (status === "synced") return "R2 已同步";
  if (status === "failed") return "R2 同步失败";
  return record.cloud || record.remote ? "云端已收录" : "本地已保存";
}
function resultWarning(result) {
  const warnings = result.warnings || result.warning || result.sync_error;
  if (!warnings) return "";
  if (Array.isArray(warnings)) return warnings.map(item => typeof item === "string" ? item : item.error || item.message || "部分同步失败").join("；");
  return typeof warnings === "string" ? warnings : Object.values(warnings).join("；");
}
function operationMessage(element, message, failed = false) {
  element.textContent = message;
  element.classList.toggle("is-error", failed);
}
// Visible progress for work performed in the browser. Background jobs already
// render their own progress cards; this state covers the device-side stages
// before an object reaches R2 (hashing, compression, preview and upload).
const transferState = { active: false, title: "", total: 0, completed: 0, failed: 0, stage: "", current: "" };
function updateTransferProgress(patch = {}) {
  Object.assign(transferState, patch);
  const panel = $("#transferProgress");
  if (!panel) return;
  const total = Math.max(0, Number(transferState.total) || 0);
  const completed = Math.max(0, Math.min(total || Number.MAX_SAFE_INTEGER, Number(transferState.completed) || 0));
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const title = $("#transferProgressTitle");
  const count = $("#transferProgressCount");
  const bar = $("#transferProgressBar");
  const stage = $("#transferProgressStage");
  const current = $("#transferProgressCurrent");
  if (title) title.textContent = transferState.title || "正在处理";
  if (count) count.textContent = `${completed} / ${total}${transferState.failed ? ` · 失败 ${transferState.failed}` : ""}`;
  if (bar) bar.value = percent;
  if (stage) stage.textContent = transferState.stage || "等待开始";
  if (current) current.textContent = transferState.current || "";
  panel.hidden = false;
  panel.classList.toggle("is-error", transferState.failed > 0);
  panel.classList.toggle("is-complete", !transferState.active && total > 0);
}
function beginTransferProgress(title, total) {
  Object.assign(transferState, { active: true, title, total: Math.max(0, Number(total) || 0), completed: 0, failed: 0, stage: "准备处理", current: "" });
  updateTransferProgress();
}
function transferStage(stage, current = "") {
  updateTransferProgress({ active: true, stage, current });
}
function transferDone(current = "", failed = false) {
  updateTransferProgress({ completed: transferState.completed + 1, failed: transferState.failed + (failed ? 1 : 0), current });
}
function finishTransferProgress(message, failed = transferState.failed) {
  updateTransferProgress({ active: false, title: message, stage: failed ? "处理完成，但有项目失败" : "全部完成", current: failed ? `失败 ${failed} 项，可查看错误后重试` : "已写入共享 R2" });
}
function r2Enabled() { return browserSyncEnabled() || state.storage?.library?.provider === "cloudflare_r2"; }
function autoSyncEnabled() { return browserSyncEnabled() || (r2Enabled() && state.storage?.library?.autoSync); }
function savedToCloud(record) { return record.saved_to_cloud === true || (record.sync_status?.library === "synced" && record.local_status === "cloud_only" && !record.sync_error); }
function eligibleIds(kind) {
  if (kind === "review") return state.review.filter(item => !isAssetBusy("staging", item.staging_id)).map(item => item.staging_id);
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  return collection.filter(item => !savedToCloud(item) && !isAssetBusy(kind, item.id)).map(item => item.id);
}
function selectInput(kind, id, name, disabled = false) {
  return `<input class="item-select" type="checkbox" data-selection="${kind}" data-id="${escapeHtml(id)}" aria-label="选择${escapeHtml(name)}" ${selections[kind].has(id) ? "checked" : ""} ${disabled || state.operation ? "disabled" : ""} />`;
}
function updateBulkControls() {
  const toolbars = [
    ["review", "selectAllReview", "reviewSelectedCount", "commitSelectedThemes"],
    ["theme", "selectAllThemes", "themeSelectedCount", "syncSelectedThemes"],
    ["font", "selectAllFonts", "fontSelectedCount", "syncSelectedFonts"],
    ["asset", "selectAllAssets", "assetSelectedCount", "syncSelectedAssets"],
  ];
  toolbars.forEach(([kind, checkboxId, countId, buttonId]) => {
    const ids = eligibleIds(kind);
    const available = new Set(ids);
    for (const id of selections[kind]) if (!available.has(id)) selections[kind].delete(id);
    const count = selections[kind].size;
    const checkbox = $("#" + checkboxId);
    checkbox.checked = ids.length > 0 && count === ids.length;
    checkbox.indeterminate = count > 0 && count < ids.length;
    checkbox.disabled = Boolean(state.operation) || !ids.length;
    $("#" + countId).textContent = `已选 ${count} / ${ids.length} 项`;
    $("#" + buttonId).disabled = Boolean(state.operation) || storageDirty || !count || (["theme", "font", "asset"].includes(kind) && !r2Enabled());
    $("#" + buttonId).title = storageDirty ? "请先保存存储设置" : "";
  });
  const chosenReview = state.review.filter(item => selections.review.has(item.staging_id));
  const privateCount = chosenReview.filter(item => !browserPrivateCompressionEnabled() && requiresOriginalPreservation(item.info)).length;
  const normalCount = chosenReview.length - privateCount;
  const onlyPrivate = privateCount > 0 && normalCount === 0;
  const syncSuffix = browserSyncEnabled() ? "、上传 R2" : autoSyncEnabled() ? "、同步" : "";
  $("#commitSelectedThemes").textContent = onlyPrivate ? `确认所选并原样保存${syncSuffix}` : `确认所选并压缩${syncSuffix || "保存"}`;
  $("#compressionPlan").textContent = chosenReview.length ? `${chosenReview.length} 个主题将压缩并重新封包${privateCount ? `；${privateCount} 个当前设备无法认证的加密包先保留原包` : ""}。处理完成后显示压缩前后大小。` : "全选或勾选主题后确认，开始处理。加密主题会先压缩包内图片，再由同步 Worker 或电脑本地服务认证清单并重新封包。";
  $$(".compression-controls input").forEach(input => { input.disabled = Boolean(state.operation); });
  $("#themeToolbar").hidden = !state.themes.length;
  $("#fontToolbar").hidden = !state.fonts.length;
  $("#assetToolbar").hidden = !state.assets.length;
  const eligible = Object.fromEntries(Object.keys(selections).map(kind => [kind, new Set(eligibleIds(kind))]));
  $$("[data-selection]").forEach(input => {
    input.checked = selections[input.dataset.selection].has(input.dataset.id);
    input.disabled = Boolean(state.operation) || !eligible[input.dataset.selection].has(input.dataset.id);
    input.closest("article")?.classList.toggle("is-selected", input.checked);
  });
  $$(".sync-theme, .sync-font, .sync-asset").forEach(button => { const kind = button.classList.contains("sync-font") ? "font" : button.classList.contains("sync-asset") ? "asset" : "theme"; button.disabled = Boolean(state.operation) || !r2Enabled() || storageDirty || button.dataset.completed === "true" || isAssetBusy(kind, button.dataset.id); });
  $$(".commit-theme, .discard-review, .rebuild-preview, #chooseThemes, #chooseThemeFolder, #indexThemeFolder, #addThemeButton, #chooseFonts, #chooseFontFolder, #chooseAssets, #chooseAssetFolder, #addAssetButton, #chooseUnifiedFiles, #chooseUnifiedFolder, #scanButton, #indexExistingCloud, #storageForm button[type='submit']").forEach(button => { button.disabled = Boolean(state.operation); });
  $$(".rebuild-preview").forEach(button => { button.disabled = Boolean(state.operation) || isAssetBusy("theme", button.dataset.id); });
  $("#storageForm button[type='submit']").disabled = Boolean(state.operation) || activeJobs().length > 0;
  $$(".commit-theme").forEach(button => { button.disabled = Boolean(state.operation) || storageDirty; button.title = storageDirty ? "请先保存存储设置" : ""; });
  $$(".retry-job").forEach(button => { button.disabled = Boolean(state.operation) || activeJobs().some(job => (job.parent_id || job.retry_of) === button.dataset.retryJob); });
  $$(".drop-zone").forEach(zone => zone.setAttribute("aria-disabled", String(Boolean(state.operation))));
  updateStorageControls();
}
function setOperation(operation) { state.operation = operation; updateBulkControls(); }
function toggleAll(kind, checked) {
  selections[kind] = new Set(checked ? eligibleIds(kind) : []);
  updateBulkControls();
}
const viewNames = { import: "导入", themes: "主题库", fonts: "字体库", assets: "收藏库", jobs: "后台任务", storage: "存储设置" };
function setView(view) {
  if (!viewNames[view]) view = "import";
  const changed = state.activeView !== view;
  state.activeView = view;
  if (view !== "storage") stopPan123Qr();
  if (changed) window.scrollTo(0, 0);
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  $$("[data-view-panel]").forEach(panel => { panel.hidden = panel.dataset.viewPanel !== view; });
  $$(".nav-item").forEach(item => item.classList.toggle("is-active", item.dataset.view === view));
  $("#topbarTitle").textContent = viewNames[view];
  if (view === "themes") loadThemes().catch(error => toast(error.message));
  if (view === "fonts") loadFonts().catch(error => toast(error.message));
  if (view === "assets") loadAssets().catch(error => toast(error.message));
  if (view === "jobs") loadJobs().catch(() => {});
  if (view === "storage") loadStorage().catch(error => toast(error.message));
}
function setImportKind(kind) {
  state.importKind = kind;
  $$("[data-import-kind]").forEach(button => {
    const selected = button.dataset.importKind === kind;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
}
function recordKindPath(kind) {
  return kind === "asset" ? "assets" : kind === "theme" ? "themes" : "fonts";
}
function recordTags(record) {
  return Array.isArray(record?.tags) ? record.tags.filter(Boolean).map(String) : [];
}
function classificationEditor(record, kind) {
  const author = String(record?.author || "").trim();
  const style = String(record?.style || "").trim();
  const tags = recordTags(record);
  return `<div class="record-classifications">${author ? `<span class="category-chip">作者：${escapeHtml(author)}</span>` : `<span class="category-chip is-empty">未分作者</span>`}${style ? `<span class="category-chip">风格：${escapeHtml(style)}</span>` : `<span class="category-chip is-empty">未分风格</span>`}${tags.map(tag => `<span class="category-chip">#${escapeHtml(tag)}</span>`).join("")}</div><form class="asset-meta-form record-classification-form" data-record-form="${escapeHtml(record?.id || "")}" data-record-kind="${escapeHtml(kind)}"><div class="asset-meta-fields"><label>作者<input name="author" value="${escapeHtml(author)}" placeholder="作者" /></label><label>风格<input name="style" value="${escapeHtml(style)}" placeholder="风格" /></label><label>标签<input name="tags" value="${escapeHtml(tags.join(", "))}" placeholder="标签，用逗号分隔" /></label></div><button class="text-button" type="submit">保存分类</button></form>`;
}
function inferFontCategory(font) {
  const text = [font?.family, font?.file_name, font?.subfamily].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
  if (/(?:可爱|萌|童趣|儿童|cute|comic|kids)/i.test(text)) return "可爱字形";
  if (/(?:手写|书写|行书|草书|毛笔|硬笔|手札|hand|script|brush|cursive)/i.test(text)) return "手写体";
  if (/(?:像素|点阵|pixel|bitmap|dot)/i.test(text)) return "像素体";
  if (/(?:圆体|圆润|圆|丸|round|maru|rounded)/i.test(text)) return "圆体";
  if (/(?:楷体|楷书|kai)/i.test(text)) return "楷体";
  if (/(?:仿宋|fangsong)/i.test(text)) return "仿宋";
  if (/(?:宋体|明朝|song|serif|mincho)/i.test(text)) return "宋体";
  if (/(?:黑体|无衬线|黑|hei|sans|gothic|雅黑|苹方)/i.test(text)) return "黑体";
  if (/(?:艺术|装饰|display|decorative)/i.test(text)) return "艺术体";
  return "其他";
}
const DEFAULT_FONT_CATEGORIES = ["宋体", "黑体", "圆体", "手写体", "可爱字形", "像素体", "楷体", "仿宋", "艺术体", "其他"];
function fontCategory(font) {
  return String(font?.style || "").trim() || inferFontCategory(font);
}
function fontCategoryOptions() {
  const categories = new Set(DEFAULT_FONT_CATEGORIES);
  state.fonts.forEach(font => {
    const category = fontCategory(font);
    if (category) categories.add(category);
  });
  return [...categories];
}
function renderFontFilters() {
  const container = $("#fontCategoryFilters");
  if (!container) return;
  const counts = new Map();
  state.fonts.forEach(font => {
    const category = fontCategory(font);
    counts.set(category, (counts.get(category) || 0) + 1);
  });
  const categories = fontCategoryOptions();
  if (state.fontFilter !== "all" && !categories.includes(state.fontFilter)) state.fontFilter = "all";
  container.innerHTML = [`<button class="filter-chip font-filter-chip ${state.fontFilter === "all" ? "is-active" : ""}" type="button" data-font-filter="all">全部 <span>${state.fonts.length}</span></button>`, ...categories.map(category => `<button class="filter-chip font-filter-chip ${state.fontFilter === category ? "is-active" : ""}" type="button" data-font-filter="${escapeHtml(category)}" ${counts.get(category) ? "" : "disabled"}>${escapeHtml(category)} <span>${counts.get(category) || 0}</span></button>`)].join("");
}
function fontClassificationEditor(font) {
  const style = fontCategory(font);
  const tags = recordTags(font);
  return `<div class="record-classifications"><span class="category-chip">分类：${escapeHtml(style)}</span>${tags.map(tag => `<span class="category-chip">#${escapeHtml(tag)}</span>`).join("")}</div><form class="asset-meta-form record-classification-form" data-record-form="${escapeHtml(font?.id || "")}" data-record-kind="font"><div class="asset-meta-fields"><label>分类<input name="style" value="${escapeHtml(style === "其他" && !font?.style ? "" : style)}" placeholder="宋体、黑体、圆体、手写体" /></label><label>标签<input name="tags" value="${escapeHtml(tags.join(", "))}" placeholder="标签，用逗号分隔" /></label></div><button class="text-button" type="submit">保存分类</button></form>`;
}
function renderThemes() {
  const list = $("#themeList");
  $("#themeCount").textContent = `${state.themes.length} 个主题`;
  $("#themeEmpty").hidden = state.themes.length > 0;
  list.innerHTML = state.themes.map(theme => {
    const preview = preferredPreview(theme.preview_light_url, theme.preview_dark_url);
    const resources = theme.resource_summary || [];
    const roles = [...new Set(resources.map(item => item.role).filter(Boolean))].slice(0, 4);
    const syncAction = theme.compressed_url || theme.library_url || theme.original_url ? `<button class="text-button sync-theme" data-id="${escapeHtml(theme.id)}" data-completed="${savedToCloud(theme)}">${savedToCloud(theme) ? "R2 已保存" : "同步到 R2"}</button>` : "";
    const compressedLink = theme.compressed_url ? `<a class="download-link" href="${escapeHtml(assetUrl(theme.compressed_url))}">下载压缩包</a>` : "";
    const libraryLink = theme.library_url ? `<a class="download-link" href="${escapeHtml(assetUrl(theme.library_url))}">下载主题</a>` : "";
    const originalLink = theme.original_url ? `<a class="download-link" href="${escapeHtml(assetUrl(theme.original_url))}">下载原始包</a>` : "";
    const compressionText = compressionSummary(theme);
    return `<article class="theme-card">
      <div class="theme-preview">${previewImage(preview.url, `${theme.name} ${preview.label} · ${previewKind(theme.preview_details)}`, "", theme.preview_details)}<span class="preview-caption">${escapeHtml(previewKind(theme.preview_details))} · 点击放大</span></div>
      <div class="theme-info"><label class="item-heading">${selectInput("theme", theme.id, `主题 ${theme.name || "未命名主题"}`, savedToCloud(theme))}<span class="theme-title">${escapeHtml(theme.name || "未命名主题")}</span></label><div class="theme-meta">${escapeHtml(theme.author || "作者未记录")}</div><p>${compressionText} · ${escapeHtml(syncLabel(theme))}</p>${theme.sync_error ? `<p class="inline-error">${escapeHtml(typeof theme.sync_error === "string" ? theme.sync_error : Object.values(theme.sync_error).join("；"))}</p>` : ""}${theme.cleanup_warning ? `<p class="inline-error">${escapeHtml(typeof theme.cleanup_warning === "string" ? theme.cleanup_warning : Object.values(theme.cleanup_warning).join("；"))}</p>` : ""}<div class="theme-badges">${roles.map(role => `<span class="badge">${escapeHtml(role)}</span>`).join("")}</div>${classificationEditor(theme, "theme")}</div>
      <div class="theme-actions"><span class="size-line">${formatBytes(theme.compressed_size || theme.library_size || theme.original_size)}</span><button class="text-button rebuild-preview" data-id="${escapeHtml(theme.id)}">更新预览</button>${syncAction}${compressedLink}${libraryLink}${originalLink}</div>
    </article>`;
  }).join("");
  $$(".sync-theme").forEach(button => button.addEventListener("click", () => syncTheme(button.dataset.id)));
  $$(".rebuild-preview").forEach(button => button.addEventListener("click", () => rebuildPreview(button.dataset.id)));
  renderCompressionResults();
  updateBulkControls();
}
function renderReview() {
  const area = $("#reviewArea");
  area.hidden = state.review.length === 0;
  $("#reviewCount").textContent = String(state.review.length);
  $("#reviewList").innerHTML = state.review.map(item => {
    const info = item.info;
    const duplicate = item.duplicates?.length > 0;
    // The local Python service has the private RED format key and can
    // authenticate/repack image replacements. Static Pages/Android cannot
    // safely re-seal the encrypted manifest, so only that mode preserves the
    // original browser-side package.
    const privateTheme = !browserPrivateCompressionEnabled() && requiresOriginalPreservation(info);
    const preview = preferredPreview(item.preview_urls?.light, item.preview_urls?.dark);
    const duplicateThumbs = duplicate ? item.duplicates.map(candidate => `<div class="thumb-label">${previewImage(candidate.preview_light_url || candidate.preview_dark_url, `已有主题 ${candidate.name} · ${previewKind(candidate.preview_details)}`, "thumb", candidate.preview_details)}<span>${escapeHtml(candidate.name)}</span></div>`).join("") : "";
    const privateNote = info.container_format === "red_private_v2"
      ? (browserPrivateCompressionEnabled()
        ? `<p class="review-meta">加密主题：图片会在当前设备压缩，再由同步 Worker 认证清单、更新资源哈希并重新封包。</p>`
        : `<p class="review-meta">加密主题：清单保持加密；本机服务会压缩包内图片并重新封包，同时保留权限、资源哈希和原始包。</p>`)
      : "";
    return `<article class="review-card" data-review-id="${escapeHtml(item.staging_id)}"><div class="review-top"><div><label class="item-heading">${selectInput("review", item.staging_id, `待确认主题 ${info.name || info.source_name}`)}<span class="review-title">${escapeHtml(info.name || info.source_name)}</span></label><div class="review-meta">${escapeHtml(info.author || "作者未记录")} · ${formatBytes(info.bytes)} · ${escapeHtml(info.source_name)}</div></div><span class="badge ${duplicate ? "" : "is-good"}">${duplicate ? `疑似重复 ${item.duplicates.length}` : "未发现同名作者"}</span></div>${privateNote}${duplicate ? `<div class="duplicate-note">已有库中存在同名作者主题。下面只展示缩略图，是否重复由你确认。</div><div class="duplicate-thumbs">${duplicateThumbs}</div>` : ""}<div class="duplicate-thumbs"><div class="thumb-label">${previewImage(preview.url, `待审核主题${preview.label} · ${previewKind(info.preview_details)}`, "thumb", info.preview_details)}<span>新主题 · ${preview.label}</span><span>${escapeHtml(previewKind(info.preview_details))} · 点击放大</span></div></div>${item.commitError ? `<p class="inline-error">${escapeHtml(item.commitError)}</p>` : ""}<div class="review-actions"><button class="primary-button commit-theme" data-id="${escapeHtml(item.staging_id)}">${privateTheme ? "确认并保存原包（电脑后台压缩）" : "确认并压缩保存"}${autoSyncEnabled() ? "并后台同步" : "（后台处理）"}</button><button class="secondary-button discard-review" data-id="${escapeHtml(item.staging_id)}">暂不处理</button></div></article>`;
  }).join("");
  $$(".commit-theme").forEach(button => button.addEventListener("click", () => commitTheme(button.dataset.id)));
  $$(".discard-review").forEach(button => button.addEventListener("click", () => discardReview(button.dataset.id)));
  updateBulkControls();
}
function renderFonts() {
  renderFontFilters();
  const visible = state.fonts.filter(fontMatchesSearch).filter(fontMatchesCategory);
  $("#fontCount").textContent = visible.length === state.fonts.length ? `${state.fonts.length} 个字体` : `${visible.length} / ${state.fonts.length} 个字体`;
  $("#fontEmpty").hidden = visible.length > 0;
  $("#fontEmpty h3").textContent = state.fonts.length && !visible.length ? "没有匹配的字体" : "还没有字体";
  $("#fontEmpty p").textContent = state.fonts.length && !visible.length ? "换一个字体名称或分类试试。" : "从单个文件或文件夹开始建立字体索引。";
  $("#fontList").innerHTML = visible.map(font => `<article class="font-card"><div><label class="item-heading">${selectInput("font", font.id, `字体 ${font.family || font.file_name}`, savedToCloud(font))}<span class="theme-title">${escapeHtml(font.family || font.file_name)}</span></label><div class="font-specimen" style="font-family: 'font-${escapeHtml(font.id)}', sans-serif">Aa 中文 123</div><div class="font-meta"><span>${escapeHtml(font.subfamily || "Regular")}</span><span>${escapeHtml((font.extension || "font").toUpperCase())}</span><span>${formatBytes(font.bytes)}</span><span>${escapeHtml(syncLabel(font))}</span></div><div class="font-hash">SHA-256 ${escapeHtml(font.sha256)}</div>${font.sync_error ? `<p class="inline-error">${escapeHtml(typeof font.sync_error === "string" ? font.sync_error : Object.values(font.sync_error).join("；"))}</p>` : ""}${font.cleanup_warning ? `<p class="inline-error">${escapeHtml(typeof font.cleanup_warning === "string" ? font.cleanup_warning : Object.values(font.cleanup_warning).join("；"))}</p>` : ""}${fontClassificationEditor(font)}</div><div class="font-actions"><button class="text-button sync-font" data-id="${escapeHtml(font.id)}" data-completed="${savedToCloud(font)}">${savedToCloud(font) ? "R2 已保存" : "同步字体到 R2"}</button>${font.url ? `<a class="download-link" href="${escapeHtml(assetUrl(font.url))}">下载原字体</a>` : ""}</div></article>`).join("");
  // A FontFace preview works without a build step and keeps the original file untouched.
  state.fonts.forEach(font => {
    const url = assetUrl(font.view_url || font.url);
    if (!url || loadedFontFaces.has(font.id)) return;
    const face = new FontFace(`font-${font.id}`, `url(${JSON.stringify(url)})`);
    face.load().then(loaded => { document.fonts.add(loaded); loadedFontFaces.add(font.id); }).catch(() => {});
  });
  $$(".sync-font").forEach(button => button.addEventListener("click", () => syncFont(button.dataset.id)));
  renderImportedFonts();
  updateBulkControls();
}
function fontMatchesSearch(font) {
  const needle = String(state.fontSearch || "").trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  return [font.family, font.file_name]
    .some(value => String(value || "").toLocaleLowerCase("zh-CN").includes(needle));
}
function fontMatchesCategory(font) {
  return state.fontFilter === "all" || fontCategory(font) === state.fontFilter;
}
function assetTypeLabel(asset) {
  return String(asset.asset_type || asset.extension || "").toLowerCase() === "svg" ? "SVG" : "HTML";
}
function assetMatchesFilter(asset) {
  const mode = state.assetFilter || "all";
  if (mode === "ungrouped" && (String(asset.author || "").trim() || String(asset.style || "").trim())) return false;
  if (mode === "author" && !String(asset.author || "").trim()) return false;
  if (mode === "style" && !String(asset.style || "").trim()) return false;
  const needle = String(state.assetSearch || "").trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  return [asset.name, asset.file_name, asset.author, asset.style, ...(asset.tags || [])].some(value => String(value || "").toLocaleLowerCase("zh-CN").includes(needle));
}
function assetPreview(asset, compact = false) {
  const url = assetUrl(asset.preview_url || asset.object_url || asset.url || "");
  if (!url) return `<div class="asset-preview-empty">暂无预览</div>`;
  const type = assetTypeLabel(asset);
  if (type === "SVG") return `<button class="preview-open asset-preview-button" type="button" aria-label="${escapeHtml(asset.name || asset.file_name || "SVG")}，点击放大" data-preview-url="${escapeHtml(url)}" data-preview-title="${escapeHtml(asset.name || asset.file_name || "SVG")}" data-preview-description="SVG 收藏预览。"><img src="${escapeHtml(url)}" alt="${escapeHtml(asset.name || asset.file_name || "SVG")}" loading="lazy" /></button>`;
  // A blank sandbox keeps user HTML isolated from the library page while still
  // allowing CSS and markup to render for a useful thumbnail.
  return `<iframe class="asset-html-preview ${compact ? "is-compact" : ""}" title="${escapeHtml(asset.name || asset.file_name || "HTML")} 预览" src="${escapeHtml(url)}" sandbox="" loading="lazy"></iframe>`;
}
function assetCard(asset, imported = false) {
  const author = String(asset.author || "").trim();
  const style = String(asset.style || "").trim();
  const tags = Array.isArray(asset.tags) ? asset.tags.filter(Boolean) : [];
  const objectUrl = assetUrl(asset.download_url || asset.object_url || asset.url || "");
  return `<article class="asset-card ${imported ? "asset-card-imported" : ""}" data-asset-id="${escapeHtml(asset.id || asset.sha256 || "")}">
    <div class="asset-card-preview">${assetPreview(asset, imported)}<span class="preview-caption">${assetTypeLabel(asset)} · ${asset.bytes ? formatBytes(asset.bytes) : ""}</span></div>
    <div class="asset-card-body"><div class="asset-card-head"><label class="item-heading">${imported ? "" : selectInput("asset", asset.id, `收藏 ${asset.name || asset.file_name}`, savedToCloud(asset))}<span class="theme-title">${escapeHtml(asset.name || asset.file_name || "未命名收藏")}</span></label><span class="badge">${assetTypeLabel(asset)}</span></div>
      <div class="asset-meta">${escapeHtml(asset.file_name || "")} · SHA ${escapeHtml(String(asset.sha256 || "").slice(0, 12))}</div>
      <div class="asset-classifications">${author ? `<span class="category-chip">作者：${escapeHtml(author)}</span>` : `<span class="category-chip is-empty">未分作者</span>`}${style ? `<span class="category-chip">风格：${escapeHtml(style)}</span>` : `<span class="category-chip is-empty">未分风格</span>`}${tags.map(tag => `<span class="category-chip">#${escapeHtml(tag)}</span>`).join("")}</div>
      <form class="asset-meta-form" data-record-form="${escapeHtml(asset.id || "")}" data-record-kind="asset"><div class="asset-meta-fields"><label>作者<input name="author" value="${escapeHtml(author)}" placeholder="作者" /></label><label>风格<input name="style" value="${escapeHtml(style)}" placeholder="风格" /></label><label>标签<input name="tags" value="${escapeHtml(tags.join(", "))}" placeholder="标签，用逗号分隔" /></label></div><button class="text-button" type="submit">保存分类</button></form>
    </div><div class="asset-actions"><button class="text-button sync-asset" data-id="${escapeHtml(asset.id || "")}" data-completed="${savedToCloud(asset)}">${savedToCloud(asset) ? "R2 已保存" : "同步到 R2"}</button>${objectUrl ? `<a class="download-link" href="${escapeHtml(objectUrl)}" download="${escapeHtml(asset.file_name || asset.name || "asset")}">下载原文件</a>` : ""}</div>
  </article>`;
}
function renderAssets() {
  const list = $("#assetList");
  const visible = state.assets.filter(assetMatchesFilter);
  $("#assetCount").textContent = `${state.assets.length} 个收藏`;
  $("#assetEmpty").hidden = visible.length > 0;
  list.innerHTML = visible.map(asset => assetCard(asset)).join("");
  $$(".asset-filters .filter-chip").forEach(button => button.classList.toggle("is-active", button.dataset.assetFilter === state.assetFilter));
  $$(".sync-asset").forEach(button => button.addEventListener("click", () => syncAsset(button.dataset.id)));
  updateBulkControls();
}
function renderImportedAssets() {
  const assets = state.importAssetIds.map(id => state.assets.find(asset => asset.id === id)).filter(Boolean);
  $("#assetImportResults").hidden = !assets.length;
  $("#assetBatchDescription").textContent = `本批 ${assets.length} 个收藏；此前收录的文件在收藏库中单独查看。`;
  $("#importedAssetList").innerHTML = assets.map(asset => assetCard(asset, true)).join("");
}
async function loadAssets(force = false) {
  let records = [];
  if (browserSyncEnabled()) records = await loadBrowserLibraryRecords(force);
  else {
    // The legacy local service predates SVG/HTML collections. Keep its other
    // pages usable instead of surfacing a noisy 404 during app startup.
    try { records = (await api("/api/assets")).items || []; }
    catch (error) { if (!/404|Not found|不存在/i.test(String(error?.message || ""))) throw error; }
  }
  const latest = new Map();
  records.filter(item => item.kind === "asset" || item.asset_type === "svg" || item.asset_type === "html").forEach(item => {
    const key = item.id || item.sha256;
    const current = latest.get(key);
    const nextTime = Date.parse(item.updated_at || item.created_at || "") || 0;
    const currentTime = Date.parse(current?.updated_at || current?.created_at || "") || 0;
    if (!current || nextTime >= currentTime) latest.set(key, item);
  });
  state.assets = [...latest.values()];
  renderAssets();
  renderImportedAssets();
}
async function saveAssetClassification(form) { return saveRecordClassification(form); }
async function saveRecordClassification(form) {
  const kind = form.dataset.recordKind;
  const id = form.dataset.recordForm;
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  const record = collection.find(item => item.id === id);
  if (!record || state.operation) return;
  const fields = new FormData(form);
  const next = {
    ...record,
    author: String(fields.get("author") || "").trim(),
    style: String(fields.get("style") || "").trim(),
    tags: String(fields.get("tags") || "").split(",").map(tag => tag.trim()).filter(Boolean),
    updated_at: new Date().toISOString(),
  };
  setOperation("record-classification");
  try {
    const result = await api(`/api/${recordKindPath(kind)}/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: next.author, style: next.style, tags: next.tags }),
    });
    Object.assign(next, result.item || result.record || result.asset || {});
    if (browserSyncEnabled()) invalidateBrowserLibraryRecords();
    const index = collection.findIndex(item => item.id === id);
    if (index >= 0) collection[index] = next;
    if (kind === "theme") renderThemes(); else if (kind === "font") renderFonts(); else renderAssets();
    toast("分类已保存");
  } catch (error) { toast(`分类保存失败：${error.message}`); }
  finally { setOperation(""); }
}
function renderImportedFonts() {
  const fonts = state.importFontIds.map(id => state.fonts.find(font => font.id === id)).filter(Boolean);
  $("#fontImportResults").hidden = !fonts.length;
  $("#fontBatchDescription").textContent = `本批 ${fonts.length} 个新字体；此前收录的字体在字体库中单独查看。`;
  $("#importedFontList").innerHTML = fonts.map(font => `<article class="font-card import-font-card"><div><div class="theme-title">${escapeHtml(font.family || font.file_name)}</div><div class="font-specimen" style="font-family: 'font-${escapeHtml(font.id)}', sans-serif">Aa 中文 123</div><div class="font-meta"><span>${escapeHtml(font.subfamily || "Regular")}</span><span>${escapeHtml((font.extension || "font").toUpperCase())}</span><span>${formatBytes(font.bytes)}</span><span>${escapeHtml(syncLabel(font))}</span></div><div class="record-classifications"><span class="category-chip">分类：${escapeHtml(font.style || inferFontCategory(font))}</span></div>${font.sync_error ? `<p class="inline-error">${escapeHtml(font.sync_error)}</p>` : ""}</div><button class="text-button" data-open-view="jobs">查看同步任务</button></article>`).join("");
}
function rememberJob(job) {
  if (!job?.id) throw new Error("后台没有返回任务编号，请刷新后检查任务列表");
  state.jobs = [job, ...state.jobs.filter(item => item.id !== job.id)];
}
function jobTitle(job) {
  if (job.action === "commit-themes") return "主题入库";
  if (job.action === "sync-all") return "全部资产同步";
  if (job.action === "archive-probe") return "123 备份验证";
  return job.kind === "font" ? "字体同步" : job.kind === "asset" ? "收藏同步" : "主题同步";
}
function jobStatus(job) {
  return { queued: "等待处理", running: "正在处理", completed: "已完成", partial: "部分失败", failed: "处理失败" }[job.status] || "等待处理";
}
function jobCard(job) {
  const total = Math.max(0, Number(job.total) || 0);
  const completed = Math.min(total, Math.max(0, Number(job.completed) || 0));
  const failed = Array.isArray(job.failed) ? job.failed : [];
  const active = ["queued", "running"].includes(job.status);
  const retrying = activeJobs().some(item => (item.parent_id || item.retry_of) === job.id);
  const detail = active && job.current ? `正在处理：${typeof job.current === "string" ? job.current : job.current.name || "当前文件"}` : `${Number(job.succeeded) || 0} 项成功 · ${Number(job.skipped) || 0} 项跳过 · ${failed.length} 项失败`;
  return `<article class="job-card" data-job-id="${escapeHtml(job.id)}"><div class="job-card-head"><div><h3>${jobTitle(job)}</h3><span class="job-meta">${escapeHtml(jobStatus(job))} · 已处理 ${completed} / ${total} 项</span></div>${failed.length && !active ? `<button class="secondary-button retry-job" data-retry-job="${escapeHtml(job.id)}" ${state.operation || retrying ? "disabled" : ""}>${retrying ? "已加入重试" : "重试失败项"}</button>` : ""}</div><progress class="job-progress" max="${Math.max(1,total)}" value="${completed}" aria-label="${jobTitle(job)}进度"></progress><p class="job-detail ${failed.length && !active ? "is-error" : ""}">${escapeHtml(detail)}</p>${failed.length ? `<details class="job-errors"><summary>${failed.length} 项失败详情</summary><ul>${failed.map(item => `<li><strong>${escapeHtml(item.name || item.id || "文件")}</strong><span>${escapeHtml(item.error || "处理失败")}</span></li>`).join("")}</ul></details>` : ""}</article>`;
}
function renderJobs() {
  const active = activeJobs();
  $("#jobNavCount").hidden = !active.length;
  $("#jobNavCount").textContent = String(active.length);
  $("#jobBanner").hidden = !active.length;
  if (active.length) {
    const current = active.find(job => job.status === "running") || active[0];
    $("#jobBannerTitle").textContent = `${active.length} 个后台任务`;
    $("#jobBannerText").textContent = `${jobTitle(current)} · ${Number(current.completed) || 0} / ${Number(current.total) || 0} 项。可以继续操作。`;
  }
  $("#jobsEmpty").hidden = state.jobs.length > 0;
  $("#jobList").innerHTML = state.jobs.map(jobCard).join("");
  const batchJobs = state.importThemeJobIds.map(id => state.jobs.find(job => job.id === id)).filter(Boolean);
  $("#themeImportResults").hidden = !batchJobs.length;
  $("#themeImportJobs").innerHTML = batchJobs.map(jobCard).join("");
  renderCompressionResults();
  renderImportedFonts();
  updateBulkControls();
}
async function loadJobs() {
  if (jobsLoading) return;
  jobsLoading = true;
  clearTimeout(jobsPollTimer);
  try {
    const data = await api("/api/jobs");
    const previous = new Map(state.jobs.map(job => [job.id, job.status]));
    const items = data.items || [];
    const revision = JSON.stringify(items.map(job => [job.id, job.status, job.completed, job.updated_at]));
    const changed = revision !== jobsRevision;
    const hadActive = activeJobs().length > 0;
    state.jobs = items;
    jobsRevision = revision;
    operationMessage($("#jobsStatus"), browserSyncEnabled() ? "免费同步模式：压缩、预览和上传在当前设备浏览器执行，没有云端后台队列。" : "任务由本地服务执行。完成记录与失败原因会保留，失败项可单独重试。");
    if (changed) {
      const finished = items.filter(job => previous.has(job.id) && ["queued", "running"].includes(previous.get(job.id)) && !["queued", "running"].includes(job.status));
      if (finished.length) toast(finished.some(job => ["partial", "failed"].includes(job.status)) ? "后台任务有失败项，可在任务页重试" : "后台任务已完成");
      renderJobs();
      if (hadActive || activeJobs().length || finished.length) await Promise.allSettled([loadThemes(), loadFonts()]);
    }
  } catch (error) { operationMessage($("#jobsStatus"), `暂时无法读取后台任务：${error.message}`, true); }
  finally {
    jobsLoading = false;
    jobsPollTimer = setTimeout(() => loadJobs().catch(() => {}), activeJobs().length ? 1800 : 8000);
  }
}
async function retryJob(id) {
  if (state.operation) return;
  setOperation("enqueue");
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
    rememberJob(result.job);
    if (state.importThemeJobIds.includes(id)) {
      state.importThemeJobIds.push(result.job.id);
      saveSessionIds("reeden-import-theme-jobs", state.importThemeJobIds);
    }
    renderJobs();
    toast("失败项已重新加入后台队列");
    loadJobs().catch(() => {});
  } catch (error) { toast(error.message); }
  finally { setOperation(""); }
}
async function loadThemes(force = false) {
  const records = browserSyncEnabled() ? await loadBrowserLibraryRecords(force) : (await api("/api/themes")).items || [];
  state.themes = records.filter(item => item.kind === "theme" || !item.kind);
  renderThemes();
}
async function loadBrowserLibraryRecords(force = false) {
  const fresh = browserLibraryRecordsCache && Date.now() - browserLibraryRecordsLoadedAt < BROWSER_RECORD_CACHE_TTL;
  if (!force && fresh) return browserLibraryRecordsCache;
  if (!force && browserLibraryRecordsPromise) return browserLibraryRecordsPromise;
  browserLibraryRecordsPromise = (async () => {
    const records = [];
    let cursor = "";
    do {
      const data = await api(`/api/library${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      records.push(...(data.items || data.records || []));
      cursor = data.cursor || "";
    } while (cursor);
    // A classification edit writes a new immutable record with the same
    // stable id. Pick the newest record before any library view consumes it.
    const latest = new Map();
    for (const record of records) {
      const key = `${record.kind || "unknown"}:${record.id || record.sha256 || JSON.stringify(record)}`;
      const current = latest.get(key);
      const nextTime = Date.parse(record.updated_at || record.created_at || "") || 0;
      const currentTime = Date.parse(current?.updated_at || current?.created_at || "") || 0;
      if (!current || nextTime >= currentTime) latest.set(key, record);
    }
    browserLibraryRecordsCache = [...latest.values()];
    browserLibraryRecordsLoadedAt = Date.now();
    return browserLibraryRecordsCache;
  })();
  try { return await browserLibraryRecordsPromise; }
  finally { browserLibraryRecordsPromise = undefined; }
}
async function loadPendingThemes() {
  if (browserSyncEnabled()) return;
  const data = await api("/api/themes/pending");
  const known = new Set(state.review.map(item => item.staging_id));
  state.review.push(...(data.items || []).filter(item => !known.has(item.staging_id)));
  renderReview();
}
async function discardReview(id) {
  if (state.operation) return;
  setOperation("dismiss-theme");
  try {
    // Browser-sync analysis keeps the source only in this tab and uses a
    // browser-* staging id. There is no server-side pending item to dismiss;
    // calling the local pending endpoint would turn its expected 404 into a
    // false "sync API unavailable" state.
    if (!String(id).startsWith("browser-")) {
      await api(`/api/themes/pending/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
    }
    state.review = state.review.filter(item => item.staging_id !== id);
    selections.review.delete(id);
    renderReview();
  } catch (error) { toast(error.message); }
  finally { setOperation(""); }
}
async function loadFonts(force = false) {
  const records = browserSyncEnabled() ? await loadBrowserLibraryRecords(force) : (await api("/api/fonts")).items || [];
  state.fonts = records.filter(item => item.kind === "font").map(font => ({ ...font, style: String(font.style || "").trim() || inferFontCategory(font) }));
  renderFonts();
}
async function loadStorage() {
  const data = await api("/api/storage");
  state.storage = data;
  if (data.mode === "browser-local") {
    storageDirty = false;
    renderStorageSummary(data);
    operationMessage($("#configStatus"), "免费浏览器同步已启用：本设备处理后直接写入共享 R2。", false);
    updateRuntimeMode();
    renderReview();
    updateBulkControls();
    return;
  }
  const form = $("#storageForm");
  const library = data.library || { provider: "local" };
  const archive = data.archive || { provider: "local" };
  const fields = { libraryProvider: library.provider, accountId: library.accountId, endpoint: library.endpoint, bucket: library.bucket, rootPath: library.rootPath, archiveProvider: archive.provider, archiveEndpoint: archive.endpoint, archiveRootPath: archive.rootPath };
  for (const [key, value] of Object.entries(fields)) form.elements[key].value = value || "";
  form.elements.autoSync.checked = Boolean(library.autoSync);
  form.elements.cloudOnly.checked = library.cloudOnly === true;
  storageDirty = false;
  renderStorageSummary(data);
  updateStorageControls();
  renderReview();
}
function renderStorageSummary(data) {
  if (data.mode === "browser-local") {
    $("#storageInventory").innerHTML = `<div class="inventory-row"><div><strong>共享 R2 库</strong><span>记录、压缩主题、字体、SVG / HTML 收藏和预览</span></div><div><strong>同一 Worker</strong><span>手机与电脑共用</span></div></div><p class="inventory-summary">免费模式：压缩、重新封包、预览和 SHA-256 查重都在当前浏览器执行；Worker 只负责 R2 对象读写和记录索引。</p>`;
    $("#storageDestination").textContent = "Cloudflare R2：通过当前同步 API 公开读取、令牌写入。原始 RED 目前按确认后的压缩/原样对象保存。";
    $("#storageHint").textContent = "浏览器本地处理 · 多设备共享 R2";
    $("#storageState").textContent = "免费浏览器同步已启用";
    $("#credentialState").textContent = syncToken ? "同步写入令牌已填写（仅保存在本机浏览器）。" : "尚未填写同步写入令牌；读取可用，上传会被 Worker 拒绝。";
    $("#pan123CredentialState").textContent = "免费模式不调用 123 云盘后台。";
    $("#storageForm").hidden = true;
    $("#pan123Label").hidden = true;
    $("#pan123Panel").hidden = true;
    return;
  }
  $("#storageForm").hidden = false;
  const library = data.library || {};
  const archive = data.archive || {};
  const status = data.status || {};
  const local = status.local || {};
  const rows = [["原始 RED", "originals", "data/originals/"], ["压缩 RED", "compressed", "data/compressed/"], ["主题预览", "previews", "data/previews/"], ["原始字体", "fonts", "data/fonts/"], ["SVG / HTML 收藏", "assets", "data/assets/"]];
  $("#storageInventory").innerHTML = rows.map(([label, key, path]) => `<div class="inventory-row"><div><strong>${label}</strong><span>${escapeHtml(local[key]?.path || path)}</span></div><div><strong>${Number(local[key]?.count || 0).toLocaleString()} 个文件</strong><span>${formatBytes(Number(local[key]?.bytes || 0))}</span></div></div>`).join("") + `<p class="inventory-summary">库清单：${Number(status.themes || 0)} 个主题、${Number(status.fonts || 0)} 个字体、${Number(status.assets || 0)} 个收藏。已读取云端：${Number(status.remoteThemes || 0)} 个主题、${Number(status.remoteFonts || 0)} 个字体、${Number(status.remoteAssets || 0)} 个收藏。</p>`;
  const r2 = library.provider === "cloudflare_r2";
  const prefix = (library.rootPath || "").replace(/^\/+|\/+$/g, "");
  const archiveLocation = archive.provider === "r2_library" ? `R2 原包目录 ${(archive.rootPath || "originals").replace(/^\/+|\/+$/g, "")}/` : archive.provider === "123pan" ? `123 云盘 ${(archive.rootPath || "Red-Garden-Backup").replace(/^\/+|\/+$/g, "")}/` : archive.provider === "123pan_webdav" ? "旧 WebDAV 服务" : "本地独立目录";
  $("#storageDestination").textContent = r2 ? `R2：${library.bucket || "尚未填写 Bucket"}/${prefix ? prefix + "/" : ""}。原始 RED：${archiveLocation}。${library.cloudOnly ? "核验成功后清理本机处理副本。" : "本机保留处理副本。"}` : `资产保存在本机，尚未启用 R2。原始 RED：${archiveLocation}。`;
  $("#storageHint").textContent = r2 ? `云端库：${library.bucket || "待配置"}` : "索引保存在本机";
  $("#storageState").textContent = r2 ? "R2 已配置 · 连接待测试" : "本地存储";
  const credentials = data.credentials || {};
  const sources = { encrypted: "已由当前 Windows 用户加密保存", environment: "使用后端环境变量", none: "尚未配置" };
  $("#credentialState").textContent = credentials.configured ? `R2 凭据：${sources[credentials.source] || "已配置"}。` : "尚未配置 R2 访问密钥。";
  const pan123 = data.pan123 || {};
  $("#pan123CredentialState").textContent = pan123.configured ? `123 云盘会话：${sources[pan123.source] || "已保存"}。是否有效请运行上传验证。` : "尚未保存 123 云盘会话。可直接登录，或使用已有会话 Token。";
}
function updateStorageControls() {
  const form = $("#storageForm");
  const locked = Boolean(state.operation) || activeJobs().length > 0;
  $("#storageBusyNote").hidden = !activeJobs().length;
  $$("input, select", form).forEach(input => { input.disabled = locked; });
  $("#storageForm button[type='submit']").disabled = locked;
  const r2 = form.elements.libraryProvider.value === "cloudflare_r2";
  const archive = form.elements.archiveProvider.value;
  const pan123 = archive === "123pan";
  $("#r2Fields").hidden = !r2;
  $("#archiveEndpointField").hidden = archive !== "123pan_webdav";
  $("#archiveHint").textContent = archive === "r2_library" ? "复用上方 Bucket 和访问密钥，原始 RED 存入库目录下的独立原包目录，默认 originals。网页可通过临时签名地址下载；同一平台的目录隔离不属于异地备份。" : pan123 ? "使用 123 云盘网页协议备份原始 RED，默认备份根目录 Red-Garden-Backup，原包存入其中的 originals/。服务地址固定，无需填写 Endpoint。保存配置后，在下方登录并验证上传。" : archive === "123pan_webdav" ? "仅兼容已有 WebDAV 服务配置，普通网盘分享链接不能填在这里。此账号是否有可用接口需自行核实；用户名和密码由后端环境变量提供。" : "原始 RED 保留在应用本机目录。可切换到 R2 或 123 云盘，由程序直接上传备份。";
  form.elements.archiveRootPath.placeholder = pan123 ? "Red-Garden-Backup" : "originals";
  const cloudArchive = archive === "r2_library" || pan123;
  form.elements.cloudOnly.disabled = locked || !r2 || !cloudArchive;
  if (!r2 || !cloudArchive) form.elements.cloudOnly.checked = false;
  for (const id of ["testStorage", "pullStorage", "syncStorage"]) $("#" + id).disabled = !r2 || storageDirty || locked;
  $("#testArchive").hidden = pan123;
  $("#testArchive").disabled = storageDirty || locked;
  $("#pan123Label").hidden = !pan123;
  $("#pan123Panel").hidden = !pan123;
  if ((!pan123 || activeJobs().length > 0) && pan123QrSession) stopPan123Qr();
  const credentialLocked = locked || Boolean(pan123QrSession);
  $$("input, button[type='submit']", $("#pan123Panel")).forEach(input => { input.disabled = credentialLocked; });
  $("#startPan123Qr").disabled = locked;
  $("#startPan123Qr").textContent = pan123QrSession ? "重新生成二维码" : "扫码连接";
  const savedPan123 = state.storage?.archive?.provider === "123pan";
  const configured = Boolean(state.storage?.pan123?.configured);
  $("#probePan123").disabled = credentialLocked || storageDirty || !savedPan123 || !configured;
  $("#probePan123").title = storageDirty || !savedPan123 ? "请先保存 123 云盘备份配置" : !configured ? "请先登录或保存会话" : "";
  const probeRoot = (state.storage?.archive?.rootPath || "Red-Garden-Backup").replace(/^\/+|\/+$/g, "");
  $("#pan123ProbeHelp").textContent = `验证会在已保存的备份目录 ${probeRoot}/probes/ 下上传一个随机小文件，再下载并核验。测试目录和文件可能保留在云盘。`;
}
async function analyzeFiles(files) {
  if (state.operation) { toast("请等待当前批次处理完成"); return; }
  const valid = [...files].filter(file => file.name.toLowerCase().endsWith(".red"));
  if (!valid.length) { toast("请选择 .red 文件"); return; }
  const body = new FormData(); valid.forEach(file => body.append("file", file, file.name));
  setOperation("analyze");
  toast("正在解析主题和查找疑似重复…");
  try {
    if (browserSyncEnabled()) {
      const codec = await browserCodec();
      const items = await mapConcurrent(valid, BROWSER_TASK_CONCURRENCY, async (file, index) => {
        operationMessage($("#reviewBatchStatus"), `正在读取主题 ${index + 1} / ${valid.length}…`);
        const raw = new Uint8Array(await file.arrayBuffer());
        let entries = [];
        let inspection;
        try {
          // readZipEntries already validates and inflates every resource. Use
          // that result for both metadata and the preview instead of doing a
          // second full ZIP read through inspectContainer().
          entries = await codec.readZipEntries(raw);
          inspection = { format: "red_v4", compressionSupported: true, entries: entries.map(entry => ({ name: entry.name, bytes: entry.bytes.length, mime: codec.mimeFromBytes(entry.bytes, entry.name) })) };
        } catch (error) {
          if (error?.code !== "private_red_unsupported") throw error;
          inspection = await codec.inspectContainer(raw);
          // The encrypted manifest cannot be decoded in the free browser
          // codec, but the private container keeps image payloads in a plain
          // sequential area. Extract those bytes for a visual-only preview.
          entries = await codec.extractPrivatePreviewImages(raw);
        }
        const identity = metadataFromEntries(entries, file.name);
        let previewUrl = "";
        let previewDetails = { kind: previewCompositionKind(entries), simulation: true, encrypted_source: inspection.format === "red_private_v2" };
        if (entries.length) {
          const preview = await composeThemePreviewBlob(entries, codec);
          if (preview) previewUrl = URL.createObjectURL(preview);
          previewDetails = { ...previewDetails, kind: previewCompositionKind(entries) };
        }
        const info = { ...identity, source_name: file.name, bytes: raw.length, container_format: inspection.format, compression_supported: inspection.compressionSupported !== false, preview_details: previewDetails };
        const duplicateRecords = browserDuplicateCandidates(identity.name, identity.author);
        return { staging_id: `browser-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`, file, bytes: raw, inspection, info, duplicates: duplicateRecords.map(record => ({ ...record })), preview_urls: { light: previewUrl, dark: "" } };
      });
      state.review.push(...items);
      renderReview();
      operationMessage($("#reviewBatchStatus"), `本批 ${items.length} 个主题已在浏览器完成识别，可全选后确认。`);
      toast(`已解析 ${items.length} 个主题，请统一确认`);
      return;
    }
    const data = await api("/api/themes/analyze", { method: "POST", body });
    state.review.push(...(data.items || []));
    renderReview();
    operationMessage($("#reviewBatchStatus"), `本批 ${data.items?.length || 0} 个主题已全部识别，可全选后确认。`);
    toast(`已解析 ${data.items?.length || 0} 个主题，请统一确认`);
  } catch (error) { toast(error.message); }
  finally { setOperation(""); }
}
async function indexExistingFiles(files) {
  if (state.operation) return;
  const valid = [...files].filter(file => file.name.toLowerCase().endsWith(".red"));
  if (!valid.length) { toast("请选择包含 .red 的已有主题文件夹"); return; }
  if (browserSyncEnabled()) {
    // The free Worker exposes only the shared record index. Local folders are
    // parsed in this browser and enter the same review/confirm flow as drops.
    await analyzeFiles(valid);
    return;
  }
  const body = new FormData(); valid.forEach(file => body.append("file", file, file.name));
  setOperation("index");
  toast("正在建立本地主题索引并生成缩略图…");
  try {
    const result = await api("/api/index/local-folder?background=1", { method: "POST", body });
    if (result.job) { rememberJob(result.job); state.importThemeJobIds.push(result.job.id); saveSessionIds("reeden-import-theme-jobs", state.importThemeJobIds); renderJobs(); }
    await loadThemes();
    toast(`已索引 ${result.added?.length || 0} 个主题，跳过 ${result.skipped?.length || 0} 个${result.job ? "，同步已交给后台" : ""}`);
  } catch (error) { toast(error.message); } finally { setOperation(""); }
}
async function commitTheme(stagingId) { return commitThemes([stagingId]); }
async function commitThemes(ids = [...selections.review]) {
  if (state.operation || storageDirty || !ids.length) return;
  const eligible = new Set(eligibleIds("review"));
  const chosen = [...new Set(ids)].filter(id => eligible.has(id));
  if (!chosen.length) return;
  setOperation("enqueue");
  try {
    const options = compressionOptions();
    try { sessionStorage.setItem("reeden-compression-options", JSON.stringify(options)); } catch {}
    if (browserSyncEnabled()) {
      const codec = await browserCodec();
      const selected = state.review.filter(item => chosen.includes(item.staging_id));
      beginTransferProgress("主题压缩与上传", selected.length);
      let finished = 0;
      const results = await mapConcurrent(selected, 2, async item => {
        const name = item.info?.source_name || item.info?.name || "主题";
        try {
          transferStage("读取主题", name);
          const raw = item.bytes || new Uint8Array(await item.file.arrayBuffer());
          const encrypted = item.info?.compression_supported === false || item.inspection?.format === "red_private_v2";
          transferStage(encrypted ? "压缩图片并重新封包" : "压缩图片", name);
          const result = encrypted
            ? await compressPrivateRedViaWorker(raw, codec, { quality: options.quality, maxEdge: options.max_edge })
            : await codec.compressRed(raw, { quality: options.quality, maxEdge: options.max_edge });
          const compressedBytes = result.bytes;
          const originalSha = await codec.sha256Hex(raw);
          transferStage("上传原始主题", name);
          const originalPath = await uploadBrowserObject("originals", originalSha, "red", raw, "application/octet-stream");
          const assetSha = await codec.sha256Hex(compressedBytes);
          transferStage("上传压缩主题", name);
          const compressedPath = await uploadBrowserObject("compressed", assetSha, "red", compressedBytes, "application/octet-stream");
          let previewPath = "";
          let previewEntries = [];
          try { previewEntries = encrypted ? await codec.extractPrivatePreviewImages(compressedBytes) : await codec.readZipEntries(compressedBytes); } catch { previewEntries = []; }
          let previewDetails = item.info.preview_details || { kind: previewCompositionKind(previewEntries), simulation: true };
          transferStage("生成主题预览", name);
          const preview = await composeThemePreviewBlob(previewEntries, codec);
          if (preview) {
            const previewBytes = new Uint8Array(await preview.arrayBuffer());
            const previewSha = await codec.sha256Hex(previewBytes);
            transferStage("上传预览和清单", name);
            previewPath = await uploadBrowserObject("previews", previewSha, "jpg", previewBytes, "image/jpeg");
            previewDetails = { ...previewDetails, kind: previewCompositionKind(previewEntries), simulation: true, encrypted_source: encrypted };
          }
          if (!preview) transferStage("上传主题清单", name);
          const record = await uploadBrowserRecord({
            kind: "theme", id: `theme-${assetSha.slice(0, 16)}`, name: item.info.name || item.info.source_name, author: item.info.author || "作者未记录",
            sha256: assetSha, original_sha256: originalSha, original_size: raw.length, compressed_size: compressedBytes.length,
            compression_supported: true, status: "browser_compressed", source_name: item.info.source_name,
            compressed_url: compressedPath, library_url: compressedPath, preview_light_url: previewPath, preview_dark_url: "", preview_details: previewDetails,
            saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: "", original_url: originalPath
          }, codec);
          transferDone(name);
          operationMessage($("#reviewBatchStatus"), `已完成主题 ${++finished} / ${selected.length}…`);
          return { item, record };
        } catch (error) {
          item.commitError = error.message || "浏览器处理失败";
          transferDone(name, true);
          operationMessage($("#reviewBatchStatus"), `已完成主题 ${++finished} / ${selected.length}…`);
          return { item, error };
        }
      });
      const completed = results.filter(result => result.record).map(result => result.record);
      const failures = results.filter(result => result.error);
      finishTransferProgress("主题处理完成", failures.length);
      state.themes = [...completed, ...state.themes];
      // Match completed records back to staging items by insertion order/name;
      // failed items remain visible for retry.
      for (const item of selected) if (!failures.some(entry => entry.item === item)) { state.review = state.review.filter(review => review !== item); selections.review.delete(item.staging_id); }
      renderReview(); renderThemes(); renderJobs();
      const message = failures.length ? `${completed.length} 个主题已保存到 R2，${failures.length} 个失败，请查看错误后重试。` : `${completed.length} 个主题已压缩并保存到 R2。`;
      operationMessage($("#reviewBatchStatus"), message, Boolean(failures.length)); toast(message);
      return;
    }
    const result = await api("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "commit-themes", ids: chosen, ...options }) });
    rememberJob(result.job);
    state.importThemeJobIds = [...new Set([...state.importThemeJobIds, result.job.id])];
    saveSessionIds("reeden-import-theme-jobs", state.importThemeJobIds);
    state.review = state.review.filter(item => !chosen.includes(item.staging_id));
    chosen.forEach(id => selections.review.delete(id));
    renderReview();
    renderJobs();
    toast(`${chosen.length} 个主题已加入后台：压缩图片、重新封包并保存`);
    loadJobs().catch(() => {});
  } catch (error) { operationMessage($("#reviewBatchStatus"), `加入后台失败：${error.message}`, true); toast(error.message); }
  finally { setOperation(""); }
}
async function syncTheme(themeId) { return syncSelectedAssets("theme", [themeId]); }
async function syncFont(fontId) { return syncSelectedAssets("font", [fontId]); }
async function syncAsset(assetId) { return syncSelectedAssets("asset", [assetId]); }
async function syncSelectedAssets(kind, ids = [...selections[kind]]) {
  if (state.operation || !r2Enabled() || storageDirty || !ids.length) return;
  if (browserSyncEnabled()) {
    const output = $(kind === "theme" ? "#themeBatchStatus" : kind === "font" ? "#fontBatchStatus" : "#assetBatchStatus");
    operationMessage(output, "免费浏览器模式会在导入/确认时直接上传到 R2；已有记录无需再次排队。", false);
    ids.forEach(id => selections[kind].delete(id));
    updateBulkControls();
    return;
  }
  const eligible = new Set(eligibleIds(kind));
  const chosen = [...new Set(ids)].filter(id => eligible.has(id));
  if (!chosen.length) return;
  const output = $(kind === "theme" ? "#themeBatchStatus" : kind === "font" ? "#fontBatchStatus" : "#assetBatchStatus");
  setOperation("enqueue");
  try {
    const result = await api("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync", kind, ids: chosen }) });
    rememberJob(result.job);
    chosen.forEach(id => selections[kind].delete(id));
    operationMessage(output, `${chosen.length} 项已加入后台同步，可切换页面或关闭网页。进度在“后台任务”中查看。`);
    renderThemes(); renderFonts(); renderAssets(); renderJobs();
    toast("已加入后台同步队列");
    loadJobs().catch(() => {});
  } catch (error) { operationMessage(output, error.message, true); toast(error.message); }
  finally { setOperation(""); }
}
async function rebuildPreview(themeId) {
  if (state.operation) return;
  if (browserSyncEnabled()) {
    toast("免费浏览器模式在导入时生成预览，暂不提供云端重建接口");
    return;
  }
  setOperation("preview");
  const button = $(`.rebuild-preview[data-id="${CSS.escape(themeId)}"]`);
  if (button) button.disabled = true;
  toast("正在用主题素材重新组合书架预览…");
  try {
    await api(`/api/themes/${encodeURIComponent(themeId)}/preview/rebuild`, { method: "POST" });
    await loadThemes();
    toast("预览已更新，同步存储可上传");
  } catch (error) { toast(error.message); }
  finally { setOperation(""); }
}
async function importFonts(files) {
  if (state.operation) { toast("请等待当前批次处理完成"); return; }
  const valid = [...files].filter(file => /\.(ttf|otf|woff2?)$/i.test(file.name));
  if (!valid.length) { toast("请选择 TTF、OTF、WOFF 或 WOFF2 文件"); return; }
  state.importFontIds = [];
  saveSessionIds("reeden-import-fonts", []);
  renderImportedFonts();
  setOperation("font-import");
  const output = $("#fontImportStatus");
  output.hidden = false;
  let duplicates = 0;
  try {
    const hashes = new Set(state.fonts.map(font => font.sha256).filter(Boolean));
    const unique = [];
    const hashed = crypto.subtle ? await mapConcurrent(valid, 4, async file => {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return { file, hash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") }; // taste-skill-ignore: SHA-256 bytes require two hexadecimal digits.
    }) : valid.map(file => ({ file, hash: "" }));
    for (const {file, hash} of hashed) {
      if (hash && hashes.has(hash)) { duplicates++; continue; }
      if (hash) hashes.add(hash);
      unique.push(file);
    }
    if (!unique.length) { operationMessage(output, `全部 ${duplicates} 个字体已存在，未重复上传。`); toast("所选字体均已存在"); return; }
    if (browserSyncEnabled()) {
      const codec = await browserCodec();
      beginTransferProgress("字体上传", unique.length);
      let finished = 0;
      const uploaded = await mapConcurrent(unique, 2, async file => {
        try {
          transferStage("识别字体并查重", file.name);
          const info = await codec.inspectFont(file);
          const bytes = new Uint8Array(await file.arrayBuffer());
          transferStage("上传字体文件", file.name);
          const fontPath = await uploadBrowserObject("fonts", info.sha256, info.extension, bytes, `font/${info.extension}`);
          transferStage("写入字体清单", file.name);
          const record = await uploadBrowserRecord({
            kind: "font", id: `font-${info.sha256.slice(0, 16)}`, sha256: info.sha256, file_name: file.name,
            family: file.name.replace(/\.[^.]+$/, ""), subfamily: "Regular", extension: info.extension, bytes: info.bytes, style: inferFontCategory({ family: file.name }), tags: [],
            url: fontPath, view_url: fontPath, preview_url: "", saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: ""
          }, codec);
          transferDone(file.name);
          operationMessage(output, `已上传字体 ${++finished} / ${unique.length}…`);
          return record;
        } catch (error) {
          transferDone(file.name, true);
          operationMessage(output, `已完成字体 ${++finished} / ${unique.length}（有一项失败）…`);
          return { error, file };
        }
      });
      const added = uploaded.filter(item => !item?.error);
      const failures = uploaded.filter(item => item?.error);
      finishTransferProgress("字体上传完成", failures.length);
      if (!added.length && failures.length) throw failures[0].error;
      state.fonts = [...added, ...state.fonts];
      state.importFontIds = added.map(font => font.id);
      saveSessionIds("reeden-import-fonts", state.importFontIds);
      renderFonts();
      const message = `已上传 ${added.length} 个字体，重复跳过 ${duplicates} 个${failures.length ? `，失败 ${failures.length} 个` : ""}。`;
      operationMessage(output, message, Boolean(failures.length)); toast(message);
      return;
    }
    operationMessage(output, `查重完成，正在接收 ${unique.length} 个新字体，完成后交给后台…`);
    const body = new FormData(); unique.forEach(file => body.append("file", file, file.name));
    const result = await api("/api/fonts/import?background=1", { method: "POST", body });
    state.importFontIds = (result.added || []).map(font => font.id);
    saveSessionIds("reeden-import-fonts", state.importFontIds);
    if (result.job) rememberJob(result.job);
    await loadFonts();
    renderJobs();
    const warning = resultWarning(result);
    const message = `已加入 ${result.added?.length || 0} 个新字体，重复跳过 ${duplicates + (result.skipped?.length || 0)} 个。${result.job ? "同步已交给后台，可以离开此页。" : ""}${warning ? ` ${warning}` : ""}`;
    operationMessage(output, message, Boolean(warning));
    toast(message);
  } catch (error) { operationMessage(output, `字体导入失败：${error.message}`, true); toast(error.message); }
  finally { setOperation(""); }
}
function assetExtension(file) {
  const match = String(file?.name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] === "htm" ? "html" : match?.[1] || "";
}
async function importAssets(files) {
  if (state.operation) { toast("请等待当前批次处理完成"); return; }
  const valid = [...files].filter(file => ["svg", "html", "htm"].includes(assetExtension(file)));
  if (!valid.length) { toast("请选择 SVG、HTML 或 HTM 文件"); return; }
  state.importAssetIds = [];
  saveSessionIds("reeden-import-assets", []);
  renderImportedAssets();
  setOperation("asset-import");
  const output = $("#assetImportStatus");
  output.hidden = false;
  let duplicates = 0;
  try {
    const hashes = new Set(state.assets.map(asset => asset.sha256).filter(Boolean));
    const unique = [];
    const hashed = await mapConcurrent(valid, 4, async file => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!crypto.subtle) throw new Error("当前环境不支持 SHA-256，无法安全去重");
      const hash = await crypto.subtle.digest("SHA-256", bytes).then(value => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
      return { file, bytes, hash };
    });
    for (const item of hashed) {
      if (item.hash && hashes.has(item.hash)) { duplicates++; continue; }
      if (item.hash) hashes.add(item.hash);
      unique.push(item);
    }
    if (!unique.length) { operationMessage(output, `全部 ${duplicates} 个收藏已存在，未重复上传。`); toast("所选收藏均已存在"); return; }
    if (browserSyncEnabled()) {
      const codec = await browserCodec();
      beginTransferProgress("收藏上传", unique.length);
      let finished = 0;
      const uploaded = await mapConcurrent(unique, 2, async ({file, bytes, hash}) => {
        try {
          const extension = assetExtension(file);
          const mime = extension === "svg" ? "image/svg+xml" : "text/html; charset=utf-8";
          transferStage("上传收藏文件", file.name);
          const objectPath = await uploadBrowserObject("assets", hash, extension, bytes, mime);
          let previewPath = "";
          if (extension === "svg") {
            try {
              transferStage("生成 SVG 预览", file.name);
              const previewBlob = await imagePreviewBlob(bytes, "image/svg+xml");
              const previewBytes = await jpegBytesFromBlob(previewBlob);
              if (previewBytes) {
                const previewSha = await codec.sha256Hex(previewBytes);
                transferStage("上传收藏预览", file.name);
                previewPath = await uploadBrowserObject("previews", previewSha, "jpg", previewBytes, "image/jpeg");
              }
            } catch { /* The SVG remains downloadable if thumbnail creation fails. */ }
          }
          transferStage("写入收藏清单", file.name);
          const record = await uploadBrowserRecord({
            kind: "asset", id: `asset-${hash.slice(0, 16)}`, asset_type: extension === "svg" ? "svg" : "html", extension,
            file_name: file.name, name: file.name.replace(/\.[^.]+$/, ""), author: "", style: "", tags: [], sha256: hash, bytes: bytes.length,
            mime, object_url: objectPath, url: objectPath, preview_url: previewPath, saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: ""
          }, codec);
          transferDone(file.name);
          operationMessage(output, `已上传收藏 ${++finished} / ${unique.length}…`);
          return record;
        } catch (error) { transferDone(file.name, true); operationMessage(output, `已完成收藏 ${++finished} / ${unique.length}（有一项失败）…`); return { error, file }; }
      });
      const added = uploaded.filter(item => !item?.error);
      const failures = uploaded.filter(item => item?.error);
      finishTransferProgress("收藏上传完成", failures.length);
      if (!added.length && failures.length) throw failures[0].error;
      state.assets = [...added, ...state.assets];
      state.importAssetIds = added.map(asset => asset.id);
      saveSessionIds("reeden-import-assets", state.importAssetIds);
      renderAssets(); renderImportedAssets();
      const message = `已上传 ${added.length} 个收藏，重复跳过 ${duplicates} 个${failures.length ? `，失败 ${failures.length} 个` : ""}。`;
      operationMessage(output, message, Boolean(failures.length)); toast(message);
      return;
    }
    operationMessage(output, `查重完成，正在接收 ${unique.length} 个新收藏…`);
    const body = new FormData();
    unique.forEach(({file}) => body.append("file", file, file.name));
    const result = await api("/api/assets/import?background=1", { method: "POST", body });
    state.importAssetIds = (result.added || []).map(asset => asset.id);
    saveSessionIds("reeden-import-assets", state.importAssetIds);
    if (result.job) rememberJob(result.job);
    await loadAssets();
    renderJobs();
    const warning = resultWarning(result);
    const message = `已加入 ${result.added?.length || 0} 个收藏，重复跳过 ${duplicates + (result.skipped?.length || 0)} 个。${result.job ? "同步已交给后台，可以离开此页。" : ""}${warning ? ` ${warning}` : ""}`;
    operationMessage(output, message, Boolean(warning));
    toast(message);
  } catch (error) { operationMessage(output, `收藏导入失败：${error.message}`, true); toast(error.message); }
  finally { setOperation(""); }
}
async function saveStorage(event) {
  event.preventDefault();
  if (state.operation || activeJobs().length) return;
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  const fields = Object.fromEntries(new FormData(form));
  const payload = {
    library: { provider: fields.libraryProvider, accountId: fields.accountId.trim(), endpoint: fields.endpoint.trim(), bucket: fields.bucket.trim(), rootPath: fields.rootPath.trim(), autoSync: form.elements.autoSync.checked, cloudOnly: form.elements.cloudOnly.checked && !form.elements.cloudOnly.disabled },
    archive: { provider: fields.archiveProvider, endpoint: fields.archiveProvider === "123pan_webdav" ? fields.archiveEndpoint.trim() : "", rootPath: fields.archiveRootPath.trim() },
  };
  if (fields.accessKeyId || fields.secretAccessKey) payload.credentials = { accessKeyId: fields.accessKeyId.trim(), secretAccessKey: fields.secretAccessKey.trim() };
  setOperation("save-storage");
  try {
    await api("/api/storage/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    form.elements.accessKeyId.value = "";
    form.elements.secretAccessKey.value = "";
    await loadStorage();
    operationMessage($("#configStatus"), "配置已保存。请测试连接，再读取已有库或同步资产。");
    toast("存储配置已保存");
  } catch (error) { operationMessage($("#configStatus"), error.message, true); } finally { setOperation(""); }
}
async function refreshPan123Session(source) {
  state.storage = { ...state.storage, pan123: { configured: true, source: source || "encrypted" } };
  try { state.storage = await api("/api/storage"); } catch {}
  renderStorageSummary(state.storage);
}
function stopPan123Qr(message = "") {
  pan123QrGeneration += 1;
  clearTimeout(pan123QrTimer);
  clearTimeout(pan123QrExpiryTimer);
  pan123QrController?.abort();
  pan123QrController = undefined;
  pan123QrSession = undefined;
  $("#pan123QrImage").removeAttribute("src");
  $("#pan123QrCode").hidden = true;
  operationMessage($("#pan123QrStatus"), message);
}
async function startPan123Qr() {
  if (state.operation || activeJobs().length || document.hidden) return;
  stopPan123Qr();
  const generation = pan123QrGeneration;
  pan123QrController = new AbortController();
  const requestController = pan123QrController;
  const requestTimeout = setTimeout(() => requestController.abort(), 15000);
  setOperation("pan123-qr-start");
  operationMessage($("#pan123QrStatus"), "正在生成登录二维码…");
  try {
    const response = await fetch(apiUrl("/api/storage/123/qr/start"), { method: "POST", headers: requestHeaders({ "Content-Type": "application/json" }), body: "{}", signal: pan123QrController.signal });
    const result = await response.json().catch(() => ({}));
    if (generation !== pan123QrGeneration || state.activeView !== "storage" || document.hidden) return;
    if (!response.ok || result.ok === false || !result.id || !/^data:image\/png;base64,[a-zA-Z0-9+/=\r\n]+$/.test(result.image || "")) throw new Error("二维码暂时无法生成，请稍后再试。");
    pan123QrSession = { id: result.id, expiresAt: Date.now() + Math.min(120, Math.max(1, Number(result.expiresIn) || 120)) * 1000 };
    $("#pan123QrImage").src = result.image;
    $("#pan123QrCode").hidden = false;
    operationMessage($("#pan123QrStatus"), "用123云盘App或微信扫码并确认。等待扫码…");
    pan123QrExpiryTimer = setTimeout(() => { stopPan123Qr("二维码已过期，请重新扫码连接。"); updateStorageControls(); }, pan123QrSession.expiresAt - Date.now());
    pan123QrTimer = setTimeout(() => pollPan123Qr(generation), 2000);
  } catch {
    if (generation === pan123QrGeneration) { stopPan123Qr(); operationMessage($("#pan123QrStatus"), "二维码暂时无法生成，请确认本机服务运行后再试。", true); }
  } finally { clearTimeout(requestTimeout); setOperation(""); }
}
async function pollPan123Qr(generation) {
  if (generation !== pan123QrGeneration || !pan123QrSession) return;
  if (state.activeView !== "storage" || document.hidden || activeJobs().length || Date.now() >= pan123QrSession.expiresAt) {
    stopPan123Qr("扫码已结束，请重新扫码连接。"); updateStorageControls(); return;
  }
  try {
    const response = await fetch(apiUrl("/api/storage/123/qr/poll"), { method: "POST", headers: requestHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ id: pan123QrSession.id }), signal: pan123QrController.signal });
    const result = await response.json().catch(() => ({}));
    if (generation !== pan123QrGeneration || !pan123QrSession) return;
    if (!response.ok || result.ok === false) throw new Error();
    if (result.status === "authenticated") {
      stopPan123Qr("扫码登录成功，会话已加密保存。");
      await refreshPan123Session(result.source);
      operationMessage($("#pan123Status"), "123 云盘已连接。保存备份配置后，可运行上传验证。");
      updateStorageControls();
      return;
    }
    if (result.status === "expired") { stopPan123Qr("二维码已过期，请重新扫码连接。"); updateStorageControls(); return; }
    if (!["waiting", "scanned"].includes(result.status)) throw new Error();
    operationMessage($("#pan123QrStatus"), result.status === "scanned" ? "已扫码，请在手机上确认登录。" : "用123云盘App或微信扫码并确认。等待扫码…");
    pan123QrTimer = setTimeout(() => pollPan123Qr(generation), 2000);
  } catch {
    if (generation === pan123QrGeneration) {
      stopPan123Qr();
      operationMessage($("#pan123QrStatus"), "暂时无法确认扫码状态，请重新扫码连接。", true);
      updateStorageControls();
    }
  }
}
async function savePan123Credentials(event, kind) {
  event.preventDefault();
  if (state.operation || activeJobs().length || pan123QrSession) return;
  const form = event.currentTarget;
  const payload = kind === "login" ? { username: form.elements.username.value.trim(), password: form.elements.password.value } : { token: form.elements.token.value.trim() };
  form.reset();
  const output = $("#pan123Status");
  setOperation("pan123-credentials");
  operationMessage(output, kind === "login" ? "正在登录 123 云盘…" : "正在加密保存 123 云盘会话…");
  try {
    const response = await fetch(apiUrl(`/api/storage/123/${kind === "login" ? "login" : "session"}`), { method: "POST", headers: requestHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false || result.configured === false || (kind === "login" && result.authenticated !== true)) {
      throw new Error(kind === "login" ? `登录未完成（${response.status}）。请检查账号信息；如需验证码，请在自己的浏览器登录，再使用下方的已有会话。` : `会话保存未完成（${response.status}）。请重新检查 Token 后提交。`);
    }
    await refreshPan123Session(result.source);
    operationMessage(output, kind === "login" ? "登录成功，会话已加密保存，账号与密码输入已清空。保存备份配置后，可运行上传验证。" : "会话已加密保存，Token 输入已清空。保存备份配置后，请运行上传验证确认会话有效。");
    if (kind === "session") $("#pan123SessionDetails").open = false;
  } catch (error) {
    const message = error instanceof TypeError ? "暂时无法连接本机服务。输入已清空，请确认服务运行后再提交。" : error.message;
    operationMessage(output, message, true);
  } finally {
    for (const key of Object.keys(payload)) payload[key] = "";
    setOperation("");
  }
}
async function probePan123() {
  if (state.operation || activeJobs().length || storageDirty || state.storage?.archive?.provider !== "123pan" || !state.storage?.pan123?.configured) return;
  const output = $("#pan123Status");
  setOperation("pan123-probe");
  operationMessage(output, "正在将 123 云盘上传验证加入后台队列…");
  try {
    const result = await api("/api/storage/123/probe", { method: "POST" });
    if (result.ok === false) throw new Error(result.error || "123 云盘上传验证未能加入队列");
    rememberJob(result.job);
    renderJobs();
    operationMessage(output, "上传验证已加入后台队列。将在备份目录的 probes/ 上传随机小文件并回读核验，结果见后台任务。关闭网页后仍会执行，请保持电脑与本机服务运行。");
    loadJobs().catch(() => {});
  } catch (error) { operationMessage(output, error.message, true); }
  finally { setOperation(""); }
}
async function testStorage(target, button) {
  if (state.operation || activeJobs().length || storageDirty) return;
  setOperation("test-storage");
  button.disabled = true;
  const label = target === "library" ? "R2" : "原始包归档";
  operationMessage($("#configStatus"), `正在测试${label}连接…`);
  try {
    const result = await api("/api/storage/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target }) });
    if (result.ok === false) throw new Error(result.error || `${label}连接未通过`);
    operationMessage($("#configStatus"), `${label}连接测试通过${result.bucket ? ` · ${result.bucket}` : ""}。`);
    if (target === "library") $("#storageState").textContent = "R2 连接测试通过";
  } catch (error) {
    operationMessage($("#configStatus"), `${label}连接失败：${error.message}`, true);
    if (target === "library") $("#storageState").textContent = "R2 连接失败";
  } finally { setOperation(""); }
}
async function cloudOperation(action, button) {
  if (state.operation) return;
  setOperation("cloud-operation");
  const output = $("#storageOperation");
  const buttons = [$("#pullStorage"), $("#syncStorage")];
  buttons.forEach(item => item.disabled = true);
  operationMessage(output, action === "pull" ? "正在读取 R2 已有库清单…" : "正在加入后台同步队列…");
  try {
    const result = action === "pull" ? await api("/api/storage/pull", { method: "POST" }) : await api("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync-all" }) });
    if (action !== "pull") { rememberJob(result.job); renderJobs(); operationMessage(output, "已加入后台同步。可以切换页面或关闭网页，在后台任务中查看进度。"); return; }
    await Promise.all([loadThemes(), loadFonts(), loadStorage()]);
    if (action === "pull") {
      const count = result.themes ?? result.theme_count ?? result.addedThemes ?? result.added?.themes ?? 0;
      const fonts = result.fonts ?? result.font_count ?? result.addedFonts ?? result.added?.fonts ?? 0;
      const unindexed = result.unindexed || [];
      const errors = result.errors || result.failed || [];
      operationMessage(output, `已读取 R2 库：${typeof count === "number" ? count : count.length || 0} 个主题、${typeof fonts === "number" ? fonts : fonts.length || 0} 个字体。${unindexed.length ? `另有 ${unindexed.length} 个文件没有库清单。` : ""}${errors.length ? ` ${errors.length} 项读取失败。` : ""}`, errors.length > 0);
      const container = $("#storageUnindexed");
      container.hidden = unindexed.length === 0;
      container.innerHTML = unindexed.length ? `<h3>没有库清单的已有文件</h3><p class="field-help">这些文件保留在 R2，目前尚未加入名称、作者与预览索引。解析会读取下列文件，在本地提取元数据和预览。</p><ul class="unindexed-list">${unindexed.map(item => `<li><span>${escapeHtml(item.key || item.object_key)}</span><span>${formatBytes(item.bytes ?? item.size)}</span></li>`).join("")}</ul><button class="secondary-button" id="indexExistingCloud" type="button">解析这些已有文件</button>` : "";
      if (unindexed.length) $("#indexExistingCloud").addEventListener("click", event => indexExistingCloud(unindexed.map(item => item.key || item.object_key), event.currentTarget));
    }
  } catch (error) { operationMessage(output, error.message, true); } finally { setOperation(""); }
}
async function indexExistingCloud(keys, button) {
  button.disabled = true;
  operationMessage($("#storageOperation"), `正在读取并解析 ${keys.length} 个 R2 已有文件，文件较大时请稍候…`);
  try {
    const result = await api("/api/storage/index-existing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }) });
    await Promise.all([loadThemes(), loadFonts(), loadStorage()]);
    const count = value => typeof value === "number" ? value : value?.length || 0;
    const errors = result.errors || [];
    operationMessage($("#storageOperation"), `解析完成：新增 ${count(result.added)} 项，跳过 ${count(result.skipped)} 项，${errors.length} 项失败。${errors.length ? " " + errors.map(item => `${item.key || "文件"}：${item.error || item.message || "解析失败"}`).join("；") : ""}`, errors.length > 0);
    if (!errors.length) $("#storageUnindexed").hidden = true;
  } catch (error) { operationMessage($("#storageOperation"), error.message, true); } finally { button.disabled = false; }
}
function setupDropZone(element, onFiles) {
  ["dragenter", "dragover"].forEach(event => element.addEventListener(event, e => { e.preventDefault(); element.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach(event => element.addEventListener(event, e => { e.preventDefault(); element.classList.remove("is-dragging"); }));
  element.addEventListener("drop", e => onFiles(e.dataTransfer.files));
  element.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); element.click(); } });
}
async function importUnifiedFiles(fileList) {
  if (state.operation) { toast("请等待当前批次处理完成"); return; }
  const groups = { theme: [], font: [], asset: [] }, unsupported = [];
  for (const file of [...(fileList || [])]) {
    const extension = String(file.name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
    if (extension === "red") groups.theme.push(file);
    else if (["ttf", "otf", "woff", "woff2"].includes(extension)) groups.font.push(file);
    else if (["svg", "html", "htm"].includes(extension)) groups.asset.push(file);
    else unsupported.push(file.name || "未命名文件");
  }
  const total = groups.theme.length + groups.font.length + groups.asset.length;
  const status = $("#unifiedImportStatus");
  status.hidden = false;
  if (!total) {
    operationMessage(status, `没有识别到支持的后缀：${unsupported.join("、") || "请拖入文件"}`, true);
    return;
  }
  operationMessage(status, `已识别 ${groups.theme.length} 个主题、${groups.font.length} 个字体、${groups.asset.length} 个收藏，正在依次处理…`);
  if (groups.theme.length) await analyzeFiles(groups.theme);
  if (groups.font.length) await importFonts(groups.font);
  if (groups.asset.length) await importAssets(groups.asset);
  operationMessage(status, `本批已分流：${groups.theme.length} 个主题、${groups.font.length} 个字体、${groups.asset.length} 个收藏。${unsupported.length ? `已跳过不支持的文件：${unsupported.join("、")}` : ""}`, Boolean(unsupported.length));
}
$("#chooseThemes").addEventListener("click", () => $("#themeInput").click());
$("#chooseThemeFolder").addEventListener("click", () => $("#themeFolderInput").click());
$("#indexThemeFolder").addEventListener("click", () => $("#existingThemeFolderInput").click());
$("#addThemeButton").addEventListener("click", () => { setView("import"); });
$("#themeInput").addEventListener("change", async e => { await analyzeFiles(e.target.files); e.target.value = ""; });
$("#themeFolderInput").addEventListener("change", async e => { await analyzeFiles(e.target.files); e.target.value = ""; });
$("#existingThemeFolderInput").addEventListener("change", async e => { await indexExistingFiles(e.target.files); e.target.value = ""; });
setupDropZone($("#themeDropZone"), analyzeFiles);
$("#themeDropZone").addEventListener("click", () => { if (!state.operation) $("#themeInput").click(); });
$("#chooseFonts").addEventListener("click", () => $("#fontInput").click());
$("#chooseFontFolder").addEventListener("click", () => $("#fontFolderInput").click());
$("#fontInput").addEventListener("change", async e => { await importFonts(e.target.files); e.target.value = ""; });
$("#fontFolderInput").addEventListener("change", async e => { await importFonts(e.target.files); e.target.value = ""; });
setupDropZone($("#fontDropZone"), importFonts);
$("#fontDropZone").addEventListener("click", () => { if (!state.operation) $("#fontInput").click(); });
$("#chooseAssets").addEventListener("click", () => $("#assetInput").click());
$("#chooseAssetFolder").addEventListener("click", () => $("#assetFolderInput").click());
$("#assetInput").addEventListener("change", async e => { await importAssets(e.target.files); e.target.value = ""; });
$("#assetFolderInput").addEventListener("change", async e => { await importAssets(e.target.files); e.target.value = ""; });
setupDropZone($("#assetDropZone"), importAssets);
$("#assetDropZone").addEventListener("click", () => { if (!state.operation) $("#assetInput").click(); });
setupDropZone($("#unifiedDropZone"), importUnifiedFiles);
$("#unifiedDropZone").addEventListener("click", () => { if (!state.operation) $("#unifiedInput").click(); });
$("#unifiedInput").addEventListener("change", async event => { await importUnifiedFiles(event.target.files); event.target.value = ""; });
$("#chooseUnifiedFiles").addEventListener("click", () => { if (!state.operation) $("#unifiedInput").click(); });
$("#chooseUnifiedFolder").addEventListener("click", () => { if (!state.operation) $("#unifiedFolderInput").click(); });
$("#unifiedFolderInput").addEventListener("change", async event => { await importUnifiedFiles(event.target.files); event.target.value = ""; });
$("#refreshThemes").addEventListener("click", () => loadThemes(true));
$("#refreshFonts").addEventListener("click", () => loadFonts(true));
$("#fontSearchInput").addEventListener("input", event => { state.fontSearch = event.target.value; renderFonts(); });
$("#refreshAssets").addEventListener("click", () => loadAssets(true));
$("#selectAllReview").addEventListener("change", event => toggleAll("review", event.target.checked));
$("#selectAllThemes").addEventListener("change", event => toggleAll("theme", event.target.checked));
$("#selectAllFonts").addEventListener("change", event => toggleAll("font", event.target.checked));
$("#selectAllAssets").addEventListener("change", event => toggleAll("asset", event.target.checked));
$("#commitSelectedThemes").addEventListener("click", () => commitThemes());
$("#syncSelectedThemes").addEventListener("click", () => syncSelectedAssets("theme"));
$("#syncSelectedFonts").addEventListener("click", () => syncSelectedAssets("font"));
$("#syncSelectedAssets").addEventListener("click", () => syncSelectedAssets("asset"));
document.addEventListener("change", event => {
  const input = event.target.closest("[data-selection]");
  if (!input || state.operation) return;
  const selected = selections[input.dataset.selection];
  if (input.checked) selected.add(input.dataset.id); else selected.delete(input.dataset.id);
  updateBulkControls();
});
$("#scanButton").addEventListener("click", () => $("#indexInput").click());
$("#indexInput").addEventListener("change", async event => { const file = event.target.files?.[0]; if (!file) return; try { if (browserSyncEnabled()) throw new Error("免费同步模式通过 R2 records 自动读取清单，无需导入本地索引文件"); const value = JSON.parse(await file.text()); const result = await api("/api/index/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }); await loadThemes(); toast(`已导入 ${result.count} 条已有清单`); } catch (error) { toast(`清单导入失败：${error.message}`); } event.target.value = ""; });
$("#mobileMenu").addEventListener("click", () => $(".sidebar").classList.toggle("is-open"));
$("#closeModal").addEventListener("click", () => $("#modalBackdrop").hidden = true);
$("#openJobs").addEventListener("click", () => setView("jobs"));
$("#refreshJobs").addEventListener("click", () => loadJobs().catch(() => {}));
$$("[data-import-kind]").forEach(button => {
  button.addEventListener("click", () => setImportKind(button.dataset.importKind));
  button.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const kinds = ["theme", "font", "asset"];
    const current = kinds.indexOf(state.importKind);
    const kind = event.key === "Home" ? kinds[0] : event.key === "End" ? kinds[kinds.length - 1] : kinds[(current + (event.key === "ArrowLeft" ? -1 : 1) + kinds.length) % kinds.length];
    setImportKind(kind);
    $(`#${kind}ImportTab`).focus();
  });
});
document.addEventListener("click", event => {
  const fontFilter = event.target.closest("[data-font-filter]");
  if (fontFilter && !fontFilter.disabled) { state.fontFilter = fontFilter.dataset.fontFilter || "all"; renderFonts(); return; }
  const openView = event.target.closest("[data-open-view]");
  if (openView) setView(openView.dataset.openView);
  const retry = event.target.closest("[data-retry-job]");
  if (retry) retryJob(retry.dataset.retryJob);
  const button = event.target.closest(".preview-open");
  if (button) showPreview(button);
});
document.addEventListener("submit", event => {
  const form = event.target.closest("[data-asset-form]");
  if (form) { event.preventDefault(); saveAssetClassification(form); }
  const recordForm = event.target.closest("[data-record-form]");
  if (recordForm) { event.preventDefault(); saveRecordClassification(recordForm); }
});
$$('[data-asset-filter]').forEach(button => button.addEventListener("click", () => { state.assetFilter = button.dataset.assetFilter || "all"; renderAssets(); }));
$("#assetSearchInput").addEventListener("input", event => { state.assetSearch = event.target.value; renderAssets(); });
$("#addAssetButton").addEventListener("click", () => { setView("import"); });
$("#closePreviewDialog").addEventListener("click", () => $("#previewDialog").close());
$("#previewDialog").addEventListener("click", event => {
  if (event.target !== event.currentTarget) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
});
$("#storageForm").addEventListener("submit", saveStorage);
$("#storageForm").addEventListener("input", () => { storageDirty = true; operationMessage($("#configStatus"), "配置有未保存的修改，请先保存再测试或同步。"); updateBulkControls(); });
$("#storageForm").elements.libraryProvider.addEventListener("change", updateStorageControls);
$("#storageForm").elements.archiveProvider.addEventListener("change", () => {
  const form = $("#storageForm");
  const path = form.elements.archiveRootPath;
  if (form.elements.archiveProvider.value === "123pan" && (!path.value.trim() || path.value === "originals")) path.value = "Red-Garden-Backup";
  updateStorageControls();
});
$("#pan123LoginForm").addEventListener("submit", event => savePan123Credentials(event, "login"));
$("#pan123SessionForm").addEventListener("submit", event => savePan123Credentials(event, "session"));
$("#startPan123Qr").addEventListener("click", startPan123Qr);
$("#stopPan123Qr").addEventListener("click", () => { stopPan123Qr("扫码已取消。"); updateStorageControls(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (pan123QrSession || state.operation === "pan123-qr-start")) { stopPan123Qr("已离开网页，请重新扫码连接。"); updateStorageControls(); }
});
$("#probePan123").addEventListener("click", probePan123);
$("#saveApiBase").addEventListener("click", saveApiBaseSetting);
$("#clearApiBase").addEventListener("click", () => { $("#apiBaseInput").value = ""; saveApiBaseSetting(); });
$("#testStorage").addEventListener("click", event => testStorage("library", event.currentTarget));
$("#testArchive").addEventListener("click", event => testStorage("archive", event.currentTarget));
$("#pullStorage").addEventListener("click", event => cloudOperation("pull", event.currentTarget));
$("#syncStorage").addEventListener("click", event => cloudOperation("sync", event.currentTarget));
$$('.nav-item').forEach(item => item.addEventListener('click', () => { setView(item.dataset.view); $(".sidebar").classList.remove("is-open"); }));
const initialView = location.hash.slice(1);
updateRuntimeMode();
try {
  const options = JSON.parse(sessionStorage.getItem("reeden-compression-options") || "null");
  if (options && Number.isInteger(options.quality) && options.quality >= 1 && options.quality <= 100) $("#compressionQuality").value = options.quality;
  if (options && Number.isInteger(options.max_edge) && options.max_edge >= 64 && options.max_edge <= 8192) $("#compressionMaxEdge").value = options.max_edge;
} catch {}
setView(viewNames[initialView] ? initialView : "import");
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (viewNames[view]) setView(view);
});
(async () => {
  try {
    await loadStorage();
    await Promise.all([loadThemes(), loadFonts(), loadAssets(), ...(browserSyncEnabled() ? [] : [loadPendingThemes()])]);
  } catch (error) { toast(error.message); }
})();
loadJobs().catch(() => {});
