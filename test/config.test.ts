import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseConfig } from "../src/index.js";

const GOOD = readFileSync(new URL("../config.example.json", import.meta.url), "utf8");

function mutate(fn: (c: Record<string, any>) => void): string {
  const c = JSON.parse(GOOD) as Record<string, any>;
  fn(c);
  return JSON.stringify(c);
}

test("config.example.json loads", () => {
  const c = parseConfig(GOOD);
  assert.equal(c.port, 8090);
  assert.equal(c.tls, null);
  assert.deepEqual(c.scaling, { buildTime: 1, reward: 1, cost: 1 });
  assert.equal(c.cdn.cache, true);
});

test("a trailing slash on publicUrl is dropped", () => {
  // content-url and ConfigURL append their own path.
  const c = parseConfig(mutate((c) => { c["publicUrl"] = "http://host:8090//"; }));
  assert.equal(c.publicUrl, "http://host:8090");
});

test("tls accepts a cert and key pair", () => {
  const c = parseConfig(mutate((c) => { c["tls"] = { cert: "a.pem", key: "b.pem" }; }));
  assert.deepEqual(c.tls, { cert: "a.pem", key: "b.pem" });
});

const BAD: [string, string][] = [
  ["an unknown top-level key", mutate((c) => { c["extra"] = 1; })],
  ["an unknown nested key", mutate((c) => { c["scaling"]["speed"] = 1; })],
  ["a missing key", mutate((c) => { delete c["publicUrl"]; })],
  ["a missing nested key", mutate((c) => { delete c["cdn"]["cache"]; })],
  ["scaling.cost = 0", mutate((c) => { c["scaling"]["cost"] = 0; })],
  ["a negative factor", mutate((c) => { c["scaling"]["reward"] = -1; })],
  ["a non-finite factor", mutate((c) => { c["scaling"]["buildTime"] = "2"; })],
  ["a non-integer port", mutate((c) => { c["port"] = 80.5; })],
  ["a non-string host", mutate((c) => { c["host"] = 0; })],
  ["cdn.servers holding a non-string", mutate((c) => { c["cdn"]["servers"] = [1]; })],
  ["a scheme-less cdn server", mutate((c) => { c["cdn"]["servers"] = ["cdn.example"]; })],
  ["a cdn server with no host", mutate((c) => { c["cdn"]["servers"] = ["https:///a"]; })],
  ["a half-specified tls block", mutate((c) => { c["tls"] = { cert: "a.pem" }; })],
  ["malformed JSON", "{"],
];

for (const [label, text] of BAD) {
  test(`${label} is rejected`, () => {
    assert.throws(() => parseConfig(text), /.+/);
  });
}
