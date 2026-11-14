# 免费设备本地处理模块

`free_codec.js` 不连接网络，也不包含 R2、123 或 RED 私有格式密钥。它暴露 `globalThis.ReedenFreeCodec`，并可由现有的 module 前端导入。

已支持：

- 字体 TTF/OTF/WOFF/WOFF2 的 SHA-256 查重；
- 使用浏览器 `FontFace` 加载字体，并生成 Canvas PNG 样张；
- 普通 `RED\\x04 + ZIP` 的安全目录读取；
- DEFLATE/Stored ZIP 读取与重新写入；
- PNG/JPEG/WebP 静态图片的 Canvas 缩放与同格式编码，只采用更小结果；
- GIF、APNG、动画 WebP、九宫格资源原样保留；
- 普通 RED JSON 中精确的 MD5/SHA-256 图片引用更新；
- 普通 RED 重新封包前后长度比较。

明确不支持：

- 加密 `RED\\x10` 的清单不在浏览器端解密；浏览器压缩包内明文图片后，交给配置了 `REEDEN_PRIVATE_FORMAT_KEY_B64` 的同步 Worker 认证清单并重新封包。没有同步 Worker 时，电脑本机 Python 后台仍可认证、压缩图片并重新封包；
- ZIP64、加密 ZIP 项、未知 ZIP 压缩方法；
- 浏览器不支持 `CompressionStream`、`DecompressionStream`、`createImageBitmap` 或 Canvas 时的图片压缩。

示例：

```js
const info = await ReedenFreeCodec.inspectFont(file);
const preview = await ReedenFreeCodec.fontPreview(file, { text: "Aa 中文 0123" });
document.querySelector("img").src = URL.createObjectURL(preview.blob);
preview.release();

const result = await ReedenFreeCodec.compressRed(redFile, { quality: 88, maxEdge: 2048 });
const download = URL.createObjectURL(new Blob([result.bytes], { type: "application/octet-stream" }));
```

大文件应放在 Web Worker 中逐项处理；当前模块本身不承诺页面关闭或手机切后台后继续。输出必须在本地保存或上传 R2 后再释放输入文件。浏览器端不能保存 R2 Access Key、Secret、123 会话或其他长期凭据。

可以使用 `free_codec_worker.js` 将普通 RED 和字体识别放到 Worker：

```js
const worker = new Worker("./free_codec_worker.js");
worker.postMessage({ id: "one", command: "compressRed", bytes: await file.arrayBuffer(), options: { quality: 88, maxEdge: 2048 } }, [buffer]);
worker.onmessage = ({ data }) => { if (!data.ok) console.error(data.error.code, data.error.message); };
```

Worker 适配器只返回可结构化克隆的数据；字体 PNG 样张仍应在带 DOM 的页面线程调用 `fontPreview()`。

验证：在 `work/reeden-library` 目录运行 `node --test static/free_codec_test.mjs`。测试覆盖哈希向量、普通 RED ZIP round-trip、私有 RED 明确拒绝和损坏头拒绝；同步 Worker 的加密重封回归在 `worker/test-private-repack.mjs`。
