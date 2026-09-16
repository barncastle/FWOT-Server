import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { md5 } from "../src/codec.js";
import { loadGameConfig, type GameConfigOptions } from "../src/gameconfig.js";

// The season set is not in the repo, so every test that needs it is skipped in
// a clean clone.
const HAVE_SET = existsSync("data/configs") && existsSync("data/events.json");
const NOW = Math.floor(Date.parse("2026-09-11T10:59:09Z") / 1000);
// RFC 5737 TEST-NET-1: a documentation address, so no real host leaks into the
// repo. The recorded reply in fixtures/config-reply.json was hashed with it.
const PUBLIC_URL = "http://192.0.2.1:8090";
const DAY = 86400;

function build(options: Partial<GameConfigOptions> = {}, root = ".") {
  const set = loadGameConfig(root, {
    publicUrl: PUBLIC_URL,
    scaling: { buildTime: 1, reward: 1, cost: 1 },
    now: NOW,
    log: () => {},
    ...options,
  });
  assert.ok(set);
  return set;
}

/** Key-sorted JSON, so an md5 of it compares content and not formatting. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function utc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

test("the season aligns to the calendar by a whole number of years", { skip: !HAVE_SET }, () => {
  const lines: string[] = [];
  const set = build({ log: (l) => lines.push(l) });

  const aligned = lines.find((l) => l.includes("season aligned"));
  assert.match(aligned ?? "", /\+9 year\(s\), 3287d -- season runs 2026-06-28 onward/);
  assert.equal(lines.filter((l) => l.includes("WARNING")).length, 0, "no month/day slipped");

  // The anchor is the earliest window in the whole set: the 2017-06-28 soft
  // launch, in WeekendEvents.
  const starts = [...set.windows.values()].flat().map((w) => w.start);
  assert.equal(Math.min(...starts), 1498644000 + 3287 * DAY);
  assert.equal([...set.windows.values()].flat().length, 68);
  assert.equal(set.gates.length, 10);

  // One shared offset: every row moved by it, and nothing else did.
  const disk = JSON.parse(readFileSync("data/configs/pod_event", "utf8"));
  const served = set.servedDoc("pod_event") as Record<string, Record<string, Record<string, number>>>;
  assert.equal(
    served["TimedPromo"]!["pod_promo"]!["startTimeUTC"],
    disk["TimedPromo"]["pod_promo"]["startTimeUTC"] + 3287 * DAY,
  );
  assert.equal(
    served["TimedPromo"]!["pod_promo"]!["endTimeUTC"],
    disk["TimedPromo"]["pod_promo"]["endTimeUTC"] + 3287 * DAY,
  );
});

test("only bk_promo is open on the recorded day", { skip: !HAVE_SET }, () => {
  const set = build();
  assert.deepEqual([...set.openGates(NOW)], ["bk_promo"]);
});

/**
 * At every window edge, each overlay row is in the state its gate says and no
 * row outside the overlay has moved.
 */
test("every gate flips its own rows, and only its own", { skip: !HAVE_SET }, () => {
  const set = build();
  const overlay = (JSON.parse(readFileSync("data/events.json", "utf8")).entries) as {
    file: string; section: string; id: string; gate: string; on: unknown; off: unknown;
  }[];

  const check = (now: number) => {
    const open = set.openGates(now);
    set.replyJson(now);
    const docs = new Map<string, Record<string, Record<string, unknown>>>();
    for (const name of new Set(overlay.map((e) => e.file))) {
      docs.set(name, set.servedDoc(name) as Record<string, Record<string, unknown>>);
    }
    const changed = new Set<string>();
    for (const name of new Set(overlay.map((e) => e.file))) {
      const base = set.baseDoc(name) as Record<string, Record<string, unknown>>;
      const served = docs.get(name)!;
      for (const section of new Set([...Object.keys(base), ...Object.keys(served)])) {
        for (const id of new Set([
          ...Object.keys(base[section] ?? {}), ...Object.keys(served[section] ?? {}),
        ])) {
          if (isDeepStrictEqual(base[section]?.[id], served[section]?.[id])) continue;
          const entry = overlay.find((e) =>
            e.file === name && e.section === section && e.id === id);
          assert.ok(entry, `unexpected change ${name}/${section}/${id} at ${utc(now)}`);
          changed.add(`${name}/${section}/${id}`);
        }
      }
    }
    // Every overlay row is in the state its gate says, changed or not.
    for (const entry of overlay) {
      assert.deepEqual(
        docs.get(entry.file)![entry.section]?.[entry.id],
        open.has(entry.gate) ? entry.on : entry.off,
        `${entry.file}/${entry.id} at ${utc(now)}`,
      );
    }
    return open;
  };

  const windows = [...set.windows.entries()].filter(([gate]) => set.gates.includes(gate));
  const earliest = Math.min(...windows.flatMap(([, ws]) => ws.map((w) => w.start)));
  assert.deepEqual([...check(earliest - DAY)], [], "nothing is open before the season");

  for (const [gate, ws] of windows) {
    for (const w of ws) {
      assert.ok(check(w.start + 3600).has(gate), `${gate} open just after its start`);
      assert.ok(!check(w.start - 3600).has(gate), `${gate} shut just before its start`);
      if (Number.isFinite(w.end)) {
        assert.ok(!check(w.end + 60).has(gate), `${gate} shut just after its end`);
        assert.ok(check(w.end - 60).has(gate), `${gate} open just before its end`);
      }
    }
  }
});

test("the manifest names, hashes and resolves every served file", { skip: !HAVE_SET }, () => {
  const set = build();
  const manifest = set.manifest();
  assert.equal(manifest.length, 127); // 128 on disk, OutfitLevel withheld
  assert.equal(manifest.filter((e) => e.file.startsWith("OutfitLevel-")).length, 0);
  assert.equal(set.servedBytes("OutfitLevel"), undefined);

  for (const entry of manifest) {
    const bytes = set.servedBytes(entry.file);
    assert.ok(bytes, entry.file);
    assert.equal(md5(bytes), entry.checksum);
    assert.equal(entry.file, `${entry.file.slice(0, -33)}-${entry.checksum}`);
    assert.equal(entry.f, entry.file);
    assert.equal(entry.m, entry.checksum);
    // The client fetches ContentPack by its bare name.
    assert.deepEqual(set.servedBytes(entry.file.slice(0, -33)), bytes);
  }
  assert.deepEqual(set.contentPackNames(),
    manifest.map((e) => e.file).filter((f) => f.startsWith("ContentPack-")));
  assert.equal(set.contentPackNames().length, 1);
});

test("an unmodified file is served as its bytes on disk", { skip: !HAVE_SET }, () => {
  const set = build();
  // Price carries three cost fields, so at 1.0 it proves the pass is skipped.
  assert.deepEqual(set.servedBytes("Price"), readFileSync("data/configs/Price"));
  const appConfig = set.servedBytes("AppConfig")!.toString("utf8");
  assert.equal(appConfig.split(`"content-url": "${PUBLIC_URL}/static/"`).length - 1, 2);
  assert.ok(!appConfig.includes("akamaized"));
});

test("the reply carries the expected fields in the expected order", { skip: !HAVE_SET }, () => {
  const set = build();
  const json = set.replyJson(NOW);
  const reply = JSON.parse(json);
  assert.deepEqual(Object.keys(reply), [
    "cksAESKeys", "useCDN", "cks", "configTree", "env", "config_tags",
    "adHocConfigs", "success",
  ]);
  assert.equal(reply.cksAESKeys, "");
  assert.equal(reply.useCDN, true);
  assert.equal(reply.env, "prod");
  assert.deepEqual(reply.config_tags, ["NUX", "NUXOnly"]);
  assert.equal(reply.success, true);
  assert.deepEqual(reply.configTree, set.manifest().map((e) => e.file.slice(0, -33)));

  const adhocs = reply.adHocConfigs.adhocs;
  assert.deepEqual(Object.keys(adhocs),
    ["Social", "Server", "AnalyticsEndpoints", "ConfigURL", "te", "Settings"]);
  assert.equal(adhocs.ConfigURL, `${PUBLIC_URL}/config/`);
  assert.equal(adhocs.Social.CalendarDate, NOW);
  assert.deepEqual(adhocs.Server, {
    CalendarDay: NOW, UtcTimeStamp: NOW, DailyBonusDate: NOW, InstallDate: NOW,
    DaysSinceInstall: 0, RunNumberToday: 1, ccpa: false,
    PeriodicBackgroundSaveFrequency: 60,
  });
  // Only the clock moves between requests.
  assert.equal(set.replyJson(NOW).length, json.length);
  assert.notEqual(set.replyJson(NOW + 1), json);
});

test("the reply matches the recorded reference reply", { skip: !HAVE_SET }, () => {
  // A reference server's reply for the same set and clock, reduced to names,
  // key order and md5s so no config content is in the repo.
  const want = JSON.parse(
    readFileSync(new URL("./fixtures/config-reply.json", import.meta.url), "utf8"),
  ) as {
    keys: string[];
    configTree: string[];
    checksums: Record<string, string>;
    content: Record<string, string>;
    configUrl: string;
  };
  // AppConfig's content-url is rewritten to publicUrl, and the fixture's AppConfig
  // md5s were taken at PUBLIC_URL, so build() must use it: any other address
  // silently moves AppConfig into the differing set below.
  const got = JSON.parse(build().replyJson(NOW));

  assert.deepEqual(got.configTree, want.configTree);
  assert.deepEqual(Object.keys(got).sort(), want.keys);

  // Every file the pipeline did not rewrite keeps the recorded md5 exactly. The
  // 17 files carrying a TimedPromo row and the 3 the overlay rewrites are
  // re-serialized compactly where the recording used indent=1, so only their
  // whitespace -- and therefore their md5 -- differs.
  const REWRITTEN = new Set([
    "AMC_Event", "Characters", "FeaturedModal", "LMB_Event", "PVP", "WeekendEvents",
    "bk_event", "bo17_event", "hw_characters", "hw_event", "ic_event",
    "invasion_characters", "invasion_event", "mon_event", "pod_event", "sh2_event",
    "slurm", "thanksgiving_event", "vday_event", "xmas_event",
  ]);
  const gotSums = new Map((got.cks as { file: string; checksum: string }[])
    .map((e) => [e.file.slice(0, -33), e.checksum]));
  const differ = Object.entries(want.checksums)
    .filter(([name, sum]) => gotSums.get(name) !== sum).map(([name]) => name);
  assert.deepEqual(differ.sort(), [...REWRITTEN].sort());

  // Content, unlike whitespace, is identical for all 127.
  for (const name of want.configTree) {
    assert.equal(md5(canonical(got.adHocConfigs[name])), want.content[name], name);
  }

  // adhocs carries the clock, and the recording was made with content-url on
  // 8090 and ConfigURL on 8080; one publicUrl cannot reproduce both, so
  // ConfigURL is necessarily left on the other port.
  assert.match(want.configUrl, /^http:\/\/[^/]+:8080\/config\/$/);
  assert.equal(got.adHocConfigs.adhocs.ConfigURL, `${PUBLIC_URL}/config/`);
  assert.notEqual(want.configUrl, got.adHocConfigs.adhocs.ConfigURL);
});

test("scaling moves the fields in the table and nothing else", { skip: !HAVE_SET }, () => {
  const plain = build();
  const timed = build({ scaling: { buildTime: 2, reward: 1, cost: 1 } });
  const costly = build({ scaling: { buildTime: 1, reward: 1, cost: 2 } });
  const paid = build({ scaling: { buildTime: 1, reward: 2, cost: 1 } });

  const rows = (set: ReturnType<typeof build>, file: string, section: string) =>
    (set.servedDoc(file) as Record<string, Record<string, Record<string, unknown>>>)[section]!;
  // Buffer.equals, so a mismatch is not a quarter-megabyte diff.
  const same = (a: Buffer | undefined, b: Buffer | undefined) =>
    a !== undefined && b !== undefined && a.equals(b);

  const before = rows(plain, "Buildings", "RentBuilding");
  const after = rows(timed, "Buildings", "RentBuilding");
  let checked = 0;
  for (const [id, row] of Object.entries(before)) {
    const wait = row["constructionTime"];
    if (typeof wait !== "number" || wait <= 0) continue;
    assert.equal(after[id]!["constructionTime"], Math.max(1, Math.round(wait * 2)), id);
    // A cost in the same row is untouched by the buildTime factor.
    assert.deepEqual(after[id]!["prices"], row["prices"], id);
    checked++;
  }
  assert.ok(checked > 100, `${checked} constructionTime rows checked`);

  const prices = rows(plain, "Price", "Price");
  const doubled = rows(costly, "Price", "Price");
  checked = 0;
  for (const [id, row] of Object.entries(prices)) {
    const cost = row["fastFinishCost"];
    if (typeof cost !== "number" || cost <= 0) continue;
    assert.equal(doubled[id]!["fastFinishCost"], Math.max(1, Math.round(cost * 2)), id);
    checked++;
  }
  assert.ok(checked > 40, `${checked} fastFinishCost rows checked`);

  // A reward never grants more of a character, a skin or a placeable, however
  // large the factor: rawInventory is the only place they appear, and it is not
  // in the table.
  const rewards = rows(plain, "Reward", "Reward");
  const richer = rows(paid, "Reward", "Reward");
  checked = 0;
  for (const [id, row] of Object.entries(rewards)) {
    if (row["rawInventory"]) {
      assert.deepEqual(richer[id]!["rawInventory"], row["rawInventory"], id);
      checked++;
    }
    const xp = row["xp"];
    if (typeof xp === "number" && xp > 0) {
      assert.equal(richer[id]!["xp"], Math.max(1, Math.round(xp * 2)), id);
    }
  }
  assert.ok(checked > 5, `${checked} rawInventory rows checked`);

  // Real money is never scaled by anything.
  assert.ok(plain.servedBytes("InAppPurchases")!.toString("utf8").includes("price_usd"));
  for (const set of [timed, costly, paid]) {
    assert.ok(same(set.servedBytes("InAppPurchases"), plain.servedBytes("InAppPurchases")));
  }

  // A factor of 1.0 skips its pass, so its files go out as they are on disk --
  // and a factor that is not 1.0 does rewrite the files it reaches.
  const onDisk = readFileSync("data/configs/Price");
  assert.ok(same(timed.servedBytes("Price"), onDisk), "buildTime does not reach Price");
  assert.ok(same(paid.servedBytes("Price"), onDisk), "reward does not reach Price");
  assert.ok(!same(costly.servedBytes("Price"), onDisk), "cost does reach Price");
});

/** A three-file set: enough for patches, literals and gate flips, no game data. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "fwot-cfg-"));
  mkdirSync(join(root, "data", "configs"), { recursive: true });
  mkdirSync(join(root, "patches"), { recursive: true });
  writeFileSync(join(root, "data", "configs", "Town"), `{
 "TimedPromo": {"t_promo": {"id": "t_promo", "startTimeUTC": 1498644000,
                            "endTimeUTC": 1498730400}},
 "Character": {"c1": {"id": "c1", "briberyId": "b1"}},
 "Price": {"p1": {"id": "p1", "fastFinishCost": 3, "materialAmount": [4, 0]}},
 "Numbers": {"n1": {"id": "n1", "a": 3.0, "b": -1.0, "c": 1e-05, "d": 7}},
 "Rows": [{"id": "r1", "keep": true}, {"id": "r2", "keep": false}]
}`);
  writeFileSync(join(root, "data", "events.json"), JSON.stringify({
    entries: [{
      file: "Town", section: "Character", id: "c1", gate: "t_promo",
      on: { id: "c1", briberyId: "b1" }, off: { id: "c1" },
    }],
  }));
  return root;
}

test("a rebuild preserves every number literal", () => {
  const root = fixture();
  const set = build({ scaling: { buildTime: 1, reward: 1, cost: 2 } }, root);
  try {
    const text = set.servedBytes("Town")!.toString("utf8");
    assert.match(text, /"a":3\.0/);
    assert.match(text, /"b":-1\.0/);
    assert.match(text, /"c":1e-05/);
    assert.match(text, /"d":7/);
    // The cost factor moved the costs, and left the zero alone.
    assert.deepEqual((set.servedDoc("Town") as any)["Price"]["p1"],
      { id: "p1", fastFinishCost: 6, materialAmount: [8, 0] });
  } finally {
    set.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a patch sets, merges and deletes; a bad one is rejected whole", () => {
  const root = fixture();
  const patch = (body: unknown) =>
    writeFileSync(join(root, "patches", "10-test.json"), JSON.stringify(body));
  try {
    patch([
      { file: "Town", section: "Character", id: "c1", op: "merge", value: { briberyId: null } },
      { file: "Town", section: "Numbers", id: "n1", op: "set", value: { id: "n1", d: 9 } },
      { file: "Town", section: "Rows", id: "r2", op: "delete" },
    ]);
    // The fixture's promo is shut at NOW, so the overlay serves the OFF row and
    // the merge lands on that.
    const first = build({}, root);
    let doc = first.servedDoc("Town") as any;
    first.close();
    assert.deepEqual(doc["Character"]["c1"], { id: "c1", briberyId: null });
    assert.deepEqual(doc["Numbers"]["n1"], { id: "n1", d: 9 });
    assert.deepEqual(doc["Rows"], [{ id: "r1", keep: true }]);

    // One unknown id rejects the whole file, so neither op lands.
    patch([
      { file: "Town", section: "Numbers", id: "n1", op: "set", value: { id: "n1", d: 11 } },
      { file: "Town", section: "Character", id: "nobody", op: "merge", value: {} },
    ]);
    const second = build({}, root);
    doc = second.servedDoc("Town") as any;
    second.close();
    assert.deepEqual(doc["Numbers"]["n1"], { id: "n1", a: 3, b: -1, c: 1e-05, d: 7 });
    assert.deepEqual(doc["Character"]["c1"], { id: "c1" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a patch with an unknown op or no value is rejected whole", () => {
  const root = fixture();
  const set = build({}, root);
  const patch = (body: unknown) =>
    writeFileSync(join(root, "patches", "10-test.json"), JSON.stringify(body));
  const numbers = () => {
    const one = build({}, root);
    try {
      return (one.servedDoc("Town") as any)["Numbers"]["n1"];
    } finally {
      one.close();
    }
  };
  try {
    // An op that is not set/merge/delete must not fall through to `set`.
    patch([{ file: "Town", section: "Numbers", id: "n1", op: "replace", value: { d: 9 } }]);
    assert.equal(numbers()["d"], 7);
    // A `set` with no value would write undefined, which serializes to nothing.
    patch([{ file: "Town", section: "Numbers", id: "n1", op: "set" }]);
    assert.equal(numbers()["d"], 7);
    // The same on a list section, where undefined becomes a null row.
    patch([{ file: "Town", section: "Rows", id: "r1", op: "set" }]);
    const one = build({}, root);
    assert.deepEqual((one.servedDoc("Town") as any)["Rows"],
      [{ id: "r1", keep: true }, { id: "r2", keep: false }]);
    one.close();
  } finally {
    set.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an overlay on a list section is refused, not flattened", () => {
  const root = fixture();
  try {
    const overlay = JSON.parse(readFileSync(join(root, "data", "events.json"), "utf8"));
    overlay.entries[0].section = "Rows";
    writeFileSync(join(root, "data", "events.json"), JSON.stringify(overlay));
    assert.throws(() => build({}, root), /Town\/Rows is not a dict section/);

    overlay.entries[0] = { ...overlay.entries[0], section: "Character", off: undefined };
    writeFileSync(join(root, "data", "events.json"), JSON.stringify(overlay));
    assert.throws(() => build({}, root), /incomplete entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a name from the previous generation still resolves", () => {
  const root = fixture();
  const set = build({}, root);
  try {
    const open = [...set.windows.get("t_promo")!][0]!;
    set.replyJson(open.start + 60);
    const onName = set.manifest().find((e) => e.file.startsWith("Town-"))!.file;
    set.replyJson(open.end + 60);
    const offName = set.manifest().find((e) => e.file.startsWith("Town-"))!.file;
    assert.notEqual(onName, offName, "the gate flip changed the file");
    // The client may still be fetching what the last reply named.
    assert.ok(set.servedBytes(onName), "the previous generation still resolves");
    assert.ok(set.servedBytes(offName));
  } finally {
    set.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("writing a patch bumps the generation and rebuilds", async () => {
  const root = fixture();
  const set = build({}, root);
  try {
    const before = set.servedBytes("Town")!.toString("utf8");
    writeFileSync(join(root, "patches", "10-test.json"), JSON.stringify([
      { file: "Town", section: "Numbers", id: "n1", op: "merge", value: { d: 42 } },
    ]));
    await new Promise((r) => setTimeout(r, 900));
    set.replyJson(NOW);
    assert.notEqual(set.servedBytes("Town")!.toString("utf8"), before);
    assert.equal((set.servedDoc("Town") as any)["Numbers"]["n1"]["d"], 42);
  } finally {
    set.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gate flip rewrites only the rows the overlay names", () => {
  const root = fixture();
  const set = build({}, root);
  try {
    const open = [...set.windows.get("t_promo")!][0]!;
    set.replyJson(open.start + 60);
    assert.deepEqual((set.servedDoc("Town") as any)["Character"]["c1"],
      { id: "c1", briberyId: "b1" });
    set.replyJson(open.end + 60);
    assert.deepEqual((set.servedDoc("Town") as any)["Character"]["c1"], { id: "c1" });
    assert.deepEqual((set.servedDoc("Town") as any)["Rows"],
      [{ id: "r1", keep: true }, { id: "r2", keep: false }]);
  } finally {
    set.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gate with no served window is fatal", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "data", "events.json"), JSON.stringify({
      entries: [{ file: "Town", section: "Character", id: "c1", gate: "no_such_promo",
        on: {}, off: {} }],
    }));
    assert.throws(() => build({}, root), /no served window no_such_promo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing overlay is fatal and an empty config dir serves nothing", () => {
  const root = fixture();
  try {
    rmSync(join(root, "data", "events.json"));
    assert.throws(() => build({}, root), /events\.json is missing/);
    rmSync(join(root, "data", "configs", "Town"));
    assert.equal(loadGameConfig(root, {
      publicUrl: PUBLIC_URL, scaling: { buildTime: 1, reward: 1, cost: 1 },
    }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
