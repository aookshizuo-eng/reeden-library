// 压缩引用映射的回归测试（纯 Node，不依赖浏览器）。
//
// 背景：压缩后的主题包曾出现「书架背景、阅读背景、轮播图全没了」。根因是
// 压缩器把 Reeden 的固定槽位资源（light/theme_bg.img、reader_schema/<id>/bg.img、
// light/bookshelf_carousel/000.img）改名成 .webp，并且没有同步配置里按目录解析的
// 相对文件名（轮播 manifest 的 "file" 字段）。真实主题包清一色使用 .img 槽位，
// Reeden 按路径加载，改名即失联。
//
// 这里断言三条规则在浏览器端 codec、客户端映射、Worker 映射三处完全一致：
//   1. `.img` 资源永远不改名，引用里的扩展名也保持 .img；
//   2. 配置目录里的相对文件名（轮播 manifest 的 file）跟着改名同步；
//   3. 九宫格资源（card_bg / 轮播 / 阅读背景）识别出来，整张保留原样。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}\n     实际: ${JSON.stringify(actual)}\n     期望: ${JSON.stringify(expected)}`); }
}
function ok(name, condition, detail = "") {
  if (condition) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${detail}`); }
}

console.log("\n[1] site/free_codec.js（浏览器端压缩器）");
const codecSource = fs.readFileSync(path.join(ROOT, "site/free_codec.js"), "utf8");
const codecStart = codecSource.indexOf("function mapReferences");
const codecEnd = codecSource.indexOf("async function compressImage");
if (codecStart < 0 || codecEnd < 0) throw new Error("无法定位 codec 映射函数");
const codecSandbox = {console, TextDecoder, TextEncoder, JSON, Math, Object, Array, Set, Map, Uint8Array, ArrayBuffer, Error, String, Number, RegExp, Date, isFinite, parseInt, parseFloat, decodeURIComponent, encodeURIComponent};
codecSandbox.text = bytes => new TextDecoder().decode(bytes);
vm.createContext(codecSandbox);
vm.runInContext(`${codecSource.slice(codecStart, codecEnd)}
this.__api = {mapReferences, replaceImageExtension, nineSlicePaths};`, codecSandbox);
const codec = codecSandbox.__api;

check("书架背景槽位不改名", codec.replaceImageExtension("light/theme_bg.img", "image/webp"), "light/theme_bg.img");
check("阅读背景槽位不改名", codec.replaceImageExtension("reader_schema/x/bg.img", "image/webp"), "reader_schema/x/bg.img");
check("轮播槽位不改名", codec.replaceImageExtension("light/bookshelf_carousel/000.img", "image/webp"), "light/bookshelf_carousel/000.img");
check("封面按新格式改名", codec.replaceImageExtension("cover_gallery/x/1.jpg", "image/webp"), "cover_gallery/x/1.webp");
check("底栏图标按新格式改名", codec.replaceImageExtension("navbar_pack/x/home_normal.png", "image/webp"), "navbar_pack/x/home_normal.webp");
check("配置文件名不动", codec.replaceImageExtension("theme.json", "image/webp"), "theme.json");

const renamed = {"light/bookshelf_carousel/000.png": "light/bookshelf_carousel/000.webp"};
check("轮播 manifest 的相对文件名跟着改名", codec.mapReferences([{url: "AAA", file: "000.png"}], {}, {}, renamed, "light/bookshelf_carousel/manifest.json"), [{url: "AAA", file: "000.webp"}]);
check("完整资源路径命中改名", codec.mapReferences("light/bookshelf_carousel/000.png", {}, {}, renamed, "light/bookshelf_carousel/manifest.json"), "light/bookshelf_carousel/000.webp");
check("别的目录不误替换", codec.mapReferences("000.png", {}, {}, renamed, "other/dir/manifest.json"), "000.png");
check("裸哈希保持裸且大小写不变", codec.mapReferences("0123456789ABCDEF0123456789ABCDEF", {"0123456789abcdef0123456789abcdef": "fedcba9876543210fedcba9876543210"}, {}, {}, "theme.json"), "FEDCBA9876543210FEDCBA9876543210");
check("带扩展名的哈希换扩展名", codec.mapReferences("0123456789abcdef0123456789abcdef.png", {"0123456789abcdef0123456789abcdef": "fedcba9876543210fedcba9876543210"}, {"0123456789abcdef0123456789abcdef": ".webp"}, {}, "theme.json"), "fedcba9876543210fedcba9876543210.webp");

const nineEntries = [
  {name: "theme.json", bytes: Buffer.from(JSON.stringify({light: {cardBackgroundImageFit: "nineSlice", bookshelfCarouselImageFit: "nineSlice:401,126,435,127@862,242#26.069"}}))},
  {name: "light/card_bg.img", bytes: Buffer.from([1])},
  {name: "light/bookshelf_carousel/000.img", bytes: Buffer.from([2])},
  {name: "light/bookshelf_carousel/manifest.json", bytes: Buffer.from("[]")},
  {name: "reader_schema/x/schema.json", bytes: Buffer.from(JSON.stringify({backgroundImageFit: "nineSlice"}))},
  {name: "reader_schema/x/bg.img", bytes: Buffer.from([3])},
  {name: "light/theme_bg.img", bytes: Buffer.from([4])},
];
const ninePaths = codec.nineSlicePaths(nineEntries);
ok("九宫格：卡片背景保留原样", ninePaths.includes("light/card_bg.img"), JSON.stringify(ninePaths));
ok("九宫格：轮播图保留原样", ninePaths.includes("light/bookshelf_carousel/000.img"), JSON.stringify(ninePaths));
ok("九宫格：阅读背景保留原样", ninePaths.includes("reader_schema/x/bg.img"), JSON.stringify(ninePaths));
ok("九宫格：普通书架背景不误伤", !ninePaths.includes("light/theme_bg.img"), JSON.stringify(ninePaths));
ok("九宫格：manifest.json 不算图片", !ninePaths.includes("light/bookshelf_carousel/manifest.json"), JSON.stringify(ninePaths));

console.log("\n[2] site/app.js（浏览器端加密包映射）");
const appSource = fs.readFileSync(path.join(ROOT, "site/app.js"), "utf8");
const appStart = appSource.indexOf("const PRIVATE_CONFIG_INLINE_LIMIT");
const appEnd = appSource.indexOf("async function compressPrivateRedViaWorker");
if (appStart < 0 || appEnd < 0) throw new Error("无法定位 app.js 映射函数");
const appSandbox = {console, TextDecoder, TextEncoder, JSON, Map, Set, String, Number};
vm.createContext(appSandbox);
vm.runInContext(`${appSource.slice(appStart, appEnd)}
this.__api = {privateRefMaps, mapPrivateRefsClient, privateReplaceExtension};`, appSandbox);
const appApi = appSandbox.__api;

check("槽位不改名", appApi.privateReplaceExtension("light/theme_bg.img", "webp"), "light/theme_bg.img");
check("封面改名", appApi.privateReplaceExtension("cover_gallery/x/1.jpg", "webp"), "cover_gallery/x/1.webp");
const imgMaps = appApi.privateRefMaps([{path: "light/theme_bg.img", old_sha256: "a".repeat(64), new_sha256: "b".repeat(64), old_md5: "c".repeat(32), new_md5: "d".repeat(32), new_extension: "webp"}]);
check("槽位资源不登记路径改名", imgMaps.paths.size, 0);
check("槽位资源扩展名保持 img", imgMaps.extensions.get("a".repeat(64)), "img");
check("裸哈希替换", appApi.mapPrivateRefsClient("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", imgMaps), "dddddddddddddddddddddddddddddddd");
check("带扩展名的哈希扩展名保持 img", appApi.mapPrivateRefsClient("cccccccccccccccccccccccccccccccc.img", imgMaps), "dddddddddddddddddddddddddddddddd.img");
const pngMaps = appApi.privateRefMaps([{path: "light/bookshelf_carousel/000.png", old_sha256: "e".repeat(64), new_sha256: "f".repeat(64), new_extension: "webp"}]);
check("改名的资源登记路径", pngMaps.paths.get("light/bookshelf_carousel/000.png"), "light/bookshelf_carousel/000.webp");
check("相对文件名跟着改名", appApi.mapPrivateRefsClient([{url: "x", file: "000.png"}], pngMaps, "light/bookshelf_carousel/manifest.json"), [{url: "x", file: "000.webp"}]);

console.log("\n[3] pages/worker-api.js（Worker 端加密重封映射）");
const workerSource = fs.readFileSync(path.join(ROOT, "pages/worker-api.js"), "utf8");
const workerStart = workerSource.indexOf("function replacePrivateExtension");
const workerEnd = workerSource.indexOf("async function repackPrivateRed");
if (workerStart < 0 || workerEnd < 0) throw new Error("无法定位 worker 映射函数");
const workerSandbox = {console, JSON, Map, Set, String, Number};
vm.createContext(workerSandbox);
vm.runInContext(`${workerSource.slice(workerStart, workerEnd)}
this.__api = {replacePrivateExtension, mapPrivateRefs};`, workerSandbox);
const workerApi = workerSandbox.__api;

check("槽位不改名", workerApi.replacePrivateExtension("light/theme_bg.img", "webp"), "light/theme_bg.img");
check("封面改名", workerApi.replacePrivateExtension("cover_gallery/x/1.jpg", "webp"), "cover_gallery/x/1.webp");
const wHashes = new Map([["a".repeat(64), "b".repeat(64)], ["c".repeat(32), "d".repeat(32)]]);
const wPaths = new Map([["light/bookshelf_carousel/000.png", "light/bookshelf_carousel/000.webp"]]);
const wExt = new Map([["a".repeat(64), "webp"]]);
check("相对文件名跟着改名", workerApi.mapPrivateRefs([{url: "x", file: "000.png"}], wHashes, wPaths, wExt, "light/bookshelf_carousel/manifest.json"), [{url: "x", file: "000.webp"}]);
check("裸哈希替换", workerApi.mapPrivateRefs("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", wHashes, wPaths, wExt, "theme.json"), "dddddddddddddddddddddddddddddddd");
check("完整路径替换", workerApi.mapPrivateRefs("light/bookshelf_carousel/000.png", wHashes, wPaths, wExt, "theme.json"), "light/bookshelf_carousel/000.webp");

console.log(failures ? `\n失败 ${failures} 项` : "\n全部通过");
process.exit(failures ? 1 : 0);
