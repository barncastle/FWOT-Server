/**
 * Hono routes: the batched RPC endpoint, and the config and asset GETs.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import { handleAction, RawJson, type ActionContext, type GameConfig } from "./actions.js";
import type { Cdn } from "./cdn.js";
import { checksum, decodeRequest, etagFor } from "./codec.js";
import { bodyCap, RateLimiter } from "./limits.js";
import type { Store } from "./store.js";

const gzip = promisify(gzipCb);

export interface AppDeps {
  store: Store;
  gameConfig: GameConfig | null;
  cdn: Cdn;
  verbose: boolean;
  /** Injectable clock for the rate limiter, so tests do not sleep. */
  now?: () => number;
}

type Call = [string, unknown];

/**
 * `data` is authoritative: response[i] answers data[i]. Fall back on the RPC
 * header only if data is missing or malformed.
 */
function callsFrom(envelope: Record<string, unknown> | null, rpc: string): Call[] {
  const calls: Call[] = [];
  const data = envelope?.["data"];
  if (Array.isArray(data)) {
    for (const item of data) {
      // A malformed element still takes a slot. Dropping it would silently
      // shift every later reply one place and pair each action with the wrong
      // answer; an unnamed call falls through to {} + success.
      calls.push(Array.isArray(item) && item.length > 0
        ? [String(item[0]), item.length > 1 ? item[1] : {}]
        : ["", {}]);
    }
  }
  if (calls.length > 0) return calls;
  return rpc.split(/[,\s]+/).filter(Boolean).map((a): Call => [a, {}]);
}

function shape(entry: unknown): string {
  if (entry instanceof RawJson) return "raw";
  if (entry === null) return "null";
  if (Array.isArray(entry)) return "[]";
  if (typeof entry === "object") return `[${Object.keys(entry).sort().join(",")}]`;
  return String(entry);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const limiter = new RateLimiter(deps.now);

  app.post("/tapservice/api/", limiter.middleware, bodyCap(), async (c) => {
    const started = Date.now();
    const body = await c.req.text();
    const { envelope, checksumOk } = decodeRequest(body);
    const rpc = c.req.header("RPC") ?? "";
    const calls = callsFrom(envelope, rpc);

    const ip = getConnInfo(c).remote.address ?? "";
    const ctx: ActionContext = { store: deps.store, gameConfig: deps.gameConfig };
    const playerId = envelope?.["player_id"];
    if (typeof playerId === "string" && playerId) deps.store.touch(playerId, ip);

    // An element is whatever its action returns -- an object, an ARRAY
    // (getClientMessageQueue is []), or null (logout). Only objects get a
    // default `success`.
    const entries = calls.map(([name, params]) => {
      const payload = handleAction(name, envelope ?? {}, params, ctx);
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload)
        && !(payload instanceof RawJson)) {
        const obj = payload as Record<string, unknown>;
        if (!("success" in obj)) obj["success"] = true;
      }
      return payload;
    });

    // A checksum mismatch is logged and still served.
    if (!checksumOk && body) {
      console.warn(`[/tapservice/api/] checksum MISMATCH RPC=${rpc || "(none)"}`);
    }
    if (deps.verbose) {
      const shapes = calls.map(([n], i) => `${n}:${shape(entries[i])}`).join(", ");
      console.log(
        `POST /tapservice/api/ RPC=${rpc || "(none)"} ` +
        `checksum=${checksumOk ? "ok" : "MISMATCH"} -> ${shapes} ` +
        `${Date.now() - started}ms`,
      );
    }

    return respond(c, entries);
  });

  // The client validates the ETag against the bytes it receives, so these are
  // never gzipped.
  app.get("/config/*", (c) => {
    let name: string;
    try {
      name = decodeURIComponent(c.req.path.slice("/config/".length));
    } catch {
      return c.text("not found", 404); // a malformed escape names no file
    }
    const data = deps.gameConfig?.servedBytes(name);
    if (!data) return c.text("not found", 404);
    // Node types Buffer over ArrayBufferLike; Hono's body wants ArrayBuffer.
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "application/json",
      "ETag": etagFor(data),
    });
  });

  // Assets are already compressed and the client checks the ETag against the
  // bytes it received, so this route is never gzipped either. A Range header
  // is ignored: nothing on this path asks for one, since the intro movie is a
  // hardcoded URL that still points at the real CDN.
  app.get("/static/*", async (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path.slice("/static/".length));
    } catch {
      return c.text("not found", 404); // a malformed escape names no file
    }
    const hit = await deps.cdn.get(rel, c.req.header("User-Agent") ?? "");
    if (!hit) return c.text("not found", 404);
    return c.body(hit.data as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "application/octet-stream",
      "ETag": etagFor(hit.data),
    });
  });

  return app;
}

/**
 * x-tc-digest is always over the UNCOMPRESSED body: the client copies that
 * header into the checksum it verifies on completion, and it only ever sees
 * inflated bytes. Responses are not signed. gzip is applied only when the
 * client asked for it -- its HTTP stack adds Accept-Encoding itself and
 * inflates transparently. The GET routes are never gzipped.
 */
async function respond(c: Context, entries: unknown[]): Promise<Response> {
  const body = `{"response":[${entries
    .map((e) => (e instanceof RawJson ? e.json : JSON.stringify(e))).join(",")}]}`;
  const plain = Buffer.from(body, "utf8");
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "x-tc-digest": checksum(body),
  };
  if (/\bgzip\b/i.test(c.req.header("Accept-Encoding") ?? "")) {
    const packed = await gzip(plain, { level: 6 });
    headers["Content-Encoding"] = "gzip";
    return c.body(packed, 200, headers);
  }
  return c.body(plain, 200, headers);
}
