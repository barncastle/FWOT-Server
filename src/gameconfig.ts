/**
 * The served config set: the files on disk plus the four runtime derivations
 * the client sees -- the season-align promo shift, the event states, the
 * patches and the scaling factors.
 *
 * A file the pipeline does not modify is hashed and served as its ORIGINAL
 * bytes, so its md5 is unchanged. Only a modified file is re-serialized. The
 * inline adHocConfigs body is the same content with its insignificant
 * whitespace stripped -- the compact form a parse and re-dump would give, but
 * stripping instead of parsing keeps every number literal exactly as authored.
 *
 * The build is synchronous throughout, so two concurrent `config` requests
 * cannot interleave and no single-flight lock is needed.
 */
import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { md5 } from "./codec.js";

const CONFIGS_DIR = "data/configs";
const EVENTS_FILE = "data/events.json";
const PATCHES_DIR = "patches";
// Withheld from the manifest so that for a duplicate id the alphabetically
// first publisher wins. The file stays on disk, unmodified.
const EXCLUDE = new Set(["OutfitLevel"]);
const PATCH_DEBOUNCE_MS = 500;

/**
 * Node 22's JSON.rawJSON, JSON.isRawJSON and the reviver's third argument are
 * not in the es2023 lib types yet.
 */
interface RawJsonValue { rawJSON: string }
interface ParseContext { source?: string }
const J = JSON as unknown as {
  rawJSON(text: string): RawJsonValue;
  isRawJSON(value: unknown): value is RawJsonValue;
  parse(
    text: string,
    reviver: (this: unknown, key: string, value: unknown, context: ParseContext) => unknown,
  ): unknown;
};

type Row = Record<string, unknown>;

/**
 * A field the host's scaling factors may touch. The section qualifies it: the
 * same name means different things in different sections -- `amount` is a rent
 * payout in BuildingRent, a drop quantity in Drop and a premium-currency grant
 * for real money in IAPConfig, and `currencyAmount` is a reward in Reward but a
 * price in Price. Every entry below was checked against the season set.
 */
interface ScaledField {
  readonly section: string;
  readonly field: string;
  /** Row guard, where only some rows of a section qualify. */
  readonly when?: (row: Row) => boolean;
}

/** Wait times, all whole seconds. */
const BUILD_TIME_FIELDS: ScaledField[] = [
  { section: "RentBuilding", field: "constructionTime" }, // building construction wait
  { section: "Skins", field: "buildTime" },               // skin unlock wait
  { section: "CraftingRecipe", field: "craftTime" },      // crafting wait
  { section: "SoloActions", field: "duration" },          // one-character job wait
  { section: "DualAction", field: "duration" },           // two-character job wait
  { section: "BuildingRent", field: "interval" },         // wait between rent collections
  { section: "Blocks", field: "unlockingTime" },          // land clearing wait
];

// Rejected: Job has no duration (it is name/icon/colour metadata only), and
// SquatterAction.duration, *.idleTime, Goals.duration ("48h", a string) and the
// UI timings in FingerInfo/FUTips/PlayspaceDialogue are not build waits.

const CURRENCY_OR_MATERIAL_DROP = new Set(["Material", "Currency", "LootBox"]);

/** What the player is given. */
const REWARD_FIELDS: ScaledField[] = [
  { section: "Reward", field: "currencyAmount" },   // paired with currencyType
  { section: "Reward", field: "materialAmount" },   // paired with materialId
  { section: "Reward", field: "xp" },
  { section: "Reward", field: "eventXp" },
  { section: "BuildingRent", field: "amount" },     // rent payout
  { section: "BuildingRent", field: "xp" },
  { section: "Blocks", field: "xp" },
  { section: "RentBuilding", field: "constructionXp" },
  { section: "Goals", field: "reward-xp" },
  { section: "Level", field: "premiumCurrencyReward" }, // level-up payout
  // Drop.type is Material, Currency, LootBox or Decoration. A decoration drop
  // is a placeable grant, not a quantity.
  {
    section: "Drop",
    field: "amount",
    when: (r) => typeof r["type"] === "string" && CURRENCY_OR_MATERIAL_DROP.has(r["type"]),
  },
];

// Rejected: Reward.rawInventory[].amount -- it would qualify only where
// typeKey is a currency or a material, and no such row exists. Every typeKey in
// the season set is Character, Skin, RentBuilding, Head, Decoration or
// MovingDeco, none of which may be scaled. Level.xp is the threshold
// to REACH a level, not a payout. IAPConfig.amount is premium currency bought
// with real money.

/** What the player pays. */
const COST_FIELDS: ScaledField[] = [
  { section: "Price", field: "currencyAmount" },
  { section: "Price", field: "materialAmount" },
  { section: "Price", field: "materialBuyout" }, // premium buyout of the same materials
  { section: "Price", field: "fastFinishCost" },
  { section: "RentBuilding", field: "prices" },
  { section: "RentBuilding", field: "ownedPrices" },
  { section: "RentBuilding", field: "unlockCost" },
  { section: "RentBuilding", field: "fastFinishCost" },
  { section: "BuildingRent", field: "fastFinishCost" },
  { section: "Blocks", field: "currencyAmount" },  // land purchase
  { section: "Blocks", field: "fastFinishCost" },
  { section: "SquatterStreak", field: "fastFinishCost" },
  { section: "Objectives", field: "skipCost" },
  { section: "Character", field: "premiumPrice" }, // bribe cost
  { section: "Character", field: "currencyAmount" },
  { section: "Road", field: "premiumPrice" },
  { section: "Road", field: "prices" },
  { section: "Sidewalk", field: "premiumPrice" },
  { section: "Sidewalk", field: "prices" },
  { section: "Material", field: "buyPrice" },
  { section: "MovingDecoInfo", field: "currencyAmount" },
  { section: "MysteryBox", field: "currencyAmount" },
  { section: "GenericShopOffer", field: "prices" },
  { section: "MaterialShopOffer", field: "prices" },
];

// Rejected: IAPConfig.price_usd is real money, never scaled.

export interface GameConfigOptions {
  publicUrl: string;
  scaling: { buildTime: number; reward: number; cost: number };
  /** Unix seconds the season shift anchors against. Tests pin it. */
  now?: number;
  log?: (line: string) => void;
}

interface ManifestEntry {
  file: string;
  checksum: string;
  f: string;
  m: string;
}

interface OverlayEntry {
  file: string;
  section: string;
  id: string;
  on: unknown;
  off: unknown;
  gate: string;
}

interface Window { start: number; end: number }

interface PatchOp {
  file: string;
  section: string;
  id: string;
  op: "set" | "merge" | "delete";
  value?: unknown;
}

/** A file as loaded, after the season shift and before any per-state work. */
interface BaseFile {
  readonly name: string;
  /** What the manifest hashes and /config/ serves. */
  bytes: Buffer;
  text: string;
  /** The whitespace-stripped body, built once for a file nothing rewrites. */
  inline: string | null;
}

interface BuiltState {
  key: string;
  manifest: ManifestEntry[];
  files: Map<string, Buffer>;
  prefix: string;
  suffix: string;
}

/** Parse preserving every non-integer literal, so 3.0 does not become 3. */
function parseDoc(text: string): unknown {
  return J.parse(text, (_key, value, context) => {
    const source = context?.source;
    return typeof value === "number" && source !== undefined && /[.eE]/.test(source)
      ? J.rawJSON(source)
      : value;
  });
}

/**
 * Drop the whitespace between tokens. JSON forbids a raw control character
 * inside a string, so anything outside a string is insignificant.
 */
function minify(text: string): string {
  const out: string[] = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (i > start) out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out.join("");
}

/** Key-order-independent identity, as Python's json.dumps(sort_keys=True) is. */
function canon(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (J.isRawJSON(value)) return value.rawJSON;
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  const obj = value as Row;
  return `{${Object.keys(obj).sort()
    .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(",")}}`;
}

function asObject(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && !J.isRawJSON(value) ? value as Row : null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (J.isRawJSON(value)) {
    const n = Number(value.rawJSON);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Scale one value. Only a positive number moves: zero stays zero, and a
 * negative is a sentinel ("no cost", "never"), not a quantity. An integer stays
 * an integer and never rounds down to nothing; a float keeps its literal form.
 */
function scaleValue(value: unknown, factor: number): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const scaled = scaleValue(item, factor);
      if (scaled !== undefined) { changed = true; return scaled; }
      return item;
    });
    return changed ? out : undefined;
  }
  const n = numberOf(value);
  if (n === null || n <= 0) return undefined;
  if (Number.isInteger(n) && typeof value === "number") {
    return Math.max(1, Math.round(n * factor));
  }
  const text = String(n * factor);
  return J.rawJSON(/[.eE]/.test(text) ? text : `${text}.0`);
}

function utcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The same calendar date `years` later. On 29 February in a non-leap year this
 * rolls into March; no season date is a 29 February.
 */
function addYears(epochSeconds: number, years: number): number {
  const d = new Date(epochSeconds * 1000);
  return Math.floor(Date.UTC(
    d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
  ) / 1000);
}

/** Every TimedPromo row of a document, dict- or list-shaped. */
function promoRows(doc: unknown): [string | null, Row][] {
  const section = asObject(doc)?.["TimedPromo"];
  if (Array.isArray(section)) {
    return section.filter((r) => asObject(r) !== null).map((r) => [null, r as Row]);
  }
  const dict = asObject(section);
  if (!dict) return [];
  return Object.entries(dict)
    .filter(([, r]) => asObject(r) !== null)
    .map(([k, r]) => [k, r as Row]);
}

export class GameConfigSet {
  private readonly base = new Map<string, BaseFile>();
  private readonly contentUrl: string;
  private readonly configUrl: string;
  private readonly factors: [Map<string, ScaledField[]>, number][] = [];
  private readonly log: (line: string) => void;
  private readonly overlay: OverlayEntry[];
  private readonly patchesDir: string;
  readonly gates: string[];
  readonly windows = new Map<string, Window[]>();
  private generation = 0;
  private watcher: FSWatcher | null = null;
  private state: BuiltState | null = null;
  private previousFiles: Map<string, Buffer> | null = null;
  private builtKey: string | null = null;

  constructor(root: string, options: GameConfigOptions) {
    this.log = options.log ?? console.log;
    this.contentUrl = `${options.publicUrl}/static/`;
    this.configUrl = `${options.publicUrl}/config/`;
    const now = options.now ?? Math.floor(Date.now() / 1000);

    const dir = join(root, CONFIGS_DIR);
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (!statSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      this.base.set(name, { name, bytes, text: bytes.toString("utf8"), inline: null });
    }

    this.shiftTimedPromos(now);

    const overlayPath = join(root, EVENTS_FILE);
    let overlayText: string;
    try {
      overlayText = readFileSync(overlayPath, "utf8");
    } catch {
      throw new Error(`${EVENTS_FILE} is missing: the event-state overlay is not optional, ` +
        `every event character would stay bribable out of season`);
    }
    const overlayDoc = asObject(parseDoc(overlayText));
    const entries = overlayDoc?.["entries"];
    if (!Array.isArray(entries)) {
      throw new Error(`${EVENTS_FILE}: no "entries" array`);
    }
    this.overlay = entries as OverlayEntry[];
    const incomplete = this.overlay.find((e) =>
      !e.file || !e.section || !e.id || !e.gate ||
      asObject(e.on) === null || asObject(e.off) === null);
    if (incomplete) {
      throw new Error(`${EVENTS_FILE}: incomplete entry ${JSON.stringify(incomplete).slice(0, 120)}`);
    }
    this.gates = [...new Set(this.overlay.map((e) => e.gate))].sort();
    this.collectWindows();
    const missing = this.gates.filter((g) => !this.windows.has(g));
    if (missing.length > 0) {
      throw new Error(`event states: promo(s) with no served window ${missing.join(", ")}`);
    }
    this.log(`  event states: ${EVENTS_FILE}, ${this.overlay.length} row(s), ` +
      `${this.gates.length} gate(s)`);

    for (const [fields, factor] of [
      [BUILD_TIME_FIELDS, options.scaling.buildTime],
      [REWARD_FIELDS, options.scaling.reward],
      [COST_FIELDS, options.scaling.cost],
    ] as [ScaledField[], number][]) {
      // A factor of 1.0 skips its pass entirely, which keeps the reply
      // byte-identical to an unscaled build.
      if (factor !== 1) this.factors.push([bySection(fields), factor]);
    }
    if (this.factors.length > 0) {
      this.log(`  scaling: buildTime=${options.scaling.buildTime} ` +
        `reward=${options.scaling.reward} cost=${options.scaling.cost} (non-genuine)`);
    }

    this.patchesDir = join(root, PATCHES_DIR);
    // Only once the set is known to build: a watcher started before it would
    // outlive a constructor that throws, with no handle left to close it.
    this.refresh(now);
    this.watchPatches(this.patchesDir);
  }

  /** The reply, with the clock spliced in. Cheap unless the state changed. */
  replyJson(now: number): string {
    this.refresh(now);
    const state = this.state;
    if (!state) throw new Error("config set never built");
    return state.prefix + JSON.stringify({
      Social: { CalendarDate: now, TermsURL: "" },
      Server: {
        CalendarDay: now,
        UtcTimeStamp: now,
        DailyBonusDate: now,
        InstallDate: now,
        DaysSinceInstall: 0,
        RunNumberToday: 1,
        ccpa: false,
        PeriodicBackgroundSaveFrequency: 60,
      },
      AnalyticsEndpoints: {},
      ConfigURL: this.configUrl,
      te: [],
      Settings: { userInfo: {}, HowToURL: "", helpURL: "" },
    }) + state.suffix;
  }

  contentPackNames(): string[] {
    return (this.state?.manifest ?? [])
      .map((e) => e.file).filter((f) => f.startsWith("ContentPack-"));
  }

  /**
   * The bytes behind `<Name>-<md5>` or the bare `<Name>`, for GET /config/. The
   * generation before the current one still resolves: a client that took the
   * manifest just before a gate flipped would otherwise get a 404 for a name it
   * was just handed, which aborts its boot with ENGINE_DATA_ERROR.
   */
  servedBytes(name: string): Buffer | undefined {
    return this.state?.files.get(name) ?? this.previousFiles?.get(name);
  }

  manifest(): ManifestEntry[] {
    return this.state?.manifest ?? [];
  }

  /** The gates whose served promo window contains `now`. */
  openGates(now: number): Set<string> {
    const open = new Set<string>();
    for (const gate of this.gates) {
      const windows = this.windows.get(gate) ?? [];
      if (windows.some((w) => w.start <= now && now < w.end)) open.add(gate);
    }
    return open;
  }

  /**
   * The document as served, for the tests that diff against the base set.
   * Plainly parsed: a raw literal is a marker object, not a value to compare.
   */
  servedDoc(name: string): unknown {
    const bytes = this.state?.files.get(name);
    return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));
  }

  /** The document after the season shift and before the overlay. */
  baseDoc(name: string): unknown {
    const file = this.base.get(name);
    return file === undefined ? undefined : JSON.parse(file.text);
  }

  /**
   * Parsed fresh every time. `text` is authoritative once the shift has run, and
   * a parsed set of this size costs a gigabyte -- holding one would trade a
   * second of CPU per rebuild for permanent resident memory.
   */
  private docOf(name: string): unknown {
    const file = this.base.get(name);
    return file === undefined ? undefined : parseDoc(file.text);
  }

  /**
   * The season-align shift: one whole-year offset shared by
   * every file, anchored on the earliest window in the set, so the season keeps
   * its real dates -- Halloween in October, Christmas in December.
   */
  private shiftTimedPromos(now: number): void {
    const found: { file: BaseFile; doc: unknown; rows: Row[]; first: number }[] = [];
    for (const file of this.base.values()) {
      // A section cannot be present without its name in the text.
      if (!file.text.includes('"TimedPromo"')) continue;
      const doc = parseDoc(file.text);
      const rows = promoRows(doc).map(([, r]) => r);
      const starts = rows.map((r) => numberOf(r["startTimeUTC"]))
        .filter((s): s is number => s !== null && s !== 0);
      if (starts.length === 0) continue;
      found.push({ file, doc, rows, first: Math.min(...starts) });
    }
    if (found.length === 0) return;

    const anchor = Math.min(...found.map((f) => f.first));
    const lastEnd = Math.max(...found.map((f) =>
      Math.max(...f.rows.map((r) => numberOf(r["endTimeUTC"]) ?? 0))));
    let years = 0;
    while (addYears(lastEnd, years) < now) years++;
    const shift = addYears(anchor, years) - anchor;
    const days = Math.floor(shift / 86400);
    this.log(`  season aligned to the calendar: +${years} year(s), ${days}d -- ` +
      `season runs ${utcDate(anchor + shift)} onward, real dates`);

    for (const { file, doc, rows, first } of found) {
      const was = utcDate(first).slice(5);
      const is = utcDate(first + shift).slice(5);
      if (was !== is) {
        this.log(`  WARNING ${file.name}: calendar alignment slipped ${was} -> ${is}`);
      }
      for (const row of rows) {
        for (const key of ["startTimeUTC", "endTimeUTC"]) {
          const value = numberOf(row[key]);
          if (value) row[key] = value + shift;
        }
      }
      const starts = rows.map((r) => numberOf(r["startTimeUTC"]))
        .filter((s): s is number => s !== null && s !== 0);
      const firstStart = Math.min(...starts);
      const lastClose = Math.max(...rows.map((r) => numberOf(r["endTimeUTC"]) ?? 0));
      const opens = Math.floor((firstStart - now) / 86400);
      const closes = Math.floor((lastClose - now) / 86400);
      const when = lastClose <= now ? "already over" : opens <= 0 ? "live now" : `opens day +${opens}`;
      this.log(`  season ${file.name}: ${rows.length} promo window(s) shifted ${days}d, ` +
        `${when}, closes day +${closes}`);
      file.text = JSON.stringify(doc);
      file.bytes = Buffer.from(file.text, "utf8");
    }
  }

  /**
   * The promo windows, over the season-shifted rows. A row with no end never ends.
   * Derived once: a gate decides which config is built, so it cannot be read
   * back out of one. A patch that edits a TimedPromo window therefore changes
   * what the client is told about the promo without moving the gate.
   */
  private collectWindows(): void {
    for (const file of this.base.values()) {
      if (!file.text.includes('"TimedPromo"')) continue;
      for (const [key, row] of promoRows(this.docOf(file.name))) {
        const id = (typeof row["id"] === "string" && row["id"]) || key;
        const start = numberOf(row["startTimeUTC"]);
        if (!id || start === null) continue;
        const end = numberOf(row["endTimeUTC"]);
        const windows = this.windows.get(id) ?? [];
        windows.push({ start, end: end ? end : Infinity });
        this.windows.set(id, windows);
      }
    }
  }

  private watchPatches(dir: string): void {
    let timer: NodeJS.Timeout | null = null;
    try {
      this.watcher = watch(dir, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { this.generation++; }, PATCH_DEBOUNCE_MS);
        timer.unref();
      });
      this.watcher.unref();
    } catch {
      // No patches directory: nothing to hot-reload.
    }
  }

  /**
   * Stop watching for patch edits. The server runs until the process does, so
   * only the tests need this -- a watcher outlives the directory it was given
   * on Windows, which keeps the event loop alive after a temporary one is gone.
   */
  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Rebuild when the open gates or the patch generation changed. */
  private refresh(now: number): void {
    const open = this.openGates(now);
    const key = `${[...open].sort().join(",")}|${this.generation}`;
    if (key === this.builtKey) return;
    const first = this.builtKey === null;
    // After the build: a throw must not leave the key claiming a state that was
    // never built, which would serve the previous one forever.
    this.build(key, open);
    this.builtKey = key;
    const closed = this.gates.filter((g) => !open.has(g));
    const rowsOff = this.overlay.filter((e) => !open.has(e.gate)).length;
    const names = [...open].sort();
    this.log(`  event states ${first ? "at start" : "CHANGED"}: open ` +
      `${names.length > 0 ? `[${names.map((g) => `'${g}'`).join(", ")}]` : "-"}; ` +
      `closed ${closed.length} gate(s), ${rowsOff} OFF row(s) served`);
  }

  private build(key: string, open: ReadonlySet<string>): void {
    const working = new Map<string, unknown>();
    const docOf = (name: string): unknown => working.get(name) ?? this.docOf(name);

    this.applyEventStates(open, working, docOf);
    this.applyPatches(working, docOf);

    const manifest: ManifestEntry[] = [];
    const files = new Map<string, Buffer>();
    const bodies: string[] = [];
    const names: string[] = [];
    for (const file of this.base.values()) {
      if (EXCLUDE.has(file.name)) continue;
      let bytes: Buffer;
      let inline: string;
      // Scaling runs here, one file at a time: a parsed set of this size is a
      // gigabyte, so no build ever holds more than one document of it.
      const changed = this.scaled(file, working.get(file.name));
      if (changed !== undefined) {
        const text = this.withContentUrl(JSON.stringify(changed));
        bytes = Buffer.from(text, "utf8");
        inline = text;
      } else {
        const text = this.withContentUrl(file.text);
        if (text === file.text) {
          bytes = file.bytes;
          file.inline ??= minify(file.text);
          inline = file.inline;
        } else {
          bytes = Buffer.from(text, "utf8");
          inline = minify(text);
        }
      }
      const digest = md5(bytes);
      const served = `${file.name}-${digest}`;
      manifest.push({ file: served, checksum: digest, f: served, m: digest });
      // The client fetches ContentPack by its bare name; 404ing it aborts
      // the boot with ENGINE_DATA_ERROR. Register both spellings.
      files.set(served, bytes);
      files.set(file.name, bytes);
      names.push(file.name);
      bodies.push(`${JSON.stringify(file.name)}:${inline}`);
    }

    // The merge order is the key order of adHocConfigs, and `success` is last,
    // where a batch layer that appends it would leave it.
    this.previousFiles = this.state?.files ?? null;
    this.state = {
      key,
      manifest,
      files,
      prefix: `{"cksAESKeys":"","useCDN":true,"cks":${JSON.stringify(manifest)}` +
        `,"configTree":${JSON.stringify(names)},"env":"prod"` +
        `,"config_tags":["NUX","NUXOnly"],"adHocConfigs":{` +
        bodies.map((b) => `${b},`).join("") + `"adhocs":`,
      suffix: `},"success":true}`,
    };
  }

  /**
   * The published AppConfig points content-url at the real CDN. Rewriting the
   * bytes rather than the parsed document leaves the rest of the file formatted
   * as it was, so the URL is the only thing that changes.
   */
  private withContentUrl(text: string): string {
    if (!text.includes("content-url")) return text;
    return text.replace(/("content-url"\s*:\s*")[^"]*(")/g, `$1${this.contentUrl}$2`);
  }

  /**
   * EventStates: each event character's genuine ON row while his event's promo
   * window is open, his genuine OFF row while it is closed. A file is rewritten
   * only when a row actually differs, so an all-ON state leaves every byte as
   * it was.
   */
  private applyEventStates(
    open: ReadonlySet<string>,
    working: Map<string, unknown>,
    docOf: (name: string) => unknown,
  ): void {
    for (const entry of this.overlay) {
      const wanted = open.has(entry.gate) ? entry.on : entry.off;
      const doc = asObject(docOf(entry.file));
      if (!doc) throw new Error(`event states: ${entry.file} is not in the config set`);
      // A list-shaped section would be replaced wholesale by the single row
      // below, losing every other row in it.
      const section = doc[entry.section] === undefined
        ? {} : asObject(doc[entry.section]);
      if (!section) {
        throw new Error(`event states: ${entry.file}/${entry.section} is not a dict section`);
      }
      if (canon(section[entry.id]) === canon(wanted)) continue;
      working.set(entry.file, {
        ...doc,
        [entry.section]: { ...section, [entry.id]: wanted },
      });
    }
  }

  /**
   * patches/*.json in filename order. An unknown file, section or id rejects
   * the whole patch FILE, which leaves the last good generation served.
   */
  private applyPatches(
    working: Map<string, unknown>,
    docOf: (name: string) => unknown,
  ): void {
    let applied = 0;
    let names: string[];
    try {
      names = readdirSync(this.patchesDir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(this.patchesDir, name);
      const staged = new Map<string, unknown>();
      let ops: PatchOp[];
      try {
        const parsed = parseDoc(readFileSync(path, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("not an array of ops");
        ops = parsed as PatchOp[];
        for (const op of ops) {
          const current = staged.get(op.file) ?? docOf(op.file);
          staged.set(op.file, applyPatchOp(current, op));
        }
      } catch (err) {
        console.warn(`  patch ${name} REJECTED: ${(err as Error).message}`);
        continue;
      }
      for (const [file, doc] of staged) working.set(file, doc);
      applied += ops.length;
    }
    if (applied > 0) this.log(`  ${applied} patch op(s) applied (non-genuine)`);
  }

  /** The document with the host's factors applied, or `current` untouched. */
  private scaled(file: BaseFile, current: unknown): unknown {
    if (this.factors.length === 0) return current;
    if (current === undefined && !this.factors.some(([sections]) =>
      [...sections.keys()].some((name) => file.text.includes(`"${name}"`)))) return current;
    const doc = current ?? parseDoc(file.text);
    let out = doc;
    for (const [sections, factor] of this.factors) out = scaleDoc(out, sections, factor);
    return out === doc && current === undefined ? undefined : out;
  }
}

function bySection(fields: ScaledField[]): Map<string, ScaledField[]> {
  const out = new Map<string, ScaledField[]>();
  for (const field of fields) {
    const list = out.get(field.section) ?? [];
    list.push(field);
    out.set(field.section, list);
  }
  return out;
}

/** One patch op, returning a new document. Throws if it addresses nothing. */
function applyPatchOp(doc: unknown, op: PatchOp): unknown {
  const where = `${op.file}/${op.section}/${op.id}`;
  // Without this an op named "replace" would fall through to `set`, and a `set`
  // with no value would write undefined -- which JSON.stringify drops from an
  // object and turns into a null row in an array.
  if (op.op !== "set" && op.op !== "merge" && op.op !== "delete") {
    throw new Error(`unknown op ${JSON.stringify(op.op)} at ${where}`);
  }
  if (op.op !== "delete" && asObject(op.value) === null) {
    throw new Error(`${op.op} ${where} needs an object value`);
  }
  const root = asObject(doc);
  if (!root) throw new Error(`unknown file ${op.file}`);
  const section = root[op.section];
  if (section === undefined) throw new Error(`unknown section ${op.file}/${op.section}`);

  if (Array.isArray(section)) {
    const index = section.findIndex((r) => asObject(r)?.["id"] === op.id);
    if (index < 0 && op.op !== "set") throw new Error(`unknown id ${where}`);
    let rows: unknown[];
    if (op.op === "delete") rows = section.filter((_, i) => i !== index);
    else if (op.op === "merge") {
      rows = [...section];
      rows[index] = { ...asObject(section[index]), ...asObject(op.value) };
    } else {
      rows = [...section];
      if (index < 0) rows.push(op.value); else rows[index] = op.value;
    }
    return { ...root, [op.section]: rows };
  }

  const dict = asObject(section);
  if (!dict) throw new Error(`${op.file}/${op.section} is not a section`);
  if (op.op !== "set" && !(op.id in dict)) throw new Error(`unknown id ${where}`);
  const rows = { ...dict };
  if (op.op === "delete") delete rows[op.id];
  else if (op.op === "merge") rows[op.id] = { ...asObject(dict[op.id]), ...asObject(op.value) };
  else rows[op.id] = op.value;
  return { ...root, [op.section]: rows };
}

/** Copy-on-write: the same reference back when nothing in the table moved. */
function scaleDoc(doc: unknown, sections: Map<string, ScaledField[]>, factor: number): unknown {
  const root = asObject(doc);
  if (!root) return doc;
  let out: Row | null = null;
  for (const [name, ops] of sections) {
    const section = root[name];
    if (section === undefined || section === null || typeof section !== "object") continue;
    const entries: [string | number, unknown][] = Array.isArray(section)
      ? section.map((r, i) => [i, r])
      : Object.entries(section as Row);
    let scaled: Row | unknown[] | null = null;
    for (const [key, value] of entries) {
      const row = asObject(value);
      if (!row) continue;
      let next: Row | null = null;
      for (const op of ops) {
        if (!(op.field in row)) continue;
        if (op.when && !op.when(row)) continue;
        const scaledValue = scaleValue(row[op.field], factor);
        if (scaledValue === undefined) continue;
        next ??= { ...row };
        next[op.field] = scaledValue;
      }
      if (next) {
        scaled ??= Array.isArray(section) ? [...section] : { ...section as Row };
        (scaled as Row)[key] = next;
      }
    }
    if (scaled) {
      out ??= { ...root };
      out[name] = scaled;
    }
  }
  return out ?? doc;
}

/**
 * The served set, or null when there is nothing to serve: the config actions
 * then fall through to a bare success.
 */
export function loadGameConfig(root: string, options: GameConfigOptions): GameConfigSet | null {
  if (typeof J.rawJSON !== "function" || typeof J.isRawJSON !== "function") {
    throw new Error("Node 22+ with JSON.rawJSON is required to preserve number literals");
  }
  let count = 0;
  try {
    count = readdirSync(join(root, CONFIGS_DIR)).length;
  } catch {
    count = 0;
  }
  if (count === 0) {
    console.warn(`  ${CONFIGS_DIR} is empty: serving no config set`);
    return null;
  }
  return new GameConfigSet(root, options);
}
