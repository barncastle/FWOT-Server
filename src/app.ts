/**
 * Hono routes: the batched RPC endpoint, and the config and asset GETs.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import { handleAction, type ActionContext, type GameConfig } from "./actions.js";
import { checksum, decodeRequest } from "./codec.js";
import type { Store } from "./store.js";

const gzip = promisify(gzipCb);

export interface AppDeps {
  store: Store;
  gameConfig: GameConfig | null;
  verbose: boolean;
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
      if (Array.isArray(item) && item.length > 0) {
        calls.push([String(item[0]), item.length > 1 ? item[1] : {}]);
      }
    }
  }
  if (calls.length > 0) return calls;
  return rpc.split(/[,\s]+/).filter(Boolean).map((a): Call => [a, {}]);
}

function shape(entry: unknown): string {
  if (entry === null) return "null";
  if (Array.isArray(entry)) return "[]";
  if (typeof entry === "object") return `[${Object.keys(entry).sort().join(",")}]`;
  return String(entry);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/tapservice/api/", async (c) => {
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
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
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

    return respond(c, { response: entries });
  });

  // Not served yet; the routes exist so they are reserved.
  app.get("/config/*", (c) => c.text("not found", 404));
  app.get("/static/*", (c) => c.text("not found", 404));

  return app;
}

/**
 * x-tc-digest is always over the UNCOMPRESSED body: the client copies that
 * header into the checksum it verifies on completion, and it only ever sees
 * inflated bytes. Responses are not signed. gzip is applied only when the
 * client asked for it -- its HTTP stack adds Accept-Encoding itself and
 * inflates transparently. The GET routes are never gzipped.
 */
async function respond(c: Context, obj: unknown): Promise<Response> {
  const body = JSON.stringify(obj);
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
