/**
 * Signed queries ("leases"). The page never sends a query: it names one with arguments, the
 * Worker validates them, builds the AST (src/app.ts) and signs it. The Durable Object only runs
 * ASTs carrying a valid signature for *its* database and name, so a visitor can't make it run
 * anything the app didn't define (an expensive scan, another project's data, …).
 *
 *   token = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payload part))
 *
 * The signature is checked when a subscription starts; a live subscription keeps running after
 * its lease expires (as in r2db). Reconnecting needs fresh leases.
 */

export interface LeasePayload {
  v: 1;
  ast: unknown;
  db: string;
  obj: string;
  exp: number;
}

export const LEASE_TTL_MS = 60_000;

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string) {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, k);
  }
  return k;
}

function b64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function signLease(secret: string, p: Omit<LeasePayload, "v" | "exp">, ttl = LEASE_TTL_MS): Promise<{ token: string; exp: number }> {
  const exp = Date.now() + ttl;
  const body = b64url(enc.encode(JSON.stringify({ v: 1, ...p, exp })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(`v1.${body}`)));
  return { token: `v1.${body}.${b64url(sig)}`, exp };
}

/** The payload if `token` is genuine, unexpired and for this database object; otherwise throws. */
export async function verifyLease(secret: string, token: string, expect: { db: string; obj: string }): Promise<LeasePayload> {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("malformed lease");
  const ok = await crypto.subtle.verify("HMAC", await key(secret), unb64url(parts[2]), enc.encode(`v1.${parts[1]}`));
  if (!ok) throw new Error("lease signature is invalid");
  const p = JSON.parse(new TextDecoder().decode(unb64url(parts[1]))) as LeasePayload;
  if (p.exp < Date.now()) throw new Error("lease expired");
  if (p.db !== expect.db || p.obj !== expect.obj) throw new Error("lease is for another database");
  return p;
}

/** Stable JSON (sorted keys): the client and the Worker key leases by the same string. */
export function canon(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
  if (x && typeof x === "object") {
    return `{${Object.keys(x as object)
      .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((x as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}
