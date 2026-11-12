/* Optional worker adapter for free_codec.js.  Keep large RED buffers off the UI thread. */
importScripts("./free_codec.js");

self.onmessage = async event => {
  const request = event.data || {};
  const id = request.id;
  try {
    if (!request.command || !["inspectContainer", "compressRed", "inspectFont"].includes(request.command)) {
      throw new ReedenFreeCodec.FreeCodecError("未知的本地处理命令", "worker_command_invalid");
    }
    const bytes = request.bytes instanceof ArrayBuffer ? new Uint8Array(request.bytes) : request.bytes;
    const result = await ReedenFreeCodec[request.command](bytes, request.options || {});
    if (result?.bytes instanceof Uint8Array) {
      const output = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength);
      self.postMessage({ id, ok: true, result: { ...result, bytes: output } }, [output]);
    } else {
      self.postMessage({ id, ok: true, result });
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: { code: error?.code || "worker_error", message: error?.message || String(error) } });
  }
};
