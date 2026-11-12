# Red Garden GitHub Pages 前端

这是手机和电脑共用的静态前端。它不包含 R2 密钥、123 会话或主题文件。

## 发布

将 `site/` 内容放到仓库的 `site/` 目录，并保留 `.github/workflows/pages.yml`。GitHub 仓库设置中将 Pages 的 Source 设为 **GitHub Actions**。每次推送到 `main` 会重新发布。

发布后，在网站“存储设置 → 多设备访问”填写免费同步 Worker 地址和写入 Token。手机和电脑会读取同一个 R2 库。

在填写同步 Worker 地址后，页面会切换到免费浏览器本地模式：普通 RED 在当前手机/电脑读取、图片压缩、重新封包并生成书架+书封预览，字体按 SHA-256 查重后直接上传；Worker 只负责 R2 对象和记录。加密 RED v2 在免费浏览器模式只识别并原样保存，电脑本地 Python 服务仍可做认证重封。页面关闭或手机切后台会暂停本地处理。

## 免费 Worker

`../free-sync-worker/` 是 R2 同步接口。它负责读写共享对象和记录，不负责压缩、重新封包或 123 后台备份。页面关闭或手机被系统挂起时，本地处理会停止。

不要将 `SYNC_WRITE_TOKEN`、R2 Access Key、Secret Access Key、`REEDEN_SECRET_KEY` 或 123 会话提交到 GitHub。
