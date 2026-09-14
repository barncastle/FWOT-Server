/**
 * Users table and save files.
 *
 * A users table plus a bounded per-user save history, rather than a flat
 * one-file-per-player layout.
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { md5 } from "./codec.js";

const USERS_FILE = "data/users.json";
const SAVES_DIR = "data/saves";
const TEMPLATE_FILE = "data/new_player.pb";
const SAVE_HISTORY = 10;          // newest N kept per user
const SAVE_CAP = 1024 * 1024;     // 1 MiB inflated
const WRITE_DEBOUNCE_MS = 1000;

export interface UserRecord {
  banned: boolean;                // recorded, NOT enforced in this build
  saveId: string | null;
  lastSeen: string;
  lastIp: string;
}

/** Filename-safe on Windows: no colons, so not a bare ISO timestamp. */
function saveStamp(counter: number): string {
  const iso = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
  return `${iso}-${String(counter % 1000).padStart(3, "0")}`;
}

/**
 * Directory name for one user. player_id is client-controlled, so a plain
 * fold-to-underscore is not enough here: it preserves `.`, which leaves `..`
 * intact and walks the save out of the tree, and it maps distinct ids onto one
 * directory, where a prune can delete another player's current save.
 *
 * Real ids are hex -- playerFor returns md5[:16] and getOrCreatePlayerId a
 * full md5 -- so they pass through readable. Anything else is replaced by its
 * md5, which cannot traverse, cannot exceed the name length limit, and cannot
 * collide with a plain id without an md5 preimage.
 */
function safeId(userId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? userId : md5(userId || "anonymous");
}

export function writeAtomic(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class Store {
  readonly users = new Map<string, UserRecord>();
  private timer: NodeJS.Timeout | null = null;
  private counter = 0;
  private template: Buffer = Buffer.alloc(0);
  private templateStamp = "";

  constructor(private readonly root: string) {
    const path = join(root, USERS_FILE);
    if (!existsSync(path)) return;
    // A truncated or hand-edited table must not take the server down with a
    // raw stack: warn, start empty, and leave the file for the operator. The
    // save files themselves are untouched.
    try {
      const blob: unknown = JSON.parse(readFileSync(path, "utf8"));
      const table = (blob as { users?: Record<string, UserRecord> } | null)?.users;
      if (table === undefined) throw new Error("no users object");
      for (const [id, rec] of Object.entries(table)) this.users.set(id, rec);
    } catch (err) {
      console.warn(`  ! ${USERS_FILE} is unreadable, starting empty: ${err}`);
      this.users.clear();
    }
  }

  /** Record the request against its user, creating the row on first sight. */
  touch(userId: string, ip: string): UserRecord {
    const rec = this.users.get(userId) ?? {
      banned: false, saveId: null, lastSeen: "", lastIp: "",
    };
    rec.lastSeen = new Date().toISOString();
    rec.lastIp = ip;
    this.users.set(userId, rec);
    this.markDirty();
    return rec;
  }

  /**
   * The new-player blob, re-read whenever the file on disk changes. Loading it
   * once at startup silently served stale bytes to every rebuilt save.
   */
  newPlayerTemplate(): Buffer {
    const path = join(this.root, TEMPLATE_FILE);
    if (!existsSync(path)) return this.template;
    const st = statSync(path);
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp !== this.templateStamp) {
      this.template = readFileSync(path);
      this.templateStamp = stamp;
      console.log(`  initial save reloaded: ${TEMPLATE_FILE} (${st.size} bytes)`);
    }
    return this.template;
  }

  /** The user's current save, or null if they have none. */
  loadSave(userId: string): Buffer | null {
    const saveId = this.users.get(userId)?.saveId;
    if (!saveId) return null;
    const path = this.savePath(userId, saveId);
    return existsSync(path) ? readFileSync(path) : null;
  }

  /**
   * Validate then persist one saveV3 body (the base64 zlib blob, tag already
   * stripped). A rejected save leaves the previous one current; the caller
   * still answers success, because the client's retry behaviour is untested.
   */
  storeSave(userId: string, body: string): boolean {
    let raw: Buffer;
    try {
      // maxOutputLength makes zlib abort DURING inflation. Checking the size
      // afterwards is too late: a few tens of KB of base64 expands to hundreds
      // of megabytes first, well under any request body cap on the way in.
      raw = inflateSync(Buffer.from(body, "base64"), { maxOutputLength: SAVE_CAP });
    } catch (err) {
      console.warn(`    ! could not decode saveV3 blob for ${userId}: ${err}`);
      return false;
    }
    if (raw.length === 0) {
      console.warn(`    ! rejected empty saveV3 blob for ${userId}`);
      return false;
    }
    // The write and the prune are inside the guard too: anything thrown here
    // would escape handleAction and fail the whole batch, costing the client
    // the replies to every other action in the same POST.
    const saveId = saveStamp(this.counter++);
    try {
      writeAtomic(this.savePath(userId, saveId), raw);
    } catch (err) {
      console.warn(`    ! could not write save for ${userId}: ${err}`);
      return false;
    }
    const rec = this.users.get(userId) ?? {
      banned: false, saveId: null, lastSeen: new Date().toISOString(), lastIp: "",
    };
    rec.saveId = saveId;
    this.users.set(userId, rec);
    this.markDirty();
    try {
      this.prune(userId);
    } catch (err) {
      console.warn(`    ! could not prune history for ${userId}: ${err}`);
    }
    console.log(`    saved ${raw.length} bytes for player ${userId} (${saveId})`);
    return true;
  }

  /** Write any pending users-table change now, cancelling the debounce. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const users = Object.fromEntries(this.users);
    writeAtomic(join(this.root, USERS_FILE), JSON.stringify({ users }, null, 2));
  }

  private savePath(userId: string, saveId: string): string {
    return join(this.root, SAVES_DIR, safeId(userId), `${saveId}.pb`);
  }

  private prune(userId: string): void {
    const dir = join(this.root, SAVES_DIR, safeId(userId));
    // Order by mtime, not by name: the name's counter wraps at 1000 and a
    // clock stepped backwards makes an older save sort newest, either of which
    // would put the live save at the head of the delete list.
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".pb"))
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    const current = this.users.get(userId)?.saveId;
    for (const f of files.slice(0, Math.max(0, files.length - SAVE_HISTORY))) {
      if (current && f.name === `${current}.pb`) continue;   // never the live save
      rmSync(join(dir, f.name), { force: true });
    }
  }

  private markDirty(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
    this.timer.unref();
  }
}
