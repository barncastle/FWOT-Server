/**
 * Entry point: read and validate config.json, build the app, listen, and
 * flush the store on shutdown.
 */
import { serve } from "@hono/node-server";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadGameConfig, type GameConfigSet } from "./gameconfig.js";
import { Store } from "./store.js";

export interface ServerConfig {
  host: string;
  port: number;
  publicUrl: string;
  tls: { cert: string; key: string } | null;
  cdn: { servers: string[]; cache: boolean };
  logging: { verbose: boolean };
  scaling: { buildTime: number; reward: number; cost: number };
}

class ConfigError extends Error {}

function obj(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

/** Reject unknown keys so a typo fails loudly instead of being ignored. */
function exact(src: Record<string, unknown>, keys: string[], where: string): void {
  for (const key of Object.keys(src)) {
    if (!keys.includes(key)) throw new ConfigError(`${where}: unknown key "${key}"`);
  }
  for (const key of keys) {
    if (!(key in src)) throw new ConfigError(`${where}: missing key "${key}"`);
  }
}

function str(src: Record<string, unknown>, key: string, where: string): string {
  const v = src[key];
  if (typeof v !== "string") throw new ConfigError(`${where}.${key}: expected a string`);
  return v;
}

function bool(src: Record<string, unknown>, key: string, where: string): boolean {
  const v = src[key];
  if (typeof v !== "boolean") throw new ConfigError(`${where}.${key}: expected a boolean`);
  return v;
}

/** Scaling factors multiply values, so zero or negative is never meaningful. */
function factor(src: Record<string, unknown>, key: string): number {
  const v = src[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new ConfigError(`scaling.${key}: expected a finite number > 0`);
  }
  return v;
}

export function parseConfig(text: string): ServerConfig {
  let blob: unknown;
  try {
    blob = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`not valid JSON: ${(err as Error).message}`);
  }
  const root = obj(blob, "config");
  exact(root, ["host", "port", "publicUrl", "tls", "cdn", "logging", "scaling"], "config");

  const port = root["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError("config.port: expected an integer 0-65535");
  }

  let tls: ServerConfig["tls"] = null;
  if (root["tls"] !== null) {
    const t = obj(root["tls"], "config.tls");
    exact(t, ["cert", "key"], "config.tls");
    tls = { cert: str(t, "cert", "config.tls"), key: str(t, "key", "config.tls") };
  }

  const cdn = obj(root["cdn"], "config.cdn");
  exact(cdn, ["servers", "cache"], "config.cdn");
  const servers = cdn["servers"];
  if (!Array.isArray(servers) || servers.some((s) => typeof s !== "string")) {
    throw new ConfigError("config.cdn.servers: expected an array of strings");
  }

  const logging = obj(root["logging"], "config.logging");
  exact(logging, ["verbose"], "config.logging");

  const scaling = obj(root["scaling"], "config.scaling");
  exact(scaling, ["buildTime", "reward", "cost"], "config.scaling");

  return {
    host: str(root, "host", "config"),
    port,
    // content-url and ConfigURL append their own path, so a trailing slash
    // here would send the client to //static/.
    publicUrl: str(root, "publicUrl", "config").replace(/\/+$/, ""),
    tls,
    cdn: { servers: servers as string[], cache: bool(cdn, "cache", "config.cdn") },
    logging: { verbose: bool(logging, "verbose", "config.logging") },
    scaling: {
      buildTime: factor(scaling, "buildTime"),
      reward: factor(scaling, "reward"),
      cost: factor(scaling, "cost"),
    },
  };
}

function main(): void {
  let config: ServerConfig;
  try {
    config = parseConfig(readFileSync("config.json", "utf8"));
  } catch (err) {
    console.error(`config.json: ${(err as Error).message}`);
    process.exit(1);
  }

  const store = new Store(".");
  let gameConfig: GameConfigSet | null;
  try {
    gameConfig = loadGameConfig(".", {
      publicUrl: config.publicUrl,
      scaling: config.scaling,
    });
  } catch (err) {
    console.error(`config set: ${(err as Error).message}`);
    process.exit(1);
  }
  const app = createApp({ store, gameConfig, verbose: config.logging.verbose });

  // The startup lines belong in the listening callback: printed before it,
  // they announce a server that a failed bind is about to take down.
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (info) => {
      console.log(`tapservice listening on http://${config.host}:${info.port}`);
      console.log(`  publicUrl ${config.publicUrl}`);
      console.log(`  users     ${store.users.size} known`);
      console.log(`  configs   ${gameConfig?.manifest().length ?? 0} served`);
      console.log(`  scaling   buildTime=${config.scaling.buildTime} ` +
        `reward=${config.scaling.reward} cost=${config.scaling.cost}`);
    },
  );

  // Without this, a port already in use is an unhandled 'error' event: the
  // operator gets a Node stack trace instead of the one line that says what
  // to do. Node would exit on it anyway, so exiting 1 changes only the wording.
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE"
      ? `${config.host}:${config.port} is already in use`
      : `server error: ${err.message}`);
    process.exit(1);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`\n${signal}: flushing store`);
      store.flush();
      // The client keeps connections alive, and close() waits on them, so drop
      // the idle ones and cap the wait on any that are mid-request.
      if ("closeIdleConnections" in server) server.closeIdleConnections();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

// Only run when executed directly, so the tests can import parseConfig.
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main();
}
