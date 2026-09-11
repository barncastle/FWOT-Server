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

/** Anything outside [A-Za-z0-9_.-] is folded. */
function safeId(userId: string): string {
  return (userId || "anonymous").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function writeAtomic(path: string, data: Buffer | string): void {
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
    const blob: unknown = JSON.parse(readFileSync(path, "utf8"));
    const table = (blob as { users?: Record<string, UserRecord> }).users ?? {};
    for (const [id, rec] of Object.entries(table)) this.users.set(id, rec);
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
      raw = inflateSync(Buffer.from(body, "base64"));
    } catch (err) {
      console.warn(`    ! could not decode saveV3 blob for ${userId}: ${err}`);
      return false;
    }
    if (raw.length === 0 || raw.length > SAVE_CAP) {
      console.warn(`    ! rejected saveV3 blob for ${userId}: ${raw.length} bytes`);
      return false;
    }
    const saveId = saveStamp(this.counter++);
    writeAtomic(this.savePath(userId, saveId), raw);
    const rec = this.users.get(userId) ?? {
      banned: false, saveId: null, lastSeen: new Date().toISOString(), lastIp: "",
    };
    rec.saveId = saveId;
    this.users.set(userId, rec);
    this.markDirty();
    this.prune(userId);
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
    // Names sort chronologically: the stamp leads and the counter only
    // disambiguates saves landing inside one second.
    const files = readdirSync(dir).filter((f) => f.endsWith(".pb")).sort();
    for (const name of files.slice(0, Math.max(0, files.length - SAVE_HISTORY))) {
      rmSync(join(dir, name), { force: true });
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
