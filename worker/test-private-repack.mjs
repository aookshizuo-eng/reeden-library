import assert from "node:assert/strict";
import {handle} from "../pages/worker-api.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const origin = "https://example.github.io";
const token = "test-token";
const keyBytes = Uint8Array.from({length: 32}, (_, index) => index + 1);
const keyB64 = Buffer.from(keyBytes).toString("base64");
const env = {ALLOWED_ORIGINS: origin, SYNC_WRITE_TOKEN: token, REEDEN_PRIVATE_FORMAT_KEY_B64: keyB64, MAX_UPLOAD_BYTES: "1000000"};
const headers = (extra = {}) => ({Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra});

const image = Uint8Array.from([1, 2, 3, 4, 5, 6]);
const replacement = Uint8Array.from([9, 8]);
const imageSha = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const oldSha = await imageSha(image);
const newSha = await imageSha(replacement);
const theme = encoder.encode(JSON.stringify({name: "Test", light: {backgroundImage: "assets/image.img", backgroundHash: `${oldSha}.img`}}));
const manifest = {version: 2, payloadKind: "directory", entries: [
  {path: "theme.json", offset: 0, length: theme.length, sha256: await imageSha(theme), customFlag: "kept"},
  {path: "assets/image.img", offset: theme.length, length: image.length, sha256: oldSha},
]};
const nonce = crypto.getRandomValues(new Uint8Array(12));
const key = await crypto.subtle.importKey("raw", keyBytes, {name: "AES-GCM"}, false, ["encrypt", "decrypt"]);
const encryptedManifest = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: nonce}, key, encoder.encode(JSON.stringify(manifest))));
const header = {
  version: 2, resourceType: "themeBundle", payloadType: "directory", containerMode: "reedenPrivate",
  algorithm: "aes-256-gcm-manifest", assetMode: "plain-sequential", manifestNonce: Buffer.from(nonce).toString("base64"),
  manifestLength: encryptedManifest.length, unknownMetadata: {keep: true},
};
const headerBytes = encoder.encode(JSON.stringify(header));
const raw = new Uint8Array(8 + headerBytes.length + encryptedManifest.length + theme.length + image.length);
raw.set([0x52, 0x45, 0x44, 0x10], 0);
new DataView(raw.buffer).setUint32(4, headerBytes.length, false);
raw.set(headerBytes, 8);
raw.set(encryptedManifest, 8 + headerBytes.length);
raw.set(theme, 8 + headerBytes.length + encryptedManifest.length);
raw.set(image, 8 + headerBytes.length + encryptedManifest.length + theme.length);
const manifestEnd = 8 + headerBytes.length + encryptedManifest.length;
const imageOffset = manifestEnd + theme.length;
const imageEnd = imageOffset + image.length;
const toBase64 = bytes => Buffer.from(bytes).toString("base64");

const unauthorized = await handle(new Request("https://worker.example/api/private/repack", {method: "POST", headers: {Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify({red_base64: toBase64(raw), replacements: []})}), env);
assert.equal(unauthorized.status, 401);

const response = await handle(new Request("https://worker.example/api/private/repack", {
  method: "POST", headers: headers(), body: JSON.stringify({
    red_base64: toBase64(raw),
    replacements: [{offset: imageOffset, end: imageEnd, bytes_base64: toBase64(replacement), old_sha256: oldSha, new_extension: "webp"}],
  }),
}), env);
assert.equal(response.status, 200);
const result = await response.json();
assert.equal(result.ok, true);
const output = Buffer.from(result.bytes, "base64");
assert.equal(output.length, result.bytes_length);
assert.deepEqual(output.subarray(0, 4), Buffer.from("RED\x10", "binary"));

const outputHeaderLength = new DataView(output.buffer, output.byteOffset, output.byteLength).getUint32(4, false);
const outputHeader = JSON.parse(decoder.decode(output.subarray(8, 8 + outputHeaderLength)));
const outputNonce = Buffer.from(outputHeader.manifestNonce, "base64");
const outputManifestEnd = 8 + outputHeaderLength + outputHeader.manifestLength;
const outputManifest = JSON.parse(decoder.decode(await crypto.subtle.decrypt({name: "AES-GCM", iv: outputNonce}, key, output.subarray(8 + outputHeaderLength, outputManifestEnd))));
assert.equal(outputManifest.entries[0].customFlag, "kept");
assert.equal(outputManifest.entries[1].sha256, newSha);
assert.equal(outputManifest.entries[1].path, "assets/image.webp");
const outputPayload = output.subarray(outputManifestEnd);
assert.deepEqual(Array.from(outputPayload.subarray(outputManifest.entries[1].offset, outputManifest.entries[1].offset + outputManifest.entries[1].length)), Array.from(replacement));
const outputTheme = JSON.parse(decoder.decode(outputPayload.subarray(outputManifest.entries[0].offset, outputManifest.entries[0].offset + outputManifest.entries[0].length)));
assert.equal(outputTheme.light.backgroundImage, "assets/image.webp");
assert.equal(outputTheme.light.backgroundHash, `${newSha}.webp`);

// Prefix-only flow: only the authenticated header + encrypted manifest are
// sent. The browser reassembles the payload from local resource bytes.
const prefix = raw.subarray(0, manifestEnd);
const directoryResponse = await handle(new Request("https://worker.example/api/private/directory", {
  method: "POST", headers: headers(), body: JSON.stringify({prefix_base64: toBase64(prefix)}),
}), env);
assert.equal(directoryResponse.status, 200);
const directory = await directoryResponse.json();
assert.equal(directory.entries.length, 2);
assert.equal(directory.entries[1].path, "assets/image.img");
assert.equal(directory.entries[1].sha256, oldSha);

const sealResponse = await handle(new Request("https://worker.example/api/private/seal", {
  method: "POST", headers: headers(), body: JSON.stringify({
    prefix_base64: toBase64(prefix),
    replacements: [{path: "assets/image.img", old_sha256: oldSha, new_sha256: newSha, new_length: replacement.length, new_extension: "webp"}],
    configs: [{path: "theme.json", bytes_base64: toBase64(theme)}],
  }),
}), env);
assert.equal(sealResponse.status, 200);
const seal = await sealResponse.json();
assert.equal(seal.entries.length, 2);
assert.equal(seal.entries[1].path, "assets/image.webp");
assert.equal(seal.entries[1].source_path, "assets/image.img");
const sealedPrefix = Buffer.from(seal.prefix_base64, "base64");
const mappedTheme = Buffer.from(seal.configs[0].bytes_base64, "base64");
const assembled = Buffer.concat([sealedPrefix, mappedTheme, Buffer.from(replacement)]);
assert.equal(assembled.length, seal.total_length);
const sealedHeaderLength = new DataView(assembled.buffer, assembled.byteOffset, assembled.byteLength).getUint32(4, false);
const sealedHeader = JSON.parse(decoder.decode(assembled.subarray(8, 8 + sealedHeaderLength)));
const sealedNonce = Buffer.from(sealedHeader.manifestNonce, "base64");
const sealedManifestEnd = 8 + sealedHeaderLength + sealedHeader.manifestLength;
const sealedManifest = JSON.parse(decoder.decode(await crypto.subtle.decrypt({name: "AES-GCM", iv: sealedNonce}, key, assembled.subarray(8 + sealedHeaderLength, sealedManifestEnd))));
assert.equal(sealedManifest.entries[1].sha256, newSha);
assert.equal(sealedManifest.entries[1].length, replacement.length);
assert.equal(sealedManifest.entries[0].sha256, await imageSha(mappedTheme));
assert.deepEqual(Array.from(assembled.subarray(sealedManifestEnd + sealedManifest.entries[1].offset, sealedManifestEnd + sealedManifest.entries[1].offset + replacement.length)), Array.from(replacement));
const assembledTheme = JSON.parse(decoder.decode(mappedTheme));
assert.equal(assembledTheme.light.backgroundImage, "assets/image.webp");
assert.equal(assembledTheme.light.backgroundHash, `${newSha}.webp`);

const directoryUnauthorized = await handle(new Request("https://worker.example/api/private/directory", {method: "POST", headers: {Origin: origin, "Content-Type": "application/json"}, body: JSON.stringify({prefix_base64: toBase64(prefix)})}), env);
assert.equal(directoryUnauthorized.status, 401);

// 大配置（有的主题 reader_schema/*.json 单文件就 2 MB）在免费版里 JSON.parse 会
// 撞 CPU 上限，改由浏览器映射后以 mapped + sha256 提交；Worker 只登记不改内容。
const mappedThemeBytes = encoder.encode(JSON.stringify({name: "Test", light: {backgroundImage: "assets/image.webp", backgroundHash: `${newSha}.webp`}}));
const mappedThemeSha = await imageSha(mappedThemeBytes);
const mappedSealResponse = await handle(new Request("https://worker.example/api/private/seal", {
  method: "POST", headers: headers(), body: JSON.stringify({
    prefix_base64: toBase64(prefix),
    replacements: [{path: "assets/image.img", old_sha256: oldSha, new_sha256: newSha, new_length: replacement.length, new_extension: "webp"}],
    configs: [{path: "theme.json", bytes_base64: toBase64(mappedThemeBytes), mapped: true, sha256: mappedThemeSha}],
  }),
}), env);
assert.equal(mappedSealResponse.status, 200);
const mappedSeal = await mappedSealResponse.json();
assert.equal(mappedSeal.configs.length, 0, "已映射的配置不应再回传字节，否则等于白传两遍");
assert.equal(mappedSeal.entries[0].sha256, mappedThemeSha);
assert.equal(mappedSeal.entries[0].length, mappedThemeBytes.length);
assert.equal(mappedSeal.entries[0].config, true);
const mappedPrefix = Buffer.from(mappedSeal.prefix_base64, "base64");
assert.equal(mappedSeal.total_length, mappedPrefix.length + mappedThemeBytes.length + replacement.length);
const mappedHeaderLength = new DataView(mappedPrefix.buffer, mappedPrefix.byteOffset, mappedPrefix.byteLength).getUint32(4, false);
const mappedHeader = JSON.parse(decoder.decode(mappedPrefix.subarray(8, 8 + mappedHeaderLength)));
const mappedManifest = JSON.parse(decoder.decode(await crypto.subtle.decrypt({name: "AES-GCM", iv: Buffer.from(mappedHeader.manifestNonce, "base64")}, key, mappedPrefix.subarray(8 + mappedHeaderLength))));
assert.equal(mappedManifest.entries[0].sha256, mappedThemeSha);
assert.equal(mappedManifest.entries[0].length, mappedThemeBytes.length);

const badMapped = await handle(new Request("https://worker.example/api/private/seal", {
  method: "POST", headers: headers(), body: JSON.stringify({
    prefix_base64: toBase64(prefix),
    replacements: [{path: "assets/image.img", old_sha256: oldSha, new_sha256: newSha, new_length: replacement.length, new_extension: "webp"}],
    configs: [{path: "theme.json", bytes_base64: toBase64(mappedTheme), mapped: true, sha256: "nope"}],
  }),
}), env);
assert.equal(badMapped.status, 422);
console.log("private repack worker tests passed");
