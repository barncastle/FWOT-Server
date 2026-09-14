/**
 * Body cap and per-IP rate limit for the RPC route. Both apply to
 * POST /tapservice/api/ only: a first launch pulls thousands of assets, so
 * GET /static/* must stay unlimited.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import { bodyLimit } from "hono/body-limit";
import type { Context, MiddlewareHandler } from "hono";

const BODY_CAP = 1024 * 1024;     // a real save is ~2 KB compressed
const CAPACITY = 20;              // burst
const REFILL_PER_SEC = 2;         // 120/min sustained
// Once refilled to the top a bucket says nothing a new one would not.
const FORGET_MS = (CAPACITY / REFILL_PER_SEC) * 1000;

function ipOf(c: Context): string {
  return getConnInfo(c).remote.address ?? "";
}

/**
 * Hono's bodyLimit rather than a Content-Length check: it also reads a chunked
 * body incrementally and stops at the cap, so a lying header buys nothing.
 */
export function bodyCap(): MiddlewareHandler {
  return bodyLimit({
    maxSize: BODY_CAP,
    onError: (c) => {
      const length = c.req.header("Content-Length");
      const size = length ? `${length} bytes` : "a chunked body";
      console.warn(`[/tapservice/api/] 413 ${ipOf(c)} sent ${size}, cap ${BODY_CAP}`);
      return c.text("Payload Too Large", 413);
    },
  });
}

interface Bucket {
  tokens: number;
  seen: number;
}

/**
 * A token bucket per source address. The numbers are loose on purpose: a cold
 * boot is a handful of POSTs and then a save every 60 s, so a player never
 * approaches the bucket. This is a safety valve, not a quota.
 *
 * Behind a reverse proxy every request carries the proxy's address and all
 * players share one bucket. X-Forwarded-For is not read: it is spoofable.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private sweptAt = -Infinity;

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.buckets.size;
  }

  allow(ip: string): boolean {
    const at = this.now();
    // Swept on a clock, not on map size: a size trigger rescans on every insert
    // once the working set outgrows it, so invented addresses cost O(n) each.
    const sinceSweep = at - this.sweptAt;
    if (sinceSweep >= FORGET_MS || sinceSweep < 0) this.sweep(at);

    let bucket = this.buckets.get(ip);
    if (bucket) {
      // A backwards clock step would otherwise charge the bucket the jump.
      const elapsed = Math.max(0, at - bucket.seen);
      bucket.tokens = Math.min(CAPACITY, bucket.tokens + (elapsed / 1000) * REFILL_PER_SEC);
      bucket.seen = at;
    } else {
      bucket = { tokens: CAPACITY, seen: at };
      this.buckets.set(ip, bucket);
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private sweep(at: number): void {
    this.sweptAt = at;
    for (const [ip, bucket] of this.buckets) {
      if (at - bucket.seen >= FORGET_MS) this.buckets.delete(ip);
    }
  }

  readonly middleware: MiddlewareHandler = async (c, next) => {
    const ip = ipOf(c);
    if (this.allow(ip)) return next();
    console.warn(`[/tapservice/api/] 429 rate limited ${ip}`);
    return c.text("Too Many Requests", 429, { "Retry-After": "1" });
  };
}
