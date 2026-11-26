import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import {staticFiles} from "../vite.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "site");
const target = path.join(root, process.argv.includes("--cloudflare") ? "dist-pages" : "dist");
const errors = [];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

for (const file of staticFiles) {
  const sourcePath = path.join(source, file);
  const targetPath = path.join(target, file);
  try {
    const [sourceBytes, targetBytes] = await Promise.all([readFile(sourcePath), readFile(targetPath)]);
    if (hash(sourceBytes) !== hash(targetBytes)) errors.push(`site/${file} 与 ${path.basename(target)}/${file} 不一致`);
    // Deploying straight from a Windows working tree used to publish CRLF
    // bytes while GitHub Pages published LF from the Git blob. Both builds
    // worked, but the two production front ends were not byte-identical.
    if (/\.[a-z]+$/i.test(file) && sourceBytes.includes(13)) errors.push(`site/${file} 含 CRLF 行尾；请先统一为 LF 再部署`);
    if (/\.[a-z]+$/i.test(file) && targetBytes.includes(13)) errors.push(`${path.basename(target)}/${file} 含 CRLF 行尾；请先统一为 LF 再部署`);
  } catch (error) {
    errors.push(`${file} 无法读取：${error.message}`);
  }
}

const appPath = path.join(source, "app.js");
const [app, html, css, ui, uiCss, entry, emittedHtml] = await Promise.all([
  readFile(appPath, "utf8"),
  readFile(path.join(source, "shell.jsx"), "utf8"),
  readFile(path.join(source, "styles.css"), "utf8"),
  readFile(path.join(source, "ui.jsx"), "utf8"),
  readFile(path.join(source, "ui.css"), "utf8"),
  readFile(path.join(source, "main.jsx"), "utf8"),
  readFile(path.join(target, "index.html"), "utf8"),

]);
const entryAssets = [...emittedHtml.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map(match => match[1]);
if (!entryAssets.some(file => file.endsWith(".js")) || !entryAssets.some(file => file.endsWith(".css"))) {
  errors.push("构建产物缺少相对路径的 React 或 CSS 入口");
}
await Promise.all(entryAssets.map(file => readFile(path.join(target, file))));
if (process.argv.includes("--cloudflare")) {
  for (const file of ["_worker.js", "worker-api.js"]) {
    const [sourceBytes, outputBytes] = await Promise.all([readFile(path.join(root, "pages", file)), readFile(path.join(target, file))]);
    if (!sourceBytes.equals(outputBytes)) errors.push(`Cloudflare 构建产物的 ${file} 不是当前版本`);
  }
}
const sharedIds=new Set();
for(const kind of ['theme','font','asset']){
  if(!html.includes(`<LibraryPager kind="${kind}" />`)||!ui.includes('id={`${kind}Pagination`}')||!ui.includes('data-page-jump={kind}'))errors.push(`${kind} 分页或页码跳转组件缺失`);
  if(html.includes(`<LibraryBulk kind="${kind}" />`)&&ui.includes('id={`downloadSelected${capital}`}'))sharedIds.add('downloadSelected'+kind[0].toUpperCase()+kind.slice(1));
  if(html.includes(`<LibraryTools kind="${kind}"`)&&ui.includes('id={`${kind}Density`}'))sharedIds.add(kind+'Density');
}
for (const marker of ["function fontPreviewMarkup", "const FONT_SPECIMEN_CACHE_KEY", "function cachedFontSpecimen", "function rememberFontSpecimen", "function fontSpecimenDataUrl", "function upgradeLegacyFontPreview", "function applyFontPreviewImage", "function isFontSpecimenImage", "preview_kind: previewPath ? \"specimen-v2\" : \"\"", "font-preview-image is-specimen", "data-font-upgrade=", "function loadFontPreviewFace", "function recoverFontPreviewImage", "new FontFace(", "font-preview-frame", "font-preview-fallback", "data-font-preview-id", "data-font-id", "function renderFonts",
    "function refreshAssetPreview", "function rebuildAssetPreviewBlob", "function findAssetCard", "data-refresh-asset", "function assetPrimaryCategory", "function fitHtmlPreviews", "asset-html-frame", "function assetAuthor", "const ASSET_AUTHOR_PLACEHOLDERS", "function privatePreviewSummary", "function composeHighlightRulePreviewBlob", "function repairMissingPrivatePreviews", "api/private/preview", "const ASSET_FILTER_TABS", "function renderAssetFilterTabs", "function assetFilterCounts", "function assetMatchesSearch", "asset-compact-title", "const PRIVATE_REPACK_HEADER", "function privateHeaderRepackSupported", "function redAssetCategory", "if (/coverGallery/i.test(resourceType)) return \"gallery\"", "if (String(info?.container_format || \"\") === \"red_v2_gallery\") return \"gallery\"", "function migrateReaderThemesToAssets", "function restoreMisclassifiedThemeAssets", "retiredThemeIds", "retiredAssetIds", "function isReaderThemePackage", "if (/themeBundle/i.test(resourceType)) return \"\"", "const compositionKind = () =>", "const bundleAppTheme", "function objectContentLength", "async function objectRedContainer", "RED_CONTAINER_FORMAT", "Range: \"bytes=0-15\"", "v1Type === \"readerColorSchema\"", "name: item.info?.name || name", "rootMeta && rootCovers > 0", "red_asset: redAssetCategory(", "kind: \"asset\", id: `asset-${assetSha.slice(0, 16)}`, asset_type: \"red\"", "function assetRedCategory", "此私有 RED 协议尚未支持重封", "privateSkippedResult(raw, [{path: \"\", used: false, reason:", "privatePreserved=encrypted&&!privateHeaderRepackSupported", "暂不支持压缩重封，将保留原包并保存浏览器生成的预览", "function analyzeFontGlyphs", "function inkProfile", "window.opentype", "glyph_method", "function downloadSelectedRecords", "function downloadRecordsSeparately", "function fetchDownloadableBytes", "function downloadUrl", "download=1", "name=${encodeURIComponent(safe)}", "function pastePan123Token", "navigator.clipboard.readText", "data-bundle", "function renderThemeAuthorFilter", "function compressPrivateRedWithDirectory", "function queueFilesForLater", "function resumeStagedJobs", "function backupOriginalTo123", "function backupOriginalTo123ViaWorker", "function pan123DirectBackup", "function safePan123TransferUrl", "function persistPan123BackupResult", "apiUrl('/api/backup/123/result')", "function pan123ListFolderFactory", "function pan123BackupParent", "const loadingFontFaces", "const failedFontFaces", "const outlinedSpecimenFaces", "if(loadingFontFaces.has(font.id)||failedFontFaces.has(font.id)){finish();return;}", "loadingFontFaces.add(font.id)", "document.fonts.delete(face)", "class=\"font-specimen\"", "specimen-hero", "specimen-cjk", "specimen-sc", "specimen-tc", "specimen-latin", "specimen-digits", "class=\"font-specimen-outline\"", "function applyFontSpecimen", "async function drawFontSpecimenOutline", "if(loadedFontFaces.has(font.id)||outlinedSpecimenFaces.has(String(font.id))){applyFontSpecimen(font);return;}", "const fontPreviewQueue=[]", "function pumpFontPreviewQueue", "function enqueueFontPreview", "function observeFontPreviews", "new IntersectionObserver(entries=>", "observeFontPreviews();", "const fontDownload=kind==='font'", "class=\"download-link catalog-download\"", "${downloadAction?'has-download':''}", "String(item.id) === String(id)", "const searched = state.fonts.filter(fontMatchesSearch)", "fallback.family = String(parsed?.names?.fontFamily", "family: analysis.family ||", "async function patchRecordsBatch", "function applyBatchResults", "/api/library/batch-patch", "async function patchThemeAuthor", "function updateBulkAuthorApply", "function openBulkAuthorDialog", "async function applyBulkThemeAuthors", "const backupByteStash", "const deferredBackupCleanup=[]", "deferredBackupCleanup.push(...backupEntries)", "await completeLocalFiles(files)", "function savedCleanupDirectories", "function rememberCleanupDirectory", "function ensureDirectoryWrite", "if(typeof handle.requestPermission==='function')return await handle.requestPermission({mode:'readwrite'})==='granted'", "function matchCleanupTargets", "const match=localTransferRows.find(row=>row&&row.file&&row.file.name===file.name", "if(ids.size)await transferStore('readwrite',store=>{for(const id of ids)store.delete(id);});", "await rememberCleanupDirectory(handle)", "授权过的文件夹会记住", "function pendingPan123Backup", "const backupOriginals = pan123BackupEnabled()", "originalPath=backupOriginals?'':uploadedOriginalPath", "original_storage: backupOriginals?'123pan':'r2'", "backupByteStash.set(record.id, raw)", "const partNumbers=Array.from", "const context={listFolder:pan123ListFolderFactory(config.token)}", "function runCodecTask", "function loadLibraryAfterConnection", "function fetchWithReadTimeout", "API_READ_TIMEOUT_MS", "已连接共享库", "function verifyPan123Backup", "换电脑登不上的原因", "扫码会退回 Worker 海外出口", "/api/backup/123/verify", "已连接 123 云盘", "function refreshPan123BackupList", "function verifyPan123Write", "/api/backup/123/list", "123 已备份", "encodeURIComponent(config.folder)", "encodeURIComponent(fileName)", "已用 ${seconds} 秒", "function autoResumeStagedQueue", "reeden-auto-resume-queue", "auto_commit", 'fetch(apiUrl(key), {method: "DELETE"', "function compressionEstimate", "COMPRESSION_PRESET_LABELS", "compressionCustomFields", "customCompressionFactors", "compressionQualityValue", "function offerLocalCleanup", "function performLocalCleanup", "function cleanupTargets", "function nativeFileBridge", "function pickFolderWithAccess", "pickedFileSources", "RedGardenNative", "showDirectoryPicker", "localCleanupEnabled", "function privatePlainIdentity", "function jsonObjectAt", "function indexOfBytes", "function applyThemeDensity", "function restoreThemeDensity", "themeDensityDefault", "reeden-theme-density", "function patchThemeCategories", "auto_categories: nextAuto", "auto_category: nextAutoSingle", "auto_categories: [], auto_category: \"\"", "恢复/暂停按钮的禁用状态依赖 commitBatchBusy", "function openBulkCategoryDialog", "function applyBulkThemeCategories", "function syncTrackedJobProgress", "trackedJobIds.add(result.job.id)", "const SCREEN_W = 462", "const carouselBox", 'mode === "blur"', "window.addEventListener(\"focus\", onBack", "function themeModeIndex", "function deleteJobRecord", "data-delete-job", "function whenStorageReady", "function pickFilesWithAccess", "showOpenFilePicker", "function storageSettingsPending", "function hydrateLocalSnapshots", "LIBRARY_CACHE_KEY", "function pan123DirectRequest", "THEME_PAGE_SIZE", "function hueColorFamily", "function themeToneCategories", "function saveThemeIdentity", "theme-identity-form", "auto_categories", "restoreDeviceCache", "updateCachedRecord", "ensureWriteAccess", "transferDeviceConfig", "expandImportArchives", "applyBulkTags", "record_sha256", "function looksLikeSvgBytes", "function assetKindOf", "function trimSvgPreamble", "function assetFileNameLabel", "source_file_name: file.name", "所选文本文件里没有找到 SVG 内容", "function redPartKind", "async function composeRedPartPreviewBlob", "composeRedPartPreviewBlob(entries, codec, redPart)", "preview_kind: item.info?.preview_details?.kind", "封面图集", "高亮图片", "function setFontPreviewState", "function failFontPreview", "function retryFontPreview", "data-font-retry", "font-specimen-note"]) {
  if (!app.includes(marker)) errors.push(`前端缺少关键回归标记：${marker}`);
}
for (const id of ["fontList", "fontCount", "fontEmpty", "themeAuthorFilter", "downloadSelectedTheme", "downloadSelectedFont", "downloadSelectedAsset", "queueForLater", "resumeStagedJobs", "pan123BackupToken", "verifyPan123Backup", "listPan123Backup", "verifyPan123Write", "pan123BackupList", "autoResumeQueue", "compressionPresetGroup", "compressionCustomFields", "compressionQuality", "compressionMaxEdge", "compressionQualityDown", "compressionQualityUp", "compressionQualityValue", "compressionGifColors", "compressionReader", "compressionIconLossless", "transferProgress", "transferProgressTitle", "transferProgressCount", "transferProgressBar", "transferProgressStage", "transferProgressCurrent", "cleanupDialog", "cleanupList", "cleanupConfirm", "cleanupCancel", "cleanupSelectAll", "cleanupSummary", "localCleanupEnabled", "localCleanupHint", "closeCleanupDialog", "themeDensity", "themeSearchInput", "themeAuthorFilter", "themeDialog", "themeDialogBody", "closeThemeDialog", "pan123WebLogin", "pan123WebLoginHint", "pan123QuickLogin", "pan123QuickLoginButton", "pan123PasteToken", "mobileMore", "moreRuntimeMode", "moreJobCount", "themeCategoryFilter", "pendingList", "bulkCategoryTheme", "bulkCategoryDialog", "bulkCategoryPicks", "bulkCategoryInput", "bulkCategoryApply", "bulkCategoryAdd", "closeBulkCategory", "bulkCategoryCancel", "bulkAuthorTheme", "bulkAuthorDialog", "bulkAuthorSub", "bulkAuthorInput", "bulkAuthorApply", "bulkAuthorCancel", "closeBulkAuthor"]) {
  if (!html.includes(`id=\"${id}\"`)&&!ui.includes(`id=\"${id}\"`)&&!sharedIds.has(id)) errors.push(`页面结构回归检查失败：缺少 #${id}`);
}
for (const marker of [".pagination {", ".theme-card .item-heading { min-height: 0; }", ".font-preview-image {", ".font-specimen {", ".font-specimen .specimen-hero {", ".font-specimen .specimen-sc {", ".font-specimen .specimen-tc {", ".font-specimen-outline {", ".font-specimen-note {", ".font-specimen[data-state=\"loading\"] {", ".catalog-download {", ".category-chip.is-key {", ".theme-categories em.is-key {", ".catalog-card.has-download .theme-info { padding-bottom: 40px; }"]) {
  if (!css.includes(marker)) errors.push(`样式缺少关键回归标记：${marker}`);
}
// 收藏库要能按图集 / 高亮 / 阅读主题分类筛选，不能只留 SVG / HTML 的入口。
// 分类改成顶部标签页后，选项表在前端常量里，标签由 renderAssetFilterTabs 生成。
for (const value of ["all", "gallery", "highlight", "reader", "svg", "html", "ungrouped"]) {
  if (!app.includes(`{ value: "${value}", label:`)) errors.push(`收藏库分类标签缺少选项：${value}`);
}
// .txt 里装 SVG 的素材必须能选进来：收藏与统一导入入口都要放开 txt。
if ((html.match(/\.svg,\.html,\.htm,\.txt/g) || []).length < 1) errors.push("导入入口没有放开 .txt（存成 txt 的 SVG 无法选择）");
for (const marker of [".catalog-grid .font-preview-image,.catalog-grid .font-specimen {width:100%;height:100%;}", ".catalog-grid .theme-thumbnail .font-preview-image {object-fit:contain;", "@media(max-width:680px){.catalog-grid .font-preview-frame {min-height:0;}}", ".asset-filter-tabs {display:flex;", ".view .catalog-grid.asset-library-grid .asset-compact {", ".asset-library-grid .asset-compact .theme-thumbnail {", ".asset-library-grid.is-list .asset-compact .theme-preview {", ".view .catalog-grid.asset-library-grid {grid-template-columns:repeat(3,minmax(0,1fr));"]) {
  if (!uiCss.includes(marker)) errors.push(`字体预览样式缺少关键回归标记：${marker}`);
}
if (!app.includes("data-delete-job")) errors.push("脚本缺少关键回归标记：data-delete-job");
for (const file of ["app.js", "free_codec.js", "free_codec_worker.js", "omggif.js", "opentype.min.js", "qrcode.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(source, file)], {encoding: "utf8"});
  if (result.status !== 0) errors.push(`${file} 语法检查失败：${(result.stderr || result.stdout).trim()}`);
}
for (const script of ["scripts/remote-import.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, script)], {encoding: "utf8"});
  if (result.status !== 0) errors.push(`${script} 语法检查失败：${(result.stderr || result.stdout).trim()}`);
}
// 压缩引用映射的规则必须三处一致（浏览器 codec / 客户端映射 / Worker 映射）。
// 这套断言曾抓到「压缩后主题丢失书架背景、阅读背景和轮播图」的真凶，所以它
// 必须跟着每次部署一起跑，不能只躺在仓库里当一次性脚本。
for (const script of ["scripts/test-compress-references.mjs", "scripts/test-library-maintenance.mjs"]) {
  const result = spawnSync(process.execPath, [path.join(root, script)], {encoding: "utf8"});
  if (result.status !== 0) errors.push(`${script} 回归测试失败：\n${(result.stdout || result.stderr || "").trim()}`);
}
// The standalone Worker must share the Pages Worker implementation; a second
// hand-edited copy silently drops routes such as /api/private/repack.
const [workerEntry, workerApi] = await Promise.all([
  readFile(path.join(root, "worker", "worker.js"), "utf8"),
  readFile(path.join(root, "pages", "worker-api.js"), "utf8"),
]);
if (!workerEntry.includes('from "../pages/worker-api.js"') || !workerEntry.includes("export {default}")) errors.push("worker/worker.js 未复用 pages/worker-api.js，独立 Worker 接口会分叉");
for (const route of ['"/api/library" && request.method === "DELETE"', '"/api/private/repack"', '"/api/private/directory"', '"/api/private/seal"', '"/api/backup/123"', '"/api/backup/123/verify"', '"/api/backup/123/list"', '"/api/backup/123/result"', '"/api/jobs"', '"/api/download" && request.method === "GET"']) {
  if (!workerApi.includes(route)) errors.push(`pages/worker-api.js 缺少关键路由：${route}`);
}
if (!workerApi.includes("function streamZip") || !workerApi.includes("zipEndOfCentralDirectory")) errors.push("pages/worker-api.js 缺少流式 ZIP 打包实现");
if (!workerApi.includes('searchParams.get("download")') || !workerApi.includes("Content-Disposition", 600)) errors.push("pages/worker-api.js 未给 download=1 对象附 Content-Disposition，APK 点击下载只会跳转被拦");
// Chinese theme names must be percent-decoded server-side, otherwise every
// non-ASCII filename is rejected before the upload starts.
if (!workerApi.includes("function headerText") || !workerApi.includes('headerText(request.headers.get("X-Pan123-Filename"))')) errors.push("pages/worker-api.js 未解码百分号编码的 123 文件名，中文主题会备份失败");
if (!workerApi.includes("function deleteStagingObject") || !workerApi.includes('spec.kind === "staging" && request.method === "DELETE"')) errors.push("pages/worker-api.js 缺少暂存文件删除，处理完的原始副本会永久占用 R2");
// Readable R2 keys and live job detail: the dashboard used to show only
// SHA-256 hashes, and job records dropped the "current file" field.
if (!workerApi.includes("function objectLabel") || !workerApi.includes("function resolveObjectKey")) errors.push("pages/worker-api.js 未保留可读文件名或重名处理，R2 里又会只剩哈希");
if (!workerApi.includes('request.headers.get("X-Content-SHA256")') || !workerApi.includes("customMetadata: {sha256: actual}")) errors.push("pages/worker-api.js 未把 SHA-256 移到请求头与对象元数据，上传将无法校验完整性");
if (!workerApi.includes("X-Content-SHA256,X-Pan123-Token")) errors.push("pages/worker-api.js 的 CORS 未放行 X-Content-SHA256，浏览器上传会被预检拦下");
// 网页端要能直接账号密码登录 123：密码由 Worker 代发到官方登录接口，只回 Token。
if (!workerApi.includes("async function loginPan123") || !workerApi.includes('url.pathname === "/api/storage/123/login"')) errors.push("pages/worker-api.js 缺少 /api/storage/123/login，网页端只能继续手抄 Token");
// 登录/验证成功后只该说「已连接」，不该顺手把云盘里的文件清单铺到面板上。
if (!app.includes("if (quiet) return data;")) errors.push("site/app.js 的 quiet 刷新又渲染了备份清单");
if (!app.includes("function objectLabel") || !app.includes("objectFileName")) errors.push("site/app.js 缺少可读对象名生成");
if (!app.includes('"X-Content-SHA256": sha')) errors.push("site/app.js 上传时未声明内容摘要，Worker 无法校验");
if (!workerApi.includes('"stage", "current"')) errors.push("pages/worker-api.js 的 updateJob 丢弃 current，后台任务看不出在传哪个文件");
if (!workerApi.includes("const hasAutoCategories = Object.hasOwn(payload, \"auto_categories\")") || !workerApi.includes('kind === "theme" && hasAutoCategories ? {auto_categories')) errors.push("pages/worker-api.js 的分类接口不能清除自动生成的类别，用户删掉的 auto tag 会复活");
if (!workerApi.includes("async function savePan123DirectResult") || !workerApi.includes("return savePan123DirectResult(request, env)")) errors.push("pages/worker-api.js 缺少浏览器直连备份的结果写回接口，直连上传会无处落库");
if (!app.includes("-原包") || !app.includes("-压缩")) errors.push("site/app.js 未给原包/压缩包加可读后缀");
if (!app.includes("revealTransferProgress")) errors.push("site/app.js 未在确认后滚动到本批进度面板");
// 预览图四周不许再出现固定 16/28px 的衬白；进度条也不许再放回待确认区，
// 否则主题上传成功后区域一隐藏，用户就再也看不到处理进度。
if (app.includes("fillRect(16, 16, 968, 968)") || app.includes("fillRect(28, 28, 390, 936)")) errors.push("site/app.js 预览图又用回了带白边的旧版式");
if (html.indexOf('id="transferProgress"') < 0 || html.indexOf('id="reviewArea"') > 0 && html.indexOf('id="transferProgress"') > html.indexOf('id="reviewArea"')) errors.push("确认上传的进度条又放回待确认区内部，项目清空后用户会看不到进度");
if((html.match(/id="transferProgress"/g)||[]).length!==1||html.includes('id="reviewProgress"'))errors.push('导入页必须只有一条进度条');
for(const id of ['pauseTransfer','compressionSettings','removeImportWithLocal'])if(!html.includes(`id="${id}"`))errors.push('缺少恢复交互：'+id);
// 123 扫码：手机切到 123 App 时 WebView 会隐藏，旧逻辑直接丢弃二维码会话，
// APK 端因此永远登不上。轮询必须改成放慢而不是结束。
if (!app.includes("if (document.hidden) { pan123QrTimer = setTimeout(() => pollPan123Qr(generation), 4000); return; }")) errors.push("site/app.js 又在 WebView 隐藏时中止 123 扫码");
if (app.includes("已离开网页，请重新扫码连接")) errors.push("site/app.js 仍在切后台时放弃 123 扫码会话");
if (!app.includes("themeDialog") || !app.includes("function openThemeDialog")) errors.push("site/app.js 缺少主题细节弹窗");
// 手机端体验回归：网格必须双列（单列一屏只能看一个主题），导航必须走底部
// tab（左上角抽屉在拇指范围外），123 云盘必须能用网页登录拿到会话。
if (!/\.theme-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css)) errors.push("手机端主题网格退回单列，空间利用率不足");
if (!/\.mobile-tabs \{[^}]*grid-template-columns: repeat\(5/.test(css)) errors.push("site/styles.css 缺少手机底部导航布局");
if (/\.sidebar\.is-open \{ display: flex; \}/.test(css)) errors.push("手机端又启用了左上角抽屉导航");
for (const marker of ["function webLoginPan123", "function loginPan123Quick", "function acceptPan123Tokens", "function nativeAppBridge", "openPan123Login", "onRedGardenPan123Login", "toggleMobileMore", "function ingestSharedFiles", "onRedGardenSharedFiles", "__shared__", "releaseSharedFiles", "function mapLargePrivateConfigs", "function mapPrivateRefsClient", "PRIVATE_CONFIG_INLINE_LIMIT", "mapped: true", "function themeToneCategory", "function saveThemeCategories", "themeCategoryFilter", "function stagePendingFiles", "function commitSelection", "pendingList"]) {
  if (!app.includes(marker)) errors.push(`site/app.js 缺少新交互实现：${marker}`);
}
for (const marker of ['className="mobile-tabs"', 'data-tab="themes"', 'id="mobileMore"', 'id="pan123WebLogin"', 'id="pan123BackupToken"', 'id="settingsBackup123Enabled"', 'id="deviceTransferDetails"', 'id="recordDialog"']) {
  if (!html.includes(marker)) errors.push(`site/shell.jsx 缺少手机导航或 123 登录入口：${marker}`);
}
// APK 多选：WebView 不可靠地把多个 content URI 交给页面（国产 ROM 只给第一个），
// 所以多选必须自己复制进 cache 再走 /__shared__ 通道。别退回 parseResult 单来源解析。
try {
  const java = await readFile(path.join(root, "android/app/src/main/java/xyz/aookshizuo/reedenlibrary/MainActivity.java"), "utf8");
  for (const marker of ["collectResultUris", "getClipData()", "red-garden-pick", "publishSharedFiles();"]) {
    if (!java.includes(marker)) errors.push(`MainActivity 多选导入通道缺失：${marker}`);
  }
  if (/parseResult\s*\(resultCode, data\)/.test(java)) errors.push("MainActivity 又用回 parseResult，多选会只剩第一个文件");
  // 下载链接在另一个域名；若被 shouldOverrideUrlLoading 拦掉，WebView 根本不会
  // 触发 DownloadListener，用户看到的就是「点下载没反应」。
  for (const marker of ["isDownloadUrl(uri)", 'path.equals("/api/download")', 'uri.getQueryParameter("download")', 'getQueryParameter("name")']) {
    if (!java.includes(marker)) errors.push(`MainActivity 下载放行逻辑缺失：${marker}`);
  }
  const loginJava = await readFile(path.join(root, "android/app/src/main/java/xyz/aookshizuo/reedenlibrary/Pan123LoginActivity.java"), "utf8");
  for (const marker of ["window.__rgCollect = function(){", "scanStore('localStorage', localStorage)", "ClipboardManager", "new JSONArray(payload)"]) {
    if (!loginJava.includes(marker)) errors.push(`Pan123LoginActivity 自动取回/复制缺失：${marker}`);
  }
} catch (error) {
  errors.push(`MainActivity.java 无法读取：${error.message}`);
}
const [codecSource] = await Promise.all([readFile(path.join(source, "free_codec.js"), "utf8")]);
if (!codecSource.includes("options.store")) errors.push("site/free_codec.js 缺少 Stored ZIP 选项，批量下载会重复压缩字体");
for (const marker of ["const RED_GALLERY", "red_v2_gallery", "startsWith(raw, RED_GALLERY)", "bundleTheme", "byArea[0].role = \"shelf\""]) {
  if (!codecSource.includes(marker)) errors.push(`site/free_codec.js 缺少封面图集容器支持：${marker}`);
}
// Compression quality regression: the OffscreenCanvas encoder must accept every
// target type. A `type === mime` guard silently kept PNG/JPEG bytes and held
// real themes at ~30% savings instead of turning the big bitmaps into WebP.
for (const marker of ["COMPRESSION_PRESETS", "function resolveImageTarget", "convertToBlob({ type, quality })", "iconLossless", "function requantizeGif", "GifWriter"]) {
  if (!codecSource.includes(marker)) errors.push(`site/free_codec.js 缺少压缩方案实现：${marker}`);
}
// 自选模式：编码方式（WebP/无损 PNG）、GIF 调色板、阅读背景开关都要真正传到编码器，
// 否则面板上的选项只是装饰。
for (const marker of ["codec", "gifColors", "compressReader", "target.codec === \"png\"", "阅读背景按设置保留原样"]) {
  if (!codecSource.includes(marker)) errors.push(`site/free_codec.js 缺少自选压缩参数支持：${marker}`);
}
for (const marker of ["customCompressionFactors", "compressionQualityValue", "gif_colors", "compress_reader"]) {
  if (!app.includes(marker)) errors.push(`site/app.js 缺少自选压缩面板逻辑：${marker}`);
}
if (!app.includes('loadReedenVendor?.("omggif.js")')) errors.push("React 入口未加载 omggif.js，GIF 无法重新量化");
if (!(await readFile(path.join(source, "omggif.js"), "utf8")).includes("function GifWriter")) errors.push("site/omggif.js 缺失或被截断");
if (/convertToBlob\s*&&\s*type === mime/.test(codecSource)) errors.push("site/free_codec.js 又退回同格式编码，PNG/JPEG 不会转 WebP，压缩率会掉回三成");

// 压缩丢图回归：Reeden 的固定槽位（书架背景 / 阅读背景 / 轮播图）用的是 .img，
// 改名成 .webp 就会让主题丢掉每一张背景；配置里按目录解析的相对文件名（轮播
// manifest 的 file）必须跟着改名同步；九宫格资源重编码会让切片坐标失效。
for (const marker of ["function nineSlicePaths", "options.skipPaths", "九宫格资源保留坐标，未压缩", "is Reeden's fixed slot extension"]) {
  if (!codecSource.includes(marker)) errors.push(`site/free_codec.js 缺少压缩保名/九宫格实现：${marker}`);
}
for (const marker of ["function privatePathExtension", "codec.nineSlicePaths", "function bulkHint", "syncButton.disabled = false", 'setAttribute("aria-disabled"', "先勾选要处理的条目，或点「全选」"]) {
  if (!app.includes(marker)) errors.push(`site/app.js 缺少压缩保名或批量按钮反馈实现：${marker}`);
}
for (const marker of ["function pathExtensionSuffix", "const effectiveExtension = newPath === entry.path ? pathExtensionSuffix(entry.path)"]) {
  if (!workerApi.includes(marker)) errors.push(`pages/worker-api.js 缺少加密包槽位保名实现：${marker}`);
}
if (!css.includes(".bulk-hint")) errors.push("site/styles.css 缺少 .bulk-hint，批量按钮的原因提示没有样式");

// 123 云盘登录回归：账号密码登录曾经交给同步 Worker 代发，请求从 Cloudflare
// 出口出去，123 判定「海外登录」并强制弹阿里云图形验证码，网页端因此永远
// 连不上。现在改为浏览器直连 123（这些接口都允许任意来源跨域），并补上
// 浏览器直连扫码，让不依赖图形验证的路径也能走通。
for (const marker of ["PAN123_SIGN_IN_URL", "PAN123_QR_GENERATE_URL", "PAN123_QR_RESULT_URL", "function pan123DirectSignIn", "function renderPan123Qr", "function startPan123BrowserQr", "function pollPan123BrowserQr", "async function loginPan123Quick"]) {
  if (!app.includes(marker)) errors.push(`site/app.js 缺少 123 浏览器直连登录实现：${marker}`);
}
if (!app.includes('"https://login.123pan.com/api/user/sign_in"') || !app.includes('"https://user.123pan.cn/api/user/qr-code/generate"')) errors.push("site/app.js 的 123 直连接口地址不对");
if (!app.includes('loadReedenVendor?.("qrcode.js")')) errors.push("React 入口未加载 qrcode.js，浏览器直连扫码画不出二维码");
if (!html.includes('id="pan123QrHost"')) errors.push("site/shell.jsx 缺少 #pan123QrHost，扫码二维码没有落点");
if (!html.includes('id="pan123ProbeBlock"')) errors.push("site/shell.jsx 缺少 #pan123ProbeBlock");
if (!app.includes('$("#pan123ProbeBlock").hidden = true;')) errors.push("site/app.js 未在浏览器同步模式下隐藏后台上传探针");
if (!(await readFile(path.join(source, "qrcode.js"), "utf8")).includes("var qrcode = function()")) errors.push("site/qrcode.js 不是预期的 vendor（qrcode-generator），扫码会画不出二维码");

const urlArg = process.argv.find(value => value.startsWith("--url="));
const liveUrl = (urlArg ? urlArg.slice("--url=".length) : process.env.REEDEN_CHECK_URL || "").replace(/\/+$/, "");
// Marker checks only prove that some preview-enabled build is live. Use this
// flag after a UI change to prove the deployed file is exactly this checkout.
const requireCurrent = process.argv.includes("--require-current");
const previewLimitArg = process.argv.find(value => value.startsWith("--preview-limit="));
const previewLimit = previewLimitArg ? Number(previewLimitArg.split("=")[1]) : Infinity;
if (!(previewLimit >= 0)) throw new Error("--preview-limit 必须是非负数");
if (liveUrl) {
  const get = async route => {
    const response = await fetch(`${liveUrl}${route}`, {signal: AbortSignal.timeout(25000)});
    if (!response.ok) throw new Error(`${route} 返回 HTTP ${response.status}`);
    return response;
  };
  try {
    const health = await (await get("/healthz")).json();
    if (health.ok !== true) errors.push("线上 /healthz 没有返回 {ok:true}");
    if (requireCurrent) {
      const liveHtml = Buffer.from(await (await get("/")).arrayBuffer());
      if (!liveHtml.equals(Buffer.from(emittedHtml))) errors.push("线上首页与当前 Vite 构建不一致");
      for (const file of entryAssets) {
        const liveAsset = Buffer.from(await (await get(`/${file}`)).arrayBuffer());
        if (!liveAsset.equals(await readFile(path.join(target, file)))) errors.push(`线上资源 ${file} 与本地不一致`);
      }
    }
    const liveAppBytes = Buffer.from(await (await get("/app.js")).arrayBuffer());
    const liveApp = liveAppBytes.toString("utf8");
    if (!liveApp.includes("function fontPreviewMarkup") || !liveApp.includes("font-preview-frame")) errors.push("线上 app.js 仍不是当前字体预览版本");
    if (requireCurrent && hash(await readFile(appPath)) !== hash(liveAppBytes)) errors.push("线上 /app.js 与当前 site/app.js 不一致：最新前端尚未部署");
    const library = await (await get("/api/library")).json();
    const records = Array.isArray(library.records) ? library.records : Array.isArray(library.items) ? library.items : null;
    if (!records) errors.push("线上 /api/library 没有 records/items 数组");
    else {
      const fonts = records.filter(item => item?.kind === "font");
      // 逐个检查预览图并对网络错误重试：一次并发 130 个请求会被对端断连接，
      // 随机报 fetch failed，那是网络抖动不是线上坏了。
      const previewChecks = [];
      let checkedPreviews = 0;
      for (const font of fonts) {
        const source = font.preview_url || font.view_url || font.url;
        if (!source) { previewChecks.push(`字体 ${font.id || font.file_name || "未命名"} 没有预览图片或字体文件地址`); continue; }
        if (!font.preview_url) continue;
        if (checkedPreviews >= previewLimit) continue;
        checkedPreviews++;
        let failure = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const preview = await fetch(new URL(font.preview_url, `${liveUrl}/`), {signal: AbortSignal.timeout(25000)});
            if (preview.ok) { failure = null; break; }
            failure = `字体 ${font.id || font.file_name || "未命名"} 的预览返回 HTTP ${preview.status}`;
            if (preview.status < 500) break;
          } catch (error) {
            failure = `字体 ${font.id || font.file_name || "未命名"} 的预览检查失败：${error.message}`;
          }
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400));
        }
        if (failure) previewChecks.push(failure);
      }
      errors.push(...previewChecks.filter(Boolean));
      console.log(`live check: ${records.length} records, ${fonts.length} fonts, ${checkedPreviews} preview images checked`);
      // Check the streamed ZIP endpoint without pulling any object bytes.
      const target = fonts[0] || records.find(item => ["theme", "font", "asset"].includes(item?.kind));
      if (target && !process.argv.includes("--skip-download-probe")) {
        const probe = await fetch(`${liveUrl}/api/download?kind=${encodeURIComponent(target.kind)}&ids=${encodeURIComponent(String(target.id))}&probe=1`);
        const result = probe.ok ? await probe.json() : null;
        if (!result?.ok) errors.push(`线上 /api/download 流式打包探测失败：HTTP ${probe.status}`);
        else console.log(`live check: /api/download probe ok (${target.kind}, ${result.count} files)`);
      }
      const session = await fetch(`${liveUrl}/api/session`, {headers: {Origin: liveUrl}, signal: AbortSignal.timeout(25000)});
      if (![200, 401].includes(session.status)) errors.push(`线上 /api/session 权限检查失败：HTTP ${session.status}`);
      // Both read-only 123 checks must exist and stay auth-gated.
      for (const route of ["/api/backup/123/verify", "/api/backup/123/list"]) {
        const probe = await fetch(`${liveUrl}${route}`, {method: "POST", headers: {Origin: liveUrl, "X-Pan123-Token": ""}});
        if (probe.status !== 401) errors.push(`线上 ${route} 鉴权探测失败：HTTP ${probe.status}`);
        else console.log(`live check: ${route} auth-gated (401)`);
      }
    }
  } catch (error) {
    errors.push(`线上检查失败：${error.message}`);
  }
}

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  const mode = liveUrl ? `static + live (${liveUrl})` : "static";
  console.log(`pages verification passed (${mode})`);
}
