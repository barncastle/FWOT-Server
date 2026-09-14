/**
 * The served config set: the files on disk, plus the passes in `config/` that
 * derive what actually goes out -- the season-align promo shift and the event
 * states (`config/promo.ts`), the host's patches (`config/patches.ts`) and the
 * host's scaling factors (`config/scaling.ts`).
 *
 * A file no pass modifies is hashed and served as its ORIGINAL bytes, so its
 * md5 is unchanged. Only a modified file is re-serialized. The inline
 * adHocConfigs body is the same content with its insignificant whitespace
 * stripped -- the compact form a parse and re-dump would give, but stripping
 * instead of parsing keeps every number literal exactly as authored.
 *
 * The build is synchronous throughout, so two concurrent `config` requests
 * cannot interleave and no single-flight lock is needed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { md5 } from "./codec.js";
import { assertRawJson, minify, parseDoc } from "./config/json.js";
import { PatchSet } from "./config/patches.js";
import { EventStates, shiftTimedPromos, type Window } from "./config/promo.js";
import { Scaling, type ScalingFactors } from "./config/scaling.js";

const CONFIGS_DIR = "data/configs";
const EVENTS_FILE = "data/events.json";
const PATCHES_DIR = "patches";
// Withheld from the manifest so that for a duplicate id the alphabetically
// first publisher wins. The file stays on disk, unmodified.
const EXCLUDE = new Set(["OutfitLevel"]);

export interface GameConfigOptions {
  publicUrl: string;
  scaling: ScalingFactors;
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

export class GameConfigSet {
  private readonly base = new Map<string, BaseFile>();
  private readonly contentUrl: string;
  private readonly configUrl: string;
  private readonly log: (line: string) => void;
  private readonly events: EventStates;
  private readonly patches: PatchSet;
  private readonly scaling: Scaling;
  private state: BuiltState | null = null;
  private previousFiles: Map<string, Buffer> | null = null;
  private builtKey: string | null = null;

  constructor(root: string, options: GameConfigOptions) {
    this.log = options.log ?? console.log;
    this.contentUrl = `${options.publicUrl}/static/`;
    this.configUrl = `${options.publicUrl}/config/`;
    const now = options.now ?? Math.floor(Date.now() / 1000);

    const dir = join(root, CONFIGS_DIR);
    const texts = new Map<string, string>();
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (!statSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      const text = bytes.toString("utf8");
      this.base.set(name, { name, bytes, text, inline: null });
      texts.set(name, text);
    }

    for (const name of shiftTimedPromos(texts, now, this.log)) {
      const file = this.base.get(name)!;
      file.text = texts.get(name)!;
      file.bytes = Buffer.from(file.text, "utf8");
    }

    let overlayText: string;
    try {
      overlayText = readFileSync(join(root, EVENTS_FILE), "utf8");
    } catch {
      throw new Error(`${EVENTS_FILE} is missing: the event-state overlay is not optional, ` +
        `every event character would stay bribable out of season`);
    }
    this.events = new EventStates(overlayText, texts, EVENTS_FILE);
    this.log(`  event states: ${EVENTS_FILE}, ${this.events.entries.length} row(s), ` +
      `${this.events.gates.length} gate(s)`);

    this.scaling = new Scaling(options.scaling);
    if (this.scaling.active) {
      this.log(`  scaling: buildTime=${options.scaling.buildTime} ` +
        `reward=${options.scaling.reward} cost=${options.scaling.cost} (non-genuine)`);
    }

    this.patches = new PatchSet(join(root, PATCHES_DIR), this.log);
    this.refresh(now);
    // Only once the set is known to build: see PatchSet.watch.
    this.patches.watch();
  }

  get gates(): string[] {
    return this.events.gates;
  }

  get windows(): ReadonlyMap<string, Window[]> {
    return this.events.windows;
  }

  /** The gates whose served promo window contains `now`. */
  openGates(now: number): Set<string> {
    return this.events.openGates(now);
  }

  close(): void {
    this.patches.close();
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

  /** Rebuild when the open gates or the patch generation changed. */
  private refresh(now: number): void {
    const open = this.openGates(now);
    const key = `${[...open].sort().join(",")}|${this.patches.generation}`;
    if (key === this.builtKey) return;
    const first = this.builtKey === null;
    // After the build: a throw must not leave the key claiming a state that was
    // never built, which would serve the previous one forever.
    this.build(key, open);
    this.builtKey = key;
    const closed = this.gates.filter((g) => !open.has(g));
    const names = [...open].sort();
    this.log(`  event states ${first ? "at start" : "CHANGED"}: open ` +
      `${names.length > 0 ? `[${names.map((g) => `'${g}'`).join(", ")}]` : "-"}; ` +
      `closed ${closed.length} gate(s), ${this.events.offRows(open)} OFF row(s) served`);
  }

  private build(key: string, open: ReadonlySet<string>): void {
    const working = new Map<string, unknown>();
    const docOf = (name: string): unknown => working.get(name) ?? this.docOf(name);

    this.events.apply(open, working, docOf);
    this.patches.apply(working, docOf);

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

  /** The document with the host's factors applied, or `current` untouched. */
  private scaled(file: BaseFile, current: unknown): unknown {
    if (!this.scaling.active) return current;
    if (current === undefined && !this.scaling.touches(file.text)) return current;
    const doc = current ?? parseDoc(file.text);
    const out = this.scaling.apply(doc);
    return out === doc && current === undefined ? undefined : out;
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
}

/**
 * The served set, or null when there is nothing to serve: the config actions
 * then fall through to a bare success.
 */
export function loadGameConfig(root: string, options: GameConfigOptions): GameConfigSet | null {
  assertRawJson();
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
