import { serve, type ServerType } from "@hono/node-server";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.js";
import { Cdn } from "../src/cdn.js";
import { encodeRequest } from "../src/codec.js";
import { RateLimiter } from "../src/limits.js";
import { Store } from "../src/store.js";

let server: ServerType;
let base: string;
let store: Store;
let clock = 0;                                       // fake, so tests do not sleep

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "fwot-lim-"));
  store = new Store(root);
  const cdn = new Cdn(root, { servers: [], cache: false });
  const app = createApp({
    store, gameConfig: null, cdn, verbose: false, now: () => clock,
  });
  server = serve({ fetch: app.fetch, port: 0 });     // never 8080 or 8090
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

/** The body is always read: an undici connection left unconsumed is destroyed
 * and the next request on it fails with ECONNRESET. */
async function post(body: string): Promise<{ res: Response; text: string }> {
  const res = await fetch(`${base}/tapservice/api/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return { res, text: await res.text() };
}

/**
 * A raw HTTP/1.1 POST that closes the connection. An oversized upload is
 * answered before it has all arrived, so Node resets the socket; on a pooled
 * fetch connection that reset surfaces on the NEXT request instead.
 */
async function rawPost(body: string): Promise<number> {
  const { connect } = await import("node:net");
  const port = (server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(
        "POST /tapservice/api/ HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: application/x-www-form-urlencoded\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" + body,
      );
    });
    sock.on("data", (c: Buffer) => {
      chunks.push(c);
      const line = Buffer.concat(chunks).toString("latin1");
      if (!line.includes("\r\n")) return;
      sock.destroy();                                // the upload is moot now
      resolve(Number(line.split(" ")[1]));
    });
    sock.on("error", reject);
  });
}

async function get(path: string): Promise<number> {
  const res = await fetch(base + path);
  await res.text();
  return res.status;
}

/** An envelope padded to about `bytes` once percent-encoded. */
function paddedBody(bytes: number): string {
  const envelope = { player_id: "cap", data: [["login", {}]], pad: "" };
  const overhead = encodeRequest(envelope).length;
  envelope.pad = "a".repeat(Math.max(0, bytes - overhead));
  return encodeRequest(envelope);
}

test("a body just under the cap is served", async () => {
  const body = paddedBody(1024 * 1024 - 1024);
  assert.ok(body.length < 1024 * 1024);
  const { res, text } = await post(body);
  assert.equal(res.status, 200);
  const json = JSON.parse(text) as { response: unknown[] };
  assert.deepEqual(json.response[0], { device_flags: [], success: true });
});

test("a body over the cap is 413 and the action never runs", async () => {
  assert.equal(store.users.has("toobig"), false);
  const envelope = { player_id: "toobig", data: [["login", {}]], pad: "a".repeat(1024 * 1024) };
  assert.equal(await rawPost(encodeRequest(envelope)), 413);
  assert.equal(store.users.has("toobig"), false);
});

test("the 21st POST in a burst is 429, and a second of refill lets 2 more by", async () => {
  clock = 1_000_000;                                 // a fresh bucket for this IP
  const body = encodeRequest({ player_id: "rl", data: [["logout", {}]] });
  for (let i = 0; i < 20; i++) {
    assert.equal((await post(body)).res.status, 200, `request ${i + 1}`);
  }
  const over = await post(body);
  assert.equal(over.res.status, 429);
  assert.equal(over.res.headers.get("retry-after"), "1");

  clock += 1000;                                     // refills 2 tokens
  assert.equal((await post(body)).res.status, 200);
  assert.equal((await post(body)).res.status, 200);
  assert.equal((await post(body)).res.status, 429);
});

test("the GET routes are never rate limited", async () => {
  // The bucket is empty from the burst above; a cold boot pulls thousands of
  // assets, so these must not share it.
  for (let i = 0; i < 40; i++) {
    assert.equal(await get("/static/a/b.png"), 404);
    assert.equal(await get("/config/Characters"), 404);
  }
  assert.equal((await post(encodeRequest({ player_id: "rl" }))).res.status, 429);
});

test("each address gets its own bucket", () => {
  let at = 0;
  const limiter = new RateLimiter(() => at);
  for (let i = 0; i < 20; i++) assert.equal(limiter.allow("10.0.0.1"), true);
  assert.equal(limiter.allow("10.0.0.1"), false);
  assert.equal(limiter.allow("10.0.0.2"), true);
});

test("a bucket that has refilled to the top is forgotten", () => {
  let at = 0;
  const limiter = new RateLimiter(() => at);
  for (let i = 0; i < 4096; i++) limiter.allow(`10.1.${i >> 8}.${i & 255}`);
  assert.equal(limiter.size, 4096);

  at += 10_000;                                      // CAPACITY / REFILL_PER_SEC
  limiter.allow("10.2.0.1");
  assert.equal(limiter.size, 1);
});

test("many distinct addresses over time do not grow the map without bound", () => {
  let at = 0;
  const limiter = new RateLimiter(() => at);
  for (let i = 0; i < 20000; i++) {
    at += 1000;
    limiter.allow(`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`);
  }
  // One address per second holds at most two sweep windows' worth.
  assert.ok(limiter.size <= 20, `size ${limiter.size}`);
});

test("a flood of addresses the sweep cannot free stays linear", () => {
  // On a size trigger this is quadratic: 50k took 13.6 s.
  const limiter = new RateLimiter(() => 0);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 50000; i++) limiter.allow(`ip-${i}`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(limiter.size, 50000);                 // all live, none freeable
  assert.ok(ms < 2000, `50k fresh addresses took ${ms.toFixed(0)}ms`);
});

test("a backwards clock step does not lock an address out", () => {
  let at = 3_600_000;
  const limiter = new RateLimiter(() => at);
  for (let i = 0; i < 20; i++) assert.equal(limiter.allow("10.0.0.9"), true);

  at -= 3_600_000;                                   // NTP correction, VM resume
  assert.equal(limiter.allow("10.0.0.9"), false);    // still empty, not indebted
  at += 10_000;
  assert.equal(limiter.allow("10.0.0.9"), true);     // refilled on schedule
});
