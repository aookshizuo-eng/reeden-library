/* Device-local codec worker. Large RED buffers and image encoding stay off the UI thread. */
importScripts("./omggif.js", "./free_codec.js?v=20261120-reader");

const codec = self.ReedenFreeCodec;
if (!codec) throw new Error("ReedenFreeCodec 未加载");

function poolLimit(requested) {
  const hardware = Number(self.navigator?.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(Number(requested) || Math.min(4, hardware), 8));
}

async function mapConcurrent(items, limit, worker) {
  const values = Array.from(items || []), result = new Array(values.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      result[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.max(1, Math.min(limit, values.length || 1))}, consume));
  return result;
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value || []);
}

function detach(bytes) {
  const view = bytesOf(bytes);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

async function dispatch(request) {
  const {command}=request;
  const options={...(request.options||{}),...(request.progress?{onProgress:progress=>self.postMessage({id:request.id,progress})}:{})};
  if (["inspectContainer", "compressRed", "inspectFont", "extractPrivatePreviewImages"].includes(command)) {
    const bytes = bytesOf(request.bytes);
    const result = await codec[command](bytes, options);
    if (result?.bytes instanceof Uint8Array) {
      const buffer = detach(result.bytes);
      return {result: {...result, bytes: buffer}, transfer: [buffer]};
    }
    return {result, transfer: []};
  }
  if (command === "compressImages") {
    const items = Array.isArray(request.items) ? request.items : [];
    let done=0;
    const settled = await mapConcurrent(items, poolLimit(options.concurrency), async item => {
      try {
        const result = await codec.compressImage(bytesOf(item.bytes), item.name || "", options);
        options.onProgress?.({stage:"image",completed:++done,total:items.length,name:item.name});
        const buffer = detach(result.bytes);
        return {ok: true, bytes: buffer, mime: result.mime, decision: result.decision};
      } catch (error) {
        return {ok: false, bytes: detach(item.bytes), mime: "", decision: {path: item.name || "", used: false, reason: error?.message || "压缩失败"}};
      }
    });
    return {result: {results: settled}, transfer: settled.map(item => item.bytes).filter(Boolean)};
  }
  if (command === "hashes") {
    const items = Array.isArray(request.items) ? request.items : [];
    const results = await mapConcurrent(items, poolLimit(options.concurrency), async item => {
      const bytes = bytesOf(item.bytes);
      const [sha256, md5] = await Promise.all([codec.sha256Hex(bytes), codec.md5Hex(bytes)]);
      return {sha256, md5, length: bytes.length};
    });
    return {result: {results}, transfer: []};
  }
  throw new Error("未知的本地处理命令：" + command);
}

self.onmessage = async event => {
  const request = event.data || {};
  const id = request.id;
  try {
    const {result, transfer} = await dispatch(request);
    self.postMessage({id, ok: true, result}, transfer);
  } catch (error) {
    self.postMessage({id, ok: false, error: {code: error?.code || "worker_error", message: error?.message || String(error)}});
  }
};
