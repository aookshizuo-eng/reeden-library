import {cp, mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "site");
const target = path.join(root, "pages");
const staticFiles = ["index.html", "app.js", "styles.css", "free_codec.js", "free_codec_worker.js", "FREE_CODEC.md", "opentype.min.js"];

await mkdir(target, {recursive: true});
for (const file of staticFiles) {
  await cp(path.join(source, file), path.join(target, file));
}
console.log(`synced ${staticFiles.length} site files to pages/`);
