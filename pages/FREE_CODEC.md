# 免费设备本地处理模块

`free_codec.js` 不连接网络，也不包含 R2、123 或 RED 私有格式密钥。它暴露 `globalThis.ReedenFreeCodec`，并可由现有的 module 前端导入；`free_codec_worker.js` 是生产前端实际使用的 Web Worker 适配器。

已支持：

- 字体 TTF/OTF/WOFF/WOFF2 的 SHA-256 查重；
- 普通 `RED\\x04 + ZIP` 的安全目录读取；
- DEFLATE/Stored ZIP 读取与重新写入；
- PNG/JPEG/WebP 静态图片的 Canvas 缩放与 WebP/同格式编码，只采用更小结果；`OffscreenCanvas` 与 `HTMLCanvasElement` 都用同一个编码入口，PNG/JPEG 会真正转成 WebP（早前按“格式相同才编码”的判断会让大图继续以 PNG/JPEG 落盘，整包只省三成）；
- 三档压缩方案（`COMPRESSION_PRESETS`）：`balanced` 保留原尺寸、94% 画质 WebP；`max` 按角色限制长边（底栏 384、启动图/阅读背景 1920、其余 1600）、90% 画质 WebP，且底栏会在无损 PNG 与有损 WebP 里取更小的一张；`custom` 用面板里的质量与长边上限；
- 动图 GIF（≥64 KB）用 vendored 的 omggif 重新量化：按帧矩形解码、把所有帧的颜色合并到 64/96/128 色调色板、按原来的 x/y/宽高/延时/disposal 写回，尺寸、帧数和播放节奏都不变；编码结果不小于原图时保留原字节；
- APNG、动画 WebP、`.9.png` 与带 `npTc` 标记的九宫格资源仍原样保留；
- 主题清单里的图片是用内容 MD5 引用的：替换后只改哈希，裸哈希保持裸哈希，带扩展名的引用才跟着换成新扩展名；
- 普通 RED JSON 中精确的 MD5/SHA-256 图片引用更新；
- 普通 RED 重新封包前后长度比较；
- 加密 `RED\\x10` 的明文图片帧扫描（旧版 Worker 的兼容路径）。

明确不支持：

- 加密 `RED\\x10` 的清单不在浏览器端解密。正式路径是 `/api/private/directory` 只解密文件头+清单得到资源目录，浏览器压缩明文图片后由 `/api/private/seal` 只重封文件头，设备本地拼装完整包；旧 Worker 回退到 `/api/private/repack`；
- ZIP64、加密 ZIP 项、未知 ZIP 压缩方法；
- 浏览器不支持 `CompressionStream`、`DecompressionStream`、`createImageBitmap` 或 Canvas 时的图片压缩。

示例：

```js
const info = await ReedenFreeCodec.inspectFont(file);
const result = await ReedenFreeCodec.compressRed(redFile, { quality: 88, maxEdge: 2048 });
const download = URL.createObjectURL(new Blob([result.bytes], { type: "application/octet-stream" }));
```

生产前端通过 `runCodecTask()` 使用一个最多 2 个实例的 Worker 池，命令包含 `inspectContainer`、`compressRed`、`inspectFont`、`extractPrivatePreviewImages`、`compressImages`（批内并发）和 `hashes`。大缓冲区在 transfer 前先复制，主线程仍保留原始字节用于上传与预览；Worker 不可用时自动回退到主线程。输出必须在本地保存或上传 R2 后再释放输入文件。浏览器端不能保存 R2 Access Key、Secret、123 会话或其他长期凭据。

字形分类与字体样张由 `site/app.js` 的 `analyzeFontGlyphs()` 完成：用 FontFace 渲染字形像素特征判断衬线、圆角、等宽、倾斜，并生成 JPEG 预览上传到 R2，因此字体卡片不必再下载原字体文件。Chromium 的 OTS 会拒绝部分第三方中文字体，这时自动改用已加载的 `opentype.min.js` 解析轮廓并绘制到 Canvas，仍能得出字形分类和真实样张；记录里用 `glyph_method` / `glyph_error` 标明走了哪条路径。只有两条路径都失败时才退回文件名规则，卡片依旧保留可见示例文字。

`writeZipEntries(entries, {store: true})` 会跳过 DEFLATE、直接写 Stored 条目。批量下载的对象（字体、RED 包、JPEG 预览）本身已经压缩，二次 DEFLATE 只浪费设备时间；连接同步 API 时批量下载由 Worker 的 `/api/download` 直接流式打包，只有在纯本地模式才使用这个函数兜底。

验证：`node scripts/verify-pages.mjs`、`node worker/test-worker.mjs`、`node worker/test-private-repack.mjs`。后者覆盖整包重封与新的「只传文件头」目录/封包协议；发布后可用 `node scripts/verify-pages.mjs --url=https://red-garden-sync.pages.dev --require-current` 逐字节核对线上版本。
