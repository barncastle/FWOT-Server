import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync,
  writeFileSync,
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
  mkdirSync(join(dir, "data", "saves"), { recursive: true });
  const path = join(dir, "data", "saves", "default_save.pb");
  writeFileSync(path, Buffer.from("first"));
  assert.deepEqual(store.newPlayerTemplate(), Buffer.from("first"));
  writeFileSync(path, Buffer.from("second!"));
  assert.deepEqual(store.newPlayerTemplate(), Buffer.from("second!"));
});

test("a traversing player_id cannot escape the save tree", () => {
  const dir = root();
  const store = new Store(dir);
  for (const id of ["..", ".", "../..", "a/b", "..\..", "\u0000x"]) {
    assert.equal(store.storeSave(id, blob("escape")), true, id);
  }
  // Everything landed under data/saves, and nothing leaked into data/.
  assert.deepEqual(readdirSync(join(dir, "data")).sort(), ["saves"]);
  for (const name of readdirSync(join(dir, "data", "saves"))) {
    assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
  }
  assert.deepEqual(store.loadSave(".."), Buffer.from("escape"));
});

test("ids differing only in unsafe characters get separate directories", () => {
  const dir = root();
  const store = new Store(dir);
  store.storeSave("a b", blob("first"));
  store.storeSave("a_b", blob("second"));
  assert.equal(readdirSync(join(dir, "data", "saves")).length, 2);
  assert.deepEqual(store.loadSave("a b"), Buffer.from("first"));
  assert.deepEqual(store.loadSave("a_b"), Buffer.from("second"));
});

test("a hex player id stays readable on disk", () => {
  const dir = root();
  const store = new Store(dir);
  store.storeSave("0123456789abcdef", blob("x"));
  assert.deepEqual(readdirSync(join(dir, "data", "saves")), ["0123456789abcdef"]);
});

test("an over-long id is stored, not thrown", () => {
  const store = new Store(root());
  assert.equal(store.storeSave("A".repeat(4096), blob("long")), true);
  assert.deepEqual(store.loadSave("A".repeat(4096)), Buffer.from("long"));
});

test("a zlib bomb is refused during inflation, not after", () => {
  const store = new Store(root());
  const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024)).toString("base64");
  assert.ok(bomb.length < 200 * 1024, "the bomb is small on the wire");
  assert.equal(store.storeSave("p1", bomb), false);
  assert.equal(store.loadSave("p1"), null);
});

test("a save of exactly the cap is still accepted", () => {
  const store = new Store(root());
  const atCap = deflateSync(Buffer.alloc(1024 * 1024, 7)).toString("base64");
  assert.equal(store.storeSave("p1", atCap), true);
  assert.equal(store.loadSave("p1")!.length, 1024 * 1024);
});

test("an unreadable users.json starts empty instead of throwing", () => {
  const dir = root();
  mkdirSync(join(dir, "data"), { recursive: true });
  for (const bad of ['{"users": {"p1":', "null", "[]", ""]) {
    writeFileSync(join(dir, "data", "users.json"), bad);
    const store = new Store(dir);
    assert.equal(store.users.size, 0, bad);
  }
});

test("prune never deletes the save the user record points at", () => {
  const dir = root();
  const store = new Store(dir);
  for (let i = 0; i < 10; i++) store.storeSave("p1", blob(`save ${i}`));

  // Step the clock back: every existing save is dated an hour ahead, so the
  // save written next sorts OLDEST by mtime and heads the delete list while
  // the user record still points at it.
  const saveDir = join(dir, "data", "saves", "p1");
  const ahead = new Date(Date.now() + 3600_000);
  for (const name of readdirSync(saveDir)) utimesSync(join(saveDir, name), ahead, ahead);

  store.storeSave("p1", blob("live"));
  const saveId = store.users.get("p1")!.saveId!;
  assert.ok(existsSync(join(saveDir, `${saveId}.pb`)), "the live save survived");
  assert.deepEqual(store.loadSave("p1"), Buffer.from("live"));
});
