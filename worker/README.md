# Reeden 免费 R2 同步 Worker

这是给 GitHub Pages 前端使用的轻量同步接口。主题和字体在手机/电脑浏览器本地处理，Worker 只负责把结果写入同一个 R2 Bucket、读取记录和返回对象。Worker 不保存 R2 Access Key；R2 通过绑定访问。

R2 对象布局：

```text
originals/<SHA-256>.red
compressed/<SHA-256>.red
fonts/<SHA-256>.<ttf|otf|woff|woff2>
previews/<SHA-256>.jpg
records/<SHA-256>.json
```

`records/` 是可合并的每资产记录集合，不用一个会被两个设备同时覆盖的总 JSON 文件。`GET /api/library` 会列出记录并返回分页 cursor。SHA-256 路径是内容地址，重复上传会覆盖同一内容地址，但不会产生第二份文件。

## 部署

1. 安装 Node.js 后，在此目录运行 `npm install -D wrangler`，或直接使用 `npx wrangler`。
2. 复制 `wrangler.toml.example` 为 `wrangler.toml`，填入 R2 Bucket 名称和 GitHub Pages 完整 Origin。
3. 执行 `npx wrangler login`，再执行 `npx wrangler secret put SYNC_WRITE_TOKEN`，输入一个随机的长 token。不要把 token 写进 GitHub 仓库或前端代码。
4. 执行 `npx wrangler deploy`。
5. 将生成的 `https://...workers.dev` 地址填入前端的同步设置。

GET 读取可以公开；PUT 上传需要 `Authorization: Bearer <SYNC_WRITE_TOKEN>`，并且浏览器 Origin 必须在 `ALLOWED_ORIGINS` 中。Worker 本身没有账户登录界面，因此写入 token 适合个人原型；后续可以接 Cloudflare Access。

## 接口

- `GET /healthz`：返回 `{ "ok": true }`。
- `GET /api/library`：读取 `records/`，支持 `?cursor=`。
- `GET /api/themes` / `GET /api/fonts`：从共享记录中过滤主题或字体。
- `GET /api/storage`：返回 `browser-local` 同步模式；用于让前端明确显示当前没有云端后台任务。
- `GET /api/jobs`：返回空任务列表和本地处理说明。
- `POST /api/jobs`：返回 501，明确拒绝创建云端后台任务，不伪造成功状态。
- `GET /api/objects/<kind>/<sha>.<ext>`：读取对象。
- `PUT /api/objects/<kind>/<sha>.<ext>`：上传对象，Worker 会读取内容并校验 SHA-256。
- `OPTIONS ...`：返回配置的 CORS 头。

上传大小默认为 96 MiB，最多可通过 `MAX_UPLOAD_BYTES` 调到 100 MiB。手机上传时建议分批，一个主题完成后再上传下一个。

## 数据边界

没有把永久 R2 密钥放进浏览器。公开 GET 的对象只要链接被发现就可下载；不要把不希望公开的原始包上传到公开读取路径。R2 和 Worker 免费额度会受 Cloudflare 当前套餐及用量限制，部署不会自动开通付费计划。
