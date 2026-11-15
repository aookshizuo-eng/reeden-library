# Red Garden GitHub Pages 前端

这是手机和电脑共用的静态前端。它不包含 R2 密钥、123 会话或主题文件。

## 发布

将 `site/` 内容放到仓库的 `site/` 目录，并保留 `.github/workflows/pages.yml`。GitHub 仓库设置中将 Pages 的 Source 设为 **GitHub Actions**。每次推送到 `main` 会重新发布。

发布前先运行 `node scripts/sync-pages.mjs`，再运行 `node scripts/verify-pages.mjs`。检查脚本会检查 `site/` 与 Cloudflare Pages 使用的 `pages/` 是否一致、关键前端脚本是否能解析、字体页面结构和预览回归标记。不要手动复制发布文件。

如果已经有线上地址，可运行 `node scripts/verify-pages.mjs --url=https://red-garden-sync.pages.dev`，同时检查 `/healthz`、`/app.js` 和 `/api/library`。改动 UI 并部署完成后，加 `--require-current` 再跑一次：它会逐字节比对线上 `/app.js` 和当前 `site/app.js`，避免线上仍停留在旧版本却误判为发布完成。

Android APK 加载 `https://aookshizuo-eng.github.io/reeden-library/`，它来自同一仓库的 GitHub Actions 发布。修改前端后必须同时推送 `main` 让 GitHub Pages 重新发布，否则 APK 仍是旧前端。

发布后，在网站“存储设置 → 多设备访问”填写免费同步 Worker 地址和写入 Token。手机和电脑会读取同一个 R2 库。保存地址和每次打开页面时都会显示「1/3 存储配置 → 2/3 记录清单 → 3/3 任务进度」，完成后显示「已连接共享库：N 个主题、N 个字体、N 个收藏（用时 N 秒）」；读取请求 25 秒无响应会明确报超时，不会一直停在「正在读取共享库…」。

在填写同步 Worker 地址后，页面会切换到免费浏览器本地模式：普通 RED 在当前手机/电脑读取、图片压缩、重新封包并生成书架+书封预览；字体按 SHA-256 查重后上传原字体文件，并在导入时渲染字形做自动分类、生成样张图，卡片始终有可见预览；SVG/HTML 收藏也按 SHA-256 去重，SVG 生成缩略图，HTML 用无权限 sandbox 预览，并可按作者、风格和标签分类。主题可按作者筛选，三个库都支持批量删除和「下载所选」（打包成 ZIP）。批量下载由共享 Worker 的 `/api/download` 直接从 R2 流式打包：ZIP 使用 Stored 条目，不对已经压缩过的字体和 RED 包做第二次 DEFLATE，浏览器只发起一次原生下载、可在下载列表查看进度，也不会把几十 MB 文件读进 JS 内存；包内附 `manifest.json`，个别 R2 对象缺失时会写入 `__errors.json` 而不是让整个下载失败。未连接同步 API 时保留浏览器本地打包兜底。

加密 RED v2 只把 4–5 KB 的「文件头 + 加密清单」发给 Worker 的 `/api/private/directory` 解析资源目录，图片字节始终留在设备里；压缩后由 `/api/private/seal` 只重封文件头，设备本地拼装完整包。CPU 密集的 ZIP 解析、图片解码与 WebP 编码在 `free_codec_worker.js` 的 Web Worker 池里并发执行，不再阻塞界面。旧版 Worker 不存在这些接口时会自动回退到整包 `/api/private/repack`。

上传进度写入共享 R2 的持久化任务，刷新页面或换一台设备都能看到；勾选导入页的「后台暂存」会先把原文件上传到 R2 `staging/`，之后任意设备可在「后台任务」点「继续处理暂存文件」完成压缩入库。服务器/命令行也可以上传：`REEDEN_SYNC_TOKEN=<Token> node scripts/remote-import.mjs --dir <目录>`，可选 `--123-token` 把原始 RED 备份到 123 云盘。网页端在「存储设置 → 原始 RED 备份到 123 云盘」填入会话 Token 后，确认主题时会自动把未压缩原包备份到 123；Token 只保存在设备浏览器，不写进仓库或 R2。

免费模式的压缩仍由浏览器执行：页面关闭或手机切后台会暂停处理，但已上传的原文件与进度不会丢失。

## 免费 Worker

`pages/worker-api.js`（由 `pages/_worker.js` 挂载，R2 绑定 `R2_ASSETS`）是 Cloudflare Pages 正在使用的同步接口；`worker/worker.js` 是同一实现的可单独部署入口（R2 绑定 `ASSETS`）。接口包含内容寻址对象读写、共享对象安全的删除、分类更新、持久化任务（`/api/jobs`）、加密目录 `/api/private/directory`、前缀重封 `/api/private/seal`、兼容旧客户端的 `/api/private/repack`，可选的原包备份 `/api/backup/123`，以及流式批量下载 `/api/download?kind=font&ids=...`（`&probe=1` 只返回文件清单，不读取对象字节）。Worker 不持有 123 会话，浏览器也拿不到服务端私有格式密钥。

不要将 `SYNC_WRITE_TOKEN`、R2 Access Key、Secret Access Key、`REEDEN_SECRET_KEY` 或 123 会话提交到 GitHub。

## Android APK

`android/` 是一个轻量 WebView 壳：它把同一份 Pages 前端打进 APK，并保留 GitHub Pages origin，因此手机和电脑填写同一个 R2 Worker 后共用同一套主题、字体和预览库。APK 需要联网访问 R2；它不会把 R2 密钥或 123 会话打包进去。

推送仓库后，在 GitHub Actions 运行 **Build Red Garden Android APK**，下载构建产物 `red-garden-android-debug` 里的 `app-debug.apk`。这是 debug 签名包，适合个人安装；如果公开分发，需要换成自己的 release keystore。
