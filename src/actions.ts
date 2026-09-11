/**
 * One handler per RPC action. The reply shapes are exactly what the client
 * parses -- do not "improve" them.
 */
import { createHash } from "node:crypto";
import { encodePbuf, md5, saveChecksum } from "./codec.js";
import type { Store } from "./store.js";

/**
 * The config set, injected so the server can run without it. `null` means no
 * manifest: the config actions fall through to a bare success.
 */
export interface GameConfig {
  reply(now: number): Record<string, unknown>;
  contentPackNames(): string[];
}

export interface ActionContext {
  store: Store;
  gameConfig: GameConfig | null;
}

type Envelope = Record<string, unknown>;

/** Stable id per device, since the client sends none until it has one. */
export function playerFor(envelope: Envelope, params: Envelope): string {
  const ident = params["id"] || envelope["device_id"] ||
    envelope["install_id"] || "anonymous";
  return md5(String(ident)).slice(0, 16);
}

export function handleAction(
  name: string,
  envelope: Envelope,
  params: unknown,
  ctx: ActionContext,
): unknown {
  // Most actions pass a parameter dict, but saveV3 passes a bare string, so
  // keep the raw value alongside a dict-shaped view for the lookups below.
  const rawParams = params;
  const p: Envelope = (params !== null && typeof params === "object" &&
    !Array.isArray(params)) ? params as Envelope : {};
  const playerId = String(envelope["player_id"] || playerFor(envelope, p));

  if (name === "getSalt" || name === "getOrCreatePlayerIdAndSalt") {
    // Reply shape:
    //   salt        "<32 hex>"
    //   signed_salt "[<unix float>, \"<salt>\"].<base64url sig>"
    // The client echoes signed_salt back verbatim as the `salt` member of the
    // auth block on later calls, so the signature only has to be well-formed,
    // not verifiable by us.
    const now = Date.now() / 1000;
    const salt = md5(`${playerId}:${now}`);
    const token = JSON.stringify([now, salt]);
    const sig = createHash("sha1").update(token + salt).digest("base64url");
    return { signed_salt: `${token}.${sig}`, salt, success: true };
  }

  if (name === "getOrCreatePlayerId") {
    // human_id is null, not an empty string, and `env` is required -- the
    // client reads it and falls back to "UNKNOWN".
    const pid = md5(playerId);
    return {
      player_id: pid,
      human_id: null,
      env: "prod",
      community_id: pid.slice(0, 12),
      success: true,
    };
  }

  if (name === "login") {
    // The reply is just {"device_flags": []}. device_flags must be an ARRAY:
    // the client scans the response for the element carrying it, then checks
    // its type is array and walks its string entries. Sending an integer made
    // the scan fall through to "No eTAG no Beuno!", which aborts config loading.
    return { device_flags: [] };
  }

  if (name === "config" || name === "getConfigPatch" || name === "sendInitRequest") {
    // The config reply, field for field. ConfigURL is NOT a
    // top-level key -- it sits at adHocConfigs.adhocs.ConfigURL, which is why
    // every ConfigURL published before this was ignored.
    if (ctx.gameConfig) return ctx.gameConfig.reply(Math.floor(Date.now() / 1000));
  }

  if (name === "getGameStatePB") {
    const raw = ctx.store.loadSave(playerId);
    // Reply for a brand-new player:
    //   {"saved_game_pbuf": "...", "time_slept": "0",
    //    "save_version": "1.0", "initial": "True"}
    // Note the values are STRINGS, and `initial` is what tells the client this
    // is a fresh player to be built from scratch -- without it the player
    // comes up with no towns at all ("0 towns" in the client log).
    const payload: Record<string, string> = { time_slept: "0", save_version: "1.0" };
    if (raw === null) {
      // The client parses saved_game_pbuf whether it is empty or absent, so an
      // initial load still needs a real blob, even for a brand new player.
      payload["initial"] = "True";
      payload["saved_game_pbuf"] = encodePbuf(ctx.store.newPlayerTemplate());
    } else {
      payload["initial"] = "False";
      payload["saved_game_pbuf"] = encodePbuf(raw);
      payload["cks"] = saveChecksum(raw);
    }
    return payload;
  }

  if (name === "saveV3") {
    // The save does NOT arrive as envelope["saved_game_pbuf"]. The client
    // passes it as saveV3's own parameter, a bare string carrying a short tag
    // before a colon:
    //     "p:eNrtlD1oE2EYx//PXfpe8qYfabqUuoROxSk9..."
    // after the tag it is the usual base64(zlib(Player)) blob.
    const blob = typeof rawParams === "string" ? rawParams
      : (typeof p["p"] === "string" ? p["p"] as string
        : envelope["saved_game_pbuf"]);
    if (typeof blob === "string") {
      const tag = blob.slice(0, 4).indexOf(":");
      ctx.store.storeSave(playerId, tag >= 0 ? blob.slice(tag + 1) : blob);
    }
    // The reply is {"success": true} -- not save_ok. A rejected
    // blob answers the same, because the client's failure path is untested.
    return { success: true };
  }

  if (name === "logout") {
    // A saveV3,logout batch is answered with
    // {"response":[{"success":true},null]} -- logout's element is null.
    return null;
  }

  if (name === "getClientMessageQueue") {
    // The reply is {"response":[[]]}: the element is an ARRAY, not an object.
    return [];
  }

  if (name === "getTransactionSummary") {
    // The reply is exactly {"Currency": {}} -- an empty dict, and NO `success`
    // key of its own (the batch layer adds one).
    return { Currency: {} };
  }

  if (name === "getContentPackRevisions") {
    // The client's reply handler reads `success`, and on failure logs
    // "Content pack revisions RPC failed with error - %s". On success it walks
    // `content_pack_revisions`, taking `filename` off each element and
    // rejecting a blank one.
    //
    // `filename` is the CONFIG manifest name, not an archive --
    //     {"filename":"ContentPack-<md5 of contents>"}
    // An EMPTY list is why the client once downloaded nothing at all: with no
    // pack it never requests an asset.
    if (ctx.gameConfig) {
      const packs = ctx.gameConfig.contentPackNames().map((f) => ({ filename: f }));
      return { success: true, content_pack_revisions: packs };
    }
  }

  if (name === "getContentPackListV2") {
    // Sibling call: the client reads `success` then `content_packs`.
    return { success: true, content_packs: [] };
  }

  if (name === "getPushPreferences") {
    return {
      success: true,
      push_preferences: [{ is_enabled: true, category_id: "miscellaneous" }],
    };
  }

  if (name === "savePushPreferences") {
    return { success: true };
  }

  return {};
}
