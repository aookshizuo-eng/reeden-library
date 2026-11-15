import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "site");
const target = path.join(root, "pages");
const staticFiles = ["index.html", "app.js", "styles.css", "free_codec.js", "free_codec_worker.js", "FREE_CODEC.md", "opentype.min.js"];
const errors = [];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

for (const file of staticFiles) {
  const sourcePath = path.join(source, file);
  const targetPath = path.join(target, file);
  try {
    const [sourceBytes, targetBytes] = await Promise.all([readFile(sourcePath), readFile(targetPath)]);
    if (hash(sourceBytes) !== hash(targetBytes)) errors.push(`site/${file} 与 pages/${file} 不一致`);
  } catch (error) {
    errors.push(`${file} 无法读取：${error.message}`);
  }
}

const appPath = path.join(source, "app.js");
const [app, html] = await Promise.all([
  readFile(appPath, "utf8"),
  readFile(path.join(source, "index.html"), "utf8"),
]);
for (const marker of ["function fontPreviewMarkup", "function loadFontPreviewFace", "function recoverFontPreviewImage", "new FontFace(", "font-preview-frame", "font-preview-fallback", "data-font-preview-id", "data-font-id", "function renderFonts"]) {
  if (!app.includes(marker)) errors.push(`前端缺少关键回归标记：${marker}`);
}
for (const id of ["fontList", "fontCount", "fontEmpty"]) {
  if (!html.includes(`id=\"${id}\"`)) errors.push(`字体页面结构回归检查失败：缺少 #${id}`);
}
for (const file of ["app.js", "free_codec.js", "free_codec_worker.js", "opentype.min.js"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(source, file)], {encoding: "utf8"});
  if (result.status !== 0) errors.push(`${file} 语法检查失败：${(result.stderr || result.stdout).trim()}`);
}
// The standalone Worker must share the Pages Worker implementation; a second
// hand-edited copy silently drops routes such as /api/private/repack.
const [workerEntry, workerApi] = await Promise.all([
  readFile(path.join(root, "worker", "worker.js"), "utf8"),
  readFile(path.join(root, "pages", "worker-api.js"), "utf8"),
]);
if (!workerEntry.includes('from "../pages/worker-api.js"') || !workerEntry.includes("export {default}")) errors.push("worker/worker.js 未复用 pages/worker-api.js，独立 Worker 接口会分叉");
for (const route of ['"/api/library" && request.method === "DELETE"', '"/api/private/repack"']) {
  if (!workerApi.includes(route)) errors.push(`pages/worker-api.js 缺少关键路由：${route}`);
}

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
