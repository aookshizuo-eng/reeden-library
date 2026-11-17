import {readFile} from "node:fs/promises";
import {defineConfig} from "vite";
import tailwindcss from "@tailwindcss/vite";

export const staticFiles = ["app.js", "free_codec.js", "free_codec_worker.js", "FREE_CODEC.md", "opentype.min.js", "omggif.js", "qrcode.js"];

export default defineConfig({
  root: "site",
  base: "./",
  esbuild: {jsx: "automatic"},
  plugins: [tailwindcss(), {
    name: "reeden-static",
    apply: "build",
    async buildStart() {
      for (const fileName of staticFiles) {
        const source = await readFile(new URL(`./site/${fileName}`, import.meta.url));
        this.emitFile({type: "asset", fileName, source});
      }
    },
  }],
  build: {outDir: "../dist", emptyOutDir: true, target: "chrome96"},
});
