/**
 * The JSON primitives the config pipeline needs and the standard library does
 * not give it: a parse that keeps every number literal as authored, a
 * whitespace stripper that never parses, and a key-order-independent identity.
 */

/**
 * Node 22's JSON.rawJSON, JSON.isRawJSON and the reviver's third argument are
 * not in the es2023 lib types yet.
 */
interface RawJsonValue { rawJSON: string }
interface ParseContext { source?: string }
const J = JSON as unknown as {
  rawJSON(text: string): RawJsonValue;
  isRawJSON(value: unknown): value is RawJsonValue;
  parse(
    text: string,
    reviver: (this: unknown, key: string, value: unknown, context: ParseContext) => unknown,
  ): unknown;
};

export type Row = Record<string, unknown>;

/** Python round-trips 3.0 as 3.0; without these two APIs JS cannot. */
export function assertRawJson(): void {
  if (typeof J.rawJSON !== "function" || typeof J.isRawJSON !== "function") {
    throw new Error("Node 22+ with JSON.rawJSON is required to preserve number literals");
  }
}

/** Parse preserving every non-integer literal, so 3.0 does not become 3. */
export function parseDoc(text: string): unknown {
  return J.parse(text, (_key, value, context) => {
    const source = context?.source;
    return typeof value === "number" && source !== undefined && /[.eE]/.test(source)
      ? J.rawJSON(source)
      : value;
  });
}

/** A number literal that survives JSON.stringify with its written form. */
export function rawNumber(text: string): unknown {
  return J.rawJSON(text);
}

/**
 * Drop the whitespace between tokens. JSON forbids a raw control character
 * inside a string, so anything outside a string is insignificant.
 */
export function minify(text: string): string {
  const out: string[] = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (i > start) out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out.join("");
}

/** Key-order-independent identity, as Python's json.dumps(sort_keys=True) is. */
export function canon(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (J.isRawJSON(value)) return value.rawJSON;
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  const obj = value as Row;
  return `{${Object.keys(obj).sort()
    .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(",")}}`;
}

export function asObject(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && !J.isRawJSON(value) ? value as Row : null;
}

export function numberOf(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (J.isRawJSON(value)) {
    const n = Number(value.rawJSON);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
