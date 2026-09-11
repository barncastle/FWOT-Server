/**
 * Wire codec for the game's `tapservice` API.
 *
 * POST body: `request=<pct-encoded envelope JSON>&chksum=<md5 hex>`.
 * The checksum covers the RAW envelope JSON, before percent-encoding.
 */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

// The checksum salt: prefixed and suffixed to the envelope JSON.
export const PREFIX_KEY = "k7rcnwefaaavs3pavqkzmfikn7yibwgfghsbsch2i";
export const SUFFIX_KEY = "rw6r2n9czldfajoy8tu13l1xerqgwuc7mr2lqtr5x";

const UNRESERVED = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~",
);

// 8 MiB, the chunk size the client uses for multipart etags.
const ETAG_CHUNK = 8 * 1024 * 1024;

function md5(data: Buffer | string): string {
  return createHash("md5").update(data).digest("hex");
}

/** The builder's encoder: unreserved passes, everything else %xx lowercase. */
export function percentEncode(text: string): string {
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.has(ch) ? ch : "%" + byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Python urllib unquote: decode %xx byte-wise, then UTF-8 with replacement.
 * decodeURIComponent throws on malformed input, and the client is untrusted.
 * `+` stays a plus, as in unquote (not unquote_plus).
 */
export function percentDecode(text: string): string {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "%" && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(...Buffer.from(ch, "utf8"));
  }
  return Buffer.from(out).toString("utf8");
}

export function checksum(requestJson: string): string {
  return md5(PREFIX_KEY + requestJson + SUFFIX_KEY);
}

/** Build the POST body for one envelope. */
export function encodeRequest(envelope: unknown): string {
  const payload = JSON.stringify(envelope);
  return `request=${percentEncode(payload)}&chksum=${checksum(payload)}`;
}

export interface DecodedRequest {
  envelope: Record<string, unknown> | null;
  checksumOk: boolean;
}

/** Split a POST body back into its envelope and whether the checksum agrees. */
export function decodeRequest(body: string): DecodedRequest {
  const fields = new Map<string, string>();
  for (const part of body.split("&")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && !fields.has(part.slice(0, eq))) {
      fields.set(part.slice(0, eq), part.slice(eq + 1));
    }
  }
  const payload = percentDecode(fields.get("request") ?? "");
  let envelope: Record<string, unknown> | null = null;
  if (payload) {
    try {
      const parsed: unknown = JSON.parse(payload);
      envelope = parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      envelope = null;
    }
  }
  return {
    envelope,
    checksumOk: payload !== "" && fields.get("chksum") === checksum(payload),
  };
}

/** Serialized GriffinMessages.Player -> wire form of saved_game_pbuf. */
export function encodePbuf(raw: Buffer): string {
  return deflateSync(raw).toString("base64");
}

/** saved_game_pbuf -> serialized GriffinMessages.Player. Throws if malformed. */
export function decodePbuf(text: string): Buffer {
  return inflateSync(Buffer.from(text, "base64"));
}

/** The `cks` the client tracks: md5 of the inflated protobuf bytes. */
export function saveChecksum(inflated: Buffer): string {
  return md5(inflated);
}

/** Reproduce EtagUtils.etagForData: S3-style, multipart above 8 MiB. */
export function etagFor(data: Buffer): string {
  if (data.length <= ETAG_CHUNK) return `"${md5(data)}"`;
  const chunks = Math.ceil(data.length / ETAG_CHUNK);
  const parts: Buffer[] = [];
  for (let i = 0; i < chunks; i++) {
    const slice = data.subarray(i * ETAG_CHUNK, (i + 1) * ETAG_CHUNK);
    parts.push(createHash("md5").update(slice).digest());
  }
  return `"${md5(Buffer.concat(parts))}-${chunks}"`;
}

export { md5 };
