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
    else if ((arg === "--api" || arg.startsWith("--api="))) options.api = take("--api");
    else if ((arg === "--token" || arg.startsWith("--token="))) options.token = take("--token");
    else if ((arg === "--123-token" || arg.startsWith("--123-token="))) options.panToken = take("--123-token");
    else if ((arg === "--123-folder" || arg.startsWith("--123-folder="))) options.panFolder = take("--123-folder");
    else if ((arg === "--dir" || arg.startsWith("--dir="))) options.paths.push(take("--dir"));
    else if (arg === "--resume" || arg.startsWith("--resume=")) options.resume = take("--resume");
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
  --resume <任务ID>   接续之前的任务，重新选择同一批原文件
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
  const response = await fetch(url, {...init,signal:AbortSignal.timeout(90000)});
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
  if(files.length>1000)throw new Error("每批最多 1000 个文件，请分批选择目录");
  if (!files.length) throw new Error("没有找到受支持后缀的文件");
  console.log(`同步 API：${options.api}；待上传 ${files.length} 个文件${options.dryRun ? "（dry-run，不发送请求）" : ""}`);
  if (options.dryRun) {
    for (const file of files) console.log("  ", path.relative(process.cwd(), file));
    return;
  }
  const auth={Authorization:`Bearer ${options.token}`,Origin:new URL(options.api).origin};
  const jsonHeaders={...auth,'Content-Type':'application/json'};
  const plan=[];
  for(const file of [...new Set(files)]) {
    const bytes=await fs.readFile(file);if(bytes.length>MAX_BYTES)throw new Error(`文件超过 96 MiB：${file}`);
    const sha=crypto.createHash('sha256').update(bytes).digest('hex');plan.push({file,name:path.basename(file),sha,key:`/api/objects/staging/${sha}.${extensionOf(file)}`});
  }
  let job;
  if(options.resume) {
    if(!/^[a-f0-9]{8,64}$/.test(options.resume))throw new Error('任务 ID 无效');
    job=(await (await request(options.api+'/api/jobs/'+options.resume,{headers:auth},'读取恢复任务')).json()).job;
    if(job.kind!=='staged-import' || plan.some(item=>!job.source_keys.includes(item.key)))throw new Error('所选文件与恢复任务不匹配，未上传');
    if(job.lease?.until>Date.now())throw new Error('网页正在处理该任务，请稍后重试');
  } else {
    job=(await (await request(options.api+'/api/jobs',{method:'POST',headers:jsonHeaders,body:JSON.stringify({kind:'staged-import',title:`后台上传 ${plan.length} 个文件`,total:plan.length,items:plan.map(x=>x.name),uploads:plan.map(x=>({name:x.name,key:x.key})),source_keys:plan.map(x=>x.key),device:'cli',auto_commit:true,upload_complete:false})},'创建恢复任务')).json()).job;
  }
  console.log(`恢复任务：${job.id}；中断后使用 --resume ${job.id} 接续。`);
  const patch=async data=>request(options.api+'/api/jobs/'+job.id,{method:'PATCH',headers:jsonHeaders,body:JSON.stringify(data)},'登记任务进度');
  let completed=0;const backups=[];
  try {
    for(const item of plan) {
      if((job.done_keys||[]).includes(item.key)){console.log(`已入库，跳过 ${item.name}`);completed++;continue;}
      const bytes=await fs.readFile(item.file);
      if(crypto.createHash('sha256').update(bytes).digest('hex')!==item.sha)throw new Error(`文件在读取后发生变化：${item.name}`);
      const head=await fetch(options.api+item.key,{method:'HEAD',headers:auth,signal:AbortSignal.timeout(15000)});
      if(!head.ok || head.headers.get('X-Content-SHA256')!==item.sha)await request(options.api+item.key,{method:'PUT',headers:{...auth,'Content-Type':'application/octet-stream'},body:bytes},`上传 ${item.name}`);
      completed++;await patch({status:'uploading',stage:`原文件已暂存 ${completed}/${plan.length}`,upload_complete:false});
      console.log(`[${completed}/${plan.length}] 已暂存 ${item.name}`);
      if(extensionOf(item.file)==='red'&&options.panToken)try{
        await request(options.api+'/api/backup/123',{method:'POST',headers:{...auth,'Content-Type':'application/octet-stream','X-Pan123-Token':options.panToken,'X-Pan123-Folder':encodeURIComponent(options.panFolder),'X-Pan123-Filename':encodeURIComponent(item.name),'X-Pan123-Etag':crypto.createHash('md5').update(bytes).digest('hex')},body:bytes},`123 备份 ${item.name}`);
      }catch(error){backups.push(error.message);}
    }
    await patch({status:'queued',stage:'原文件暂存完成，等待网页处理',upload_complete:true,error:backups.join('；')});
    console.log(`暂存完成。在网页「上传与恢复」继续任务 ${job.id}。`);
    if(backups.length){console.error('123 备份未完成，R2 任务已保留：'+backups.join('；'));process.exitCode=1;}
  }catch(error){await patch({status:'partial',stage:'暂存中断，可补传原文件',error:error.message,upload_complete:false}).catch(()=>{});throw new Error(`${error.message}；恢复命令：追加 --resume ${job.id}`);}

}

main().catch(error => { console.error("后台上传失败：", error.message); process.exitCode = 1; });
