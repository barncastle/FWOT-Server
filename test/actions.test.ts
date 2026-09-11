import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { handleAction, playerFor, type ActionContext, type GameConfig } from "../src/actions.js";
import { decodePbuf, md5 } from "../src/codec.js";
import { Store } from "../src/store.js";

function ctx(gameConfig: GameConfig | null = null): ActionContext {
  return { store: new Store(mkdtempSync(join(tmpdir(), "fwot-act-"))), gameConfig };
}

const ENV = { player_id: "abc123" };

/** Key sets are exactly what the client parses; they must not drift. */
const TABLE: { name: string; keys: string[] | null }[] = [
  { name: "getSalt", keys: ["salt", "signed_salt", "success"] },
  { name: "getOrCreatePlayerIdAndSalt", keys: ["salt", "signed_salt", "success"] },
  { name: "getOrCreatePlayerId", keys: ["community_id", "env", "human_id", "player_id", "success"] },
  { name: "login", keys: ["device_flags"] },
  { name: "getGameStatePB", keys: ["initial", "save_version", "saved_game_pbuf", "time_slept"] },
  { name: "saveV3", keys: ["success"] },
  { name: "getTransactionSummary", keys: ["Currency"] },
  { name: "getContentPackListV2", keys: ["content_packs", "success"] },
  { name: "getPushPreferences", keys: ["push_preferences", "success"] },
  { name: "savePushPreferences", keys: ["success"] },
  { name: "somethingUnknown", keys: [] },
  { name: "config", keys: [] },            // no config set injected
  { name: "getConfigPatch", keys: [] },
  { name: "sendInitRequest", keys: [] },
  { name: "getContentPackRevisions", keys: [] },
];

for (const row of TABLE) {
  test(`${row.name} returns the expected key set`, () => {
    const out = handleAction(row.name, ENV, {}, ctx());
    assert.ok(out !== null && typeof out === "object" && !Array.isArray(out));
    assert.deepEqual(Object.keys(out as object).sort(), row.keys);
  });
}

test("logout is null and getClientMessageQueue is an array", () => {
  assert.equal(handleAction("logout", ENV, {}, ctx()), null);
  assert.deepEqual(handleAction("getClientMessageQueue", ENV, {}, ctx()), []);
});

test("login answers exactly {device_flags: []}", () => {
  assert.deepEqual(handleAction("login", ENV, {}, ctx()), { device_flags: [] });
});

test("getTransactionSummary carries no success of its own", () => {
  assert.deepEqual(handleAction("getTransactionSummary", ENV, {}, ctx()), { Currency: {} });
});

test("getOrCreatePlayerId has a null human_id and env prod", () => {
  const out = handleAction("getOrCreatePlayerId", ENV, {}, ctx()) as Record<string, unknown>;
  assert.equal(out["human_id"], null);
  assert.equal(out["env"], "prod");
  assert.equal(out["player_id"], md5("abc123"));
  assert.equal(out["community_id"], md5("abc123").slice(0, 12));
});

test("getSalt signs a well-formed [time, salt].sig token", () => {
  const out = handleAction("getSalt", ENV, {}, ctx()) as Record<string, string>;
  assert.match(out["salt"]!, /^[0-9a-f]{32}$/);
  // The token is [<unix float>, "<salt>"], so it holds dots of its own: the
  // signature is what follows the LAST one.
  const signed = out["signed_salt"]!;
  const cut = signed.lastIndexOf(".");
  assert.ok(signed.slice(cut + 1).length > 0);
  assert.deepEqual((JSON.parse(signed.slice(0, cut)) as unknown[])[1], out["salt"]);
});

test("getGameStatePB values are strings, and a new player is initial True", () => {
  const out = handleAction("getGameStatePB", ENV, {}, ctx()) as Record<string, string>;
  for (const v of Object.values(out)) assert.equal(typeof v, "string");
  assert.equal(out["initial"], "True");
  assert.equal(out["time_slept"], "0");
  assert.equal(out["save_version"], "1.0");
  assert.equal(out["cks"], undefined);
});

test("an existing player gets initial False plus the cks of the raw save", () => {
  const c = ctx();
  const raw = Buffer.from("a saved town");
  c.store.storeSave("abc123", deflateSync(raw).toString("base64"));
  const out = handleAction("getGameStatePB", ENV, {}, c) as Record<string, string>;
  assert.equal(out["initial"], "False");
  assert.equal(out["cks"], md5(raw));
  assert.deepEqual(decodePbuf(out["saved_game_pbuf"]!), raw);
});

test("saveV3 takes its blob as a bare p:-tagged string parameter", () => {
  const c = ctx();
  const raw = Buffer.from("town state");
  const blob = "p:" + deflateSync(raw).toString("base64");
  assert.deepEqual(handleAction("saveV3", ENV, blob, c), { success: true });
  assert.deepEqual(c.store.loadSave("abc123"), raw);
});

test("a rejected saveV3 still answers success and keeps the good save", () => {
  const c = ctx();
  const raw = Buffer.from("good");
  handleAction("saveV3", ENV, "p:" + deflateSync(raw).toString("base64"), c);
  assert.deepEqual(handleAction("saveV3", ENV, "p:garbage", c), { success: true });
  assert.deepEqual(c.store.loadSave("abc123"), raw);
});

test("the config actions use the injected set when there is one", () => {
  const fake: GameConfig = {
    reply: (now) => ({ cks: [], configTree: [], now }),
    contentPackNames: () => ["ContentPack-" + "0".repeat(32)],
  };
  for (const name of ["config", "getConfigPatch", "sendInitRequest"]) {
    const out = handleAction(name, ENV, {}, ctx(fake)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), ["cks", "configTree", "now"]);
  }
  assert.deepEqual(handleAction("getContentPackRevisions", ENV, {}, ctx(fake)), {
    success: true,
    content_pack_revisions: [{ filename: "ContentPack-" + "0".repeat(32) }],
  });
});

test("playerFor falls back through id, device_id, install_id, anonymous", () => {
  assert.equal(playerFor({}, { id: "x" }), md5("x").slice(0, 16));
  assert.equal(playerFor({ device_id: "d" }, {}), md5("d").slice(0, 16));
  assert.equal(playerFor({ install_id: "i" }, {}), md5("i").slice(0, 16));
  assert.equal(playerFor({}, {}), md5("anonymous").slice(0, 16));
});
