/**
 * The season-align shift of every TimedPromo row, and the event states that
 * follow the shifted promo windows.
 *
 * These two passes are what make the served set GENUINE, which is what
 * separates them from `patches`: their rows come from named dump revisions,
 * they are not a host choice, and a fault in them is fatal rather than skipped.
 */
import { asObject, canon, numberOf, parseDoc, type Row } from "./json.js";

export interface Window { start: number; end: number }

interface OverlayEntry {
  file: string;
  section: string;
  id: string;
  on: unknown;
  off: unknown;
  gate: string;
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

/** A section cannot be present without its name in the text. */
function carriesPromo(text: string): boolean {
  return text.includes('"TimedPromo"');
}

/**
 * The season-align shift: one whole-year offset shared by
 * every file, anchored on the earliest window in the set, so the season keeps
 * its real dates -- Halloween in October, Christmas in December.
 *
 * Rewrites the text of every file it moves, and names them.
 */
export function shiftTimedPromos(
  texts: Map<string, string>,
  now: number,
  log: (line: string) => void,
): Set<string> {
  const moved = new Set<string>();
  const found: { name: string; doc: unknown; rows: Row[]; first: number }[] = [];
  for (const [name, text] of texts) {
    if (!carriesPromo(text)) continue;
    const doc = parseDoc(text);
    const rows = promoRows(doc).map(([, r]) => r);
    const starts = rows.map((r) => numberOf(r["startTimeUTC"]))
      .filter((s): s is number => s !== null && s !== 0);
    if (starts.length === 0) continue;
    found.push({ name, doc, rows, first: Math.min(...starts) });
  }
  if (found.length === 0) return moved;

  const anchor = Math.min(...found.map((f) => f.first));
  const lastEnd = Math.max(...found.map((f) =>
    Math.max(...f.rows.map((r) => numberOf(r["endTimeUTC"]) ?? 0))));
  let years = 0;
  while (addYears(lastEnd, years) < now) years++;
  const shift = addYears(anchor, years) - anchor;
  const days = Math.floor(shift / 86400);
  log(`  season aligned to the calendar: +${years} year(s), ${days}d -- ` +
    `season runs ${utcDate(anchor + shift)} onward, real dates`);

  for (const { name, doc, rows, first } of found) {
    const was = utcDate(first).slice(5);
    const is = utcDate(first + shift).slice(5);
    if (was !== is) {
      log(`  WARNING ${name}: calendar alignment slipped ${was} -> ${is}`);
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
    log(`  season ${name}: ${rows.length} promo window(s) shifted ${days}d, ` +
      `${when}, closes day +${closes}`);
    texts.set(name, JSON.stringify(doc));
    moved.add(name);
  }
  return moved;
}

/**
 * Each event character's genuine ON row while his
 * event's promo window is open, his genuine OFF row -- the same row without a
 * bribe -- while it is closed. The rows come from the overlay; the windows are
 * the served, already shifted, TimedPromo rows read against the clock this
 * server sends as UtcTimeStamp.
 */
export class EventStates {
  readonly entries: OverlayEntry[];
  readonly gates: string[];
  readonly windows = new Map<string, Window[]>();

  constructor(overlayText: string, texts: ReadonlyMap<string, string>, where: string) {
    const entries = asObject(parseDoc(overlayText))?.["entries"];
    if (!Array.isArray(entries)) throw new Error(`${where}: no "entries" array`);
    this.entries = entries as OverlayEntry[];
    const incomplete = this.entries.find((e) =>
      !e.file || !e.section || !e.id || !e.gate ||
      asObject(e.on) === null || asObject(e.off) === null);
    if (incomplete) {
      throw new Error(`${where}: incomplete entry ${JSON.stringify(incomplete).slice(0, 120)}`);
    }
    this.gates = [...new Set(this.entries.map((e) => e.gate))].sort();

    this.collectWindows(texts);
    const missing = this.gates.filter((g) => !this.windows.has(g));
    if (missing.length > 0) {
      throw new Error(`event states: promo(s) with no served window ${missing.join(", ")}`);
    }
  }

  /**
   * The promo windows, over the season-shifted rows. A row with no end never ends.
   * Derived once: a gate decides which config is built, so it cannot be read
   * back out of one. A patch that edits a TimedPromo window therefore changes
   * what the client is told about the promo without moving the gate.
   */
  private collectWindows(texts: ReadonlyMap<string, string>): void {
    for (const [, text] of texts) {
      if (!carriesPromo(text)) continue;
      for (const [key, row] of promoRows(parseDoc(text))) {
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

  /** The gates whose served promo window contains `now`. */
  openGates(now: number): Set<string> {
    const open = new Set<string>();
    for (const gate of this.gates) {
      const windows = this.windows.get(gate) ?? [];
      if (windows.some((w) => w.start <= now && now < w.end)) open.add(gate);
    }
    return open;
  }

  /** The rows serving their no-bribe side, for the log line. */
  offRows(open: ReadonlySet<string>): number {
    return this.entries.filter((e) => !open.has(e.gate)).length;
  }

  /**
   * Write each entry's gated side into `working`. A file is rewritten only when
   * a row actually differs, so an all-ON state leaves every byte as it was.
   */
  apply(
    open: ReadonlySet<string>,
    working: Map<string, unknown>,
    docOf: (name: string) => unknown,
  ): void {
    for (const entry of this.entries) {
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
}
