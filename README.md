# Red Garden GitHub Pages 前端

这是手机和电脑共用的静态前端。它不包含 R2 密钥、123 会话或主题文件。

## 发布

将 `site/` 内容放到仓库的 `site/` 目录，并保留 `.github/workflows/pages.yml`。GitHub 仓库设置中将 Pages 的 Source 设为 **GitHub Actions**。每次推送到 `main` 会重新发布。

发布前先运行 `node scripts/sync-pages.mjs`，再运行 `node scripts/verify-pages.mjs`。检查脚本会检查 `site/` 与 Cloudflare Pages 使用的 `pages/` 是否一致、关键前端脚本是否能解析、字体页面结构和预览回归标记。不要手动复制发布文件。

如果已经有线上地址，可运行 `node scripts/verify-pages.mjs --url=https://red-garden-sync.pages.dev`，同时检查 `/healthz`、`/app.js` 和 `/api/library`。改动 UI 并部署完成后，加 `--require-current` 再跑一次：它会逐字节比对线上 `/app.js` 和当前 `site/app.js`，避免线上仍停留在旧版本却误判为发布完成。

Android APK 加载 `https://aookshizuo-eng.github.io/reeden-library/`，它来自同一仓库的 GitHub Actions 发布。修改前端后必须同时推送 `main` 让 GitHub Pages 重新发布，否则 APK 仍是旧前端。

发布后，在网站“存储设置 → 多设备访问”填写免费同步 Worker 地址和写入 Token。手机和电脑会读取同一个 R2 库。

在填写同步 Worker 地址后，页面会切换到免费浏览器本地模式：普通 RED 在当前手机/电脑读取、图片压缩、重新封包并生成书架+书封预览；字体按 SHA-256 查重后上传原字体文件，字体库优先显示已生成的样张，没有样张时在浏览器加载字体文件显示示例字形；SVG/HTML 收藏也按 SHA-256 去重，SVG 生成缩略图，HTML 用无权限 sandbox 预览，并可按作者、风格和标签分类。加密 RED v2 的图片先由当前设备压缩，再由 Worker 使用服务端私有格式密钥认证清单、更新哈希并重新封包；电脑本地 Python 服务也支持同样流程。页面关闭或手机切后台会暂停本地处理。

## 免费 Worker

`pages/worker-api.js`（由 `pages/_worker.js` 挂载，R2 绑定 `R2_ASSETS`）是 Cloudflare Pages 正在使用的同步接口；`worker/worker.js` 是可单独部署的 Worker（R2 绑定 `ASSETS`）。它们负责读写共享对象和记录，不负责压缩、重新封包或 123 后台备份；加密 RED 的重认证封包由 `/api/private/repack` 在服务端完成。页面关闭或手机被系统挂起时，本地处理会停止。

不要将 `SYNC_WRITE_TOKEN`、R2 Access Key、Secret Access Key、`REEDEN_SECRET_KEY` 或 123 会话提交到 GitHub。

## Android APK

`android/` 是一个轻量 WebView 壳：它把同一份 Pages 前端打进 APK，并保留 GitHub Pages origin，因此手机和电脑填写同一个 R2 Worker 后共用同一套主题、字体和预览库。APK 需要联网访问 R2；它不会把 R2 密钥或 123 会话打包进去。

推送仓库后，在 GitHub Actions 运行 **Build Red Garden Android APK**，下载构建产物 `red-garden-android-debug` 里的 `app-debug.apk`。这是 debug 签名包，适合个人安装；如果公开分发，需要换成自己的 release keystore。
