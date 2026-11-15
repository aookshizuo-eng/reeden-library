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
// Device-local codec. free_codec.js implements ZIP parsing, image re-encoding
// and font inspection; free_codec_worker.js runs the CPU-heavy work in a Web
// Worker pool. Encrypted RED manifests are re-sealed by the sync Worker.
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
      ? (freeCodecReady() ? "同步 API 暂时不可用，已切换为本地浏览器处理模式。处理结果会在 API 恢复后同步；页面关闭会暂停本地任务。" : "同步 API 不可用；本地浏览器处理器尚未加载，未执行压缩或上传。请检查同步 API 地址与网络后重试；压缩本身在当前设备完成，不需要电脑。")
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
  // The previous library may belong to another API; never reuse its cached
  // records after the address changes.
  invalidateBrowserLibraryRecords();
  operationMessage($("#apiBaseStatus"), apiBase ? "已保存同步地址。正在读取共享库…" : "已清除同步地址，当前在本机浏览器内处理。");
  loadLibraryAfterConnection({fromSave: true});
}
let libraryLoadGeneration = 0;
function librarySummary() {
  return `${state.themes.length} 个主题、${state.fonts.length} 个字体、${state.assets.length} 个收藏`;
}
// One loader for both startup and "保存同步地址". Every stage writes a visible
// status, including the success case, so the settings panel can never stay on
// an endless "正在读取共享库…" after the requests have already finished.
async function loadLibraryAfterConnection({fromSave = false} = {}) {
  const generation = ++libraryLoadGeneration;
  const remote = Boolean(apiBase);
  const started = Date.now();
  const current = () => generation === libraryLoadGeneration;
  const status = (text, failed = false) => {
    if (remote) operationMessage($("#apiBaseStatus"), text, failed);
  };
  if (remote) status(fromSave ? "已保存同步地址。正在读取共享库（1/3 存储配置）…" : "正在读取共享库（1/3 存储配置）…");
  try {
    await loadStorage();
    if (!current()) return;
    status("正在读取共享库（2/3 记录清单）…");
    await Promise.all([loadThemes(), loadFonts(), loadAssets(), ...(browserSyncEnabled() ? [] : [loadPendingThemes()])]);
    if (!current()) return;
    status("正在读取共享库（3/3 任务进度）…");
    await loadJobs();
    if (!current()) return;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const jobsFailed = Boolean($("#jobsStatus")?.classList.contains("is-error"));
    if (remote) {
      status(`已连接共享库：${librarySummary()}（用时 ${seconds} 秒）。${jobsFailed ? "任务进度读取失败，请查看任务页提示。" : ""}`, jobsFailed);
    } else {
      toast(`已读取本机库：${librarySummary()}`);
    }
  } catch (error) {
    if (!current()) return;
    if (remote) status(`连接共享库失败：${error.message}`, true);
    else toast(`读取本机库失败：${error.message}`);
  }
}
function requestHeaders(headers = {}) {
  const result = new Headers(headers);
  if (apiBase && syncToken) result.set("Authorization", `Bearer ${syncToken}`);
  return result;
}
const state = { themes: [], fonts: [], assets: [], review: [], jobs: [], activeView: "import", importKind: "theme", themeSearch: "", themeAuthor: "all", assetFilter: "all", assetSearch: "", fontSearch: "", fontFilter: "all", storage: null, operation: "", importFontIds: readSessionIds("reeden-import-fonts"), importThemeJobIds: readSessionIds("reeden-import-theme-jobs"), importAssetIds: readSessionIds("reeden-import-assets") };
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
const API_READ_TIMEOUT_MS = 25000;
// A hung read used to leave the storage page on "正在读取共享库…" forever.
// Only idempotent reads are time-limited; uploads can legitimately take much
// longer and must never be aborted halfway through a PUT.
function fetchWithReadTimeout(url, request, timeoutMs) {
  if (!(timeoutMs > 0) || typeof AbortController === "undefined") return fetch(url, request);
  const controller = new AbortController();
  const outer = request.signal;
  const relayAbort = () => controller.abort(outer.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", relayAbort, {once: true});
  }
  const timer = setTimeout(() => controller.abort(new DOMException("read timeout", "TimeoutError")), timeoutMs);
  return fetch(url, {...request, signal: controller.signal})
    .catch(error => {
      if (controller.signal.aborted && !outer?.aborted) {
        throw new Error(`读取超时（${Math.round(timeoutMs / 1000)} 秒）：${new URL(url, location.href).pathname}`);
      }
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", relayAbort);
    });
}
async function api(path, options = {}) {
  if (staticHostedWithoutApi()) {
    throw new Error("当前 APK/静态网页尚未连接同步 Worker；请到“存储设置 → 多设备访问”填写 Worker 地址和同步 Token");
  }
  if (apiBase && remoteUnavailable) throw new Error("同步 API 不可用，未执行远程操作；请检查同步地址与网络后重试");
  const request = { ...options, headers: requestHeaders(options.headers || {}) };
  delete request.readTimeoutMs;
  const method = String(request.method || "GET").toUpperCase();
  const configuredTimeout = Number(options.readTimeoutMs);
  const readTimeout = ["GET", "HEAD"].includes(method)
    ? Math.max(1000, Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : API_READ_TIMEOUT_MS)
    : 0;
  const deadline = Date.now() + readTimeout;
  let response;
  try {
    // Pages Functions can briefly return a platform 500/502/503 while a new
    // deployment or R2 binding is warming up. Retry safe reads only; writes
    // must never be repeated automatically. The deadline covers all retries.
    for (let attempt = 0; ; attempt++) {
      const remaining = readTimeout ? Math.max(1000, deadline - Date.now()) : 0;
      response = await fetchWithReadTimeout(apiUrl(path), request, remaining);
      if (![500, 502, 503].includes(response.status) || !["GET", "HEAD"].includes(method) || attempt >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 450 * (attempt + 1)));
    }
  }
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
      const contentType = response.headers.get("content-type") || "";
      const detail = data.error || data.message || (contentType.includes("text/html") ? "同步服务正在部署或暂时不可用，请稍后刷新" : responseText.trim().slice(0, 240));
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
function bytesFromBase64(value) {
  const encoded = atob(String(value || "")), output = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index++) output[index] = encoded.charCodeAt(index);
  return output;
}
function concatBytes(chunks) {
  const total = chunks.reduce((sum, part) => sum + part.length, 0), result = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) { result.set(part, offset); offset += part.length; }
  return result;
}
function privateSkippedResult(raw, decisions = []) {
  return { bytes: raw, originalBytes: raw.length, compressedBytes: raw.length, savedBytes: 0, packageSelected: false, decisions, format: "red_private_v2", privateWorker: true };
}

// A small pool of codec workers keeps RED parsing, image decoding and WebP
// encoding off the UI thread. Every buffer is copied before transfer so the
// caller keeps its original bytes for the R2 upload and preview generation.
const codecWorkers = [];
let codecWorkerCursor = 0;
let codecWorkerSequence = 0;
function acquireCodecWorker() {
  if (typeof Worker === "undefined" || codecWorkerDisabled) return null;
  const wanted = Math.min(2, Math.max(1, Math.min(4, Number(navigator.hardwareConcurrency) || 2)));
  for (let index = codecWorkers.length; index < wanted; index++) {
    try { codecWorkers.push(new Worker("./free_codec_worker.js")); }
    catch { codecWorkerDisabled = true; break; }
  }
  if (!codecWorkers.length) { codecWorkerDisabled = true; return null; }
  const worker = codecWorkers[codecWorkerCursor++ % codecWorkers.length];
  return worker;
}
let codecWorkerDisabled = false;
function detachedCopy(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  return view.slice().buffer;
}
function normalizeCodecResult(result) {
  if (result?.bytes instanceof ArrayBuffer) result.bytes = new Uint8Array(result.bytes);
  const list = Array.isArray(result) ? result : result?.results;
  if (Array.isArray(list)) for (const item of list) if (item?.bytes instanceof ArrayBuffer) item.bytes = new Uint8Array(item.bytes);
  return result;
}
async function callCodecWorker(command, payload) {
  const worker = acquireCodecWorker();
  if (!worker) return null;
  const id = ++codecWorkerSequence;
  const message = {id, command, options: payload.options || {}};
  const transfer = [];
  if (payload.bytes) { const buffer = detachedCopy(payload.bytes); message.bytes = buffer; transfer.push(buffer); }
  if (payload.items) {
    message.items = payload.items.map(item => {
      const buffer = detachedCopy(item.bytes);
      transfer.push(buffer);
      return {...item, bytes: buffer};
    });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    const onMessage = event => {
      if (event.data?.id !== id) return;
      cleanup();
      if (!event.data.ok) { reject(new Error(event.data.error?.message || "本地处理线程失败")); return; }
      resolve(normalizeCodecResult(event.data.result));
    };
    const onError = event => {
      cleanup();
      codecWorkers.splice(codecWorkers.indexOf(worker), 1);
      reject(new Error(event.message || "本地处理线程异常"));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("本地处理超时")); }, 300000);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    try { worker.postMessage(message, transfer); } catch (error) { cleanup(); reject(error); }
  });
}
async function runCodecTask(command, payload, fallback) {
  if (!codecWorkerDisabled) {
    try { const result = await callCodecWorker(command, payload); if (result !== null) return result; }
    catch (error) { console.warn("codec worker 回退到主线程：", error.message); }
  }
  return await fallback();
}
function privatePrefix(raw) {
  if (raw.length < 12 || raw[0] !== 82 || raw[1] !== 69 || raw[2] !== 68 || raw[3] !== 16) throw new Error("不是 RED v2 加密主题");
  const headerLength = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(4, false);
  if (headerLength < 2 || headerLength > 65536 || 8 + headerLength > raw.length) throw new Error("RED v2 文件头无效");
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headerLength)));
  const prefixLength = 8 + headerLength + Number(header.manifestLength);
  if (!Number.isSafeInteger(prefixLength) || prefixLength > raw.length) throw new Error("RED v2 加密目录长度无效");
  return raw.subarray(0, prefixLength);
}
async function privateDirectory(prefix) {
  const response = await fetch(apiUrl("/api/private/directory"), {
    method: "POST", headers: requestHeaders({"Content-Type": "application/json"}),
    body: JSON.stringify({prefix_base64: base64Bytes(prefix)}),
  });
  if (response.status === 404) return null; // older Worker: use the whole-package fallback
  const text = await response.text();
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`加密目录解析失败（${response.status}）：${data.error || text.slice(0, 160)}`);
  return data;
}
async function privateSeal(prefix, replacements, configs) {
  const response = await fetch(apiUrl("/api/private/seal"), {
    method: "POST", headers: requestHeaders({"Content-Type": "application/json"}),
    body: JSON.stringify({prefix_base64: base64Bytes(prefix), replacements, configs}),
  });
  const text = await response.text();
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`加密主题重封失败（${response.status}）：${data.error || text.slice(0, 160)}`);
  if (!data.prefix_base64 || !Array.isArray(data.entries)) throw new Error("加密主题重封接口返回不完整");
  return data;
}
function privateResult(raw, output, decisions) {
  if (!output || output.length >= raw.length) {
    return privateSkippedResult(raw, decisions.map(item => ({...item, used: false, reason: "重封后未变小，保留原包"})));
  }
  return {bytes: output, originalBytes: raw.length, compressedBytes: output.length, savedBytes: raw.length - output.length,
    packageSelected: true, decisions, format: "red_private_v2", privateWorker: true};
}
async function compressPrivateRedViaWorker(raw, codec, options = {}) {
  const prefix = privatePrefix(raw);
  const directory = await privateDirectory(prefix);
  if (directory?.entries?.length) return await compressPrivateRedWithDirectory(raw, codec, options, prefix, directory);
  return await compressPrivateRedLegacy(raw, codec, options);
}
async function compressPrivateRedWithDirectory(raw, codec, options, prefix, directory) {
  const payload = raw.subarray(prefix.length);
  const entries = directory.entries;
  let cursor = 0;
  for (const entry of entries) {
    if (entry.offset !== cursor || entry.length < 0 || entry.offset + entry.length > payload.length) throw new Error("加密目录资源区不连续或越界");
    cursor = entry.offset + entry.length;
  }
  if (cursor !== payload.length) throw new Error("加密目录资源区末尾存在未登记数据");
  const slice = entry => payload.subarray(entry.offset, entry.offset + entry.length);
  const images = entries.filter(entry => String(codec.mimeFromBytes(slice(entry), entry.path) || "").startsWith("image/"));
  if (!images.length) return privateSkippedResult(raw);
  const compressed = await runCodecTask("compressImages",
    {items: images.map(entry => ({name: entry.path, bytes: slice(entry)})), options: {...options, concurrency: Math.min(4, Number(navigator.hardwareConcurrency) || 2)}},
    async () => ({results: await mapConcurrent(images, 3, async entry => {
      const result = await codec.compressImage(slice(entry), entry.path, options);
      return {ok: true, bytes: result.bytes, mime: result.mime, decision: result.decision};
    })}));
  const changed = [];
  compressed.results.forEach((result, index) => {
    const entry = images[index], original = slice(entry);
    if (!result?.ok || !result.decision?.used || result.bytes.length >= original.length) return;
    changed.push({entry, original, bytes: result.bytes, mime: result.mime});
  });
  if (!changed.length) return privateSkippedResult(raw);
  const hashItems = changed.flatMap(item => [{bytes: item.original}, {bytes: item.bytes}]);
  const hashes = await runCodecTask("hashes", {items: hashItems, options: {concurrency: 4}},
    async () => ({results: await mapConcurrent(hashItems, 3, async item => ({sha256: await codec.sha256Hex(item.bytes), md5: await codec.md5Hex(item.bytes), length: item.bytes.length}))}));
  const replacements = changed.map((item, index) => {
    const oldHash = hashes.results[index * 2], newHash = hashes.results[index * 2 + 1];
    if (oldHash.sha256.toLowerCase() !== String(item.entry.sha256).toLowerCase()) throw new Error(`加密目录资源校验失败：${item.entry.path}`);
    return {path: item.entry.path, old_sha256: oldHash.sha256, new_sha256: newHash.sha256,
      old_md5: oldHash.md5, new_md5: newHash.md5, new_length: item.bytes.length,
      new_extension: imageExtensionForMime(item.mime)};
  });
  const configs = entries.filter(entry => /\.json$/i.test(entry.path)).map(entry => ({path: entry.path, bytes_base64: base64Bytes(slice(entry))}));
  const seal = await privateSeal(prefix, replacements, configs);
  const configMap = new Map((seal.configs || []).map(item => [item.path, bytesFromBase64(item.bytes_base64)]));
  const changedMap = new Map(changed.map(item => [item.entry.path, item.bytes]));
  const sourceByPath = new Map(entries.map(entry => [entry.path, entry]));
  const chunks = [bytesFromBase64(seal.prefix_base64)];
  for (const entry of seal.entries) {
    if (entry.config && configMap.has(entry.source_path)) chunks.push(configMap.get(entry.source_path));
    else if (entry.replaced && changedMap.has(entry.source_path)) chunks.push(changedMap.get(entry.source_path));
    else {
      const source = sourceByPath.get(entry.source_path);
      if (!source) throw new Error(`重封资源缺少原始数据：${entry.source_path}`);
      chunks.push(slice(source));
    }
  }
  const output = concatBytes(chunks);
  if (output.length !== Number(seal.total_length)) throw new Error("加密主题重封长度校验失败");
  const decisions = changed.map((item, index) => ({path: item.entry.path, used: true, reason: "浏览器压缩图片后由同步 Worker 只重封文件头", original_bytes: item.original.length, compressed_bytes: replacements[index].new_length}));
  return privateResult(raw, output, decisions);
}
async function compressPrivateRedLegacy(raw, codec, options = {}) {
  const previewEntries = await runCodecTask("extractPrivatePreviewImages",
    {bytes: raw, options: {limit: 2000, maxBytes: 80 * 1024 * 1024}},
    () => codec.extractPrivatePreviewImages(raw, {limit: 2000, maxBytes: 80 * 1024 * 1024}));
  const compressed = await runCodecTask("compressImages",
    {items: previewEntries.map(entry => ({name: entry.name, bytes: entry.bytes})), options: {...options, concurrency: 4}},
    async () => ({results: await mapConcurrent(previewEntries, 3, async entry => {
      const result = await codec.compressImage(entry.bytes, entry.name, options);
      return {ok: true, bytes: result.bytes, mime: result.mime, decision: result.decision};
    })}));
  const changed = [];
  compressed.results.forEach((result, index) => {
    const entry = previewEntries[index];
    if (!result?.ok || !result.decision?.used || result.bytes.length >= entry.bytes.length) return;
    changed.push({entry, bytes: result.bytes, mime: result.mime});
  });
  if (!changed.length) return privateSkippedResult(raw);
  const hashItems = changed.flatMap(item => [{bytes: item.entry.bytes}, {bytes: item.bytes}]);
  const hashes = await runCodecTask("hashes", {items: hashItems, options: {concurrency: 4}},
    async () => ({results: await mapConcurrent(hashItems, 3, async item => ({sha256: await codec.sha256Hex(item.bytes), md5: await codec.md5Hex(item.bytes), length: item.bytes.length}))}));
  const replacements = changed.map((item, index) => ({
    offset: item.entry.offset, end: item.entry.end,
    old_sha256: hashes.results[index * 2].sha256, old_md5: hashes.results[index * 2].md5,
    new_md5: hashes.results[index * 2 + 1].md5, new_extension: imageExtensionForMime(item.mime),
    bytes_base64: base64Bytes(item.bytes),
  }));
  const response = await fetch(apiUrl("/api/private/repack"), {
    method: "POST", headers: requestHeaders({"Content-Type": "application/json"}),
    body: JSON.stringify({red_base64: base64Bytes(raw), replacements}),
  });
  const responseText = await response.text();
  let data = {}; try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
  if (!response.ok) throw new Error(`加密主题重封失败（${response.status}）：${data.error || responseText.slice(0, 200)}`);
  if (!data.bytes) throw new Error("加密主题重封接口没有返回压缩包");
  const decisions = changed.map((item, index) => ({path: `private@${item.entry.offset}`, used: true, reason: "压缩后由同步 Worker 认证重封", original_bytes: item.entry.bytes.length, compressed_bytes: item.bytes.length}));
  return privateResult(raw, bytesFromBase64(data.bytes), decisions);
}
const PAN123_TOKEN_STORAGE_KEY = "reeden-pan123-token";
const PAN123_FOLDER_STORAGE_KEY = "reeden-pan123-folder";
function pan123BackupConfig() {
  try { return {token: localStorage.getItem(PAN123_TOKEN_STORAGE_KEY) || "", folder: localStorage.getItem(PAN123_FOLDER_STORAGE_KEY) || "Red-Garden-Backup"}; }
  catch { return {token: "", folder: "Red-Garden-Backup"}; }
}
async function backupOriginalTo123(raw, name, codec) {
  const config = pan123BackupConfig();
  if (!config.token || !browserSyncEnabled()) return null;
  try {
    const md5 = await codec.md5Hex(raw);
    const fileName = (String(name || "theme").replace(/\.red$/i, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 200) || "theme") + ".red";
    const response = await fetch(apiUrl("/api/backup/123"), {
      method: "POST",
      headers: requestHeaders({
        "Content-Type": "application/octet-stream",
        "X-Pan123-Token": config.token,
        // HTTP header values only allow ISO-8859-1; Chinese theme names must be
        // percent-encoded or fetch throws before the request is ever sent.
        "X-Pan123-Folder": encodeURIComponent(config.folder),
        "X-Pan123-Filename": encodeURIComponent(fileName),
        "X-Pan123-Etag": md5,
      }),
      body: raw,
    });
    const text = await response.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) throw new Error(data.error || text.slice(0, 160));
    return data;
  } catch (error) {
    toast(`123 云盘备份未完成：${error.message}（R2 原包不受影响）`);
    return {error: error.message};
  }
}
// "测试连接" only lists the 123 root and the configured backup folder. It
// never creates a folder, uploads a probe file or stores the token on a server.
async function verifyPan123Backup() {
  const output = $("#pan123BackupStatus");
  const token = String($("#pan123BackupToken")?.value || "").trim() || pan123BackupConfig().token;
  const folder = String($("#pan123BackupFolder")?.value || "").trim() || "Red-Garden-Backup";
  if (!token) {
    operationMessage(output, "请先填写 123 云盘会话 Token：在 123 网盘网页 F12 → Network → 任一 /b/api 请求 → 复制 Authorization: Bearer 之后的值。", true);
    return false;
  }
  if (!apiBase) {
    operationMessage(output, "请先在「多设备访问」保存同步 API 地址与写入 Token。", true);
    return false;
  }
  operationMessage(output, "正在验证 123 云盘会话（只读校验）…");
  try {
    const response = await fetch(apiUrl("/api/backup/123/verify"), {
      method: "POST", headers: requestHeaders({"X-Pan123-Token": token, "X-Pan123-Folder": encodeURIComponent(folder)}),
    });
    const text = await response.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {}
    if (response.status === 401) throw new Error("同步写入 Token 无效或未保存，请先在「多设备访问」重新保存");
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const who = data.nickname ? `（${data.nickname}）` : "";
    operationMessage(output, `已连接 123 云盘${who}：根目录 ${data.rootItems} 项，备份目录 ${data.folder || "云盘根目录"}${data.folderExists ? "已存在" : "将在首次备份时创建"}。只读校验，未写入任何文件。`);
    refreshPan123BackupList({quiet: true}).catch(() => {});
    return true;
  } catch (error) {
    operationMessage(output, `123 云盘连接失败：${error.message}`, true);
    return false;
  }
}
function pan123InputConfig() {
  return {
    token: String($("#pan123BackupToken")?.value || "").trim() || pan123BackupConfig().token,
    folder: String($("#pan123BackupFolder")?.value || "").trim() || "Red-Garden-Backup",
  };
}
// "查看备份清单" answers the real question: are original .red packages actually
// sitting in 123, and does every theme in the shared library have one? It is
// read-only and auth-gated; the Worker never stores the session token.
async function refreshPan123BackupList({quiet = false} = {}) {
  const output = $("#pan123BackupStatus");
  const list = $("#pan123BackupList");
  const config = pan123InputConfig();
  if (!config.token) { if (!quiet) operationMessage(output, "请先填写并保存 123 云盘会话 Token，再查看备份清单。", true); return null; }
  if (!apiBase) { if (!quiet) operationMessage(output, "请先在「多设备访问」保存同步 API 地址与写入 Token。", true); return null; }
  // 123's list API takes several seconds; a frozen label looks like a hang, so
  // show elapsed seconds until the response lands.
  let ticker = null;
  const stopTicker = () => { if (ticker) { clearInterval(ticker); ticker = null; } };
  if (!quiet) {
    const startedAt = Date.now();
    operationMessage(output, "正在读取 123 云盘备份清单…");
    ticker = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      operationMessage(output, `正在读取 123 云盘备份清单…（已用 ${seconds} 秒）`);
    }, 1000);
  }
  try {
    const response = await fetch(apiUrl("/api/backup/123/list"), {
      method: "POST", headers: requestHeaders({"X-Pan123-Token": config.token, "X-Pan123-Folder": encodeURIComponent(config.folder)}),
    });
    const text = await response.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {}
    if (response.status === 401) throw new Error("同步写入 Token 无效或未保存，请先在「多设备访问」重新保存");
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    stopTicker();
    const items = Array.isArray(data.items) ? data.items : [];
    const files = items.filter(item => item.type === "file");
    const folders = items.filter(item => item.type === "folder");
    const redFiles = files.filter(item => /\.red$/i.test(item.name));
    const themes = state.themes || [];
    const backed = themes.filter(theme => theme.original_123?.key);
    const failed = themes.filter(theme => !theme.original_123?.key && theme.original_123_error);
    const missing = themes.filter(theme => !theme.original_123?.key && !theme.original_123_error);
    const parts = [
      `<div class="backup-head">123 云盘 / ${escapeHtml(data.folder || "云盘根目录")}</div>`,
      `<div>${data.folderExists ? "目录已存在" : "目录尚未创建（首次备份时自动创建）"}：文件 ${data.fileCount} 个，其中 <code>.red</code> 原包 ${redFiles.length} 个，合计 ${formatBytes(data.totalBytes)}；${folders.length} 个子目录${data.truncated ? "（仅显示前 1000 项）" : ""}。</div>`,
      `<div>共享库主题 ${themes.length} 个：已备份 ${backed.length} 个，备份失败 ${failed.length} 个，未备份 ${missing.length} 个。主题卡片也会显示「123 已备份 / 未备份」。</div>`,
    ];
    if (items.length) {
      parts.push(`<ul>${items.slice(0, 40).map(item => `<li><span>${item.type === "folder" ? "目录 · " : ""}${escapeHtml(item.name)}</span><span>${item.type === "folder" ? "文件夹" : formatBytes(item.bytes)}</span></li>`).join("")}</ul>`);
      if (items.length > 40) parts.push(`<div>仅列出前 40 项，共 ${items.length} 项。</div>`);
    } else {
      parts.push(`<div>目录里还没有文件。备份只发生在「导入 .red → 确认并压缩保存」这一步，字体、SVG/HTML 和预览图不备份到 123。</div>`);
    }
    if (missing.length) parts.push(`<div>未备份的主题：${escapeHtml(missing.slice(0, 8).map(theme => theme.name || theme.id).join("、"))}${missing.length > 8 ? ` 等 ${missing.length} 个` : ""}。</div>`);
    if (failed.length) parts.push(`<div class="inline-error">备份失败：${escapeHtml(failed.slice(0, 5).map(theme => `${theme.name || theme.id}（${theme.original_123_error}）`).join("；"))}</div>`);
    list.innerHTML = parts.join("");
    if (!quiet) operationMessage(output, `备份清单已更新：${redFiles.length} 个 .red 原包，库内 ${backed.length} / ${themes.length} 个主题已备份。只读检查，未写入文件。`);
    return data;
  } catch (error) {
    stopTicker();
    if (!quiet) operationMessage(output, `123 备份清单读取失败：${error.message}`, true);
    return null;
  } finally {
    stopTicker();
  }
}
// "测试连接" only proves the account can be read. This one actually exercises
// the upload path with a tiny fixed .red file; repeated runs reuse the same file.
async function verifyPan123Write() {
  const output = $("#pan123BackupStatus");
  const config = pan123InputConfig();
  if (!config.token) { operationMessage(output, "请先填写并保存 123 云盘会话 Token。", true); return false; }
  if (!apiBase) { operationMessage(output, "请先在「多设备访问」保存同步 API 地址与写入 Token。", true); return false; }
  operationMessage(output, "正在验证 123 云盘写入链路（会上传 1 个小测试文件）…");
  try {
    const codec = await loadFreeCodec();
    if (!codec?.md5Hex) throw new Error("浏览器处理器未加载，请刷新页面后重试");
    const bytes = new TextEncoder().encode("Red Garden 123 backup write verification\n");
    const etag = await codec.md5Hex(bytes);
    const folder = `${config.folder.replace(/\/+$/g, "")}/_verify`;
    const response = await fetch(apiUrl("/api/backup/123"), {
      method: "POST",
      headers: requestHeaders({
        "Content-Type": "application/octet-stream",
        "X-Pan123-Token": config.token,
        "X-Pan123-Folder": encodeURIComponent(folder),
        "X-Pan123-Filename": encodeURIComponent("reeden-backup-check.red"),
        "X-Pan123-Etag": etag,
      }),
      body: bytes,
    });
    const text = await response.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    operationMessage(output, `123 写入验证通过：${data.key}（${formatBytes(data.bytes)}，${data.reused ? "已存在并复用" : "新建"}，FileId ${data.fileId}）。测试文件保留在 _verify/ 子目录，不会混进真实原包。`);
    await refreshPan123BackupList({quiet: true});
    return true;
  } catch (error) {
    operationMessage(output, `123 写入验证失败：${error.message}（R2 原包不受影响）`, true);
    return false;
  }
}
async function browserCodec() {
  const codec = await loadFreeCodec();
  if (!codec?.inspectContainer || !codec?.sha256Hex || !codec?.md5Hex || !codec?.compressImage || !codec?.extractPrivatePreviewImages) throw new Error("浏览器处理器未加载，请刷新页面后重试");
  return codec;
}
// R2 keys keep the source name so the Cloudflare dashboard reads like a folder
// of themes instead of a wall of hashes. The digest is no longer part of the
// name: it travels in the X-Content-SHA256 header and lands in object metadata,
// and the Worker appends -2, -3 when two packs share a name.
function objectLabel(value) {
  const text = String(value || "")
    .replace(/[\\/:*?"<>|~]+/g, "-")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .trim();
  return text.slice(0, 80).replace(/[.\s]+$/, "");
}
function objectFileName(sha, extension, label) {
  const safe = objectLabel(label);
  return safe ? `${safe}.${extension}` : `${sha}.${extension}`;
}
async function uploadBrowserObject(kind, sha, extension, body, contentType, label = "") {
  const path = `/api/objects/${encodeURIComponent(kind)}/${encodeURIComponent(objectFileName(sha, extension, label))}`;
  const request = (method) => fetch(apiUrl(path), {
    method,
    headers: requestHeaders({ "Content-Type": contentType || "application/octet-stream", "X-Content-SHA256": sha }),
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
  // The Worker may rename the object to avoid a name clash, so keep whatever
  // filename it actually stored; later reads and deletes must hit that object.
  let stored = null;
  try { stored = await response.json(); } catch {}
  if (stored?.filename) return `/api/objects/${encodeURIComponent(kind)}/${encodeURIComponent(stored.filename)}`;
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
/**
 * Classify a font from its rendered glyph shapes instead of its file name.
 * One FontFace load also produces the specimen image stored in R2, so font
 * cards never need to download the multi-megabyte original again.
 */
function inkProfile(context, width, height) {
  const data = context.getImageData(0, 0, width, height).data;
  const rows = new Array(height).fill(0), cols = new Array(width).fill(0);
  let minX = width, maxX = -1, minY = height, maxY = -1, total = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    if (data[index + 3] <= 100 || data[index] + data[index + 1] + data[index + 2] >= 420) continue;
    rows[y]++; cols[x]++; total++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < minX) return null;
  const box = {minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1};
  const band = (array, from, to) => {
    const start = Math.floor(from * box.height), end = Math.max(start + 1, Math.ceil(to * box.height));
    let sum = 0; for (let y = minY + start; y < minY + end && y < height; y++) sum += rows[y];
    return sum / (end - start);
  };
  const rowWidth = fraction => {
    const y = Math.min(height - 1, minY + Math.floor(fraction * box.height));
    return rows[y];
  };
  const widths = cols.slice(minX, maxX + 1).filter(value => value > 0).sort((a, b) => a - b);
  const percentile = p => widths.length ? widths[Math.min(widths.length - 1, Math.floor(p * widths.length))] : 0;
  const slantTop = (() => {
    let sum = 0, count = 0;
    for (let y = minY; y < minY + Math.max(1, Math.floor(box.height * 0.2)); y++) for (let x = minX; x <= maxX; x++) {
      const index = (y * width + x) * 4;
      if (data[index + 3] > 100 && data[index] + data[index + 1] + data[index + 2] < 420) { sum += x; count++; }
    }
    return count ? sum / count : minX + box.width / 2;
  })();
  const slantBottom = (() => {
    let sum = 0, count = 0;
    for (let y = Math.max(0, maxY - Math.max(1, Math.floor(box.height * 0.2))); y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const index = (y * width + x) * 4;
      if (data[index + 3] > 100 && data[index] + data[index + 1] + data[index + 2] < 420) { sum += x; count++; }
    }
    return count ? sum / count : minX + box.width / 2;
  })();
  const cornerInk = (() => {
    const corner = Math.max(2, Math.floor(Math.min(box.width, box.height) * 0.16));
    let sum = 0;
    for (const [cx, cy] of [[minX, minY], [maxX - corner + 1, minY], [minX, maxY - corner + 1], [maxX - corner + 1, maxY - corner + 1]]) {
      for (let y = cy; y < cy + corner; y++) for (let x = cx; x < cx + corner; x++) {
        if (y < 0 || y >= height || x < 0 || x >= width) continue;
        const index = (y * width + x) * 4;
        if (data[index + 3] > 100 && data[index] + data[index + 1] + data[index + 2] < 420) sum++;
      }
    }
    return sum;
  })();
  return {
    serifScore: (band(rows, 0, 0.12) + band(rows, 0.88, 1)) / (2 * Math.max(1, band(rows, 0.44, 0.56))),
    strokeContrast: percentile(0.9) / Math.max(1, percentile(0.1)),
    roundScore: 1 - rowWidth(0.03) / Math.max(1, Math.max(rowWidth(0.4), rowWidth(0.6))),
    slant: slantBottom - slantTop,
    density: total / Math.max(1, box.width * box.height),
    cornerInkRatio: cornerInk / Math.max(1, total),
    box,
  };
}
async function analyzeFontGlyphs(bytes, fileName, fallbackStyle) {
  const fallback = {style: fallbackStyle || inferFontCategory({family: fileName}), source: "filename", method: "none", error: "", features: null, specimen: null};
  if (typeof document === "undefined") return fallback;
  const family = `rg-glyph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createCanvas = (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    if (!context) throw new Error("浏览器不支持 Canvas 2D");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height);
    context.fillStyle = "#101418"; context.textAlign = "center"; context.textBaseline = "middle";
    return {canvas, context};
  };
  let face, advanceOf, renderer;
  // Chromium's OTS sanitizer rejects some third-party Chinese TTFs that are
  // otherwise perfectly parseable. opentype.min.js is already loaded, so fall
  // back to drawing its glyph outlines directly instead of giving up on the
  // whole classification and specimen.
  try {
    if (typeof FontFace === "undefined") throw new Error("当前浏览器不支持 FontFace");
    face = new FontFace(family, bytes);
    await face.load();
    document.fonts.add(face);
    fallback.method = "FontFace";
    advanceOf = (text, size) => {
      const {context} = createCanvas(8, 8);
      context.font = `${size}px "${family}"`;
      return context.measureText(text).width;
    };
    renderer = (text, size, width, height) => {
      const {canvas, context} = createCanvas(width, height);
      context.font = `${size}px "${family}"`;
      context.fillText(text, width / 2, height / 2);
      return canvas;
    };
  } catch (error) {
    fallback.error = error?.message || String(error);
    try {
      const parser = window.opentype;
      if (typeof parser?.parse !== "function") throw new Error("opentype.js 未加载");
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const parsed = parser.parse(buffer);
      fallback.method = "opentype";
      advanceOf = (text, size) => parsed.getAdvanceWidth(text, size);
      renderer = (text, size, width, height) => {
        const {canvas, context} = createCanvas(width, height);
        const path = parsed.getPath(text, 0, 0, size);
        const box = path.getBoundingBox();
        const scale = Math.min(1, width * 0.82 / Math.max(1, box.x2 - box.x1), height * 0.82 / Math.max(1, box.y2 - box.y1));
        context.save();
        context.translate(width / 2, height / 2);
        context.scale(scale, scale);
        context.translate(-(box.x1 + box.x2) / 2, -(box.y1 + box.y2) / 2);
        context.fillStyle = "#101418";
        context.fill(new Path2D(path.toPathData(2)));
        context.restore();
        return canvas;
      };
    } catch (second) {
      fallback.error = `${fallback.error}；opentype 回退失败：${second?.message || String(second)}`;
      return fallback;
    }
  }
  try {
    const width = 420, height = 240;
    const profileFor = (text, size) => inkProfile(renderer(text, size, width, height).getContext("2d", {willReadFrequently: true}), width, height);
    const advances = ["i", "W", "中", "A"].map(text => advanceOf(text, 120)).filter(value => value > 0);
    const mono = advances.length === 4 && Math.min(...advances) / Math.max(...advances) > 0.88;
    const capitalI = profileFor("I", 170);
    const letterH = profileFor("H", 170);
    const square = profileFor("口", 170);
    const features = {
      mono, serifScore: Number((capitalI?.serifScore || 0).toFixed(2)),
      strokeContrast: Number((letterH?.strokeContrast || 0).toFixed(2)),
      roundScore: Number((square?.roundScore || 0).toFixed(2)),
      slant: Number((letterH?.slant || 0).toFixed(1)),
      density: Number((letterH?.density || 0).toFixed(3)),
    };
    let style;
    if (mono) style = "等宽";
    else if (Math.abs(features.slant) > 10 || features.density > 0.42) style = "手写体";
    else if (features.roundScore > 0.42 || (square?.cornerInkRatio || 0) < 0.012) style = "圆体";
    else if (features.serifScore > 1.5 || features.strokeContrast > 2.8) style = "宋体";
    else if (features.density > 0.3) style = "艺术体";
    else style = "黑体";
    // A visible specimen is generated from the same parsed font, so opening
    // the card later never needs to fetch the original font file again.
    const specimen = renderer("Aa 中文 你好 123", 64, 900, 300);
    const context = specimen.getContext("2d");
    context.fillStyle = "#8a94a3"; context.font = "20px sans-serif";
    context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(String(fileName || "").slice(0, 60), 450, 252);
    const blob = await new Promise(resolve => specimen.toBlob(resolve, "image/jpeg", 0.9));
    fallback.specimen = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    return {style, source: "glyph", method: fallback.method, error: fallback.error, features, specimen: fallback.specimen};
  } catch (error) {
    fallback.error = `字形绘制失败：${error?.message || String(error)}`;
    return fallback;
  } finally {
    if (face) { try { document.fonts.delete(face); } catch {} }
  }
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
const COMPRESSION_PRESET_LABELS = {balanced: "最高性价比", max: "最大压缩", custom: "自选模式"};
// Measured on real themes: still images drop to roughly a seventh of their bytes
// under 最大压缩 (WebP + per-role caps), while animated GIFs only merge colors
// and keep every frame, so they stay around three quarters of their size.
const COMPRESSION_PRESET_FACTORS = {
  balanced: {still: 0.55, gif: 0.85, fallback: [0.3, 0.8]},
  max: {still: 0.14, gif: 0.7, fallback: [0.12, 0.5]},
  custom: {still: 0.2, gif: 0.8, fallback: [0.15, 0.5]},
};
function selectedCompressionPreset() {
  const checked = document.querySelector("input[name='compressionPreset']:checked");
  return COMPRESSION_PRESET_LABELS[checked?.value] ? checked.value : "max";
}
function compressionOptions() {
  const preset = selectedCompressionPreset();
  if (preset === "custom") {
    const codec = document.querySelector("input[name='compressionCodec']:checked")?.value === "png" ? "png" : "webp";
    const quality = Number($("#compressionQuality").value);
    const max_edge = Number($("#compressionMaxEdge").value);
    const gif_colors = Number($("#compressionGifColors").value);
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("画质请选择 1–100 之间的数值");
    if (!Number.isInteger(max_edge) || max_edge < 0 || max_edge > 8192) throw new Error("静态图片长边上限请选择 0–8192 之间的数值（0 表示保持原尺寸）");
    return {
      preset, codec, quality, max_edge,
      gif_colors: Number.isInteger(gif_colors) && gif_colors >= 0 ? gif_colors : 0,
      icon_lossless: Boolean($("#compressionIconLossless")?.checked),
      compress_reader: Boolean($("#compressionReader")?.checked),
    };
  }
  const fixed = preset === "balanced" ? { quality: 94, max_edge: 0 } : { quality: 90, max_edge: 2560 };
  return { preset, ...fixed };
}
function syncCompressionControls() {
  const preset = selectedCompressionPreset();
  const custom = $("#compressionCustomFields");
  if (custom) custom.hidden = preset !== "custom";
  const busy = Boolean(state.operation);
  $$("#compressionCustomFields input").forEach(input => { input.disabled = busy || preset !== "custom"; });
  $$("input[name='compressionPreset']").forEach(input => { input.disabled = busy; });
  // Quality only means something for the lossy WebP encoder; a PNG target is
  // lossless, so the slider is disabled instead of silently ignored.
  const lossless = document.querySelector("input[name='compressionCodec']:checked")?.value === "png";
  const qualityRow = $("#compressionQualityRow");
  if (qualityRow) qualityRow.classList.toggle("is-muted", lossless);
  ["#compressionQuality", "#compressionQualityDown", "#compressionQualityUp"].forEach(selector => {
    const node = $(selector);
    if (node) node.disabled = busy || preset !== "custom" || lossless;
  });
  const output = $("#compressionQualityValue");
  if (output) {
    const value = Number($("#compressionQuality").value);
    output.textContent = `${Number.isFinite(value) ? value : 95}%`;
  }
}
function themeSizeEstimate(item, factors) {
  const entries = item.inspection?.entries;
  if (!Array.isArray(entries) || !entries.length) return null;
  let gif = 0, still = 0, other = 0;
  for (const entry of entries) {
    const mime = String(entry.mime || ""), size = Number(entry.bytes) || 0;
    if (mime === "image/gif") gif += size;
    else if (mime.startsWith("image/")) still += size;
    else other += size;
  }
  if (!gif && !still) return null;
  return {bytes: still * factors.still + gif * factors.gif + other, gif, still};
}
// 自选模式的比例没有固定值，按画质/编码方式反推一个经验系数，只为估算区间。
function customCompressionFactors(options) {
  const quality = Math.min(100, Math.max(50, Number(options?.quality) || 90));
  const maxEdge = Number(options?.max_edge) || 0;
  const still = options?.codec === "png"
    ? (maxEdge > 0 ? 0.5 : 0.95)
    : Math.min(0.9, Math.max(0.05, 0.13 * Math.pow(quality / 90, 4)));
  const colors = Number(options?.gif_colors || 0);
  const gif = colors === 0 ? 1 : colors >= 256 ? 0.85 : colors >= 128 ? 0.78 : 0.7;
  return { still, gif, fallback: [still * 0.75, Math.min(1, still * 2.2)] };
}
function compressionEstimate(chosen) {
  if (!chosen.length) return "";
  let options = null;
  try { options = compressionOptions(); } catch { options = null; }
  const preset = options?.preset || "max";
  const factors = preset === "custom" && options
    ? customCompressionFactors(options)
    : (COMPRESSION_PRESET_FACTORS[preset] || COMPRESSION_PRESET_FACTORS.max);
  let before = 0, low = 0, high = 0, gifTotal = 0;
  for (const item of chosen) {
    const size = Number(item.info?.bytes || item.bytes?.length || item.file?.size || 0);
    before += size;
    const estimate = themeSizeEstimate(item, factors);
    if (!estimate) { low += size * factors.fallback[0]; high += size * factors.fallback[1]; continue; }
    gifTotal += estimate.gif;
    low += estimate.bytes * 0.75;
    high += estimate.bytes * 1.35;
  }
  if (!before) return "";
  const toMb = value => (Math.max(0, value) / 1048576).toFixed(2);
  const gifShare = gifTotal / before;
  const gifNote = factors.gif >= 0.99
    ? `其中动图约 ${toMb(gifTotal)} MB：GIF 按你的设置保持原样，这部分体积不会变小。`
    : gifShare > 0.35
      ? `其中动图约 ${toMb(gifTotal)} MB：GIF 会保留尺寸、帧数与播放节奏，只能合并颜色，压缩幅度比静态图小。`
      : "";
  const label = preset === "custom" && options
    ? `自选（${options.codec === "png" ? "无损 PNG" : `WebP ${options.quality}%`}${Number(options.max_edge) > 0 ? `，长边 ${options.max_edge} px` : "，保持原尺寸"}${Number(options.gif_colors) > 0 ? `，GIF ${options.gif_colors} 色` : "，GIF 不改"})`
    : COMPRESSION_PRESET_LABELS[preset];
  return `按「${label}」压缩，原包 ${toMb(before)} MB，预计约 ${toMb(Math.min(low, before))}–${toMb(Math.min(high, before))} MB（经验估算，以实际导出为准）。${gifNote}`;
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
      : "加密 RED 需要配置同步 API：图片在当前设备压缩后，由 Worker 认证清单并重新封包。")
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
// Upload progress lives in R2 so a phone can watch a desktop batch (and vice
// versa) even after a refresh. Failures to write progress never block uploads.
let activeCloudJob = null;
let cloudJobPatch = null;
let cloudJobTimer;
let suppressCloudJob = false;
let resumingStaged = false;
let stagedResumeBusy = false;
async function sendCloudJobPatch(patch, id = activeCloudJob) {
  if (!id || !patch) return;
  try {
    // keepalive lets the final "completed" patch survive a tab that closes
    // right as compression ends, which otherwise leaves the job stuck running.
    await fetch(apiUrl(`/api/jobs/${encodeURIComponent(id)}`), {
      method: "PATCH", headers: requestHeaders({"Content-Type": "application/json"}), body: JSON.stringify(patch), keepalive: true,
    });
  } catch {}
}
async function createCloudJob(title, total, items = []) {
  if (suppressCloudJob || !browserSyncEnabled() || !syncToken) return;
  try {
    const response = await fetch(apiUrl("/api/jobs"), {
      method: "POST", headers: requestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        kind: "upload", title, total,
        // The queue record keeps the batch names so another device (or the
        // job list) can show what is inside the batch, not just "0 / 1".
        items: (Array.isArray(items) ? items : []).map(String).filter(Boolean).slice(0, 100),
        device: /Android|iPhone|iPad/i.test(navigator.userAgent) ? "mobile" : "desktop",
      }),
      keepalive: true,
    });
    if (!response.ok) return;
    const data = await response.json();
    activeCloudJob = data.job?.id || null;
    if (activeCloudJob && cloudJobPatch) {
      const pending = cloudJobPatch; cloudJobPatch = null;
      await sendCloudJobPatch(pending);
    }
  } catch {}
}
function persistJobProgress(patch) {
  cloudJobPatch = {...(cloudJobPatch || {}), ...patch};
  if (!activeCloudJob) return;
  clearTimeout(cloudJobTimer);
  cloudJobTimer = setTimeout(() => {
    const pending = cloudJobPatch; cloudJobPatch = null;
    sendCloudJobPatch(pending);
  }, 500);
}
function updateTransferProgress(patch = {}) {
  Object.assign(transferState, patch);
  const total = Math.max(0, Number(transferState.total) || 0);
  const completed = Math.max(0, Math.min(total || Number.MAX_SAFE_INTEGER, Number(transferState.completed) || 0));
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const stageText = transferState.stage || "等待开始";
  const currentText = transferState.current || "";
  const countText = `${completed} / ${total}${transferState.failed ? ` · 失败 ${transferState.failed}` : ""}`;
  const paint = (prefix, visible) => {
    const title = $(`#${prefix}Title`);
    const count = $(`#${prefix}Count`);
    const bar = $(`#${prefix}Bar`);
    const stage = $(`#${prefix}Stage`);
    const current = $(`#${prefix}Current`);
    if (title) title.textContent = transferState.title || "正在处理";
    if (count) count.textContent = countText;
    if (bar) bar.value = percent;
    if (stage) stage.textContent = stageText;
    if (current) current.textContent = currentText;
    const panel = $(`#${prefix}`);
    if (panel) { panel.hidden = !visible; panel.classList.toggle("is-error", transferState.failed > 0); panel.classList.toggle("is-complete", !transferState.active && total > 0); }
  };
  // The reviewed batch sits near the bottom of the import view, so its own
  // panel is painted as well; otherwise the only feedback was in 后台任务.
  paint("transferProgress", true);
  paint("reviewProgress", transferState.active || (Boolean(transferState.title) && Boolean($("#reviewProgress") && !$("#reviewArea").hidden)));
  persistJobProgress({status: transferState.active ? "running" : "completed", stage: stageText,
    current: currentText, completed: transferState.completed, failed: transferState.failed, total});
}
function revealTransferProgress() {
  const panel = $("#reviewProgress");
  if (!panel || panel.hidden) return;
  try { panel.scrollIntoView({block: "nearest", behavior: "smooth"}); } catch { panel.scrollIntoView(); }
}
function beginTransferProgress(title, total, items = []) {
  activeCloudJob = null; cloudJobPatch = null; clearTimeout(cloudJobTimer);
  Object.assign(transferState, { active: true, title, total: Math.max(0, Number(total) || 0), completed: 0, failed: 0, stage: "准备处理", current: "" });
  updateTransferProgress();
  revealTransferProgress();
  createCloudJob(title, total, items).catch(() => {});
}
function transferStage(stage, current = "") {
  updateTransferProgress({ active: true, stage, current });
}
function transferDone(current = "", failed = false) {
  updateTransferProgress({ completed: transferState.completed + 1, failed: transferState.failed + (failed ? 1 : 0), current });
}
function finishTransferProgress(message, failed = transferState.failed) {
  updateTransferProgress({ active: false, title: message, stage: failed ? "处理完成，但有项目失败" : "全部完成", current: failed ? `失败 ${failed} 项，可查看错误后重试` : "已写入共享 R2" });
  const finalPatch = {...(cloudJobPatch || {}), status: failed ? "partial" : "completed", stage: message,
    completed: transferState.completed, failed, total: transferState.total, result: message};
  cloudJobPatch = null; clearTimeout(cloudJobTimer);
  const id = activeCloudJob; activeCloudJob = null;
  if (id) sendCloudJobPatch(finalPatch, id);
}
function r2Enabled() { return browserSyncEnabled() || state.storage?.library?.provider === "cloudflare_r2"; }
function autoSyncEnabled() { return browserSyncEnabled() || (r2Enabled() && state.storage?.library?.autoSync); }
function savedToCloud(record) { return record.saved_to_cloud === true || (record.sync_status?.library === "synced" && record.local_status === "cloud_only" && !record.sync_error); }
function eligibleIds(kind) {
  if (kind === "review") return state.review.filter(item => !isAssetBusy("staging", item.staging_id)).map(item => item.staging_id);
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  return collection.filter(item => !savedToCloud(item) && !isAssetBusy(kind, item.id)).map(item => item.id);
}
function selectableIds(kind) {
  if (kind === "review") return state.review.filter(item => !isAssetBusy("staging", item.staging_id)).map(item => item.staging_id);
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  return collection.filter(item => !isAssetBusy(kind, item.id)).map(item => item.id);
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
    const ids = selectableIds(kind);
    const available = new Set(ids);
    for (const id of selections[kind]) if (!available.has(id)) selections[kind].delete(id);
    const count = selections[kind].size;
    const checkbox = $("#" + checkboxId);
    checkbox.checked = ids.length > 0 && count === ids.length;
    checkbox.indeterminate = count > 0 && count < ids.length;
    checkbox.disabled = Boolean(state.operation) || !ids.length;
    $("#" + countId).textContent = `已选 ${count} / ${ids.length} 项`;
    const syncCount = [...selections[kind]].filter(id => eligibleIds(kind).includes(id)).length;
    $("#" + buttonId).disabled = Boolean(state.operation) || storageDirty || !syncCount || (["theme", "font", "asset"].includes(kind) && !r2Enabled());
    $("#" + buttonId).title = storageDirty ? "请先保存存储设置" : "";
    const deleteButton = $("#deleteSelected" + kind[0].toUpperCase() + kind.slice(1));
    if (deleteButton) deleteButton.disabled = Boolean(state.operation) || !count;
    const downloadButton = $("#downloadSelected" + kind[0].toUpperCase() + kind.slice(1));
    if (downloadButton) downloadButton.disabled = Boolean(state.operation) || !count;
  });
  const chosenReview = state.review.filter(item => selections.review.has(item.staging_id));
  const privateCount = chosenReview.filter(item => !browserPrivateCompressionEnabled() && requiresOriginalPreservation(item.info)).length;
  const normalCount = chosenReview.length - privateCount;
  const onlyPrivate = privateCount > 0 && normalCount === 0;
  const syncSuffix = browserSyncEnabled() ? "、上传 R2" : autoSyncEnabled() ? "、同步" : "";
  $("#commitSelectedThemes").textContent = onlyPrivate ? `确认所选并原样保存${syncSuffix}` : `确认所选并压缩${syncSuffix || "保存"}`;
  const basePlan = chosenReview.length ? `${chosenReview.length} 个主题将压缩并重新封包${privateCount ? `；${privateCount} 个当前设备无法认证的加密包先保留原包` : ""}。处理完成后显示压缩前后大小。` : "全选或勾选主题后确认，开始处理。加密主题会先压缩包内图片，再由同步 Worker 认证清单并重新封包。";
  $("#compressionPlan").textContent = [basePlan, compressionEstimate(chosenReview)].filter(Boolean).join(" ");
  syncCompressionControls();
  $("#themeToolbar").hidden = !state.themes.length;
  $("#fontToolbar").hidden = !state.fonts.length;
  $("#assetToolbar").hidden = !state.assets.length;
  const eligible = Object.fromEntries(Object.keys(selections).map(kind => [kind, new Set(selectableIds(kind))]));
  $$("[data-selection]").forEach(input => {
    input.checked = selections[input.dataset.selection].has(input.dataset.id);
    input.disabled = Boolean(state.operation) || !eligible[input.dataset.selection].has(input.dataset.id);
    input.closest("article")?.classList.toggle("is-selected", input.checked);
  });
  $$(".sync-theme, .sync-font, .sync-asset").forEach(button => { const kind = button.classList.contains("sync-font") ? "font" : button.classList.contains("sync-asset") ? "asset" : "theme"; button.disabled = Boolean(state.operation) || !r2Enabled() || storageDirty || button.dataset.completed === "true" || isAssetBusy(kind, button.dataset.id); });
  $$(".delete-record").forEach(button => { const kind = button.dataset.kind; button.disabled = Boolean(state.operation) || isAssetBusy(kind, button.dataset.id); });
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
  selections[kind] = new Set(checked ? selectableIds(kind) : []);
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
  // During startup the boot sequence already loads storage and then all
  // libraries. Loading here too would race a second, differently-deduplicated
  // request and make the card count flicker between raw and merged records.
  if (state.storage) {
    if (view === "themes") loadThemes().catch(error => toast(error.message));
    if (view === "fonts") loadFonts().catch(error => toast(error.message));
    if (view === "assets") loadAssets().catch(error => toast(error.message));
  }
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
const DEFAULT_FONT_CATEGORIES = ["宋体", "黑体", "圆体", "手写体", "等宽", "可爱字形", "像素体", "楷体", "仿宋", "艺术体", "其他"];
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
  const source = font?.style_source === "glyph" ? (font?.glyph_method === "opentype" ? "字形判定 · 轮廓回退" : "字形判定") : "名称规则";
  return `<div class="record-classifications"><span class="category-chip">分类：${escapeHtml(style)} · ${source}</span>${tags.map(tag => `<span class="category-chip">#${escapeHtml(tag)}</span>`).join("")}</div><details class="font-edit-details"><summary>编辑分类与标签</summary><form class="asset-meta-form record-classification-form" data-record-form="${escapeHtml(font?.id || "")}" data-record-kind="font"><div class="asset-meta-fields"><label>分类<input name="style" value="${escapeHtml(style === "其他" && !font?.style ? "" : style)}" placeholder="宋体、黑体、圆体、手写体" /></label><label>标签<input name="tags" value="${escapeHtml(tags.join(", "))}" placeholder="标签，用逗号分隔" /></label></div><button class="text-button" type="submit">保存分类</button></form></details>`;
}
function fontPreviewMarkup(font) {
  const name = font.family || font.file_name || "字体";
  // The specimen text always exists in the DOM. A broken preview image or a
  // failed FontFace load must never leave an empty card.
  const specimen = `<span class="font-preview-fallback" data-font-preview-id="${escapeHtml(font.id || "")}"${font.preview_url ? " hidden" : ""}>Aa 中文 你好 123</span>`;
  const image = font.preview_url ? `<img class="font-preview-image" src="${escapeHtml(assetUrl(font.preview_url))}" alt="${escapeHtml(name)} 字形预览" loading="lazy" />` : "";
  return `<div class="font-preview-frame" data-font-id="${escapeHtml(font.id || "")}">${image}${specimen}</div>`;
}
function loadFontPreviewFace(font) {
  const url = assetUrl(font?.view_url || font?.url);
  if (!url || !font?.id || loadedFontFaces.has(font.id) || typeof FontFace === "undefined") return;
  const face = new FontFace(`font-${font.id}`, `url(${JSON.stringify(url)})`);
  face.load().then(loaded => {
    document.fonts.add(loaded);
    loadedFontFaces.add(font.id);
    const specimen = $(`[data-font-preview-id="${CSS.escape(font.id)}"]`);
    if (specimen) specimen.style.fontFamily = `font-${font.id}, sans-serif`;
  }).catch(() => {});
}
function recoverFontPreviewImage(image) {
  const frame = image.closest(".font-preview-frame");
  const fallback = frame?.querySelector(".font-preview-fallback");
  if (!frame || !fallback) return;
  image.remove();
  fallback.hidden = false;
  const font = state.fonts.find(item => String(item.id) === String(frame.dataset.fontId));
  if (font) loadFontPreviewFace(font);
}
function fontCard(font, imported = false) {
  const name = font.family || font.file_name || "未命名字体";
  const category = fontCategory(font);
  const selection = imported ? "" : selectInput("font", font.id, `字体 ${name}`, isAssetBusy("font", font.id));
  const actions = imported
    ? `<button class="text-button" data-open-view="jobs">查看同步任务</button>`
    : `<button class="text-button sync-font" data-id="${escapeHtml(font.id)}" data-completed="${savedToCloud(font)}">${savedToCloud(font) ? "R2 已保存" : "同步字体到 R2"}</button>${font.url ? `<a class="download-link" href="${escapeHtml(assetUrl(font.url))}">下载原字体</a>` : ""}<button class="text-button danger-text delete-record" data-kind="font" data-id="${escapeHtml(font.id)}">删除</button>`;
  return `<article class="font-card ${imported ? "import-font-card" : ""}"><div class="font-card-top">${selection}<span class="category-chip">${escapeHtml(category)}</span></div>${fontPreviewMarkup(font)}<div class="font-card-body"><h3 class="font-name">${escapeHtml(name)}</h3><div class="font-meta"><span>${escapeHtml((font.extension || "font").toUpperCase())}</span><span>${formatBytes(font.bytes)}</span><span>${escapeHtml(syncLabel(font))}</span></div>${font.sync_error ? `<p class="inline-error">${escapeHtml(typeof font.sync_error === "string" ? font.sync_error : Object.values(font.sync_error).join("；"))}</p>` : ""}${font.cleanup_warning ? `<p class="inline-error">${escapeHtml(typeof font.cleanup_warning === "string" ? font.cleanup_warning : Object.values(font.cleanup_warning).join("；"))}</p>` : ""}${imported ? "" : fontClassificationEditor(font)}</div><div class="font-actions">${actions}</div></article>`;
}
function themeMatchesSearch(theme) {
  const needle = String(state.themeSearch || "").trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  return [theme.name, theme.author, theme.file_name, theme.source_name, theme.compression_supported === false ? "加密" : "压缩"].some(value => String(value || "").toLocaleLowerCase("zh-CN").includes(needle));
}
function themeAuthorLabel(theme) { return String(theme?.author || "").trim() || "作者未记录"; }
function renderThemeAuthorFilter() {
  const select = $("#themeAuthorFilter");
  if (!select) return;
  const counts = new Map();
  state.themes.forEach(theme => {
    const author = themeAuthorLabel(theme);
    counts.set(author, (counts.get(author) || 0) + 1);
  });
  const authors = [...counts.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (state.themeAuthor !== "all" && !counts.has(state.themeAuthor)) state.themeAuthor = "all";
  select.innerHTML = `<option value="all">全部作者 (${state.themes.length})</option>` + authors.map(author => `<option value="${escapeHtml(author)}">${escapeHtml(author)} (${counts.get(author)})</option>`).join("");
  select.value = state.themeAuthor;
}
function renderThemes() {
  const list = $("#themeList");
  renderThemeAuthorFilter();
  const visible = state.themes.filter(theme => themeMatchesSearch(theme) && (state.themeAuthor === "all" || themeAuthorLabel(theme) === state.themeAuthor));
  $("#themeCount").textContent = visible.length === state.themes.length ? `${state.themes.length} 个主题` : `${visible.length} / ${state.themes.length} 个主题`;
  $("#themeEmpty").hidden = visible.length > 0;
  $("#themeEmpty h3").textContent = state.themes.length && !visible.length ? "没有匹配的主题" : "还没有已收录主题";
  $("#themeEmpty p").textContent = state.themes.length && !visible.length ? "换一个主题名称、作者或压缩状态试试。" : "导入一个 `.red` 文件后，这里会显示预览、作者和压缩状态。";
  list.innerHTML = visible.map(theme => {
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
      <div class="theme-info"><label class="item-heading">${selectInput("theme", theme.id, `主题 ${theme.name || "未命名主题"}`, isAssetBusy("theme", theme.id))}<span class="theme-title">${escapeHtml(theme.name || "未命名主题")}</span></label><div class="theme-meta">${escapeHtml(theme.author || "作者未记录")}</div><p>${compressionText} · ${escapeHtml(syncLabel(theme))}</p>${theme.sync_error ? `<p class="inline-error">${escapeHtml(typeof theme.sync_error === "string" ? theme.sync_error : Object.values(theme.sync_error).join("；"))}</p>` : ""}${theme.cleanup_warning ? `<p class="inline-error">${escapeHtml(typeof theme.cleanup_warning === "string" ? theme.cleanup_warning : Object.values(theme.cleanup_warning).join("；"))}</p>` : ""}<div class="theme-badges">${roles.map(role => `<span class="badge">${escapeHtml(role)}</span>`).join("")}${theme.original_123?.key ? `<span class="badge is-good" title="${escapeHtml(theme.original_123.key)}">123 已备份</span>` : theme.original_123_error ? `<span class="badge" title="${escapeHtml(theme.original_123_error)}">123 备份失败</span>` : `<span class="badge">123 未备份</span>`}</div></div>
      <div class="theme-actions"><span class="size-line">${formatBytes(theme.compressed_size || theme.library_size || theme.original_size)}</span><button class="text-button rebuild-preview" data-id="${escapeHtml(theme.id)}">更新预览</button>${syncAction}${compressedLink}${libraryLink}${originalLink}<button class="text-button danger-text delete-record" data-kind="theme" data-id="${escapeHtml(theme.id)}">删除</button></div>
    </article>`;
  }).join("");
  $$(".sync-theme").forEach(button => button.addEventListener("click", () => syncTheme(button.dataset.id)));
  $$(".rebuild-preview").forEach(button => button.addEventListener("click", () => rebuildPreview(button.dataset.id)));
  $$(".delete-record[data-kind='theme']").forEach(button => button.addEventListener("click", () => deleteSelectedRecords("theme", [button.dataset.id])));
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
        : `<p class="review-meta">加密主题：先在「存储设置」填好同步 API 地址与 Token，图片就会在当前设备压缩，再由 Worker 认证清单、更新资源哈希并重新封包；未配置时只保存原包。</p>`)
      : "";
    return `<article class="review-card" data-review-id="${escapeHtml(item.staging_id)}"><div class="review-top"><div><label class="item-heading">${selectInput("review", item.staging_id, `待确认主题 ${info.name || info.source_name}`)}<span class="review-title">${escapeHtml(info.name || info.source_name)}</span></label><div class="review-meta">${escapeHtml(info.author || "作者未记录")} · ${formatBytes(info.bytes)} · ${escapeHtml(info.source_name)}</div></div><span class="badge ${duplicate ? "" : "is-good"}">${duplicate ? `疑似重复 ${item.duplicates.length}` : "未发现同名作者"}</span></div>${privateNote}${duplicate ? `<div class="duplicate-note">已有库中存在同名作者主题。下面只展示缩略图，是否重复由你确认。</div><div class="duplicate-thumbs">${duplicateThumbs}</div>` : ""}<div class="duplicate-thumbs"><div class="thumb-label">${previewImage(preview.url, `待审核主题${preview.label} · ${previewKind(info.preview_details)}`, "thumb", info.preview_details)}<span>新主题 · ${preview.label}</span><span>${escapeHtml(previewKind(info.preview_details))} · 点击放大</span></div></div>${item.commitError ? `<p class="inline-error">${escapeHtml(item.commitError)}</p>` : ""}<div class="review-actions"><button class="primary-button commit-theme" data-id="${escapeHtml(item.staging_id)}">${privateTheme ? "确认并保存原包（配好同步后可压缩）" : "确认并压缩保存"}${autoSyncEnabled() ? "并后台同步" : "（后台处理）"}</button><button class="secondary-button discard-review" data-id="${escapeHtml(item.staging_id)}">暂不处理</button></div></article>`;
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
  $("#fontList").innerHTML = visible.map(font => fontCard(font)).join("");
  $$("#fontList .font-preview-image").forEach(image => {
    image.addEventListener("error", () => recoverFontPreviewImage(image), {once: true});
    if (image.complete && image.naturalWidth === 0) recoverFontPreviewImage(image);
  });
  // Only fonts without a generated specimen need the original font file.
  // Cards with a preview image must not download a multi-megabyte TTF/WOFF.
  visible.filter(font => !font.preview_url).forEach(loadFontPreviewFace);
  $$(".sync-font").forEach(button => button.addEventListener("click", () => syncFont(button.dataset.id)));
  $$(".delete-record[data-kind='font']").forEach(button => button.addEventListener("click", () => deleteSelectedRecords("font", [button.dataset.id])));
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
    <div class="asset-card-body"><div class="asset-card-head"><label class="item-heading">${imported ? "" : selectInput("asset", asset.id, `收藏 ${asset.name || asset.file_name}`, isAssetBusy("asset", asset.id))}<span class="theme-title">${escapeHtml(asset.name || asset.file_name || "未命名收藏")}</span></label><span class="badge">${assetTypeLabel(asset)}</span></div>
      <div class="asset-meta">${escapeHtml(asset.file_name || "")} · SHA ${escapeHtml(String(asset.sha256 || "").slice(0, 12))}</div>
      <div class="asset-classifications">${author ? `<span class="category-chip">作者：${escapeHtml(author)}</span>` : `<span class="category-chip is-empty">未分作者</span>`}${style ? `<span class="category-chip">风格：${escapeHtml(style)}</span>` : `<span class="category-chip is-empty">未分风格</span>`}${tags.map(tag => `<span class="category-chip">#${escapeHtml(tag)}</span>`).join("")}</div>
      <form class="asset-meta-form" data-record-form="${escapeHtml(asset.id || "")}" data-record-kind="asset"><div class="asset-meta-fields"><label>作者<input name="author" value="${escapeHtml(author)}" placeholder="作者" /></label><label>风格<input name="style" value="${escapeHtml(style)}" placeholder="风格" /></label><label>标签<input name="tags" value="${escapeHtml(tags.join(", "))}" placeholder="标签，用逗号分隔" /></label></div><button class="text-button" type="submit">保存分类</button></form>
    </div><div class="asset-actions"><button class="text-button sync-asset" data-id="${escapeHtml(asset.id || "")}" data-completed="${savedToCloud(asset)}">${savedToCloud(asset) ? "R2 已保存" : "同步到 R2"}</button>${objectUrl ? `<a class="download-link" href="${escapeHtml(objectUrl)}" download="${escapeHtml(asset.file_name || asset.name || "asset")}">下载原文件</a>` : ""}<button class="text-button danger-text delete-record" data-kind="asset" data-id="${escapeHtml(asset.id || "")}">删除</button></div>
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
  $$(".delete-record[data-kind='asset']").forEach(button => button.addEventListener("click", () => deleteSelectedRecords("asset", [button.dataset.id])));
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
  $("#importedFontList").innerHTML = fonts.map(font => fontCard(font, true)).join("");
}
function rememberJob(job) {
  if (!job?.id) throw new Error("后台没有返回任务编号，请刷新后检查任务列表");
  state.jobs = [job, ...state.jobs.filter(item => item.id !== job.id)];
}
function jobTitle(job) {
  if (job.action === "commit-themes") return "主题入库";
  if (job.action === "sync-all") return "全部资产同步";
  if (job.action === "archive-probe") return "123 备份验证";
  const explicit = String(job.title || "").trim();
  if (explicit) return explicit;
  return job.kind === "font" ? "字体同步" : job.kind === "asset" ? "收藏同步" : "主题同步";
}
function jobStatus(job) {
  return { queued: "等待处理", running: "正在处理", completed: "已完成", partial: "部分失败", failed: "处理失败" }[job.status] || "等待处理";
}
function jobItemNames(job) {
  const items = Array.isArray(job.items) ? job.items.map(value => String(value || "").trim()).filter(Boolean) : [];
  return items.length ? items : Array.isArray(job.source_keys) ? job.source_keys.map(String).filter(Boolean) : [];
}
function jobCard(job) {
  const total = Math.max(0, Number(job.total) || 0);
  const completed = Math.min(total, Math.max(0, Number(job.completed) || 0));
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const failed = Array.isArray(job.failed) ? job.failed : [];
  const active = ["queued", "running"].includes(job.status);
  const retrying = activeJobs().some(item => (item.parent_id || item.retry_of) === job.id);
  const names = jobItemNames(job);
  const currentName = typeof job.current === "string" ? job.current.trim() : String(job.current?.name || "").trim();
  const stage = String(job.stage || "").trim();
  // While a job runs, the useful information is "which file, which step,
  // how far". The old card only had a counter, so a 4-theme batch looked
  // identical to a stuck job with no name attached.
  let detail;
  if (active) {
    const position = currentName ? ` ${Math.min(total || 1, completed + 1)}/${total || 1}` : "";
    const subject = currentName
      ? `${currentName}`
      : names.length === 1 ? names[0] : names.length ? `${names.slice(0, 2).join("、")}${names.length > 2 ? ` 等 ${names.length} 个` : ""}` : "";
    if (job.status === "queued" && !currentName) detail = `已进入队列${subject ? `：${subject}` : ""}，等待本设备继续处理`;
    else detail = [`正在处理${position}${subject ? `：${subject}` : ""}`, stage && stage !== "等待处理" ? stage : ""].filter(Boolean).join(" · ");
  } else {
    // A finished job's own result is more informative than a raw counter, e.g.
    // "1 个主题已自动压缩并入库" instead of "0 项成功 · 0 项跳过".
    detail = job.result ? String(job.result).slice(0, 180) : `${Number(job.succeeded) || 0} 项成功 · ${Number(job.skipped) || 0} 项跳过 · ${failed.length} 项失败`;
  }
  const itemsLine = active && names.length > 1
    ? `<p class="job-items">本批包含：${escapeHtml(names.slice(0, 6).join("、"))}${names.length > 6 ? ` 等 ${names.length} 个` : ""}</p>`
    : "";
  return `<article class="job-card" data-job-id="${escapeHtml(job.id)}"><div class="job-card-head"><div><h3>${escapeHtml(jobTitle(job))}</h3><span class="job-meta">${escapeHtml(jobStatus(job))} · 已处理 ${completed} / ${total} 项</span></div>${failed.length && !active ? `<button class="secondary-button retry-job" data-retry-job="${escapeHtml(job.id)}" ${state.operation || retrying ? "disabled" : ""}>${retrying ? "已加入重试" : "重试失败项"}</button>` : ""}</div><div class="job-progress-row"><progress class="job-progress" max="${Math.max(1,total)}" value="${completed}" aria-label="${escapeHtml(jobTitle(job))}进度"></progress><span class="job-percent">${percent}%</span></div><p class="job-detail ${failed.length && !active ? "is-error" : ""}">${escapeHtml(detail)}</p>${itemsLine}${failed.length ? `<details class="job-errors"><summary>${failed.length} 项失败详情</summary><ul>${failed.map(item => `<li><strong>${escapeHtml(item.name || item.id || "文件")}</strong><span>${escapeHtml(item.error || "处理失败")}</span></li>`).join("")}</ul></details>` : ""}</article>`;
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
    operationMessage($("#jobsStatus"), browserSyncEnabled()
      ? "免费同步模式：批次队列存在共享 R2，关掉页面不会丢，换一台设备或重开页面会自动继续；图片压缩需要浏览器画布，所以由设备执行。"
      : "任务由本地服务执行。完成记录与失败原因会保留，失败项可单独重试。");
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
function latestRecords(records) {
  // A classification edit writes a new immutable record with the same stable
  // id. Both /api/library and the legacy per-kind endpoints must merge those
  // duplicates the same way, otherwise the card count depends on which load
  // finishes last.
  const latest = new Map();
  for (const record of records || []) {
    const key = `${record.kind || "unknown"}:${record.id || record.sha256 || JSON.stringify(record)}`;
    const current = latest.get(key);
    const nextTime = Date.parse(record.updated_at || record.created_at || "") || 0;
    const currentTime = Date.parse(current?.updated_at || current?.created_at || "") || 0;
    if (!current || nextTime >= currentTime) latest.set(key, record);
  }
  return [...latest.values()];
}
async function loadThemes(force = false) {
  const records = browserSyncEnabled() ? await loadBrowserLibraryRecords(force) : latestRecords((await api("/api/themes")).items || []);
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
    browserLibraryRecordsCache = latestRecords(records);
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
  const records = browserSyncEnabled() ? await loadBrowserLibraryRecords(force) : latestRecords((await api("/api/fonts")).items || []);
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
      const selected = state.review.filter(item => chosen.includes(item.staging_id));
      beginTransferProgress("主题压缩与上传", selected.length, selected.map(item => item.info?.source_name || item.info?.name || "主题"));
      // Loading the codec used to happen before the panel appeared, so the
      // click looked like it did nothing for a moment.
      transferStage("加载压缩引擎", "");
      const codec = await browserCodec();
      let finished = 0;
      const results = await mapConcurrent(selected, 2, async item => {
        const name = item.info?.source_name || item.info?.name || "主题";
        try {
          transferStage("读取主题", name);
          const raw = item.bytes || new Uint8Array(await item.file.arrayBuffer());
          const encrypted = item.info?.compression_supported === false || item.inspection?.format === "red_private_v2";
          transferStage(encrypted ? "压缩图片并重新封包" : "压缩图片", name);
          const compressionOptions = options.preset === "custom"
            ? { preset: options.preset, codec: options.codec, quality: options.quality, maxEdge: options.max_edge, gifColors: options.gif_colors, iconLossless: options.icon_lossless, compressReader: options.compress_reader, concurrency: Math.min(4, Number(navigator.hardwareConcurrency) || 2) }
            : { preset: options.preset, concurrency: Math.min(4, Number(navigator.hardwareConcurrency) || 2) };
          const result = encrypted
            ? await compressPrivateRedViaWorker(raw, codec, compressionOptions)
            : await runCodecTask("compressRed", { bytes: raw, options: compressionOptions }, () => codec.compressRed(raw, compressionOptions));
          const compressedBytes = result.bytes;
          const originalSha = await codec.sha256Hex(raw);
          transferStage("上传原始主题", name);
          const originalPath = await uploadBrowserObject("originals", originalSha, "red", raw, "application/octet-stream", `${name}-原包`);
          const backup = pan123BackupConfig().token ? await backupOriginalTo123(raw, item.info?.source_name || name, codec) : null;
          const assetSha = await codec.sha256Hex(compressedBytes);
          transferStage("上传压缩主题", name);
          const compressedPath = await uploadBrowserObject("compressed", assetSha, "red", compressedBytes, "application/octet-stream", `${name}-压缩`);
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
            previewPath = await uploadBrowserObject("previews", previewSha, "jpg", previewBytes, "image/jpeg", `${name}-预览`);
            previewDetails = { ...previewDetails, kind: previewCompositionKind(previewEntries), simulation: true, encrypted_source: encrypted };
          }
          if (!preview) transferStage("上传主题清单", name);
          const record = await uploadBrowserRecord({
            kind: "theme", id: `theme-${assetSha.slice(0, 16)}`, name: item.info.name || item.info.source_name, author: item.info.author || "作者未记录",
            sha256: assetSha, original_sha256: originalSha, original_size: raw.length, compressed_size: compressedBytes.length,
            compression_supported: true, status: "browser_compressed", source_name: item.info.source_name,
            compressed_url: compressedPath, library_url: compressedPath, preview_light_url: previewPath, preview_dark_url: "", preview_details: previewDetails,
            saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: "", original_url: originalPath,
            original_123: backup && !backup.error ? backup : null, original_123_error: backup?.error || ""
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
function downloadableFiles(kind, record) {
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
async function fetchDownloadableBytes(path, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(assetUrl(path), {signal: controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("读取超时，请检查网络后重试");
    throw error;
  } finally { clearTimeout(timer); }
}
async function downloadSelectedRecords(kind, ids = [...selections[kind]]) {
  if (state.operation) return;
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  const chosen = [...new Set(ids)].map(id => collection.find(item => String(item.id) === String(id))).filter(Boolean);
  if (!chosen.length) { toast("请先勾选要下载的项目"); return; }
  const output = $(`#${kind}BatchStatus`);
  const query = new URLSearchParams({kind, ids: chosen.map(item => String(item.id)).join(",")}).toString();
  setOperation(`download-${kind}`);
  // Remote mode: the shared Worker streams a Stored ZIP directly from R2.
  // Nothing is pulled into JS memory and already-compressed fonts/RED files
  // are not deflated a second time, so a 50 MB selection starts downloading
  // immediately with the browser's own progress indicator.
  if (apiBase && !remoteUnavailable) {
    operationMessage(output, `正在准备 ${chosen.length} 项批量下载…`);
    try {
      const probe = await fetch(apiUrl(`/api/download?${query}&probe=1`), {headers: requestHeaders()});
      let info = null;
      try { info = await probe.json(); } catch {}
      if (!probe.ok || !info?.ok) throw new Error(info?.error || `HTTP ${probe.status}`);
      const link = document.createElement("a");
      link.href = apiUrl(`/api/download?${query}`);
      link.download = `reeden-${kind}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.append(link); link.click(); link.remove();
      operationMessage(output, `已发起批量下载：${info.count} 个文件由共享库直接打包，可在浏览器下载列表查看进度。`);
      toast(`已发起 ${chosen.length} 项批量下载`);
    } catch (error) {
      operationMessage(output, `批量下载失败：${error.message}`, true);
      toast(`批量下载失败：${error.message}`);
    } finally { setOperation(""); }
    return;
  }
  // Browser-only mode keeps a local ZIP fallback for devices without the API.
  operationMessage(output, "正在读取所选文件并打包 ZIP…");
  try {
    const codec = await loadFreeCodec();
    if (!codec?.writeZipEntries) throw new Error("本地打包器未加载，请刷新页面后重试");
    const entries = [], manifest = [], failures = [];
    let done = 0;
    await mapConcurrent(chosen, 2, async record => {
      for (const file of downloadableFiles(kind, record)) {
        try {
          const bytes = await fetchDownloadableBytes(file.path);
          const name = `${kind}/${file.name.replace(/[\\/:*?"<>|]/g, "_")}`;
          entries.push({name, bytes});
          manifest.push({kind, id: record.id, name: file.name, path: name, bytes: bytes.length});
        } catch (error) {
          failures.push({name: file.name, path: file.path, error: error.message});
        }
      }
      operationMessage(output, `已读取 ${++done} / ${chosen.length} 项（${entries.length} 个文件）…`);
    });
    if (!manifest.length) throw new Error(`所有文件都读取失败：${failures[0]?.error || "未知错误"}`);
    entries.push({name: "manifest.json", bytes: new TextEncoder().encode(JSON.stringify({created_at: new Date().toISOString(), files: manifest, failures}, null, 2))});
    operationMessage(output, `正在生成 ZIP（${manifest.length} 个文件）…`);
    // Fonts and RED packages are already compressed: use Stored entries so the
    // fallback does not waste minutes on a second DEFLATE pass.
    const packageBytes = await codec.writeZipEntries(entries, {concurrency: 4, store: true});
    const zip = packageBytes.subarray(codec.RED_ZIP?.length || 4);
    const url = URL.createObjectURL(new Blob([zip], {type: "application/zip"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = `reeden-${kind}-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    operationMessage(output, `已打包 ${manifest.length} 个文件，下载已开始。${failures.length ? ` ${failures.length} 个文件读取失败，详见包内 manifest.json。` : ""}`, false);
    toast(`已发起 ${chosen.length} 项批量下载`);
  } catch (error) {
    operationMessage(output, `批量下载失败：${error.message}`, true);
    toast(`批量下载失败：${error.message}`);
  } finally { setOperation(""); }
}
async function syncTheme(themeId) { return syncSelectedAssets("theme", [themeId]); }
async function syncFont(fontId) { return syncSelectedAssets("font", [fontId]); }
async function syncAsset(assetId) { return syncSelectedAssets("asset", [assetId]); }
async function deleteSelectedRecords(kind, ids = [...selections[kind]]) {
  if (state.operation) return;
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  const chosen = [...new Set(ids)].map(id => collection.find(item => String(item.id) === String(id))).filter(Boolean);
  if (!chosen.length) return;
  const label = kind === "theme" ? "主题" : kind === "font" ? "字体" : "收藏";
  const names = chosen.slice(0, 3).map(item => item.name || item.family || item.file_name || "未命名").join("、");
  const suffix = chosen.length > 3 ? ` 等 ${chosen.length} 项` : "";
  const confirmed = window.confirm(`确认删除 ${label}“${names}”${suffix}？\n\n将删除库记录，并只删除没有被其他记录引用的 R2 对象。共享对象会保留。删除完成后会刷新清单；对象删除失败时会保留在 R2 并明确提示。已删除记录可通过重新导入原文件恢复。`);
  if (!confirmed) return;
  const output = $(kind === "theme" ? "#themeBatchStatus" : kind === "font" ? "#fontBatchStatus" : "#assetBatchStatus");
  setOperation(`delete-${kind}`);
  operationMessage(output, `正在删除 ${chosen.length} 项${label}，检查共享对象引用…`);
  try {
    const result = await api("/api/library", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: chosen.map(item => ({ kind, id: item.id })) }) });
    const deletedIds = new Set((result.deleted || []).map(item => String(item.id)));
    if (kind === "theme") state.themes = state.themes.filter(item => !deletedIds.has(String(item.id)));
    if (kind === "font") state.fonts = state.fonts.filter(item => !deletedIds.has(String(item.id)));
    if (kind === "asset") state.assets = state.assets.filter(item => !deletedIds.has(String(item.id)));
    chosen.forEach(item => selections[kind].delete(item.id));
    invalidateBrowserLibraryRecords();
    renderThemes(); renderFonts(); renderAssets();
    const failed = result.failed || [];
    const shared = result.retainedShared || [];
    const message = `已删除 ${deletedIds.size} 项${label}。${shared.length ? `共享对象保留 ${shared.length} 个。` : ""}${failed.length ? ` ${failed.length} 个对象删除失败，文件仍保留在 R2，可稍后重试。` : ""}如需恢复已删除记录，请重新导入原文件。`;
    operationMessage(output, message, Boolean(failed.length));
    toast(failed.length ? `已删除记录，但有 ${failed.length} 个对象失败` : `${label}已删除，清单已刷新`);
    await Promise.all([loadThemes(true), loadFonts(true), loadAssets(true)]);
  } catch (error) {
    operationMessage(output, `删除失败：${error.message}。原记录仍保留，可重试。`, true);
    toast(`删除失败：${error.message}`);
  } finally { setOperation(""); }
}
async function syncSelectedAssets(kind, ids = [...selections[kind]]) {
  if (state.operation || !r2Enabled() || storageDirty || !ids.length) return;
  if (browserSyncEnabled()) {
    const output = $(kind === "theme" ? "#themeBatchStatus" : kind === "font" ? "#fontBatchStatus" : "#assetBatchStatus");
    const chosen = [...new Set(ids)].filter(id => eligibleIds(kind).includes(id));
    operationMessage(output, "免费浏览器模式会在导入/确认时直接上传到 R2；已有记录无需再次排队。", false);
    chosen.forEach(id => selections[kind].delete(id));
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
          const fontPath = await uploadBrowserObject("fonts", info.sha256, info.extension, bytes, `font/${info.extension}`, file.name.replace(/\.[^.]+$/, ""));
          transferStage("分析字形并生成预览", file.name);
          const analysis = await analyzeFontGlyphs(bytes, file.name, inferFontCategory({family: file.name}));
          let previewPath = "";
          if (analysis.specimen?.length) {
            const previewSha = await codec.sha256Hex(analysis.specimen);
            previewPath = await uploadBrowserObject("previews", previewSha, "jpg", analysis.specimen, "image/jpeg", `${file.name.replace(/\.[^.]+$/, "")}-预览`);
          }
          transferStage("写入字体清单", file.name);
          const record = await uploadBrowserRecord({
            kind: "font", id: `font-${info.sha256.slice(0, 16)}`, sha256: info.sha256, file_name: file.name,
            family: file.name.replace(/\.[^.]+$/, ""), subfamily: "Regular", extension: info.extension, bytes: info.bytes,
            style: analysis.style, style_source: analysis.source, glyph_method: analysis.method, glyph_error: analysis.error || "", glyph_analysis: analysis.features, tags: [],
            url: fontPath, view_url: fontPath, preview_url: previewPath, preview_state: previewPath ? "generated" : "disabled", preview_error: "", saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: ""
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
          const objectPath = await uploadBrowserObject("assets", hash, extension, bytes, mime, file.name.replace(/\.[^.]+$/, ""));
          let previewPath = "";
          if (extension === "svg") {
            try {
              transferStage("生成 SVG 预览", file.name);
              const previewBlob = await imagePreviewBlob(bytes, "image/svg+xml");
              const previewBytes = await jpegBytesFromBlob(previewBlob);
              if (previewBytes) {
                const previewSha = await codec.sha256Hex(previewBytes);
                transferStage("上传收藏预览", file.name);
                previewPath = await uploadBrowserObject("previews", previewSha, "jpg", previewBytes, "image/jpeg", `${file.name.replace(/\.[^.]+$/, "")}-预览`);
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
    if (generation === pan123QrGeneration) { stopPan123Qr(); operationMessage($("#pan123QrStatus"), "二维码暂时无法生成，请稍后重试。", true); }
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
    const message = error instanceof TypeError ? "暂时无法连接同步 API。输入已清空，请检查地址与网络后重新提交。" : error.message;
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
    operationMessage(output, "上传验证已加入后台队列。将在备份目录的 probes/ 上传随机小文件并回读核验，结果见后台任务。关闭网页后仍由 Worker 继续执行，不需要保持电脑开机。");
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
async function queueFilesForLater(fileList) {
  if (state.operation) { toast("请等待当前批次处理完成"); return; }
  const valid = [...(fileList || [])].filter(file => /\.(red|ttf|otf|woff2?|svg|html?)$/i.test(String(file.name || "")));
  if (!valid.length) { toast("没有可暂存的受支持文件"); return; }
  const codec = await browserCodec();
  setOperation("staging");
  suppressCloudJob = true;
  beginTransferProgress("后台暂存原文件", valid.length);
  const status = $("#unifiedImportStatus");
  status.hidden = false;
  try {
    const keys = [], names = [];
    await mapConcurrent(valid, 2, async file => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha = await codec.sha256Hex(bytes);
      const ext = /\.htm$/i.test(file.name) ? "html" : String(file.name).split(".").pop().toLowerCase();
      transferStage("上传原始文件到共享库", file.name);
      keys.push(await uploadBrowserObject("staging", sha, ext, bytes, "application/octet-stream"));
      names.push(file.name);
      transferDone(file.name);
    });
    const response = await fetch(apiUrl("/api/jobs"), {
      method: "POST", headers: requestHeaders({"Content-Type": "application/json"}),
      body: JSON.stringify({kind: "staged-import", title: `暂存 ${valid.length} 个文件，等待处理`, total: valid.length,
        items: names, source_keys: keys, auto_commit: true,
        device: /Android|iPhone|iPad/i.test(navigator.userAgent) ? "mobile" : "desktop"}),
    });
    if (!response.ok) throw new Error(`暂存任务创建失败（${response.status}）`);
    suppressCloudJob = false;
    finishTransferProgress(`${valid.length} 个原文件已暂存到共享库`);
    operationMessage(status, `已暂存 ${valid.length} 个文件。可在任意设备打开「后台任务」点「继续处理暂存文件」完成压缩与入库。`);
    toast("原文件已上传到共享库，稍后可继续处理");
    loadJobs().catch(() => {});
  } catch (error) {
    operationMessage(status, `后台暂存失败：${error.message}`, true);
    toast(`后台暂存失败：${error.message}`);
  } finally { suppressCloudJob = false; setOperation(""); }
}
// A tab that closes mid-run leaves the job "running", so takeover waits out an
// idle window first: that avoids two devices compressing the same batch while
// still letting a genuinely abandoned batch resume on its own.
const STAGED_TAKEOVER_IDLE_MS = 120000;
function isStagedResumable(job, now = Date.now()) {
  if (!job || job.kind !== "staged-import") return false;
  if (!Array.isArray(job.source_keys) || !job.source_keys.length) return false;
  if (job.status === "queued") return true;
  if (job.status !== "running") return false;
  const idle = now - Date.parse(job.updated_at || "");
  return !Number.isFinite(idle) || idle > STAGED_TAKEOVER_IDLE_MS;
}
async function resumeStagedJobs() {
  if (stagedResumeBusy || state.operation) { toast("请等待当前批次处理完成"); return; }
  stagedResumeBusy = true;
  const status = $("#jobsStatus");
  try {
    const data = await api("/api/jobs");
    const queued = (data.items || []).filter(job => isStagedResumable(job));
    if (!queued.length) { operationMessage(status, "当前没有待处理的暂存文件。"); toast("没有待处理的暂存文件"); return; }
    for (const job of queued) {
      await sendCloudJobPatch({status: "running", stage: "正在读取暂存原文件"}, job.id);
      const files = [];
      for (let index = 0; index < job.source_keys.length; index++) {
        const response = await fetch(assetUrl(job.source_keys[index]));
        if (!response.ok) throw new Error(`读取暂存文件失败（${response.status}）`);
        const name = job.items?.[index] || String(job.source_keys[index]).split("/").pop();
        files.push(new File([await response.arrayBuffer()], name, {type: "application/octet-stream"}));
      }
      operationMessage(status, `正在处理「${job.title}」的 ${files.length} 个文件…`);
      resumingStaged = true;
      try { await importUnifiedFiles(files); }
      finally { resumingStaged = false; }
      // A staged batch carries the intent to process later, so finish the job
      // here instead of parking it in the review list for another click.
      let autoCommitted = 0;
      if (job.auto_commit) {
        // Parsed themes land in state.review without being ticked, so use the
        // same "everything eligible" set the 全选 button would produce.
        const pending = eligibleIds("review");
        if (pending.length) {
          operationMessage(status, `「${job.title}」已解析 ${pending.length} 个主题，正在自动压缩入库…`);
          await sendCloudJobPatch({stage: "自动确认并压缩", total: pending.length}, job.id);
          const before = state.themes.length;
          try { await commitThemes(pending); autoCommitted = Math.max(0, state.themes.length - before); }
          catch (error) { operationMessage(status, `自动压缩失败：${error.message}`, true); }
        }
      }
      await sendCloudJobPatch({status: "completed", completed: job.total,
        stage: autoCommitted ? "已自动完成压缩入库" : "已在本设备完成导入",
        result: autoCommitted ? `${autoCommitted} 个主题已自动压缩并入库`
          : files.length ? `${files.length} 个文件已导入；主题仍需在导入页确认` : "无文件"}, job.id);
      // The staged raw copies served their purpose; leaving them would keep a
      // second full copy of every theme in R2 forever.
      for (const key of job.source_keys) {
        fetch(apiUrl(key), {method: "DELETE", headers: requestHeaders()}).catch(() => {});
      }
    }
    operationMessage(status, "暂存文件已处理完成；未自动提交的主题已在导入页列出，可手动确认。");
    toast("暂存任务已处理完成");
    await loadJobs();
  } catch (error) {
    operationMessage(status, `继续处理失败：${error.message}`, true);
    toast(`继续处理失败：${error.message}`);
  } finally { resumingStaged = false; stagedResumeBusy = false; }
}
// The queue lives in shared R2, but image recompression needs a real canvas,
// so the work still runs in a browser. Landing on any device finishes a batch
// staged elsewhere instead of waiting for someone to press a button.
const AUTO_RESUME_STORAGE_KEY = "reeden-auto-resume-queue";
function autoResumeQueueEnabled() {
  try { return localStorage.getItem(AUTO_RESUME_STORAGE_KEY) !== "off"; } catch { return true; }
}
function setAutoResumeQueue(enabled) {
  try { localStorage.setItem(AUTO_RESUME_STORAGE_KEY, enabled ? "on" : "off"); } catch {}
}
async function autoResumeStagedQueue() {
  if (!autoResumeQueueEnabled() || !browserSyncEnabled() || !syncToken) return;
  if (stagedResumeBusy || state.operation) return;
  const queued = (state.jobs || []).filter(job => isStagedResumable(job));
  if (!queued.length) return;
  operationMessage($("#jobsStatus"), `检测到 ${queued.length} 个云端排队批次，正在自动继续处理…`);
  toast(`云端有 ${queued.length} 个排队批次，已自动继续`);
  await resumeStagedJobs();
}
async function clearFinishedJobs() {
  if (state.operation) return;
  try {
    const data = await api("/api/jobs");
    const finished = (data.items || []).filter(job => !["queued", "running"].includes(job.status));
    for (const job of finished) {
      await fetch(apiUrl(`/api/jobs/${encodeURIComponent(job.id)}`), {method: "DELETE", headers: requestHeaders()});
    }
    toast(`已清除 ${finished.length} 条已完成任务`);
    await loadJobs();
  } catch (error) { toast(`清理失败：${error.message}`); }
}
async function importUnifiedFiles(fileList) {
  if (state.operation) { toast("请等待当前批次处理完成"); return; }
  if (!resumingStaged && $("#queueForLater")?.checked) { await queueFilesForLater(fileList); return; }
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
$("#themeSearchInput").addEventListener("input", event => { state.themeSearch = event.target.value; renderThemes(); });
$("#themeAuthorFilter").addEventListener("change", event => { state.themeAuthor = event.target.value || "all"; renderThemes(); });
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
$("#deleteSelectedTheme").addEventListener("click", () => deleteSelectedRecords("theme"));
$("#deleteSelectedFont").addEventListener("click", () => deleteSelectedRecords("font"));
$("#deleteSelectedAsset").addEventListener("click", () => deleteSelectedRecords("asset"));
$("#downloadSelectedTheme").addEventListener("click", () => downloadSelectedRecords("theme"));
$("#downloadSelectedFont").addEventListener("click", () => downloadSelectedRecords("font"));
$("#downloadSelectedAsset").addEventListener("click", () => downloadSelectedRecords("asset"));
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
$("#resumeStagedJobs").addEventListener("click", () => resumeStagedJobs());
$$("input[name='compressionPreset']").forEach(input => input.addEventListener("change", () => { syncCompressionControls(); updateBulkControls(); }));
$$("input[name='compressionCodec']").forEach(input => input.addEventListener("change", () => { syncCompressionControls(); updateBulkControls(); }));
["#compressionQuality", "#compressionMaxEdge", "#compressionGifColors", "#compressionReader", "#compressionIconLossless"].forEach(selector => {
  const input = $(selector);
  if (!input) return;
  const event = input.tagName === "SELECT" || input.type === "checkbox" ? "change" : "input";
  input.addEventListener(event, () => { if (selectedCompressionPreset() === "custom") { syncCompressionControls(); updateBulkControls(); } });
});
[["#compressionQualityDown", -1], ["#compressionQualityUp", 1]].forEach(([selector, delta]) => {
  const button = $(selector);
  if (!button) return;
  button.addEventListener("click", () => {
    const range = $("#compressionQuality");
    if (!range) return;
    const next = Math.min(Number(range.max) || 100, Math.max(Number(range.min) || 1, (Number(range.value) || 95) + delta));
    range.value = String(next);
    syncCompressionControls();
    if (selectedCompressionPreset() === "custom") updateBulkControls();
  });
});
const autoResumeBox = $("#autoResumeQueue");
if (autoResumeBox) {
  autoResumeBox.checked = autoResumeQueueEnabled();
  autoResumeBox.addEventListener("change", () => {
    setAutoResumeQueue(autoResumeBox.checked);
    toast(autoResumeBox.checked ? "已开启：打开页面时自动继续排队批次" : "已关闭：只在你点按钮时继续排队批次");
  });
}
$("#clearFinishedJobs").addEventListener("click", () => clearFinishedJobs());
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
(() => {
  const config = pan123BackupConfig();
  $("#pan123BackupToken").value = config.token;
  $("#pan123BackupFolder").value = config.folder;
  if (config.token) operationMessage($("#pan123BackupStatus"), "已保存 123 云盘会话 Token；点击「测试连接」可验证会话是否仍然有效。");
})();
$("#savePan123Backup").addEventListener("click", () => {
  const token = String($("#pan123BackupToken").value || "").trim();
  const folder = String($("#pan123BackupFolder").value || "").trim() || "Red-Garden-Backup";
  try {
    localStorage.setItem(PAN123_TOKEN_STORAGE_KEY, token);
    localStorage.setItem(PAN123_FOLDER_STORAGE_KEY, folder);
    if (token) {
      toast("123 云盘设置已保存，正在验证连接");
      verifyPan123Backup();
    } else {
      operationMessage($("#pan123BackupStatus"), "会话 Token 为空，当前只保留 R2 原包。");
      toast("123 云盘备份已关闭");
    }
  } catch { operationMessage($("#pan123BackupStatus"), "当前浏览器无法保存设置，请检查隐私模式设置。", true); }
});
$("#verifyPan123Backup").addEventListener("click", () => { verifyPan123Backup(); });
$("#listPan123Backup").addEventListener("click", () => { refreshPan123BackupList(); });
$("#verifyPan123Write").addEventListener("click", () => { verifyPan123Write(); });
$("#clearPan123Backup").addEventListener("click", () => {
  try { localStorage.removeItem(PAN123_TOKEN_STORAGE_KEY); } catch {}
  $("#pan123BackupToken").value = "";
  operationMessage($("#pan123BackupStatus"), "已关闭 123 云盘备份，原包仍会存入 R2。");
});
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
  if (options && Number.isInteger(options.max_edge) && options.max_edge >= 0 && options.max_edge <= 8192) {
    const select = $("#compressionMaxEdge");
    if (select) {
      const value = String(options.max_edge);
      select.value = [...select.options].some(option => option.value === value) ? value : select.options[0].value;
    }
  }
  if (options?.codec) {
    const codec = document.querySelector(`input[name='compressionCodec'][value='${options.codec === "png" ? "png" : "webp"}']`);
    if (codec) codec.checked = true;
  }
  if (options && Number.isInteger(options.gif_colors)) {
    const select = $("#compressionGifColors");
    if (select) {
      const value = String(options.gif_colors);
      select.value = [...select.options].some(option => option.value === value) ? value : "0";
    }
  }
  if (options && typeof options.icon_lossless === "boolean" && $("#compressionIconLossless")) $("#compressionIconLossless").checked = options.icon_lossless;
  if (options && typeof options.compress_reader === "boolean" && $("#compressionReader")) $("#compressionReader").checked = options.compress_reader;
  if (options && COMPRESSION_PRESET_LABELS[options.preset]) {
    const radio = document.querySelector(`input[name='compressionPreset'][value='${options.preset}']`);
    if (radio) radio.checked = true;
  }
} catch {}
syncCompressionControls();
setView(viewNames[initialView] ? initialView : "import");
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (viewNames[view]) setView(view);
});
loadLibraryAfterConnection().then(() => autoResumeStagedQueue().catch(() => {})).catch(() => {});
