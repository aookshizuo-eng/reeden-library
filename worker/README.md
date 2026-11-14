# Reeden 免费 R2 同步 Worker

这是给 GitHub Pages 前端使用的轻量同步接口。普通主题和字体在手机/电脑浏览器本地处理，Worker 负责把结果写入同一个 R2 Bucket、读取记录和返回对象。加密 RED 的图片仍由浏览器先压缩，Worker 通过私有格式密钥认证清单、更新哈希并重新封包；Worker 不接收图像解码任务，也不把私钥返回浏览器。Worker 不保存 R2 Access Key；R2 通过绑定访问。

R2 对象布局：

```text
originals/<SHA-256>.red
compressed/<SHA-256>.red
fonts/<SHA-256>.<ttf|otf|woff|woff2>
previews/<SHA-256>.jpg
assets/<SHA-256>.<svg|html>
records/<SHA-256>.json
```

`records/` 是可合并的每资产记录集合，不用一个会被两个设备同时覆盖的总 JSON 文件。`GET /api/library` 会列出记录并返回分页 cursor。SHA-256 路径是内容地址，重复上传会覆盖同一内容地址，但不会产生第二份文件。

## 部署

1. 安装 Node.js 后，在此目录运行 `npm install -D wrangler`，或直接使用 `npx wrangler`。
2. 复制 `wrangler.toml.example` 为 `wrangler.toml`，填入 R2 Bucket 名称和 GitHub Pages 完整 Origin。
3. 执行 `npx wrangler login`，再执行 `npx wrangler secret put SYNC_WRITE_TOKEN`，输入一个随机的长 token。不要把 token 写进 GitHub 仓库或前端代码。
4. 对支持加密 RED 重封的部署，再执行 `npx wrangler secret put REEDEN_PRIVATE_FORMAT_KEY_B64`，写入私有格式密钥文件 `private_format_key.bin` 的 Base64 内容；不要把原始密钥或 Base64 写进仓库。
5. 执行 `npx wrangler deploy`。
6. 将生成的 `https://...workers.dev` 地址填入前端的同步设置。

GET 读取可以公开；PUT 上传需要 `Authorization: Bearer <SYNC_WRITE_TOKEN>`，并且浏览器 Origin 必须在 `ALLOWED_ORIGINS` 中。Worker 本身没有账户登录界面，因此写入 token 适合个人原型；后续可以接 Cloudflare Access。

## 接口

- `GET /healthz`：返回 `{ "ok": true }`。
- `GET /api/library`：读取 `records/`，支持 `?cursor=`。
- `GET /api/themes` / `GET /api/fonts`：从共享记录中过滤主题或字体。
- `GET /api/assets`：从共享记录中过滤 SVG/HTML 收藏。
- `GET /api/storage`：返回 `browser-local` 同步模式；用于让前端明确显示当前没有云端后台任务。
- `GET /api/jobs`：返回空任务列表和本地处理说明。
- `POST /api/jobs`：返回 501，明确拒绝创建云端后台任务，不伪造成功状态。
- `GET /api/objects/<kind>/<sha>.<ext>`：读取对象。
- `PUT` 或 `POST /api/objects/<kind>/<sha>.<ext>`：上传对象，Worker 会读取内容并校验 SHA-256。PUT 是标准方法，POST 用于兼容部分手机 WebView 或代理对 PUT 返回 405 的情况。
- `POST /api/private/repack`：需要写入 Token 和 `REEDEN_PRIVATE_FORMAT_KEY_B64`。请求包含 `red_base64` 与图片替换项 `{offset,end,bytes_base64}`；Worker 认证加密目录、更新资源哈希和 JSON 引用，再返回 `{bytes:<base64>}`。它不负责 PNG/JPEG 编码，浏览器先完成图片压缩。
- `PATCH /api/assets/<id>`、`PATCH /api/themes/<id>`、`PATCH /api/fonts/<id>`：更新作者、风格和标签；记录以新的内容寻址 JSON 保存，原文件不会重复上传。
- `OPTIONS ...`：返回配置的 CORS 头。

上传大小默认为 96 MiB，最多可通过 `MAX_UPLOAD_BYTES` 调到 100 MiB。手机上传时建议分批，一个主题完成后再上传下一个。

## 数据边界

没有把永久 R2 密钥放进浏览器。公开 GET 的对象只要链接被发现就可下载；不要把不希望公开的原始包上传到公开读取路径。R2 和 Worker 免费额度会受 Cloudflare 当前套餐及用量限制，部署不会自动开通付费计划。
