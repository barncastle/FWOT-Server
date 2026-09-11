import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { Store } from "../src/store.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "fwot-store-"));
}

const blob = (text: string) => deflateSync(Buffer.from(text)).toString("base64");

test("a save round-trips through the store", () => {
  const dir = root();
  const store = new Store(dir);
  assert.equal(store.storeSave("p1", blob("hello")), true);
  assert.deepEqual(store.loadSave("p1"), Buffer.from("hello"));
  assert.equal(store.loadSave("p2"), null);
});

test("a corrupt blob is rejected and the previous save survives", () => {
  const dir = root();
  const store = new Store(dir);
  store.storeSave("p1", blob("good"));
  assert.equal(store.storeSave("p1", "not base64 zlib at all"), false);
  assert.deepEqual(store.loadSave("p1"), Buffer.from("good"));
});

test("an empty inflated save is rejected", () => {
  const store = new Store(root());
  assert.equal(store.storeSave("p1", blob("")), false);
  assert.equal(store.loadSave("p1"), null);
});

test("history prunes to the newest 10", () => {
  const dir = root();
  const store = new Store(dir);
  for (let i = 0; i < 13; i++) store.storeSave("p1", blob(`save ${i}`));
  const files = readdirSync(join(dir, "data", "saves", "p1"));
  assert.equal(files.length, 10);
  assert.deepEqual(store.loadSave("p1"), Buffer.from("save 12"));
});

test("the users table is written atomically and reloaded on restart", () => {
  const dir = root();
  const store = new Store(dir);
  store.touch("p1", "10.0.0.1");
  store.storeSave("p1", blob("state"));
  store.flush();

  const path = join(dir, "data", "users.json");
  assert.ok(existsSync(path));
  assert.equal(existsSync(path + ".tmp"), false);   // renamed, not left behind
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
    users: Record<string, { banned: boolean; saveId: string; lastIp: string }>;
  };
  assert.equal(onDisk.users["p1"]!.banned, false);
  assert.equal(onDisk.users["p1"]!.lastIp, "10.0.0.1");

  const reopened = new Store(dir);
  assert.equal(reopened.users.get("p1")!.saveId, onDisk.users["p1"]!.saveId);
  assert.deepEqual(reopened.loadSave("p1"), Buffer.from("state"));
});

test("flush writes a change that the debounce has not fired for yet", () => {
  const dir = root();
  const store = new Store(dir);
  store.touch("p1", "10.0.0.2");
  assert.equal(existsSync(join(dir, "data", "users.json")), false);
  store.flush();
  assert.match(readFileSync(join(dir, "data", "users.json"), "utf8"), /10\.0\.0\.2/);
});

test("the debounced write lands on its own", async () => {
  const dir = root();
  const store = new Store(dir);
  store.touch("p1", "10.0.0.3");
  await new Promise((r) => setTimeout(r, 1200));
  assert.match(readFileSync(join(dir, "data", "users.json"), "utf8"), /10\.0\.0\.3/);
});

test("the new-player template is re-read when the file changes", () => {
  const dir = root();
  const store = new Store(dir);
  assert.equal(store.newPlayerTemplate().length, 0);   // no file yet
  mkdirSync(join(dir, "data"), { recursive: true });
  const path = join(dir, "data", "new_player.pb");
  writeFileSync(path, Buffer.from("first"));
  assert.deepEqual(store.newPlayerTemplate(), Buffer.from("first"));
  writeFileSync(path, Buffer.from("second!"));
  assert.deepEqual(store.newPlayerTemplate(), Buffer.from("second!"));
});
