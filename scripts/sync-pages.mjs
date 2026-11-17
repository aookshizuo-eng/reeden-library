import {cp} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--outDir", "../dist-pages"], {cwd: root, stdio: "inherit"});
for (const file of ["_worker.js", "worker-api.js"]) {
  await cp(new URL(`../pages/${file}`, import.meta.url), new URL(`../dist-pages/${file}`, import.meta.url));
}
