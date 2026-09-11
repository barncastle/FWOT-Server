import { serve, type ServerType } from "@hono/node-server";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { createApp } from "../src/app.js";
import { checksum, encodeRequest, percentEncode } from "../src/codec.js";
import { Store } from "../src/store.js";

let server: ServerType;
let base: string;

before(async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "fwot-srv-")));
  const app = createApp({ store, gameConfig: null, verbose: false });
  server = serve({ fetch: app.fetch, port: 0 });     // never 8080 or 8090
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

interface Reply { response: unknown[] }

async function post(
  envelope: unknown,
  init: { rpc?: string; gzip?: boolean; body?: string } = {},
): Promise<{ res: Response; text: string; json: Reply }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (init.rpc !== undefined) headers["RPC"] = init.rpc;
  // undici always asks for gzip unless told otherwise, so the plain case has
  // to say so explicitly.
  headers["Accept-Encoding"] = init.gzip ? "gzip" : "identity";
  const res = await fetch(`${base}/tapservice/api/`, {
    method: "POST",
    headers,
    body: init.body ?? encodeRequest(envelope),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  const text = raw.toString("utf8");
  return { res, text, json: JSON.parse(text) as Reply };
}

test("response[i] answers data[i] for a multi-action POST", async () => {
  const { json } = await post({
    player_id: "p1",
    data: [["getSalt", {}], ["login", {}], ["logout", {}], ["getClientMessageQueue", {}]],
  }, { rpc: "getSalt,login,logout,getClientMessageQueue" });

  assert.equal(json.response.length, 4);
  assert.ok("salt" in (json.response[0] as object));
  assert.deepEqual(json.response[1], { device_flags: [], success: true });
  assert.equal(json.response[2], null);              // logout passes through
  assert.deepEqual(json.response[3], []);            // array passes through
});

test("data wins over a disagreeing RPC header", async () => {
  const { json } = await post({ player_id: "p1", data: [["login", {}]] },
    { rpc: "getSalt,getOrCreatePlayerId,login" });
  assert.equal(json.response.length, 1);
  assert.deepEqual(json.response[0], { device_flags: [], success: true });
});

test("the RPC header is the fallback when data is absent", async () => {
  const { json } = await post({ player_id: "p1" }, { rpc: "login, logout" });
  assert.equal(json.response.length, 2);
  assert.deepEqual(json.response[0], { device_flags: [], success: true });
  assert.equal(json.response[1], null);
});

test("a mismatched checksum is logged and still served", async () => {
  const payload = JSON.stringify({ player_id: "p1", data: [["login", {}]] });
  const body = `request=${percentEncode(payload)}&chksum=${"0".repeat(32)}`;
  const { res, json } = await post(null, { body, rpc: "login" });
  assert.equal(res.status, 200);
  assert.deepEqual(json.response[0], { device_flags: [], success: true });
});

test("x-tc-digest is the checksum of the uncompressed body", async () => {
  const { res, text } = await post({ player_id: "p1", data: [["login", {}]] });
  assert.equal(res.headers.get("content-encoding"), null);
  assert.equal(res.headers.get("x-tc-digest"), checksum(text));
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
});

test("Accept-Encoding gzip returns one gzip member that inflates identically", async () => {
  const envelope = { player_id: "p1", data: [["login", {}], ["getPushPreferences", {}]] };
  const plain = await post(envelope);

  // fetch inflates transparently, so read the raw socket bytes instead.
  const packed = await rawPost(encodeRequest(envelope), "gzip");
  assert.match(packed.headers["content-encoding"]!, /gzip/);
  assert.equal(packed.body[0], 0x1f);
  assert.equal(packed.body[1], 0x8b);
  const inflated = gunzipSync(packed.body);          // throws on a second member
  assert.equal(inflated.toString("utf8"), plain.text);
  assert.equal(packed.headers["x-tc-digest"], checksum(plain.text));
});

test("the GET routes are reserved and never gzipped", async () => {
  for (const path of ["/config/Characters", "/static/a/b.png"]) {
    const res = await fetch(base + path, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-encoding"), null);
  }
});

/** A raw HTTP/1.1 POST, so the gzip bytes arrive unmodified. */
async function rawPost(body: string, encoding: string): Promise<{
  headers: Record<string, string>; body: Buffer;
}> {
  const { connect } = await import("node:net");
  const port = (server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        "POST /tapservice/api/ HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        `Accept-Encoding: ${encoding}\r\n` +
        "Content-Type: application/x-www-form-urlencoded\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "Connection: close\r\n\r\n" + body,
      );
    });
    const chunks: Buffer[] = [];
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("error", reject);
    sock.on("end", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      const headers: Record<string, string> = {};
      for (const line of all.subarray(0, split).toString("latin1").split("\r\n").slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ headers, body: all.subarray(split + 4) });
    });
  });
}
