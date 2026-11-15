import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "site");
const target = path.join(root, "pages");
const staticFiles = ["index.html", "app.js", "styles.css", "free_codec.js", "free_codec_worker.js", "FREE_CODEC.md", "opentype.min.js", "omggif.js"];
const errors = [];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

for (const file of staticFiles) {
  const sourcePath = path.join(source, file);
  const targetPath = path.join(target, file);
  try {
    const [sourceBytes, targetBytes] = await Promise.all([readFile(sourcePath), readFile(targetPath)]);
    if (hash(sourceBytes) !== hash(targetBytes)) errors.push(`site/${file} 与 pages/${file} 不一致`);
    // Deploying straight from a Windows working tree used to publish CRLF
    // bytes while GitHub Pages published LF from the Git blob. Both builds
    // worked, but the two production front ends were not byte-identical.
    if (/\.[a-z]+$/i.test(file) && sourceBytes.includes(13)) errors.push(`site/${file} 含 CRLF 行尾；请先统一为 LF 再部署`);
    if (/\.[a-z]+$/i.test(file) && targetBytes.includes(13)) errors.push(`pages/${file} 含 CRLF 行尾；请先统一为 LF 再部署`);
  } catch (error) {
    errors.push(`${file} 无法读取：${error.message}`);
  }
}

const appPath = path.join(source, "app.js");
const [app, html] = await Promise.all([
  readFile(appPath, "utf8"),
  readFile(path.join(source, "index.html"), "utf8"),
]);
for (const marker of ["function fontPreviewMarkup", "function loadFontPreviewFace", "function recoverFontPreviewImage", "new FontFace(", "font-preview-frame", "font-preview-fallback", "data-font-preview-id", "data-font-id", "function renderFonts",
  "function analyzeFontGlyphs", "function inkProfile", "window.opentype", "glyph_method", "function downloadSelectedRecords", "function fetchDownloadableBytes", "function renderThemeAuthorFilter", "function compressPrivateRedWithDirectory", "function queueFilesForLater", "function resumeStagedJobs", "function backupOriginalTo123", "function runCodecTask", "function loadLibraryAfterConnection", "function fetchWithReadTimeout", "API_READ_TIMEOUT_MS", "已连接共享库", "function verifyPan123Backup", "/api/backup/123/verify", "已连接 123 云盘", "function refreshPan123BackupList", "function verifyPan123Write", "/api/backup/123/list", "123 已备份", "encodeURIComponent(config.folder)", "encodeURIComponent(fileName)", "已用 ${seconds} 秒", "function autoResumeStagedQueue", "reeden-auto-resume-queue", "auto_commit", 'fetch(apiUrl(key), {method: "DELETE"', "function compressionEstimate", "COMPRESSION_PRESET_LABELS", "compressionCustomFields", "customCompressionFactors", "compressionQualityValue"]) {
  if (!app.includes(marker)) errors.push(`前端缺少关键回归标记：${marker}`);
}
for (const id of ["fontList", "fontCount", "fontEmpty", "themeAuthorFilter", "downloadSelectedTheme", "downloadSelectedFont", "downloadSelectedAsset", "queueForLater", "resumeStagedJobs", "pan123BackupToken", "verifyPan123Backup", "listPan123Backup", "verifyPan123Write", "pan123BackupList", "autoResumeQueue", "compressionPresetGroup", "compressionCustomFields", "compressionQuality", "compressionMaxEdge", "compressionQualityDown", "compressionQualityUp", "compressionQualityValue", "compressionGifColors", "compressionReader", "compressionIconLossless", "reviewProgress", "reviewProgressTitle", "reviewProgressCount", "reviewProgressBar", "reviewProgressStage", "reviewProgressCurrent"]) {
  if (!html.includes(`id=\"${id}\"`)) errors.push(`页面结构回归检查失败：缺少 #${id}`);
}
for (const file of ["app.js", "free_codec.js", "free_codec_worker.js", "omggif.js", "opentype.min.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(source, file)], {encoding: "utf8"});
  if (result.status !== 0) errors.push(`${file} 语法检查失败：${(result.stderr || result.stdout).trim()}`);
}
for (const script of ["scripts/remote-import.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, script)], {encoding: "utf8"});
  if (result.status !== 0) errors.push(`${script} 语法检查失败：${(result.stderr || result.stdout).trim()}`);
}
// The standalone Worker must share the Pages Worker implementation; a second
// hand-edited copy silently drops routes such as /api/private/repack.
const [workerEntry, workerApi] = await Promise.all([
  readFile(path.join(root, "worker", "worker.js"), "utf8"),
  readFile(path.join(root, "pages", "worker-api.js"), "utf8"),
]);
if (!workerEntry.includes('from "../pages/worker-api.js"') || !workerEntry.includes("export {default}")) errors.push("worker/worker.js 未复用 pages/worker-api.js，独立 Worker 接口会分叉");
for (const route of ['"/api/library" && request.method === "DELETE"', '"/api/private/repack"', '"/api/private/directory"', '"/api/private/seal"', '"/api/backup/123"', '"/api/backup/123/verify"', '"/api/backup/123/list"', '"/api/jobs"', '"/api/download" && request.method === "GET"']) {
  if (!workerApi.includes(route)) errors.push(`pages/worker-api.js 缺少关键路由：${route}`);
}
if (!workerApi.includes("function streamZip") || !workerApi.includes("zipEndOfCentralDirectory")) errors.push("pages/worker-api.js 缺少流式 ZIP 打包实现");
// Chinese theme names must be percent-decoded server-side, otherwise every
// non-ASCII filename is rejected before the upload starts.
if (!workerApi.includes("function headerText") || !workerApi.includes('headerText(request.headers.get("X-Pan123-Filename"))')) errors.push("pages/worker-api.js 未解码百分号编码的 123 文件名，中文主题会备份失败");
if (!workerApi.includes("function deleteStagingObject") || !workerApi.includes('spec.kind === "staging" && request.method === "DELETE"')) errors.push("pages/worker-api.js 缺少暂存文件删除，处理完的原始副本会永久占用 R2");
// Readable R2 keys and live job detail: the dashboard used to show only
// SHA-256 hashes, and job records dropped the "current file" field.
if (!workerApi.includes("function objectLabel") || !workerApi.includes("function resolveObjectKey")) errors.push("pages/worker-api.js 未保留可读文件名或重名处理，R2 里又会只剩哈希");
if (!workerApi.includes('request.headers.get("X-Content-SHA256")') || !workerApi.includes("customMetadata: {sha256: actual}")) errors.push("pages/worker-api.js 未把 SHA-256 移到请求头与对象元数据，上传将无法校验完整性");
if (!workerApi.includes("X-Content-SHA256,X-Pan123-Token")) errors.push("pages/worker-api.js 的 CORS 未放行 X-Content-SHA256，浏览器上传会被预检拦下");
if (!app.includes("function objectLabel") || !app.includes("objectFileName")) errors.push("site/app.js 缺少可读对象名生成");
if (!app.includes('"X-Content-SHA256": sha')) errors.push("site/app.js 上传时未声明内容摘要，Worker 无法校验");
if (!workerApi.includes('"stage", "current"')) errors.push("pages/worker-api.js 的 updateJob 丢弃 current，后台任务看不出在传哪个文件");
if (!app.includes("-原包") || !app.includes("-压缩")) errors.push("site/app.js 未给原包/压缩包加可读后缀");
if (!app.includes("revealTransferProgress")) errors.push("site/app.js 未在确认后滚动到本批进度面板");
const [codecSource] = await Promise.all([readFile(path.join(source, "free_codec.js"), "utf8")]);
if (!codecSource.includes("options.store")) errors.push("site/free_codec.js 缺少 Stored ZIP 选项，批量下载会重复压缩字体");
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
if (!html.includes("omggif.js")) errors.push("site/index.html 未加载 omggif.js，GIF 无法重新量化");
if (!(await readFile(path.join(source, "omggif.js"), "utf8")).includes("function GifWriter")) errors.push("site/omggif.js 缺失或被截断");
if (/convertToBlob\s*&&\s*type === mime/.test(codecSource)) errors.push("site/free_codec.js 又退回同格式编码，PNG/JPEG 不会转 WebP，压缩率会掉回三成");

const urlArg = process.argv.find(value => value.startsWith("--url="));
const liveUrl = (urlArg ? urlArg.slice("--url=".length) : process.env.REEDEN_CHECK_URL || "").replace(/\/+$/, "");
// Marker checks only prove that some preview-enabled build is live. Use this
// flag after a UI change to prove the deployed file is exactly this checkout.
const requireCurrent = process.argv.includes("--require-current");
if (liveUrl) {
  const get = async route => {
    const response = await fetch(`${liveUrl}${route}`);
    if (!response.ok) throw new Error(`${route} 返回 HTTP ${response.status}`);
    return response;
  };
  try {
    const health = await (await get("/healthz")).json();
    if (health.ok !== true) errors.push("线上 /healthz 没有返回 {ok:true}");
    const liveAppBytes = Buffer.from(await (await get("/app.js")).arrayBuffer());
    const liveApp = liveAppBytes.toString("utf8");
    if (!liveApp.includes("function fontPreviewMarkup") || !liveApp.includes("font-preview-frame")) errors.push("线上 app.js 仍不是当前字体预览版本");
    if (requireCurrent && hash(await readFile(appPath)) !== hash(liveAppBytes)) errors.push("线上 /app.js 与当前 site/app.js 不一致：最新前端尚未部署");
    const library = await (await get("/api/library")).json();
    const records = Array.isArray(library.records) ? library.records : Array.isArray(library.items) ? library.items : null;
    if (!records) errors.push("线上 /api/library 没有 records/items 数组");
    else {
      const fonts = records.filter(item => item?.kind === "font");
      const previewChecks = await Promise.all(fonts.map(async font => {
        const source = font.preview_url || font.view_url || font.url;
        if (!source) return `字体 ${font.id || font.file_name || "未命名"} 没有预览图片或字体文件地址`;
        if (!font.preview_url) return null;
        try {
          const preview = await fetch(new URL(font.preview_url, `${liveUrl}/`));
          return preview.ok ? null : `字体 ${font.id || font.file_name || "未命名"} 的预览返回 HTTP ${preview.status}`;
        } catch (error) {
          return `字体 ${font.id || font.file_name || "未命名"} 的预览检查失败：${error.message}`;
        }
      }));
      errors.push(...previewChecks.filter(Boolean));
      console.log(`live check: ${records.length} records, ${fonts.length} fonts, ${fonts.filter(item => item.preview_url).length} preview images`);
      // Check the streamed ZIP endpoint without pulling any object bytes.
      const target = fonts[0] || records.find(item => ["theme", "font", "asset"].includes(item?.kind));
      if (target) {
        const probe = await fetch(`${liveUrl}/api/download?kind=${encodeURIComponent(target.kind)}&ids=${encodeURIComponent(String(target.id))}&probe=1`);
        const result = probe.ok ? await probe.json() : null;
        if (!result?.ok) errors.push(`线上 /api/download 流式打包探测失败：HTTP ${probe.status}`);
        else console.log(`live check: /api/download probe ok (${target.kind}, ${result.count} files)`);
      }
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
