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
console.log("private repack worker tests passed");
