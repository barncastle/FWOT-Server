import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  checksum, decodePbuf, decodeRequest, encodePbuf, encodeRequest, etagFor,
  percentEncode, PREFIX_KEY, saveChecksum, SUFFIX_KEY,
} from "../src/codec.js";

interface Vectors {
  prefixKey: string;
  suffixKey: string;
  checksum: { input: string; md5: string }[];
  percentEncode: { input: string; encoded: string }[];
  encodeRequest: { envelope: unknown; body: string };
  pbuf: { rawHex: string; wire: string; cks: string; tagged: string };
  etag: { size: number; fillHex: string; etag: string }[];
}

const v = JSON.parse(
  readFileSync(new URL("./fixtures/vectors.json", import.meta.url), "utf8"),
) as Vectors;

test("keys match the reference vectors", () => {
  assert.equal(PREFIX_KEY, v.prefixKey);
  assert.equal(SUFFIX_KEY, v.suffixKey);
});

test("checksum matches the reference vectors", () => {
  for (const c of v.checksum) assert.equal(checksum(c.input), c.md5, c.input);
});

test("percent encoding matches the reference vectors", () => {
  for (const c of v.percentEncode) {
    assert.equal(percentEncode(c.input), c.encoded, c.input);
  }
});

test("a reference form body round-trips to the same envelope", () => {
  const { envelope, checksumOk } = decodeRequest(v.encodeRequest.body);
  assert.ok(checksumOk);
  assert.deepEqual(envelope, v.encodeRequest.envelope);
});

test("encodeRequest reproduces the reference body byte for byte", () => {
  assert.equal(encodeRequest(v.encodeRequest.envelope), v.encodeRequest.body);
});

test("a tampered body fails the checksum but still decodes", () => {
  const bad = v.encodeRequest.body.replace(/chksum=./, "chksum=0");
  const { envelope, checksumOk } = decodeRequest(bad);
  assert.equal(checksumOk, false);
  assert.deepEqual(envelope, v.encodeRequest.envelope);
});

test("pbuf round-trips and matches the reference cks", () => {
  const raw = Buffer.from(v.pbuf.rawHex, "hex");
  assert.deepEqual(decodePbuf(encodePbuf(raw)), raw);
  assert.deepEqual(decodePbuf(v.pbuf.wire), raw);
  assert.equal(saveChecksum(raw), v.pbuf.cks);
});

test("a p:-tagged blob decodes once the tag is stripped", () => {
  const tag = v.pbuf.tagged.slice(0, 4).indexOf(":");
  assert.ok(tag >= 0);
  assert.deepEqual(
    decodePbuf(v.pbuf.tagged.slice(tag + 1)),
    Buffer.from(v.pbuf.rawHex, "hex"),
  );
});

test("etag matches the reference vectors on both sides of 8 MiB", () => {
  for (const c of v.etag) {
    const fill = Buffer.from(c.fillHex, "hex");
    const data = Buffer.alloc(c.size);
    for (let i = 0; i < c.size; i++) data[i] = fill[i % fill.length]!;
    assert.equal(etagFor(data), c.etag, `size ${c.size}`);
  }
});

test("a 9 MiB buffer is multipart and a small one is not", () => {
  assert.match(etagFor(Buffer.alloc(11)), /^"[0-9a-f]{32}"$/);
  assert.match(etagFor(Buffer.alloc(9 * 1024 * 1024)), /^"[0-9a-f]{32}-2"$/);
});
