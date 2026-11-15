#!/usr/bin/env node
/**
 * Server/CLI uploader for the same Cloudflare Worker + R2 library.
 *
 * It does not compress anything: files are staged in R2 and a persistent job
 * is created, so the web UI on any device can click "继续处理暂存文件" to
 * finish compression, previews and records. Original .red packages can also
 * be backed up to 123 with a session token supplied only to this process.
 *
 *   REEDEN_SYNC_TOKEN=xxxx node scripts/remote-import.mjs --dir "D:/themes"
 *   node scripts/remote-import.mjs a.red b.ttf --123-token <token> --123-folder Red-Garden-Backup
 *
 * Tokens are read from the environment or arguments, never written to disk.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

const DEFAULT_API = "https://red-garden-sync.pages.dev";
const SUPPORTED = new Set(["red", "ttf", "otf", "woff", "woff2", "svg", "html", "htm"]);
const MAX_BYTES = 96 * 1024 * 1024;

function parseArgs(argv) {
  const options = {api: process.env.REEDEN_API_BASE || DEFAULT_API, token: process.env.REEDEN_SYNC_TOKEN || "",
    panToken: process.env.REEDEN_PAN123_TOKEN || "", panFolder: "Red-Garden-Backup", dryRun: false, paths: []};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const take = name => {
      const inline = arg.slice(name.length + 1);
      return inline ? inline : argv[++index];
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--api")) options.api = take("--api");
    else if (arg.startsWith("--token")) options.token = take("--token");
    else if (arg.startsWith("--123-token")) options.panToken = take("--123-token");
    else if (arg.startsWith("--123-folder")) options.panFolder = take("--123-folder");
    else if (arg.startsWith("--dir")) options.paths.push(take("--dir"));
    else if (arg.startsWith("--")) throw new Error(`未知参数：${arg}`);
    else options.paths.push(arg);
  }
  options.api = String(options.api).replace(/\/+$/, "");
  return options;
}

const HELP = `用法：node scripts/remote-import.mjs <文件或目录...> [选项]

选项：
  --dir <目录>        递归上传目录内受支持的文件
  --api <地址>        同步 API 地址（默认 ${DEFAULT_API}）
  --token <Token>     SYNC_WRITE_TOKEN（也可用环境变量 REEDEN_SYNC_TOKEN）
  --123-token <Token> 可选：把原始 .red 额外备份到 123 云盘（也可用 REEDEN_PAN123_TOKEN）
  --123-folder <目录> 123 备份目录，默认 Red-Garden-Backup
  --dry-run           只列出待上传文件，不发送任何请求

文件后缀：${[...SUPPORTED].join(", ")}。上传后会在 R2 创建持久化任务，网页端可继续处理。`;

async function collect(target) {
  const absolute = path.resolve(target);
  const stat = await fs.stat(absolute);
  if (stat.isFile()) return [absolute];
  const result = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.push(file);
    }
  }
  await walk(absolute);
  return result;
}

function extensionOf(file) {
  const extension = path.extname(file).slice(1).toLowerCase();
  return SUPPORTED.has(extension) ? (extension === "htm" ? "html" : extension) : "";
}

async function request(url, init, label) {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 300); } catch {}
    throw new Error(`${label} 失败（${response.status}）${detail ? `：${detail}` : ""}`);
  }
  return response;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  if (!options.paths.length) { console.log(HELP); process.exitCode = 2; return; }
  if (!options.token && !options.dryRun) throw new Error("缺少写入 Token：请用 --token 或 REEDEN_SYNC_TOKEN 提供，本机不会保存该值");
  const collected = (await Promise.all(options.paths.map(collect))).flat();
  const files = collected.filter(file => extensionOf(file)).sort();
  if (!files.length) throw new Error("没有找到受支持后缀的文件");
  console.log(`同步 API：${options.api}；待上传 ${files.length} 个文件${options.dryRun ? "（dry-run，不发送请求）" : ""}`);
  if (options.dryRun) {
    for (const file of files) console.log("  ", path.relative(process.cwd(), file));
    return;
  }
  const auth = {"Authorization": `Bearer ${options.token}`, "Content-Type": "application/octet-stream"};
  const keys = [], names = [];
  for (const [index, file] of files.entries()) {
    const bytes = new Uint8Array(await fs.readFile(file));
    if (bytes.length > MAX_BYTES) throw new Error(`文件超过 Worker 上传上限（96 MiB）：${file}`);
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const ext = extensionOf(file), name = path.basename(file);
    const key = `/api/objects/staging/${sha}.${ext}`;
    await request(options.api + key, {method: "PUT", headers: auth, body: bytes}, `上传 ${name}`);
    keys.push(key);
    names.push(name);
    console.log(`[${index + 1}/${files.length}] 已暂存 ${name} (${bytes.length} 字节)`);
    if (ext === "red" && options.panToken) {
      const md5 = crypto.createHash("md5").update(bytes).digest("hex");
      const response = await request(options.api + "/api/backup/123", {
        method: "POST",
        headers: {...auth, "X-Pan123-Token": options.panToken, "X-Pan123-Folder": options.panFolder,
          "X-Pan123-Filename": name.replace(/[\\/:*?"<>|]/g, "_"), "X-Pan123-Etag": md5},
        body: bytes,
      }, `123 备份 ${name}`);
      const result = await response.json();
      console.log(`        123 备份：${result.key}${result.reused ? "（已存在）" : ""}`);
    }
  }
  const created = await request(options.api + "/api/jobs", {
    method: "POST", headers: {"Authorization": `Bearer ${options.token}`, "Content-Type": "application/json"},
    body: JSON.stringify({kind: "staged-import", title: `后台上传 ${files.length} 个文件`, total: files.length,
      items: names, source_keys: keys, device: "cli"}),
  }, "创建后台任务");
  const job = await created.json();
  console.log(`已创建持久化任务 ${job.job?.id || "(未知)"}：在网页「后台任务」点击「继续处理暂存文件」即可完成入库。`);
}

main().catch(error => { console.error("后台上传失败：", error.message); process.exitCode = 1; });
