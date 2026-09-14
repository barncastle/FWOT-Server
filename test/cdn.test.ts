import { serve, type ServerType } from "@hono/node-server";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { Cdn, type CdnOptions } from "../src/cdn.js";
import { etagFor } from "../src/codec.js";
import { Store } from "../src/store.js";

/** A port nothing listens on, so a connection is refused immediately. */
const DEAD = "http://127.0.0.1:1/";

interface Upstream {
  url: string;
  hits: Map<string, number>;
  server: Server;
}

/**
 * A fake CDN bucket. A name in `files` is served, a number is sent as that
 * status, and an unknown name is a 403 -- a real bucket's usual answer.
 * `delayMs` of Infinity never replies, which is what the timeout test needs.
 */
async function upstream(
  files: Record<string, Buffer | number>, delayMs = 0,
): Promise<Upstream> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").slice(1));
    hits.set(name, (hits.get(name) ?? 0) + 1);
    if (delayMs === Infinity) return;
    const entry = files[name];
    if (entry === undefined) {
      res.writeHead(403);
      res.end();
    } else if (typeof entry === "number") {
      res.writeHead(entry);
      res.end();
    } else {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(entry);
      }, delayMs).unref();
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, hits, server };
}

interface Rig {
  root: string;
  local(rel: string, data: Buffer): void;
  cached(rel: string): Buffer | null;
  get(rel: string, headers?: Record<string, string>): Promise<Response>;
  close(): void;
}

function rig(options: CdnOptions, ...fakes: Upstream[]): Rig {
  const root = mkdtempSync(join(tmpdir(), "fwot-cdn-"));
  const app = createApp({
    store: new Store(root),
    gameConfig: null,
    cdn: new Cdn(root, options),
    verbose: false,
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  const ready = new Promise((r) => server.once("listening", r));
  const base = async (): Promise<string> => {
    await ready;
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  return {
    root,
    local(rel, data) {
      const path = join(root, "data/local-cdn", rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    cached(rel) {
      const path = join(root, "data/cdn-cache", rel);
      return existsSync(path) ? readFileSync(path) : null;
    },
    async get(rel, headers = {}) {
      return fetch(`${await base()}/static/${rel}`, { headers });
    },
    close() {
      for (const fake of [...fakes.map((f) => f.server), server as ServerType]) {
        if ("closeAllConnections" in fake) fake.closeAllConnections();
        fake.close();
      }
    },
  };
}

async function bytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

const PAYLOAD = Buffer.from("an asset, compressed elsewhere");

test("an upstream hit is cached, and the repeat never reaches the upstream", async () => {
  const up = await upstream({ "a/b.ccz": PAYLOAD });
  const r = rig({ servers: [up.url], cache: true }, up);
  try {
    const first = await r.get("a/b.ccz");
    assert.equal(first.status, 200);
    assert.deepEqual(await bytes(first), PAYLOAD);
    assert.equal(up.hits.get("a/b.ccz"), 1);
    assert.deepEqual(r.cached("a/b.ccz"), PAYLOAD);

    assert.deepEqual(await bytes(await r.get("a/b.ccz")), PAYLOAD);
    assert.equal(up.hits.get("a/b.ccz"), 1);
  } finally {
    r.close();
  }
});

test("with the cache off nothing is written and every request goes upstream", async () => {
  const up = await upstream({ "a/b.ccz": PAYLOAD });
  const r = rig({ servers: [up.url], cache: false }, up);
  try {
    await r.get("a/b.ccz");
    await r.get("a/b.ccz");
    assert.equal(up.hits.get("a/b.ccz"), 2);
    assert.equal(r.cached("a/b.ccz"), null);
    assert.equal(existsSync(join(r.root, "data/cdn-cache")), false);
  } finally {
    r.close();
  }
});

test("an upstream 403 falls through to the local directory, then 404s", async () => {
  const up = await upstream({});                       // every name 403s
  const r = rig({ servers: [up.url], cache: true }, up);
  try {
    r.local("a/b.ccz", PAYLOAD);
    const hit = await r.get("a/b.ccz");
    assert.equal(hit.status, 200);
    assert.deepEqual(await bytes(hit), PAYLOAD);
    // A local hit is already on disk; caching it would only duplicate it.
    assert.equal(r.cached("a/b.ccz"), null);

    assert.equal((await r.get("nowhere.ccz")).status, 404);
    // A miss is never recorded: the client re-asks and the bucket may answer.
    assert.equal(r.cached("nowhere.ccz"), null);
  } finally {
    r.close();
  }
});

test("servers are tried in order past an error and a 404", async () => {
  const missing = await upstream({ "a/b.ccz": 404 });
  const good = await upstream({ "a/b.ccz": PAYLOAD });
  const r = rig({ servers: [DEAD, missing.url, good.url], cache: true }, missing, good);
  try {
    assert.deepEqual(await bytes(await r.get("a/b.ccz")), PAYLOAD);
    assert.equal(missing.hits.get("a/b.ccz"), 1);
    assert.equal(good.hits.get("a/b.ccz"), 1);
    assert.deepEqual(r.cached("a/b.ccz"), PAYLOAD);
  } finally {
    r.close();
  }
});

test(".compressed maps to the platform's real name", async () => {
  const astc = Buffer.from("astc bytes");
  const pvr = Buffer.from("pvr bytes");
  const up = await upstream({ "tex.astc.ccz": astc, "tex.pvr.ccz": pvr });
  const r = rig({ servers: [up.url], cache: false }, up);
  try {
    const android = await r.get("tex.compressed",
      { "User-Agent": "futurama15/1.5.7 android/28" });
    assert.deepEqual(await bytes(android), astc);

    const ios = await r.get("tex.compressed",
      { "User-Agent": "futurama15/1.5.7 ios/12.1" });
    assert.deepEqual(await bytes(ios), pvr);

    // No recognisable User-Agent: Android, the default.
    assert.deepEqual(await bytes(await r.get("tex.compressed")), astc);

    // No transcoding: a mapped name nothing has is a plain 404.
    assert.equal((await r.get("gone.compressed")).status, 404);
    assert.equal(up.hits.get("gone.compressed"), undefined);
  } finally {
    r.close();
  }
});

test("a name holding # or ? reaches the upstream whole", async () => {
  // Interpolated raw, they would become a fragment or a query and fetch a
  // different asset than the cache and the local directory look up.
  const up = await upstream({ "a#b.ccz": PAYLOAD, "c?d.ccz": PAYLOAD });
  const r = rig({ servers: [up.url], cache: true }, up);
  try {
    assert.deepEqual(await bytes(await r.get("a%23b.ccz")), PAYLOAD);
    assert.equal(up.hits.get("a#b.ccz"), 1);
    assert.deepEqual(r.cached("a#b.ccz"), PAYLOAD);

    assert.deepEqual(await bytes(await r.get("c%3Fd.ccz")), PAYLOAD);
    assert.equal(up.hits.get("c?d.ccz"), 1);
  } finally {
    r.close();
  }
});

test("a traversing name is refused without touching the disk or an upstream", async () => {
  const up = await upstream({});
  const r = rig({ servers: [up.url], cache: true }, up);
  try {
    writeFileSync(join(r.root, "secret.txt"), "not an asset");
    for (const rel of [
      "..%2fsecret.txt",
      "%2fetc%2fpasswd",
      "..%5csecret.txt",
      "c:%2fWindows%2fwin.ini",
      "a%2f..%2f..%2fsecret.txt",
      "%00",
    ]) {
      const res = await r.get(rel);
      assert.equal(res.status, 404, rel);
      assert.equal((await res.text()).includes("not an asset"), false, rel);
    }
    assert.equal(up.hits.size, 0);
  } finally {
    r.close();
  }
});

test("the reply carries the etag and is never gzipped", async () => {
  const up = await upstream({ "a/b.ccz": PAYLOAD });
  const r = rig({ servers: [up.url], cache: false }, up);
  try {
    const res = await r.get("a/b.ccz", { "Accept-Encoding": "gzip" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.equal(res.headers.get("etag"), etagFor(PAYLOAD));
    assert.equal(res.headers.get("content-encoding"), null);
    assert.deepEqual(await bytes(res), PAYLOAD);
  } finally {
    r.close();
  }
});

test("concurrent requests for one uncached name fetch it once", async () => {
  // The upstream is slow and the cache is off, so the second request can only
  // be answered once by joining the first one's flight.
  const up = await upstream({ "a/b.ccz": PAYLOAD }, 100);
  const r = rig({ servers: [up.url], cache: false }, up);
  try {
    const both = await Promise.all([r.get("a/b.ccz"), r.get("a/b.ccz")]);
    for (const res of both) assert.deepEqual(await bytes(res), PAYLOAD);
    assert.equal(up.hits.get("a/b.ccz"), 1);
  } finally {
    r.close();
  }
});

test("an upstream that never answers is abandoned and the next one serves", async () => {
  const stuck = await upstream({}, Infinity);
  const good = await upstream({ "a/b.ccz": PAYLOAD });
  const r = rig({ servers: [stuck.url, good.url], cache: false, timeoutMs: 200 },
    stuck, good);
  try {
    const started = Date.now();
    assert.deepEqual(await bytes(await r.get("a/b.ccz")), PAYLOAD);
    assert.ok(Date.now() - started < 5000);
    assert.equal(stuck.hits.get("a/b.ccz"), 1);
  } finally {
    r.close();
  }
});
