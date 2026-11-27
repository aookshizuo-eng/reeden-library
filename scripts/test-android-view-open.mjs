// 回归：文件管理器「用其他应用打开」必须能选中本 App，并把文件接进导入通道。
// 之前 Manifest 只注册了 SEND/SEND_MULTIPLE，点文件时系统发的 ACTION_VIEW
// 匹配不到，App 不出现在打开方式列表里。
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "android/app/src/main/AndroidManifest.xml");
const activityPath = path.join(root, "android/app/src/main/java/xyz/aookshizuo/reedenlibrary/MainActivity.java");
const versionPath = path.join(root, "android/version.properties");

const [manifest, activity, version] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(activityPath, "utf8"),
  readFile(versionPath, "utf8"),
]);

const errors = [];
const check = (ok, message) => { if (!ok) errors.push(message); };

// Manifest：存在带 content/file scheme 的 VIEW filter，且 DEFAULT category 齐全。
check(/<action android:name="android\.intent\.action\.VIEW"/.test(manifest), "Manifest 缺少 ACTION_VIEW，App 不会出现在「用其他应用打开」列表");
check(/<action android:name="android\.intent\.action\.SEND"/.test(manifest), "Manifest 丢失原有 ACTION_SEND（分享入口）");
check(/<action android:name="android\.intent\.action\.SEND_MULTIPLE"/.test(manifest), "Manifest 丢失原有 ACTION_SEND_MULTIPLE（多选分享入口）");
check(/<data android:scheme="content"/.test(manifest), "VIEW filter 缺少 content scheme（国内文件管理器主流）");
check(/<data android:scheme="file"/.test(manifest), "VIEW filter 缺少 file scheme（部分文件管理器仍用 file://）");
check(/<data android:mimeType="\*\/\*"/.test(manifest), "VIEW filter 缺少 */* MIME，未知类型文件（如 .red）无法匹配");
check((manifest.match(/android:name="android\.intent\.category\.DEFAULT"/g) || []).length >= 3, "DEFAULT category 数量不足（MAIN/SEND/VIEW 都要）");
check(/android:exported="true"/.test(manifest), "MainActivity 未导出，隐式 VIEW intent 无法投递");

// Java：VIEW 从 data 取 URI，且 file:// URI 有文件名兜底，否则前端按后缀分流会失败。
check(/Intent\.ACTION_VIEW\.equals\(action\)/.test(activity), "MainActivity 未识别 ACTION_VIEW");
check(/intent\.getData\(\)/.test(activity), "MainActivity 未从 VIEW intent 的 data 取文件");
check(/uri\.getLastPathSegment\(\)/.test(activity), "缺少 file:// URI 的文件名兜底，导入后前端拿不到扩展名");

// XML 良构性：拼错标签会让整个 APK 构建失败，提前拦下来。
const xmlCheck = spawnSync("python3", ["-c",
  "import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1])", manifestPath], {encoding: "utf8"});
check(xmlCheck.status === 0, `AndroidManifest.xml 不是合法 XML：${(xmlCheck.stderr || "").trim()}`);

// 版本号必须大于上一版 12，否则用户装了新 APK 也不会更新。
const codeMatch = version.match(/VERSION_CODE=(\d+)/);
const code = codeMatch ? Number(codeMatch[1]) : 0;
check(code > 12, `versionCode 仍为 ${code}（应大于 12），用户不会识别到 APK 更新`);

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`android VIEW open-target check passed (versionCode=${code})`);
}
