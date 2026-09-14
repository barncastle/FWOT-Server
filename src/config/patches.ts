/**
 * `patches/*.json`: the host's own edits to the served set, applied in filename
 * order and hot-reloaded. They are the opposite of the promo passes -- nothing
 * here is genuine, so the directory defaults to empty, any op that is active is
 * logged as such, and a bad file is skipped rather than being fatal.
 */
import { readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { asObject, parseDoc } from "./json.js";

const DEBOUNCE_MS = 500;

interface PatchOp {
  file: string;
  section: string;
  id: string;
  op: "set" | "merge" | "delete";
  value?: unknown;
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

export class PatchSet {
  private watcher: FSWatcher | null = null;
  private version = 0;

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void,
  ) {}

  /** Bumped by an edit, so the set rebuilds on the next config request. */
  get generation(): number {
    return this.version;
  }

  /**
   * Start watching for edits. Call it only once the set is known to build: a
   * watcher started before that would outlive a constructor that throws, with
   * no handle left to close it.
   */
  watch(): void {
    let timer: NodeJS.Timeout | null = null;
    try {
      this.watcher = watch(this.dir, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { this.version++; }, DEBOUNCE_MS);
        timer.unref();
      });
      this.watcher.unref();
    } catch {
      // No patches directory: nothing to hot-reload.
    }
  }

  /**
   * Stop watching. The server runs until the process does, so only the tests
   * need this -- a watcher outlives the directory it was given on Windows,
   * which keeps the event loop alive after a temporary one is gone.
   */
  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * Apply every file in filename order. An unknown file, section or id rejects
   * the whole patch FILE, which leaves the last good generation served.
   */
  apply(working: Map<string, unknown>, docOf: (name: string) => unknown): void {
    let applied = 0;
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const staged = new Map<string, unknown>();
      let ops: PatchOp[];
      try {
        const parsed = parseDoc(readFileSync(join(this.dir, name), "utf8"));
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
}
