/**
 * The asset CDN behind `GET /static/*`: what the client downloads from
 * `content-url`. The upstreams are tried first, and the local directory is the
 * fallback.
 *
 * Nothing is mirrored here and a miss is never recorded: a name that 403s on
 * a bucket today may be a 200 tomorrow, and the client re-asks anyway.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeAtomic } from "./store.js";

const CACHE_DIR = "data/cdn-cache";
const LOCAL_DIR = "data/local-cdn";
const FETCH_TIMEOUT_MS = 15_000;
const LOGICAL_SUFFIX = ".compressed";

export interface CdnOptions {
  servers: string[];
  cache: boolean;
  verbose?: boolean;
  /** Per-server upstream timeout. Tests pin it. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface CdnHit {
  data: Buffer;
  /** `cache`, `upstream <index>` or `local`, for the verbose log. */
  source: string;
}

/**
 * `.compressed` is a logical name, not a file: the client resolves it per
 * platform and the literal name 403s on every bucket.
 * The client normally does this itself, so this is a safety net. Density
 * (@2x/@4x) stays the client's choice and is never added here, and there is no
 * transcoding -- a missing mapped name is a 404.
 */
function mapLogicalName(rel: string, userAgent: string): string {
  if (!rel.endsWith(LOGICAL_SUFFIX)) return rel;
  // User-Agent is `<app>/<version> <os>/<osversion>`. Anything else, including
  // a missing header, is treated as Android.
  const os = userAgent.split(" ")[1]?.split("/")[0]?.toLowerCase();
  const real = os === "ios" ? ".pvr.ccz" : ".astc.ccz";
  return rel.slice(0, -LOGICAL_SUFFIX.length) + real;
}

/**
 * `rel` is attacker-controlled and builds two filesystem paths, so it is
 * checked before any syscall -- see safeId in store.ts for why. A backslash is
 * rejected outright rather than normalized: on Windows it is a separator, so
 * allowing it would need every rule below to be written twice.
 */
function unsafe(name: string): boolean {
  return name === ""
    || name.includes("\0")
    || name.includes("\\")
    || name.startsWith("/")
    || /^[A-Za-z]:/.test(name)
    || name.split("/").includes("..");
}

/** The path `name` names inside `dir`, or null if it resolves outside it. */
function under(dir: string, name: string): string | null {
  const root = resolve(dir);
  const path = resolve(join(root, name));
  return path.startsWith(root + sep) ? path : null;
}

export class Cdn {
  private readonly cacheDir: string;
  private readonly localDir: string;
  private readonly servers: string[];
  private readonly cache: boolean;
  private readonly verbose: boolean;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly inflight = new Map<string, Promise<CdnHit | null>>();

  constructor(root: string, options: CdnOptions) {
    this.cacheDir = join(root, CACHE_DIR);
    this.localDir = join(root, LOCAL_DIR);
    this.servers = options.servers;
    this.cache = options.cache;
    this.verbose = options.verbose ?? false;
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.log = options.log ?? console.log;
  }

  /** The bytes for one `/static/` path, or null for a 404. */
  async get(rel: string, userAgent: string): Promise<CdnHit | null> {
    const started = Date.now();
    const name = mapLogicalName(rel, userAgent);
    const hit = unsafe(name) ? null : await this.resolve(name, userAgent);
    if (this.verbose) {
      this.log(`GET /static/${rel} ${hit?.source ?? "404"} `
        + `${hit?.data.length ?? 0} bytes ${Date.now() - started}ms`);
    }
    return hit;
  }

  private resolve(name: string, userAgent: string): Promise<CdnHit | null> {
    const cached = this.cache ? this.read(this.cacheDir, name) : null;
    if (cached) return Promise.resolve({ data: cached, source: "cache" });

    // One fetch per name. A cold boot pulls thousands of assets over several
    // connections at once, and asking the upstream twice for the same file
    // wastes a round trip and races two writers onto one cache path.
    const running = this.inflight.get(name);
    if (running) return running;
    const flight = this.miss(name, userAgent)
      .finally(() => this.inflight.delete(name));
    this.inflight.set(name, flight);
    return flight;
  }

  private async miss(name: string, userAgent: string): Promise<CdnHit | null> {
    for (const [index, base] of this.servers.entries()) {
      const data = await this.upstream(base, name, userAgent);
      if (!data) continue;
      if (this.cache) this.store(name, data);
      return { data, source: `upstream ${index}` };
    }
    const local = this.read(this.localDir, name);
    return local ? { data: local, source: "local" } : null;
  }

  private async upstream(
    base: string, name: string, userAgent: string,
  ): Promise<Buffer | null> {
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/${name}`, {
        headers: userAgent ? { "User-Agent": userAgent } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Only a 200 is an asset. A 403 is a bucket's normal answer for a
      // name the 2018 configs still reference, and it must not spam the log.
      if (res.status !== 200) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;             // timeout, DNS, reset: try the next server
    }
  }

  private store(name: string, data: Buffer): void {
    const path = under(this.cacheDir, name);
    if (!path) return;
    try {
      writeAtomic(path, data);
    } catch (err) {
      // A full disk, or a name that collides with a directory already in the
      // cache. The client still gets its bytes; only the cache write is lost.
      console.warn(`  ! could not cache ${name}: ${err}`);
    }
  }

  private read(dir: string, name: string): Buffer | null {
    const path = under(dir, name);
    if (!path || !existsSync(path)) return null;
    try {
      return readFileSync(path);
    } catch {
      return null;             // a directory, or an unreadable file: a miss
    }
  }
}
