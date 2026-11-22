const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
// GitHub Pages mode can point this static UI at a separate sync API without
// putting any R2 credential in the browser. The local Python service remains
// the default when no API base is configured.
const API_BASE_STORAGE_KEY = "reeden-api-base";
const FALLBACK_API_BASE = "https://red-garden-sync.pages.dev";
const SYNC_TOKEN_STORAGE_KEY = "reeden-sync-write-token";
async function configCryptoKey(password, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256"}, material, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
}
let pendingConnectConfig;
let connectionDirty=false;
let connectionSaving=false;
async function transferDeviceConfig(event) {
  event.preventDefault();
  const form = event.currentTarget, status = $("#deviceTransferStatus");
  const password = form.elements.passphrase.value;
  if (password.length < 8) { operationMessage(status, "请输入至少 8 位的迁移口令，两台设备使用相同口令。", true); return; }
  const action = event.submitter?.value||($('[data-transfer-direction][aria-pressed="true"]')?.dataset.transferDirection==='import'?'import':'link');
  const buttons = [...form.querySelectorAll("button")];
  buttons.forEach(button => { button.disabled = true; });
  try {
    if (["export","cloud-save","link"].includes(action)) {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
      const config = {apiBase, syncToken, pan123: form.elements.include123.checked ? pan123BackupConfig() : null,backup123Enabled:form.elements.include123.checked&&pan123BackupEnabled()};
      const key = await configCryptoKey(password, salt);
      const cipher = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, new TextEncoder().encode(JSON.stringify(config)));
      const file = {format: "reeden-device-v1", salt: base64Bytes(salt), iv: base64Bytes(iv), cipher: base64Bytes(new Uint8Array(cipher))};
      if(action==='cloud-save') {
        await ensureWriteAccess();await api('/api/device-config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(file)});
        operationMessage(status,'加密配置已保存到私有库。新设备可先用接入链接连接，再读取最新配置。');
      } else if(action==='link') {
        const link=new URL(location.href);link.hash='connect='+base64Bytes(new TextEncoder().encode(JSON.stringify(file))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
        if(link.href.length>16000)throw new Error('配置较大，请改用加密文件导出');
        $('#deviceConnectLink').value=link.href;$('#deviceLinkLabel').hidden=false;
        operationMessage(status,'接入链接已生成。把链接和迁移口令分开传到新设备，打开后输入口令导入。');
      } else {
        const url=URL.createObjectURL(new Blob([JSON.stringify(file)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='reeden-device.encrypted.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        operationMessage(status,'已导出加密配置。新设备导入时输入相同迁移口令。');
      }
    } else {
      let data=pendingConnectConfig;
      if(action==='cloud-load') {await ensureWriteAccess();data=await api('/api/device-config');}
      if(!data){const file=form.elements.configFile.files[0];if(!file||file.size>262144)throw new Error('请选择本站导出的加密配置（不超过 256 KB）');data=JSON.parse(await file.text());}
      if(data.format!=='reeden-device-v1')throw new Error('不是本站的加密配置');
      const key = await configCryptoKey(password, bytesFromBase64(data.salt));
      let plain;
      try { plain = await crypto.subtle.decrypt({name: "AES-GCM", iv: bytesFromBase64(data.iv)}, key, bytesFromBase64(data.cipher)); }
      catch { throw new Error("迁移口令不正确或文件已损坏，现有配置未改动"); }
      const config = JSON.parse(new TextDecoder().decode(plain));
      const base = normalizeApiBase(config.apiBase);
      if (!base || typeof config.syncToken !== "string") throw new Error("配置中的同步地址或 Token 无效");
      localStorage.setItem(API_BASE_STORAGE_KEY, base);
      localStorage.setItem(SYNC_TOKEN_STORAGE_KEY, config.syncToken);
      if (config.pan123) {
        localStorage.setItem(PAN123_TOKEN_STORAGE_KEY, normalizePan123Token(config.pan123.token));
        setBackup123Enabled(config.backup123Enabled!==false);
        localStorage.setItem(PAN123_FOLDER_STORAGE_KEY, String(config.pan123.folder || "Red-Garden-Backup"));
      }
      pendingConnectConfig=null; privateReadTicket="";connectionDirty=false;
      apiBase = base; syncToken = config.syncToken; remoteUnavailable = false; storageReady = false;
      state.storage = null; browserLibraryRecordsCache = undefined; jobsSnapshotAt = 0;
      state.themes = []; state.fonts = []; state.assets = []; state.jobs = [];
      const pan = pan123BackupConfig();
      $("#pan123BackupToken").value = pan.token; $("#pan123BackupFolder").value = pan.folder;
      updateRuntimeMode();
      refreshSettingsControls();$('#connectionDetails').open=false;
      operationMessage(status, "配置已导入。正在读取这台设备的资源库；123 会话是否有效可单独测试。");
      await loadLibraryAfterConnection();
    }
  } catch (error) { operationMessage(status, error.message, true); }
  finally { form.elements.passphrase.value = ""; buttons.forEach(button => { button.disabled = false; });setTransferDirection($('[data-transfer-direction][aria-pressed="true"]')?.dataset.transferDirection||'import'); }
}
function normalizeApiBase(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  try {
    const url = new URL(text, window.location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) return "";
    return url.href.replace(/\/$/, "");
  } catch { return ""; }
}
let apiBase = normalizeApiBase((() => {
  try {
    const saved = localStorage.getItem(API_BASE_STORAGE_KEY) || "";
    return saved.includes("reeden-library-sync.773541521.workers.dev") ? FALLBACK_API_BASE : saved;
  } catch { return ""; }
})() || window.REEDEN_API_BASE);
let syncToken = (() => { try { return localStorage.getItem(SYNC_TOKEN_STORAGE_KEY) || ""; } catch { return ""; } })();
let remoteUnavailable = false;
let freeCodecModule;
// Device-local codec. free_codec.js implements ZIP parsing, image re-encoding
// and font inspection; free_codec_worker.js runs the CPU-heavy work in a Web
// Worker pool. Encrypted RED manifests are re-sealed by the sync Worker.
async function loadFreeCodec() {
  await window.loadReedenVendor?.("omggif.js");
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
let privateReadTicket='',privateReadTicketUntil=0;
function assetUrl(path) {
  if(!path)return '';
  const value=apiUrl(path);
  if(privateReadTicket && value.startsWith(apiBase+'/api/') && /\/api\/(objects\/|download)/.test(value)) {
    const url=new URL(value);url.searchParams.set('access',privateReadTicket);return url.href;
  }
  return value;
}
// A plain object GET is meant for inline previews. Download links need the
// Worker to send Content-Disposition, otherwise an Android WebView treats the
// cross-origin href as navigation (and the app blocks it as "leaving" the
// site). `download=1` keeps one object key but changes the response headers.
// The readable file name travels in `name=` as well: Android's DownloadManager
// only understands the ASCII part of Content-Disposition, so a Chinese theme
// name would otherwise be saved as underscores.
function downloadUrl(path, name = "") {
  const source = String(path || "");
  if (!source) return "";
  const url = assetUrl(source);
  if (/^https?:/i.test(url) && /\/api\/objects\//i.test(url) && !/[?&]download=1(?:&|$)/i.test(url)) {
    let file = "";
    try {
      const marker = url.indexOf("/api/objects/");
      const rest = url.slice(marker + "/api/objects/".length).split(/[?#]/)[0];
      const parts = rest.split("/");
      file = decodeURIComponent(parts[parts.length - 1] || "");
    } catch { file = ""; }
    file = String(name || file);
    let safe = file.replace(/[\\/:*?"<>|\r\n]/g, "_");
    const extension = safe.match(/\.[a-z\d]{1,8}$/i)?.[0] || "";
    if (safe.length > 120) safe = safe.slice(0, 120 - extension.length) + extension;
    return `${url}${url.includes("?") ? "&" : "?"}download=1&name=${encodeURIComponent(safe)}`;
  }
  return url;
}
function updateRuntimeMode() {
  const label = $("#runtimeModeLabel");
  const modeText = remoteUnavailable ? "本地浏览器处理模式" : apiBase ? "设备同步模式 · R2 API" : staticHostedWithoutApi() ? "等待连接同步 Worker" : "本地处理模式";
  if (label) label.textContent = modeText;
  if ($("#moreRuntimeMode")) $("#moreRuntimeMode").textContent = modeText;
  const note = $("#staticModeNote");
  if (note) {
    note.hidden = !apiBase && !remoteUnavailable && !staticHostedWithoutApi();
    note.textContent = staticHostedWithoutApi()
      ? "当前 APK/静态网页没有本机后端。请在“设置 → 资源库连接”填写 Cloudflare Worker 地址和同步 Token 后，手机与电脑才会共用 R2。"
      : remoteUnavailable
      ? (freeCodecReady() ? "同步 API 暂时不可用，已切换为本地浏览器处理模式。处理结果会在 API 恢复后同步；页面关闭会暂停本地任务。" : "同步 API 不可用；本地浏览器处理器尚未加载，未执行压缩或上传。请检查同步 API 地址与网络后重试；压缩本身在当前设备完成，不需要电脑。")
      : "当前为多设备同步模式：手机和电脑共用同一个 API 与 R2。压缩和重新封包在当前设备浏览器中进行，页面关闭后处理会暂停。";
  }
  const input = $("#apiBaseInput");
  if (input && !connectionDirty && document.activeElement !== input) input.value = apiBase;
  const tokenInput = $("#syncTokenInput");
  if (tokenInput && !connectionDirty && document.activeElement !== tokenInput) tokenInput.value = syncToken;
}
function markRemoteUnavailable(reason = "") {
  if (!apiBase) return;
  remoteUnavailable = true;
  updateRuntimeMode();
  const status = $("#apiBaseStatus");
  if (status && reason) operationMessage(status, `同步 API 不可用：${reason}。未执行压缩或上传。`, true);
}
async function saveApiBaseSetting() {
  if(connectionSaving)return;
  if (state.operation) { toast("请等待当前操作完成再切换连接"); return; }
  const input = $("#apiBaseInput");
  const value = String(input?.value || "").trim();
  if (value && !normalizeApiBase(value)) {
    operationMessage($("#apiBaseStatus"), "请输入完整的 HTTP 或 HTTPS API 地址，不要带路径、查询参数或片段。", true);
    return;
  }
  const oldBase = apiBase;
  if (!value && apiBase && location.hostname.endsWith(".pages.dev")) { operationMessage($("#apiBaseStatus"), "当前站点已内置 R2 接口，无需清除地址。", true); return; }
  const nextBase=normalizeApiBase(value),nextToken=String($("#syncTokenInput")?.value || "").trim();
  try {
    if (nextBase) localStorage.setItem(API_BASE_STORAGE_KEY, nextBase);
    else localStorage.removeItem(API_BASE_STORAGE_KEY);
    if (nextBase && nextToken) localStorage.setItem(SYNC_TOKEN_STORAGE_KEY, nextToken);
    else localStorage.removeItem(SYNC_TOKEN_STORAGE_KEY);
  } catch { operationMessage($("#apiBaseStatus"), "浏览器未允许保存设置，关闭页面后配置可能丢失。请允许网站存储。", true); return; }
  apiBase=nextBase;syncToken=nextToken;remoteUnavailable=false;connectionDirty=false;
  updateRuntimeMode();
  // 同步地址刚保存完，表单里没有待保存的改动，上传不该再被拦住。
  if ($("#storageForm").hidden) storageDirty = false;
  // The previous library may belong to another API; never reuse its cached
  // records after the address changes.
  if (oldBase !== apiBase) {
    browserLibraryRecordsCache = undefined;
    state.themes = []; state.fonts = []; state.assets = []; state.jobs = []; jobsSnapshotAt = 0;
    state.storage = null;
    storageReady = false;
  }
  operationMessage($("#apiBaseStatus"), apiBase ? "已保存同步地址。正在读取共享库…" : "已清除同步地址，当前在本机浏览器内处理。");
  connectionSaving=true;$('#saveApiBase').disabled=true;
  try{await loadLibraryAfterConnection({fromSave:true});}finally{connectionSaving=false;refreshSettingsControls();}
}
let libraryLoadGeneration = 0;
let libraryStarted = false;
function librarySummary() {
  return `${state.themes.length} 个主题、${state.fonts.length} 个字体、${state.assets.length} 个收藏`;
}
// One loader for both startup and "保存同步地址". Every stage writes a visible
// status, including the success case, so the settings panel can never stay on
// an endless "正在读取共享库…" after the requests have already finished.
// 阅读主题（RED\x01 阅读配色 / 高亮方案）以前和「应用主题」混在主题库里，
// 但它只改阅读页、没有书架和启动图。这里在读完共享库后原地迁移：先写一条
// 收藏记录复用同一个原包对象，再从主题库删掉旧记录；删失败就保留原样重试。
async function migrateReaderThemesToAssets() {
  if (!browserSyncEnabled() || state.operation) return;
  // 只认 RED\x01 容器：阅读配色 / 高亮方案都是这个封装。光看
  // preview_details.kind==="reader" 会把加密应用主题误搬走（它们的目录是密文，
  // 角色识别失败时预览会退化成 reader）。
  const readers = state.themes.filter(theme => String(theme.container_format || "") === "red_v1_gzip");
  if (!readers.length) return;
  const codec = await browserCodec(), migrated = [];
  for (const theme of readers) {
    const sha = String(theme.original_sha256 || theme.sha256 || "");
    // compressed_url / original_url 是 R2 对象键；library_url 有时是聚合下载
    // 地址，放在最后兜底，否则 Worker 会因「关联文件不存在」拒绝写记录。
    const sourceUrl = String(theme.compressed_url || theme.original_url || theme.library_url || "");
    if (!sha || !sourceUrl) continue;
    const category = theme.preview_details?.kind === "highlight" ? "高亮" : "阅读主题";
    const existing = state.assets.find(asset => [asset.sha256, asset.original_sha256].includes(sha));
    if (!existing) {
      try {
        const record = {
          kind: "asset", id: `asset-${sha.slice(0, 16)}`, asset_type: "red", extension: "red",
          category, red_category: category, preview_kind: theme.preview_details?.kind || "reader",
          file_name: theme.file_name || `${theme.name || category}.red`, name: theme.name || "", author: theme.author || "", style: theme.style || "", tags: theme.tags || [],
          sha256: sha, original_sha256: sha, bytes: theme.bytes || 0, mime: "application/octet-stream",
          container_format: theme.container_format || "red_v1_gzip", compression_supported: false,
          object_url: sourceUrl, url: sourceUrl,
          preview_url: theme.preview_light_url || theme.preview_dark_url || "",
          saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: ""
        };
        const bytes = new TextEncoder().encode(JSON.stringify(record));
        record.record_sha256 = await codec.sha256Hex(bytes);
        record.updated_at = record.imported_at = new Date().toISOString();
        record.created_at = theme.created_at || record.updated_at;
        await uploadBrowserObject("records", record.record_sha256, "json", bytes, "application/json", "", record);
        state.assets.unshift(record);
      } catch (error) {
        // 原包已不在 R2（例如只在 123 备份）时跳过这一条，别挡住其他迁移。
        console.warn("阅读主题迁移：写收藏记录失败", theme.name, error);
        continue;
      }
    }
    migrated.push(theme);
  }
  if (!migrated.length) return;
  try {
    await api("/api/library", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: migrated.map(theme => ({ kind: "theme", id: theme.id })) }) });
  } catch (error) { console.warn("阅读主题迁移：删除旧记录失败", error); return; }
  const ids = new Set(migrated.map(theme => String(theme.id)));
  ids.forEach(id => retiredThemeIds.add(id));
  state.themes = state.themes.filter(theme => !ids.has(String(theme.id)));
  browserLibraryRecordsCache = latestRecords([...state.themes, ...state.fonts, ...state.assets]);
  saveDeviceSnapshot();
  renderThemes(); renderAssets();
  toast(`已把 ${migrated.length} 个阅读主题移到收藏库`);
}
// 上一版把「加密应用主题」误判成阅读主题搬进了收藏库：它们的目录是密文，
// 角色识别失败时 preview_details.kind 会退化成 reader，自动分类也写成阅读主题。
// 回迁时不信记录上的字段，直接读原包前 16 字节看容器头：只有 RED\x01 才是
// 真正的阅读配色 / 高亮方案，其余（加密主题、普通 ZIP 主题、封面图集）都搬回
// 主题库，并清掉错误的「阅读主题」标签。
async function objectContentLength(path) {
  if (!path) return 0;
  try {
    const response = await transferFetch(apiUrl(path), { method: "HEAD", headers: requestHeaders() });
    const length = Number(response.headers.get("Content-Length"));
    return response.ok && Number.isFinite(length) && length > 0 ? length : 0;
  } catch { return 0; }
}
// 只用 Range 取头部 16 字节，返回 RED 容器类型字节（1/2/4/16），读不到返回 0。
async function objectRedContainer(path) {
  if (!path) return 0;
  try {
    const response = await transferFetch(assetUrl(path), { headers: { ...requestHeaders(), Range: "bytes=0-15" } });
    if (!response.ok) return 0;
    const head = new Uint8Array(await response.arrayBuffer());
    if (head.length < 4 || head[0] !== 82 || head[1] !== 69 || head[2] !== 68) return 0;
    return head[3];
  } catch { return 0; }
}
const RED_CONTAINER_FORMAT = { 2: "red_v2_gallery", 4: "red_v4", 16: "red_private_v2" };
async function restoreMisclassifiedThemeAssets() {
  if (!browserSyncEnabled() || state.operation) return;
  const candidates = state.assets.filter(asset => asset.asset_type === "red" && assetRedCategory(asset) === "阅读主题");
  if (!candidates.length) return;
  const wrong = [];
  for (const asset of candidates) {
    const sourceUrl = String(asset.object_url || asset.url || "");
    if (!sourceUrl) continue;
    const container = await objectRedContainer(sourceUrl);
    // 读不到头（对象在 123 备份里 / 网络失败）时退回记录上的容器字段。
    const fallbackContainer = String(asset.container_format || "");
    const isReader = container ? container === 1 : fallbackContainer === "red_v1_gzip";
    if (!isReader) wrong.push({ asset, sourceUrl, container });
  }
  if (!wrong.length) return;
  const codec = await browserCodec(), restored = [];
  for (const { asset, sourceUrl, container } of wrong) {
    const sha = String(asset.original_sha256 || asset.sha256 || "");
    if (!sha) continue;
    if (state.themes.some(theme => [theme.sha256, theme.original_sha256].includes(sha))) { restored.push(asset); continue; }
    try {
      const containerFormat = RED_CONTAINER_FORMAT[container] || String(asset.container_format || "red_private_v2");
      const record = {
        kind: "theme", id: `theme-${sha.slice(0, 16)}`,
        name: asset.name || "", author: asset.author || "", style: asset.style || "",
        file_name: asset.file_name || asset.source_file_name || "", source_file_name: asset.source_file_name || asset.file_name || "",
        sha256: sha, original_sha256: sha, bytes: Number(asset.bytes) || await objectContentLength(sourceUrl), mime: "application/octet-stream",
        container_format: containerFormat, compression_supported: containerFormat === "red_v4",
        preview_light_url: asset.preview_url || "", preview_dark_url: "",
        preview_details: { kind: "shelf_and_reader", simulation: true, encrypted_source: containerFormat === "red_private_v2" },
        categories: [], auto_categories: [], tags: Array.isArray(asset.tags) ? asset.tags : [],
        compressed_url: sourceUrl, original_url: sourceUrl, library_url: sourceUrl,
        object_url: sourceUrl, url: sourceUrl,
        saved_to_cloud: true, cloud: asset.cloud || "cloudflare_r2", sync_status: { library: "synced" }, sync_error: ""
      };
      const bytes = new TextEncoder().encode(JSON.stringify(record));
      record.record_sha256 = await codec.sha256Hex(bytes);
      record.updated_at = record.imported_at = new Date().toISOString();
      record.created_at = asset.created_at || record.updated_at;
      await uploadBrowserObject("records", record.record_sha256, "json", bytes, "application/json", "", record);
      state.themes.unshift(record);
      restored.push(asset);
    } catch (error) {
      console.warn("应用主题回迁失败", asset.name, error);
    }
  }
  if (!restored.length) return;
  try {
    await api("/api/library", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: restored.map(asset => ({ kind: "asset", id: asset.id })) }) });
  } catch (error) { console.warn("应用主题回迁：删除收藏记录失败", error); return; }
  const ids = new Set(restored.map(asset => String(asset.id)));
  ids.forEach(id => retiredAssetIds.add(id));
  state.assets = state.assets.filter(asset => !ids.has(String(asset.id)));
  browserLibraryRecordsCache = latestRecords([...state.themes, ...state.fonts, ...state.assets]);
  saveDeviceSnapshot();
  renderThemes(); renderAssets();
  toast(`已把 ${restored.length} 个应用主题移回主题库`);
}
async function loadLibraryAfterConnection({fromSave = false} = {}) {
  const generation = ++libraryLoadGeneration;
  const remote = Boolean(apiBase);
  const current = () => generation === libraryLoadGeneration;
  const status = (text, failed = false) => {
    if (remote) operationMessage($("#apiBaseStatus"), text, failed);
  };
  if (remote) status(fromSave ? "已保存同步地址。正在读取共享库（1/3 存储配置）…" : "正在读取共享库（1/3 存储配置）…");
  try {
    if(apiBase)await ensureWriteAccess();
    await restoreDeviceCache();
    if (state.storage?.mode === "browser-local" && Array.isArray(browserLibraryRecordsCache)) {
      storageReady = true;
      renderStorageSummary(state.storage);
      state.themes = browserLibraryRecordsCache.filter(item => item.kind === "theme");
      state.fonts = browserLibraryRecordsCache.filter(item => item.kind === "font");
      state.assets = browserLibraryRecordsCache.filter(item => item.kind === "asset");
      renderThemes(); renderFonts(); renderAssets();
    }
    await loadStorage();
    if (!current()) return;
    libraryStarted = true;
    status("正在读取共享库（2/3 记录清单）…");
    await Promise.all([loadThemes(), loadFonts(), loadAssets(), ...(browserSyncEnabled() ? [] : [loadPendingThemes()])]);
    if (!current()) return;
    status("正在读取共享库（3/3 任务进度）…");
    if (state.activeView === "jobs" || activeJobs().length || (autoResumeQueueEnabled() && (!jobsSnapshotAt || Date.now() - jobsSnapshotAt > 300000))) await loadJobs();
    else renderJobs();
    if (!current()) return;
    const jobsFailed = Boolean($("#jobsStatus")?.classList.contains("is-error"));
    if (remote) {
      status(`已连接共享库：${librarySummary()}。${jobsFailed ? "任务读取失败，请在任务页重试。" : ""}`, jobsFailed);
    } else {
      toast(`已读取本机库：${librarySummary()}`);
    }
    if (remote) {
      // 先回迁被误判的应用主题，再把真正的阅读主题搬进收藏库，顺序不能反。
      try { await restoreMisclassifiedThemeAssets(); } catch (error) { console.warn("应用主题回迁失败", error); }
      try { await migrateReaderThemesToAssets(); } catch (error) { console.warn("阅读主题迁移失败", error); }
    }
    refreshSettingsControls();
  } catch (error) {
    if (!current()) return;
    for (const kind of Object.keys(libraryKinds)) {
      const output = $(`[data-library-status="${kind}"]`);
      if (!output.hidden) {
        catalogStatus(kind, `读取失败：${error.message}。可点刷新重试。`, true);
        $(`#${kind}Count`).textContent = "读取失败";
      }
    }
    if (remote) {status(`连接共享库失败：${error.message}`, true);$('#connectionDetails').open=true;}
    else toast(`读取本机库失败：${error.message}`);
  }
}
let writeAccess = {base: "", token: "", at: 0};
async function ensureRecordReference(record) {
  if (record.record_sha256 || !browserSyncEnabled()) return;
  const records = await loadBrowserLibraryRecords(true);
  for (const kind of ["theme", "font", "asset"]) {
    const fresh = new Map(records.filter(item => item.kind === kind).map(item => [item.id, item]));
    for (const item of state[kind + "s"]) if (fresh.has(item.id)) Object.assign(item, fresh.get(item.id));
  }
}
async function ensureWriteAccess() {
  if (!apiBase) return true;
  if (writeAccess.base === apiBase && writeAccess.token === syncToken && Date.now() - writeAccess.at < 300000 && privateReadTicketUntil>Date.now()+60000) return true;
  const response = await fetchWithReadTimeout(apiUrl("/api/session"), {headers: requestHeaders()}, 10000);
  if (response.status === 404) return true; // compatible with previous Worker
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.canWrite) {
    const message = syncToken ? "此设备的访问口令无效。请从已连接设备生成接入链接或导出加密配置。" : "此设备尚未连接私有库。请打开接入链接并输入迁移口令，或在设置导入加密配置。";
    operationMessage($("#apiBaseStatus"), message, true);$('#connectionDetails').open=true;
    toast(message);
    throw new Error(message);
  }
  privateReadTicket=data.ticket||'';privateReadTicketUntil=data.expires||Date.now()+300000;
  writeAccess = {base: apiBase, token: syncToken, at: Date.now()};
  operationMessage($("#apiBaseStatus"), "写入权限有效；当前设备已连接共享 R2。");
  return true;
}
function requestHeaders(headers = {}) {
  const result = new Headers(headers);
  if (apiBase && syncToken) result.set("Authorization", `Bearer ${syncToken}`);
  return result;
}
const THEME_PAGE_SIZE = 24;
const state = { themes: [], fonts: [], assets: [], review: [], pending: [], jobs: [], activeView: "themes", themeDensity: "grid", importKind: "theme", themeSearch: "", themeAuthor: "all", themeCategory: "all", assetFilter: "all", assetSearch: "", fontSearch: "", fontFilter: "all", storage: null, operation: "", importFontIds: readSessionIds("reeden-import-fonts"), importThemeJobIds: readSessionIds("reeden-import-theme-jobs"), importAssetIds: readSessionIds("reeden-import-assets") };
const selectionModes = {theme:false,font:false,asset:false};
const selections = { review: new Set(), theme: new Set(), font: new Set(), asset: new Set() };
// 已经迁移到收藏库的阅读主题 id。并发加载时旧快照可能晚到，这里再挡一次，
// 避免主题库刚清空又被旧数据填回来。
const retiredThemeIds = new Set();
// 反方向：被误迁进收藏库的应用主题。删完记录后旧快照可能晚到，这里同样再挡一次。
const retiredAssetIds = new Set();
// 本地服务模式下「确认上传」是提交后台任务；记住这批 job id，轮询回来时把
// 进度写进用户眼前那条进度条，而不是让用户只看见一句「已加入后台」。
const trackedJobIds = new Set();
const loadedFontFaces = new Set();
// 大字体 load() 可能要几秒，期间每次渲染都会再建一个 FontFace 并重复下载。
// 同步占位 + 失败负缓存：同一 id 全程只加载一次，失败也不在每次渲染时重试。
const loadingFontFaces = new Set();
const failedFontFaces = new Set();
// OTS 拒收的字体改用 opentype 描边样张，缓存结果避免重复拉取同一个大文件。
const outlinedSpecimenFaces = new Map();
const recentUploadIds = new Set();
const recentOnly = {theme: false, font: false, asset: false};
// 启动时先用本机快照恢复存储配置与库记录，这样刷新后按钮状态、已保存的
// R2/123 设置立即就是对的，不会闪出「尚未配置」让人以为又要重存一次。
function deviceDB() {
  if (!deviceDatabase) deviceDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open("reeden-device-v2", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("缓存数据库被其他页面占用"));
  });
  return deviceDatabase;
}
async function readDeviceSnapshot() {
  const db = await deviceDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction("snapshots").objectStore("snapshots").get(apiBase || "local");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function saveDeviceSnapshot() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    const scope = apiBase || "local";
    const snapshot = structuredClone({records: browserLibraryRecordsCache, at: browserLibraryRecordsLoadedAt, storage: state.storage, jobs: state.jobs, jobsAt: jobsSnapshotAt});
    deviceWriteQueue = deviceWriteQueue.catch(() => {}).then(async () => {
      const db = await deviceDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("snapshots", "readwrite");
        tx.objectStore("snapshots").put(snapshot, scope);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }).catch(() => {
      try {
        localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify({apiBase, at: snapshot.at, records: snapshot.records}));
      } catch { cachePersistent = false; }
      updateCacheInfo();
    });
  }, 0);
}
async function restoreDeviceCache() {
  try {
    const saved = await readDeviceSnapshot();
    if (saved) {
      if (Array.isArray(saved.records)) {
        browserLibraryRecordsCache = latestRecords(saved.records);
        browserLibraryRecordsLoadedAt = saved.at || 0;
      }
      if (saved.storage) state.storage = saved.storage;
      if (Array.isArray(saved.jobs)) { state.jobs = saved.jobs; jobsSnapshotAt = saved.jobsAt || 0; }
    }
  } catch { cachePersistent = false; }
  updateCacheInfo();
}
function updateCacheInfo() {
  const time = browserLibraryRecordsLoadedAt ? new Date(browserLibraryRecordsLoadedAt).toLocaleString("zh-CN") : "";
  $$("[data-cache-info]").forEach(el => {
    el.textContent = !cachePersistent ? "本地缓存不可用；请检查浏览器的存储权限。"
      : time ? `本机缓存 · ${time} 更新 · 其他设备有新增时点刷新`
      : "首次连接将读取云端清单，之后优先使用本机缓存。";
  });
}
function updateCachedRecord(record) {
  const current = browserLibraryRecordsCache || [...state.themes, ...state.fonts, ...state.assets];
  browserLibraryRecordsCache = latestRecords([...current.filter(item => !(item.kind === record.kind && item.id === record.id)), record]);
  if (!browserLibraryRecordsLoadedAt) browserLibraryRecordsLoadedAt = Date.now();
  saveDeviceSnapshot();
  updateCacheInfo();
}
function hydrateLocalSnapshots() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_SNAPSHOT_KEY) || "null");
    if (saved && saved.data && saved.at && (!saved.apiBase || saved.apiBase === apiBase)) state.storage = saved.data;
  } catch {}
  try {
    const saved = JSON.parse(localStorage.getItem(LIBRARY_CACHE_KEY) || "null");
    if (saved && saved.at && (saved.apiBase === apiBase || (!saved.apiBase && !localStorage.getItem(API_BASE_STORAGE_KEY))) && Array.isArray(saved.records)) {
      browserLibraryRecordsCache = latestRecords(saved.records);
      browserLibraryRecordsLoadedAt = saved.at;
    }
  } catch {}
}
const BROWSER_TASK_CONCURRENCY = 3;
const BROWSER_RECORD_CACHE_TTL = 15000;
let browserLibraryRecordsCache;
let browserLibraryRecordsPromise;
let browserLibraryRecordsLoadedAt = 0;
// 刷新/重新打开页面时先用本机快照渲染，避免每次开网页都重新列一遍 R2 记录。
// 写入后会主动清掉快照，所以多设备之间仍以「手动刷新」为准。
const STORAGE_SNAPSHOT_KEY = "reeden-storage-snapshot-v1";
const LIBRARY_CACHE_KEY = "reeden-library-records-v1";
const LIBRARY_CACHE_TTL = 30 * 60 * 1000;
let storageDirty = false;
// /api/storage 至少成功读过一次。之前刷新完页面、配置还没读回来时，
// browserSyncEnabled() 会是 false，于是上传被当成「本机后端」发到同步 Worker，
// 直接 404 —— 用户只能手动再保存一次设置才恢复。这里记住读取状态，
// 需要判断同步模式时先等它回来。
let storageReady = false;
let storageReadyPromise = null;
let jobsSnapshotAt = 0;
let cachePersistent = true;
let cacheSaveTimer;
let deviceDatabase;
let deviceWriteQueue = Promise.resolve();
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
  try { localStorage.removeItem(LIBRARY_CACHE_KEY); } catch {}
}
function readSessionIds(key) {
  try { const value = JSON.parse(sessionStorage.getItem(key) || "[]"); return Array.isArray(value) ? value.filter(id => typeof id === "string") : []; }
  catch { return []; }
}
function saveSessionIds(key, ids) { try { sessionStorage.setItem(key, JSON.stringify(ids)); } catch {} }
function activeJobs() { return state.jobs.filter(job => ["queued", "running"].includes(job.status) && (!browserSyncEnabled() || Date.now()-Date.parse(job.updated_at||job.created_at||0)<120000)); }
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
    throw new Error("当前 APK/静态网页尚未连接同步服务；请到“设置 → 资源库连接”填写 Worker 地址和同步 Token");
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
      throw new Error("当前设备缺少正确的写入 Token。请导入已有设备的加密配置或填写正确 Token；重复保存同一个错误 Token 不会恢复权限。");
    }
    if (response.status === 405) {
      const message = "同步地址返回 405：请在“设置 → 资源库连接”填写 Cloudflare Worker 的 workers.dev 地址，而不是 GitHub Pages 网页地址或 Cloudflare 控制台地址；修改 Worker 后还要重新部署。";
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
let transferController=null,transferStartedAt=0,transferClock;
const codecCalls=new Map();
function transferSignal(){return commitBatchBusy||transferState.active?transferController?.signal:undefined;}
function pauseCurrentTransfer(){
  if(!transferController||!transferState.active)return;
  transferController.abort(new DOMException('已暂停，文件保留，可继续上传','AbortError'));
  for(const worker of codecWorkers)worker.terminate();codecWorkers.length=0;
  operationMessage($('#reviewBatchStatus'),backupPhaseActive?'正在暂停 123 备份；R2 已入库。':'正在暂停；未完成文件会保留。');$('#pauseTransfer').disabled=true;
}
async function transferFetch(url,options={},timeout=45000){
  const outer=transferSignal(),timer=AbortSignal.timeout(timeout);
  const signal=outer?AbortSignal.any([outer,timer]):timer;
  try{return await fetch(url,{...options,signal});}
  catch(error){if(outer?.aborted)throw outer.reason;if(timer.aborted)throw new Error(`连接超时：${new URL(url,location.href).pathname}；文件已保留，可重试`);throw error;}
}
function uploadRequest(url,options,label){
  return new Promise((resolve,reject)=>{
    const signal=transferSignal();if(signal?.aborted){reject(signal.reason);return;}
    const xhr=new XMLHttpRequest();let idle,ended=false;
    const complete=(error,response)=>{if(ended)return;ended=true;clearTimeout(idle);signal?.removeEventListener('abort',abort);error?reject(error):resolve(response);};
    const abort=()=>{complete(signal?.reason||new Error('上传已暂停'));xhr.abort();};
    const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>{complete(new Error('上传连接 60 秒无响应；文件已保留，可重试'));xhr.abort();},60000);};
    xhr.open(options.method,url);xhr.timeout=600000;
    for(const [key,value]of new Headers(options.headers))xhr.setRequestHeader(key,value);
    xhr.upload.onprogress=event=>{touch();if(event.lengthComputable)transferStage(`上传 ${formatBytes(event.loaded)} / ${formatBytes(event.total)}`,label);};
    xhr.onprogress=touch;
    xhr.onload=()=>{const headers=new Headers();for(const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)){const at=line.indexOf(':');if(at>0)headers.append(line.slice(0,at),line.slice(at+1).trim());}complete(null,new Response(xhr.responseText,{status:xhr.status,headers}));};
    xhr.onerror=()=>complete(new Error('上传连接中断；文件已保留，可重试'));xhr.ontimeout=()=>complete(new Error('上传超过 10 分钟；文件已保留，可重试'));xhr.onabort=()=>complete(signal?.reason||new Error('上传已暂停'));
    signal?.addEventListener('abort',abort,{once:true});touch();xhr.send(options.body);
  });
}
const codecWorkers = [];
let codecWorkerCursor = 0;
let codecWorkerSequence = 0;
function processingConcurrency() {
  const cores=Number(navigator.hardwareConcurrency)||2,memory=Number(navigator.deviceMemory)||4;
  return Math.max(1,Math.min(4,cores-1,memory<=2?1:memory<=4?2:4));
}
function acquireCodecWorker() {
  if (typeof Worker === "undefined" || codecWorkerDisabled) return null;
  const wanted = processingConcurrency();
  for (let index = codecWorkers.length; index < wanted; index++) {
    try { codecWorkers.push(new Worker("./free_codec_worker.js?v=20261118-progress")); }
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
async function callCodecWorker(command,payload) {
  const worker=acquireCodecWorker();if(!worker)return null;
  const signal=transferSignal();if(signal?.aborted)throw signal.reason;
  const id=++codecWorkerSequence,message={id,command,options:payload.options||{},progress:true},transfer=[];
  if(payload.bytes){const buffer=detachedCopy(payload.bytes);message.bytes=buffer;transfer.push(buffer);}
  if(payload.items)message.items=payload.items.map(item=>{const bytes=detachedCopy(item.bytes);transfer.push(bytes);return {...item,bytes};});
  return new Promise((resolve,reject)=>{
    let timer,closed=false;
    const cleanup=()=>{clearTimeout(timer);codecCalls.delete(id);signal?.removeEventListener('abort',abort);worker.removeEventListener('message',onMessage);worker.removeEventListener('error',onError);};
    const fail=error=>{if(closed)return;closed=true;cleanup();reject(error);};
    const abort=()=>fail(signal.reason);
    const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>{for(const call of [...codecCalls.values()])if(call.worker===worker)call.fail(new Error('压缩线程 90 秒没有进展；文件已保留，可重试'));worker.terminate();const index=codecWorkers.indexOf(worker);if(index>=0)codecWorkers.splice(index,1);},90000);};
    const onMessage=event=>{if(event.data?.id!==id||closed)return;if(event.data.progress){touch();payload.onProgress?.(event.data.progress);return;}cleanup();closed=true;if(!event.data.ok)reject(new Error(event.data.error?.message||'压缩失败'));else resolve(normalizeCodecResult(event.data.result));};
    const onError=event=>{for(const call of [...codecCalls.values()])if(call.worker===worker)call.fail(new Error(event.message||'压缩线程中断，文件已保留'));worker.terminate();const index=codecWorkers.indexOf(worker);if(index>=0)codecWorkers.splice(index,1);};
    codecCalls.set(id,{worker,fail});signal?.addEventListener('abort',abort,{once:true});worker.addEventListener('message',onMessage);worker.addEventListener('error',onError);touch();try{worker.postMessage(message,transfer);}catch(error){fail(error);}
  });
}
async function runCodecTask(command,payload,fallback) {
  if(!codecWorkerDisabled){const result=await callCodecWorker(command,payload);if(result!==null)return result;}
  if(transferSignal()?.aborted)throw transferSignal().reason;
  return fallback();
}
// 封面图集、高亮包这类私有 RED 变体的图片仍是顺序明文，浏览器能读出并合成
// 预览，但公开头字段与 Worker 已支持的重封格式不同，目录接口会回 422。按同一
// 组字段先在浏览器判定，不支持的变体直接保留原包，不让整批主题导入失败。
const PRIVATE_REPACK_HEADER = {version:2,resourceType:"themeBundle",payloadType:"directory",containerMode:"reedenPrivate",algorithm:"aes-256-gcm-manifest",assetMode:"plain-sequential"};
function privateHeaderRepackSupported(header) {
  return Boolean(header) && typeof header === "object" && Object.keys(PRIVATE_REPACK_HEADER).every(key => header[key] === PRIVATE_REPACK_HEADER[key]);
}
// 图集（coverGallery）和高亮规则包不是阅读主题：收进收藏库，各占一个分类。
// 私有 v2 用公开头的 resourceType 判定；v1 gzip 的阅读/高亮包没有公开头，
// 先看解码出来的图片角色，再退回文件名，避免误伤普通阅读主题。
function redAssetCategory(info) {
  const kind = redPartKind(info?.entries, info);
  if (kind === "gallery") return "图集";
  if (kind === "highlight") return "高亮";
  // 阅读主题（v1 阅读配色/高亮方案）以前当主题入库，现在和主题库分开：
  // 它只改阅读页，没有书架和启动图，放在收藏库「阅读主题」里更好找。
  if (kind === "reader") return "阅读主题";
  return "";
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
function indexOfBytes(haystack, needle, from = 0) {
  if (!needle?.length) return -1;
  const first = needle[0];
  for (let index = Math.max(0, from); index <= haystack.length - needle.length; index++) {
    if (haystack[index] !== first) continue;
    let offset = 1;
    while (offset < needle.length && haystack[index + offset] === needle[offset]) offset++;
    if (offset === needle.length) return index;
  }
  return -1;
}
// Byte-level brace matching is safe on UTF-8: continuation bytes are >= 0x80,
// so { } " and \ can never appear inside a multi-byte character.
function jsonObjectAt(raw, openIndex, limit = 4 * 1024 * 1024) {
  let depth = 0, inString = false, escaped = false;
  for (let index = openIndex; index < raw.length && index - openIndex < limit; index++) {
    const byte = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
      continue;
    }
    if (byte === 0x22) inString = true;
    else if (byte === 0x7b) depth++;
    else if (byte === 0x7d && !--depth) return raw.subarray(openIndex, index + 1);
  }
  return null;
}
// A private RED keeps its images in a plain sequential area, and Reeden writes
// the theme JSON there unencrypted after the images. The encrypted manifest
// carries no name/author, so without this the review card can only fall back to
// the file name and shows "作者未记录".
function privatePlainIdentity(raw, from = 0) {
  const marker = new TextEncoder().encode('"author"');
  const decoder = new TextDecoder("utf-8");
  const positions = [];
  let at = indexOfBytes(raw, marker, from);
  while (at >= 0 && positions.length < 24) { positions.push(at); at = indexOfBytes(raw, marker, at + 1); }
  let name = "", author = "";
  const collect = node => {
    const identity = { name: "", author: "" };
    const visit = value => {
      if (!value || typeof value !== "object") return;
      if (!identity.name) {
        const candidate = value.name || value.title || value.themeName;
        if (typeof candidate === "string" && candidate.trim()) identity.name = candidate.trim();
      }
      if (!identity.author) {
        const candidate = value.author || value.creator || value.designer;
        if (typeof candidate === "string" && candidate.trim()) identity.author = candidate.trim();
      }
      for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
    };
    visit(node);
    return identity;
  };
  // The nearest brace before "author" is usually the nested "light"/"dark"
  // object, which has an author but no name. Walk outwards through enclosing
  // objects and merge what each level contributes.
  for (const position of positions.reverse()) {
    let scan = position;
    for (let level = 0; level < 8; level++) {
      let open = scan;
      for (let back = 0; back < 2 * 1024 * 1024 && open > from; back++, open--) if (raw[open] === 0x7b) break;
      if (raw[open] !== 0x7b) break;
      const slice = jsonObjectAt(raw, open);
      if (slice) {
        let value = null;
        try { value = JSON.parse(decoder.decode(slice)); } catch { value = null; }
        if (value) {
          const identity = collect(value);
          if (identity.name && !name) name = identity.name;
          if (identity.author && !author) author = identity.author;
          if (name && author) break;
        }
      }
      scan = open - 1;
    }
    if (name && author) break;
  }
  return name || author ? { name, author } : null;
}
async function privateDirectory(prefix) {  const response = await transferFetch(apiUrl("/api/private/directory"), {
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
  const response = await transferFetch(apiUrl("/api/private/seal"), {
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
/* 加密主题里的 .json 配置（theme.json、reader_schema/*、navbar_pack 等）写着
   图片引用：裸 MD5 / 带扩展名的哈希 / 完整资源路径。图片换成 WebP 后这些引用
   必须跟着变，否则主题打不开。小配置交给 Worker 映射；有的主题单个 schema.json
   就有 2 MB，在免费版 Worker 里 JSON.parse 会撞 CPU 上限（10ms）直接 500，所以
   超过 512 KB 的配置在浏览器里按同一套规则先映射好，Worker 只登记不解析。 */
const PRIVATE_CONFIG_INLINE_LIMIT = 512 * 1024;
function privateReplaceExtension(path, extension) {
  const ext = String(extension || "").replace(/^\./, "").toLowerCase();
  const safe = ["png", "jpg", "jpeg", "webp", "gif"].includes(ext);
  // `.img` 是 Reeden 的固定槽位（theme_bg.img / card_bg.img / bg.img /
  // 000.img），按路径加载，改名会让书架背景、阅读背景和轮播图全部失联。
  return safe && /\.(?:png|jpe?g|webp|gif)$/i.test(String(path || "")) ? String(path).replace(/\.(?:png|jpe?g|webp|gif)$/i, `.${ext}`) : path;
}
function privatePathExtension(path) {
  const match = String(path || "").match(/\.([A-Za-z0-9]+)$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}
function privateRefMaps(replacements) {
  const maps = {hashes: new Map(), paths: new Map(), extensions: new Map(), tokens: new Set()};
  const put = (map, key, value) => { const normalized = String(key || "").toLowerCase(); if (normalized) map.set(normalized, value); };
  for (const item of replacements || []) {
    const oldSha = String(item.old_sha256 || ""), newSha = String(item.new_sha256 || "");
    if (oldSha && newSha) { put(maps.hashes, oldSha, newSha); maps.tokens.add(oldSha.toLowerCase()); }
    if (item.old_md5 && item.new_md5) { put(maps.hashes, item.old_md5, String(item.new_md5)); maps.tokens.add(String(item.old_md5).toLowerCase()); }
    if (item.path) maps.tokens.add(String(item.path).toLowerCase());
    const extension = String(item.new_extension || "").replace(/^\./, "").toLowerCase();
    if (!extension || !item.path) continue;
    const newPath = privateReplaceExtension(item.path, extension);
    if (newPath !== item.path) maps.paths.set(item.path, newPath);
    // 资源没有改名时，引用里的扩展名也要跟着保持原样（`.img` 依旧写 `.img`），
    // 否则「哈希.扩展名」形态的引用会指向一个并不存在的文件名。
    const effective = newPath === item.path ? privatePathExtension(item.path).replace(/^\./, "") : extension;
    put(maps.extensions, oldSha, effective);
    put(maps.extensions, item.old_md5, effective);
  }
  return maps;
}
// 与 pages/worker-api.js 的 mapPrivateRefs 保持一致：路径整串优先，其次是裸哈希
// 与「哈希.扩展名」，命中就用新哈希替换、扩展名跟随后端给出的新格式。哈希统一
// 输出小写——包内资源名就是小写，大写引用照抄成大写文件名反而找不到文件。
function mapPrivateRefsClient(value, maps, configPath = "") {
  if (Array.isArray(value)) return value.map(item => mapPrivateRefsClient(item, maps, configPath));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapPrivateRefsClient(item, maps, configPath)]));
  if (typeof value !== "string") return value;
  if (maps.paths.has(value)) return maps.paths.get(value);
  const exact = maps.hashes.get(value.toLowerCase());
  if (exact) return exact;
  const match = value.match(/^([a-f0-9]{32}|[a-f0-9]{64})(\.[A-Za-z0-9]+)?$/i);
  if (match) {
    const mapped = maps.hashes.get(match[1].toLowerCase());
    const extension = maps.extensions.get(match[1].toLowerCase());
    return mapped ? mapped + (extension ? `.${extension}` : (match[2] || "")) : value;
  }
  // 配置目录里的相对文件名（轮播 manifest 的 "file": "000.img"）也要跟着改名，
  // 否则 Reeden 按 manifest 目录去找文件时找不到已经改名的轮播图。
  if (configPath) {
    const dir = configPath.slice(0, configPath.lastIndexOf("/") + 1);
    if (dir) {
      const target = maps.paths.get(dir + value);
      if (target && target.startsWith(dir)) return target.slice(dir.length);
    }
  }
  return value;
}
async function mapLargePrivateConfigs(entries, slice, replacements, codec) {
  const result = new Map();
  if (typeof codec?.sha256Hex !== "function") return result;
  const maps = privateRefMaps(replacements);
  for (const entry of entries) {
    if (!/\.json$/i.test(entry.path)) continue;
    const bytes = slice(entry);
    if (bytes.length <= PRIVATE_CONFIG_INLINE_LIMIT) continue;
    let text;
    try { text = new TextDecoder().decode(bytes); } catch { continue; }
    let document;
    try { document = JSON.parse(text); } catch { continue; }
    const lower = text.toLowerCase();
    const touched = maps.tokens.size > 0 && [...maps.tokens].some(token => lower.includes(token));
    // 关键：只要配置超过 512 KB 就一律以 mapped 形式提交，哪怕里面没有被替换的
    // 图片引用。以前「没有引用就跳过」会让这份大 JSON 以 base64 明文回给 Worker，
    // Worker 再去 JSON.parse 就撞上 1 MB 上限与 10 ms CPU，整包重封直接 422。
    // 现在 Worker 对这些大配置只登记字节和 sha256，既不解析也不算大小账。
    const mappedBytes = touched
      ? new TextEncoder().encode(JSON.stringify(mapPrivateRefsClient(document, maps, entry.path)))
      : bytes.slice();
    result.set(entry.path, {bytes: mappedBytes, sha256: await codec.sha256Hex(mappedBytes)});
  }
  return result;
}
async function compressPrivateRedViaWorker(raw, codec, options = {}) {
  const prefix = privatePrefix(raw);
  let directory;
  try {
    directory = await privateDirectory(prefix);
  } catch (error) {
    // 422「此私有 RED 协议尚未支持重封」= 封面图集/高亮包等其它头形态。
    // 浏览器已经能读出图片和预览，这里保留原包入库，用户仍可收录与查看。
    if (String(error?.message || "").includes("此私有 RED 协议尚未支持重封")) {
      return privateSkippedResult(raw, [{path: "", used: false, reason: "此私有 RED 协议暂不支持压缩，保留原包并保存预览"}]);
    }
    throw error;
  }
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
  // 九宫格资源的切片坐标绑定在原始像素网格上，重编码会丢 npTc、缩放会让坐标
  // 失效，Reeden 直接画不出来。加密包里配置是加密的，但目录条目仍带路径，
  // 可以按路径取出明文 JSON 判定。
  let skipPaths = [];
  try {
    if (typeof codec.nineSlicePaths === "function") {
      skipPaths = codec.nineSlicePaths(entries.map(entry => ({name: entry.path, bytes: slice(entry)})));
    }
  } catch { skipPaths = []; }
  const codecOptions = skipPaths.length ? { ...options, skipPaths } : options;
  const compressed = await runCodecTask("compressImages",
    {items: images.map(entry => ({name: entry.path, bytes: slice(entry)})), options: {...codecOptions, concurrency: Math.min(4, Number(navigator.hardwareConcurrency) || 2)}},
    async () => ({results: await mapConcurrent(images, 3, async entry => {
      const result = await codec.compressImage(slice(entry), entry.path, codecOptions);
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
  const localConfigs = await mapLargePrivateConfigs(entries, slice, replacements, codec);
  const configs = entries
    .filter(entry => /\.json$/i.test(entry.path) && !localConfigs.has(entry.path))
    .map(entry => ({path: entry.path, bytes_base64: base64Bytes(slice(entry))}));
  for (const [path, item] of localConfigs) configs.push({path, bytes_base64: base64Bytes(item.bytes), mapped: true, sha256: item.sha256});
  const seal = await privateSeal(prefix, replacements, configs);
  const configMap = new Map([...localConfigs].map(([path, item]) => [path, item.bytes]));
  for (const item of seal.configs || []) configMap.set(item.path, bytesFromBase64(item.bytes_base64));
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
  const response = await transferFetch(apiUrl("/api/private/repack"), {
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
// 123 的登录与扫码接口都回 `Access-Control-Allow-Origin: *`，允许任意来源跨域
// 调用。浏览器直接连 123 时，请求从用户自己的网络出口发出，123 不会把它当成
// 「海外登录」而强制弹阿里云图形验证码；反过来，同步 Worker 代发时请求从
// Cloudflare 出口出去，123 按海外 IP 处理并要求验证码——这正是网页端账号密码
// 登录一直失败的原因。所以浏览器同步模式下优先让浏览器自己直连。
const PAN123_SIGN_IN_URL = "https://login.123pan.com/api/user/sign_in";
const PAN123_QR_GENERATE_URL = "https://user.123pan.cn/api/user/qr-code/generate";
const PAN123_QR_RESULT_URL = "https://user.123pan.cn/api/user/qr-code/result";
const PAN123_WEB_URL = "https://www.123pan.com/";
function pan123BackupConfig() {
  try { return {token: localStorage.getItem(PAN123_TOKEN_STORAGE_KEY) || "", folder: localStorage.getItem(PAN123_FOLDER_STORAGE_KEY) || "Red-Garden-Backup"}; }
  catch { return {token: "", folder: "Red-Garden-Backup"}; }
}
let backupPhaseActive=false;
const deferredPan123=[];
// 整批提交时 123 备份延后到 commitSelection 末尾；这类主题的本地恢复副本
// 也要等备份结果出来再决定能否清除，否则会误留“未完成文件”横幅。
const deferredBackupCleanup=[];
// 原包只备份到 123，不写 R2；入库阶段原包字节已在浏览器内存，暂存下来供
// 紧随其后的备份直接复用。成功后释放；失败/暂停保留到本次会话内重试。
const backupByteStash=new Map();
function pendingPan123Backup(record){return !record.original_123?.key&&(backupByteStash.has(record.id)||!!record.original_url);}
function pan123BackupEnabled(){return !!pan123BackupConfig().token && $('#backupTo123')?.checked!==false;}
// 问题3：备份走的还是 Worker -> Cloudflare 海外出口 -> 123，这是慢+易失败的根因。
// 登录/校验/列清单早已浏览器直连，唯独上传原包还留在海外中转。这里把控制面
// （/b/api/*，CORS 全开）和数据面（presigned 节点 PUT，123 官方网页也是浏览器直传）
// 全部搬到用户自己的网络出口；结果只写一个元数据回 Worker，不经手字节、不代发 123。
// 浏览器直连因 CORS/网络不可达时，自动回退到下面的 Worker 中转兜底，不比现状更差。
function safePan123TransferUrl(value){
  let url;try{url=new URL(String(value||''));}catch{throw new Error('123 返回了无效的传输地址');}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||host==='localhost'||host.endsWith('.localhost')||/^\d{1,3}(\.\d{1,3}){3}$/.test(host))throw new Error('123 返回了不安全的传输地址');
  return url.href;
}
async function persistPan123BackupResult(record,md5,result){
  const response=await transferFetch(apiUrl('/api/backup/123/result'),{method:'POST',headers:requestHeaders({'Content-Type':'application/json'}),body:JSON.stringify({theme_id:record.id,md5,result})},30000);
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.ok)throw new Error(data.error||`备份结果写回失败（HTTP ${response.status}）`);
  if(data.item){Object.assign(record,data.item);const current=state.themes.find(item=>item.id===record.id);if(current)Object.assign(current,data.item);updateCachedRecord(record);}
  return data;
}
// 备份批次共享的目录解析：同一 token + 目录只解析一次 FileId，避免逐主题重复列目录。
function pan123ListFolderFactory(token){
  return async(parent)=>{
    const data=await pan123DirectRequest(token,'/file/list/new',{params:{driveId:0,limit:100,next:'0',orderBy:'file_id',orderDirection:'desc',parentFileId:String(parent),trashed:'false',SearchData:'',Page:1,OnlyLookAbnormalFile:0,event:'homeListFile',operateType:4,inDirectSpace:'false'}});
    return Array.isArray(data.InfoList)?data.InfoList:[];
  };
}
async function pan123BackupParent(token,folder,listFolder,context){
  if(context.parent!==undefined)return context.parent;
  // 并发去重：共享同一个 in-flight promise，避免多个主题同时解析同一目录。
  if(!context.parentPromise)context.parentPromise=(async()=>{
    let parent=0;
    for(const name of folder.split('/').filter(Boolean)){
      if(name.length>240||name==='.'||name==='..')throw new Error('123 备份目录名称无效');
      let found=(await listFolder(parent)).find(item=>item&&String(item.FileName)===name);
      if(!found){
        await pan123DirectRequest(token,'/file/upload_request',{method:'POST',body:{driveId:0,etag:'',fileName:name,parentFileId:parent,size:0,type:1,duplicate:0,NotReuse:true,event:'newCreateFolder',operateType:1}});
        found=(await listFolder(parent)).find(item=>item&&String(item.FileName)===name);
      }
      if(!found||Number(found.Type)!==1)throw new Error(`123 备份目录不可用：${name}`);
      parent=Number(found.FileId);
    }
    context.parent=parent;return parent;
  })();
  try{return await context.parentPromise;}
  finally{if(context.parent===undefined)context.parentPromise=null;}
}
async function pan123DirectBackup(record,codec,config,inMemoryBytes,context){
  const token=config.token;
  let md5=record.original_md5;
  const fileName=(String(record.source_name||redDownloadLabel(record)).replace(/\.red$/i,'').replace(/[\\/:*?"<>|]/g,'_').slice(0,200)||'theme')+'.red';
  const folder=String(config.folder||'').replace(/^\/+|\/+$/g,'');
  // 原包只备份到 123，正常入库直接用本地字节；只有历史记录（曾经存过 R2）
  // 重试时才回退 R2。若原包未存 R2 且内存字节已释放，则明确提示重新选文件。
  let bytes=inMemoryBytes;
  if(!bytes){
    if(!record.original_url)throw new Error('原包内存字节已释放且未存 R2，请重新选择文件后备份到 123');
    transferStage('从 R2 读取原包（历史记录重试）',record.name||record.id);
    const raw=await transferFetch(assetUrl(record.original_url),{headers:requestHeaders()},180000);
    if(!raw.ok)throw new Error(`无法读取 R2 原包（HTTP ${raw.status}）`);
    bytes=new Uint8Array(await raw.arrayBuffer());
  }
  if(!bytes.length)throw new Error('原包为空');
  if(!md5){
    const result=await runCodecTask('hashes',{items:[{bytes}],options:{concurrency:1}},async()=>({results:[{md5:await codec.md5Hex(bytes)}]}));
    md5=result.results[0].md5;record.original_md5=md5;updateCachedRecord(record);
  }
  // 备份目录的 FileId 一批主题完全相同。旧实现每个主题都重新列目录找一遍，
  // 一批 66 个主题就是 66 次重复往返。这里由批次解析一次，通过 context 共享。
  const listFolder=context.listFolder||pan123ListFolderFactory(token);
  const parent=await pan123BackupParent(token,folder,listFolder,context);
  const existing=(await listFolder(parent)).find(item=>item&&String(item.FileName)===fileName);
  const sha256=await codec.sha256Hex(bytes);
  if(existing){
    if(Number(existing.Type)!==0||Number(existing.Size)!==bytes.length||String(existing.Etag||'').toLowerCase()!==md5)throw new Error('123 备份目录已有同名但不同的文件，未覆盖');
    const result={ok:true,provider:'123pan',key:folder?`${folder}/${fileName}`:fileName,fileId:String(existing.FileId),bytes:bytes.length,sha256,reused:true};
    await persistPan123BackupResult(record,md5,result);return result;
  }
  const info=await pan123DirectRequest(token,'/file/upload_request',{method:'POST',body:{driveId:0,duplicate:0,etag:md5,fileName,parentFileId:parent,size:bytes.length,type:0}});
  if(!info.Reuse){
    if(!info.Bucket||!info.Key||!info.StorageNode||!info.FileId)throw new Error('123 未返回完整上传参数，原包仍保留在本地');
    const common={StorageNode:info.StorageNode,bucket:info.Bucket,key:info.Key,uploadId:String(info.UploadId||'')};
    const chunkSize=16*1024*1024,parts=Math.max(1,Math.ceil(bytes.length/chunkSize));
    // 分块并发：旧实现每块"鉴权→PUT→鉴权→PUT"串行，往返次数随块数线性叠加。
    // 用有限并发同时推进多块，S3 multipart 允许乱序上传，最后统一 complete。
    const partNumbers=Array.from({length:parts},(_,index)=>index+1);
    await mapConcurrent(partNumbers,Math.min(4,parts),async number=>{
      if(transferController?.signal.aborted)return;
      const auth=await pan123DirectRequest(token,parts===1?'/file/s3_upload_object/auth':'/file/s3_repare_upload_parts_batch',{method:'POST',body:{...common,partNumberStart:number,partNumberEnd:number+1}});
      const url=safePan123TransferUrl(auth?.presignedUrls?.[String(number)]);
      const chunk=bytes.subarray((number-1)*chunkSize,Math.min(bytes.length,number*chunkSize));
      const response=await uploadRequest(url,{method:'PUT'},`${record.name||record.id} · 第 ${number}/${parts} 块`);
      if(!response.ok)throw new Error(`123 分块上传失败（HTTP ${response.status}）`);
    });
    if(transferController?.signal.aborted)return {paused:true};
    await pan123DirectRequest(token,'/file/upload_complete/v2',{method:'POST',body:{...common,fileId:info.FileId,fileSize:bytes.length,isMultipart:parts>1}});
  }
  const stored=(await listFolder(parent)).find(item=>item&&String(item.FileName)===fileName);
  if(!stored||Number(stored.Type)!==0||Number(stored.Size)!==bytes.length||String(stored.Etag||'').toLowerCase()!==md5)throw new Error('123 尚未确认原包落盘，未记为成功；本地原包仍在');
  const result={ok:true,provider:'123pan',key:folder?`${folder}/${fileName}`:fileName,fileId:String(stored.FileId),bytes:bytes.length,sha256,reused:false};
  await persistPan123BackupResult(record,md5,result);return result;
}
async function backupOriginalTo123(record,codec,inMemoryBytes,context){
  const config=pan123BackupConfig();if(!config.token)return {error:'尚未连接 123 云盘'};
  try{
    const direct=await pan123DirectBackup(record,codec,config,inMemoryBytes,context||{});
    if(direct?.paused)return direct;
    return direct;
  }catch(error){
    if(transferController?.signal.aborted)return {paused:true};
    const message=String(error?.message||'');
    // 只有浏览器直连本身不可达（CORS/网络）才回退 Worker；原包只备份到 123 的
    // 新记录没有 R2 副本，不能回退。会话过期、同名冲突也直接上报更诚实。
    const canFallback=!!record.original_url&&(error instanceof TypeError||/Failed to fetch|NetworkError|Load failed|直连|跨域|CORS/i.test(message));
    if(canFallback)return backupOriginalTo123ViaWorker(record,codec);
    if(!record.original_url&&(error instanceof TypeError||/Failed to fetch|NetworkError|Load failed|直连|跨域|CORS/i.test(message)))return {error:'浏览器直连 123 不可用，且原包未存 R2；请恢复网络后重新选择文件备份'};
    error.stage ||= 'direct-backup';
    const failure=pan123Failure(error,'backup');record.original_123_error=failure;updateCachedRecord(record);
    return {error:failure};
  }
}
// Worker 中转兜底：仅在浏览器无法直连 123（多为 CORS/网络限制）时使用。
async function backupOriginalTo123ViaWorker(record,codec) {
  const config=pan123BackupConfig();if(!config.token)return {error:'尚未连接 123 云盘'};
  let stage='source-checksum';
  try {
    if(!record.original_url)throw new Error('原包未存 R2，且浏览器直连不可用；请重新选择文件后备份到 123');
    let md5=record.original_md5;
    if(!md5){
      transferStage('为旧记录补齐备份校验',record.name||record.id);
      const response=await transferFetch(assetUrl(record.original_url),{headers:requestHeaders()},180000);if(!response.ok)throw new Error('无法读取旧记录的原包校验');
      const raw=new Uint8Array(await response.arrayBuffer());
      const result=await runCodecTask('hashes',{items:[{bytes:raw}],options:{concurrency:1}},async()=>({results:[{md5:await codec.md5Hex(raw)}]}));md5=result.results[0].md5;record.original_md5=md5;updateCachedRecord(record);
    }
    const fileName=(String(record.source_name||redDownloadLabel(record)).replace(/\.red$/i,'').replace(/[\\/:*?"<>|]/g,'_').slice(0,200)||'theme')+'.red';
    stage='backup-api';
    const response=await transferFetch(apiUrl('/api/backup/123/from-r2'),{method:'POST',headers:requestHeaders({'Content-Type':'application/json','X-Pan123-Token':config.token,'X-Pan123-Folder':encodeURIComponent(config.folder),'X-Pan123-Filename':encodeURIComponent(fileName),'X-Pan123-Etag':md5}),body:JSON.stringify({theme_id:record.id})},180000);
    const data=await response.json().catch(()=>({}));
    if(data.item){Object.assign(record,data.item);const current=state.themes.find(item=>item.id===record.id);if(current)Object.assign(current,data.item);updateCachedRecord(record);}
    if((!response.ok||!data.ok)&&!record.original_123?.key)throw Object.assign(new Error(data.error||`备份接口 HTTP ${response.status}`),{stage:data.stage||'backup-api',httpStatus:response.status,upstreamStatus:data.upstreamStatus,platformCode:data.platformCode});
    return data;
  }catch(error){
    if(transferController?.signal.aborted)return {paused:true};
    error.stage ||=stage;
    const message=pan123Failure(error,'backup');record.original_123_error=message;updateCachedRecord(record);return {error:message};
  }
}
async function runPan123Backups(records) {
  const pending=records.filter(pendingPan123Backup);if(!pending.length)return;
  const status=$('#pan123BackupStatus');operationMessage(status,'压缩版已入 R2，正在把原包直接备份到 123…');backupPhaseActive=true;const previous=suppressCloudJob;suppressCloudJob=true;
  beginTransferProgress('压缩版已入 R2 · 原包直传 123',pending.length,pending.map(item=>item.name));$('#pauseTransfer').textContent='暂停 123 备份';
  let backed=0,issue='';
  try {
    const codec=await browserCodec();
    const config=pan123BackupConfig();
    // 一批主题共享同一个目标目录与 listFolder 句柄：目录 FileId 只解析一次。
    const context={listFolder:pan123ListFolderFactory(config.token)};
    // 主题级并发：复用入库时暂存的本地字节，原包不写 R2；只有历史记录重试才读 R2。
    const width=Math.min(3,pending.length);
    const outcomes=await mapConcurrent(pending,width,async record=>{
      if(transferController.signal.aborted)return {paused:true};
      transferStage('备份原包到 123',record.name||record.id);
      const bytes=backupByteStash.get(record.id);
      let result;
      try{
        result=await backupOriginalTo123(record,codec,bytes,context);
        if(!result?.paused&&!result?.error)transferDone(record.name);
        return result;
      }finally{
        // 成功才释放；失败/暂停保留内存字节，当前会话内可直接重试。
        if(result?.ok)backupByteStash.delete(record.id);
      }
    });
    const paused=transferController.signal.aborted;
    for(const result of outcomes){
      if(result?.paused)continue;
      if(result?.error&&!issue)issue=result.error;
      else if(!result?.error)backed++;
    }
    const message=issue?`压缩版已入 R2；本次 ${backed} 个原包已备份，${issue}。可稍后重试待备份，无需重新上传。`:paused?'压缩版已入 R2；123 备份已暂停，可稍后重试待备份。':`压缩版已入 R2；本次 ${backed} 个原包已备份到 123。`;
    operationMessage(status,message,!!issue);finishTransferProgress(message,issue?1:0);
  }catch(error){operationMessage(status,`压缩版已入 R2；123 备份未完成：${error.message}`,true);finishTransferProgress('压缩版已入 R2；123 备份稍后重试',1);}
  finally{
    const retained=new Set(pending.filter(record=>backupByteStash.has(record.id)).map(record=>record.id));
    for(const id of [...backupByteStash.keys()])if(!retained.has(id))backupByteStash.delete(id);
    backupPhaseActive=false;suppressCloudJob=previous;$('#pauseTransfer').textContent='暂停，稍后继续';renderThemes();updateBulkControls();
  }
}
async function retryPan123Backups() {
  if(state.operation)return;await whenStorageReady();await ensureWriteAccess();
  if(!pan123BackupConfig().token){operationMessage($('#pan123BackupStatus'),'请先连接 123 云盘。未备份的原包仍保留在本地或历史 R2 副本。',true);return;}
  setView('import');setOperation('backup-123');
  try{await runPan123Backups(state.themes.filter(pendingPan123Backup));}finally{setOperation('');}
}
// 123 的 /b/api 接口同样返回 Access-Control-Allow-Origin: *，浏览器可以用自己的
// 网络出口直连。登录已经走直连了，但「测试连接」此前还绕回同步 Worker —— 请求从
// Cloudflare 出口发出就被 123 当成「海外登录」要求图形验证码，于是扫码/账号密码
// 明明成功，立刻又被校验判失败。这里把校验也改成浏览器直连，和登录保持同一出口。
const PAN123_DIRECT_API = "https://www.123pan.cn/b/api";
function normalizePan123Token(value) { return String(value || "").trim().replace(/^Bearer\s+/i, "").trim(); }
const pan123Diagnostics=[];
function pan123Failure(error,context="direct") {
  const message=String(error?.message||error?.name||'未知错误').replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]').replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[会话已隐藏]').replace(/(token|password|secret)(["'\s:=]+)[^\s,;"']+/gi,'$1$2[已隐藏]');
  pan123Diagnostics.push({time:new Date().toISOString(),context,stage:error?.stage||context,httpStatus:error?.httpStatus,upstreamStatus:error?.upstreamStatus,platformCode:error?.platformCode,type:error?.name||'Error',message:message.slice(0,1200)});if(pan123Diagnostics.length>30)pan123Diagnostics.shift();
  if(context==="backup" && error instanceof TypeError)return error.stage==="source-checksum"?"无法读取旧记录的 R2 原包以补齐备份校验":"无法连接 123 备份接口，尚未收到平台错误码";
  if (error?.name === "AbortError") return "连接 123 超时，请检查网络后重试；已保存的会话仍保留。";
  if (error instanceof TypeError) return "浏览器无法直连 123（网络、扩展或跨域限制）。请使用 123 官方网页登录；重新保存 R2 设置无法解决此问题。";
  return error?.message || "123 请求未完成";
}
async function pan123Fetch(url, options = {}) {
  const response = await fetch(url, {...options, signal: options.signal || AbortSignal.timeout(15000)});
  const data = await response.json().catch(() => null);
  if (!data) throw new Error(`123 返回了无法识别的内容（HTTP ${response.status}），请使用官方网页完成登录验证。`);
  if (!response.ok) throw new Error(`123 接口 HTTP ${response.status}：${data.message || data.msg || "请求被拒绝"}`);
  return data;
}
async function pan123DirectRequest(token, path, {params = {}, method = "GET", body} = {}) {
  const url = new URL(PAN123_DIRECT_API + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const data = await pan123Fetch(url.href, {
    method,
    headers: {"Content-Type": "application/json", platform: "web", "app-version": "3", Accept: "application/json", Authorization: `Bearer ${normalizePan123Token(token)}`},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const code = Number(data?.code);
  if (code === 401 || code === 403) {
    const error = new Error("123 会话已过期或被拒绝，请重新登录后再测试");
    error.rejected = true;
    throw error;
  }
  // /b/api 成功码既有 0 也有 200，两种都要认。
  if (![0, 200].includes(code)) throw new Error(data?.message || data?.msg || `123 接口拒绝（code ${code}）`);
  return data.data && typeof data.data === "object" ? data.data : {};
}
// "测试连接" 只读列一下根目录和备份目录，不创建目录、不上传探针、不在服务端留 Token。
async function verifyPan123Backup() {
  // Independent of R2: never route 123 verification through /api/backup/123/verify.
  // 换电脑登不上的原因之一：扫码会退回 Worker 海外出口。现在无论存储是否就绪都直连。
  const output = $("#pan123BackupStatus");
  const token = normalizePan123Token($("#pan123BackupToken")?.value || pan123BackupConfig().token);
  const folder = String($("#pan123BackupFolder")?.value || "").trim() || "Red-Garden-Backup";
  if (!token) { operationMessage(output, "尚未登录 123。它是可选备份，不影响 R2 入库。", true); return false; }
  operationMessage(output, "正在直连 123 验证会话…");
  try {
    const info = await pan123DirectRequest(token, "/user/info");
    const nickname = String(info.Nickname || info.nickname || info.UserName || info.userName || "");
    localStorage.setItem(PAN123_TOKEN_STORAGE_KEY, token);
    localStorage.setItem(PAN123_FOLDER_STORAGE_KEY, folder);
    refreshSettingsControls();
    operationMessage(output, `已连接 123 云盘${nickname ? `（${nickname}）` : ""}，备份目录 ${folder}。会话已保存，无需每次登录。`);
    return true;
  } catch (error) {
    operationMessage(output, `123 校验未通过：${pan123Failure(error)}。现有会话未清除。`, true);
    return false;
  }
}

function pan123InputConfig() {
  return {
    token: String($("#pan123BackupToken")?.value || "").trim() || pan123BackupConfig().token,
    folder: String($("#pan123BackupFolder")?.value || "").trim() || "Red-Garden-Backup",
  };
}
// 网页登录：APK 里由原生 WebView 打开 123 登录页（主 WebView 不允许离开本站），
// 登录后按 JWT 形状把会话扫出来交回这里；浏览器跨域读不到对方 localStorage，
// 只能新开窗口让用户自己复制。两条路最后都落到同一个 localStorage key，
// 备份与验证逻辑不需要知道 Token 从哪来。
function nativeAppBridge() {
  const bridge = window.RedGardenNative;
  if (!bridge || typeof bridge.capability !== "function") return null;
  try { return { bridge, caps: JSON.parse(String(bridge.capability() || "{}")) }; } catch { return null; }
}
function pan123TokenSourceLabel(source) {
  const text = String(source || "");
  if (text === "scan") return "123 云盘扫码";
  if (text === "password") return "123 云盘账号密码登录";
  if (text.startsWith("localStorage:")) return "网页本地存储";
  if (text.startsWith("sessionStorage:")) return "网页会话存储";
  return "网页 Cookie";
}
async function acceptPan123Tokens(payload) {
  let list = [];
  // 原生回传的是 JSON 字符串，浏览器直连拿到的是数组，两种都要收下。
  if (Array.isArray(payload)) list = payload;
  else { try { list = JSON.parse(String(payload || "[]")); } catch { list = []; } }
  if (!Array.isArray(list)) list = [];
  const tokens = list.filter(item => item && typeof item.token === "string" && item.token).slice(0, 2).map(item => ({...item, token: normalizePan123Token(item.token)}));
  const output = $("#pan123BackupStatus");
  if (!tokens.length) {
    operationMessage(output, "登录页里没有找到会话 Token。请确认页面已经显示登录状态，再点一次「取回会话 Token」。", true);
    return;
  }
  const input = $("#pan123BackupToken");
  if (input) input.value = tokens[0].token;
  try { localStorage.setItem(PAN123_TOKEN_STORAGE_KEY, tokens[0].token); } catch {}
  refreshSettingsControls();

  const source = String(tokens[0].source || "");
  operationMessage(output, source === "scan" || source === "password"
    ? `${pan123TokenSourceLabel(source)}成功，会话已保存，正在验证…`
    : `已从${pan123TokenSourceLabel(source)}取回会话（共 ${tokens.length} 个候选），已保存，正在验证…`);
  const tryOne = async index => {
    if (index >= tokens.length) {
      // Keep the specific failure from verifyPan123Backup visible.
      return false;
    }
    if (input) input.value = tokens[index].token;
    try { localStorage.setItem(PAN123_TOKEN_STORAGE_KEY, tokens[index].token); } catch {}
    if (await verifyPan123Backup()) {
      if (source === "scan" || source === "password") toast(`${pan123TokenSourceLabel(source)}成功`);
      return true;
    }
    return tryOne(index + 1);
  };
  return tryOne(0);
}
// 浏览器直连 123 官方登录接口。请求从用户自己的网络出口发出，123 不会按
// 「海外 IP」强制弹阿里云图形验证码；密码只在这一层经过 JS，不进我们的
// Worker、不写 R2、不落盘。
async function pan123DirectSignIn(username, password) {
  const isMail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
  const body = isMail ? {mail: username, password, type: 2} : {passport: username, password, remember: true};
  const data = await pan123Fetch(PAN123_SIGN_IN_URL, {
    method: "POST", headers: {"Content-Type": "application/json", platform: "web", "app-version": "3"}, body: JSON.stringify(body),
  });
  const code = Number(data?.code);
  const token = String(data?.data?.token || "");
  if (![0, 200].includes(code) || !token) {
    const detail = String(data?.message || data?.msg || "").trim();
    const error = new Error(detail || "123 没有接受这次登录：账号或密码不正确，或该账号需要短信验证码。若密码登录一直不过，请改用「扫码连接」。");
    // 123 已经明确拒绝这次登录，再拿 Worker 的海外出口重试一次只会更糟。
    error.rejected = true;
    throw error;
  }
  return token;
}
// 网页端账号密码登录：优先让浏览器直接连 123 官方登录接口（不会被判成海外
// IP 而要验证码），失败再退回同步 Worker 代发（本机后端模式没有跨域限制）。
async function loginPan123Quick(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const output = $("#pan123BackupStatus");
  const username = String(form.elements.username?.value || "").trim();
  const password = String(form.elements.password?.value || "");
  if (!username || !password) { operationMessage(output, "请填写 123 云盘账号和密码。", true); return; }
  const button = $("#pan123QuickLoginButton");
  if (button) button.disabled = true;
  operationMessage(output, "正在登录 123 云盘…");
  try {
    stopPan123Qr();
    const token = await pan123DirectSignIn(username, password);
    // 先把密码从 DOM 里清掉，再保存 Token。
    const input = $("#pan123BackupToken");
    if (input) input.value = token;
    try {
      localStorage.setItem(PAN123_TOKEN_STORAGE_KEY, token);
      localStorage.setItem(PAN123_FOLDER_STORAGE_KEY, String($("#pan123BackupFolder")?.value || "").trim() || "Red-Garden-Backup");

    } catch {}
    await acceptPan123Tokens([{token, source: "password"}]);
  } catch (error) {
    const message = pan123Failure(error);
    const advice = message.includes("扫码连接") ? "" : "如果提示需要验证码，请改用「扫码连接」，或在下方直接粘贴会话 Token。";
    const text = advice ? `${String(message).replace(/[。.]$/, "")}。${advice}` : String(message);
    operationMessage(output, text, true);
  } finally {
    // 密码用完即弃：成功失败都不留在表单里。
    form.reset();
    if (button) button.disabled = false;
  }
}
async function webLoginPan123() {
  const output = $("#pan123BackupStatus");
  const app = nativeAppBridge();
  if (app?.caps?.pan123Login) {
    operationMessage(output, "正在打开 123 云盘登录页，登录完成后会自动取回会话…");
    let result = {};
    try { result = JSON.parse(String(app.bridge.openPan123Login() || "{}")); } catch {}
    if (result && result.started === false) operationMessage(output, result.reason || "登录页没有打开，请重试。", true);
    return;
  }
  // 带 noopener 时 window.open 一律返回 null，不能拿返回值判断是否被拦截；
  // 先正常打开再断开 opener 引用，既保留句柄也不会把本页交给对方。
  const opened = window.open(PAN123_WEB_URL, "_blank");
  if (opened) {
    try { opened.opener = null; } catch {}
    // 浏览器不允许本站读另一个域的 localStorage / cookie，所以登录后没法
    // 像 APK 那样自动取回。把回填位置提前展开，回到本页时自动聚焦；如果
    // 用户已经把 Token 粘进去了，直接接上校验，不再要求多点一次。
    const details = $("#pan123TokenDetails");
    if (details) details.open = true;
    operationMessage(output, "已打开 123 云盘网页。浏览器不能跨站读取 123 的登录态，所以这条路上拿不回 Token：请在 123 页面复制会话 Token 后点「从剪贴板粘贴」，或直接用上面的扫码 / 账号密码登录（都由本机浏览器直连 123，不会再被判定成海外登录）。");
    const onBack = () => {
      const input = $("#pan123BackupToken");
      if (!input) return;
      try { input.scrollIntoView({block: "center", behavior: "smooth"}); } catch {}
      try { input.focus({preventScroll: true}); } catch { input.focus(); }
      if (String(input.value || "").trim()) verifyPan123Backup();
    };
    window.addEventListener("focus", onBack, {once: true});
  } else {
    operationMessage(output, `没打开新窗口（可能被弹窗拦截）。请手动打开 ${PAN123_WEB_URL} 登录后复制会话 Token。`, true);
  }
}
// 原生登录页回传：payload 是 [{token, source}] 的 JSON 字符串。
window.onRedGardenPan123Login = payload => acceptPan123Tokens(payload);
// 纯浏览器里读不到 123 的登录态，但用户多半已经在 123 页面复制过会话值。
// 给一个「从剪贴板粘贴」按钮：一次点击就能填入并直接验证，不用手动找输入框。
async function pastePan123Token() {
  const output = $("#pan123BackupStatus");
  const input = $("#pan123BackupToken");
  let text = "";
  try {
    text = String(await navigator.clipboard.readText() || "");
  } catch {
    operationMessage(output, "浏览器没有放开剪贴板读取权限，请把 Token 直接粘贴到输入框。", true);
    return;
  }
  const token = text.trim().split(/\s+/).filter(Boolean).pop() || "";
  if (!token) { operationMessage(output, "剪贴板是空的，请先复制会话 Token。", true); return; }
  if (input) input.value = token;
  try { localStorage.setItem(PAN123_TOKEN_STORAGE_KEY, token); } catch {}
  operationMessage(output, "已从剪贴板填入会话 Token，正在验证…");
  await verifyPan123Backup();
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
    // quiet 是「登录 / 验证之后顺手刷新一下」，用户此刻只想知道有没有连上；
    // 把几十个文件名铺到面板里既答非所问，又把下面的按钮顶出视野。清单只在
    // 明确点「查看备份清单」时才渲染。
    if (quiet) return data;
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
    operationMessage(output, `123 写入验证通过：${data.key}（${formatBytes(data.bytes)}，${data.reused ? "已存在并复用" : "新建"}）。测试文件保留在 _verify/ 子目录，不会混进真实原包。`);
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
let uploadActive=0;const uploadWaiting=[],uploadAttempts=new Set();
async function withUploadSlot(action) {
  if(uploadActive>=4)await new Promise(resolve=>uploadWaiting.push(resolve));else uploadActive++;
  try{return await action();}finally{if(uploadWaiting.length)uploadWaiting.shift()();else uploadActive--;}
}
async function uploadBrowserObject(kind, sha, extension, body, contentType, label = "", targetRecord = null) {
  const path = `/api/objects/${encodeURIComponent(kind)}/${encodeURIComponent(objectFileName(sha, extension, label))}`;
  const request = (method) => uploadRequest(apiUrl(path), {
    method,
    headers: requestHeaders({ "Content-Type": contentType || "application/octet-stream", "X-Content-SHA256": sha }),
    body,
  },label);
  if(uploadAttempts.has(path+'|'+sha) && kind!=='records' && (body?.byteLength||body?.size||0)>65536) {
    const head=await transferFetch(apiUrl(path),{method:'HEAD',headers:requestHeaders()});
    if(head.ok&&head.headers.get('X-Content-SHA256')===sha)return path;
  }
  // PUT is the canonical R2 object method. A few WebView proxies and older
  // Worker deployments reject PUT with 405; retrying as POST keeps the same
  // content-addressed endpoint while the Worker accepts both methods.
  uploadAttempts.add(path+"|"+sha);
  let response = await withUploadSlot(()=>request("PUT"));
  if (response.status === 405) response = await withUploadSlot(()=>request("POST"));
  if (!response.ok) {
    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; } catch {}
    if (response.status === 401) {
      throw new Error("当前设备缺少正确的写入 Token。请导入已有设备的加密配置或填写正确 Token；重复保存同一个错误 Token 不会恢复权限。");
    }
    if (response.status === 405) {
      throw new Error("同步 API 返回 405：请确认填写的是带 API 的 Pages 地址或 Worker 地址，而不是 GitHub Pages 或控制台地址，并重新部署最新 Worker");
    }
    const detail = data.error || data.message || responseText.trim().slice(0, 240);
    throw new Error(`上传失败（${response.status}）${detail ? `：${detail}` : ""}`);
  }
  // The Worker may rename the object to avoid a name clash, so keep whatever
  // filename it actually stored; later reads and deletes must hit that object.
  let stored = null;
  try { stored = await response.json(); } catch {}
  if(targetRecord && stored?.item)Object.assign(targetRecord,stored.item);
  if (stored?.filename) return `/api/objects/${encodeURIComponent(kind)}/${encodeURIComponent(stored.filename)}`;
  return path;
}
async function uploadBrowserRecord(record, codec) {
  // Records are immutable content-addressed objects. Keep a stable asset id
  // and timestamp so a classification edit supersedes its older record.
  if (!record.updated_at) record.updated_at = new Date().toISOString();
  if (!record.created_at) record.created_at = record.imported_at || record.updated_at;
  if (!record.imported_at) record.imported_at = new Date().toISOString();
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const recordSha = await codec.sha256Hex(bytes);
  await uploadBrowserObject("records", recordSha, "json", bytes, "application/json", "", record);
  record.record_sha256 ||= recordSha;
  recentUploadIds.add(`${record.kind}:${record.id}`);
  libraryPage[record.kind] = 1;
  librarySort[record.kind] = "added";
  $(`[data-library-sort="${record.kind}"]`).value = "added";
  updateCachedRecord(record);
  toast(`已入库：${record.name || record.family || record.file_name || "资源"}`);
  return record;
}
function normalizeIdentity(value) {
  return String(value || "").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}
function browserDuplicateCandidates(name, author) {
  const target = `${normalizeIdentity(themeIdentity({name, author}).title)}\u0000${normalizeIdentity(author || "作者未记录")}`;
  return state.themes.filter(theme => `${normalizeIdentity(themeIdentity(theme).title)}\u0000${normalizeIdentity(themeIdentity(theme).author)}` === target);
}

function themeIdentity(theme) {
  const author = String(theme?.author || '').trim() || '作者未记录';
  let title = String(theme?.name || theme?.source_name || theme?.file_name || '未命名主题').trim();
  if (author !== '作者未记录') {
    const prefix = title.slice(0, author.length);
    const suffix = title.slice(author.length);
    if (prefix.toLocaleLowerCase('zh-CN') === author.toLocaleLowerCase('zh-CN') && /^\s*[-—–－]\s*\S/.test(suffix)) {
      title = suffix.replace(/^\s*[-—–－]\s*/, '').trim();
    }
  }
  return {title: title || '未命名主题', author};
}
function filenameIdentityFallback(fileName) {
  const stem = String(fileName || '主题').replace(/\.red$/i, '').replace(/\s*[([【（].*?(?:加密|未加密|日夜|夜间).*?[)\]】）]\s*$/i, '').replace(/\s*[-_·]?(?:未加密|加密|日夜|夜间)\s*$/i, '').replace(/\s*\(\d+\)\s*$/i, '').trim();
  const parts = stem.split(/_-_+|\s+[-—–－]\s*|\s*[-—–－]\s+/).map(item => item.trim()).filter(Boolean);
  if (/^(?:应用主题|阅读主题|主题|reeden)$/i.test(parts[0] || '')) parts.shift();
  if (parts.length < 2) return {name: parts[0] || stem || '主题', author: '作者未记录'};
  return {name: parts.slice(1).join(' - '), author: parts[0]};
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
  const metadataPriority = entry => /^theme\.json$/i.test(entry.name || '') ? 0 : /(^|\/)theme\.json$/i.test(entry.name || '') ? 1 : 2;
  const ordered = [...(entries || [])].sort((a, b) => metadataPriority(a) - metadataPriority(b));
  for (const entry of ordered) {
    if (!entry.name?.toLowerCase().endsWith(".json")) continue;
    try {
      const value = JSON.parse(new TextDecoder().decode(entry.bytes));
      visit(value);
      if (metadataName && metadataAuthor) break;
    } catch { /* JSON assets can be unrelated configuration. */ }
  }
  return {name: themeIdentity({name, author}).title, author};
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
  if (/carousel|banner|slider|swiper|轮播|横幅|焦点图/i.test(value)) return "carousel";
  if (/card_bg|cardbackground|card-background|book_card|bookshelf_card|书架卡片|书卡|卡片/i.test(value)) return "card";
  if (/theme_bg|bookshelf|shelf|library|background|书架|书架底|首页|主页/i.test(value)) return "shelf";
  return "other";
}
function isNightAsset(name) {
  return /(^|[._/-])(dark|night|nighttime|darkmode|黑夜|夜间)([._/-]|$)/i.test(String(name || ""));
}
/**
 * Reeden 的日夜两套资源不靠路径名区分：theme_bg、bookshelf_carousel 这类文件名里
 * 带 light/dark 的能直接看出来，而 reader_schema、custom_splash、cover_gallery、
 * navbar_pack 的目录名是随机 UUID，日夜归属只写在 theme.json 的 light / dark 块里
 * （ID 指向 UUID 目录，图片用 MD5 指向具体字节）。这里按「块 → 资源」的绑定关系把
 * 每条资源归入 light 或 dark，预览时整套只取一套，避免日夜一左一右混排。
 */
async function themeModeIndex(entries, codec) {
  const list = Array.isArray(entries) ? entries : [];
  const config = list
    .filter(entry => /(^|\/)theme\.json$/i.test(String(entry?.name || "")))
    .sort((a, b) => String(a?.name || "").length - String(b?.name || "").length)[0];
  if (!config?.bytes?.length) return null;
  let root;
  try { root = JSON.parse(new TextDecoder().decode(config.bytes)); } catch { return null; }
  const findBlock = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 3) return null;
    if (value.light && value.dark && typeof value.light === "object" && typeof value.dark === "object") return value;
    for (const child of Object.values(value)) { const found = findBlock(child, depth + 1); if (found) return found; }
    return null;
  };
  const block = findBlock(root);
  if (!block) return null;
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const uuidSegment = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const md5Pattern = /^[0-9a-f]{32}$/i;
  const collect = source => {
    const ids = new Set(), hashes = new Set();
    const visit = value => {
      if (typeof value === "string") {
        const text = value.trim();
        const uuid = text.match(uuidPattern);
        if (uuid) ids.add(uuid[0].toLowerCase());
        else if (md5Pattern.test(text)) hashes.add(text.toLowerCase());
        return;
      }
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(source);
    return {ids, hashes};
  };
  const light = collect(block.light), dark = collect(block.dark);
  if (!light.ids.size && !light.hashes.size && !dark.ids.size && !dark.hashes.size) return null;
  const byName = new Map();
  const assign = (name, mode) => { if (name && !byName.has(name)) byName.set(name, mode); };
  for (const entry of list) {
    const name = String(entry?.name || "");
    if (!name) continue;
    const segments = name.toLowerCase().split("/");
    // 1) 目录名是被 light / dark 块引用的 UUID：theme.json 是权威，先听它的
    for (const segment of segments) {
      if (!uuidSegment.test(segment)) continue;
      const id = segment.toLowerCase();
      if (light.ids.has(id)) { assign(name, "light"); break; }
      if (dark.ids.has(id)) { assign(name, "dark"); break; }
    }
    if (byName.has(name)) continue;
    // 2) 路径里直接写了 light / dark
    if (segments.includes("dark")) assign(name, "dark");
    else if (segments.includes("light")) assign(name, "light");
  }
  // 3) 剩下的按 MD5 对上块里的图片引用（压缩后字节会变，这一步主要服务原包）
  const pending = list.filter(entry => entry?.name && !byName.has(String(entry.name)) && entry.bytes?.length && entry.bytes.length <= 8 * 1024 * 1024);
  if (pending.length && typeof codec?.md5Hex === "function") {
    for (const entry of pending.slice(0, 32)) {
      let hash = "";
      try { hash = String(await codec.md5Hex(entry.bytes)).toLowerCase(); } catch { continue; }
      if (light.hashes.has(hash)) assign(String(entry.name), "light");
      else if (dark.hashes.has(hash)) assign(String(entry.name), "dark");
    }
  }
  return {byName, light, dark};
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
  // 双模式包先用 theme.json 的 light / dark 绑定判定归属：只有文件名带 light/dark
  // 的条目能靠路径认出来，UUID 目录里的夜间资源必须靠块里的 ID 才能认出来，
  // 否则就会把日夜两套图一左一右拼在一起。
  const modeIndex = await themeModeIndex(entries, codec);
  let images;
  if (modeIndex) {
    const lightImages = allImages.filter(item => modeIndex.byName.get(item.entry.name) === "light");
    const darkImages = allImages.filter(item => modeIndex.byName.get(item.entry.name) === "dark");
    images = lightImages.length ? lightImages : darkImages.length ? darkImages : allImages.filter(item => !isNightAsset(item.entry.name));
    if (!images.length) images = allImages;
  } else {
    const dayImages = allImages.filter(item => !isNightAsset(item.entry.name));
    images = dayImages.length ? dayImages : allImages;
  }
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
    // 只有一张竖长图、又没有启动图时，它更可能是阅读页背景而不是书架背景：
    // 纯阅读主题就是这么打包的（只有阅读背景 + 高亮图）。误判成书架会让右侧
    // 书架面板显示一张被裁掉的阅读页，所以这种歧义情况一律当作 reader。
    const singlePortrait = shelfBackgrounds.length === 1 && !splash;
    shelf = singlePortrait ? null : (shelfBackgrounds[0] || namedShelf || null);
    const readerBackgrounds = shelfBackgrounds.filter(item => item !== shelf);
    reader = (singlePortrait ? shelfBackgrounds[0] : null) || readerBackgrounds[readerBackgrounds.length - 1] || reader || images.find(item => item.role === "reader") || images.find(item => item.mime === "image/png" && item.width >= 1000 && item.aspect < .7) || null;
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
  // cover 之外的两种模式都是为「不留白」服务的：
  //   contain —— 只给真正该看见全貌的小元素用（轮播图）；
  //   blur    —— 横图塞进竖框时的兜底，用图片自己的放大模糊版铺满背景，
  //              再把完整构图居中叠上去，既不会压成一条横向色带，也没有白边。
  const drawFit = async (item, x, y, width, height, mode = "cover") => {
    if (!item) return;
    let bitmap;
    try { bitmap = await createImageBitmap(new Blob([item.entry.bytes], {type: item.mime})); } catch { return; }
    try {
      const scaleX = width / bitmap.width, scaleY = height / bitmap.height;
      const coverScale = Math.max(scaleX, scaleY);
      const drawWidth = bitmap.width * coverScale, drawHeight = bitmap.height * coverScale;
      context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip();
      if (mode === "blur") {
        const bleed = Math.max(drawWidth, drawHeight) * .08 + 24;
        try { context.filter = "blur(26px) saturate(.92)"; } catch {}
        context.drawImage(bitmap, x + (width - drawWidth) / 2 - bleed, y + (height - drawHeight) / 2 - bleed, drawWidth + bleed * 2, drawHeight + bleed * 2);
        try { context.filter = "none"; } catch {}
        const containScale = Math.min(scaleX, scaleY);
        const innerWidth = bitmap.width * containScale, innerHeight = bitmap.height * containScale;
        context.drawImage(bitmap, x + (width - innerWidth) / 2, y + (height - innerHeight) / 2, innerWidth, innerHeight);
      } else {
        const scale = mode === "contain" ? Math.min(scaleX, scaleY) : coverScale;
        const scaledWidth = bitmap.width * scale, scaledHeight = bitmap.height * scale;
        context.drawImage(bitmap, x + (width - scaledWidth) / 2, y + (height - scaledHeight) / 2, scaledWidth, scaledHeight);
      }
      context.restore();
    } finally { bitmap.close?.(); }
  };
  // 图片和目标框比例相差太多时才启用模糊兜底，正常竖图直接裁切铺满，
  // 这样启动图仍然是「整屏」，不会被糊成两层。
  const fillScene = (item, x, y, width, height) => {
    const aspect = item?.aspect || 1, target = width / height;
    return drawFit(item, x, y, width, height, aspect / target > 1.5 || target / aspect > 1.5 ? "blur" : "cover");
  };
  const clipRoundRect = (x, y, width, height, radius) => {
    context.beginPath();
    if (typeof context.roundRect === "function") { context.roundRect(x, y, width, height, radius); return; }
    const r = Math.min(radius, width / 2, height / 2);
    context.moveTo(x + r, y); context.lineTo(x + width - r, y); context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r); context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height); context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r); context.quadraticCurveTo(x, y, x + r, y); context.closePath();
  };
  // 取一次 32x32 缩略统计平均色：亮度、饱和度、冷暖决定自动分类。
  const sampleTone = () => {
    try {
      const sample = document.createElement("canvas");
      sample.width = 48; sample.height = 48;
      const sampleContext = sample.getContext("2d", {willReadFrequently: true});
      if (!sampleContext) return null;
      sampleContext.drawImage(canvas, 0, 0, 48, 48);
      const data = sampleContext.getImageData(0, 0, 48, 48).data;
      let r = 0, g = 0, b = 0;
      // 色系识别：只对有彩度、亮度适中的像素统计色相，避免白底/黑底/文字把
      // 结果带偏。每个色相区间累计“饱和度×亮度”权重，取最重的一档当主色系。
      const hueBuckets = new Array(12).fill(0);
      const familyBuckets = new Map();
      for (let index = 0; index < data.length; index += 4) {
        const pr = data[index], pg = data[index + 1], pb = data[index + 2];
        r += pr; g += pg; b += pb;
        const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
        const light = (0.299 * pr + 0.587 * pg + 0.114 * pb) / 255;
        const sat = max ? (max - min) / max : 0;
        if (sat < .16 || light < .09 || light > .93) continue;
        let hue = 0;
        const delta = max - min;
        if (delta) {
          if (max === pr) hue = ((pg - pb) / delta) % 6;
          else if (max === pg) hue = (pb - pr) / delta + 2;
          else hue = (pr - pg) / delta + 4;
          hue *= 60; if (hue < 0) hue += 360;
        }
        const weight = sat * Math.min(1, Math.max(.25, light));
        hueBuckets[Math.min(11, Math.floor(hue / 30))] += weight;
        const family = hueColorFamily(hue, sat, light);
        if (family) familyBuckets.set(family, (familyBuckets.get(family) || 0) + weight);
      }
      const pixels = data.length / 4;
      r /= pixels; g /= pixels; b /= pixels;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const dominantHue = hueBuckets.indexOf(Math.max(...hueBuckets));
      const dominantFamily = familyBuckets.size
        ? [...familyBuckets].sort((a, b2) => b2[1] - a[1])[0][0]
        : "";
      return {
        light: (0.299 * r + 0.587 * g + 0.114 * b) / 255,
        saturation: max ? (max - min) / max : 0,
        warm: r >= b + 8,
        hue: dominantHue * 30 + 15,
        hueStrength: Math.max(...hueBuckets),
        colorFamily: dominantFamily,
      };
    } catch { return null; }
  };
  const largestImage = images.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
  const libraryArt = Boolean(splash || shelf || card || carousel || (covers && covers.length));
  if (!libraryArt) {
    // 阅读主题 / 纯高亮主题：包里没有启动图、书架背景和封面。旧逻辑会在左侧画
    // 「无可用阅读页」、右侧留白。这里改成整张缩略图就用面积最大的那张（通常是
    // 阅读页背景），其余高亮图缩成底部一排色块，能直接看出主题观感。
    const hero = reader || largestImage;
    if (!hero) return null;
    const extras = images.filter(item => item !== hero).slice(0, 5);
    const stripHeight = extras.length ? 168 : 0;
    context.fillStyle = "#e9e7df"; context.fillRect(0, 0, 1000, 1000);
    await drawFit(hero, 0, 0, 1000, 1000 - stripHeight, "cover");
    if (extras.length) {
      context.fillStyle = "rgba(24,21,17,.72)"; context.fillRect(0, 1000 - stripHeight, 1000, stripHeight);
      const thumbWidth = 150, thumbHeight = 120, gap = 14;
      const startX = (1000 - (extras.length * thumbWidth + (extras.length - 1) * gap)) / 2;
      for (let index = 0; index < extras.length; index++) {
        const x = startX + index * (thumbWidth + gap);
        await drawFit(extras[index], x, 1000 - stripHeight + 24, thumbWidth, thumbHeight, "cover");
      }
    }
    const tone = sampleTone();
    if (tone) { try { entries.previewTone = tone; } catch {} }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .86));
    try { entries.previewKind = reader ? "reader" : "single"; } catch {}
    entries.previewCategory = themeToneCategories(tone, {kind: entries.previewKind})[0] || "";
    return blob;
  }
  // 左屏按真实手机比例（9:19.5 ≈ .462）铺满，右栏书架也铺满，两栏之间只留
  // 12px 缝。旧版有 16+28px 的外衬、并且用 contain 画启动图，缩略图四周会浮出
  // 一圈白边；书架遇到横图还会被压成一条横向色带，和其他主题看起来不是一套。
  const SCREEN_W = 462, GAP = 12;
  const panelX = SCREEN_W + GAP, panelW = 1000 - panelX, panelH = 1000;
  context.fillStyle = "#e6e2d8"; context.fillRect(0, 0, 1000, 1000);
  const screenAsset = splash || reader || shelf || covers[0] || null;
  if (screenAsset) await fillScene(screenAsset, 0, 0, SCREEN_W, panelH);
  else { context.fillStyle = "#f2ece1"; context.fillRect(0, 0, SCREEN_W, panelH); }
  if (shelf) await fillScene(shelf, panelX, 0, panelW, panelH);
  else { context.fillStyle = "#f2ece1"; context.fillRect(panelX, 0, panelW, panelH); }
  // 书架页上方固定留一条横幅位置给轮播图；包里没有轮播才把整块还给背景。
  // 横幅是宽图，用 cover 会被裁成一条色带，所以这里也走「模糊铺底 + 完整图」。
  const carouselBox = carousel ? {x: panelX + 16, y: 16, w: panelW - 32, h: 400} : null;
  if (carouselBox) {
    context.save();
    clipRoundRect(carouselBox.x, carouselBox.y, carouselBox.w, carouselBox.h, 12); context.clip();
    await drawFit(carousel, carouselBox.x, carouselBox.y, carouselBox.w, carouselBox.h, "blur");
    context.restore();
  }
  if (card) {
    // card_bg 是实际的横版书架卡片，重复几次就能看出主题真实的书架密度。
    const cardX = panelX + 20, cardW = panelW - 40, cardH = 150;
    const firstY = carouselBox ? carouselBox.y + carouselBox.h + 26 : 88, rowGap = 16;
    for (let index = 0; index < Math.min(covers.length, 4); index++) {
      const y = firstY + index * (cardH + rowGap);
      if (y + cardH > panelH - 24) break;
      await drawFit(card, cardX, y, cardW, cardH, "cover");
      const coverW = 92, coverH = 128;
      context.fillStyle = "rgba(20,16,12,.14)"; context.fillRect(cardX + 22, y + 12, coverW + 4, coverH + 4);
      await drawFit(covers[index], cardX + 24, y + 10, coverW, coverH, "cover");
      context.fillStyle = "rgba(70,42,32,.74)";
      context.font = "600 16px system-ui, sans-serif";
      context.fillText(`Reeden 主题 ${index + 1}`, cardX + 136, y + 52);
      context.font = "13px system-ui, sans-serif";
      context.fillText("书架卡片预览", cardX + 136, y + 78);
    }
  } else if (covers.length) {
    // 背景是主题真实的书架图，封面直接浮上去；底部用渐变压暗而不是铺白块，
    // 既保证看得清，又不会在缩略图上再制造一圈白边。
    const shadeTop = carouselBox ? 600 : 520;
    const shade = context.createLinearGradient(0, shadeTop, 0, 1000);
    shade.addColorStop(0, "rgba(16,13,10,0)"); shade.addColorStop(1, "rgba(16,13,10,.5)");
    context.fillStyle = shade; context.fillRect(panelX, shadeTop, panelW, 1000 - shadeTop);
    const cardWidth = 84, cardHeight = 148, gap = 14, columns = 5;
    const startX = panelX + (panelW - (columns * cardWidth + (columns - 1) * gap)) / 2;
    const startY = carouselBox ? 700 : 620;
    for (let index = 0; index < covers.length; index++) {
      const column = index % columns, row = Math.floor(index / columns);
      const x = startX + column * (cardWidth + gap), y = startY + row * (cardHeight + 28);
      if (y + cardHeight > 976) break;
      context.fillStyle = "rgba(10,8,6,.28)"; context.fillRect(x + 3, y + 4, cardWidth, cardHeight);
      await drawFit(covers[index], x, y, cardWidth, cardHeight, "cover");
    }
  }
  const finalTone = sampleTone();
  if (finalTone) { try { entries.previewTone = finalTone; } catch {} }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .86));
  try { entries.previewKind = splash ? "shelf_and_splash" : "shelf_and_reader"; } catch {}
  entries.previewCategory = themeToneCategories(finalTone, {kind: entries.previewKind})[0] || "";
  return blob;
}
// 图集 / 阅读主题 / 高亮包都属于「主题部件」，但预览不能共用书架那套拼贴：
// 图集只有封面，拼书架和手机屏只会出现一堆被裁掉的书封；高亮包是一段段
// 文字底色，塞进 9:19.5 的手机屏会糊成一条色带。这里按部件类型各画一套。
function redPartKind(entries, info = {}) {
  const resourceType = String(info?.header?.resourceType || "");
  const names = (entries || []).map(entry => String(entry?.name || ""));
  if (/coverGallery/i.test(resourceType)) return "gallery";
  if (/highlight/i.test(resourceType)) return "highlight";
  // themeBundle 是完整应用主题（书架 / 封面 / 启动图），不是可拆的部件。
  // 加密包里目录不可读，角色识别可能只认出阅读背景，不能因此判成阅读主题。
  if (/themeBundle/i.test(resourceType)) return "";
  if (names.some(name => /(^|\/)highlight\//i.test(name))) return "highlight";
  // v1 gzip 容器（RED\x01）没有目录结构可看：纯配色阅读主题只有一份
  // theme.json，靠 type 区分阅读配色和高亮规则，否则会被当成普通主题。
  const v1Meta = (() => {
    const entry = (entries || []).find(item => /(^|\/)theme\.json$/i.test(String(item?.name || "")));
    if (!entry?.bytes?.length) return null;
    try { return JSON.parse(new TextDecoder().decode(entry.bytes)); } catch { return null; }
  })();
  const v1Type = String(v1Meta?.type || "");
  if (v1Type === "highlightRule" || v1Type === "highlightRules") return "highlight";
  if (v1Type === "readerColorSchema") return "reader";
  // RED\x02 是「封面图集」专用容器：根目录只有一份 meta.json 和
  // 1.jpg / 2.jpg 这样的序号封面，没有 theme.json。
  if (String(info?.container_format || "") === "red_v2_gallery") return "gallery";
  const rootMeta = names.some(name => /^meta\.json$/i.test(name));
  const rootCovers = names.filter(name => /^[^/]+\.(jpe?g|png|webp|gif|avif)$/i.test(name)).length;
  if (rootMeta && rootCovers > 0 && !names.some(name => /(^|\/)theme\.json$/i.test(name))) return "gallery";
  // v2 加密主题的目录是密文，文件名不可信：认不出部件类型就按普通主题处理。
  if (String(info?.container_format || "") === "red_private_v2") return "";
  const roles = new Set((entries || []).map(entry => entry?.role || previewRole(entry?.name)));
  // 只有「没有书架 / 启动图 / 封面 / 轮播 / 图标」的包才算阅读主题：
  // 完整应用主题里也带 reader_schema，不加这条会把整包误判成部件。
  if (roles.has("reader") && !["shelf", "splash", "cover", "carousel", "card", "icon"].some(role => roles.has(role))) return "reader";
  const sourceName = String(info?.source_name || info?.name || "");
  if (/封面图集|图集/.test(sourceName)) return "gallery";
  if (/高亮/.test(sourceName)) return "highlight";
  return "";
}
async function composeRedPartPreviewBlob(entries, codec, mode) {
  if (!Array.isArray(entries) || !entries.length || typeof createImageBitmap !== "function") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1000; canvas.height = 1000;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const roundPath = (x, y, width, height, radius) => {
    context.beginPath();
    if (typeof context.roundRect === "function") { context.roundRect(x, y, width, height, radius); return; }
    const r = Math.min(radius, width / 2, height / 2);
    context.moveTo(x + r, y); context.lineTo(x + width - r, y); context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r); context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height); context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r); context.quadraticCurveTo(x, y, x + r, y); context.closePath();
  };
  const items = [];
  for (const entry of entries) {
    const mime = codec.mimeFromBytes(entry.bytes, entry.name);
    if (!mime?.startsWith("image/")) continue;
    try {
      const bitmap = await createImageBitmap(new Blob([entry.bytes], {type: mime}));
      items.push({ entry, bitmap, width: bitmap.width, height: bitmap.height });
    } catch {}
  }
  if (!items.length) {
    // 纯配色阅读主题（只有背景色/正文色，没有背景图）以前直接返回 null，
    // 卡片上就只剩「暂无预览」。这里按包里的配色画两页：左侧日间、右侧夜间，
    // 标题用主色、正文用正文色，至少能看出这套阅读主题的观感。
    if (mode !== "reader") return null;
    const themeEntry = entries.find(entry => /(^|\/)theme\.json$/i.test(String(entry?.name || "")));
    let metadata; try { metadata = JSON.parse(new TextDecoder().decode(themeEntry.bytes)); } catch { return null; }
    const list = Array.isArray(metadata?.data) ? metadata.data.filter(item => item && typeof item === "object") : [];
    if (!list.length) return null;
    const colorOf = value => {
      const raw = String(value || "").trim();
      const eight = raw.match(/^#?([0-9a-f]{8})$/i);
      if (eight) return `#${eight[1].slice(2)}`;
      if (/^#?[0-9a-f]{6}$/i.test(raw)) return raw.startsWith("#") ? raw : `#${raw}`;
      return "";
    };
    const day = list.find(item => item.themeMode !== "dark") || list[0];
    const night = list.find(item => item.themeMode === "dark" && item !== day);
    const pages = night ? [day, night] : [day];
    context.fillStyle = "#f2eee5"; context.fillRect(0, 0, 1000, 1000);
    const gap = 24, margin = 48, pageHeight = 880;
    const pageWidth = (1000 - margin * 2 - gap * (pages.length - 1)) / pages.length;
    pages.forEach((item, index) => {
      const x = margin + index * (pageWidth + gap), y = 60;
      roundPath(x, y, pageWidth, pageHeight, 26);
      context.save(); context.clip();
      context.fillStyle = colorOf(item.backgroundColor) || "#fffdf8"; context.fillRect(x, y, pageWidth, pageHeight);
      const ink = colorOf(item.textColor) || "#1d1a15", accent = colorOf(item.primaryColor) || "#8a4a30";
      context.fillStyle = accent; context.fillRect(x + 62, y + 92, 88, 9);
      context.globalAlpha = .9; context.fillRect(x + 62, y + 124, Math.max(80, pageWidth - 124), 24); context.globalAlpha = 1;
      context.fillStyle = ink;
      let lineY = y + 196;
      for (const ratio of [1, .96, 1, .9, .72, 1, .94, .86, 1, .58]) {
        context.globalAlpha = .16 + ratio * .26;
        context.fillRect(x + 62, lineY, Math.max(40, (pageWidth - 124) * ratio), 12);
        lineY += 44;
        if (lineY > y + pageHeight - 96) break;
      }
      context.globalAlpha = 1;
      context.restore();
      context.save();
      roundPath(x + .5, y + .5, pageWidth - 1, pageHeight - 1, 26);
      context.strokeStyle = "rgba(29,26,21,.12)"; context.lineWidth = 1; context.stroke();
      context.restore();
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .86));
    try { entries.previewKind = "reader"; } catch {}
    return blob;
  }
  try {
    // fit=contain 保证封面图 / 高亮条整块可见，不会被卡片比例裁掉。
    const card = (item, x, y, width, height, radius, fit = "contain") => {
      context.save();
      roundPath(x, y, width, height, radius);
      context.fillStyle = "#fffdf8"; context.fill();
      context.clip();
      const scale = (fit === "cover" ? Math.max : Math.min)(width / item.width, height / item.height);
      const drawWidth = item.width * scale, drawHeight = item.height * scale;
      context.drawImage(item.bitmap, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
      context.restore();
      context.save();
      roundPath(x + .5, y + .5, width - 1, height - 1, radius);
      context.strokeStyle = "rgba(29,26,21,.12)"; context.lineWidth = 1; context.stroke();
      context.restore();
    };
    context.fillStyle = "#f2eee5"; context.fillRect(0, 0, 1000, 1000);
    if (mode === "gallery") {
      // 封面图集：只按封面本身的网格排列，不画手机屏和书架。
      // 图集靠 `1.jpg/2.jpg` 的序号排序，预览也按序号排，别按 ZIP 写入顺序。
      const covers = [...items].sort((a, b) => String(a.entry?.name || "").localeCompare(String(b.entry?.name || ""), undefined, {numeric: true})).slice(0, 6);
      const columns = covers.length <= 2 ? covers.length : covers.length <= 4 ? 2 : 3;
      const rows = Math.ceil(covers.length / columns);
      const gap = 18, margin = 54;
      const cellWidth = (1000 - margin * 2 - gap * (columns - 1)) / columns;
      const cellHeight = (1000 - margin * 2 - gap * (rows - 1)) / rows;
      covers.forEach((item, index) => {
        card(item, margin + (index % columns) * (cellWidth + gap), margin + Math.floor(index / columns) * (cellHeight + gap), cellWidth, cellHeight, 20);
      });
    } else if (mode === "highlight") {
      // 单独的高亮包：只排高亮图片本身，一条一块，不掺背景图。
      const strips = items.slice(0, 4);
      const gap = 20, margin = 84;
      const height = Math.min(230, (1000 - margin * 2 - gap * (strips.length - 1)) / strips.length);
      let y = (1000 - (strips.length * height + (strips.length - 1) * gap)) / 2;
      for (const item of strips) { card(item, margin, y, 1000 - margin * 2, height, 18); y += height + gap; }
    } else {
      // 阅读主题：左页是阅读背景，右边是高亮图片，一眼能看出阅读观感。
      const background = items.find(item => item.entry?.role === "reader") || items[0];
      const highlights = items.filter(item => item !== background).slice(0, 3);
      const pageWidth = highlights.length ? 620 : 760;
      const pageX = highlights.length ? 52 : (1000 - pageWidth) / 2;
      const pageY = 70;
      card(background, pageX, pageY, pageWidth, 860, 24, "cover");
      if (highlights.length) {
        const columnX = pageX + pageWidth + 34;
        const columnWidth = 1000 - columnX - 52;
        const gap = 18;
        const height = (860 - gap * (highlights.length - 1)) / highlights.length;
        let y = pageY;
        for (const item of highlights) { card(item, columnX, y, columnWidth, height, 14); y += height + gap; }
      }
    }
    // 阅读主题仍会自动分类，采样口径和主题预览保持一致（亮度 / 饱和 / 主色系）。
    try {
      const sample = document.createElement("canvas");
      sample.width = 48; sample.height = 48;
      const sampleContext = sample.getContext("2d", {willReadFrequently: true});
      if (sampleContext) {
        sampleContext.drawImage(canvas, 0, 0, 48, 48);
        const data = sampleContext.getImageData(0, 0, 48, 48).data;
        let r = 0, g = 0, b = 0;
        for (let index = 0; index < data.length; index += 4) { r += data[index]; g += data[index + 1]; b += data[index + 2]; }
        const pixels = data.length / 4; r /= pixels; g /= pixels; b /= pixels;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let hue = 0; const delta = max - min;
        if (delta) {
          if (max === r) hue = ((g - b) / delta) % 6;
          else if (max === g) hue = (b - r) / delta + 2;
          else hue = (r - g) / delta + 4;
          hue *= 60; if (hue < 0) hue += 360;
        }
        const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const saturation = max ? (max - min) / max : 0;
        try { entries.previewTone = {light, saturation, warm: hue < 90, colorFamily: hueColorFamily(hue, saturation, light), hueStrength: saturation > .18 ? 1.4 : 0}; } catch {}
      }
    } catch {}
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .86));
    try { entries.previewKind = mode; } catch {}
    return blob;
  } finally {
    items.forEach(item => item.bitmap.close?.());
  }
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
  const fallback = {style: fallbackStyle || inferFontCategory({family: fileName}), source: "filename", method: "none", error: "", features: null, specimen: null, family: "", subfamily: ""};
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
      // 解析已成功，顺手用字体内部名称替代文件名，并清掉 FontFace 阶段的残留错误。
      fallback.family = String(parsed?.names?.fontFamily || "").trim();
      fallback.subfamily = String(parsed?.names?.fontSubfamily || "").trim();
      fallback.error = "";
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
    // 样张要能看清字形：画布收紧到 700x300，字号按实际字宽自动收缩，
    // 免得等宽字体的长串被裁掉两边；卡片里按高度铺满显示，字形比原来大一圈。
    const specimenText = "Aa 中文 你好 123";
    const specimenWidth = 700, specimenHeight = 300;
    let specimenSize = 84;
    const measured = Number(advanceOf(specimenText, specimenSize)) || 0;
    if (measured > specimenWidth * 0.88) specimenSize = Math.max(46, Math.floor(specimenSize * specimenWidth * 0.88 / measured));
    const specimen = renderer(specimenText, specimenSize, specimenWidth, specimenHeight);
    const context = specimen.getContext("2d");
    context.fillStyle = "#8a94a3"; context.font = "22px sans-serif";
    context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(String(fileName || "").slice(0, 60), specimenWidth / 2, specimenHeight - 38);
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
  if(theme.container_format==='red_v1_gzip')return '阅读主题 · 保留原始 gzip 封装';
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
  if($("#compressionSettingsLabel"))$("#compressionSettingsLabel").textContent=COMPRESSION_PRESET_LABELS[document.querySelector("input[name=compressionPreset]:checked")?.value||"max"]||"自选模式";
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
    const url = downloadUrl(theme.compressed_url || theme.library_url || theme.original_url, redDownloadLabel(theme)+".red");
    return `<article class="compression-result"><div><strong>${escapeHtml(theme.name || theme.source_name || "主题")}</strong><p>${escapeHtml(compressionSummary(theme))}</p><p>${escapeHtml(syncLabel(theme))}</p></div>${url ? `<a class="download-link" href="${escapeHtml(url)}">${requiresOriginalPreservation(theme) ? "下载原样主题" : "下载压缩 RED"}</a>` : ""}</article>`;
  }).join("");
}
/* 主题分类 ---------------------------------------------------------------
   自动分类不猜「这是什么类型的图」——那需要人工标注的数据集；改成读预览图的
   整体色调（亮度 / 饱和度 / 冷暖），这是能可靠算出来的，而且和用户挑主题的
   直觉一致。类别词表存在本地，可以随时增删；每个主题的分类写在记录的
   categories 字段里，跟着同步走。 */
const THEME_CATEGORY_KEY = "reeden-theme-categories";
const DEFAULT_THEME_CATEGORIES = ["暖色", "冷色", "暗色", "明亮", "低饱和", "阅读主题", "红色系", "橙色系", "黄色系", "绿色系", "青色系", "蓝色系", "蓝紫系", "紫色系", "粉色系", "灰色系", "黑色系", "白色系"];
function themeCategoryVocabulary() {
  try {
    const raw = JSON.parse(localStorage.getItem(THEME_CATEGORY_KEY) || "null");
    if (Array.isArray(raw)) return raw.map(item => String(item || "").trim()).filter(Boolean);
  } catch {}
  return [...DEFAULT_THEME_CATEGORIES];
}
function saveThemeCategoryVocabulary(list) {
  const cleaned = [...new Set((list || []).map(item => String(item || "").trim()).filter(Boolean))].slice(0, 40);
  try { localStorage.setItem(THEME_CATEGORY_KEY, JSON.stringify(cleaned)); } catch {}
  return cleaned;
}
// 色相 → 色系。中文本地语境里粉/紫单独成系比并进红/蓝更直观。
function hueColorFamily(hue, saturation = 1, light = .5) {
  if (saturation < .13) return light > .82 ? "白色系" : light < .24 ? "黑色系" : "灰色系";
  const h = ((Number(hue) || 0) % 360 + 360) % 360;
  if (h < 12 || h >= 345) return "红色系";
  if (h < 38) return "橙色系";
  if (h < 66) return "黄色系";
  if (h < 95) return "绿色系";
  if (h < 165) return "青色系";
  if (h < 200) return "蓝色系";
  if (h < 255) return "蓝紫系";
  if (h < 290) return "紫色系";
  if (h < 320) return "粉色系";
  return "红色系";
}
// 「阅读主题」这个分类只给 RED\x01 阅读配色包。加密应用主题（RED\x10）的目录
// 是密文，预览可能只认出阅读背景，不能因此被归成阅读主题——否则主题库里的
// 正常应用主题会被打上错误标签、甚至被迁进收藏库。
function isReaderThemePackage(previewDetails = {}) {
  const container = String(previewDetails.container || previewDetails.container_format || "");
  if (container) return container === "red_v1_gzip";
  return previewDetails.kind === "reader";
}
function themeToneCategory(tone, previewDetails = {}) {
  if (!tone) return isReaderThemePackage(previewDetails) ? "阅读主题" : "";
  const light = Number(tone.light) || 0, saturation = Number(tone.saturation) || 0;
  // 有明确主色相时优先给色系，这是用户要的“试着识别色系”；亮度档仍单独保留
  // 一份（下面 themeCategoryList 会把两者合并），暗色主题一眼能看出来。
  if (tone.colorFamily && (Number(tone.hueStrength) || 0) > 1.2) return tone.colorFamily;
  if (light < .32) return "暗色";
  if (saturation < .14) return light > .78 ? "明亮" : "低饱和";
  return tone.warm ? "暖色" : "冷色";
}
function themeToneCategories(tone, previewDetails = {}) {
  const list = [];
  const primary = themeToneCategory(tone, previewDetails);
  if (primary) list.push(primary);
  if (tone) {
    const light = Number(tone.light) || 0, saturation = Number(tone.saturation) || 0;
    if (light < .32 && primary !== "暗色") list.push("暗色");
    else if (light > .78 && primary !== "明亮" && saturation < .3) list.push("明亮");
    if (tone.colorFamily && tone.colorFamily !== primary) list.push(tone.colorFamily);
  }
  if (isReaderThemePackage(previewDetails) && !list.includes("阅读主题")) list.push("阅读主题");
  return list;
}
function themeCategoryList(theme) {
  const own = Array.isArray(theme?.categories) ? theme.categories : [];
  const auto = Array.isArray(theme?.auto_categories) && theme.auto_categories.length
    ? theme.auto_categories
    : theme?.auto_category ? [theme.auto_category] : [];
  const list = [...new Set([...own, ...auto].map(item => String(item || "").trim()).filter(Boolean))];
  // 旧记录可能带着误判出来的「阅读主题」标签；只有 RED\x01 阅读配色包才保留。
  const container = String(theme?.container_format || "");
  return container && container !== "red_v1_gzip" ? list.filter(item => item !== "阅读主题") : list;
}
function preferredPreview(light, dark) {
  return {url: light || dark || "", label: light ? "日间" : dark ? "夜间补位" : "暂无预览"};
}
function previewCompositionKind(entries) {
  if (entries?.previewKind) return entries.previewKind;
  const roles = (entries || []).map(entry => entry?.role || previewRole(entry?.name));
  if (roles.some(role => role === "splash")) return "shelf_and_splash";
  // 没有启动图、书架、封面、轮播的包就是阅读主题或纯高亮主题，标签不要再说
  // 「书架 + 阅读页」，否则用户会以为漏读了书架素材。
  if (!roles.some(role => ["shelf", "cover", "carousel", "card"].includes(role))) {
    return roles.includes("reader") ? "reader" : "single";
  }
  return "shelf_and_reader";
}
function previewKind(details = {}) {
  if (details?.kind === "shelf_and_splash") return "书架 + 启动";
  if (details?.kind === "shelf_and_reader") return "书架 + 阅读页";
  if (details?.kind === "shelf") return "书架模拟";
  if (details?.kind === "splash") return "启动图";
  if (details?.kind === "reader") return "阅读背景与高亮";
  if (details?.kind === "gallery") return "封面图集";
  if (details?.kind === "highlight") return "高亮图片";
  if (details?.kind === "single") return "主题图片";
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
  if(record.container_format==='red_v1_gzip')return false;
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
  if (!element) return;
  element.hidden = !message;
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
let localResumeBusy=false;
const importIssues=new Map();
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
  const countText = `已完成 ${completed} / ${total}${transferController?.signal.aborted?" · 已暂停":transferState.failed?` · 失败 ${transferState.failed}`:""}`;
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
    if (panel) { panel.hidden = !visible; panel.classList.toggle("is-error", transferState.failed > 0 && !transferController?.signal.aborted); panel.classList.toggle("is-complete", !transferState.active && total > 0); }
  };
  // One shared panel survives clearing the review list.
  paint("transferProgress", Boolean(transferState.title));
  if($('#localResumePanel'))$('#localResumePanel').hidden=transferState.active||!localTransferRows.length;
  $('#pauseTransfer').hidden=!transferState.active||!transferController;$('#pauseTransfer').disabled=!!transferController?.signal.aborted;
  const settings=$('#compressionSettings');if(settings){settings.hidden=transferState.active;if(transferState.active)settings.open=false;}
  const bar=$('#transferProgressBar');if(transferState.active)bar.removeAttribute('value');

  persistJobProgress({status: transferState.active ? "running" : "completed", stage: stageText,
    current: currentText, completed: transferState.completed, failed: transferState.failed, total});
}
function revealTransferProgress() {
  const panel = $("#transferProgress");
  if (!panel || panel.hidden) return;
  try { panel.scrollIntoView({block: "nearest", behavior: "smooth"}); } catch { panel.scrollIntoView(); }
}
function beginTransferProgress(title, total, items = [], options = {}) {
  if(!transferController || !commitBatchBusy)transferController=new AbortController();
  transferStartedAt=Date.now();$("#transferElapsed").textContent="已用 0:00";clearInterval(transferClock);transferClock=setInterval(()=>{
    const seconds=Math.floor((Date.now()-transferStartedAt)/1000);$('#transferElapsed').textContent=`已用 ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  },1000);
  activeCloudJob = null; cloudJobPatch = null; clearTimeout(cloudJobTimer);
  Object.assign(transferState, { active: true, title, total: Math.max(0, Number(total) || 0), completed: 0, failed: 0, stage: "准备处理", current: "" });
  updateTransferProgress();
  revealTransferProgress();
  if(options.persist!==false)createCloudJob(title, total, items).catch(() => {});
}
function transferStage(stage, current = "") {
  if(transferController?.signal.aborted)return;
  updateTransferProgress({ active: true, stage, current });
}
function transferDone(current = "", failed = false) {
  updateTransferProgress({ completed: transferState.completed + 1, failed: transferState.failed + (failed ? 1 : 0), current });
}
function finishTransferProgress(message, failed = transferState.failed) {
  clearInterval(transferClock);if(transferController?.signal.aborted)message=backupPhaseActive?"R2 已入库；123 备份已暂停，可稍后重试":"已暂停，未完成文件保留，可继续上传";
  updateTransferProgress({ active: false, title: message, stage: backupPhaseActive?(transferController?.signal.aborted?"123 备份已暂停":failed?"123 备份待重试":"123 备份完成"):transferController?.signal.aborted?"已暂停，文件保留":failed ? "处理完成，但有项目失败" : "全部完成", current: failed ? `失败 ${failed} 项，可查看错误后重试` : "已写入共享 R2" });
  const finalPatch = {...(cloudJobPatch || {}), status: failed ? "partial" : "completed", stage: message,
    completed: transferState.completed, failed, total: transferState.total, result: message};
  cloudJobPatch = null; clearTimeout(cloudJobTimer);
  const id = activeCloudJob; activeCloudJob = null;
  if (id) sendCloudJobPatch(finalPatch, id);
}
function r2Enabled() { return browserSyncEnabled() || state.storage?.library?.provider === "cloudflare_r2"; }
/**
 * 设置是否真的有「没保存的修改」。
 * 浏览器同步模式下这张表单是隐藏的，它的字段根本不参与上传，
 * 这时残留的 storageDirty 不该再拦住上传（那正是「刷新后必须重新保存一次」的老毛病）。
 */
function storageSettingsPending() {
  if (state.storage?.mode === "browser-local") return false;
  return storageDirty;
}
function autoSyncEnabled() { return browserSyncEnabled() || (r2Enabled() && state.storage?.library?.autoSync); }
function savedToCloud(record) { return record.saved_to_cloud === true || (record.sync_status?.library === "synced" && record.local_status === "cloud_only" && !record.sync_error); }
function pendingIds() { return state.pending.map(item => item.id); }
function eligibleIds(kind) {
  if (kind === "review") return [...state.review.filter(item => !isAssetBusy("staging", item.staging_id)).map(item => item.staging_id), ...pendingIds()];
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  return collection.filter(item => !savedToCloud(item) && !isAssetBusy(kind, item.id)).map(item => item.id);
}
function selectableIds(kind) {
  if (kind === "review") return [...state.review.filter(item => !isAssetBusy("staging", item.staging_id)).map(item => item.staging_id), ...pendingIds()];
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  return collection.filter(item => !isAssetBusy(kind, item.id)).map(item => item.id);
}
function selectInput(kind, id, name, disabled = false) {
  return `<input class="item-select" type="checkbox" data-selection="${kind}" data-id="${escapeHtml(id)}" aria-label="选择${escapeHtml(name)}" ${selections[kind].has(id) ? "checked" : ""} ${disabled || state.operation ? "disabled" : ""} />`;
}
function bulkHint(button) {
  const toolbar = button?.closest(".bulk-toolbar");
  if (!toolbar) return null;
  let hint = toolbar.querySelector(".bulk-hint");
  if (!hint) { hint = document.createElement("span"); hint.className = "bulk-hint"; hint.setAttribute("role", "status"); button.after(hint); }
  return hint;
}
function updateBulkControls() {
  if(state.storage)refreshSettingsControls();
  $('#resumeLocalTransfers').disabled=localResumeBusy||Boolean(state.operation)||commitBatchBusy;
  $('#discardLocalTransfers').disabled=localResumeBusy||Boolean(state.operation)||commitBatchBusy;
  $('#retryImportIssues').disabled=localResumeBusy||Boolean(state.operation)||commitBatchBusy;
  const toolbars = [
    ["review", "selectAllReview", "reviewSelectedCount", "commitSelectedThemes"],
    ["theme", "selectAllThemes", "themeSelectedCount", "syncSelectedThemes"],
    ["font", "selectAllFonts", "fontSelectedCount", "syncSelectedFonts"],
    ["asset", "selectAllAssets", "assetSelectedCount", "syncSelectedAssets"],
  ];
  toolbars.forEach(([kind, checkboxId, countId, buttonId]) => {
    const ids = selectableIds(kind);
    const available = new Set(ids);
    const matching = kind === "review" ? ids : filterLibrary(kind).map(item => item.id).filter(id => available.has(id));
    const checkedMatches = matching.filter(id => selections[kind].has(id)).length;
    for (const id of selections[kind]) if (!available.has(id)) selections[kind].delete(id);
    const count = selections[kind].size;
    const checkbox = $("#" + checkboxId);
    checkbox.checked = matching.length > 0 && checkedMatches === matching.length;
    checkbox.indeterminate = checkedMatches > 0 && checkedMatches < matching.length;
    checkbox.disabled = Boolean(state.operation) || !matching.length;
    $("#" + countId).textContent = count === checkedMatches ? `已选 ${count} 项` : `已选 ${count} 项（${count - checkedMatches} 项在筛选范围外）`;
    const clear = $(`[data-clear-selection="${kind}"]`);
    if (clear) { clear.hidden = !count; clear.disabled = Boolean(state.operation); }
    const syncButton = $("#" + buttonId);
    if (syncButton) {
      const eligibleSyncIds = new Set(eligibleIds(kind));
      const syncCount = [...selections[kind]].filter(id => eligibleSyncIds.has(id)).length;
      const blocked = Boolean(state.operation) || !storageReady || storageSettingsPending() || !syncCount || (["theme", "font", "asset"].includes(kind) && !r2Enabled());
      // 禁用态按钮按下去毫无反应，用户只会看到「点不动」。改成「看起来灰着、
      // 点一下就告诉你为什么」，保证每次点击都有反馈；真正的拦截条件仍在
      // 处理函数里逐条校验并给出提示。
      syncButton.disabled = false;
      syncButton.setAttribute("aria-disabled", blocked ? "true" : "false");
      syncButton.classList.toggle("is-blocked", blocked);
      // 按钮不可用时必须把原因摆在明面上。
      const reason = state.operation ? "正在处理中，请等当前任务结束"
        : !storageReady ? "正在读取存储配置，请稍候…"
        : storageSettingsPending() ? "设置有未保存的修改，先在「设置」保存再上传"
        : !syncCount ? (count ? "所选条目暂时不能上传，请重新勾选" : "先勾选要处理的条目，或点「全选」")
        : (["theme", "font", "asset"].includes(kind) && !r2Enabled()) ? "未连接共享库，先在「设置」填写同步 API 地址"
        : "";
      syncButton.title = reason;
      const hint = bulkHint(syncButton);
      if (hint) { hint.textContent = reason; hint.hidden = !reason; }
    }
    const deleteButton = $("#deleteSelected" + kind[0].toUpperCase() + kind.slice(1));
    if (deleteButton) deleteButton.disabled = Boolean(state.operation) || !count;
    const downloadButton = $("#downloadSelected" + kind[0].toUpperCase() + kind.slice(1));
    if (downloadButton) downloadButton.disabled = Boolean(state.operation) || !count;
    // Phones pin the bulk bar only while something is selected; otherwise it
    // would eat 96px at the top of every scroll for nothing.
    const bar = $("#" + kind + "Toolbar");
    if (bar) bar.classList.toggle("has-selection", count > 0 || Boolean(selectionModes[kind]));
  });
  for(const kind of ['theme','font','asset']) {
    const selecting=selectionModes[kind]||selections[kind].size>0;
    $(`#${kind}List`).classList.toggle('is-selecting',selecting);
    const toggle=$(`[data-catalog-selection="${kind}"]`);
    toggle.textContent=selecting?'退出多选':'多选';toggle.setAttribute('aria-pressed',String(selecting));toggle.disabled=Boolean(state.operation);
    $(`#${kind}SelectionHint`).hidden=!selecting;
    $$(`#${kind}List .theme-card-hit`).forEach(button=>{
      const id=button.dataset.themeOpen||button.dataset.recordId,record=state[kind+'s'].find(item=>String(item.id)===id);
      const name=kind==='theme'?themeIdentity(record).title:(kind==='font'?record?.family:record?.name)||record?.file_name||'';
      button.setAttribute('aria-label',selecting?`${selections[kind].has(id)?'取消选择':'选择'} ${name}`:`查看 ${name} 的详情`);
      if(selecting)button.setAttribute('aria-pressed',String(selections[kind].has(id)));else button.removeAttribute('aria-pressed');
    });
  }
  $$("#themeDialog form input, #themeDialog form button, #recordDialog form input, #recordDialog form button, #recordDialog [data-record-sync], #recordDialog [data-record-delete]").forEach(input => { input.disabled = Boolean(state.operation); });
  if($("#backupTo123"))$("#backupTo123").disabled=!!state.operation;
  if($("#retryPan123Backups"))$("#retryPan123Backups").disabled=!!state.operation||!state.themes.some(pendingPan123Backup);
  $("#selectDuplicateImports").disabled=![...state.review,...state.pending].some(item=>item.duplicateKind)||!!state.operation;
  $("#removeSelectedImports").disabled=!selections.review.size||!!state.operation;
  const chosenReview = state.review.filter(item => selections.review.has(item.staging_id));
  const chosenPending = state.pending.filter(item => selections.review.has(item.id));
  const pendingFonts = chosenPending.filter(item => item.kind === "font").length;
  const pendingAssets = chosenPending.length - pendingFonts;
  const pendingText = [pendingFonts ? `${pendingFonts} 个字体` : "", pendingAssets ? `${pendingAssets} 个收藏` : ""].filter(Boolean).join("、");
  const privateCount = chosenReview.filter(item => !browserPrivateCompressionEnabled() && requiresOriginalPreservation(item.info)).length;
  const normalCount = chosenReview.length - privateCount;
  const onlyPrivate = privateCount > 0 && normalCount === 0;
  const syncSuffix = browserSyncEnabled() ? "、上传 R2" : autoSyncEnabled() ? "、同步" : "";
  const commitLabel = !chosenReview.length && pendingText
    ? `确认并上传（${pendingText}）`
    : onlyPrivate ? `确认所选并原样保存${syncSuffix}` : `确认所选并压缩${syncSuffix || "保存"}`;
  $("#commitSelectedThemes").textContent = pendingText && chosenReview.length ? `${commitLabel} + ${pendingText}` : commitLabel;
  const basePlan = chosenReview.length ? `${chosenReview.length} 个主题将压缩并重新封包${privateCount ? `；${privateCount} 个当前设备无法认证的加密包先保留原包` : ""}。处理完成后显示压缩前后大小。` : "全选或勾选主题后确认，开始处理。加密主题会先压缩包内图片，再由同步 Worker 认证清单并重新封包。";
  $("#compressionPlan").textContent = [basePlan, compressionEstimate(chosenReview)].filter(Boolean).join(" ");
  syncCompressionControls();
  $("#themeToolbar").hidden = !state.themes.length;
  $("#fontToolbar").hidden = !state.fonts.length;
  $("#assetToolbar").hidden = !state.assets.length;
  // 批量改类别只在主题库出现，状态必须取主题的选中数。之前它写在上面那个
  // 四种 toolbar 的循环里，被最后一次（asset）的 count 覆盖，所以哪怕选了
  // 一堆主题、没选收藏时按钮一直是灰的。
  const bulkCategoryButton = $("#bulkCategoryTheme");
  if (bulkCategoryButton) bulkCategoryButton.disabled = Boolean(state.operation) || !selections.theme.size;
  const bulkAuthorButton = $("#bulkAuthorTheme");
  if (bulkAuthorButton) bulkAuthorButton.disabled = Boolean(state.operation) || !selections.theme.size;
  const eligible = Object.fromEntries(Object.keys(selections).map(kind => [kind, new Set(selectableIds(kind))]));
  $$("[data-selection]").forEach(input => {
    input.checked = selections[input.dataset.selection].has(input.dataset.id);
    input.disabled = Boolean(state.operation) || !eligible[input.dataset.selection].has(input.dataset.id);
    input.closest("article")?.classList.toggle("is-selected", input.checked);
  });
  $$(".sync-theme, .sync-font, .sync-asset").forEach(button => { const kind = button.classList.contains("sync-font") ? "font" : button.classList.contains("sync-asset") ? "asset" : "theme"; button.disabled = Boolean(state.operation) || !r2Enabled() || storageSettingsPending() || button.dataset.completed === "true" || isAssetBusy(kind, button.dataset.id); });
  $$(".delete-record").forEach(button => { const kind = button.dataset.kind; button.disabled = Boolean(state.operation) || isAssetBusy(kind, button.dataset.id); });
  $$(".commit-theme, .discard-review, .rebuild-preview, #chooseThemes, #chooseThemeFolder, #indexThemeFolder, #addThemeButton, #chooseFonts, #chooseFontFolder, #chooseAssets, #chooseAssetFolder, #chooseUnifiedFiles, #chooseUnifiedFolder, #scanButton, #indexExistingCloud, #storageForm button[type='submit']").forEach(button => { button.disabled = Boolean(state.operation); });
  $$(".rebuild-preview").forEach(button => { button.disabled = Boolean(state.operation) || isAssetBusy("theme", button.dataset.id); });
  $("#storageForm button[type='submit']").disabled = Boolean(state.operation) || activeJobs().length > 0;
  $$(".commit-theme").forEach(button => { button.disabled = Boolean(state.operation) || storageSettingsPending(); button.title = storageSettingsPending() ? "请先保存设置" : ""; });
  $$(".retry-job").forEach(button => { button.disabled = Boolean(state.operation) || activeJobs().some(job => (job.parent_id || job.retry_of) === button.dataset.retryJob); });
  $$(".drop-zone").forEach(zone => zone.setAttribute("aria-disabled", String(Boolean(state.operation))));
  updateStorageControls();
}
function setOperation(operation) { state.operation = operation; updateBulkControls(); }
function toggleAll(kind, checked) {
  const available = new Set(selectableIds(kind));
  const ids = kind === "review" ? available : filterLibrary(kind).map(item => item.id).filter(id => available.has(id));
  for (const id of ids) {
    if (checked) selections[kind].add(id);
    else selections[kind].delete(id);
  }
  updateBulkControls();
}
const viewNames = { import: "导入", themes: "主题库", fonts: "字体库", assets: "收藏库", jobs: "后台任务", storage: "设置" };
function setView(view, replace = false) {
  if (!Object.hasOwn(viewNames, view)) view = "themes";
  const changed = state.activeView !== view;
  state.activeView = view;
  if (view !== "storage") stopPan123Qr();
  if (changed) window.scrollTo(0, 0);
  if (location.hash !== `#${view}`) history[replace ? "replaceState" : "pushState"](null, "", `#${view}`);
  $$("[data-view-panel]").forEach(panel => { panel.hidden = panel.dataset.viewPanel !== view; });
  $$(".nav-item").forEach(item => {
    const active = item.dataset.view === view;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  // 底部 tab 只有五个入口，后台任务与设置归到「更多」。
  const tabFor = ["jobs", "storage"].includes(view) ? "more" : view;
  $$(".mobile-tabs .tab-item").forEach(item => {
    const active = item.dataset.tab === tabFor;
    item.classList.toggle("is-active", active);
    if (active && item.dataset.tab !== "more") item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
    if (item.dataset.tab === "more") item.setAttribute("aria-expanded", active ? "true" : "false");
  });
  closeMobileMore();
  $("#topbarTitle").textContent = viewNames[view];
  $("#addThemeButton").hidden = view === "import";
  // During startup the boot sequence already loads storage and then all
  // libraries. Loading here too would race a second, differently-deduplicated
  // request and make the card count flicker between raw and merged records.
  if (state.storage && libraryStarted) {
    if (view === "themes") loadThemes().catch(error => toast(error.message));
    if (view === "fonts") loadFonts().catch(error => toast(error.message));
    if (view === "assets") loadAssets().catch(error => toast(error.message));
  }
  if (libraryStarted && view === "jobs") loadJobs().catch(() => {});
  if (libraryStarted && view === "storage") loadStorage().catch(error => toast(error.message));
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
  // 计数跟当前搜索结果走，否则搜到 2 个黑体却显示「黑体 (120)」。
  const searched = state.fonts.filter(fontMatchesSearch);
  const counts = new Map();
  searched.forEach(font => {
    const category = fontCategory(font);
    counts.set(category, (counts.get(category) || 0) + 1);
  });
  const categories = fontCategoryOptions();
  if (state.fontFilter !== "all" && !categories.includes(state.fontFilter)) state.fontFilter = "all";
  container.innerHTML=`<option value="all">全部分类 (${searched.length})</option>`+categories.filter(category=>counts.get(category)).map(category=>`<option value="${escapeHtml(category)}">${escapeHtml(category)} (${counts.get(category)})</option>`).join('');
  container.value=state.fontFilter;
}
function fontClassificationEditor(font) {
  const style = fontCategory(font);
  const tags = recordTags(font);
  const source = font?.style_source === "glyph" ? (font?.glyph_method === "opentype" ? "字形判定 · 轮廓回退" : "字形判定") : "名称规则";
  return `<div class="record-classifications"><span class="category-chip">分类：${escapeHtml(style)} · ${source}</span>${tags.map(tag => `<span class="category-chip">#${escapeHtml(tag)}</span>`).join("")}</div><details class="font-edit-details"><summary>编辑分类与标签</summary><form class="asset-meta-form record-classification-form" data-record-form="${escapeHtml(font?.id || "")}" data-record-kind="font"><div class="asset-meta-fields"><label>分类<input name="style" value="${escapeHtml(style === "其他" && !font?.style ? "" : style)}" placeholder="宋体、黑体、圆体、手写体" /></label><label>标签<input name="tags" value="${escapeHtml(tags.join(", "))}" placeholder="标签，用逗号分隔" /></label></div><button class="text-button" type="submit">保存分类</button></form></details>`;
}
function fontPreviewMarkup(font) {
  const name = font.family || font.file_name || "字体";
  const fid = escapeHtml(font.id || "");
  // 富样张：进入视口后用真实字体渲染多行文字，能同时看清单字、中文词句、
  // 拉丁字母和数字，比入库时那张单行 JPG 更能判断字体风格。
  // 样张同时给简体和繁体：字形覆盖是选字体时最常看的一点，源文件里那张
  // 单行 JPG 只有「Aa 中文 你好 123」，看不出简繁字形差别。
  // 样张默认就显示（用系统字体 + 「字形加载中」提示），字体到了再换成真实
  // 字形：此前默认 hidden 等 FontFace，一旦新上传的大字体还在下载，卡片就
  // 露出入库时的单行 JPG，看起来像「又变回老样式」。版式必须一直是新版式。
  const hasSource = Boolean(font.view_url || font.url || font.preview_url);
  const specimen = `<div class="font-specimen" data-font-preview-id="${fid}" data-state="${hasSource ? "loading" : "idle"}"><strong class="specimen-hero">中文</strong><span class="specimen-cjk specimen-sc">简体 · 汉字阅读 书写字体</span><span class="specimen-cjk specimen-tc">繁體 · 漢字閱讀 書寫字體</span><span class="specimen-latin">ABCDEFG abcdefg</span><span class="specimen-digits">0123456789 ，。！？</span></div>`;
  // Chromium 的 OTS 会拒掉一部分第三方中文字体，这类字体用 opentype.js
  // 直接描字形轮廓生成样张图，避免永远停在旧的单行 JPG 上。
  const outline = `<img class="font-specimen-outline" data-font-preview-id="${fid}" alt="${escapeHtml(name)} 简繁字形样张" hidden />`;
  // 兜底文本始终留在 DOM：JPG 坏掉且 FontFace 也失败时仍有可读字形。
  const fallback = `<span class="font-preview-fallback" data-font-preview-id="${fid}" hidden>Aa 中文 你好 123</span>`;
  const image = font.preview_url ? `<img class="font-preview-image" alt="${escapeHtml(name)} 字形预览" hidden />` : "";
  const note = `<button class="font-specimen-note" type="button" data-font-retry="${fid}" ${hasSource ? "" : "hidden"}>${hasSource ? "字形加载中…" : ""}</button>`;
  return `<div class="font-preview-frame" data-font-id="${fid}">${image}${specimen}${outline}${fallback}${note}</div>`;
}
// 样张的三种状态：loading 半透明等字体、live 真实字形、fallback 加载失败可重试。
// 状态写在帧上而不是只改 hidden，版式与文案才能统一，不会退回旧单行样张。
function setFontPreviewState(font, state, note) {
  if(!font?.id)return;
  $$(`[data-font-id="${CSS.escape(String(font.id))}"]`).forEach(frame=>{
    const specimen=frame.querySelector(".font-specimen");
    const badge=frame.querySelector(".font-specimen-note");
    if(specimen)specimen.dataset.state=state;
    frame.classList.toggle("is-font-fallback",state==="fallback");
    if(!badge)return;
    if(state==="live"||state==="idle"){badge.hidden=true;return;}
    badge.hidden=false;
    badge.classList.toggle("is-warn",state==="fallback");
    badge.textContent=note||(state==="fallback"?"字形未加载 · 点此重试":"字形加载中…");
  });
}
// 把已加载的字体套回所有同名样张。搜索、翻页、筛选都会重建卡片 DOM，
// 只靠 load() 里那一次 apply() 会让新卡片退回 JPG，看起来像「字形没更新」。
function applyFontSpecimen(font) {
  if(!font?.id)return;
  const outlineUrl=outlinedSpecimenFaces.get(String(font.id));
  $$(`[data-font-id="${CSS.escape(font.id)}"]`).forEach(frame=>{
    const specimen=frame.querySelector(".font-specimen");
    const image=frame.querySelector(".font-preview-image");
    const fallback=frame.querySelector(".font-preview-fallback");
    const outline=frame.querySelector(".font-specimen-outline");
    if(specimen){specimen.style.fontFamily=`font-${font.id}, sans-serif`;specimen.hidden=Boolean(outlineUrl);specimen.dataset.state=outlineUrl?"outline":"live";}
    if(outline&&outlineUrl){outline.src=outlineUrl;outline.hidden=false;}
    if(image)image.hidden=true;
    if(fallback)fallback.hidden=true;
  });
  setFontPreviewState(font,"live");
}
// 字形加载失败时保留新版式，只把提示换成可点重试；点击后清掉失败负缓存重新入队。
function failFontPreview(font, message) {
  failedFontFaces.add(font.id);
  setFontPreviewState(font,"fallback",message||"字形未加载 · 点此重试");
}
function retryFontPreview(font) {
  if(!font?.id)return;
  failedFontFaces.delete(font.id);
  setFontPreviewState(font,"loading");
  enqueueFontPreview(font);
}
// 用 opentype.js 描边出简繁样张：FontFace 加载失败时仍能看到真实字形。
async function drawFontSpecimenOutline(font,url) {
  if(typeof window.opentype?.parse!=="function"||!url)return false;
  try {
    const response=await fetch(url);if(!response.ok)return false;
    const bytes=new Uint8Array(await response.arrayBuffer());
    const parsed=window.opentype.parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    const canvas=document.createElement("canvas");canvas.width=700;canvas.height=300;
    const context=canvas.getContext("2d");if(!context)return false;
    context.fillStyle="#fff";context.fillRect(0,0,700,300);context.fillStyle="#1d1a15";
    for(const line of [{text:"中文",size:92,y:78},{text:"简体 · 汉字阅读 书写字体",size:30,y:158},{text:"繁體 · 漢字閱讀 書寫字體",size:30,y:198},{text:"ABCDEFG abcdefg 0123456789",size:22,y:252}]){
      try {
        const path=parsed.getPath(line.text,0,0,line.size),box=path.getBoundingBox();
        const scale=Math.min(1,660/Math.max(1,box.x2-box.x1));
        context.save();context.translate(350,line.y);context.scale(scale,scale);
        context.translate(-(box.x1+box.x2)/2,0);context.fill(new Path2D(path.toPathData(2)));context.restore();
      } catch {}
    }
    outlinedSpecimenFaces.set(String(font.id),canvas.toDataURL("image/jpeg",0.9));
    return true;
  } catch { return false; }
}
// 富样张按视口懒加载，且同时最多下载 3 个字体文件（单个可达数十 MB），
// 避免一进字体库就把整库字体拉下来。已加载/失败/在途的字体只入队一次。
const fontPreviewQueue=[];
let fontPreviewActive=0;
function pumpFontPreviewQueue() {
  while(fontPreviewActive<3 && fontPreviewQueue.length) {
    const font=fontPreviewQueue.shift();
    fontPreviewActive++;
    loadFontPreviewFace(font,()=>{fontPreviewActive--;pumpFontPreviewQueue();});
  }
}
function enqueueFontPreview(font) {
  if(!font?.id)return;
  // 已经成功加载/描边的字体在新卡片上必须重新套用，否则搜索翻页之后
  // 样张又被 hidden 的初始状态盖回旧 JPG，用户看到的就是「字形没更新」。
  if(loadedFontFaces.has(font.id)||outlinedSpecimenFaces.has(String(font.id))){applyFontSpecimen(font);return;}
  // 失败过的字体只记负缓存、不重下；但重建出来的新卡片要恢复成「可点重试」。
  if(failedFontFaces.has(font.id)){setFontPreviewState(font,"fallback");return;}
  if(loadingFontFaces.has(font.id))return;
  if(fontPreviewQueue.some(item=>item.id===font.id))return;
  fontPreviewQueue.push(font);
  pumpFontPreviewQueue();
}
let fontPreviewObserver;
function observeFontPreviews() {
  if(fontPreviewObserver)fontPreviewObserver.disconnect();
  const frames=$$("#fontList .font-preview-frame");
  if(typeof IntersectionObserver==="undefined"){frames.forEach(frame=>{const font=state.fonts.find(item=>String(item.id)===String(frame.dataset.fontId));if(font)enqueueFontPreview(font);});return;}
  fontPreviewObserver=new IntersectionObserver(entries=>{
    for(const entry of entries) {
      if(!entry.isIntersecting)continue;
      fontPreviewObserver.unobserve(entry.target);
      const font=state.fonts.find(item=>String(item.id)===String(entry.target.dataset.fontId));
      if(font)enqueueFontPreview(font);
    }
  },{rootMargin:"120px"});
  frames.forEach(frame=>fontPreviewObserver.observe(frame));
}
function loadFontPreviewFace(font, done) {
  const finish=()=>{if(typeof done==="function")done();};
  if(!font?.id){finish();return;}
  const apply=()=>applyFontSpecimen(font);
  if(loadedFontFaces.has(font.id)||outlinedSpecimenFaces.has(String(font.id))){apply();finish();return;}
  if(loadingFontFaces.has(font.id)||failedFontFaces.has(font.id)){finish();return;}
  const url = assetUrl(font?.view_url || font?.url);
  // 还没入库的字体没有对象地址：保持新版式但不提示「加载中」，避免一直转。
  if (!url) {setFontPreviewState(font,"idle");finish();return;}
  // 大字体首次从 R2 拉取要几十秒；长时间没有结果就先把提示改成可重试，
  // 请求本身继续，成功后 apply() 会覆盖回真实字形。
  const slow=setTimeout(()=>{if(!loadedFontFaces.has(font.id))setFontPreviewState(font,"fallback");},15000);
  const settle=()=>{clearTimeout(slow);};
  if (typeof FontFace !== "undefined") {
    loadingFontFaces.add(font.id);
    const face = new FontFace(`font-${font.id}`, `url(${JSON.stringify(url)})`);
    face.load().then(loaded => {
      document.fonts.add(loaded);
      loadedFontFaces.add(font.id);
      apply();
    }).catch(async () => {
      // OTS 拒收的第三方中文字体很常见，不能就此放弃：再用 opentype 描边。
      if(await drawFontSpecimenOutline(font,url))apply();
      else failFontPreview(font);
    }).finally(() => {
      settle();
      loadingFontFaces.delete(font.id);
      finish();
    });
    return;
  }
  // 没有 FontFace API（如部分 WebView）时直接走描边路径。
  loadingFontFaces.add(font.id);
  drawFontSpecimenOutline(font,url).then(ok=>{
    if(ok)apply();else failFontPreview(font);
  }).finally(()=>{settle();loadingFontFaces.delete(font.id);finish();});
}
function recoverFontPreviewImage(image) {
  const frame = image.closest(".font-preview-frame");
  if (!frame) return;
  image.remove();
  const font = state.fonts.find(item => String(item.id) === String(frame.dataset.fontId));
  if (font) loadFontPreviewFace(font);
}
function fontCard(font, imported = false) {
  if(!imported)return libraryRecordCard('font',font,fontPreviewMarkup(font),font.author||(font.extension||'font').toUpperCase());
  const name = font.family || font.file_name || "未命名字体";
  const category = fontCategory(font);
  const selection = imported ? "" : selectInput("font", font.id, `字体 ${name}`, isAssetBusy("font", font.id));
  const actions = imported
    ? `<button class="text-button" data-open-view="jobs">查看同步任务</button>`
    : `${savedToCloud(font) ? "" : `<button class="text-button sync-font" data-id="${escapeHtml(font.id)}" data-completed="false">同步字体到 R2</button>`}${font.url ? `<a class="download-link" href="${escapeHtml(downloadUrl(font.url, font.file_name || name))}">下载原字体</a>` : ""}<button class="text-button danger-text delete-record" data-kind="font" data-id="${escapeHtml(font.id)}">删除</button>`;
  return `<article class="font-card ${imported ? "import-font-card" : ""}"><div class="font-card-top">${selection}<span class="category-chip">${escapeHtml(category)}</span></div>${fontPreviewMarkup(font)}<div class="font-card-body"><h3 class="font-name">${escapeHtml(name)}</h3><div class="font-meta"><span>${escapeHtml((font.extension || "font").toUpperCase())}</span><span>${formatBytes(font.bytes)}</span><span>${escapeHtml(syncLabel(font))}</span></div>${font.sync_error ? `<p class="inline-error">${escapeHtml(typeof font.sync_error === "string" ? font.sync_error : Object.values(font.sync_error).join("；"))}</p>` : ""}${font.cleanup_warning ? `<p class="inline-error">${escapeHtml(typeof font.cleanup_warning === "string" ? font.cleanup_warning : Object.values(font.cleanup_warning).join("；"))}</p>` : ""}${imported ? "" : fontClassificationEditor(font)}</div><div class="font-actions">${actions}</div></article>`;
}
function themeMatchesSearch(theme) {
  const needle = String(state.themeSearch || "").trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  return [theme.name, themeIdentity(theme).title, theme.author, theme.file_name, theme.source_name, ...(theme.tags || []), ...themeCategoryList(theme), theme.compression_supported === false ? "加密" : "压缩"].some(value => String(value || "").toLocaleLowerCase("zh-CN").includes(needle));
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
function themeDetailRow(label, value) {
  if (!value) return "";
  return `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}
function renderThemeCategoryFilter() {
  const select = $("#themeCategoryFilter");
  if (!select) return;
  const counts = new Map();
  state.themes.forEach(theme => themeCategoryList(theme).forEach(category => counts.set(category, (counts.get(category) || 0) + 1)));
  const vocabulary = [...new Set([...themeCategoryVocabulary(), ...counts.keys()])];
  if (state.themeCategory !== "all" && !counts.has(state.themeCategory)) state.themeCategory = "all";
  select.innerHTML = `<option value="all">全部类别 (${state.themes.length})</option>` + vocabulary
    .filter(category => counts.has(category))
    .map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)} (${counts.get(category)})</option>`).join("");
  select.value = state.themeCategory;
}
function themeCategoryEditorMarkup(theme) {
  const own = themeCategoryList(theme);
  const vocabulary = themeCategoryVocabulary();
  return `<div class="theme-category-editor" data-theme-categories="${escapeHtml(theme.id)}">
    <div class="theme-category-chips">${own.length ? own.map(category => `<button class="category-chip" type="button" data-category-remove="${escapeHtml(category)}" aria-label="移除类别 ${escapeHtml(category)}">${escapeHtml(category)}<span aria-hidden="true">×</span></button>`).join("") : `<span class="field-help">还没有分类，点下面的常用类别或自己起一个。</span>`}</div>
    <div class="theme-category-add"><input type="text" maxlength="16" placeholder="新类别，例如 深色护眼" aria-label="新建主题类别" /><button class="text-button" type="button" data-category-add>添加</button></div>
    <div class="theme-category-suggest">${vocabulary.filter(category => !own.includes(category)).map(category => `<button class="category-suggest" type="button" data-category-suggest="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("")}</div>
    <details class="theme-category-manage"><summary>管理类别词表</summary><div class="theme-category-vocabulary">${vocabulary.map(category => `<span class="category-chip is-static">${escapeHtml(category)}<button type="button" data-category-forget="${escapeHtml(category)}" aria-label="从词表删除 ${escapeHtml(category)}">×</button></span>`).join("")}</div><p class="field-help">删除词表条目只会让它不再出现在建议里，已归类主题的标签保留。</p></details>
  </div>`;
}
async function patchThemeCategories(theme, categories, autoFields) {
  await ensureRecordReference(theme);
  const body = { record_sha256: theme.record_sha256, author: theme.author === "作者未记录" ? "" : theme.author, style: theme.style || "", tags: theme.tags || [], categories };
  // 删除自动识别的类别时，必须把 auto 字段一起提交，否则 Worker 保留原值，
  // themeCategoryList() 渲染时又把它合并回来，用户看到的就是「删了又复活」。
  if (autoFields) Object.assign(body, autoFields);
  const result = await api(`/api/themes/${encodeURIComponent(theme.id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  Object.assign(theme, result.item || {}, { categories });
  updateCachedRecord(theme);
  return theme;
}
async function saveThemeCategories(themeId, categories, autoFields) {
  const theme = state.themes.find(item => String(item.id) === String(themeId));
  if (!theme || state.operation) return;
  setOperation("theme-categories");
  try {
    await patchThemeCategories(theme, categories, autoFields);
    if (browserSyncEnabled()) saveDeviceSnapshot();
    renderThemes();
    if ($("#themeDialog").open && $("#themeDialog").dataset.themeId === String(themeId)) {
      openThemeDialog(themeId);
      operationMessage($("#themeDialogStatus"), "分类已保存");
    }
    toast("分类已保存");
  } catch (error) { operationMessage($("#themeDialogStatus"), `分类保存失败：${error.message}`, true); toast(`分类保存失败：${error.message}`); }
  finally { setOperation(""); }
}
/* 批量分类：一次给多个主题加/换类别。逐条 PATCH，每条都走和单项编辑
   完全相同的接口，避免出现「批量能改、单条改不了」的两套路径。 */
let bulkCategorySelection = new Set();
function bulkCategoryTargets() {
  return state.themes.filter(theme => selections.theme.has(theme.id));
}
function bulkCategoryMode() {
  return document.querySelector('input[name="bulkCategoryMode"]:checked')?.value || "add";
}
function updateBulkCategoryApply() {
  const button = $("#bulkCategoryApply");
  if (!button) return;
  const targets = bulkCategoryTargets();
  const count = bulkCategorySelection.size;
  const label = count ? `${count} 个类别` : "留空";
  button.textContent = `应用到 ${targets.length} 个主题（${label}）`;
  button.disabled = Boolean(state.operation) || !targets.length || (!count && bulkCategoryMode() !== "replace");
}
function renderBulkCategoryPicks() {
  const picks = $("#bulkCategoryPicks");
  if (!picks) return;
  const targets = bulkCategoryTargets();
  const vocabulary = [...new Set([...themeCategoryVocabulary(), ...targets.flatMap(theme => themeCategoryList(theme))])];
  if (!vocabulary.length) { picks.innerHTML = `<p class="field-help">还没有类别，先在下面起一个。</p>`; return; }
  // 每个类别后面标出「几个主题已经有它」，替换模式下能一眼看出会不会丢标签。
  picks.innerHTML = vocabulary.map(category => {
    const owned = targets.filter(theme => themeCategoryList(theme).includes(category)).length;
    const chosen = bulkCategorySelection.has(category);
    return `<label class="bulk-category-pick${chosen ? " is-chosen" : ""}"><input type="checkbox" value="${escapeHtml(category)}" ${chosen ? "checked" : ""} /><span>${escapeHtml(category)}</span>${owned ? `<em>${owned}</em>` : ""}</label>`;
  }).join("");
  picks.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener("change", () => {
    if (input.checked) bulkCategorySelection.add(input.value); else bulkCategorySelection.delete(input.value);
    input.closest(".bulk-category-pick")?.classList.toggle("is-chosen", input.checked);
    updateBulkCategoryApply();
  }));
}
function openBulkCategoryDialog() {
  const targets = bulkCategoryTargets();
  if (!targets.length) { toast("先勾选要修改的主题"); return; }
  const dialog = $("#bulkCategoryDialog");
  if (!dialog) return;
  bulkCategorySelection = new Set();
  const names = targets.slice(0, 3).map(theme => theme.name || "未命名主题").join("、");
  $("#bulkCategorySub").textContent = `将修改 ${targets.length} 个主题：${names}${targets.length > 3 ? " 等" : ""}`;
  const addMode = document.querySelector('input[name="bulkCategoryMode"][value="add"]');
  if (addMode) addMode.checked = true;
  renderBulkCategoryPicks();
  updateBulkCategoryApply();
  if (!dialog.open) dialog.showModal();
}
function addBulkCategoryFromInput() {
  const input = $("#bulkCategoryInput");
  const values = splitTags(input?.value);
  if (!values.length) { toast("先输入类别名"); return; }
  saveThemeCategoryVocabulary([...new Set([...themeCategoryVocabulary(), ...values])]);
  values.forEach(value => bulkCategorySelection.add(value));
  if (input) input.value = "";
  renderBulkCategoryPicks();
  updateBulkCategoryApply();
}
async function applyBulkThemeCategories() {
  const targets = bulkCategoryTargets();
  if (!targets.length || state.operation) return;
  const replace = bulkCategoryMode() === "replace";
  const picked = [...bulkCategorySelection];
  if (!replace && !picked.length) { toast("先勾选类别"); return; }
  const dialog = $("#bulkCategoryDialog");
  const applyButton = $("#bulkCategoryApply");
  setOperation("theme-categories");
  let done = 0, failed = 0;
  try {
    for (const theme of targets) {
      const own = themeCategoryList(theme);
      const next = replace ? [...picked] : [...own, ...picked.filter(category => !own.includes(category))];
      if (applyButton) applyButton.textContent = `处理中 ${done + failed + 1}/${targets.length}`;
      // 替换模式要连自动识别类别一起清掉，否则 auto_categories 会被 themeCategoryList()
      // 合并回来，replace 看起来没生效；追加模式保留自动类别不动。
      try { await patchThemeCategories(theme, next, replace ? { auto_categories: [], auto_category: "" } : undefined); done++; } catch { failed++; }
    }
    if (browserSyncEnabled()) saveDeviceSnapshot();
    renderThemes();
    dialog?.close();
    toast(failed ? `已更新 ${done} 个主题，${failed} 个失败` : `已把类别写入 ${done} 个主题`);
  } finally { setOperation(""); }
}
/* 批量作者：和单项「名称与作者」编辑走同一个 PATCH 接口，只提交 author，
   后端会保留作品名、类别、标签，避免出现两套互相打架的写入路径。 */
async function patchThemeAuthor(theme, author) {
  await ensureRecordReference(theme);
  const result = await api(`/api/themes/${encodeURIComponent(theme.id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ record_sha256: theme.record_sha256, author }),
  });
  Object.assign(theme, result.item || {});
  updateCachedRecord(theme);
  return theme;
}
function updateBulkAuthorApply() {
  const button = $("#bulkAuthorApply");
  if (!button) return;
  const count = bulkCategoryTargets().length;
  const author = String($("#bulkAuthorInput")?.value || "").trim();
  button.textContent = `应用到 ${count} 个主题${author ? `（${author}）` : "（清空作者）"}`;
  button.disabled = Boolean(state.operation) || !count;
}
function openBulkAuthorDialog() {
  const targets = bulkCategoryTargets();
  if (!targets.length) { toast("先勾选要修改的主题"); return; }
  const dialog = $("#bulkAuthorDialog");
  if (!dialog) return;
  const names = targets.slice(0, 3).map(theme => themeIdentity(theme).title).join("、");
  $("#bulkAuthorSub").textContent = `将修改 ${targets.length} 个主题：${names}${targets.length > 3 ? " 等" : ""}`;
  const input = $("#bulkAuthorInput");
  if (input) { input.value = ""; }
  updateBulkAuthorApply();
  if (!dialog.open) dialog.showModal();
  input?.focus();
}
async function applyBulkThemeAuthors() {
  const targets = bulkCategoryTargets();
  if (!targets.length || state.operation) return;
  const author = String($("#bulkAuthorInput")?.value || "").trim();
  const dialog = $("#bulkAuthorDialog"), applyButton = $("#bulkAuthorApply");
  setOperation("theme-authors");
  let done = 0, failed = 0;
  try {
    await ensureWriteAccess();
    for (const theme of targets) {
      if (applyButton) applyButton.textContent = `处理中 ${done + failed + 1}/${targets.length}`;
      try { await patchThemeAuthor(theme, author); done++; } catch { failed++; }
    }
    if (browserSyncEnabled()) saveDeviceSnapshot();
    renderThemes();
    dialog?.close();
    toast(failed ? `已更新 ${done} 个主题，${failed} 个失败` : `已把作者「${author || "作者未记录"}」写入 ${done} 个主题`);
  } finally { setOperation(""); }
}
function splitTags(value) { return [...new Set(String(value || "").split(/[,，;；\n]+/).map(value => value.trim().slice(0, 24)).filter(Boolean))].slice(0, 30); }
function suggestedTags(record) {
  const tags = [...(record.auto_categories || []), ...(record.categories || [])];
  if (record.kind === "font") tags.push(fontCategory(record), String(record.extension || "").toUpperCase());
  if (record.kind === "asset") tags.push(record.style, String(record.extension || record.asset_type || "").toUpperCase());
  return [...new Set(tags.filter(Boolean))].slice(0, 30);
}
let bulkTagKind = "theme";
function openBulkTags(kind) {
  if (!selections[kind].size) { toast("先勾选需要修改的资源"); return; }
  bulkTagKind = kind;
  $("#bulkTagForm").reset();
  $("#bulkTagTitle").textContent = `批量标签 · ${selections[kind].size} 项`;
  $("#bulkTagStatus").textContent = "自动补标签使用已有类别和格式信息，不读取或上传原文件。";
  $("#bulkTagDialog").showModal();
}
async function applyBulkTags(event) {
  event.preventDefault();
  if (state.operation) return;
  const form = event.currentTarget, kind = bulkTagKind;
  const mode = form.elements.mode.value, picked = splitTags(form.elements.tags.value);
  if (mode !== "auto" && !picked.length && mode !== "replace") { toast("请输入标签，用逗号分隔"); return; }
  const targets = state[kind + "s"].filter(item => selections[kind].has(item.id));
  setOperation("bulk-tags");
  const failures = []; let done = 0, skipped = 0;
  try {
    await ensureWriteAccess();
    if (targets[0]) await ensureRecordReference(targets[0]);
    await mapConcurrent(targets, 3, async record => {
      const own = record.tags || [];
      const tags = mode === "replace" ? picked : mode === "remove" ? own.filter(tag => !picked.includes(tag)) : [...new Set([...own, ...(mode === "auto" ? suggestedTags(record) : picked)])].slice(0, 30);
      if (JSON.stringify(tags) === JSON.stringify(own)) { skipped++; return; }
      try {
        const result = await api(`/api/${recordKindPath(kind)}/${encodeURIComponent(record.id)}`, {
          method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify({record_sha256: record.record_sha256, tags}),
        });
        Object.assign(record, result.item);
        updateCachedRecord(record); done++;
      } catch (error) { failures.push({id: record.id, name: record.name || record.family || record.id, error: error.message}); }
      $("#bulkTagStatus").textContent = `已保存 ${done} / ${targets.length} 项，失败 ${failures.length} 项…`;
    });
    selections[kind] = new Set(failures.map(item => item.id));
    libraryKinds[kind].render();
    $("#bulkTagStatus").textContent = `保存 ${done} 项，无需修改 ${skipped} 项。` + failures.map(item => `${item.name}：${item.error}`).join("；");
    if (!failures.length) $("#bulkTagDialog").close();
    toast(`标签已保存 ${done} 项，失败 ${failures.length} 项`);
  } catch (error) { $("#bulkTagStatus").textContent = error.message; }
  finally { setOperation(""); }
}
async function saveThemeIdentity(themeId, form) {
  const theme = state.themes.find(item => String(item.id) === String(themeId));
  if (!theme || state.operation) return;
  const fields = new FormData(form);
  const author = String(fields.get("author") || "").trim();
  const rawName = String(fields.get("name") || "").trim();
  const name = rawName ? themeIdentity({name: rawName, author}).title : "";
  if (!name) { toast("作品名不能为空"); return; }
  setOperation("theme-identity");
  operationMessage($("#themeDialogStatus"), "正在保存名称与作者…");
  try {
    await ensureRecordReference(theme);
    const result = await api(`/api/themes/${encodeURIComponent(theme.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record_sha256: theme.record_sha256, name, author, style: theme.style || "", tags: theme.tags || [], categories: themeCategoryList(theme) }),
    });
    Object.assign(theme, result.item || {}, {name});
    updateCachedRecord(theme);
    if (browserSyncEnabled()) saveDeviceSnapshot();
    renderThemes();
    if ($("#themeDialog").open && $("#themeDialog").dataset.themeId === String(theme.id)) {
      openThemeDialog(theme.id);
      operationMessage($("#themeDialogStatus"), "名称与作者已保存");
    }
    toast("名称与作者已保存");
  } catch (error) { operationMessage($("#themeDialogStatus"), `保存失败：${error.message}`, true); toast(`保存失败：${error.message}`); }
  finally { setOperation(""); }
}
function openThemeDialog(id) {
  const theme = state.themes.find(item => String(item.id) === String(id));
  const dialog = $("#themeDialog");
  if (!theme || !dialog) return;

  const sameTheme = dialog.open && dialog.dataset.themeId === String(id);
  const expanded = new Set(sameTheme ? $$('.theme-detail-disclosure[open]', dialog).map(item => item.dataset.section) : []);
  const scrollTop = sameTheme ? $('#themeDialogBody').scrollTop : 0;
  const oldForm = sameTheme && state.operation !== 'theme-identity' ? $('.theme-identity-form', dialog) : null;
  const draft = oldForm ? {name: oldForm.elements.name.value, author: oldForm.elements.author.value} : null;
  const identity = themeIdentity(theme);
  const title = identity.title, author = identity.author;
  const preview = preferredPreview(theme.preview_light_url, theme.preview_dark_url);
  const roles = [...new Set((theme.resource_summary || []).map(item => item.role).filter(Boolean))];
  const themeFile = theme.compressed_url || theme.library_url;
  const backup = theme.original_123?.key ? '123 已备份' : theme.original_123_error ? '123 备份失败' : '123 未备份';
  const tags = [...new Set([...themeCategoryList(theme), ...(theme.tags || [])])];
  const compressed = Number(theme.compressed_size || theme.bytes) || 0;
  const original = Number(theme.original_size) || 0;
  const reduction = original > compressed && compressed > 0 ? `节省 ${((1 - compressed / original) * 100).toFixed(1)}%` : '';
  const open = section => expanded.has(section) ? ' open' : '';
  dialog.dataset.themeId = String(id);
  $('#themeDialogTitle').textContent = title;
  $('#themeDialogSub').textContent = author;
  $('#themeDialogBody').innerHTML = `<div class="theme-dialog-preview">${previewImage(preview.url, `${title} · ${previewKind(theme.preview_details)}`, '', theme.preview_details)}${preview.url ? '<p class="preview-hint">点击图片放大</p>' : ''}</div>
    <div class="theme-dialog-details">
      <div class="theme-detail-status"><span class="badge ${savedToCloud(theme) ? 'is-good' : ''}">${escapeHtml(syncLabel(theme))}</span><span class="badge">${backup}</span></div>
      <div class="theme-size-summary">${original && compressed && original !== compressed ? `<span>${formatBytes(original)}</span><span aria-label="压缩为">→</span>` : ''}<strong>${compressed || original ? formatBytes(compressed || original) : '体积未记录'}</strong>${reduction ? `<span class="theme-size-saving">${reduction}</span>` : ''}</div>
      ${tags.length ? `<div class="theme-detail-tags">${tags.slice(0, 5).map(tag => `<span class="category-chip">${escapeHtml(tag)}</span>`).join('')}${tags.length > 5 ? `<span class="field-help">另 ${tags.length - 5} 项</span>` : ''}</div>` : ''}
      <div class="theme-dialog-actions">
        ${themeFile ? `<a class="primary-button" href="${escapeHtml(downloadUrl(themeFile, redDownloadLabel(theme) + '.red'))}">下载主题</a>` : ''}
        ${theme.original_url ? `<a class="secondary-button" href="${escapeHtml(downloadUrl(theme.original_url, redDownloadLabel(theme) + '.original.red'))}">下载原始包</a>` : ''}
        ${themeFile && !savedToCloud(theme) ? '<button class="secondary-button" id="themeDialogSync" type="button">同步到 R2</button>' : ''}
      </div>
      <p class="operation-status" id="themeDialogStatus" role="status" hidden></p>
      ${theme.sync_error ? `<p class="inline-error">${escapeHtml(typeof theme.sync_error === 'string' ? theme.sync_error : Object.values(theme.sync_error).join('；'))}</p>` : ''}
      <div class="theme-detail-editors">
        <details class="theme-detail-disclosure" data-section="identity"${open('identity')}><summary>编辑名称与作者</summary>
          <form class="theme-identity-form" data-theme-identity="${escapeHtml(theme.id)}"><div class="asset-meta-fields"><label>作品名<input name="name" maxlength="200" value="${escapeHtml(draft?.name ?? title)}" required /></label><label>作者<input name="author" maxlength="200" value="${escapeHtml(draft?.author ?? (author === '作者未记录' ? '' : author))}" placeholder="未记录可留空" /></label></div><button class="secondary-button" type="submit">保存名称与作者</button></form>
        </details>
        <details class="theme-detail-disclosure" data-section="categories"${open('categories')}><summary>编辑分类与标签</summary>${themeCategoryEditorMarkup(theme)}
          <form class="theme-tags-form" data-record-form="${escapeHtml(theme.id)}" data-record-kind="theme"><label>标签<input name="tags" value="${escapeHtml((theme.tags || []).join('，'))}" placeholder="用逗号分隔" /></label><button class="secondary-button" type="submit">保存标签</button></form>
        </details>
        <details class="theme-detail-disclosure" data-section="maintenance"${open('maintenance')}><summary>文件信息与维护</summary><dl class="detail-list">
          ${themeDetailRow('源文件', theme.source_name || theme.file_name)}
          ${themeDetailRow('预览内容', previewKind(theme.preview_details))}
          ${themeDetailRow('资源角色', roles.join(' · '))}
          ${themeDetailRow('原始体积', original ? formatBytes(original) : '')}
        </dl><div class="theme-maintenance-actions"><button class="text-button" id="themeDialogRebuild" type="button">更新预览</button><button class="text-button danger-text" id="themeDialogDelete" type="button">删除主题</button></div><p class="field-help">更新预览会读取一次已保存的主题文件，使用最新布局重新生成。</p></details>
      </div>
    </div>`;
  $('#themeDialogBody').scrollTop = scrollTop;
  const categoryEditor = $("#themeDialogBody .theme-category-editor");
  if (categoryEditor) {
    const current = () => themeCategoryList(theme);
    categoryEditor.querySelector("[data-category-add]")?.addEventListener("click", () => {
      const input = categoryEditor.querySelector(".theme-category-add input");
      const value = String(input?.value || "").trim();
      if (!value) { toast("先输入类别名"); return; }
      if (current().includes(value)) { toast("已经有这个类别"); return; }
      const vocabulary = themeCategoryVocabulary();
      if (!vocabulary.includes(value)) saveThemeCategoryVocabulary([...vocabulary, value]);
      saveThemeCategories(theme.id, [...current(), value]);
    });
    categoryEditor.querySelector(".theme-category-add input")?.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      categoryEditor.querySelector("[data-category-add]")?.click();
    });
    categoryEditor.querySelectorAll("[data-category-remove]").forEach(button => button.addEventListener("click", () => {
      const removed = button.dataset.categoryRemove;
      // 自动识别的 tag 存在 auto_categories（或旧版单数 auto_category）里，
      // themeCategoryList() 会把它们和 categories 合并显示。只删 categories 不够，
      // 渲染时又会被合并回来，用户看到的就是「自动生成的 tag 删不掉」。三处一起清。
      const nextCategories = (Array.isArray(theme.categories) ? theme.categories : []).filter(category => category !== removed);
      const nextAuto = (Array.isArray(theme.auto_categories) ? theme.auto_categories : (theme.auto_category ? [theme.auto_category] : [])).filter(category => category !== removed);
      const nextAutoSingle = theme.auto_category && theme.auto_category !== removed ? theme.auto_category : "";
      saveThemeCategories(theme.id, nextCategories, { auto_categories: nextAuto, auto_category: nextAutoSingle });
    }));
    categoryEditor.querySelectorAll("[data-category-suggest]").forEach(button => button.addEventListener("click", () => {
      const value = button.dataset.categorySuggest;
      if (current().includes(value)) return;
      saveThemeCategories(theme.id, [...current(), value]);
    }));
    categoryEditor.querySelectorAll("[data-category-forget]").forEach(button => button.addEventListener("click", () => {
      saveThemeCategoryVocabulary(themeCategoryVocabulary().filter(category => category !== button.dataset.categoryForget));
      openThemeDialog(theme.id);
      toast("已从类别词表移除");
    }));
  }
  $("#themeDialogBody .theme-identity-form")?.addEventListener("submit", event => {
    event.preventDefault();
    saveThemeIdentity(theme.id, event.currentTarget);
  });
  $("#themeDialogSync")?.addEventListener("click", () => { dialog.close(); syncTheme(theme.id); });
  $("#themeDialogRebuild")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = "正在更新…";
    try {
      if (await rebuildPreview(theme.id) && dialog.open && dialog.dataset.themeId === String(theme.id)) {
        openThemeDialog(theme.id);
        operationMessage($('#themeDialogStatus'), '预览已更新');
      }
    }
    finally { button.disabled = false; button.textContent = "更新预览"; }
  });
  $("#themeDialogDelete")?.addEventListener("click", () => { dialog.close(); deleteSelectedRecords("theme", [theme.id]); });
  if (!dialog.open) dialog.showModal();
}
// v2：手机上默认改成双列网格，旧 key 里存的 list 不再沿用，否则老用户
// 打开 APK 还是一行一个主题。
const THEME_DENSITY_KEY = "reeden-theme-density-v2";
// A theme preview is a composite of shelf + splash art, so a square frame at
// full card width pushed every action below the fold. Grid keeps a 16:10 strip,
// list drops it to a 116px thumbnail. Phones now start in grid: two columns fit
// the same information in half the scrolling.
function themeDensityDefault() {
  return "grid";
}
function applyThemeDensity(mode, persist = true) {
  const density = mode === "list" ? "list" : "grid";
  state.themeDensity = density;
  const list = $("#themeList");
  if (list) {
    list.classList.toggle("is-list", density === "list");
    list.classList.toggle("is-grid", density === "grid");
  }
  $$("#themeDensity .density-option").forEach(button => {
    const active = button.dataset.density === density;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (persist) { try { localStorage.setItem(THEME_DENSITY_KEY, density); } catch {} }
}
function restoreThemeDensity() {
  let saved = "";
  try { saved = localStorage.getItem(THEME_DENSITY_KEY) || ""; } catch {}
  applyThemeDensity(saved || themeDensityDefault(), false);
}
const libraryKinds = {
  theme: {name: "主题", render: renderThemes, load: loadThemes},
  font: {name: "字体", render: renderFonts, load: loadFonts},
  asset: {name: "收藏", render: renderAssets, load: loadAssets},
};
const libraryPage = {theme: 1, font: 1, asset: 1};
const librarySort = {theme: "added", font: "added", asset: "added"};
const libraryCollator = new Intl.Collator("zh-CN", {numeric: true, sensitivity: "base"});
function isNewArrival(record) {
  return recentUploadIds.has(`${record.kind}:${record.id}`) || Date.now() - Date.parse(record.imported_at || record.created_at || "") < 86400000;
}
function filterLibrary(kind) {
  return matchingLibrary(kind).filter(record => !recentOnly[kind] || isNewArrival(record));
}
function matchingLibrary(kind) {
  if (kind === "theme") return state.themes.filter(theme => themeMatchesSearch(theme)
    && (state.themeAuthor === "all" || themeAuthorLabel(theme) === state.themeAuthor)
    && (state.themeCategory === "all" || themeCategoryList(theme).includes(state.themeCategory)));
  if (kind === "font") return state.fonts.filter(fontMatchesSearch).filter(fontMatchesCategory);
  return state.assets.filter(assetMatchesFilter);
}
function catalogStatus(kind, message = "", error = false) {
  const status = $(`[data-library-status="${kind}"]`);
  status.hidden = !message;
  status.textContent = message;
  status.classList.toggle("is-error", error);
}
function catalogPage(kind) {
  const visible = filterLibrary(kind);
  const all = state[kind + "s"];
  const name = libraryKinds[kind].name;
  const order = librarySort[kind];
  const label = item => kind === "theme" ? themeIdentity(item).title : item.name || item.family || item.file_name || "";
  const bytes = item => Number(item.compressed_size ?? item.bytes ?? item.original_size) || 0;
  const byName = (a, b) => libraryCollator.compare(label(a), label(b));
  const updated = item => Date.parse(order === "added" || order === "oldest" ? item.imported_at || item.created_at || item.updated_at || "" : item.updated_at || item.created_at || "") || 0;
  visible.sort((a, b) => (order === "name" ? 0 : order === "size" ? bytes(b) - bytes(a) : order === "oldest" ? updated(a) - updated(b) : updated(b) - updated(a)) || byName(a, b));
  const count = $(`#${kind}Count`);
  const noun = kind === "asset" ? "个收藏" : `个${name}`;
  count.textContent = visible.length === all.length ? `${all.length} ${noun}` : `${visible.length} / ${all.length} ${noun}`;
  const empty = $(`#${kind}Empty`);
  empty.hidden = visible.length > 0;
  const filtered = all.length > 0;
  $("h3", empty).textContent = filtered ? `没有匹配的${name}` : `还没有${name}`;
  $("p", empty).textContent = filtered ? "试试其他关键词，或清除筛选。" : {
    theme: "导入一个 .red 文件开始。",
    font: "导入 TTF、OTF、WOFF 或 WOFF2 文件开始。",
    asset: "导入 SVG 或 HTML 文件开始。",
  }[kind];
  $("button", empty).textContent = filtered ? "清除筛选" : "导入文件";
  const pageCount = Math.max(1, Math.ceil(visible.length / THEME_PAGE_SIZE));
  const page = libraryPage[kind] = Math.max(1, Math.min(libraryPage[kind], pageCount));
  try { localStorage.setItem("reeden-browse-v1", JSON.stringify({pages: libraryPage, sort: librarySort, themeSearch: state.themeSearch, themeAuthor: state.themeAuthor, themeCategory: state.themeCategory, fontSearch: state.fontSearch, fontFilter: state.fontFilter, assetSearch: state.assetSearch, assetFilter: state.assetFilter})); } catch {}
  $(`#${kind}Pagination`).hidden = pageCount === 1;
  $(`#${kind}PageInfo`).textContent = `第 ${page} / ${pageCount} 页 · 共 ${visible.length} 项`;
  $(`#${kind}PrevPage`).disabled = page <= 1;
  $(`#${kind}NextPage`).disabled = page >= pageCount;
  const jump=$(`#${kind}PageInput`);jump.max=String(pageCount);jump.value=String(page);jump.setCustomValidity('');
  return visible.slice((page - 1) * THEME_PAGE_SIZE, page * THEME_PAGE_SIZE);
}
async function refreshCatalog(kind) {
  const button = $(`#refresh${kind === "asset" ? "Assets" : kind === "font" ? "Fonts" : "Themes"}`);
  button.disabled = true;
  catalogStatus(kind, `正在刷新${libraryKinds[kind].name}…`);
  try {
    if (remoteUnavailable) {
      remoteUnavailable = false;
      await loadStorage();
    } else {
      await whenStorageReady();
    }
    await libraryKinds[kind].load(true);
  } catch (error) {
    catalogStatus(kind, `刷新失败：${error.message}。请重试。`, true);
  } finally {
    button.disabled = false;
  }
}

function renderThemes() {
  const list = $('#themeList');
  renderThemeAuthorFilter();
  renderThemeCategoryFilter();
  const pageItems = catalogPage('theme');
  list.innerHTML = pageItems.map(theme => {
    const {title, author} = themeIdentity(theme);
    const preview = preferredPreview(theme.preview_light_url, theme.preview_dark_url);
    const categories = themeCategoryList(theme);
    return `<article class="theme-card" data-theme-id="${escapeHtml(theme.id)}">
      <button class="theme-card-hit" type="button" data-theme-open="${escapeHtml(theme.id)}" aria-label="查看 ${escapeHtml(title)} 的详情"></button>
      <div class="theme-preview">${preview.url ? `<div class="theme-thumbnail"><img src="${escapeHtml(assetUrl(preview.url))}" alt="${escapeHtml(title)} 主题预览" loading="lazy" /></div>` : '<span class="preview-empty">暂无预览</span>'}<span class="preview-caption" title="作者：${escapeHtml(author)}">${escapeHtml(author)}</span><button class="theme-more" type="button" data-theme-details="${escapeHtml(theme.id)}" aria-label="查看 ${escapeHtml(title)} 的详情">⋯</button></div>
      <div class="theme-info">${isNewArrival(theme) ? '<span class="arrival-label">新入库</span>' : ''}<div class="item-heading">${selectInput('theme', theme.id, `主题 ${title}`, isAssetBusy('theme', theme.id))}<h3 class="theme-title">${escapeHtml(title)}</h3></div>${categories.length ? `<div class="theme-meta"><span class="theme-categories">${categories.map(category => `<em>${escapeHtml(category)}</em>`).join('')}</span></div>` : ''}${theme.sync_error ? `<p class="inline-error">${escapeHtml(typeof theme.sync_error === 'string' ? theme.sync_error : Object.values(theme.sync_error).join('；'))}</p>` : ''}${theme.cleanup_warning ? `<p class="inline-error">${escapeHtml(typeof theme.cleanup_warning === 'string' ? theme.cleanup_warning : Object.values(theme.cleanup_warning).join('；'))}</p>` : ''}</div>
    </article>`;
  }).join('');
  $$('#themeList [data-theme-open]').forEach(button => button.addEventListener('click', event => {
    const id = button.dataset.themeOpen;
    if (state.operation || isAssetBusy('theme', id)) { toast('请等待当前任务完成'); return; }
    if (selectionModes.theme || selections.theme.size || event.ctrlKey || event.metaKey) {
      if (selections.theme.has(id)) selections.theme.delete(id); else selections.theme.add(id);
      updateBulkControls();
    } else openThemeDialog(id);
  }));
  $$('#themeList [data-theme-details]').forEach(button => button.addEventListener('click', () => openThemeDialog(button.dataset.themeDetails)));
  renderCompressionResults();
  updateBulkControls();
}
/* 字体和收藏也走「待处理」：选完不立刻上传，和主题一起在待确认区勾选，
   点一次按钮统一上传。上传阶段沿用原来的 importFonts / importAssets，
   只是把清理本地文件的弹窗挪到整批结束后合并成一次。 */
const deferredCleanup = [];
async function stagePendingFiles(files, kind) {
  const label = kind === "font" ? "字体" : "收藏";
  const candidates = kind === "font"
    ? [...(files || [])].filter(file => /\.(ttf|otf|woff2?)$/i.test(file.name || ""))
    : [...(files || [])].filter(file => ["svg", "html", "htm", "txt"].includes(assetExtension(file)));
  if (!candidates.length) { toast(kind === "font" ? "请选择 TTF、OTF、WOFF 或 WOFF2 文件" : "请选择 SVG、HTML 或 HTM 文件（.txt 里是 SVG 也能识别）"); return; }
  // 收藏按内容判定：.txt 只有出现 <svg 才当 SVG，纯文本不塞进待确认区。
  const scanned = kind === "font"
    ? candidates.map(file => ({ file, resolved: "font", bytes: null }))
    : await mapConcurrent(candidates, 3, async file => {
        const raw = new Uint8Array(await file.arrayBuffer());
        const resolved = assetKindOf(file, raw);
        // 只有 .txt → SVG 需要裁掉 BOM/空行后再算哈希；其余文件不驻留字节，整批不占内存。
        const bytes = resolved === "svg" && assetExtension(file) !== "svg" ? trimSvgPreamble(raw) : null;
        return { file, resolved, bytes };
      });
  const usable = scanned.filter(item => item.resolved);
  if (!usable.length) { toast(kind === "font" ? "请选择 TTF、OTF、WOFF 或 WOFF2 文件" : "所选文本文件里没有找到 SVG 内容，请确认文件开头有 <svg"); return; }
  if (usable.length < scanned.length) toast(`${scanned.length - usable.length} 个文本文件不包含 SVG，已跳过`);
  const accepted = usable.map(item => item.file);
  await rememberLocalFiles(accepted);
  const hashes = await mapConcurrent(usable, 3, async item => {
    const hash = await crypto.subtle.digest("SHA-256", item.bytes || await item.file.arrayBuffer());
    return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
  });
  let added = 0;
  for (const [fileIndex,file] of accepted.entries()) {
    const duplicate = state.pending.some(item => item.file===file);
    if (duplicate) continue;
    const id = `pending-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    state.pending.push({id, kind, file, sha256:hashes[fileIndex], name: file.name || `${label}文件`, size: Number(file.size) || 0});
    // 手动选进来的文件默认勾上：用户选它就是为了上传，不再要求二次勾选。
    selections.review.add(id);
    added++;
  }
  renderReview();
  toast(added ? `已加入待处理：${added} 个${label}，勾选后统一上传` : `这些${label}已在待处理列表中`);
}
function dropPending(items) {
  const ids = new Set(items.map(item => item.id));
  state.pending = state.pending.filter(item => !ids.has(item.id));
  ids.forEach(id => selections.review.delete(id));
  renderReview();
}
function renderPending() {
  const list = $("#pendingList");
  if (!list) return;
  list.hidden = state.pending.length === 0;
  list.innerHTML = state.pending.map(item => {
    const label = item.kind === "font" ? "字体" : "收藏";
    return `<article class="pending-card" data-pending-id="${escapeHtml(item.id)}"><label class="item-heading">${selectInput("review", item.id, `${label} ${item.name}`)}<strong>${escapeHtml(item.name)}</strong>${item.duplicateKind?'<span class="badge">内容重复</span>':''}</label><span class="badge">${label}</span><span class="pending-size">${formatBytes(item.size)}</span><button class="text-button" type="button" data-pending-remove="${escapeHtml(item.id)}">移除</button></article>`;
  }).join("");
  $$("[data-pending-remove]").forEach(button => button.addEventListener("click", () => {
    removeImportItems([button.dataset.pendingRemove]).catch(error=>toast(error.message));
  }));
}
let commitBatchBusy = false;
async function commitSelection() {
  if (commitBatchBusy) { toast("整批文件仍在处理，请等待字体和主题全部结束"); return; }
  // 早退必须给出原因：以前这里直接 return，用户只看到按钮「没反应」。
  if (state.operation) { toast("正在处理中，请等当前任务结束后再试"); return; }
  await whenStorageReady();
  try { await ensureWriteAccess(); } catch { return; }
  if (storageSettingsPending()) { toast("设置有未保存的修改，请先在「设置」保存后再上传"); return; }
  const themeIds = state.review.filter(item => selections.review.has(item.staging_id)).map(item => item.staging_id);
  const chosen = state.pending.filter(item => selections.review.has(item.id));
  if (!themeIds.length && !chosen.length) { toast("请先勾选要处理的条目，或点「全选」"); return; }
  deferredCleanup.length = 0;deferredPan123.length=0;deferredBackupCleanup.length=0;
  transferController=new AbortController();
  commitBatchBusy = true;
  try {
    if (themeIds.length) await commitThemes(themeIds);
    if(transferController?.signal.aborted)return;
    const fonts = chosen.filter(item => item.kind === "font");
    const assets = chosen.filter(item => item.kind === "asset");
    if (fonts.length) {
      const options = {deferCleanup: true};
      await importFonts(fonts.map(item => item.file), options);
      const failed = new Set(options.failedFiles || []);
      dropPending(fonts.filter(item => !failed.has(item.file)));
    }
    if(transferController?.signal.aborted)return;
    if (assets.length) {
      const options = {deferCleanup: true};
      await importAssets(assets.map(item => item.file), options);
      const failed = new Set(options.failedFiles || []);
      dropPending(assets.filter(item => !failed.has(item.file)));
    }
    if(deferredPan123.length && !transferController?.signal.aborted)await runPan123Backups(deferredPan123);
    // 延后的 123 备份此时已有结果：只有真正备份成功（或复用的旧记录）才清恢复副本。
    if(!transferController?.signal.aborted)for(const entry of deferredBackupCleanup){
      if(entry.reused||entry.record?.original_123?.key)deferredCleanup.push(entry.file);
    }
    deferredBackupCleanup.length=0;
    const remaining = state.pending.length + state.review.length+importIssues.size;
    operationMessage($("#unifiedImportStatus"), remaining ? `仍有 ${remaining} 项待处理或无法读取，原件已保留，见确认区或错误清单。` : "整批上传完成，主题和字体已进入各自资源库，可按最新入库查看。", remaining > 0);
  } finally {
    commitBatchBusy = false;
    // 恢复/暂停按钮的禁用状态依赖 commitBatchBusy；这里清掉后必须刷新一次控件，
    // 否则暂停后「继续上传」永远灰着——用户点了没反应，正是「恢复也无法恢复」。
    updateBulkControls();
    if (deferredCleanup.length && !transferController?.signal.aborted) {
      const files = [...new Set(deferredCleanup)];
      deferredCleanup.length = 0;
      await completeLocalFiles(files);
      offerLocalCleanup(files, `本批 ${files.length} 个文件已上传成功，可以删掉本地副本释放空间。`).catch(error => toast(`本地文件清理失败：${error.message || error}`));
    }
  }
}
function reviewDuplicates() {
  const seenHashes=new Map(),seenNames=new Map();
  for(const item of state.review){
    if(!item.file)continue;
    const hash=item.original_sha256,key=[item.info?.author||'',item.info?.name||''].join('\0');
    const exact=state.themes.filter(record=>hash&&[record.original_sha256,record.sha256].includes(hash));
    const same=exact.length?exact:browserDuplicateCandidates(item.info?.name,item.info?.author);
    const prior=(hash&&seenHashes.get(hash))||seenNames.get(key);
    item.duplicateKind=exact.length || (hash&&seenHashes.has(hash))?'exact':same.length||prior?'name':'';
    item.duplicates=[...same.slice(0,3),...(prior?[{name:prior.info.name,preview_light_url:prior.preview_urls?.light}]:[])];
    if(hash)seenHashes.set(hash,item);if(!seenNames.has(key))seenNames.set(key,item);
  }
  const pending=new Set();
  for(const item of state.pending){const key=item.kind+':'+item.sha256;item.duplicateKind=item.sha256&&(pending.has(key)||state[item.kind==='font'?'fonts':'assets'].some(record=>record.sha256===item.sha256))?'exact':'';pending.add(key);}
}
function selectDuplicateImports() {
  reviewDuplicates();selections.review.clear();
  state.review.filter(item=>item.duplicateKind).forEach(item=>selections.review.add(item.staging_id));state.pending.filter(item=>item.duplicateKind).forEach(item=>selections.review.add(item.id));updateBulkControls();
  toast(`已选中 ${selections.review.size} 项重复或疑似重复；同一批保留第一份。`);
}
async function removeImportItems(ids=[...selections.review]) {
  if(state.operation)return;
  const selected=new Set(ids),themes=state.review.filter(item=>selected.has(item.staging_id)),pending=state.pending.filter(item=>selected.has(item.id));if(!themes.length&&!pending.length)return;
  const files=[...themes,...pending].map(item=>item.file).filter(Boolean),dialog=$('#removeImportDialog');
  const suspected=themes.filter(item=>item.duplicateKind==='name').length;
  $('#removeImportDescription').textContent=`移除 ${themes.length+pending.length} 项待导入文件，已有资源库不受影响。${suspected?`其中 ${suspected} 项仅同名作者，内容可能不同，请先核对。`:''}${files.some(file=>file.archivePath)?'ZIP 原包会保留，不自动删除。':''}`;
  const choice=await new Promise(resolve=>{
    dialog.onclose=()=>resolve(null);const finish=value=>{dialog.close();resolve(value);};$('#removeImportConfirm').onclick=()=>finish({local:false});$('#removeImportWithLocal').onclick=()=>finish({local:true});$('#removeImportCancel').onclick=$('#closeRemoveImport').onclick=()=>finish(null);dialog.oncancel=e=>{e.preventDefault();finish(null);};dialog.showModal();
  });if(!choice)return;
  setOperation('remove-import');
  try {
    for(const item of themes)if(!String(item.staging_id).startsWith('browser-'))await api(`/api/themes/pending/${encodeURIComponent(item.staging_id)}/dismiss`,{method:'POST'});
    await completeLocalFiles(files);
    state.review=state.review.filter(item=>!selected.has(item.staging_id));state.pending=state.pending.filter(item=>!selected.has(item.id));ids.forEach(id=>selections.review.delete(id));
    for(const item of themes)for(const url of Object.values(item.preview_urls||{}))if(String(url).startsWith('blob:'))URL.revokeObjectURL(url);
    renderReview();operationMessage($('#reviewBatchStatus'),`已移除 ${themes.length+pending.length} 项待导入文件。`);
  }catch(error){operationMessage($('#reviewBatchStatus'),error.message,true);return;}finally{setOperation('');}
  if(choice.local){
    const {targets}=cleanupTargets(files.filter(file=>!file.archivePath));if(!targets.length){toast('没有可单独清理的本地原件；ZIP 原包保留');return;}
    const {selected:chosen,bridge}=await openCleanupDialog(targets,'核对后选择要删除的本地原文件。',{note:'这些待导入文件没有上传；疑似重复也可能是不同版本。删除本地原件后可能无法恢复，请核对后勾选。'});
    if(!chosen.length)operationMessage($('#reviewBatchStatus'),'已移出列表，本地原文件保留。');
    if(chosen.length){const result=await performLocalCleanup(chosen,bridge);operationMessage($('#reviewBatchStatus'),`已移除待导入项；本地已删除 ${result.deleted} 个${result.failures.length?'；'+result.failures.map(x=>x.name+'：'+x.reason).join('；'):''}`,!!result.failures.length);}
  }
}
function renderReview() {
  reviewDuplicates();
  const duplicateCount=[...state.review,...state.pending].filter(item=>item.duplicateKind).length;
  $("#selectDuplicateImports").textContent=`选中重复（${duplicateCount}）`;$("#selectDuplicateImports").disabled=!duplicateCount||!!state.operation;
  const area = $("#reviewArea");
  const pendingTotal = state.review.length + state.pending.length;
  area.hidden = pendingTotal === 0;
  $("#reviewCount").textContent = String(pendingTotal);
  // 待处理区只放「选了但还没上传」的字体和收藏，主题有自己的压缩选项卡片。
  $("#reviewToolbar").hidden = pendingTotal === 0;
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
    const privateRebuildable = info.container_format === "red_private_v2" && privateHeaderRepackSupported(item.inspection?.header);
    const redAsset = info.red_asset || "";
    const privateNote = redAsset
      ? `<p class="review-meta">${redAsset}包：收录进收藏库「${redAsset}」分类，保留原文件并保存浏览器生成的预览，不当作阅读主题压缩。</p>`
      : info.container_format === "red_private_v2"
      ? (!privateRebuildable
        ? `<p class="review-meta">私有 RED 包：当前协议暂不支持压缩重封，将保留原包并保存浏览器生成的预览，可正常收录。</p>`
        : browserPrivateCompressionEnabled()
          ? `<p class="review-meta">加密主题：图片会在当前设备压缩，再由同步 Worker 认证清单、更新资源哈希并重新封包。</p>`
          : `<p class="review-meta">加密主题：先在「设置」填好同步 API 地址与 Token，图片就会在当前设备压缩，再由 Worker 认证清单、更新资源哈希并重新封包；未配置时只保存原包。</p>`)
      : info.container_format === "red_v1_gzip" ? '<p class="review-meta">阅读主题：保留原始 gzip 封装，不转换为 ZIP。</p>' : "";
    return `<article class="review-card" data-review-id="${escapeHtml(item.staging_id)}"><div class="review-top"><div><label class="item-heading">${selectInput("review", item.staging_id, `待确认主题 ${info.name || info.source_name}`)}<span class="review-title">${escapeHtml(info.name || info.source_name)}</span></label><div class="review-meta">${escapeHtml(info.author || "作者未记录")} · ${formatBytes(info.bytes)} · ${escapeHtml(info.source_name)}</div></div><span class="badge ${duplicate ? "" : "is-good"}">${duplicate ? (item.duplicateKind==="exact"?"内容完全相同":`疑似重复 ${item.duplicates.length}`) : "未发现同名作者"}</span></div>${privateNote}${duplicate ? `<div class="duplicate-note">${item.duplicateKind==="exact"?"SHA-256 相同，可移除重复导入项。":"库中或本批有同名作者主题，可能为不同版本，请核对。"}</div><div class="duplicate-thumbs">${duplicateThumbs}</div>` : ""}<div class="duplicate-thumbs"><div class="thumb-label">${previewImage(preview.url, `待审核主题${preview.label} · ${previewKind(info.preview_details)}`, "thumb", info.preview_details)}<span>新主题 · ${preview.label}</span><span>${escapeHtml(previewKind(info.preview_details))} · 点击放大</span></div></div>${item.commitError ? `<p class="inline-error">${escapeHtml(item.commitError)}</p>` : ""}<div class="review-actions"><button class="primary-button commit-theme" data-id="${escapeHtml(item.staging_id)}">${redAsset ? "确认并收录到收藏库" : info.container_format === "red_v1_gzip" ? "确认并保存阅读主题" : privateTheme ? "确认并保存原包（配好同步后可压缩）" : "确认并压缩保存"}${autoSyncEnabled() ? "并后台同步" : "（后台处理）"}</button><button class="secondary-button discard-review" data-id="${escapeHtml(item.staging_id)}">暂不处理</button></div></article>`;
  }).join("");
  $$(".commit-theme").forEach(button => button.addEventListener("click", () => commitTheme(button.dataset.id)));
  $$(".discard-review").forEach(button => button.addEventListener("click", () => discardReview(button.dataset.id)));
  renderPending();
  updateBulkControls();
}
function renderFonts() {
  renderFontFilters();
  const visible = catalogPage("font");
  $("#fontList").innerHTML = visible.map(font => fontCard(font)).join("");
  // 样张不再用入库时的单行 JPG 兜底，加载失败就地重试。
  $$("#fontList [data-font-retry]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    const font = state.fonts.find(item => String(item.id) === String(button.dataset.fontRetry));
    if (font) retryFontPreview(font);
  }));
  // 富样张按视口懒加载：滚动到哪加载到哪，同一时刻最多 3 个，避免整库字体
  // 一起下载。已加载过的字体由 loadedFontFaces 去重，不再重复拉取。
  observeFontPreviews();
  $$(".sync-font").forEach(button => button.addEventListener("click", () => syncFont(button.dataset.id)));
  $$(".delete-record[data-kind='font']").forEach(button => button.addEventListener("click", () => deleteSelectedRecords("font", [button.dataset.id])));
  renderImportedFonts();
  updateBulkControls();
}
function fontMatchesSearch(font) {
  const needle = String(state.fontSearch || "").trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  return [font.family,font.name,font.file_name,font.author,fontCategory(font),...recordTags(font)]
    .some(value => String(value || "").toLocaleLowerCase("zh-CN").includes(needle));
}
function fontMatchesCategory(font) {
  return state.fontFilter === "all" || fontCategory(font) === state.fontFilter;
}
function assetTypeLabel(asset) {
  const type = String(asset.asset_type || asset.extension || "").toLowerCase();
  // 图集 / 高亮是 RED 包，不是网页：标签直接显示分类，避免被当成 HTML。
  if (type === "red") return String(asset.red_category || "主题部件");
  return type === "svg" ? "SVG" : "HTML";
}
function assetRedCategory(asset) {
  return String(asset.red_category || asset.category || "").trim();
}
function assetMatchesFilter(asset) {
  const mode = state.assetFilter || "all";
  // 收藏库先按大类分：SVG / HTML / 主题部件（RED 包），再在部件里分图集、高亮。
  const type = String(asset.asset_type || asset.extension || "").toLowerCase();
  if (mode === "svg" && type !== "svg") return false;
  if (mode === "html" && type !== "html" && type !== "") return false;
  if (mode === "red" && type !== "red") return false;
  if (mode === "gallery" && assetRedCategory(asset) !== "图集") return false;
  if (mode === "highlight" && assetRedCategory(asset) !== "高亮") return false;
  if (mode === "reader" && assetRedCategory(asset) !== "阅读主题") return false;
  if (mode === "ungrouped" && (String(asset.author || "").trim() || String(asset.style || "").trim())) return false;
  if (mode === "author" && !String(asset.author || "").trim()) return false;
  if (mode === "style" && !String(asset.style || "").trim()) return false;
  return assetMatchesSearch(asset);
}
function assetMatchesSearch(asset) {
  const needle = String(state.assetSearch || "").trim().toLocaleLowerCase("zh-CN");
  if (!needle) return true;
  return [asset.name, asset.file_name, asset.author, asset.style, assetRedCategory(asset), ...(asset.tags || [])].some(value => String(value || "").toLocaleLowerCase("zh-CN").includes(needle));
}
// 收藏库顶部用「标签页」代替下拉框：参考「进度条收藏夹」，常用分类一眼可见、
// 直接带数量，不必先展开下拉再找。数量跟搜索结果走，和字体库的计数规则一致。
const ASSET_FILTER_TABS = [
  { value: "all", label: "全部" },
  { value: "gallery", label: "封面图集" },
  { value: "highlight", label: "高亮包" },
  { value: "reader", label: "阅读主题" },
  { value: "svg", label: "SVG" },
  { value: "html", label: "HTML" },
  { value: "ungrouped", label: "未分类" },
];
function assetFilterCounts(assets) {
  const counts = { all: assets.length, gallery: 0, highlight: 0, reader: 0, svg: 0, html: 0, ungrouped: 0, red: 0 };
  assets.forEach(asset => {
    const type = String(asset.asset_type || asset.extension || "").toLowerCase();
    if (type === "svg") counts.svg += 1;
    else if (type === "html") counts.html += 1;
    else if (type === "red") counts.red += 1;
    const category = assetRedCategory(asset);
    if (category === "图集") counts.gallery += 1;
    else if (category === "高亮") counts.highlight += 1;
    else if (category === "阅读主题") counts.reader += 1;
    if (!String(asset.author || "").trim() && !String(asset.style || "").trim()) counts.ungrouped += 1;
  });
  return counts;
}
function renderAssetFilterTabs() {
  const container = $("#assetFilterTabs");
  if (!container) return;
  const counts = assetFilterCounts(state.assets.filter(assetMatchesSearch));
  if (state.assetFilter !== "all" && !ASSET_FILTER_TABS.some(tab => tab.value === state.assetFilter)) state.assetFilter = "all";
  // 七个固定分类常驻（数量为 0 也留着）：标签位置稳定，点一下就知道这类是空的，
  // 不会因为数量变化而整排重排。
  container.innerHTML = ASSET_FILTER_TABS
    .map(tab => `<button class="filter-chip asset-filter-tab${tab.value === state.assetFilter ? " is-active" : ""}" type="button" role="tab" aria-selected="${tab.value === state.assetFilter}" data-asset-filter="${tab.value}">${escapeHtml(tab.label)} <span>${counts[tab.value] || 0}</span></button>`)
    .join("");
}
function assetPreview(asset, compact = false) {
  const url = assetUrl(asset.preview_url || asset.object_url || asset.url || "");
  if (!url) return `<div class="asset-preview-empty">暂无预览</div>`;
  const type = assetTypeLabel(asset);
  const rawType = String(asset.asset_type || asset.extension || "").toLowerCase();
  // RED 图集/高亮只有浏览器合成的 JPG 预览；直接给图片，不能塞 iframe。
  if (rawType === "red") {
    const preview = assetUrl(asset.preview_url || "");
    if (!preview) return `<div class="asset-preview-empty">暂无预览</div>`;
    return `<button class="preview-open asset-preview-button" type="button" aria-label="${escapeHtml(asset.name || asset.file_name || type)}，点击放大" data-preview-url="${escapeHtml(preview)}" data-preview-title="${escapeHtml(asset.name || asset.file_name || type)}" data-preview-description="${escapeHtml(type)}预览。"><img src="${escapeHtml(preview)}" alt="${escapeHtml(asset.name || asset.file_name || type)}" loading="lazy" /></button>`;
  }
  if (type === "SVG") return `<button class="preview-open asset-preview-button" type="button" aria-label="${escapeHtml(asset.name || asset.file_name || "SVG")}，点击放大" data-preview-url="${escapeHtml(url)}" data-preview-title="${escapeHtml(asset.name || asset.file_name || "SVG")}" data-preview-description="SVG 收藏预览。"><img src="${escapeHtml(url)}" alt="${escapeHtml(asset.name || asset.file_name || "SVG")}" loading="lazy" /></button>`;
  // A blank sandbox keeps user HTML isolated from the library page while still
  // allowing CSS and markup to render for a useful thumbnail.
  return `<iframe class="asset-html-preview ${compact ? "is-compact" : ""}" title="${escapeHtml(asset.name || asset.file_name || "HTML")} 预览" src="${escapeHtml(url)}" sandbox="" loading="lazy"></iframe>`;
}
function libraryRecordCard(kind,record,preview,caption) {
  const name=(kind==='font'?record.family:record.name)||record.name||record.file_name||'未命名',tags=recordTags(record),id=escapeHtml(record.id);
  // 收藏库里图集 / 高亮要显示自己的分类，不能只靠预览角标的小字。
  const redCategory = kind==='asset' ? assetRedCategory(record) : "";
  // SVG / HTML 也给一个实心分类标签，收藏库一眼能分出网页和主题部件。
  const typeCategory = kind==='asset' ? (redCategory || assetTypeLabel(record)) : "";
  const categories = kind==='font' ? [fontCategory(record)] : record.style ? [record.style] : [];
  // 字体卡片直接放下载入口，不必先点开详情。网络字体用 downloadUrl 的下载
  // 语义（download=1 + name=），本地未同步的字体无地址则不显示按钮。
  const fontDownload=kind==='font' ? downloadUrl(record.download_url||record.object_url||record.url||'',record.file_name||name) : '';
  // 下载入口放在卡片右下角、做成实心按钮：之前是元信息行里一个灰色小字，
  // 在截图里几乎看不见。absolute + z-index 保证它盖在整卡点击层之上。
  const downloadAction=fontDownload?`<a class="download-link catalog-download" href="${escapeHtml(fontDownload)}" download="${escapeHtml(record.file_name||name)}" aria-label="下载字体 ${escapeHtml(name)}">↓ 下载</a>`:'';
  if (kind === 'asset') {
    // 参考「进度条收藏夹」：标题和分类标签在上、小缩略图在下，一张卡只占一列宽，
    // 一屏能扫到十几二十个收藏。卡片只留「分类 + 第一个标签」两段元信息（没标签时
    // 退回作者），文件名、SHA、全部标签留在详情弹窗——之前每张卡 16:9 大图加两行
    // 元信息，四个收藏就占满一屏。
    return `<article class="theme-card catalog-card asset-card asset-compact" data-record-card="asset" data-asset-id="${id}">
    <button class="theme-card-hit" type="button" data-record-open="asset" data-record-id="${id}" aria-label="查看 ${escapeHtml(name)} 的详情"></button>
    <div class="asset-compact-head"><div class="item-heading">${selectInput('asset',record.id,name,isAssetBusy('asset',record.id))}<h3 class="asset-compact-title">${escapeHtml(name)}</h3></div><div class="asset-compact-meta"><span class="theme-categories">${typeCategory?`<em class="is-key">${escapeHtml(typeCategory)}</em>`:''}${tags.length?`<em>${escapeHtml(tags[0])}</em>`:String(record.author||'').trim()?`<em>${escapeHtml(String(record.author).trim())}</em>`:''}</span><span class="asset-compact-size">${record.bytes?formatBytes(record.bytes):''}</span></div></div>
    <div class="theme-preview"><div class="theme-thumbnail catalog-asset-preview">${preview}</div><button class="theme-more" type="button" data-record-details="asset" data-record-id="${id}" aria-label="查看 ${escapeHtml(name)} 的详情">⋯</button></div>
    ${record.sync_error?`<p class="inline-error">${escapeHtml(typeof record.sync_error==='string'?record.sync_error:Object.values(record.sync_error).join('；'))}</p>`:''}
  </article>`;
  }
  return `<article class="theme-card catalog-card ${kind}-card ${downloadAction?'has-download':''}" data-record-card="${kind}" data-${kind}-id="${id}">
    <button class="theme-card-hit" type="button" data-record-open="${kind}" data-record-id="${id}" aria-label="查看 ${escapeHtml(name)} 的详情"></button>
    <div class="theme-preview"><div class="theme-thumbnail catalog-${kind}-preview">${preview}</div><span class="preview-caption">${escapeHtml(caption)}</span><button class="theme-more" type="button" data-record-details="${kind}" data-record-id="${id}" aria-label="查看 ${escapeHtml(name)} 的详情">⋯</button></div>
    <div class="theme-info">${isNewArrival(record)?'<span class="arrival-label">新入库</span>':''}<div class="item-heading">${selectInput(kind,record.id,name,isAssetBusy(kind,record.id))}<h3 class="theme-title">${escapeHtml(name)}</h3></div><div class="theme-meta"><span class="theme-categories">${typeCategory?`<em class="is-key">${escapeHtml(typeCategory)}</em>`:''}${categories.filter(Boolean).map(tag=>`<em>${escapeHtml(tag)}</em>`).join('')}${tags.slice(0,2).map(tag=>`<em>${escapeHtml(tag)}</em>`).join('')}</span><span>${formatBytes(record.bytes)}</span></div>${record.sync_error?`<p class="inline-error">${escapeHtml(typeof record.sync_error==='string'?record.sync_error:Object.values(record.sync_error).join('；'))}</p>`:''}</div>
    ${downloadAction}
  </article>`;
}
function openRecordDialog(kind,id) {
  const record=state[kind+'s'].find(item=>String(item.id)===String(id));if(!record)return;
  const name=(kind==='font'?record.family:record.name)||record.name||record.file_name||'未命名',dialog=$('#recordDialog'),body=$('#recordDialogBody'),font=kind==='font';
  $('#recordDialogTitle').textContent=name;
  $('#recordDialogDescription').textContent=`${font?'字体':assetTypeLabel(record)} · ${formatBytes(record.bytes)} · ${syncLabel(record)}`;
  const url=downloadUrl(record.download_url||record.object_url||record.url||'',record.file_name||name);
  body.innerHTML=`<div class="record-dialog-preview">${font?fontPreviewMarkup(record):assetPreview(record)}</div><div class="record-dialog-fields"><form class="asset-meta-form" data-record-form="${escapeHtml(record.id)}" data-record-kind="${kind}">${font?'':`<label>作者<input name="author" value="${escapeHtml(record.author||'')}" /></label>`}<label>${font?'分类':'风格'}<input name="style" value="${escapeHtml(font?fontCategory(record):record.style||'')}" /></label><label>标签<input name="tags" value="${escapeHtml(recordTags(record).join(', '))}" placeholder="用逗号分隔" /></label><button class="secondary-button" type="submit">保存分类</button></form><div class="record-detail-actions">${url?`<a class="primary-button" href="${escapeHtml(url)}" download="${escapeHtml(record.file_name||name)}">${font?'下载字体':'下载文件'}</a>`:''}${savedToCloud(record)?'':`<button class="secondary-button" data-record-sync>同步到 R2</button>`}<button class="text-button danger-text" data-record-delete>删除</button></div><details><summary>文件信息</summary><p class="field-help">${escapeHtml(font?(record.file_name||''):assetFileNameLabel(record))}<br>SHA ${escapeHtml(record.sha256||'未记录')}</p>${record.cleanup_warning?`<p class="inline-error">${escapeHtml(typeof record.cleanup_warning==='string'?record.cleanup_warning:Object.values(record.cleanup_warning).join('；'))}</p>`:''}</details></div>`;
  const sync=$('[data-record-sync]',body);if(sync)sync.onclick=async()=>{sync.disabled=true;try{await(font?syncFont(id):syncAsset(id));openRecordDialog(kind,id);}finally{sync.disabled=false;}};
  $('[data-record-delete]',body).onclick=async()=>{await deleteSelectedRecords(kind,[id]);if(!state[kind+'s'].some(item=>String(item.id)===String(id)))dialog.close();};
  if(font){$$('[data-font-retry]',body).forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();retryFontPreview(record);}));loadFontPreviewFace(record);}
  if(!dialog.open)dialog.showModal();
  updateBulkControls();
}
function assetCard(asset, imported = false) {
  if(!imported)return libraryRecordCard('asset',asset,assetPreview(asset,true),asset.author||assetTypeLabel(asset));
  const author = String(asset.author || "").trim();
  const style = String(asset.style || "").trim();
  const redCategory = assetRedCategory(asset);
  const tags = Array.isArray(asset.tags) ? asset.tags.filter(Boolean) : [];
  const objectUrl = downloadUrl(asset.download_url || asset.object_url || asset.url || "", asset.file_name || asset.name);
  // 参考「进度条收藏夹」：标题和分类标签在上，预览在下，卡片贴紧排列；
  // 分类编辑收进 details，动作只留必要的几个。
  return `<article class="asset-card ${imported ? "asset-card-imported" : ""}" data-asset-id="${escapeHtml(asset.id || asset.sha256 || "")}">
    <div class="asset-card-body"><div class="asset-card-head"><label class="item-heading">${imported ? "" : selectInput("asset", asset.id, `收藏 ${asset.name || asset.file_name}`, isAssetBusy("asset", asset.id))}<span class="asset-title">${escapeHtml(asset.name || asset.file_name || "未命名收藏")}</span></label><span class="badge">${assetTypeLabel(asset)}</span></div>
      <div class="asset-classifications">${redCategory ? `<span class="category-chip is-key">${escapeHtml(redCategory)}</span>` : ""}${author ? `<span class="category-chip">${escapeHtml(author)}</span>` : ""}${style ? `<span class="category-chip">${escapeHtml(style)}</span>` : ""}${tags.map(tag => `<span class="category-chip">#${escapeHtml(tag)}</span>`).join("")}${!redCategory && !author && !style && !tags.length ? `<span class="category-chip is-empty">未分类</span>` : ""}</div>
    </div>
    <div class="asset-card-preview">${assetPreview(asset, imported)}<span class="preview-caption">${assetTypeLabel(asset)} · ${asset.bytes ? formatBytes(asset.bytes) : ""}</span></div>
    <div class="asset-actions">${savedToCloud(asset) ? "" : `<button class="text-button sync-asset" data-id="${escapeHtml(asset.id || "")}" data-completed="false">同步到 R2</button>`}${objectUrl ? `<a class="download-link" href="${escapeHtml(objectUrl)}" download="${escapeHtml(asset.file_name || asset.name || "asset")}">下载</a>` : ""}<button class="text-button danger-text delete-record" data-kind="asset" data-id="${escapeHtml(asset.id || "")}">删除</button></div>
    <details class="asset-edit"><summary>编辑分类</summary><div class="asset-meta">${escapeHtml(assetFileNameLabel(asset))} · ${asset.bytes ? formatBytes(asset.bytes) : ""} · SHA ${escapeHtml(String(asset.sha256 || "").slice(0, 12))}</div><form class="asset-meta-form" data-record-form="${escapeHtml(asset.id || "")}" data-record-kind="asset"><div class="asset-meta-fields"><label>作者<input name="author" value="${escapeHtml(author)}" placeholder="作者" /></label><label>风格<input name="style" value="${escapeHtml(style)}" placeholder="风格" /></label><label>标签<input name="tags" value="${escapeHtml(tags.join(", "))}" placeholder="标签，用逗号分隔" /></label></div><button class="text-button" type="submit">保存分类</button></form></details>
  </article>`;
}
function renderAssets() {
  const list = $("#assetList");
  const visible = catalogPage("asset");
  list.innerHTML = visible.map(asset => assetCard(asset)).join("");
  renderAssetFilterTabs();
  const legacyFilter = $("#assetCategoryFilter");
  if (legacyFilter) legacyFilter.value = state.assetFilter;
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
  state.assets = [...latest.values()].filter(item => !retiredAssetIds.has(String(item.id)));
  catalogStatus("asset");
  renderAssets();
  renderImportedAssets();
}
async function saveAssetClassification(form) { return saveRecordClassification(form); }
async function saveRecordClassification(form) {
  const kind = form.dataset.recordKind;
  const id = form.dataset.recordForm;
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  // 表单属性取到的 id 是字符串，后端可能返回数字 id；严格相等会静默不保存。
  const record = collection.find(item => String(item.id) === String(id));
  if (!record || state.operation) return;
  const fields = new FormData(form);
  const next = {
    ...record,
    author: fields.has("author") ? String(fields.get("author") || "").trim() : record.author || "",
    style: fields.has("style") ? String(fields.get("style") || "").trim() : record.style || "",
    tags: fields.has("tags") ? splitTags(fields.get("tags")) : record.tags || [],
    updated_at: new Date().toISOString(),
  };
  setOperation("record-classification");
  try {
    await ensureRecordReference(record);
    const result = await api(`/api/${recordKindPath(kind)}/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record_sha256: record.record_sha256, author: next.author, style: next.style, tags: next.tags }),
    });
    Object.assign(next, result.item || result.record || result.asset || {});
    if (browserSyncEnabled()) saveDeviceSnapshot();
    const index = collection.findIndex(item => String(item.id) === String(id));
    if (index >= 0) collection[index] = next;
    updateCachedRecord(next);
    if (kind === "theme") { renderThemes(); if ($("#themeDialog").open && $("#themeDialog").dataset.themeId === id) { openThemeDialog(id); operationMessage($("#themeDialogStatus"), "标签已保存"); } } else if (kind === "font") renderFonts(); else renderAssets();
    toast("分类已保存");
  } catch (error) { if (kind === "theme") operationMessage($("#themeDialogStatus"), `标签保存失败：${error.message}`, true); toast(`分类保存失败：${error.message}`); }
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
  if(browserSyncEnabled() && ["running","uploading"].includes(job.status) && Date.now()-Date.parse(job.updated_at||0)>120000 && !(job.lease?.until>Date.now()))return "已暂停，可继续";
  return { uploading:"暂存原文件", paused:"已暂停", queued: "等待处理", running: "正在处理", completed: "已完成", partial: "部分失败", failed: "处理失败" }[job.status] || "等待处理";
}
function jobItemNames(job) {
  const items = Array.isArray(job.items) ? job.items.map(value => String(value || "").trim()).filter(Boolean) : [];
  return items.length ? items : Array.isArray(job.source_keys) ? job.source_keys.map(String).filter(Boolean) : [];
}
function jobCard(job) {
  const total = Math.max(0, Number(job.total) || 0,job.source_keys?.length||0,job.items?.length||0);
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
  // 统一的删除键：排队中、跑一半、已完成的都能删，不用等任务自己结束。
  const resumeButton = job.kind==='staged-import' && isStagedResumable(job) ? `<button class="secondary-button" data-resume-cloud="${escapeHtml(job.id)}">继续上传</button>` : !['completed'].includes(job.status) && job.kind==='upload' ? '<button class="secondary-button" data-resume-old>恢复或重新选文件</button>' : '';
  const deleteButton = `<button class="secondary-button delete-job" data-delete-job="${escapeHtml(job.id)}" title="删除这条任务记录，进行中的任务也会被删掉">删除</button>`;
  return `<article class="job-card" data-job-id="${escapeHtml(job.id)}"><div class="job-card-head"><div><h3>${escapeHtml(jobTitle(job))}</h3><span class="job-meta">${escapeHtml(jobStatus(job))} · 已处理 ${completed} / ${total} 项</span></div><div class="job-card-actions">${failed.length && !active ? `<button class="secondary-button retry-job" data-retry-job="${escapeHtml(job.id)}" ${state.operation || retrying ? "disabled" : ""}>${retrying ? "已加入重试" : "重试失败项"}</button>` : ""}${resumeButton}${deleteButton}</div></div><div class="job-progress-row"><progress class="job-progress" max="${Math.max(1,total)}" value="${completed}" aria-label="${escapeHtml(jobTitle(job))}进度"></progress><span class="job-percent">${percent}%</span></div><p class="job-detail ${failed.length && !active ? "is-error" : ""}">${escapeHtml(detail)}</p>${itemsLine}${failed.length ? `<details class="job-errors"><summary>${failed.length} 项失败详情</summary><ul>${failed.map(item => `<li><strong>${escapeHtml(item.name || item.id || "文件")}</strong><span>${escapeHtml(item.error || "处理失败")}</span></li>`).join("")}</ul></details>` : ""}</article>`;
}
function renderJobs() {
  const active = activeJobs();
  $("#jobNavCount").hidden = !active.length;
  $("#jobNavCount").textContent = String(active.length);
  if ($("#moreJobCount")) {
    $("#moreJobCount").hidden = !active.length;
    $("#moreJobCount").textContent = String(active.length);
  }
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
  $$(".delete-job").forEach(button => button.addEventListener("click", () => deleteJobRecord(button.dataset.deleteJob)));
  renderCompressionResults();
  renderImportedFonts();
  updateBulkControls();
}
function syncTrackedJobProgress(items) {
  if (!trackedJobIds.size) return;
  const jobs = items.filter(job => trackedJobIds.has(job.id));
  if (!jobs.length) return;
  const current = jobs.find(job => job.status === "running") || jobs.find(job => job.status === "queued") || jobs[jobs.length - 1];
  const active = ["queued", "running"].includes(current.status);
  if (active) {
    updateTransferProgress({
      active: true,
      title: `主题压缩与上传 · ${jobTitle(current)}`,
      total: Math.max(1, Number(current.total) || transferState.total || 1),
      completed: Number(current.completed) || 0,
      failed: Number(current.failed) || 0,
      stage: current.stage || "后台处理中",
      current: current.current || "",
    });
  } else {
    finishTransferProgress(`${jobTitle(current)}：${current.status === "completed" ? "完成" : "已结束"}`, Number(current.failed) || 0);
    jobs.forEach(job => trackedJobIds.delete(job.id));
  }
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
    jobsSnapshotAt = Date.now();
    saveDeviceSnapshot();
    jobsRevision = revision;
    operationMessage($("#jobsStatus"), browserSyncEnabled()
      ? "本机未完成文件可从顶部继续；云端暂存任务可在其他设备接管。关闭网页会暂停压缩，逐文件保留已完成结果。"
      : "任务由本地服务执行。完成记录与失败原因会保留，失败项可单独重试。");
    if (changed) {
      const finished = items.filter(job => previous.has(job.id) && ["queued", "running"].includes(previous.get(job.id)) && !["queued", "running"].includes(job.status));
      if (finished.length) toast(finished.some(job => ["partial", "failed"].includes(job.status)) ? "后台任务有失败项，可在任务页重试" : "后台任务已完成");
      syncTrackedJobProgress(items);
      renderJobs();
      if (hadActive || activeJobs().length || finished.length) await Promise.allSettled([loadThemes(), loadFonts()]);
    }
  } catch (error) { operationMessage($("#jobsStatus"), `暂时无法读取后台任务：${error.message}`, true); }
  finally {
    jobsLoading = false;
    if (activeJobs().length) jobsPollTimer = setTimeout(() => loadJobs().catch(() => {}), document.hidden ? 15000 : 4000);
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
/**
 * 统一的任务删除键：排队中、正在跑、已完成的都能删。
 * Worker 侧已有 DELETE /api/jobs/:id，这里只把本地列表同步掉。
 */
async function deleteJobRecord(id) {
  const jobId = String(id || "");
  if (!jobId) return;
  if (state.operation) { toast("正在处理中，请等当前任务结束后再试"); return; }
  setOperation("job-delete");
  let failed = false;
  try {
    const response = await fetch(apiUrl(`/api/jobs/${encodeURIComponent(jobId)}`), { method: "DELETE", headers: requestHeaders() });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.jobs = state.jobs.filter(job => job.id !== jobId);
    state.importThemeJobIds = state.importThemeJobIds.filter(item => item !== jobId);
    saveSessionIds("reeden-import-theme-jobs", state.importThemeJobIds);
    trackedJobIds.delete(jobId);
    toast("已删除任务");
  } catch (error) {
    failed = true;
    toast(`删除任务失败：${error?.message || error}`);
  } finally { setOperation(""); }
  if (!failed) renderJobs();
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
  state.themes = records.filter(item => (item.kind === "theme" || !item.kind) && !retiredThemeIds.has(String(item.id)));
  catalogStatus("theme");
  renderThemes();
}
async function loadBrowserLibraryRecords(force = false) {
  // 本机快照优先：刚打开网页时内存缓存还是空的，但上次会话留下的快照能直接
  // 命中，省掉一次 R2 记录列举（用户很在意每次开网页都读一次 R2 的流量）。
  if (!force && !browserLibraryRecordsCache) {
    try {
      const saved = JSON.parse(localStorage.getItem(LIBRARY_CACHE_KEY) || "null");
      if (saved && saved.at && (saved.apiBase === apiBase || (!saved.apiBase && !localStorage.getItem(API_BASE_STORAGE_KEY))) && Array.isArray(saved.records)) {
        browserLibraryRecordsCache = latestRecords(saved.records);
        browserLibraryRecordsLoadedAt = saved.at;
      }
    } catch {}
  }
  // 快照命中后不再发起网络读取。想强制刷新时用「刷新」按钮（force=true）。
  const fresh = Array.isArray(browserLibraryRecordsCache);
  if (!force && fresh) return browserLibraryRecordsCache;
  if (browserLibraryRecordsPromise) return browserLibraryRecordsPromise;
  const scope = apiBase;
  browserLibraryRecordsPromise = (async () => {
    const headers=requestHeaders();
    const etag=localStorage.getItem('reeden-index-etag:'+scope);
    if(etag && Array.isArray(browserLibraryRecordsCache))headers.set('If-None-Match',etag);
    const response=await fetchWithReadTimeout(apiUrl('/api/library?all=1'),{headers},30000);
    if(response.status===304){browserLibraryRecordsLoadedAt=Date.now();saveDeviceSnapshot();updateCacheInfo();return browserLibraryRecordsCache;}
    const data=await response.json();if(!response.ok)throw new Error(data.error||`读取失败（${response.status}）`);
    const records=[...(data.items||data.records||[])];
    let cursor=data.cursor;
    while(cursor){const page=await api('/api/library?cursor='+encodeURIComponent(cursor));records.push(...(page.items||page.records||[]));cursor=page.cursor;}
    const nextEtag=response.headers.get('ETag');if(nextEtag)localStorage.setItem('reeden-index-etag:'+scope,nextEtag);
    if (scope !== apiBase) throw new Error("连接已切换，旧库读取结果已忽略");
    browserLibraryRecordsCache = latestRecords(records);
    browserLibraryRecordsLoadedAt = Date.now();
    saveDeviceSnapshot();
    updateCacheInfo();
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
async function discardReview(id) { return removeImportItems([id]); }

async function loadFonts(force = false) {
  const records = browserSyncEnabled() ? await loadBrowserLibraryRecords(force) : latestRecords((await api("/api/fonts")).items || []);
  state.fonts = records.filter(item => item.kind === "font").map(font => ({ ...font, style: String(font.style || "").trim() || inferFontCategory(font) }));
  catalogStatus("font");
  renderFonts();
}
function loadStorage(force = false) {
  if (storageReadyPromise) return storageReadyPromise;
  if (!force && state.storage && storageReady) return Promise.resolve();
  storageReadyPromise = fetchStorage().finally(() => { storageReadyPromise = null; });
  return storageReadyPromise;
}
async function fetchStorage() {
  try {
    const data = await api("/api/storage");
    state.storage = data;
    try { localStorage.setItem(STORAGE_SNAPSHOT_KEY, JSON.stringify({apiBase, at: Date.now(), data})); } catch {}
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
  } catch (error) {
    // 网络暂不可达时沿用本机快照中的存储配置，别把已保存的设置「读丢」。
    if (!state.storage) throw error;
    renderStorageSummary(state.storage);
  } finally {
    storageReady = true;
    updateBulkControls();
  }
}
/**
 * 等存储配置读回来再决定走哪条上传链路。
 * 刷新后立刻点上传时，旧逻辑会误判成「本机后端模式」把请求发给同步 Worker，
 * 结果是 404，用户只能再手动保存一次设置。
 */
function whenStorageReady() {
  if (storageReady) return Promise.resolve();
  return loadStorage();
}
function setBackup123Enabled(enabled) {
  localStorage.setItem('reeden-backup-123-enabled',enabled?'on':'off');
  if(!enabled)stopPan123Qr();
  $('#backupTo123').checked=enabled;refreshSettingsControls();
}
function refreshSettingsControls() {
  const browser=state.storage?.mode==='browser-local',config=pan123BackupConfig();
  const enabled=browser?$('#backupTo123').checked:state.storage?.archive?.provider==='123pan';
  $('#settingsBackup123Enabled').checked=enabled;$('#settingsBackup123Enabled').disabled=Boolean(state.operation);
  $('#settings123ToggleRow').hidden=!browser;$('#pan123BackupControls').hidden=!enabled;
  $('#pan123SettingsSummary').textContent=!enabled?'已关闭':config.token?'已保存登录 · '+config.folder:'尚未连接，请先登录';
  $('#pan123BrowserLoginMethods').hidden=!browser;$('#pan123LocalLoginMethods').hidden=browser;
  $('#pan123PasswordDetails').hidden=browser;$('#pan123SessionDetails').hidden=browser;$('#pan123ProbeBlock').hidden=browser;
  $('#localStorageSettings').hidden=browser;$('#syncStorage').hidden=browser;
  if(browser){
    $('#pullStorage').disabled=Boolean(state.operation);
    $('#pan123Settings').hidden=false;$('#pan123Label').hidden=false;$('#pan123Panel').hidden=false;
    $('#storageInventory').innerHTML=['theme','font','asset'].map(kind=>`<div class="inventory-row"><strong>${libraryKinds[kind].name}</strong><span>${state[kind+'s'].length} 项</span></div>`).join('');
  }
  if(enabled&&!(browser?config.token:state.storage?.pan123?.configured))$('#pan123LoginDetails').open=true;
  const details=$('#connectionDetails');
  if(!details.dataset.initialized){details.open=!syncToken;details.dataset.initialized='1';}
  $('summary',details).textContent=syncToken?'修改连接':'连接资源库';
  $('#saveApiBase').disabled=Boolean(state.operation)||connectionSaving;
}
function renderStorageSummary(data) {
  if (data.mode === "browser-local") {
    $("#storageDestination").textContent = '私有 R2 · '+(apiBase?new URL(apiBase).hostname:'尚未连接');
    $("#storageHint").textContent = "浏览器本地处理 · 多设备共享 R2";
    $("#storageState").textContent = "R2 私有库";
    $("#storageForm").hidden = true;
    $("#r2SettingsLabel").hidden = true;
    // 静态模式没有本机后端，但 123 的登录与扫码接口允许跨域，浏览器可以自己
    // 直连，请求从用户自己的网络出口发出。平台仍可能要求验证。
    $("#pan123Label").hidden = false;
    // 主 WebView 不允许离开本站，这个外链点了也只会被拦下；登录入口在上方面板里。
    const labelLink = $("#pan123Label .download-link");
    if (labelLink) labelLink.hidden = true;
    $("#pan123Panel").hidden = false;
    // 只属于本机后端的子块在这里没有对应实现：Worker 代发登录会被 123 的
    // 海外风控拦下，后台上传探针也没有对应路由，留着只会点了报错。
    $("#pan123PasswordDetails").hidden = true;
    $("#pan123SessionDetails").hidden = true;
    $("#pan123ProbeBlock").hidden = true;
    refreshSettingsControls();
    return;
  }
  $("#storageForm").hidden = false;
  $("#r2SettingsLabel").hidden = false;
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
  refreshSettingsControls();
}
function updateStorageControls() {
  // 免费/静态模式没有本机后端表单；123 说明块与网页登录面板由
  // renderStorageSummary 决定显示，这里再跑一遍会把它重新藏起来。
  if (state.storage?.mode === "browser-local") {refreshSettingsControls();return;}
  const form = $("#storageForm");
  const locked = Boolean(state.operation) || activeJobs().length > 0;
  $("#storageBusyNote").hidden = !activeJobs().length;
  $$("input, select", form).forEach(input => { input.disabled = locked; });
  $("#storageForm button[type='submit']").disabled = locked;
  const r2 = form.elements.libraryProvider.value === "cloudflare_r2";
  const archive = form.elements.archiveProvider.value;
  const pan123 = archive === "123pan";
  $('#pan123Settings').hidden=!pan123;
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
  setOperation("analyze");
  toast("正在解析主题和查找疑似重复…");
  try {
    await rememberLocalFiles(valid);await whenStorageReady();
    const body = new FormData(); valid.forEach(file => body.append("file", file, file.name));
    if (browserSyncEnabled()) {
      beginTransferProgress('读取主题',valid.length,valid.map(file=>file.name),{persist:false});
      const signal=transferController.signal;
      const codec = await browserCodec();
      const inspectFile=async (file, index) => {
        signal.throwIfAborted();
        operationMessage($("#reviewBatchStatus"), `正在读取主题 ${index + 1} / ${valid.length}…`);
        const raw = new Uint8Array(await file.arrayBuffer());
        signal.throwIfAborted();
        const originalSha=await codec.sha256Hex(raw);
        const existing=state.themes.find(record=>record.original_sha256===originalSha||record.sha256===originalSha);
        if(existing)return {staging_id:'browser-'+crypto.randomUUID(),file,original_sha256:originalSha,info:{...existing,name:themeIdentity(existing).title,source_name:file.name,bytes:file.size},duplicates:[existing],preview_urls:{light:existing.preview_light_url,dark:existing.preview_dark_url}};
        let entries = [];
        let inspection;
        try {
          // readZipEntries already validates and inflates every resource. Use
          // that result for both metadata and the preview instead of doing a
          // second full ZIP read through inspectContainer().
          entries = await codec.readZipEntries(raw);
          // 图集（RED\x02）按序号文件名取图，改名会丢封面；和 v1 gzip 一样
          // 只做识别、原包保留。
          inspection = { format: entries.containerFormat||"red_v4", compressionSupported: !["red_v1_gzip","red_v2_gallery"].includes(entries.containerFormat), entries: entries.map(entry => ({ name: entry.name, bytes: entry.bytes.length, mime: codec.mimeFromBytes(entry.bytes, entry.name) })) };
        } catch (error) {
          if (error?.code !== "private_red_unsupported") throw error;
          inspection = await codec.inspectContainer(raw);
          // The encrypted manifest cannot be decoded in the free browser
          // codec, but the private container keeps image payloads in a plain
          // sequential area. Extract those bytes for a visual-only preview.
          entries = await codec.extractPrivatePreviewImages(raw);
        }
        signal.throwIfAborted();
        const identity = metadataFromEntries(entries, file.name);
        // The private container encrypts its directory, so the ZIP metadata
        // pass finds nothing. Recover name/author from the plain JSON Reeden
        // writes after the images instead of settling for the file name.
        if (String(inspection?.format || "").includes("private")) {
          const plain = privatePlainIdentity(raw);
          if (plain?.name) identity.name = plain.name;
          if (plain?.author) identity.author = plain.author;
        }
        identity.name = themeIdentity(identity).title;
        // 图集 / 阅读主题 / 高亮包各用一套预览：它们不是书架 + 启动图那种主题。
        const redPart = redPartKind(entries, { header: inspection?.header, container_format: inspection.format, source_name: file.name });
        // 加密应用主题的目录是密文：角色识别偶尔只认出阅读背景，预览就会退化成
        // 「阅读背景与高亮」，自动分类跟着写成阅读主题，甚至被迁进收藏库。这里
        // 对 resourceType=themeBundle 的包统一按应用主题记录，不再报 reader。
        const bundleAppTheme = String(inspection?.header?.resourceType || "") === "themeBundle";
        const compositionKind = () => {
          const kind = redPart || previewCompositionKind(entries);
          return !redPart && bundleAppTheme && (kind === "reader" || kind === "single") ? "shelf_and_reader" : kind;
        };
        let previewUrl = "", previewBlob=null;
        let previewDetails = { kind: compositionKind(), container: inspection.format, simulation: true, encrypted_source: inspection.format === "red_private_v2" };
        if (entries.length) {
          // 部件预览失败（例如极端小图解码不了）时退回主题预览，宁可样式旧一点也不能没图。
          const preview = redPart
            ? (await composeRedPartPreviewBlob(entries, codec, redPart)) || await composeThemePreviewBlob(entries, codec)
            : await composeThemePreviewBlob(entries, codec);
          if (preview) {previewBlob=preview;previewUrl = URL.createObjectURL(preview);}
          previewDetails = { ...previewDetails, kind: compositionKind() };
        }
        const tone = entries.previewTone || null;
        const toneCategories = themeToneCategories(tone, previewDetails);
        const autoCategory = toneCategories[0] || "";
        const info = { ...identity, source_name: file.name, bytes: raw.length, container_format: inspection.format, compression_supported: inspection.compressionSupported !== false, preview_details: previewDetails, preview_tone: tone, auto_category: autoCategory, auto_categories: toneCategories, red_asset: redAssetCategory({header: inspection?.header, container_format: inspection.format, source_name: file.name, entries}) };
        const duplicateRecords = browserDuplicateCandidates(identity.name, identity.author);
        return { staging_id: `browser-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`, file, original_sha256:originalSha, preview_blob:previewBlob, inspection, info, duplicates: duplicateRecords.map(record => ({ ...record })), preview_urls: { light: previewUrl, dark: "" } };
      };
      const outcomes=await mapConcurrent(valid,BROWSER_TASK_CONCURRENCY,async(file,index)=>{
        if(signal.aborted)return {file,paused:true};
        try{const item=await inspectFile(file,index);signal.throwIfAborted();transferDone(file.name);return item;}
        catch(error){if(signal.aborted||error?.name==='AbortError')return {file,paused:true};transferDone(file.name,true);return {file,error};}
      });
      const items=outcomes.filter(item=>!item.error&&!item.paused),failures=outcomes.filter(item=>item.error);
      for(const outcome of outcomes.filter(item=>!item.paused)){
        const key=localFileIds.get(outcome.file)||outcome.file;importIssues.delete(key);
        if(outcome.error)importIssues.set(key,{file:outcome.file,message:outcome.error?.message||'读取失败'});
      }
      state.review.push(...items);
      // 刚解析出来的主题默认勾上：和字体/收藏一致——用户把文件拖进来就是想上传，
      // 之前主题不勾选，「确认所选并压缩」按钮一直灰着，看起来就像点不动。
      for (const item of items) selections.review.add(item.staging_id);
      renderReview();
      renderImportIssues();
      const message=signal.aborted?`读取已暂停，${items.length} 个主题已就绪，未完成文件保留，可继续上传。`:`已识别 ${items.length} 个主题${failures.length?`，${failures.length} 个无法读取，已单独保留`:''}。`;
      finishTransferProgress(message,failures.length);
      updateTransferProgress({stage:signal.aborted?'读取已暂停':'读取完成，等待确认',current:'尚未上传；未完成原件已保存在浏览器'});
      operationMessage($('#reviewBatchStatus'),message,!!failures.length);operationMessage($('#unifiedImportStatus'),message,!!failures.length);
      return {items,failures,paused:signal.aborted};
    }
    const data = await api("/api/themes/analyze", { method: "POST", body });
    const analyzed = data.items || [];
    state.review.push(...analyzed);
    for (const item of analyzed) if (item?.staging_id) selections.review.add(item.staging_id);
    renderReview();
    operationMessage($("#reviewBatchStatus"), `本批 ${data.items?.length || 0} 个主题已全部识别，可全选后确认。`);
    toast(`已解析 ${data.items?.length || 0} 个主题，请统一确认`);
  } catch (error) {
    if(error?.name==='AbortError'||transferController?.signal.aborted){operationMessage($('#unifiedImportStatus'),'读取已暂停，原文件保留，可继续上传。');return {items:[],failures:[],paused:true};}
    for(const file of valid)importIssues.set(localFileIds.get(file)||file,{file,message:error.message});
    renderImportIssues();operationMessage($('#unifiedImportStatus'),`读取失败：${error.message}。原文件保留，可重试。`,true);toast(error.message);
    return {items:[],failures:valid.map(file=>({file,error}))};
  }
  finally { if(transferState.active&&state.operation==='analyze')finishTransferProgress('读取未完成，原文件保留',1);setOperation(""); }
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
  if (state.operation) { toast("正在处理中，请等当前任务结束后再试"); return; }
  await whenStorageReady();
  if (storageSettingsPending()) { toast("设置有未保存的修改，请先在「设置」保存后再上传"); return; }
  if (!ids.length) { toast("请先勾选要处理的条目，或点「全选」"); return; }
  const eligible = new Set(eligibleIds("review"));
  const chosen = [...new Set(ids)].filter(id => eligible.has(id));
  if (!chosen.length) { toast("所选条目已失效，请重新勾选后再确认"); return; }
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
      // 原包只备份到 123 时不写 R2；未启用 123 则维持原行为，原包仍进 R2。
      const backupOriginals = pan123BackupEnabled();
      let finished = 0;
      const started=performance.now();
      const width=Math.min(3,processingConcurrency(),selected.some(item=>(item.file?.size||0)>32*1024*1024)?((Number(navigator.deviceMemory)||4)>=8?2:1):3);
      const results = await mapConcurrent(selected, width, async item => {
        const name = item.info?.source_name || item.info?.name || "主题";
        try {
          transferStage("读取主题", name);
          const raw = item.bytes || new Uint8Array(await item.file.arrayBuffer());
          // 图集 / 高亮包进收藏库，不和阅读主题混在一起；重导入时在收藏库里查重。
          const redAsset = item.info?.red_asset || "";
          const existing=redAsset
            ? state.assets.find(record=>[record.original_sha256,record.sha256].includes(item.original_sha256))
            : state.themes.find(record=>[record.original_sha256,record.sha256].includes(item.original_sha256));
          if(existing){await completeLocalFiles([item.file]);transferDone(name);finished++;return {item,record:existing,reused:true,redAsset:Boolean(redAsset)};}
          if (redAsset) {
            transferStage(`上传${redAsset}原包`, name);
            const assetSha = item.original_sha256 || await codec.sha256Hex(raw);
            const fileName = item.info?.source_name || `${name}.red`;
            const objectPath = await uploadBrowserObject("assets", assetSha, "red", raw, "application/octet-stream", name);
            let previewPath = "";
            if (item.preview_blob) {
              const previewBytes = new Uint8Array(await item.preview_blob.arrayBuffer());
              previewPath = await uploadBrowserObject("previews", await codec.sha256Hex(previewBytes), "jpg", previewBytes, "image/jpeg", name + "-预览");
            }
            transferStage("写入收藏记录", name);
            const record = await uploadBrowserRecord({
              kind: "asset", id: `asset-${assetSha.slice(0, 16)}`, asset_type: "red", extension: "red",
              category: redAsset, red_category: redAsset, preview_kind: item.info?.preview_details?.kind || "", file_name: fileName, name: item.info?.name || name, author: item.info?.author || "", style: "", tags: [],
              sha256: assetSha, original_sha256: assetSha, bytes: raw.length, mime: "application/octet-stream",
              container_format: item.info?.container_format || "", compression_supported: item.info?.compression_supported !== false,
              object_url: objectPath, url: objectPath, preview_url: previewPath,
              saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: ""
            }, codec);
            await completeLocalFiles([item.file]);
            transferDone(name);
            operationMessage($("#reviewBatchStatus"), `已收录${redAsset} ${++finished} / ${selected.length}…`);
            return { item, record, redAsset: true };
          }
          const encrypted=item.inspection?.format==='red_private_v2'||item.info?.container_format==='red_private_v2'||raw[3]===16;
          // 封面图集/高亮包的私有头不被 Worker 支持，压缩函数会原样返回：
          // 这种情况下要标记为原样保存，卡片才会显示「下载原样主题」而不是压缩版。
          const privatePreserved=encrypted&&!privateHeaderRepackSupported(item.inspection?.header);
          const compressionOptions=options.preset==='custom'
            ? {preset:options.preset,codec:options.codec,quality:options.quality,maxEdge:options.max_edge,gifColors:options.gif_colors,iconLossless:options.icon_lossless,compressReader:options.compress_reader,concurrency:2}
            : {preset:options.preset,concurrency:2};
          const originalSha=item.original_sha256||await codec.sha256Hex(raw);
          const compress=()=>encrypted?compressPrivateRedViaWorker(raw,codec,compressionOptions):runCodecTask('compressRed',{bytes:raw,options:compressionOptions,onProgress:progress=>transferStage(`${progress.stage==='pack'?'重新封包':'压缩资源'} ${progress.completed}/${progress.total}`,name)},()=>codec.compressRed(raw,compressionOptions));
          const prepare=async()=>{
            transferStage('压缩主题',name);const result=await compress(),compressedBytes=result.bytes;
            const assetSha=await codec.sha256Hex(compressedBytes);
            let preview=item.preview_blob,previewDetails=item.info.preview_details||{};
            if(!preview){let entries=[];try{entries=encrypted?await codec.extractPrivatePreviewImages(compressedBytes):await codec.readZipEntries(compressedBytes);}catch{}preview=await composeThemePreviewBlob(entries,codec);previewDetails={...previewDetails,kind:previewCompositionKind(entries),simulation:true,encrypted_source:encrypted};}
            const previewUpload=async()=>{if(!preview)return '';const bytes=new Uint8Array(await preview.arrayBuffer());return uploadBrowserObject('previews',await codec.sha256Hex(bytes),'jpg',bytes,'image/jpeg',name+'-预览');};
            transferStage('上传压缩包与预览',name);
            const [compressedPath,previewPath]=await Promise.all([uploadBrowserObject('compressed',assetSha,'red',compressedBytes,'application/octet-stream',name+'-压缩'),previewUpload()]);
            transferStage(backupOriginals?'压缩包已入 R2，准备备份原包':'等待 R2 原包确认',name);return {compressedBytes,assetSha,compressedPath,previewPath,previewDetails};
          };
          // 原包只备份到 123：启用备份时不写 R2，只算 md5；否则保持原包入库 R2。
          const operations=await Promise.allSettled([
            prepare(),
            backupOriginals?null:uploadBrowserObject('originals',originalSha,'red',raw,'application/octet-stream',name+'-原包'),
            backupOriginals?runCodecTask('hashes',{items:[{bytes:raw}],options:{concurrency:1}},async()=>({results:[{md5:await codec.md5Hex(raw)}]})):null
          ]);
          const failure=operations.slice(0,2).find(result=>result.status==='rejected');if(failure)throw failure.reason;
          const [{compressedBytes,assetSha,compressedPath,previewPath,previewDetails},uploadedOriginalPath,checksums]=operations.map(result=>result.value);
          const originalPath=backupOriginals?'':uploadedOriginalPath;
          transferStage("保存资源记录",name);
          const record = await uploadBrowserRecord({
            kind: "theme", id: `theme-${assetSha.slice(0, 16)}`, name: item.info.name || item.info.source_name, author: item.info.author || "作者未记录",
            sha256: assetSha, original_sha256: originalSha, original_size: raw.length, compressed_size: compressedBytes.length,
            compression_supported: item.info?.container_format!=='red_v1_gzip'&&!privatePreserved,container_format:item.info?.container_format, status:item.info?.container_format==='red_v1_gzip'||privatePreserved?'browser_original':"browser_compressed", source_name: item.info.source_name,
            // 色系识别：把主色系 + 明暗/阅读属性一起写进类别，别只存一个 auto_category。
            categories: [...new Set([...(item.info.auto_categories || [item.info.auto_category]), ...(item.info.categories || [])].map(value => String(value || "").trim()).filter(Boolean))],
            auto_categories: item.info.auto_categories || (item.info.auto_category ? [item.info.auto_category] : []),
            compressed_url: compressedPath, library_url: compressedPath, preview_light_url: previewPath, preview_dark_url: "", preview_details: previewDetails,
            saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: "", original_url: originalPath,
            original_storage: backupOriginals?'123pan':'r2',
            original_md5:checksums?.results?.[0]?.md5||"",original_123:null,original_123_error:""
          }, codec);
          // 原包不会写 R2：把入库时已在内存的原包字节暂存，紧随其后的 123 备份直接复用。
          if(backupOriginals && raw?.byteLength) backupByteStash.set(record.id, raw);
          // 备份成功前不清除本地恢复副本，避免 123 失败时原包无处可取。
          if(!backupOriginals && item.file)await completeLocalFiles([item.file]);
          transferDone(name);
          operationMessage($("#reviewBatchStatus"), `已完成主题 ${++finished} / ${selected.length}…`);
          return { item, record };
        } catch (error) {
          item.commitError = transferController?.signal.aborted?"已暂停，原文件已保留，可重新确认继续":error.message || "浏览器处理失败";
          transferDone(name, true);
          operationMessage($("#reviewBatchStatus"), `已完成主题 ${++finished} / ${selected.length}…`);
          return { item, error };
        }
      });
      const completed = results.filter(result => result.record && !result.redAsset).map(result => result.record);
      const addedAssets = results.filter(result => result.record && result.redAsset).map(result => result.record);
      const failures = results.filter(result => result.error);
      finishTransferProgress("主题处理完成", failures.length);
      state.themes = latestRecords([...completed, ...state.themes]);
      if (addedAssets.length) state.assets = latestRecords([...addedAssets, ...state.assets]);
      // Match completed records back to staging items by insertion order/name;
      // failed items remain visible for retry.
      for (const item of selected) if (!failures.some(entry => entry.item === item)) { state.review = state.review.filter(review => review !== item); selections.review.delete(item.staging_id); }
      renderReview(); renderThemes(); renderJobs(); if (addedAssets.length) renderAssets();
      const elapsed=((performance.now()-started)/1000).toFixed(1);
      const savedParts=[completed.length?`${completed.length} 个主题已保存到 R2`:"",addedAssets.length?`${addedAssets.length} 个主题部件已收录进收藏库`:""].filter(Boolean).join("，");
      const message = transferController?.signal.aborted?`已暂停，${completed.length + addedAssets.length} 项已完成，未完成文件保留，可继续上传。`:failures.length ? `${savedParts || "本批未完成"}，${failures.length} 个失败，请查看错误后重试。` : `${savedParts || "本批已处理"}，耗时 ${elapsed} 秒${results.some(result=>result.reused)?"（重复原件已跳过）":""}。`;
      operationMessage($("#reviewBatchStatus"), message, Boolean(failures.length)); toast(message);
      const backupEntries=backupOriginals?results.filter(result=>result.record&&!result.redAsset&&!result.reused&&result.item?.file).map(result=>({file:result.item.file,record:result.record})):[];
      const backups=backupEntries.map(entry=>entry.record);
      const readyNow=results.filter(result=>result.record&&!result.redAsset&&result.item?.file&&(!backupOriginals||result.reused)).map(result=>result.item.file);
      if(commitBatchBusy){
        // 整批还有字体/收藏要处理：备份和恢复副本都等 commitSelection 末尾统一结算。
        if(backups.length&&!transferController?.signal.aborted)deferredPan123.push(...backups);
        if(backupEntries.length)deferredBackupCleanup.push(...backupEntries);
        deferredCleanup.push(...readyNow);
      }else{
        if(backups.length&&!transferController?.signal.aborted)await runPan123Backups(backups);
        // 启用 123 时只有备份成功的主题才清恢复副本；失败/暂停保留原包。
        const cleanupFiles=[...readyNow,...backupEntries.filter(entry=>entry.record.original_123?.key).map(entry=>entry.file)];
        if(cleanupFiles.length)await completeLocalFiles(cleanupFiles);
        if(!transferController?.signal.aborted&&cleanupFiles.length)offerLocalCleanup(cleanupFiles, `本次 ${cleanupFiles.length} 个主题已处理完成，可以删掉本地原包释放空间。`).catch(error => toast(`本地文件清理失败：${error.message || error}`));
      }
      return;
    }
    // 本地服务模式也要有看得见的进度：先把条亮出来，再提交任务，随后由
    // loadJobs() 用真实 job.completed / total 持续刷新它。
    const jobNames = state.review.filter(item => chosen.includes(item.staging_id)).map(item => item.info?.source_name || item.info?.name || "主题");
    beginTransferProgress("主题压缩与上传", chosen.length, jobNames);
    transferStage("提交到后台队列", "");
    const result = await api("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "commit-themes", ids: chosen, ...options }) });
    rememberJob(result.job);
    trackedJobIds.add(result.job.id);
    state.importThemeJobIds = [...new Set([...state.importThemeJobIds, result.job.id])];
    saveSessionIds("reeden-import-theme-jobs", state.importThemeJobIds);
    state.review = state.review.filter(item => !chosen.includes(item.staging_id));
    chosen.forEach(id => selections.review.delete(id));
    renderReview();
    renderJobs();
    transferStage("等待后台压缩", `${chosen.length} 个主题已排队`);
    toast(`${chosen.length} 个主题已加入后台：压缩图片、重新封包并保存`);
    loadJobs().catch(() => {});
  } catch (error) { operationMessage($("#reviewBatchStatus"), `加入后台失败：${error.message}`, true); toast(error.message); }
  finally { if(browserSyncEnabled()&&transferState.active)finishTransferProgress("处理未完成，原文件保留",1);setOperation(""); }
}
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
function downloadableFiles(kind, record, extras = kind !== "theme") {
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
// A single item is always handed over as its own file. Bundling is a batch
// decision, and even there the user can switch it off and get every file one
// by one instead of a ZIP.
// ZIP names should follow the user's calendar, not UTC: a 03:30 CST download
// used to be stamped with yesterday's date.
function localDateStamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
async function downloadRecordsSeparately(kind, chosen, output) {
  const files = [];
  for (const record of chosen) {
    for (const file of downloadableFiles(kind, record, document.querySelector(`[data-download-extras="${kind}"]`)?.checked === true || kind!=="theme")) {
      // Previews are handy inside an archive but pure noise in a loose batch.
      if (kind === "theme" && /\.(preview|night)\.jpg$/i.test(file.name)) continue;
      files.push(file);
    }
  }
  if (!files.length) throw new Error("没有可下载的文件");
  let done = 0, failed = 0;
  for (const file of files) {
    try {
      // Remote mode: hand the object straight to the native downloader. An
      // Android WebView cannot fetch a `blob:` URL from DownloadManager, and
      // pulling a 20 MB RED into JS just to re-emit it is wasteful. The Worker
      // adds Content-Disposition when `download=1` is present.
      const direct = apiBase && !remoteUnavailable && /^\/api\/objects\//i.test(String(file.path)) ? downloadUrl(file.path, file.name) : "";
      let url = direct;
      if (!url) {
        const bytes = await fetchDownloadableBytes(file.path);
        url = URL.createObjectURL(new Blob([bytes]));
      }
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      document.body.append(link); link.click(); link.remove();
      if (!direct) setTimeout(() => URL.revokeObjectURL(url), 60000);
      done++;
    } catch { failed++; }
    operationMessage(output, `正在逐个下载：${done} / ${files.length} 个文件${failed ? `（失败 ${failed}）` : ""}…`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return {done, failed};
}
async function downloadSelectedRecords(kind, ids = [...selections[kind]]) {
  if (state.operation) return;
  const collection = kind === "theme" ? state.themes : kind === "font" ? state.fonts : state.assets;
  const chosen = [...new Set(ids)].map(id => collection.find(item => String(item.id) === String(id))).filter(Boolean);
  if (!chosen.length) { toast("请先勾选要下载的项目"); return; }
  const output = $(`#${kind}BatchStatus`);
  const bundle = document.querySelector(`input[data-bundle="${kind}"]`)?.checked !== false;
  if (!bundle) {
    setOperation(`download-${kind}`);
    operationMessage(output, `正在逐个下载 ${chosen.length} 项，不打包…`);
    try {
      const {done, failed} = await downloadRecordsSeparately(kind, chosen, output);
      operationMessage(output, `已下载 ${done} 个文件${failed ? `，失败 ${failed} 个` : ""}。如果浏览器询问“是否允许下载多个文件”，请选择允许。`, failed > 0);
    } catch (error) {
      operationMessage(output, `下载失败：${error.message}`, true);
    } finally { setOperation(""); }
    return;
  }
  const extras=kind!=="theme" || document.querySelector(`[data-download-extras="${kind}"]`)?.checked===true;
  const query = new URLSearchParams({kind, ids: chosen.map(item => String(item.id)).join(","), date: localDateStamp(),extras:extras?"1":"0"}).toString();
  if(apiBase)await ensureWriteAccess();
  setOperation(`download-${kind}`);
  // Remote mode: the shared Worker streams a Stored ZIP directly from R2.
  // Nothing is pulled into JS memory and already-compressed fonts/RED files
  // are not deflated a second time, so a 50 MB selection starts downloading
  // immediately with the browser's own progress indicator.
  if (apiBase && !remoteUnavailable) {
    operationMessage(output, `正在准备 ${chosen.length} 项批量下载…`);
    try {
      const link = document.createElement("a");
      link.href = assetUrl(`/api/download?${query}`);
      link.download = `reeden-${kind}-${localDateStamp()}.zip`;
      document.body.append(link); link.click(); link.remove();
      operationMessage(output, `已发起 ${chosen.length} 项下载${kind==="theme"&&!extras?"（仅压缩 RED）":""}，可在浏览器下载列表查看进度。`);
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
      for (const file of downloadableFiles(kind, record, document.querySelector(`[data-download-extras="${kind}"]`)?.checked === true || kind!=="theme")) {
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
    link.download = `reeden-${kind}-${localDateStamp()}.zip`;
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
    if (kind === "font") {
      state.fonts = state.fonts.filter(item => !deletedIds.has(String(item.id)));
      // 同 sha256 的字体删后重新导入时 id 不变，清掉旧 FontFace 避免用到失效字体。
      deletedIds.forEach(id => {
        loadedFontFaces.delete(id); failedFontFaces.delete(id); loadingFontFaces.delete(id);
        for (const face of [...document.fonts]) if (face.family === `font-${id}`) document.fonts.delete(face);
      });
    }
    if (kind === "asset") state.assets = state.assets.filter(item => !deletedIds.has(String(item.id)));
    chosen.forEach(item => selections[kind].delete(item.id));
    browserLibraryRecordsCache=latestRecords([...state.themes,...state.fonts,...state.assets]);saveDeviceSnapshot();
    renderThemes(); renderFonts(); renderAssets();
    const failed = result.failed || [];
    const shared = result.retainedShared || [];
    const message = `已删除 ${deletedIds.size} 项${label}。${shared.length ? `共享对象保留 ${shared.length} 个。` : ""}${failed.length ? ` ${failed.length} 个对象删除失败，文件仍保留在 R2，可稍后重试。` : ""}文件进入清理等待期，可在存储维护中核对；如需恢复记录，请重新导入原文件。`;
    operationMessage(output, message, Boolean(failed.length));
    toast(failed.length ? `已删除记录，但有 ${failed.length} 个对象失败` : `${label}已删除，清单已刷新`);
    await Promise.all([loadThemes(true), loadFonts(true), loadAssets(true)]);
  } catch (error) {
    operationMessage(output, `删除失败：${error.message}。原记录仍保留，可重试。`, true);
    toast(`删除失败：${error.message}`);
  } finally { setOperation(""); }
}
async function syncSelectedAssets(kind, ids = [...selections[kind]]) {
  // 早退都要说明原因，否则按钮看起来就是「按了没反应」。
  if (state.operation) { toast("正在处理中，请等当前任务结束后再试"); return; }
  await whenStorageReady();
  if (!r2Enabled()) { toast("未连接共享库，请先在「设置」填写同步 API 地址"); return; }
  if (storageSettingsPending()) { toast("设置有未保存的修改，请先在「设置」保存后再同步"); return; }
  if (!ids.length) { toast("请先勾选要处理的条目，或点「全选」"); return; }
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
  if (!chosen.length) { toast("所选条目已失效，请重新勾选后再同步"); return; }
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
  if (state.operation) return false;
  await whenStorageReady();
  const theme = state.themes.find(item => String(item.id) === String(themeId));
  if (!theme) return false;
  const status = $('#themeDialogStatus');
  setOperation('preview');
  operationMessage(status, '正在读取主题并更新预览…');
  try {
    if (browserSyncEnabled()) {
      await ensureWriteAccess();
      const source = theme.compressed_url || theme.library_url || theme.original_url;
      if (!source) throw new Error('这条记录没有可读取的主题文件，请重新导入');
      const codec = await browserCodec();
      const raw = await fetchDownloadableBytes(source);
      let entries;
      try { entries = await codec.readZipEntries(raw); }
      catch (error) {
        if (error?.code !== 'private_red_unsupported') throw error;
        entries = await codec.extractPrivatePreviewImages(raw);
      }
      const preview = await composeThemePreviewBlob(entries, codec);
      if (!preview) throw new Error('主题里没有可生成预览的图片，原预览已保留');
      const bytes = new Uint8Array(await preview.arrayBuffer());
      const sha = await codec.sha256Hex(bytes);
      const previewUrl = await uploadBrowserObject('previews', sha, 'jpg', bytes, 'image/jpeg', `${themeIdentity(theme).title}-预览`);
      await ensureRecordReference(theme);
      const result = await api(`/api/themes/${encodeURIComponent(themeId)}`, {
        method: 'PATCH', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({record_sha256: theme.record_sha256, preview_light_url: previewUrl, preview_details: {...theme.preview_details, kind: previewCompositionKind(entries), simulation: true, renderer_version: 2}}),
      });
      Object.assign(theme, result.item);
      updateCachedRecord(theme);
      renderThemes();
    } else {
      await api(`/api/themes/${encodeURIComponent(themeId)}/preview/rebuild`, {method: 'POST'});
      await loadThemes();
    }
    operationMessage(status, '预览已更新');
    toast('预览已更新');
    return true;
  } catch (error) {
    operationMessage(status, `预览更新失败：${error.message}`, true);
    toast(`预览更新失败：${error.message}`);
    return false;
  } finally { setOperation(''); }
}
async function importFonts(files, options = {}) {
  await window.loadReedenVendor?.("opentype.min.js");
  if (state.operation) { toast("请等待当前批次处理完成"); return; }
  const valid = [...files].filter(file => /\.(ttf|otf|woff2?)$/i.test(file.name));
  if (!valid.length) { toast("请选择 TTF、OTF、WOFF 或 WOFF2 文件"); return; }
  await whenStorageReady();
  try { await ensureWriteAccess(); } catch { return; }
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
      if (hash && hashes.has(hash)) { duplicates++; await completeLocalFiles([file]); continue; }
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
            family: analysis.family || file.name.replace(/\.[^.]+$/, ""), subfamily: analysis.subfamily || "Regular", extension: info.extension, bytes: info.bytes,
            style: analysis.style, style_source: analysis.source, glyph_method: analysis.method, glyph_error: analysis.error || "", glyph_analysis: analysis.features, tags: [],
            url: fontPath, view_url: fontPath, preview_url: previewPath, preview_state: previewPath ? "generated" : "disabled", preview_error: "", saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: ""
          }, codec);
          await completeLocalFiles([file]);
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
      options.failedFiles = failures.map(item => item.file);
      finishTransferProgress("字体上传完成", failures.length);
      if (!added.length && failures.length) throw failures[0].error;
      state.fonts = [...added, ...state.fonts];
      // 收录成功的字体立刻从首页撤走：内容已经在字体库里，首页只留一句提示。
      state.importFontIds = [];
      saveSessionIds("reeden-import-fonts", []);
      renderFonts();
      const failedFiles = new Set(failures.map(item => item.file));
      const succeededFiles = unique.filter(file => !failedFiles.has(file));
      const message = `已上传 ${added.length} 个字体，重复跳过 ${duplicates} 个${failures.length ? `，失败 ${failures.length} 个` : ""}。已收录，可到字体库查看。`;
      operationMessage(output, message, Boolean(failures.length)); toast(message);
      if (options.deferCleanup) deferredCleanup.push(...succeededFiles);
      else offerLocalCleanup(succeededFiles, `本次 ${succeededFiles.length} 个字体已上传成功，可以删掉本地副本释放空间。`).catch(error => toast(`本地文件清理失败：${error.message || error}`));
      return;
    }
    operationMessage(output, `查重完成，正在接收 ${unique.length} 个新字体，完成后交给后台…`);
    const body = new FormData(); unique.forEach(file => body.append("file", file, file.name));
    const result = await api("/api/fonts/import?background=1", { method: "POST", body });
    state.importFontIds = [];
    saveSessionIds("reeden-import-fonts", []);
    if (result.job) rememberJob(result.job);
    await loadFonts();
    renderJobs();
    const warning = resultWarning(result);
    const message = `已加入 ${result.added?.length || 0} 个新字体，重复跳过 ${duplicates + (result.skipped?.length || 0)} 个。${result.job ? "同步已交给后台，可以离开此页。" : ""}${warning ? ` ${warning}` : ""}`;
    operationMessage(output, message, Boolean(warning));
    toast(message);
  } catch (error) { options.failedFiles ||= valid; operationMessage(output, `字体导入失败：${error.message}`, true); toast(error.message); }
  finally {if(transferState.active)finishTransferProgress("处理未完成，原文件保留",1);setOperation("");}
}
function assetExtension(file) {
  const match = String(file?.name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] === "htm" ? "html" : match?.[1] || "";
}
// 大量 SVG 素材是从网页或设计工具另存为 .txt 的：扩展名不可信，开头的 <svg 才可信。
const ASSET_TEXT_SNIFF_BYTES = 8192;
function looksLikeSvgBytes(bytes) {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, ASSET_TEXT_SNIFF_BYTES)))
    .replace(/^\uFEFF/, "");
  return /<svg[\s>/]/i.test(head);
}
function assetKindOf(file, bytes) {
  const extension = assetExtension(file);
  if (extension === "svg" || extension === "html") return extension;
  if ((extension === "txt" || extension === "") && looksLikeSvgBytes(bytes)) return "svg";
  return "";
}
// .txt 常见开头带 BOM 或空行；`<?xml` 前有空白会让浏览器拒绝整份 SVG。
function trimSvgPreamble(bytes) {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (start < bytes.length && (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0a || bytes[start] === 0x0d)) start++;
  return start ? bytes.subarray(start) : bytes;
}
function assetFileNameLabel(asset) {
  const name = String(asset?.file_name || "");
  const source = String(asset?.source_file_name || "");
  return source && source !== name ? `${source} → ${name}` : name;
}
async function importAssets(files, options = {}) {
  if (state.operation) { toast("请等待当前批次处理完成"); return; }
  const candidates = [...files].filter(file => ["svg", "html", "htm", "txt"].includes(assetExtension(file)));
  if (!candidates.length) { toast("请选择 SVG、HTML 或 HTM 文件（.txt 里是 SVG 也能识别）"); return; }
  // 先按内容定类型：.txt 只有含 <svg 才收录，纯文本直接忽略。
  const scanned = (await mapConcurrent(candidates, 4, async file => {
    const raw = new Uint8Array(await file.arrayBuffer());
    const kind = assetKindOf(file, raw);
    if (!kind) return null;
    const bytes = kind === "svg" && assetExtension(file) !== "svg" ? trimSvgPreamble(raw) : raw;
    return { file, kind, bytes };
  })).filter(Boolean);
  if (!scanned.length) { toast("所选文本文件里没有找到 SVG 内容，请确认文件开头有 <svg"); return; }
  if (scanned.length < candidates.length) toast(`${candidates.length - scanned.length} 个文本文件不包含 SVG，已跳过`);
  const valid = scanned.map(item => item.file);
  await whenStorageReady();
  try { await ensureWriteAccess(); } catch { return; }
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
    const hashed = await mapConcurrent(scanned, 4, async ({file, kind, bytes}) => {
      if (!crypto.subtle) throw new Error("当前环境不支持 SHA-256，无法安全去重");
      const hash = await crypto.subtle.digest("SHA-256", bytes).then(value => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
      return { file, bytes, hash, kind };
    });
    for (const item of hashed) {
      if (item.hash && hashes.has(item.hash)) { duplicates++; await completeLocalFiles([item.file]); continue; }
      if (item.hash) hashes.add(item.hash);
      unique.push(item);
    }
    if (!unique.length) { operationMessage(output, `全部 ${duplicates} 个收藏已存在，未重复上传。`); toast("所选收藏均已存在"); return; }
    if (browserSyncEnabled()) {
      const codec = await browserCodec();
      beginTransferProgress("收藏上传", unique.length);
      let finished = 0;
      const uploaded = await mapConcurrent(unique, 2, async ({file, bytes, hash, kind}) => {
        try {
          const extension = kind;
          const base = file.name.replace(/\.[^.]+$/, "");
          // .txt 里装的是 SVG：按 .svg 存对象、给 image/svg+xml，浏览器才能直接当图片用。
          const fileName = extension !== assetExtension(file) ? `${base}.${extension}` : file.name;
          const mime = extension === "svg" ? "image/svg+xml" : "text/html; charset=utf-8";
          transferStage("上传收藏文件", file.name);
          const objectPath = await uploadBrowserObject("assets", hash, extension, bytes, mime, base);
          let previewPath = "";
          if (extension === "svg") {
            try {
              transferStage("生成 SVG 预览", file.name);
              const previewBlob = await imagePreviewBlob(bytes, "image/svg+xml");
              const previewBytes = await jpegBytesFromBlob(previewBlob);
              if (previewBytes) {
                const previewSha = await codec.sha256Hex(previewBytes);
                transferStage("上传收藏预览", file.name);
                previewPath = await uploadBrowserObject("previews", previewSha, "jpg", previewBytes, "image/jpeg", `${base}-预览`);
              }
            } catch { /* The SVG remains downloadable if thumbnail creation fails. */ }
          }
          transferStage("写入收藏清单", file.name);
          const record = await uploadBrowserRecord({
            kind: "asset", id: `asset-${hash.slice(0, 16)}`, asset_type: extension === "svg" ? "svg" : "html", extension,
            file_name: fileName, ...(fileName !== file.name ? { source_file_name: file.name } : {}),
            name: base, author: "", style: "", tags: [], sha256: hash, bytes: bytes.length,
            mime, object_url: objectPath, url: objectPath, preview_url: previewPath, saved_to_cloud: true, cloud: "cloudflare_r2", sync_status: { library: "synced" }, sync_error: ""
          }, codec);
          await completeLocalFiles([file]);
          transferDone(file.name);
          operationMessage(output, `已上传收藏 ${++finished} / ${unique.length}…`);
          return record;
        } catch (error) { transferDone(file.name, true); operationMessage(output, `已完成收藏 ${++finished} / ${unique.length}（有一项失败）…`); return { error, file }; }
      });
      const added = uploaded.filter(item => !item?.error);
      const failures = uploaded.filter(item => item?.error);
      options.failedFiles = failures.map(item => item.file);
      finishTransferProgress("收藏上传完成", failures.length);
      if (!added.length && failures.length) throw failures[0].error;
      state.assets = [...added, ...state.assets];
      // 收录成功的收藏同样从首页撤走，收藏库里已经能看到。
      state.importAssetIds = [];
      saveSessionIds("reeden-import-assets", []);
      renderAssets(); renderImportedAssets();
      const failedAssetFiles = new Set(failures.map(item => item.file));
      const succeededAssetFiles = unique.filter(item => !failedAssetFiles.has(item.file)).map(item => item.file);
      const message = `已上传 ${added.length} 个收藏，重复跳过 ${duplicates} 个${failures.length ? `，失败 ${failures.length} 个` : ""}。已收录，可到收藏库查看。`;
      operationMessage(output, message, Boolean(failures.length)); toast(message);
      if (options.deferCleanup) deferredCleanup.push(...succeededAssetFiles);
      else offerLocalCleanup(succeededAssetFiles, `本次 ${succeededAssetFiles.length} 个收藏已上传成功，可以删掉本地副本释放空间。`).catch(error => toast(`本地文件清理失败：${error.message || error}`));
      return;
    }
    operationMessage(output, `查重完成，正在接收 ${unique.length} 个新收藏…`);
    const body = new FormData();
    unique.forEach(({file}) => body.append("file", file, file.name));
    const result = await api("/api/assets/import?background=1", { method: "POST", body });
    state.importAssetIds = [];
    saveSessionIds("reeden-import-assets", []);
    if (result.job) rememberJob(result.job);
    await loadAssets();
    renderJobs();
    const warning = resultWarning(result);
    const message = `已加入 ${result.added?.length || 0} 个收藏，重复跳过 ${duplicates + (result.skipped?.length || 0)} 个。${result.job ? "同步已交给后台，可以离开此页。" : ""}${warning ? ` ${warning}` : ""}`;
    operationMessage(output, message, Boolean(warning));
    toast(message);
  } catch (error) { options.failedFiles ||= valid; operationMessage(output, `收藏导入失败：${error.message}`, true); toast(error.message); }
  finally {if(transferState.active)finishTransferProgress("处理未完成，原文件保留",1);setOperation("");}
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
    await loadStorage(true);
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
  const host = $("#pan123QrHost");
  if (host) host.innerHTML = "";
  $("#pan123QrCode").hidden = true;
  operationMessage($("#pan123QrStatus"), message);
}
// 浏览器本地把扫码内容画成二维码（vendor qrcode-generator，MIT）。
// 123 的二维码内容就是「落地页 URL + uniID」，用官方那套参数最稳。
function renderPan123Qr(text) {
  const host = $("#pan123QrHost");
  if (!host) return false;
  try {
    const factory = window.qrcode;
    if (typeof factory !== "function") throw new Error("二维码组件没有加载");
    const qr = factory(0, "M");
    qr.addData(String(text || ""));
    qr.make();
    const count = qr.getModuleCount();
    const margin = 3;
    const size = count + margin * 2;
    let path = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
    host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="123 云盘扫码登录二维码"><rect width="${size}" height="${size}" fill="#fffdf8"/><path d="${path}" fill="#1d1a15"/></svg>`;
    return true;
  } catch (error) {
    host.innerHTML = `<p class="inline-error">二维码渲染失败：${escapeHtml(error.message || error)}</p>`;
    return false;
  }
}
// 浏览器直连 123 扫码登录：请求从用户自己的网络出口发出，不会被 123 当成
// 海外 IP 而弹验证码，因此这是浏览器同步模式下唯一不依赖图形验证的登录方式。
async function startPan123BrowserQr() {
  const generation = pan123QrGeneration;
  const status = $("#pan123QrStatus");
  operationMessage(status, "正在生成登录二维码…");
  await window.loadReedenVendor?.("qrcode.js");
  let payload = {};
  try {
    payload = await pan123Fetch(PAN123_QR_GENERATE_URL, {headers: {platform: "web", "app-version": "3"}});
  } catch (error) {
    operationMessage(status, pan123Failure(error), true);
    return;
  }
  if (generation !== pan123QrGeneration) return;
  const uniID = String(payload?.data?.uniID || "");
  const url = String(payload?.data?.url || "");
  if (![0, 200].includes(Number(payload?.code)) || !uniID || !/^https:\/\//.test(url)) {
    operationMessage(status, "二维码暂时无法生成，请稍后重试，或改用账号密码登录。", true);
    return;
  }
  const qrUrl = new URL(url);
  Object.entries({env: "production", uniID, source: "123pan", type: "login"}).forEach(([key, value]) => qrUrl.searchParams.set(key, value));
  const text = qrUrl.href;
  if (!renderPan123Qr(text)) {
    operationMessage(status, "二维码渲染失败，请刷新页面后重试，或改用账号密码登录。", true);
    return;
  }
  $("#pan123QrCode").hidden = false;
  pan123QrSession = { browser: true, id: uniID, errors: 0, expiresAt: Date.now() + 120000 };
  operationMessage(status, "用123云盘App或微信扫码并确认。等待扫码…");
  pan123QrExpiryTimer = setTimeout(() => { stopPan123Qr("二维码已过期，请重新扫码连接。"); updateStorageControls(); }, pan123QrSession.expiresAt - Date.now());
  pan123QrTimer = setTimeout(() => pollPan123BrowserQr(generation, uniID), 1200);
}
async function pollPan123BrowserQr(generation, uniID) {
  if (generation !== pan123QrGeneration || !uniID) return;
  if (Date.now() >= (pan123QrSession?.expiresAt || 0)) {
    stopPan123Qr("二维码已过期，请重新扫码连接。"); updateStorageControls(); return;
  }
  // 手机扫码要切到 123 云盘 App，此时 WebView 会短暂隐藏；只放慢轮询，不要中止。
  if (document.hidden) { pan123QrTimer = setTimeout(() => pollPan123BrowserQr(generation, uniID), 4000); return; }
  let payload = {};
  try {
    payload = await pan123Fetch(`${PAN123_QR_RESULT_URL}?uniID=${encodeURIComponent(uniID)}&remember=true&gray=true`, {headers: {platform: "web", "app-version": "3"}});
  } catch (error) {
    if (generation !== pan123QrGeneration) return;
    if (++pan123QrSession.errors >= 2) { stopPan123Qr(pan123Failure(error)); return; }
    pan123QrTimer = setTimeout(() => pollPan123BrowserQr(generation, uniID), 3000);
    return;
  }
  if (generation !== pan123QrGeneration) return;
  const code = Number(payload?.code);
  if ((code === 200 || code === 0) && (payload?.data?.token || payload?.data?.accessToken || payload?.data?.access_token || payload?.data?.Authorization)) {
    // 200 是 123 扫码成功的约定返回码，会话 Token 就在 data 里。
    const data = payload?.data || {};
    const token = String(data.token || data.accessToken || data.access_token || data.Authorization || "");
    stopPan123Qr("扫码登录成功。");
    if (token) await acceptPan123Tokens([{token, source: "scan"}]);
    else operationMessage($("#pan123QrStatus"), "扫码已确认，但没有取回会话 Token，请重新扫码。", true);
    return;
  }
  if (![0, 200].includes(code)) { stopPan123Qr("暂时无法确认扫码状态，请重新扫码连接。"); updateStorageControls(); return; }
  const loginStatus = Number(payload?.data?.loginStatus);
  if (loginStatus === 4) { stopPan123Qr("二维码已过期，请重新扫码连接。"); updateStorageControls(); return; }
  if (loginStatus === 2) { stopPan123Qr("你已在手机上拒绝了这次登录，请重新扫码。"); updateStorageControls(); return; }
  operationMessage($("#pan123QrStatus"), loginStatus === 1 ? "已扫码，请在手机上确认登录。" : "用123云盘App或微信扫码并确认。等待扫码…");
  pan123QrTimer = setTimeout(() => pollPan123BrowserQr(generation, uniID), 1200);
}
async function startPan123Qr() {
  // 和 verifyPan123Backup 同理：新设备没有存储快照时必须等 storage 就绪，否则
  // browserSyncEnabled() 为 false，扫码会退回 Worker 海外出口被 123 判海外登录。
  if (apiBase) { stopPan123Qr(); try { await startPan123BrowserQr(); } catch (error) { operationMessage($("#pan123QrStatus"), pan123Failure(error), true); } return; }
  await whenStorageReady();
  // 以前这里遇到 document.hidden / 有后台任务就直接 return，手机上点了没反应，
  // 也没任何提示。现在只拦真正会冲突的操作，并且把原因写出来。
  if (state.operation) { operationMessage($("#pan123QrStatus"), "当前有操作正在进行，完成后再生成二维码。", true); return; }
  // 只有本机后端模式的扫码要占用后端任务队列；浏览器直连 123 不碰 Worker，
  // 后台有任务在跑时也照样能扫，不然用户看到的就是「点了没反应」。
  if (!browserSyncEnabled() && activeJobs().length) { operationMessage($("#pan123QrStatus"), "后台任务正在处理，完成后再扫码登录。", true); return; }
  stopPan123Qr();
  // 浏览器同步模式直接连 123：不经过 Worker 就没有「海外 IP 强制验证码」。
  if (browserSyncEnabled()) { await startPan123BrowserQr(); return; }
  const generation = pan123QrGeneration;
  pan123QrController = new AbortController();
  const requestController = pan123QrController;
  const requestTimeout = setTimeout(() => requestController.abort(), 15000);
  setOperation("pan123-qr-start");
  operationMessage($("#pan123QrStatus"), "正在生成登录二维码…");
  try {
    const response = await fetch(apiUrl("/api/storage/123/qr/start"), { method: "POST", headers: requestHeaders({ "Content-Type": "application/json" }), body: "{}", signal: pan123QrController.signal });
    const result = await response.json().catch(() => ({}));
    if (generation !== pan123QrGeneration || state.activeView !== "storage") return;
    if (!response.ok || result.ok === false || !result.id || !/^data:image\/[a-z+]+;base64,[a-zA-Z0-9+/=\r\n]+$/i.test(result.image || "")) throw new Error("二维码暂时无法生成，请稍后再试。");
    pan123QrSession = { id: result.id, expiresAt: Date.now() + Math.min(120, Math.max(1, Number(result.expiresIn) || 120)) * 1000 };
    const host = $("#pan123QrHost");
    if (host) host.innerHTML = `<img id="pan123QrImage" alt="123扫码登录" width="200" height="200" src="${escapeHtml(result.image)}" />`;
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
  if (state.activeView !== "storage" || activeJobs().length || Date.now() >= pan123QrSession.expiresAt) {
    stopPan123Qr("扫码已结束，请重新扫码连接。"); updateStorageControls(); return;
  }
  // 手机扫码要切到 123 云盘 App，此时 WebView 会短暂隐藏。旧逻辑直接判定
  // 「已离开网页」并丢弃会话，所以 APK 端永远登不上；现在只是放慢轮询。
  if (document.hidden) { pan123QrTimer = setTimeout(() => pollPan123Qr(generation), 4000); return; }
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
  if (state.operation) { operationMessage($("#pan123Status"), "当前有操作正在进行，完成后再登录。", true); return; }
  // 之前如果有残留的扫码会话，账号密码登录会被静默忽略；这里先结束扫码再登录。
  if (pan123QrSession) stopPan123Qr();
  const form = event.currentTarget;
  const payload = kind === "login" ? { username: form.elements.username.value.trim(), password: form.elements.password.value } : { token: form.elements.token.value.trim() };
  form.reset();
  const output = $("#pan123Status");
  setOperation("pan123-credentials");
  operationMessage(output, kind === "login" ? "正在登录 123 云盘…" : "正在加密保存 123 云盘会话…");
  try {
    const response = await fetch(apiUrl(`/api/storage/123/${kind === "login" ? "login" : "session"}`), { method: "POST", headers: requestHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false || result.configured === false || (kind === "login" && result.authenticated !== true && !result.token)) {
      throw new Error(kind === "login" ? `登录未完成（${result.error || response.status}）。请检查账号信息；如需验证码，请改用「网页登录」，或使用下方的已有会话。` : `会话保存未完成（${response.status}）。请重新检查 Token 后提交。`);
    }
    // 网页版的密码登录由 Worker 代发、只回 Token，会话统一存在本机浏览器；
    // 这条路径不需要再去问服务端「配置好没有」。
    if (kind === "login" && result.token) {
      const input = $("#pan123BackupToken");
      if (input) input.value = result.token;
      try { localStorage.setItem(PAN123_TOKEN_STORAGE_KEY, result.token); } catch {}
      operationMessage(output, `登录成功${result.nickname ? `（${result.nickname}）` : ""}，会话已保存在本机。备份目录在「原始 RED 备份到 123 云盘」里设置。`);
      return;
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
    if(browserSyncEnabled()&&action==='pull'){
      await ensureWriteAccess();await loadBrowserLibraryRecords(true);
      await Promise.all([loadThemes(),loadFonts(),loadAssets()]);renderStorageSummary(state.storage);
      operationMessage(output,`已刷新：${librarySummary()}。`);return;
    }
    const result = action === "pull" ? await api("/api/storage/pull", { method: "POST" }) : await api("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync-all" }) });
    if (action !== "pull") { rememberJob(result.job); renderJobs(); operationMessage(output, "已加入后台同步。可以切换页面或关闭网页，在后台任务中查看进度。"); return; }
    await Promise.all([loadThemes(), loadFonts(),loadAssets(),loadStorage()]);
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
  await whenStorageReady();await ensureWriteAccess();
  if(state.operation){toast('请等待当前批次结束');return;}
  const candidates=[...(fileList||[])].filter(file=>/\.(red|ttf|otf|woff2?|svg|html?|txt)$/i.test(file.name||''));
  if(!candidates.length)return;
  // .txt 只有内容是 SVG 才暂存；扩展名按 svg 落，Worker 的暂存白名单才认。
  const entries=[];
  for(const file of candidates){
    const raw=new Uint8Array(await file.arrayBuffer());
    const detected=assetExtension(file)==='txt'?assetKindOf(file,raw):'';
    if(assetExtension(file)==='txt'&&detected!=='svg')continue;
    entries.push({file,ext:detected||assetExtension(file),bytes:detected==='svg'?trimSvgPreamble(raw):raw});
  }
  if(!entries.length)return;
  const files=entries.map(item=>item.file);
  await rememberLocalFiles(files);
  setOperation('staging');suppressCloudJob=true;
  const status=$('#unifiedImportStatus');let job;
  try {
    if(files.length>1000)throw new Error("每批最多暂存 1000 个文件，请分批上传");
    const codec=await browserCodec(),uploads=[];
    for(const entry of entries){const sha=await codec.sha256Hex(entry.bytes);uploads.push({name:entry.file.name,key:`/api/objects/staging/${sha}.${entry.ext}`,sha,file:entry.file,ext:entry.ext,bytes:entry.bytes});}
    job=(await api('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'staged-import',title:`暂存 ${files.length} 个文件`,total:files.length,items:uploads.map(x=>x.name),source_keys:uploads.map(x=>x.key),uploads:uploads.map(({name,key})=>({name,key})),auto_commit:true,upload_complete:false,device:'browser'})})).job;
    rememberJob(job);renderJobs();beginTransferProgress('暂存原文件',files.length);
    for(const item of uploads){transferStage('上传到云端暂存',item.name);await uploadBrowserObject('staging',item.sha,item.ext,item.bytes,'application/octet-stream');transferDone(item.name);await api(`/api/jobs/${job.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage:`已暂存 ${transferState.completed}/${files.length}`,completed:transferState.completed})});}
    await api(`/api/jobs/${job.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'queued',stage:'原文件暂存完成，可以继续入库',upload_complete:true,completed:0})});
    finishTransferProgress('云端暂存完成');operationMessage(status,'已保存云端恢复任务。在「上传与恢复」中继续；本设备也保留恢复副本。');
  }catch(error){if(job)await sendCloudJobPatch({status:'partial',stage:'暂存中断，可继续已上传文件或补选原文件',error:error.message},job.id);operationMessage(status,`暂存中断：${error.message}。恢复任务已保留。`,true);}
  finally{suppressCloudJob=false;setOperation('');await loadJobs();}
}

// A tab that closes mid-run leaves the job "running", so takeover waits out an
// idle window first: that avoids two devices compressing the same batch while
// still letting a genuinely abandoned batch resume on its own.
const STAGED_TAKEOVER_IDLE_MS = 120000;
function isStagedResumable(job, now = Date.now()) {
  if (!job || job.kind !== "staged-import") return false;
  if (!Array.isArray(job.source_keys) || !job.source_keys.length || job.lease?.until>now) return false;
  if (["queued","partial","failed","paused"].includes(job.status)) return true;
  if (!["running","uploading"].includes(job.status)) return false;
  const idle = now - Date.parse(job.updated_at || "");
  return !Number.isFinite(idle) || idle > STAGED_TAKEOVER_IDLE_MS;
}
async function resumeStagedJobs(onlyId='') {
  if(stagedResumeBusy || state.operation){toast('请等待当前批次结束');return;}
  await ensureWriteAccess();stagedResumeBusy=true;
  const status=$('#jobsStatus'),owner=crypto.randomUUID();let currentJob,heartbeat;
  try {
    const data=await api('/api/jobs');
    const queued=(data.items||[]).filter(job=>(!onlyId || job.id===onlyId)&&isStagedResumable(job));
    if(!queued.length){operationMessage(status,'没有可继续的云端暂存任务；其他设备正在处理的任务需等待释放。');return;}
    for(const job of queued) {
      currentJob=job;
      await api(`/api/jobs/${job.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner,status:'running',stage:'继续逐文件入库'})});
      heartbeat=setInterval(()=>api(`/api/jobs/${job.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner})}).catch(()=>{}),30000);
      const done=new Set(job.done_keys||[]),failures=[];
      const sources=[...new Set(job.source_keys||[])];
      for(let index=0;index<sources.length;index++) {
        const key=sources[index];if(done.has(key))continue;
        const name=job.uploads?.find(item=>item.key===key)?.name||job.items?.[(job.source_keys||[]).indexOf(key)]||decodeURIComponent(key.split('/').pop());
        try {
          const response=await fetch(assetUrl(key),{headers:requestHeaders()});
          if(!response.ok)throw new Error(response.status===404?'原文件未传完，请在本设备恢复或重新选择此文件':`读取暂存失败（${response.status}）`);
          const file=new File([await response.arrayBuffer()],name,{type:'application/octet-stream'});file.archivePath='cloud-staging';
          resumingStaged=true;suppressCloudJob=true;
          try {await importUnifiedFiles([file]);selections.review.clear();state.review.filter(item=>item.file===file).forEach(item=>selections.review.add(item.staging_id));state.pending.filter(item=>item.file===file).forEach(item=>selections.review.add(item.id));await commitSelection();}
          finally {resumingStaged=false;suppressCloudJob=false;}
          if(state.review.some(item=>item.file===file)||state.pending.some(item=>item.file===file))throw new Error('文件尚未成功入库，原始暂存文件已保留');
          const hash=key.match(/([a-f0-9]{64})\./)?.[1];
          if(!hash || ![...state.themes,...state.fonts,...state.assets].some(record=>[record.original_sha256,record.sha256,record.source_sha256].includes(hash)))throw new Error('未能确认文件入库，暂存副本已保留');
          done.add(key);
          await api(`/api/jobs/${job.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner,done_keys:[...done],completed:done.size,stage:`已入库 ${done.size}/${sources.length}`})});

        }catch(error){failures.push(`${name}：${error.message}`);}
      }
      // Checkpoints are durable before deleting temporary sources. Resume also retries this cleanup.
      for(const key of sources.filter(key=>done.has(key)))try{
        const cleanup=await fetch(apiUrl(key), {method: "DELETE", headers:requestHeaders()});
        if(!cleanup.ok)throw new Error(`HTTP ${cleanup.status}`);
      }catch(error){failures.push('暂存清理未完成：'+error.message);}
      clearInterval(heartbeat);heartbeat=null;
      await api(`/api/jobs/${job.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner,release:true,total:sources.length,status:done.size===sources.length&&!failures.length?'completed':'partial',done_keys:[...done],completed:done.size,failed:failures.length,result:`${done.size}/${sources.length} 个文件已入库`,error:failures.join('；'),stage:failures.length?'有文件需补选或重试':'全部入库完成'})});
      operationMessage(status,failures.length?`已完成 ${done.size}/${sources.length}；${failures.join('；')}`:'云端任务全部入库完成',failures.length>0);
    }
  }catch(error){operationMessage(status,`继续失败：${error.message}。文件及恢复任务均保留。`,true);if(currentJob)await sendCloudJobPatch({owner,release:true,status:'partial',error:error.message},currentJob.id);}
  finally{clearInterval(heartbeat);resumingStaged=false;suppressCloudJob=false;stagedResumeBusy=false;await loadJobs();await refreshLocalTransfers();}
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
/* Local file cleanup --------------------------------------------------------
   A page cannot delete a file picked through <input type="file">: the browser
   only hands over a read-only snapshot of the bytes. Two sources can remove it
   afterwards: the Android shell exposes a small Storage Access Framework
   bridge, and Chrome/Edge return a writable directory handle when the user
   grants one. Everything else gets an honest list instead of a button that
   cannot possibly work. */
const pickedFileSources = new WeakMap();

// Durable on-device checkpoints contain the original File, not just progress text.
const localFileIds = new WeakMap();
let transferDatabase, localTransferRows=[];
function transferDB() {
  if(!transferDatabase)transferDatabase=new Promise((resolve,reject)=>{
    const r=indexedDB.open('reeden-transfers-v1',2);
    r.onupgradeneeded=()=>{
      const db=r.result;
      if(!db.objectStoreNames.contains('files'))db.createObjectStore('files',{keyPath:'id'});
      if(!db.objectStoreNames.contains('dirs'))db.createObjectStore('dirs');
    };
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  return transferDatabase;
}
async function transferStore(mode,action,storeName='files') {
  const db=await transferDB();return new Promise((resolve,reject)=>{const tx=db.transaction(storeName,mode),request=action(tx.objectStore(storeName));let result; if(request)request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
const CLEANUP_DIRECTORIES_KEY='cleanup-directories';
async function savedCleanupDirectories() {
  try { const handles=await transferStore('readonly',store=>store.get(CLEANUP_DIRECTORIES_KEY),'dirs');return Array.isArray(handles)?handles:[]; }
  catch { return []; }
}
async function sameCleanupDirectory(a,b) {
  if(!a||!b)return false;
  if(a===b)return true;
  if(typeof a.isSameEntry==='function') { try { if(await a.isSameEntry(b))return true; } catch {} }
  if(typeof b.isSameEntry==='function') { try { if(await b.isSameEntry(a))return true; } catch {} }
  return a.kind===b.kind&&a.name===b.name;
}
async function rememberCleanupDirectory(handle) {
  if(!handle)return;
  try {
    const saved=await savedCleanupDirectories(),kept=[];
    for(const item of saved)if(!await sameCleanupDirectory(item,handle))kept.push(item);
    kept.slice(-7).push(handle);
    await transferStore('readwrite',store=>store.put(kept,CLEANUP_DIRECTORIES_KEY),'dirs');
  } catch {}
}
// 权限请求必须留在用户点击的同步手势里。旧实现先 await queryPermission() 再
// await requestPermission()，两次 await 之间浏览器可能已消耗用户激活，request
// 就被拒绝，只好退回 showDirectoryPicker 让用户每次重选文件夹。直接 request：
// 已授权时浏览器会同步返回 'granted' 不再弹窗，未授权时在本次点击里弹一次即可。
async function ensureDirectoryWrite(handle) {
  if(!handle)return false;
  try {
    if(typeof handle.requestPermission==='function')return await handle.requestPermission({mode:'readwrite'})==='granted';
    if(typeof handle.queryPermission==='function')return await handle.queryPermission({mode:'readwrite'})==='granted';
    return true;
  } catch { return false; }
}
async function refreshLocalTransfers() {
  try {localTransferRows=(await transferStore('readonly',store=>store.getAll())).filter(row=>row.apiBase===apiBase);}catch{localTransferRows=[];}
  const panel=$('#localResumePanel');if(!panel)return;
  panel.hidden=!localTransferRows.length||transferState.active;
  $('#localResumeText').textContent=`此设备有 ${localTransferRows.length} 个未完成文件，原文件副本已保存在浏览器，可继续上传。`;
  $('#localResumeNames').textContent=localTransferRows.slice(0,4).map(row=>row.file.name).join('、')+(localTransferRows.length>4?'…':'');
}
async function rememberLocalFiles(files) {
  for(const file of files) {
    if(localFileIds.has(file))continue;
    const source=pickedFileSources.get(file)?.entry;
    const row={id:crypto.randomUUID(),apiBase,file,archivePath:file.archivePath||'',created_at:Date.now(),handle:source?.handle||null,parent:source?.parent||null,directory:source?.directory||null,path:source?.path||file.name};
    try {await transferStore('readwrite',store=>store.put(row));}
    catch(error) {
      if(error?.name==='DataCloneError'){row.handle=null;row.parent=null;row.directory=null;try{await transferStore('readwrite',store=>store.put(row));}catch{throw new Error('浏览器空间不足，无法保存恢复副本。请分批导入或使用云端暂存。');}}
      else throw new Error('浏览器未能保存恢复副本，请检查存储空间与网站权限后重试。');
    }
    localFileIds.set(file,row.id);
  }
  await refreshLocalTransfers();
}
async function completeLocalFiles(files) {
  // localFileIds 是以 File 对象为键的 WeakMap：同一文件跨会话恢复或重新构造后
  // 对象引用变了，这里就查不到 id，IndexedDB 行删不掉，"未完成文件"横幅会一直挂。
  // 先用映射，查不到再按文件名+大小回退匹配本地恢复行，确保已完成的副本被清掉。
  const ids=new Set(),cleared=[];
  for(const file of files||[]){
    if(!file)continue;
    let id=localFileIds.get(file);
    if(!id){
      const match=localTransferRows.find(row=>row&&row.file&&row.file.name===file.name&&Number(row.file.size)===Number(file.size));
      if(match){id=match.id;localFileIds.set(file,id);}
    }
    if(id){ids.add(id);cleared.push(file);}
  }
  for(const file of cleared)importIssues.delete(localFileIds.get(file)||file);
  if(ids.size)await transferStore('readwrite',store=>{for(const id of ids)store.delete(id);});
  await refreshLocalTransfers();
  renderImportIssues();
}
function renderImportIssues(){
  const issues=[...importIssues.values()],panel=$('#importIssues');panel.hidden=!issues.length;
  $('#importIssueSummary').textContent=`${issues.length} 个文件无法读取，原件已保留`;
  $('#importIssueList').innerHTML=issues.map((issue,index)=>`<li><span><strong>${escapeHtml(issue.file.name)}</strong><small>${escapeHtml(issue.message)}</small></span><button class="text-button" data-remove-import-issue="${index}" type="button">移出恢复列表</button></li>`).join('');
  if(issues.length&&!state.review.length&&!state.pending.length)panel.open=true;
}
async function resumeLocalTransfers() {
  if(localResumeBusy||state.operation || commitBatchBusy){toast('请等待当前批次处理结束');return;}
  localResumeBusy=true;const button=$('#resumeLocalTransfers');button.textContent='正在恢复…';updateBulkControls();
  const oldResuming=resumingStaged;
  try{
  operationMessage($('#unifiedImportStatus'),'正在恢复未完成文件…');
  await ensureWriteAccess();await refreshLocalTransfers();
  const files=[];
  const loaded=new Set([...state.pending.map(x=>x.file),...state.review.map(x=>x.file)].map(file=>localFileIds.get(file)).filter(Boolean));
  for(const row of localTransferRows) {
    if(loaded.has(row.id))continue;
    const file=row.file;localFileIds.set(file,row.id);if(row.archivePath)file.archivePath=row.archivePath;
    registerPickedFiles([{file,handle:row.handle,parent:row.parent,directory:row.directory,path:row.path}]);files.push(file);
  }
  setView('import');
  resumingStaged=true;
  const result=files.length?await importUnifiedFiles(files):null;
  if(result?.paused)return;
  toggleAll('review',true);
  if(!selections.review.size){operationMessage($('#unifiedImportStatus'),importIssues.size?`${importIssues.size} 个文件仍无法读取，请展开下方错误清单。其余原件保留，可重试。`:'没有待恢复的文件。',!!importIssues.size);return;}
  await commitSelection();
  }catch(error){operationMessage($('#unifiedImportStatus'),`恢复失败：${error.message}。原文件保留，可重试。`,true);}
  finally {resumingStaged=oldResuming;localResumeBusy=false;button.textContent='继续上传';await refreshLocalTransfers();updateBulkControls();}
}
async function discardLocalTransfers() {
  if(localResumeBusy||state.operation)return;
  if(!window.confirm('移除浏览器里的未完成恢复副本？本机原文件和 R2 文件都保留。'))return;
  const ids=new Set(localTransferRows.map(row=>row.id));
  await transferStore('readwrite',store=>ids.forEach(id=>store.delete(id)));
  state.pending=state.pending.filter(item=>!ids.has(localFileIds.get(item.file)));state.review=state.review.filter(item=>!ids.has(localFileIds.get(item.file)));
  for(const id of ids)importIssues.delete(id);renderImportIssues();renderReview();await refreshLocalTransfers();
}

const LOCAL_CLEANUP_KEY = "reeden-local-cleanup";

function localCleanupEnabled() {
  try { return localStorage.getItem(LOCAL_CLEANUP_KEY) === "1"; } catch { return false; }
}
function nativeFileBridge() {
  const bridge = window.RedGardenNative;
  if (!bridge || typeof bridge.capability !== "function") return null;
  try { return JSON.parse(String(bridge.capability() || "{}"))?.canDelete ? bridge : null; } catch { return null; }
}
function supportsDirectoryHandle() { return typeof window.showDirectoryPicker === "function"; }
function supportsFileHandle() { return typeof window.showOpenFilePicker === "function"; }
function refreshCleanupHint() {
  const hint = $("#localCleanupHint");
  if (!hint) return;
  const mode = nativeFileBridge() ? "app" : (supportsFileHandle() || supportsDirectoryHandle()) ? "picker" : "none";
  hint.dataset.cleanupMode = mode;
  hint.textContent = mode === "app"
    ? "本机文件删除：可用。上传成功后弹窗询问，删除由应用通过系统文件接口完成，系统可能再确认一次。"
    : mode === "picker"
      ? "本机文件删除：可用。授权过的文件夹会记住，后续清理直接复用，不必每次重新选择；删除前仍会核对文件内容。"
      : "本机文件删除：当前浏览器不允许网页删除本机文件，上传后会列出清单让你手动清理（手机 APK 与桌面 Chrome/Edge 支持自动删除）。";
}
function registerPickedFiles(items, source = null) {
  const batch = { source, entries: [] };
  for (const item of [...(items || [])]) {
    if (!item) continue;
    const file = typeof File !== "undefined" && item instanceof File ? item : item.file;
    if (!file) continue;
    const entry = {
      file,
      name: file.name || "",
      size: Number.isFinite(item.size) ? item.size : Number(file.size) || 0,
      path: item.path || file.webkitRelativePath || file.name || "",
      parent: item.parent || null,
      handle: item.handle || null,
      directory: item.directory || source?.directory || item.parent || null,
    };
    pickedFileSources.set(file, { batch, entry });
    batch.entries.push(entry);
  }
  return batch;
}
async function collectDirectoryFiles(handle, prefix = "", names = null) {
  const collected = [];
  for await (const child of handle.values()) {
    if (child.kind === "directory") { collected.push(...await collectDirectoryFiles(child, `${prefix}${child.name}/`, names)); continue; }
    if(names&&!names.has(child.name))continue;
    let file;
    try { file = await child.getFile(); } catch { continue; }
    collected.push({ file, path: `${prefix}${child.name}`, parent: handle, handle: child });
  }
  return collected;
}
// File handles are read-only import sources. Batch deletion uses one writable
// directory grant; requesting write permission per file loses user activation.
async function pickFilesWithAccess(inputId, handler) {
  const input = $("#" + inputId);
  if (!input) return;
  if (!localCleanupEnabled() || !supportsFileHandle()) { input.click(); return; }
  let handles;
  try {
    handles = await window.showOpenFilePicker({ multiple: true, id: `reeden-${inputId}` });
  } catch (error) {
    if (error?.name === "AbortError") return;
    toast(`无法打开文件选择器，改用普通选择：${error?.message || error?.name || "未知原因"}`);
    input.click();
    return;
  }
  const collected = [];
  for (const handle of handles || []) {
    let file;
    try { file = await handle.getFile(); } catch { continue; }
    collected.push({ file, handle, name: file.name, size: file.size, path: file.name });
  }
  if (!collected.length) { toast("没有选到可用文件"); return; }
  registerPickedFiles(collected, { files: true });
  await handler(collected.map(item => item.file));
}
async function pickFolderWithAccess(inputId, handler) {
  const input = $("#" + inputId);
  if (!input) return;
  if (!localCleanupEnabled() || !supportsDirectoryHandle()) { input.click(); return; }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: "reeden-import", mode: "readwrite" });
  } catch (error) {
    if (error?.name === "AbortError") return;
    toast(`无法申请文件夹写入权限，改用普通选择：${error?.message || error?.name || "未知原因"}`);
    input.click();
    return;
  }
  await rememberCleanupDirectory(handle);
  try {
    const collected = await collectDirectoryFiles(handle);
    if (!collected.length) { toast("这个文件夹里没有可选文件"); return; }
    registerPickedFiles(collected, { directory: handle });
    await handler(collected.map(item => item.file));
  } catch (error) {
    toast(`读取文件夹失败：${error?.message || error?.name || "未知原因"}`);
  }
}
function cleanupTargets(files) {
  const bridge = nativeFileBridge();
  const targets = [];
  const seen = new Set();
  for (const file of files || []) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const entry = pickedFileSources.get(file)?.entry;
    targets.push({
      file,
      name: entry?.name || file.name || "未命名文件",
      size: Number.isFinite(entry?.size) ? entry.size : Number(file.size) || 0,
      path: entry?.path || file.webkitRelativePath || file.name || "",
      parent: entry?.parent || null,
      handle: entry?.handle || null,
      directory: entry?.directory || entry?.parent || null,
      deletable: Boolean(bridge),
    });
  }
  return { targets, bridge };
}
async function sameLocalFile(current,original) {
  if(current.size!==original.size) return false;
  const digest=async file=>new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));
  const [a,b]=await Promise.all([digest(current),digest(original)]);return a.every((value,index)=>value===b[index]);
}
async function directoryWriteGranted(directory) {
  if (!directory) return false;
  try { return typeof directory.queryPermission !== 'function' || await directory.queryPermission({mode:'readwrite'}) === 'granted'; }
  catch { return false; }
}
async function matchCleanupTargets(folder,targets,candidates) {
  const pending=candidates.filter(target=>!target.deletable);
  if(!folder||!pending.length)return 0;
  const entries=await collectDirectoryFiles(folder,'',new Set(pending.map(target=>target.name)));
  let matched=0;
  for(const target of pending) {
    let candidatesForName=entries.filter(entry=>entry.file.name===target.name&&entry.file.size===target.size);
    if(target.handle?.isSameEntry){
      const exact=[];
      for(const entry of candidatesForName)if(await target.handle.isSameEntry(entry.handle))exact.push(entry);
      if(exact.length)candidatesForName=exact;
    }
    const matches=[];
    for(const entry of candidatesForName)if(await sameLocalFile(entry.file,target.file))matches.push(entry);
    if(matches.length!==1)continue;
    const entry=matches[0];
    Object.assign(target,{parent:entry.parent,handle:entry.handle,directory:folder,deletable:true});
    const source=pickedFileSources.get(target.file)?.entry;
    if(source)Object.assign(source,{parent:entry.parent,handle:entry.handle,directory:folder});
    matched++;
  }
  return matched;
}
async function openCleanupDialog(targets, summary, options={}) {
  const dialog=$('#cleanupDialog');
  const bridge=nativeFileBridge(),canChoose=supportsDirectoryHandle();
  // 先用上次保存且仍有效的目录句柄匹配，避免每次删除都重新弹文件夹授权。
  // 这里只 query 权限；真正 request 必须留在用户点击确认的同步入口里。
  const savedDirectories=await savedCleanupDirectories();
  for(const directory of savedDirectories){
    if(!targets.some(target=>!target.deletable))break;
    if(!await directoryWriteGranted(directory))continue;
    await matchCleanupTargets(directory,targets,targets);
  }
  // Query only, once per root. Permission requests belong to the picker button's
  // direct click, never to a loop or a restored background transfer.
  const permissions=new Map();
  for(const target of targets) {
    const directory=target.directory||target.parent;
    if(directory&&!permissions.has(directory))permissions.set(directory,directoryWriteGranted(directory));
  }
  await Promise.all([...permissions].map(async([directory,pending])=>permissions.set(directory,await pending)));
  for(const target of targets)target.deletable=Boolean(bridge||target.parent&&permissions.get(target.directory||target.parent));
  return new Promise(resolve=>{
    if(!dialog?.showModal){resolve({selected:[],bridge:null});return;}
    let closed=false,busy=false;
    const selected=new Set(options.checked===false?[]:targets.filter(t=>t.deletable||canChoose));
    const finish=value=>{if(closed)return;closed=true;dialog.close();resolve(value);};
    dialog.onclose=()=>finish({selected:[],bridge:null});
    $('#cleanupNote').textContent=options.note||'仅删除本机原件，云端已入库副本保留。';
    const render=()=>{
      const available=targets.filter(t=>t.deletable||canChoose);
      $('#cleanupList').innerHTML=targets.map((t,i)=>`<li class="${t.deletable||canChoose?'':'is-locked'}"><label class="check-label"><input type="checkbox" data-cleanup-index="${i}" ${selected.has(t)?'checked':''} ${busy||!t.deletable&&!canChoose?'disabled':''}><span><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(formatBytes(t.size)+(t.deletable?'':' · 需要文件夹授权'))}</small></span></label></li>`).join('');
      $('#cleanupDialogDescription').textContent=summary;
      const boxes=$$('#cleanupList input'),confirm=$('#cleanupConfirm'),all=$('#cleanupSelectAll');
      const count=()=>{
        const picked=targets.filter(t=>selected.has(t)),need=picked.filter(t=>!t.deletable).length;
        $('#cleanupSummary').textContent=`已选 ${picked.length} / ${targets.length}${need?` · ${need} 个待授权`:''}`;
        all.checked=!!available.length&&picked.length===available.length;all.disabled=busy||!available.length;
        all.indeterminate=picked.length>0&&picked.length<available.length;$('#cleanupSelectAllLabel').textContent='全选';
        confirm.disabled=busy||!!available.length&&!picked.length;
        confirm.textContent=busy?'正在核对文件…':need?`授权文件夹并删除（${picked.length}）`:picked.length?`删除所选（${picked.length}）`:'关闭（需手动删除）';
      };
      boxes.forEach((box,i)=>box.onchange=()=>{if(box.checked)selected.add(targets[i]);else selected.delete(targets[i]);count();});
      all.onchange=()=>{available.forEach(t=>{if(all.checked)selected.add(t);else selected.delete(t);});render();};
      confirm.onclick=async()=>{
        if(busy)return;
        if(targets.some(t=>selected.has(t)&&!t.deletable)) {if(!await grantFolder())return;}
        if(!closed&&!targets.some(t=>selected.has(t)&&!t.deletable))finish({selected:targets.filter(t=>selected.has(t)),bridge});
      };count();
    };
    const grantFolder=async()=>{
      if(busy||closed)return false;
      busy=true;render();
      let matched=0;
      try{
        const pendingTargets=()=>targets.filter(target=>selected.has(target)&&!target.deletable);
        // 优先复用以前保存的目录句柄：只请求一次写权限，不再让用户重新选文件夹。
        for(const directory of savedDirectories){
          if(!pendingTargets().length)break;
          if(!await ensureDirectoryWrite(directory))continue;
          matched+=await matchCleanupTargets(directory,targets,pendingTargets());
        }
        if(pendingTargets().length&&supportsDirectoryHandle()){
          const folder=await window.showDirectoryPicker({id:'reeden-import',mode:'readwrite'});
          if(!await directoryWriteGranted(folder))throw new Error('未获得文件夹的写入权限，请重新选择并允许修改。');
          await rememberCleanupDirectory(folder);
          matched+=await matchCleanupTargets(folder,targets,pendingTargets());
        }
        const remaining=pendingTargets().length;
        if(!closed)$('#cleanupNote').textContent=remaining?`本次匹配 ${matched} 个，仍有 ${remaining} 个未匹配。请选择其余文件所在文件夹，或取消勾选；重名不唯一、内容已改变的文件会保留。`:`已核对 ${matched} 个文件。${options.note||'删除前会再次核对内容。'}`;
        return !closed&&!remaining;
      }catch(error){if(!closed&&error.name!=='AbortError')$('#cleanupNote').textContent='授权失败：'+error.message;return false;}
      finally{busy=false;if(!closed)render();}
    };
    $('#cleanupCancel').onclick=$('#closeCleanupDialog').onclick=()=>finish({selected:[],bridge:null});dialog.oncancel=e=>{e.preventDefault();finish({selected:[],bridge:null});};render();dialog.showModal();
  });
}
async function removeDirectoryEntry(target) {
  const parent = target.parent;
  const current=await (await parent.getFileHandle(target.name)).getFile();
  if(!await sameLocalFile(current,target.file))throw new Error('文件内容已改变，已保留');
  await parent.removeEntry(target.name);
}
async function performLocalCleanup(selected, bridge) {
  const byHandle = selected.filter(target => target.parent);
  const byNative = selected.filter(target => !target.parent && bridge);
  let deleted = 0;
  const failures = [];
  const permissions=new Map();
  for(const target of byHandle){const root=target.directory||target.parent;if(!permissions.has(root))permissions.set(root,await directoryWriteGranted(root));}
  for (const target of selected.filter(target => !target.parent && !bridge)) failures.push({name: target.name, reason: '没有删除权限；请选择所在文件夹授权，或手动删除'});
  for (const target of byHandle) {
    try {
      if(!permissions.get(target.directory||target.parent))throw new Error('文件夹授权已失效，请重新选择所在文件夹后再清理');
      await removeDirectoryEntry(target); deleted++;
    }
    catch (error) { failures.push({ name: target.name, reason: error?.message || "删除失败" }); }
  }
  if (byNative.length) {
    try {
      const payload = byNative.map(target => ({ name: target.name, size: target.size }));
      const result = JSON.parse(String(bridge.deleteFiles(JSON.stringify(payload)) || "{}"));
      if (result?.unsupported) failures.push({ name: `${byNative.length} 个文件`, reason: result.message || "系统不允许删除这些文件" });
      else {
        const nativeDeleted = Math.min(byNative.length, Math.max(0, Number(result?.deleted) || 0));
        deleted += nativeDeleted;
        for (const item of result?.failed || []) failures.push({ name: item?.name || "文件", reason: item?.reason || "删除失败" });
        if (nativeDeleted + (result?.failed?.length || 0) < byNative.length) failures.push({name: '本地文件', reason: '系统未确认删除结果，请手动检查'});
      }
    } catch (error) { failures.push({ name: `${byNative.length} 个文件`, reason: error?.message || "原生删除失败" }); }
  }
  return { deleted, failures };
}
// Called after a batch has actually landed in R2. Never blocks the import:
// the caller keeps its operation lock release path, and a dismissed dialog just
// leaves the files on disk.
async function offerLocalCleanup(files, summary) {
  if(!localCleanupEnabled())return;
  const { targets } = cleanupTargets(files.filter(file => !file.archivePath));
  if (!targets.length) return;
  // 即使当前环境一个都删不了，也要把清单摆出来：用户至少知道哪些文件已经上传、
  // 可以自己手动清理，而不是只弹一句提示就消失。
  if (!targets.some(target => target.deletable)) refreshCleanupHint();
  const { selected, bridge } = await openCleanupDialog(targets, summary);
  if (!selected.length) return;
  const result = await performLocalCleanup(selected, bridge);
  operationMessage($("#unifiedImportStatus"),`本地清理：已删除 ${result.deleted} 个；${result.failures.map(item=>item.name+"："+item.reason).join("；")||"全部完成"}`,result.failures.length>0);
  if (result.failures.length) toast(`已删除 ${result.deleted} 个本地文件，${result.failures.length} 个失败：${result.failures[0].name}（${result.failures[0].reason}）`);
  else toast(`已删除 ${result.deleted} 个本地文件`);
}
async function expandImportArchives(files) {
  const result = [], errors = [];
  let extracted = 0;
  for (const file of files) {
    if (!/\.zip$/i.test(file.name)) { result.push(file); continue; }
    operationMessage($("#unifiedImportStatus"), `正在本机读取 ZIP：${file.name}…`);
    try {
      if (file.size > 256 * 1024 * 1024) throw new Error("ZIP 超过 256 MB，请拆分后导入");
      const codec = await loadFreeCodec();
      const entries = await codec.readZipEntries(new Uint8Array(await file.arrayBuffer()), {standardZip: true,
        filter: name => !name.startsWith("__MACOSX/") && !name.split("/").some(part => part.startsWith(".")) && /\.(red|ttf|otf|woff2?|svg|html?|txt)$/i.test(name),
      });
      for (const entry of entries) {
        const item = new File([entry.bytes], entry.name.split("/").pop(), {lastModified: file.lastModified});
        Object.defineProperty(item, "archivePath", {value: `${file.name}/${entry.name}`});
        result.push(item);
        extracted++;
      }
      if (!entries.length) errors.push(`${file.name}：没有找到支持的主题、字体或 SVG/HTML 收藏`);
    } catch (error) { errors.push(`${file.name}：${error.message}`); }
  }
  if (extracted || errors.length) {
    const text = [extracted ? `ZIP 已在本机提取 ${extracted} 个主题/字体/收藏；原 ZIP 保留，等待确认上传。` : "", ...errors].filter(Boolean).join(" ");
    operationMessage($("#archiveImportStatus"), text, errors.length > 0);
  }
  return result;
}
async function importUnifiedFiles(fileList) {
  if (state.operation) { toast("请等待当前批次处理完成"); return; }
  let expanded;
  setOperation("zip-extract");
  try { expanded = await expandImportArchives([...(fileList || [])]); }
  finally { setOperation(""); }
  if (!expanded.length) return;
  if (!resumingStaged && $("#queueForLater")?.checked) { await queueFilesForLater(expanded); return; }
  const groups = { theme: [], font: [], asset: [] }, unsupported = [];
  for (const file of expanded) {
    const extension = String(file.name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
    if (extension === "red") groups.theme.push(file);
    else if (["ttf", "otf", "woff", "woff2"].includes(extension)) groups.font.push(file);
    else if (["svg", "html", "htm", "txt"].includes(extension)) groups.asset.push(file);
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
  setOperation('prepare-import');
  try{await rememberLocalFiles([...groups.theme,...groups.font,...groups.asset]);}finally{setOperation('');}
  const analysis=groups.theme.length?await analyzeFiles(groups.theme):null;
  if(analysis?.paused)return {paused:true};
  if (groups.font.length) await stagePendingFiles(groups.font, "font");
  if (groups.asset.length) await stagePendingFiles(groups.asset, "asset");
  const failed=analysis?.failures?.length||0;
  operationMessage(status, `已就绪：${analysis?.items?analysis.items.length:groups.theme.length} 个主题、${groups.font.length} 个字体、${groups.asset.length} 个收藏。${failed?`${failed} 个主题无法读取，原件保留，见下方清单。`:''}${unsupported.length ? `已跳过不支持的文件：${unsupported.join("、")}` : ""}`, Boolean(unsupported.length||failed));
  return {failures:analysis?.failures||[]};
}
// 从别的应用「分享」到 APK：原生把文件复制进 cache，并用 shouldInterceptRequest
// 在 /__shared__/<id> 上流式返回，这里读成 File 后走同一个统一导入，所以分享
// 和手动选文件的结果完全一致（字体、收藏直接上传，主题进入待确认并自动全选）。
const handledSharedIds = new Set();
async function ingestSharedFiles(payload) {
  let list = [];
  try { list = JSON.parse(String(payload || "[]")); } catch { return; }
  const fresh = (Array.isArray(list) ? list : [])
    .filter(item => item && item.id && item.name && !handledSharedIds.has(item.id));
  if (!fresh.length) return;
  fresh.forEach(item => handledSharedIds.add(item.id));
  if (state.activeView !== "import") setView("import");
  const files = [];
  for (const item of fresh) {
    try {
      const url = new URL(`./__shared__/${encodeURIComponent(item.id)}`, location.href).href;
      const response = await fetch(url, {cache: "no-store"});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength) throw new Error("空文件");
      files.push(new File([bytes], item.name, {type: "application/octet-stream"}));
    } catch (error) {
      toast(`读取分享文件失败：${item.name}（${error.message}）`);
    }
  }
  try { nativeAppBridge()?.bridge?.releaseSharedFiles(JSON.stringify(fresh.map(item => item.id))); } catch {}
  if (!files.length) return;
  toast(`收到 ${files.length} 个分享文件，正在导入`);
  const before = new Set(state.review.map(item => item.staging_id));
  await importUnifiedFiles(files);
  const added = state.review.filter(item => !before.has(item.staging_id));
  if (added.length) {
    added.forEach(item => selections.review.add(item.staging_id));
    updateBulkControls();
    toast(`${added.length} 个主题已加入待确认并勾选，点「确认所选并压缩保存」即上传`);
  }
}
window.onRedGardenSharedFiles = payload => { ingestSharedFiles(payload).catch(() => {}); };
// onPageFinished 可能早于 ES module 执行完，这里主动再拉一次，按 id 去重。
async function pullSharedFiles() {
  const app = nativeAppBridge();
  if (!app || typeof app.bridge.sharedFiles !== "function") return;
  let list = "[]";
  try { list = String(app.bridge.sharedFiles() || "[]"); } catch { return; }
  await ingestSharedFiles(list);
}
$("#chooseThemes").addEventListener("click", () => pickFilesWithAccess("themeInput", analyzeFiles));$("#chooseThemeFolder").addEventListener("click", () => pickFolderWithAccess("themeFolderInput", analyzeFiles));
$("#indexThemeFolder").addEventListener("click", () => $("#existingThemeFolderInput").click());
$("#addThemeButton").addEventListener("click", () => { setView("import"); });
$("#themeInput").addEventListener("change", async e => { await analyzeFiles(e.target.files); e.target.value = ""; });
$("#themeFolderInput").addEventListener("change", async e => { await analyzeFiles(e.target.files); e.target.value = ""; });
$("#existingThemeFolderInput").addEventListener("change", async e => { await indexExistingFiles(e.target.files); e.target.value = ""; });
setupDropZone($("#themeDropZone"), analyzeFiles);
$("#themeDropZone").addEventListener("click", () => { if (!state.operation) pickFilesWithAccess("themeInput", analyzeFiles); });
$("#chooseFonts").addEventListener("click", () => pickFilesWithAccess("fontInput", files => stagePendingFiles(files, "font")));
$("#chooseFontFolder").addEventListener("click", () => pickFolderWithAccess("fontFolderInput", files => stagePendingFiles(files, "font")));
$("#fontInput").addEventListener("change", async e => { stagePendingFiles(e.target.files, "font"); e.target.value = ""; });
$("#fontFolderInput").addEventListener("change", async e => { stagePendingFiles(e.target.files, "font"); e.target.value = ""; });
setupDropZone($("#fontDropZone"), files => stagePendingFiles(files, "font"));
$("#fontDropZone").addEventListener("click", () => { if (!state.operation) pickFilesWithAccess("fontInput", files => stagePendingFiles(files, "font")); });
$("#chooseAssets").addEventListener("click", () => pickFilesWithAccess("assetInput", files => stagePendingFiles(files, "asset")));
$("#chooseAssetFolder").addEventListener("click", () => pickFolderWithAccess("assetFolderInput", files => stagePendingFiles(files, "asset")));
$("#assetInput").addEventListener("change", async e => { stagePendingFiles(e.target.files, "asset"); e.target.value = ""; });
$("#assetFolderInput").addEventListener("change", async e => { stagePendingFiles(e.target.files, "asset"); e.target.value = ""; });
setupDropZone($("#assetDropZone"), files => stagePendingFiles(files, "asset"));
$("#assetDropZone").addEventListener("click", () => { if (!state.operation) pickFilesWithAccess("assetInput", files => stagePendingFiles(files, "asset")); });
setupDropZone($("#unifiedDropZone"), importUnifiedFiles);
$("#unifiedDropZone").addEventListener("click", () => { if (!state.operation) pickFilesWithAccess("unifiedInput", importUnifiedFiles); });
$("#unifiedInput").addEventListener("change", async event => { await importUnifiedFiles(event.target.files); event.target.value = ""; });
$("#chooseUnifiedFiles").addEventListener("click", () => { if (!state.operation) pickFilesWithAccess("unifiedInput", importUnifiedFiles); });
$("#chooseUnifiedFolder").addEventListener("click", () => { if (!state.operation) pickFolderWithAccess("unifiedFolderInput", importUnifiedFiles); });
$("#unifiedFolderInput").addEventListener("change", async event => { await importUnifiedFiles(event.target.files); event.target.value = ""; });
$('#backupTo123').checked=localStorage.getItem('reeden-backup-123-enabled')==='on'||(localStorage.getItem('reeden-backup-123-enabled')===null&&!!pan123BackupConfig().token);
$('#backupTo123').addEventListener('change',event=>setBackup123Enabled(event.target.checked));
$('#retryPan123Backups').addEventListener('click',()=>retryPan123Backups().catch(error=>operationMessage($('#pan123BackupStatus'),error.message,true)));
$("#localCleanupEnabled").checked = localCleanupEnabled();
$("#localCleanupEnabled").addEventListener("change", event => {
  try { localStorage.setItem(LOCAL_CLEANUP_KEY, event.target.checked ? "1" : "0"); } catch {}
  toast(event.target.checked ? "已开启：选择文件夹时申请写入权限，上传成功后再询问是否删除" : "已关闭本地文件清理，上传后不会询问删除");
});
refreshCleanupHint();
$("#themeCategoryFilter").addEventListener("change", event => { state.themeCategory = event.target.value; libraryPage.theme = 1; renderThemes(); });
$("#themeAuthorFilter").addEventListener("change", event => { state.themeAuthor = event.target.value || "all"; libraryPage.theme = 1; renderThemes(); });
for (const [kind, {render}] of Object.entries(libraryKinds)) {
  const input = $(`#${kind}SearchInput`);
  const clear = $(`[data-clear-search="${input.id}"]`);
  const sort = $(`[data-library-sort="${kind}"]`);
  $(`[data-recent-only="${kind}"]`).addEventListener("change", event => { recentOnly[kind] = event.target.checked; libraryPage[kind] = 1; render(); });
  const capital = kind[0].toUpperCase() + kind.slice(1);
  const refreshId = kind === "asset" ? "refreshAssets" : `refresh${capital}s`;
  $(`#${refreshId}`).addEventListener("click", () => refreshCatalog(kind));
  let searchTimer;
  input.addEventListener("input", () => {
    state[kind + "Search"] = input.value;
    clear.hidden = !input.value;
    libraryPage[kind] = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 120);
  });
  clear.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
  sort.addEventListener("change", () => {
    librarySort[kind] = sort.value;
    libraryPage[kind] = 1;
    render();
  });
  for (const [direction, delta] of [["Prev", -1], ["Next", 1]]) {
    $(`#${kind}${direction}Page`).addEventListener("click", () => {
      libraryPage[kind] += delta;
      render();
      input.closest(".view").querySelector("h1").focus({preventScroll: true});
      window.scrollTo(0, 0);
    });
  }
  const jump=$(`[data-page-jump="${kind}"]`),pageInput=$(`#${kind}PageInput`);
  pageInput.addEventListener('input',()=>pageInput.setCustomValidity(''));
  jump.addEventListener('submit',event=>{
    event.preventDefault();const value=Number(pageInput.value);
    if(!pageInput.value||!Number.isInteger(value)){pageInput.setCustomValidity('请输入整数页码');pageInput.reportValidity();return;}
    libraryPage[kind]=Math.max(1,Math.min(Number(pageInput.max)||1,value));render();
    input.closest('.view').querySelector('h1').focus({preventScroll:true});window.scrollTo(0,0);
  });
  $(`[data-clear-selection="${kind}"]`).addEventListener("click", () => {
    selections[kind].clear();
    updateBulkControls();
  });
  $(`[data-library-empty="${kind}"]`).addEventListener("click", () => {
    if (!state[kind + "s"].length) { setView("import"); return; }
    recentOnly[kind] = false; $(`[data-recent-only="${kind}"]`).checked = false;
    if (kind === "theme") {
      state.themeAuthor = state.themeCategory = "all";
    } else {
      state[kind + "Filter"] = "all";
    }
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
}
document.addEventListener("keydown", event => {
  if (event.defaultPrevented || event.isComposing || $("dialog[open], #modalBackdrop:not([hidden]), #mobileMore:not([hidden])")) return;
  const shortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
  const editing = event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]");
  if (!shortcut && (editing || event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey)) return;
  const search = $("[data-view-panel]:not([hidden]) .library-search input");
  if (!search) return;
  event.preventDefault();
  search.focus();
});
$("#selectAllReview").addEventListener("change", event => toggleAll("review", event.target.checked));
$$('[data-catalog-selection]').forEach(button=>button.addEventListener('click',()=>{
  const kind=button.dataset.catalogSelection;
  if(selectionModes[kind]||selections[kind].size){selectionModes[kind]=false;selections[kind].clear();}else selectionModes[kind]=true;
  updateBulkControls();
}));
$("#selectAllThemes").addEventListener("change", event => toggleAll("theme", event.target.checked));
$("#selectAllFonts").addEventListener("change", event => toggleAll("font", event.target.checked));
$("#selectAllAssets").addEventListener("change", event => toggleAll("asset", event.target.checked));
$('#selectDuplicateImports').addEventListener('click',selectDuplicateImports);
$('#removeSelectedImports').addEventListener('click',()=>removeImportItems().catch(error=>toast(error.message)));
$('#pauseTransfer').addEventListener('click',pauseCurrentTransfer);
$("#commitSelectedThemes").addEventListener("click", () => commitSelection());
$("#syncSelectedThemes").addEventListener("click", () => syncSelectedAssets("theme"));
$("#syncSelectedFonts").addEventListener("click", () => syncSelectedAssets("font"));
$("#syncSelectedAssets")?.addEventListener("click", () => syncSelectedAssets("asset"));
$("#deleteSelectedTheme").addEventListener("click", () => deleteSelectedRecords("theme"));
$("#deleteSelectedFont").addEventListener("click", () => deleteSelectedRecords("font"));
$("#deleteSelectedAsset")?.addEventListener("click", () => deleteSelectedRecords("asset"));
$("#downloadSelectedTheme").addEventListener("click", () => downloadSelectedRecords("theme"));
$("#bulkCategoryTheme")?.addEventListener("click", openBulkCategoryDialog);
$("#closeBulkCategory")?.addEventListener("click", () => $("#bulkCategoryDialog")?.close());
$("#bulkCategoryCancel")?.addEventListener("click", () => $("#bulkCategoryDialog")?.close());
$("#bulkCategoryApply")?.addEventListener("click", applyBulkThemeCategories);
$("#bulkCategoryAdd")?.addEventListener("click", addBulkCategoryFromInput);
$("#bulkCategoryInput")?.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addBulkCategoryFromInput(); } });
$("#bulkAuthorTheme")?.addEventListener("click", openBulkAuthorDialog);
$("#closeBulkAuthor")?.addEventListener("click", () => $("#bulkAuthorDialog")?.close());
$("#bulkAuthorCancel")?.addEventListener("click", () => $("#bulkAuthorDialog")?.close());
$("#bulkAuthorApply")?.addEventListener("click", applyBulkThemeAuthors);
$("#bulkAuthorInput")?.addEventListener("input", updateBulkAuthorApply);
$("#bulkAuthorDialog")?.addEventListener("cancel", event => { if (state.operation) event.preventDefault(); });
document.querySelectorAll('input[name="bulkCategoryMode"]').forEach(input => input.addEventListener("change", updateBulkCategoryApply));
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
// 手机底部导航：五个拇指能够到的入口，「更多」里放后台任务与设置。
function closeMobileMore() {
  const panel = $("#mobileMore");
  if (panel && !panel.hidden) panel.hidden = true;
  $(".mobile-tabs [data-tab='more']")?.setAttribute("aria-expanded", "false");
}
function toggleMobileMore() {
  const panel = $("#mobileMore");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  $(".mobile-tabs [data-tab='more']")?.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
}
$$(".mobile-tabs [data-tab]").forEach(button => button.addEventListener("click", () => {
  if (button.dataset.tab === "more") { toggleMobileMore(); return; }
  setView(button.dataset.tab);
}));
$$("#mobileMore [data-more-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.moreView)));
$("#mobileMore [data-more-action='refresh']")?.addEventListener("click", () => {
  closeMobileMore();
  const view = state.activeView;
  if (view === "themes") loadThemes().catch(error => toast(error.message));
  else if (view === "fonts") loadFonts().catch(error => toast(error.message));
  else if (view === "assets") loadAssets().catch(error => toast(error.message));
  else if (view === "jobs") loadJobs().catch(() => {});
  else loadStorage().catch(() => {});
  toast("已刷新");
});
document.addEventListener("click", event => {
  const panel = $("#mobileMore");
  if (!panel || panel.hidden) return;
  if (event.target.closest("#mobileMore, .mobile-tabs [data-tab='more']")) return;
  closeMobileMore();
});
$("#closeModal").addEventListener("click", () => $("#modalBackdrop").hidden = true);
$("#openJobs").addEventListener("click", () => setView("jobs"));
$("#refreshJobs").addEventListener("click", () => loadJobs().catch(() => {}));
document.addEventListener('click',event=>{
  const cloud=event.target.closest('[data-resume-cloud]');if(cloud)resumeStagedJobs(cloud.dataset.resumeCloud).catch(error=>toast(error.message));
  if(event.target.closest('[data-resume-old]')){if(localTransferRows.length)resumeLocalTransfers().catch(error=>toast(error.message));else{setView('import');toast('此旧任务没有保存原文件，请重新选择原文件；已入库内容会查重跳过');$('#chooseUnifiedFiles').click();}}
});
$("#resumeLocalTransfers").addEventListener("click",()=>resumeLocalTransfers().catch(error=>toast(error.message)));
$('#retryImportIssues').addEventListener('click',async()=>{
  if(localResumeBusy||state.operation||commitBatchBusy)return;
  const previous=resumingStaged;resumingStaged=true;
  try{await importUnifiedFiles([...importIssues.values()].map(issue=>issue.file));}catch(error){operationMessage($('#unifiedImportStatus'),error.message,true);}finally{resumingStaged=previous;}
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-remove-import-issue]');if(!button||localResumeBusy||state.operation||commitBatchBusy)return;
  const issue=[...importIssues.values()][Number(button.dataset.removeImportIssue)];if(!issue)return;
  button.disabled=true;try{await completeLocalFiles([issue.file]);operationMessage($('#unifiedImportStatus'),'已移出恢复列表，本机原文件保留。');}catch(error){toast(error.message);button.disabled=false;}
});
$("#discardLocalTransfers").addEventListener("click",()=>discardLocalTransfers().catch(error=>toast(error.message)));
refreshLocalTransfers();
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
  const openView = event.target.closest("[data-open-view]");
  if (openView) setView(openView.dataset.openView);
  const retry = event.target.closest("[data-retry-job]");
  if (retry) retryJob(retry.dataset.retryJob);
  const deleteJob = event.target.closest("[data-delete-job]");
  if (deleteJob) deleteJobRecord(deleteJob.dataset.deleteJob);
  const button = event.target.closest(".preview-open");
  if (button) showPreview(button);
});
document.addEventListener("submit", event => {
  const form = event.target.closest("[data-asset-form]");
  if (form) { event.preventDefault(); saveAssetClassification(form); }
  const recordForm = event.target.closest("[data-record-form]");
  if (recordForm) { event.preventDefault(); saveRecordClassification(recordForm); }
});
$('#fontCategoryFilters').addEventListener('change',event=>{state.fontFilter=event.target.value;libraryPage.font=1;renderFonts();});
// 收藏分类标签页：点一下切换分类，数量由 renderAssetFilterTabs 重新统计。
document.addEventListener('click',event=>{
  const tab=event.target.closest('[data-asset-filter]');if(!tab)return;
  state.assetFilter=tab.dataset.assetFilter;libraryPage.asset=1;renderAssets();
});
const assetCategorySelect=$('#assetCategoryFilter');
if(assetCategorySelect)assetCategorySelect.addEventListener('change',event=>{state.assetFilter=event.target.value;libraryPage.asset=1;renderAssets();});
$('#closeRecordDialog').addEventListener('click',()=>$('#recordDialog').close());
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-record-open],[data-record-details]');if(!button)return;
  const kind=button.dataset.recordOpen||button.dataset.recordDetails,id=button.dataset.recordId;
  if(button.dataset.recordOpen){
    if(state.operation||isAssetBusy(kind,id))return;
    if(selectionModes[kind]||selections[kind].size||event.ctrlKey||event.metaKey){
      const box=$(`#${kind}List input[data-selection="${kind}"][data-id="${CSS.escape(id)}"]`);
      if(box&&!box.disabled){box.checked=!box.checked;box.dispatchEvent(new Event('change',{bubbles:true}));}return;
    }
  }
  openRecordDialog(kind,id);
});
$("#closePreviewDialog").addEventListener("click", () => $("#previewDialog").close());
$("#closeThemeDialog").addEventListener("click", () => $("#themeDialog").close());
$$('dialog').forEach(dialog => {
  let startedOutside = false;
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  dialog.addEventListener('pointerdown', event => { startedOutside = event.target === dialog && outside(event); });
  dialog.addEventListener('click', event => {
    if (!startedOutside || event.target !== dialog || !outside(event)) return;
    startedOutside = false;
    if (dialog.dispatchEvent(new Event('cancel', {cancelable: true}))) dialog.close();
  });
});
$("#storageForm").addEventListener("submit", saveStorage);
$("#storageForm").addEventListener("input", () => {
  // 浏览器同步模式下这张表单是隐藏的，字段不参与上传，别把上传拦住。
  if ($("#storageForm").hidden) return;
  storageDirty = true; operationMessage($("#configStatus"), "配置有未保存的修改，请先保存再测试或同步。"); updateBulkControls();
});
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
  if (!document.hidden && pan123QrSession) {
    clearTimeout(pan123QrTimer);
    pan123QrTimer = setTimeout(() => pan123QrSession?.browser ? pollPan123BrowserQr(pan123QrGeneration, pan123QrSession.id) : pollPan123Qr(pan123QrGeneration), 600);
  }
});
$("#probePan123").addEventListener("click", probePan123);
$('#copyPan123Diagnostics').addEventListener('click',async()=>{
 const text=JSON.stringify({time:new Date().toISOString(),site:location.hostname,events:pan123Diagnostics},null,2);$('#pan123Diagnostics').textContent=text;$('#pan123Diagnostics').hidden=false;
 try{await navigator.clipboard.writeText(text);toast('已复制诊断，不包含保存的账号和会话');}catch{toast('请选中下面的诊断内容复制');}
});
$('#maintenancePlan').addEventListener('click',async()=>{
 const status=$('#maintenanceStatus'),button=$('#maintenancePlan');button.disabled=true;
 try{await ensureWriteAccess();const plan=await api('/api/maintenance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'plan'})});
 $('#maintenanceList').textContent=plan.items.map(item=>item.key+' · '+formatBytes(item.bytes)+' · '+item.reason).join('\n')||'没有符合条件的文件';
 operationMessage(status,`待核对 ${plan.items.length} 个；另有 ${plan.held_count} 个保留，${plan.remaining} 个可在下一批核对。仅列出无引用且满 7 天的文件。`);
 const confirm=$('#maintenanceDelete');confirm.hidden=!plan.items.length;confirm.onclick=async()=>{
 if(!window.confirm('确认删除清单中的 '+plan.items.length+' 个无引用旧文件？此操作无法撤销。'))return;
 confirm.disabled=true;try{const result=await api('/api/maintenance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',id:plan.id})});operationMessage(status,`已清理 ${result.deleted.length} 个，跳过 ${result.skipped.length} 个。`);confirm.hidden=true;}catch(error){operationMessage(status,error.message,true);}finally{confirm.disabled=false;}};
 }catch(error){operationMessage(status,error.message,true);}finally{button.disabled=false;}
});
$("#deviceTransferForm").addEventListener("submit", transferDeviceConfig);
for(const id of ['apiBaseInput','syncTokenInput'])$(`#${id}`).addEventListener('input',()=>{connectionDirty=true;});
$$('[data-transfer-direction]').forEach(button=>button.addEventListener('click',()=>setTransferDirection(button.dataset.transferDirection)));
function setTransferDirection(direction){
  $$('[data-transfer-direction]').forEach(button=>{const active=button.dataset.transferDirection===direction;button.setAttribute('aria-pressed',String(active));button.classList.toggle('is-active',active);});
  $$('[data-transfer-panel]').forEach(panel=>{panel.hidden=panel.dataset.transferPanel!==direction;$$('button',panel).forEach(button=>button.disabled=panel.hidden);});
  $('#deviceConfigFileLabel').hidden=Boolean(pendingConnectConfig);
}
$('#settingsBackup123Enabled').addEventListener('change',event=>setBackup123Enabled(event.target.checked));
for (const id of ["pan123BackupToken", "pan123BackupFolder"]) $(`#${id}`).addEventListener("change", () => {
  try {
    const token = normalizePan123Token($("#pan123BackupToken").value);
    localStorage.setItem(PAN123_TOKEN_STORAGE_KEY, token);
    localStorage.setItem(PAN123_FOLDER_STORAGE_KEY, $("#pan123BackupFolder").value.trim() || "Red-Garden-Backup");
    operationMessage($("#pan123BackupStatus"), "已自动保存。");refreshSettingsControls();
  } catch { operationMessage($("#pan123BackupStatus"), "浏览器阻止保存设置，请允许网站存储。", true); }
});
for (const kind of Object.keys(libraryKinds)) {
  $(`[data-bulk-tags="${kind}"]`).addEventListener("click", () => openBulkTags(kind));
}
$("#bulkTagForm").addEventListener("submit", applyBulkTags);
$("#closeBulkTags").addEventListener("click", () => { if (!state.operation) $("#bulkTagDialog").close(); });
$("#bulkTagDialog").addEventListener("cancel", event => { if (state.operation) event.preventDefault(); });
$("#saveApiBase").addEventListener("click", saveApiBaseSetting);
$("#clearApiBase").addEventListener("click",()=>{$('#apiBaseInput').value=normalizeApiBase(window.REEDEN_API_BASE||(location.hostname.endsWith('.pages.dev')?location.origin:FALLBACK_API_BASE));connectionDirty=true;});
(() => {
  const config = pan123BackupConfig();
  $("#pan123BackupToken").value = config.token;
  $("#pan123BackupFolder").value = config.folder;
  if (config.token) operationMessage($("#pan123BackupStatus"), "已保存 123 云盘会话 Token；点击「测试连接」可验证会话是否仍然有效。");
})();
$("#verifyPan123Backup").addEventListener("click", () => { verifyPan123Backup(); });
$("#pan123PasteToken")?.addEventListener("click", () => { pastePan123Token(); });
$("#pan123QuickLogin")?.addEventListener("submit", loginPan123Quick);
$("#pan123WebLogin")?.addEventListener("click", webLoginPan123);
(() => {
  const hint = $("#pan123WebLoginHint");
  if (!hint) return;
  hint.textContent = nativeAppBridge()?.caps?.pan123Login
    ? "登录请求由本机浏览器直接连 123，不经过 Worker，会保留 123 返回的验证提示；在应用内登录页完成后会自动取回会话。"
    : "遇到验证码时，请到官方网页完成验证。";
})();
$("#listPan123Backup").addEventListener("click", () => { refreshPan123BackupList(); });
$("#verifyPan123Write").addEventListener("click", () => { verifyPan123Write(); });
$("#clearPan123Backup").addEventListener("click", () => {
  try { localStorage.removeItem(PAN123_TOKEN_STORAGE_KEY); } catch {}
  $("#pan123BackupToken").value = "";
  setBackup123Enabled(false);toast('已断开 123 云盘');operationMessage($("#pan123BackupStatus"), "已断开 123 云盘。");
});
$("#testStorage").addEventListener("click", event => testStorage("library", event.currentTarget));
$("#testArchive").addEventListener("click", event => testStorage("archive", event.currentTarget));
$("#pullStorage").addEventListener("click", event => cloudOperation("pull", event.currentTarget));
$("#syncStorage").addEventListener("click", event => cloudOperation("sync", event.currentTarget));
$$('.nav-item').forEach(item => item.addEventListener('click', () => { setView(item.dataset.view); $(".sidebar").classList.remove("is-open"); }));
function applyCatalogDensity(kind,mode,persist=true){
  if(kind==='theme'){applyThemeDensity(mode,persist);return;}
  const density=mode==='list'?'list':'grid';$(`#${kind}List`).classList.toggle('is-list',density==='list');
  $$(`[data-catalog-density="${kind}"]`).forEach(button=>{const active=button.dataset.density===density;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));});
  if(persist)try{localStorage.setItem('reeden-'+kind+'-density',density);}catch{}
}
$$('[data-catalog-density]').forEach(button=>button.addEventListener('click',()=>applyCatalogDensity(button.dataset.catalogDensity,button.dataset.density)));
for(const kind of ['font','asset']){let saved;try{saved=localStorage.getItem('reeden-'+kind+'-density');}catch{}applyCatalogDensity(kind,saved,false);}
restoreThemeDensity();
let initialView=location.hash.slice(1);
if(initialView.startsWith('connect=')) {
  try{pendingConnectConfig=JSON.parse(new TextDecoder().decode(bytesFromBase64(initialView.slice(8).replace(/-/g,'+').replace(/_/g,'/'))));initialView='storage';history.replaceState(null,'',location.pathname+location.search+'#storage');operationMessage($('#deviceTransferStatus'),'已收到加密接入配置，请输入迁移口令并点击导入。');}catch{initialView='storage';toast('接入链接无效，请重新生成');}
}
setTransferDirection(pendingConnectConfig||!syncToken?'import':'export');
if(pendingConnectConfig){$('#deviceTransferDetails').open=true;$('#deviceConfigFileLabel').hidden=true;}
hydrateLocalSnapshots();
try {
  const saved = JSON.parse(localStorage.getItem("reeden-browse-v1") || "null");
  if (saved) {
    for (const kind of Object.keys(libraryKinds)) {
      libraryPage[kind] = Math.max(1, Number(saved.pages?.[kind]) || 1);
      if (["added", "oldest", "recent", "name", "size"].includes(saved.sort?.[kind])) librarySort[kind] = saved.sort[kind];
      state[kind + "Search"] = String(saved[kind + "Search"] || "");
      $(`#${kind}SearchInput`).value = state[kind + "Search"];
      $(`[data-clear-search="${kind}SearchInput"]`).hidden = !state[kind + "Search"];
      $(`[data-library-sort="${kind}"]`).value = librarySort[kind];
    }
    for (const key of ["themeAuthor", "themeCategory", "fontFilter", "assetFilter"]) state[key] = String(saved[key] || "all");
  }
} catch {}
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
setView(initialView, true);
// 分享进入时原生可能先于 app.js 执行完就回调，这里补一次主动拉取（按 id 去重）。
setTimeout(() => { pullSharedFiles().catch(() => {}); }, 900);
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  setView(view, true);
});
loadLibraryAfterConnection().then(() => autoResumeStagedQueue().catch(() => {})).catch(() => {});
