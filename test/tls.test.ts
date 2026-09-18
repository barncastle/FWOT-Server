import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { Cdn } from "../src/cdn.js";
import { listen, parseConfig, type ServerConfig } from "../src/index.js";
import { Store } from "../src/store.js";

const CERT = "test/fixtures/localhost-cert.pem";
const KEY = "test/fixtures/localhost-key.pem";

function config(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...parseConfig(JSON.stringify({
      host: "127.0.0.1",
      port: 0,                                       // never 8080 or 8090
      publicUrl: "https://localhost",
      tls: null,
      cdn: { servers: [], cache: false },
      logging: { verbose: false },
      scaling: { buildTime: 1.0, actionTime: 1.0, reward: 1.0, cost: 1.0 },
    })),
    ...over,
  };
}

function app() {
  const root = mkdtempSync(join(tmpdir(), "fwot-tls-"));
  return createApp({
    store: new Store(root),
    gameConfig: null,
    cdn: new Cdn(root, { servers: [], cache: false }),
    verbose: false,
  });
}

/** GET over HTTPS with the chain actually verified against the fixture CA. */
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      servername: "localhost",                       // the cert's only SAN
      ca: readFileSync(CERT),
      rejectUnauthorized: true,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("with tls set the server speaks HTTPS and its certificate verifies", async () => {
  const server = listen(config({ tls: { cert: CERT, key: KEY } }), app(), () => {});
  await new Promise((r) => server.once("listening", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await get(port, "/config/Characters");
    assert.equal(res.status, 404);                   // routed, so TLS came up
    assert.equal(res.body, "not found");
  } finally {
    server.close();
  }
});

test("TLS with an http:// publicUrl warns; no TLS with an https:// one does not", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});

  const bad = listen(
    config({ tls: { cert: CERT, key: KEY }, publicUrl: "http://lan.invalid:8090" }),
    app(), () => {});
  await new Promise((r) => bad.once("listening", r));
  bad.close();
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /publicUrl .* TLS is on/);

  // The reverse is the legitimate reverse-proxy setup.
  const proxied = listen(config({ publicUrl: "https://fwot.example.com" }), app(), () => {});
  await new Promise((r) => proxied.once("listening", r));
  proxied.close();
  assert.equal(warn.mock.callCount(), 1);
});
